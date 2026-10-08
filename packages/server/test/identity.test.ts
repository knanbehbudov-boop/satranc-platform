import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client, newPlayer, startTestApp, STRONG_PASSWORD, type TestEnv, uniqueName, WsClient } from './helpers.ts';

let env: TestEnv;
before(async () => {
  env = await startTestApp();
});
after(async () => {
  await env.close();
});

function registration(name: string, extra: Record<string, unknown> = {}) {
  return {
    email: `${name}@ornek.test`,
    password: STRONG_PASSWORD,
    displayName: name,
    birthDate: '1992-03-04',
    countryCode: 'tr',
    acceptTos: true,
    ...extra,
  };
}

describe('M1 kayıt', () => {
  it('geçerli kayıt 201 döner, şifre özeti ve doğum tarihi yanıtta yok', async () => {
    const c = new Client(env.base);
    const name = uniqueName();
    const r = await c.post('/v1/auth/register', registration(name));
    assert.equal(r.status, 201);
    assert.equal(r.body.user.displayName, name);
    assert.equal(r.body.user.countryCode, 'TR');
    assert.equal(r.body.user.emailVerified, false);
    assert.equal(JSON.stringify(r.body).includes('password'), false);
    assert.equal(JSON.stringify(r.body).includes('1992'), false);
  });

  it('18 yaş altı reddedilir ve hiçbir kayıt oluşmaz', async () => {
    const c = new Client(env.base);
    const name = uniqueName();
    const today = new Date();
    const minor = `${today.getUTCFullYear() - 17}-01-01`;
    const r = await c.post('/v1/auth/register', registration(name, { birthDate: minor }));
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'AGE_RESTRICTED');
    const count = await env.app.pool.query('SELECT count(*)::int AS n FROM users WHERE display_name = $1', [name]);
    assert.equal(count.rows[0]?.n, 0);
  });

  it('18. doğum günü bugünse kabul, yarınsa ret', async () => {
    const t = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const todayBirth = `${t.getUTCFullYear() - 18}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
    const ok = await new Client(env.base).post('/v1/auth/register', registration(uniqueName(), { birthDate: todayBirth }));
    assert.equal(ok.status, 201);
    const tomorrow = new Date(t.getTime() + 86_400_000);
    const tomorrowBirth = `${tomorrow.getUTCFullYear() - 18}-${pad(tomorrow.getUTCMonth() + 1)}-${pad(tomorrow.getUTCDate())}`;
    const no = await new Client(env.base).post('/v1/auth/register', registration(uniqueName(), { birthDate: tomorrowBirth }));
    assert.equal(no.status, 403);
  });

  it('Kullanım Şartları kabul edilmeden kayıt olmaz', async () => {
    const r = await new Client(env.base).post('/v1/auth/register', registration(uniqueName(), { acceptTos: false }));
    assert.equal(r.status, 400);
    assert.equal(r.body.details.fields.acceptTos, 'kabul edilmeli');
  });

  it('zayıf şifre, yinelenen e-posta ve kullanıcı adı', async () => {
    const weak = await new Client(env.base).post('/v1/auth/register', registration(uniqueName(), { password: 'kisa' }));
    assert.equal(weak.body.code, 'WEAK_PASSWORD');
    const common = await new Client(env.base).post('/v1/auth/register', registration(uniqueName(), { password: 'password123' }));
    assert.equal(common.body.code, 'WEAK_PASSWORD');

    const name = uniqueName();
    await new Client(env.base).post('/v1/auth/register', registration(name));
    const dupEmail = await new Client(env.base).post('/v1/auth/register', registration(uniqueName(), { email: `${name.toUpperCase()}@ornek.test` }));
    assert.equal(dupEmail.status, 409);
    assert.equal(dupEmail.body.code, 'EMAIL_TAKEN');
    const dupName = await new Client(env.base).post('/v1/auth/register', registration(name.toUpperCase(), { email: `${uniqueName()}@ornek.test` }));
    assert.equal(dupName.body.code, 'DISPLAY_NAME_TAKEN');
  });
});

describe('M1 e-posta doğrulama', () => {
  it('token tek kullanımlık; doğrulanınca emailVerified true', async () => {
    const c = new Client(env.base);
    const name = uniqueName();
    await c.post('/v1/auth/register', registration(name));
    const mail = await c.get(`/v1/dev/mailbox?email=${name}@ornek.test`);
    assert.equal(mail.body.messages.length, 1);
    const token = mail.body.messages[0].token;
    const v1 = await c.post('/v1/auth/verify-email', { token });
    assert.equal(v1.body.user.emailVerified, true);
    const v2 = await c.post('/v1/auth/verify-email', { token });
    assert.equal(v2.body.code, 'INVALID_TOKEN');
  });
});

describe('M1 giriş ve oturum', () => {
  it('yanlış şifre ve bilinmeyen e-posta aynı hatayı verir', async () => {
    const p = await newPlayer(env.base);
    const wrong = await new Client(env.base).post('/v1/auth/login', { email: p.email, password: 'Yanlis-Sifre-2026' });
    const unknown = await new Client(env.base).post('/v1/auth/login', { email: 'yok@ornek.test', password: 'Yanlis-Sifre-2026' });
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.body, unknown.body);
  });

  it('girişte httpOnly, SameSite=Strict yenileme çerezi ve erişim tokeni', async () => {
    const p = await newPlayer(env.base);
    const c = new Client(env.base);
    const r = await c.post('/v1/auth/login', { email: p.email, password: STRONG_PASSWORD });
    const cookie = r.headers.getSetCookie()[0] as string;
    assert.match(cookie, /^rt=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\/v1\/auth/);
    c.token = r.body.accessToken;
    const me = await c.get('/v1/me');
    assert.equal(me.body.user.id, p.id);
  });

  it('tokensiz ve bozuk tokenle /me 401', async () => {
    assert.equal((await new Client(env.base).get('/v1/me')).status, 401);
    const c = new Client(env.base);
    c.token = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.';
    assert.equal((await c.get('/v1/me')).status, 401);
  });

  it('yenileme tokeni döner; eski token tekrar kullanılırsa tüm aile kapanır', async () => {
    const p = await newPlayer(env.base);
    const c = p.client;
    const first = c.cookies.get('rt') as string;
    const r1 = await c.post('/v1/auth/refresh');
    assert.equal(r1.status, 200);
    const second = c.cookies.get('rt') as string;
    assert.notEqual(first, second);

    // Saldırgan çalınmış eski tokeni kullanır.
    const thief = new Client(env.base);
    thief.cookies.set('rt', first);
    const stolen = await thief.post('/v1/auth/refresh');
    assert.equal(stolen.status, 401);
    assert.equal(stolen.body.code, 'SESSION_REVOKED');

    // Meşru kullanıcının yeni tokeni de artık geçersiz (aile kapatıldı).
    const after = await c.post('/v1/auth/refresh');
    assert.equal(after.status, 401);
  });

  it('başka sitenin Origin başlığıyla yenileme reddedilir (CSRF)', async () => {
    const p = await newPlayer(env.base);
    const r = await p.client.req('POST', '/v1/auth/refresh', {}, { origin: 'https://kotu-site.example' });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'CSRF');
  });

  it('çıkıştan sonra yenileme çalışmaz ve WebSocket kimliği reddedilir', async () => {
    const p = await newPlayer(env.base);
    const token = p.client.token;
    assert.equal((await p.client.post('/v1/auth/logout')).status, 204);
    assert.equal((await p.client.post('/v1/auth/refresh')).status, 401);
    const ws = await WsClient.open(env.base, token);
    assert.ok(ws.messages.some((m) => m.type === 'auth.error'));
    ws.close();
  });

  it('oturum listesi ve uzaktan kapatma', async () => {
    const p = await newPlayer(env.base);
    const other = new Client(env.base);
    await other.post('/v1/auth/login', { email: p.email, password: STRONG_PASSWORD });
    const list = await p.client.get('/v1/me/sessions');
    assert.equal(list.body.sessions.length, 2);
    const remote = list.body.sessions.find((s: any) => !s.current);
    assert.equal((await p.client.del(`/v1/me/sessions/${remote.id}`)).status, 204);
    assert.equal((await other.post('/v1/auth/refresh')).status, 401);
  });

  it('giriş denemeleri hız sınırına takılır', async () => {
    const c = new Client(env.base);
    const email = `${uniqueName()}@ornek.test`;
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await c.post('/v1/auth/login', { email, password: 'Yanlis-Sifre-2026' })).status);
    assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
    assert.equal(statuses[5], 429);
  });

  it('cihaz anahtarı kaydedilir', async () => {
    const p = await newPlayer(env.base);
    const r = await env.app.pool.query('SELECT device_key FROM devices WHERE user_id = $1', [p.id]);
    assert.equal(r.rows[0]?.device_key, p.client.deviceId);
  });
});

describe('M0 altyapı', () => {
  it('health, güvenlik başlıkları ve standart hata biçimi', async () => {
    const r = await new Client(env.base).get('/health');
    assert.equal(r.body.ok, true);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(r.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    const nf = await new Client(env.base).get('/v1/yok');
    assert.deepEqual(Object.keys(nf.body).sort(), ['code', 'message']);
  });

  it('bozuk JSON ve çok büyük gövde', async () => {
    const res = await fetch(env.base + '/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bozuk' });
    assert.equal(res.status, 400);
    const big = await fetch(env.base + '/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 'a'.repeat(70_000) }) });
    assert.equal(big.status, 413);
  });

  it('outbox: olay kaybolmaz ve her tüketici bir kez işler', async () => {
    const seen: number[] = [];
    env.app.events.subscribe('test-tuketici', ['user.registered'], async (e) => {
      seen.push(e.id);
    });
    await newPlayer(env.base);
    await newPlayer(env.base);
    await env.app.events.settle();
    await env.app.events.settle();
    const ids = new Set(seen);
    assert.equal(ids.size, seen.length, 'tekrar işlenen olay yok');
    const total = await env.app.pool.query(`SELECT count(*)::int AS n FROM outbox WHERE topic = 'user.registered'`);
    assert.equal(seen.length, total.rows[0]?.n);
  });

  it('outbox: işleyici hata verirse olay geri alınır ve tekrar denenir', async () => {
    let attempts = 0;
    env.app.events.subscribe('hatali-tuketici', ['user.email_verified'], async () => {
      attempts++;
      if (attempts === 1) throw new Error('geçici hata');
    });
    await newPlayer(env.base);
    await env.app.events.settle();
    await new Promise((r) => setTimeout(r, 500));
    await env.app.events.settle();
    assert.ok(attempts >= 2, `deneme sayısı: ${attempts}`);
    const consumed = await env.app.pool.query(`SELECT count(*)::int AS n FROM outbox_consumed WHERE consumer = 'hatali-tuketici'`);
    assert.ok((consumed.rows[0]?.n as number) >= 1);
  });

  it('WebSocket: kimlik, ping/pong, bilinmeyen tür ve bozuk mesaj', async () => {
    const p = await newPlayer(env.base);
    const ws = await WsClient.open(env.base, p.client.token);
    assert.ok(ws.messages.some((m) => m.type === 'auth.ok' && m.userId === p.id));
    ws.send({ type: 'ping', t: 123 });
    assert.equal((await ws.next((m) => m.type === 'pong')).t, 123);
    ws.send({ type: 'yok' });
    assert.equal((await ws.next((m) => m.code === 'UNKNOWN_TYPE')).type, 'error');
    ws.ws.send('{bozuk');
    assert.equal((await ws.next((m) => m.code === 'INVALID_JSON')).type, 'error');
    // Büyük mesaj (çok parçalı çerçeve uzunluğu) de işlenir.
    ws.send({ type: 'ping', t: 'x'.repeat(5000) });
    assert.equal((await ws.next((m) => m.type === 'pong' && typeof m.t === 'string')).t.length, 5000);
    ws.close();
  });
});
