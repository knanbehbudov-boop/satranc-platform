/**
 * K46 — bildirimler: SMTP istemcisi, Web Push şifreleme/VAPID, olaylardan e-posta ve telefon
 * bildirimi, izinli günlük özet ve abonelikten çıkma.
 */
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { buildMessage, sendMail } from '../src/infra/mail/smtp.ts';
import { b64u, encryptPayload, fromB64u, generateVapidKeys, vapidJwt } from '../src/infra/push/webpush.ts';
import { Client, newPlayer, sleep, startTestApp, STRONG_PASSWORD, type TestEnv, uniqueName } from './helpers.ts';
import { ScriptedPlayer } from './scripted-player.ts';

/** Basit sahte SMTP sunucusu: komutları ve iletiyi kaydeder. */
function fakeSmtp(): Promise<{ server: Server; port: number; log: string[]; messages: string[] }> {
  const log: string[] = [];
  const messages: string[] = [];
  const server = createServer((sock) => {
    sock.setEncoding('utf8');
    let inData = false;
    let data = '';
    let buf = '';
    sock.write('220 sahte ESMTP\r\n');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push(data);
            data = '';
            sock.write('250 tamam\r\n');
          } else data += `${line}\r\n`;
          continue;
        }
        log.push(line);
        if (/^EHLO/.test(line)) sock.write('250-sahte\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN/.test(line)) sock.write(Buffer.from(line.slice(11), 'base64').toString() === '\0kul\0sifre' ? '235 ok\r\n' : '535 hayır\r\n');
        else if (/^(MAIL|RCPT)/.test(line)) sock.write('250 ok\r\n');
        else if (line === 'DATA') { inData = true; sock.write('354 devam\r\n'); }
        else if (line === 'QUIT') { sock.write('221 güle güle\r\n'); sock.end(); }
        else sock.write('502 ?\r\n');
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port, log, messages })));
}

/** RFC 8291 çözücü (alıcı tarafı) — şifrelemenin doğruluğunu sınamak için. */
function decryptPayload(body: Buffer, ua: ReturnType<typeof createECDH>, authSecret: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20] as number;
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const shared = ua.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(pt[pt.length - 1], 2, 'son kayıt ayırıcısı');
  return pt.subarray(0, pt.length - 1).toString('utf8');
}

function browserSubscription() {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = randomBytes(16);
  return { ua, auth, sub: { endpoint: `https://push.example.test/${randomBytes(8).toString('hex')}`, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } } };
}

describe('K46 altyapı', () => {
  it('SMTP: kimlik doğrulama, gönderen/alıcı, UTF-8 başlık ve base64 gövde', async () => {
    const s = await fakeSmtp();
    try {
      await sendMail({ host: '127.0.0.1', port: s.port, secure: false, starttls: false, user: 'kul', pass: 'sifre' },
        { from: 'Satranç Turnuvaları <bildirim@ornek.test>', to: 'oyuncu@ornek.test', subject: 'Turnuvan başlıyor', text: 'Merhaba, şampiyon! ♞' });
      assert.ok(s.log.includes('MAIL FROM:<bildirim@ornek.test>'));
      assert.ok(s.log.includes('RCPT TO:<oyuncu@ornek.test>'));
      const msg = s.messages[0] as string;
      assert.match(msg, /Subject: =\?UTF-8\?B\?/);
      const body = msg.split('\r\n\r\n')[1] as string;
      assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), 'Merhaba, şampiyon! ♞');
      await assert.rejects(sendMail({ host: '127.0.0.1', port: s.port, secure: false, user: 'kul', pass: 'yanlis' }, { from: 'a@b.c', to: 'd@e.f', subject: 'x', text: 'y' }), /kimlik doğrulama/);
    } finally {
      s.server.close();
    }
    assert.match(buildMessage({ from: 'a@b.c', to: 'd@e.f', subject: 'Basit', text: 'x', headers: { 'List-Unsubscribe': '<https://x>' } }), /List-Unsubscribe: <https:\/\/x>/);
  });

  it('Web Push: RFC 8291 şifreleme alıcıda çözülür; VAPID imzası açık anahtarla doğrulanır', () => {
    const { ua, auth, sub } = browserSubscription();
    const body = encryptPayload(Buffer.from(JSON.stringify({ title: 'Turnuvan başlıyor!' })), sub.keys.p256dh, sub.keys.auth);
    assert.equal(JSON.parse(decryptPayload(body, ua, auth)).title, 'Turnuvan başlıyor!');
    const keys = generateVapidKeys();
    const jwt = vapidJwt(keys, 'https://push.example.test/abc', 'mailto:destek@ornek.test');
    const [h, p, sig] = jwt.split('.') as [string, string, string];
    assert.equal(JSON.parse(fromB64u(p).toString()).aud, 'https://push.example.test');
    const raw = fromB64u(keys.publicKey);
    const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) }, format: 'jwk' });
    assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: 'ieee-p1363' }, fromB64u(sig)));
  });
});

