/**
 * K49 — bölge engeli: IP aralıkları, hesap ülkesi ve kart ülkesi. Para çekme engellenmez,
 * yönetim ekibi muaf, 'log' kipinde yalnız kayıt tutulur.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ipKey, parseDelegated } from '../src/modules/geo/service.ts';
import { Client, newPlayer, sleep, startTestApp, STRONG_PASSWORD, type TestEnv, uniqueName } from './helpers.ts';

describe('K49 IP hesapları', () => {
  it('IPv4, IPv6 ve IPv4-eşlemeli adresler', () => {
    assert.deepEqual(ipKey('5.10.192.1'), { family: 4, n: (5n << 24n) + (10n << 16n) + (192n << 8n) + 1n });
    assert.deepEqual(ipKey('::ffff:5.10.192.1'), ipKey('5.10.192.1'));
    assert.deepEqual(ipKey('2a00:1d38:1:2::5'), { family: 6, n: (0x2a00n << 32n) + (0x1d38n << 16n) + 1n });
    assert.deepEqual(ipKey('::1'), { family: 6, n: 0n });
    assert.equal(ipKey('yok'), null);
  });

  it('resmî tahsis dosyası ayrıştırılır; yalnız engelli ülkeler alınır', () => {
    const text = [
      '2|ripencc|20261008|1|19830705|20261008|+0100',
      'ripencc|*|ipv4|*|90000|summary',
      'ripencc|AZ|ipv4|5.10.192.0|8192|20120116|allocated',
      'ripencc|TR|ipv4|5.2.80.0|4096|20120101|allocated',
      'ripencc|AZ|ipv6|2a00:1d38::|32|20100618|allocated',
      'ripencc|AZ|asn|12345|1|20100618|allocated',
      'ripencc|AZ|ipv4|9.9.9.0|256|20100618|reserved',
    ].join('\n');
    const r = parseDelegated(text, new Set(['AZ']));
    assert.equal(r.length, 2);
    assert.deepEqual(r[0], { country: 'AZ', family: 4, start: ipKey('5.10.192.0')!.n, end: ipKey('5.10.223.255')!.n });
    assert.deepEqual(r[1], { country: 'AZ', family: 6, start: ipKey('2a00:1d38::')!.n, end: ipKey('2a00:1d38:ffff::')!.n });
  });
});

describe('K49 uçtan uca', () => {
  let env: TestEnv;
  before(async () => {
    env = await startTestApp({ geoBlockMode: 'enforce', geoBlockedCountries: ['AZ'], sandboxDeliveryDelayMs: 0, sandboxDuplicateRate: 0, geoDataUrl: 'https://ornek.test/delegated' });
  });
  after(async () => env.close());
  const q = <T = any>(sql: string, params: unknown[] = []) => env.app.pool.query<T>(sql, params).then((r) => r.rows);
  const register = (c: Client, countryCode: string) => c.post('/v1/auth/register', {
    email: `${uniqueName('geo')}@ornek.test`, password: STRONG_PASSWORD, displayName: uniqueName('geo'), birthDate: '1990-01-01', countryCode, acceptTos: true,
  });
  async function flush() {
    for (let i = 0; i < 50; i++) {
      await env.app.sandbox!.deliver();
      await env.app.payments.processRefunds();
      await env.app.events.settle();
      const r = await q<{ n: number }>(`SELECT (SELECT count(*) FROM psp_sandbox_events WHERE delivered_at IS NULL) + (SELECT count(*) FROM refunds WHERE status = 'PENDING') AS n`);
      if (Number(r[0]?.n) === 0) return;
      await sleep(20);
    }
  }

  it('engelli ülke seçilerek kayıt olunamaz', async () => {
    const r = await register(new Client(env.base), 'AZ');
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'REGION_BLOCKED');
    assert.equal(r.body.message, 'Bu ülkeden kayıt kabul edilmiyor');
    assert.equal((await register(new Client(env.base), 'TR')).status, 201);
  });

  it('IP listesi indirilir; engelli IP kayıt, yükleme ve katılım yapamaz; para çekme ve yönetici serbest', async () => {
    const player = await newPlayer(env.base);
    const staff = await newPlayer(env.base);
    await q(`UPDATE users SET roles = '{player,admin}' WHERE id = $1`, [staff.id]);
    // Test istekleri 127.0.0.1'den gelir: listeye o aralığı "AZ" olarak koyan bir dosya verilir.
    env.app.geo.fetchText = async () => 'ripencc|AZ|ipv4|127.0.0.0|16777216|20120116|allocated\nripencc|TR|ipv4|5.2.80.0|4096|20120101|allocated\n';
    assert.equal(await env.app.geo.refresh(), 1);
    assert.equal(await env.app.geo.countryOfIp('127.0.0.1'), 'AZ');
    assert.equal(await env.app.geo.countryOfIp('5.2.80.1'), null);

    const reg = await register(new Client(env.base), 'TR');
    assert.deepEqual([reg.status, reg.body.message], [403, 'Platformumuz bulunduğun bölgede hizmet vermiyor']);
    // Yeni turnuvaya katılım ve bakiye yükleme engellenir.
    const dep = await player.client.post('/v1/me/wallet/deposit', { amountCents: 2000 });
    assert.equal(dep.body.code, 'REGION_BLOCKED');
    const t = (await q<{ id: string }>(`SELECT id FROM tournaments WHERE status = 'OPEN' LIMIT 1`))[0]!;
    assert.equal((await player.client.post(`/v1/tournaments/${t.id}/join`, {})).body.code, 'REGION_BLOCKED');
    // Para çekme engellenmez (bakiye yetersiz hatası bölge hatası değildir).
    const w = await player.client.post('/v1/me/withdrawals', { amountCents: 2000, method: 'ewallet', destination: 'oyuncu@cuzdan.test', holderName: 'Test Oyuncu' });
    assert.notEqual(w.body.code, 'REGION_BLOCKED');
    // Yönetim ekibi muaf.
    assert.equal((await staff.client.post('/v1/me/wallet/deposit', { amountCents: 2000 })).status, 200);
    const audit = await q(`SELECT data FROM audit_log WHERE action = 'geo.blocked' ORDER BY id`);
    assert.ok(audit.length >= 3);
    assert.deepEqual([audit[1].data.by, audit[1].data.ipCountry], ['ip', 'AZ']);

    // 'log' kipi: engellemez, yalnız kaydeder.
    await env.restart({ geoBlockMode: 'log' });
    assert.equal((await player.client.post('/v1/me/wallet/deposit', { amountCents: 2000 })).status, 200);
    await env.restart({ geoBlockMode: 'enforce' });
    await q('DELETE FROM geo_ip_ranges');
  });

  it('engelli ülkede çıkarılmış kartla ödeme kabul edilmez ve iade edilir', async () => {
    const p = await newPlayer(env.base);
    const d = await p.client.post('/v1/me/wallet/deposit', { amountCents: 2500 });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    const u = new URL(d.body.checkoutUrl, env.base);
    const pay = await new Client(env.base).post(`/sandbox-psp/v1/checkout/${u.pathname.split('/').pop()}/pay`, { secret: u.searchParams.get('secret'), card: '4000 0003 1000 0007', exp: '12/39', cvc: '123' });
    assert.equal(pay.body.status, 'succeeded');
    await flush();
    const pm = (await q(`SELECT status, card_country FROM payments WHERE id = $1`, [d.body.paymentId]))[0];
    assert.deepEqual([pm.status, pm.card_country], ['REFUNDED', 'AZ']);
    const bal = (await p.client.get('/v1/me/balance')).body.balances.find((b: any) => b.currency === 'USD');
    assert.equal(bal?.totalCents ?? 0, 0, 'cüzdana para geçmedi');
    const inv = await env.app.ledger.invariants();
    assert.ok(inv.balanced);
    const rec = await env.app.payments.reconcile('USD');
    assert.ok(rec.ok, JSON.stringify(rec));
  });
});