describe('K46 uçtan uca', () => {
  let env: TestEnv;
  const mails: { to: string; subject: string; text: string; headers?: Record<string, string> }[] = [];
  const pushes: { endpoint: string; payload: any }[] = [];
  let pushStatus = 201;
  before(async () => {
    env = await startTestApp({ paidMinRatedGames: 0, publicBaseUrl: 'https://satranc.example' });
    env.app.tournaments.firstGameDelayMs = 0;
    env.app.notifications.mailer = async (m) => { mails.push(m); };
    env.app.notifications.pusher = async (sub, payload) => { pushes.push({ endpoint: sub.endpoint, payload }); return pushStatus; };
  });
  after(async () => env.close());
  const q = <T = any>(sql: string, params: unknown[] = []) => env.app.pool.query<T>(sql, params).then((r) => r.rows);

  it('kayıtta izin kutusu: işaretlenmezse duyuru yok; ayarlardan açılıp kapanır', async () => {
    const name = uniqueName();
    const c = new Client(env.base);
    const reg = await c.post('/v1/auth/register', { email: `${name}@ornek.test`, password: STRONG_PASSWORD, displayName: name, birthDate: '1990-01-01', countryCode: 'GB', acceptTos: true, newTournamentsEmail: true });
    assert.equal(reg.status, 201);
    assert.equal((await q('SELECT notify_new_tournaments FROM users WHERE id = $1', [reg.body.user.id]))[0].notify_new_tournaments, true);
    const p = await newPlayer(env.base);
    assert.equal((await p.client.get('/v1/me/notifications')).body.newTournamentsEmail, false, 'varsayılan kapalı');
    assert.equal((await p.client.post('/v1/me/notifications', { newTournamentsEmail: true })).body.newTournamentsEmail, true);
    assert.ok((await q('SELECT notify_consent_at FROM users WHERE id = $1', [p.id]))[0].notify_consent_at);
  });

  it('turnuvaya kayıt e-postası; turnuva dolunca telefon bildirimi; sıradaki maç bildirimi', async () => {
    const code = uniqueName('bld').toLowerCase();
    await q(`INSERT INTO tournament_templates (code, name, kind, capacity, time_control, ready_seconds, break_seconds) VALUES ($1, 'Bildirim Kupası', 'free', 4, '180+2', 30, 0)`, [code]);
    await env.app.tournaments.ensureOpen();
    const tid = (await q<{ id: string }>(`SELECT t.id FROM tournaments t JOIN tournament_templates p ON p.id = t.template_id WHERE p.code = $1 AND t.status = 'OPEN'`, [code]))[0]!.id;
    const players: ScriptedPlayer[] = [];
    for (let i = 0; i < 4; i++) players.push(await ScriptedPlayer.create(env.base, () => 'win'));
    const first = players[0]!;
    const { sub } = browserSubscription();
    assert.equal((await first.client.post('/v1/me/push-subscriptions', sub)).status, 200);
    assert.equal((await first.client.get('/v1/me/notifications')).body.pushDevices, 1);
    for (const p of players) await p.client.post(`/v1/tournaments/${tid}/join`);
    for (let i = 0; i < 100 && !pushes.some((x) => x.payload.title === 'Turnuvan başlıyor!'); i++) await sleep(50);
    const ready = pushes.find((x) => x.payload.title === 'Turnuvan başlıyor!');
    assert.ok(ready, 'turnuva dolunca bildirim gitti');
    assert.equal(ready.endpoint, sub.endpoint);
    assert.equal(ready.payload.url, `/#/turnuva/${tid}`);
    for (let i = 0; i < 100 && !pushes.some((x) => /başlıyor/.test(x.payload.title) && x.payload.url.startsWith('/#/oyun/')); i++) await sleep(50);
    assert.ok(pushes.some((x) => x.payload.url.startsWith('/#/oyun/')), 'maç başlarken bildirim');

    const joined = await q(`SELECT to_email, subject, body FROM mail_outbox WHERE template = 'tournament_joined' AND data->>'userId' = $1`, [first.id]);
    assert.equal(joined.length, 1);
    assert.match(joined[0].subject, /Kaydın alındı: Bildirim Kupası/);
    assert.match(joined[0].body, /https:\/\/satranc\.example\/#\/turnuva\//);
    const n = await env.app.notifications.deliverMail();
    assert.ok(n >= 4, `gönderilen e-posta: ${n}`);
    assert.ok(mails.some((m) => m.subject === 'Kaydın alındı: Bildirim Kupası'));
    for (const p of players) p.close();
  });

  it('geçersiz abonelik (410) silinir', async () => {
    const p = await newPlayer(env.base);
    const { sub } = browserSubscription();
    await p.client.post('/v1/me/push-subscriptions', sub);
    pushStatus = 410;
    try {
      await env.app.notifications.push(p.id, { title: 't', body: 'b', url: '/' });
    } finally {
      pushStatus = 201;
    }
    assert.equal((await q('SELECT 1 FROM push_subscriptions WHERE user_id = $1', [p.id])).length, 0);
    assert.equal((await p.client.post('/v1/me/push-subscriptions', { endpoint: 'http://kotu', keys: {} })).status, 400);
  });

  it('günlük özet yalnız izin verene, günde bir; abonelikten çıkma bağlantısı çalışır', async () => {
    await q(`UPDATE users SET last_digest_at = now()`); // önceki testlerin kullanıcıları
    const yes = await newPlayer(env.base);
    const no = await newPlayer(env.base);
    await yes.client.post('/v1/me/notifications', { newTournamentsEmail: true });
    await q(`UPDATE users SET last_digest_at = NULL WHERE id IN ($1, $2)`, [yes.id, no.id]);
    const sent = await env.app.notifications.sendDigests();
    assert.equal(sent, 1);
    const rows = await q(`SELECT data->>'userId' AS uid, body FROM mail_outbox WHERE template = 'digest'`);
    assert.deepEqual(rows.map((r) => r.uid), [yes.id]);
    assert.match(rows[0].body, /USD · 4 kişi · 3 dk/);
    const link = /https:\/\/satranc\.example(\/v1\/notifications\/unsubscribe\?\S+)/.exec(rows[0].body)![1]!;
    assert.equal(await env.app.notifications.sendDigests(), 0, 'aynı gün ikinci özet yok');
    await env.app.notifications.deliverMail();
    const m = mails.find((x) => x.subject === 'Bugünün açık turnuvaları')!;
    assert.match(m.headers!['List-Unsubscribe']!, /unsubscribe/);
    const bad = await fetch(`${env.base}/v1/notifications/unsubscribe?u=${yes.id}&t=yanlis`);
    assert.equal(bad.status, 400);
    const ok = await fetch(env.base + link);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /duyurularından çıktın/);
    assert.equal((await yes.client.get('/v1/me/notifications')).body.newTournamentsEmail, false);
  });
});
