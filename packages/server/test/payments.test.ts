/**
 * Bölüm 7 — M7 ödeme (sandbox sağlayıcı). Webhook'lar gerçek HTTP isteğiyle,
 * imzalı olarak gelir; testler idempotency, imza, 3D Secure, red, iade, ters ibraz
 * ve mutabakatı uçtan uca sınar.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { signPayload, verifySignature, WebhookSignatureError } from '../src/modules/payments/provider.ts';
import { Client, newPlayer, sleep, startTestApp, STRONG_PASSWORD, type TestEnv } from './helpers.ts';

let env: TestEnv;
const SECRET = 'whsec_test_secret_123';

before(async () => {
  env = await startTestApp({ pspWebhookSecret: SECRET, sandboxDeliveryDelayMs: 0, sandboxDuplicateRate: 0 });
});
after(async () => env.close());

const q = <T = any>(sql: string, params: unknown[] = []) => env.app.pool.query<T>(sql, params).then((r) => r.rows);
const bal = (code: string) => env.app.ledger.balance(env.app.pool, code);

/** Bekleyen tüm sandbox webhook'ları teslim edilene kadar bekler. */
async function flush(timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await env.app.sandbox!.deliver();
    const r = await q<{ n: number }>('SELECT count(*)::int AS n FROM psp_sandbox_events WHERE delivered_at IS NULL');
    if (r[0]!.n === 0) return;
    await sleep(30);
  }
  throw new Error('Webhook teslimi zaman aşımı');
}

/**
 * Turnuvadan bağımsız ödeme (koltuğa bağlı akış Bölüm 8 testlerinde: paid-tournament.test.ts).
 * tournamentId/entryId boş olduğu için turnuva modülü 'payment.succeeded' olayını yok sayar.
 */
async function playerWithEntry() {
  const p = await newPlayer(env.base);
  return { ...p, tournamentId: null as string | null, entryId: null as string | null };
}

let keyNo = 0;
async function newPayment(p: { id: string; tournamentId: string | null; entryId: string | null }, cents = 1000) {
  const r = await env.app.payments.createPayment({
    userId: p.id,
    tournamentId: p.tournamentId,
    entryId: p.entryId,
    amountCents: cents,
    currency: 'USD',
    idempotencyKey: `test:${++keyNo}`,
    description: 'Test giriş ücreti',
    returnUrl: (id) => `/#/odeme/${id}`,
  });
  const url = new URL(r.checkoutUrl!, env.base);
  return { ...r, intentId: url.pathname.split('/').pop()!, secret: url.searchParams.get('secret')! };
}

async function pay(intentId: string, secret: string, card: string) {
  return new Client(env.base).post(`/sandbox-psp/v1/checkout/${intentId}/pay`, { secret, card, exp: '12/39', cvc: '123' });
}

describe('webhook imzası', () => {
  it('imza şeması: doğru imza geçer, gövde/anahtar/zaman değişirse reddedilir', () => {
    const body = Buffer.from('{"a":1}');
    const h = signPayload(SECRET, body);
    verifySignature(SECRET, body, h);
    assert.throws(() => verifySignature(SECRET, Buffer.from('{"a":2}'), h), WebhookSignatureError);
    assert.throws(() => verifySignature('baska', body, h), WebhookSignatureError);
    const old = signPayload(SECRET, body, Math.floor(Date.now() / 1000) - 3600);
    assert.throws(() => verifySignature(SECRET, body, old), /zaman penceresi/);
    assert.throws(() => verifySignature(SECRET, body, undefined), /başlığı yok/);
  });

  it('imzasız, yanlış imzalı ve eski (tekrar) webhook 400 alır; hiçbir şey kaydedilmez', async () => {
    const body = JSON.stringify({ id: 'evt_sahte', type: 'payment_intent.succeeded', data: { object: { id: 'pi_x', amount_received: 999999 } } });
    const c = new Client(env.base);
    const none = await c.req('POST', '/v1/webhooks/psp', JSON.parse(body));
    assert.equal(none.status, 400);
    assert.equal(none.body.code, 'WEBHOOK_SIGNATURE');
    const wrong = await fetch(`${env.base}/v1/webhooks/psp`, { method: 'POST', headers: { 'content-type': 'application/json', 'psp-signature': signPayload('yanlis', body) }, body });
    assert.equal(wrong.status, 400);
    const replay = await fetch(`${env.base}/v1/webhooks/psp`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'psp-signature': signPayload(SECRET, body, Math.floor(Date.now() / 1000) - 600) }, body,
    });
    assert.equal(replay.status, 400);
    assert.equal((await q('SELECT * FROM webhook_events WHERE event_id = $1', ['evt_sahte'])).length, 0);
  });

  it('bilinmeyen türde imzalı olay kabul edilir ve yok sayılır', async () => {
    const body = JSON.stringify({ id: 'evt_bilinmeyen', type: 'customer.created', data: { object: {} } });
    const r = await fetch(`${env.base}/v1/webhooks/psp`, { method: 'POST', headers: { 'content-type': 'application/json', 'psp-signature': signPayload(SECRET, body) }, body });
    assert.equal(r.status, 200);
  });
});

describe('ödeme akışı (sandbox)', () => {
  let p: Awaited<ReturnType<typeof playerWithEntry>>;
  before(async () => {
    p = await playerWithEntry();
  });

  it('barındırılan ödeme sayfası CSP ile sunulur; kart verisi uygulama API\'sine hiç gelmez', async () => {
    const pay1 = await newPayment(p);
    const page = await fetch(new URL(pay1.checkoutUrl!, env.base));
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type')!, /text\/html/);
    assert.match(page.headers.get('content-security-policy')!, /script-src 'self'/);
    const html = await page.text();
    assert.match(html, /<script src="\/sandbox-psp\/checkout\.js"/);
    assert.doesNotMatch(html, /<script>|style="/);
    assert.equal((await fetch(`${env.base}/sandbox-psp/checkout.js`)).status, 200);
    assert.equal((await fetch(`${env.base}/sandbox-psp/checkout.css`)).status, 200);
    // payments tablosunda kart numarası için sütun yok; yalnız son 4 hane.
    const cols = await q<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'payments'`);
    assert.ok(!cols.some((c) => /card_number|pan|cvc/.test(c.column_name)));
  });

  it('aynı idempotency anahtarı aynı ödemeyi döndürür (çift tıklama)', async () => {
    const input = {
      userId: p.id, tournamentId: p.tournamentId, entryId: p.entryId, amountCents: 1000, currency: 'USD',
      idempotencyKey: 'cift-tik', description: 'x', returnUrl: (id: string) => `/#/odeme/${id}`,
    };
    const [a, b] = await Promise.all([env.app.payments.createPayment(input), env.app.payments.createPayment(input)]);
    assert.equal(a.paymentId, b.paymentId);
    assert.equal((await q('SELECT * FROM payments WHERE idempotency_key = $1', ['cift-tik'])).length, 1);
  });

  it('başarılı ödeme: webhook ile kesinleşir, defter doğru (K9: ücret ayrı gider), olay yayınlanır', async () => {
    const before = { clearing: await bal('PSP_CLEARING:USD'), fees: await bal('PSP_FEES:USD'), inn: await bal('USER_PAYMENT_IN:USD') };
    const x = await newPayment(p, 1000);
    // Webhook gelmeden önce: tarayıcı ne derse desin ödeme kesinleşmemiştir.
    const st0 = await p.client.get(`/v1/payments/${x.paymentId}`);
    assert.equal(st0.body.status, 'CREATED');
    const r = await pay(x.intentId, x.secret, '4242 4242 4242 4242');
    assert.equal(r.body.status, 'succeeded');
    assert.equal(r.body.returnUrl, `/#/odeme/${x.paymentId}`);
    await flush();
    const st = await p.client.get(`/v1/payments/${x.paymentId}`);
    assert.equal(st.body.status, 'SUCCEEDED');
    assert.equal(st.body.cardLast4, '4242');
    const fee = Math.round(1000 * 0.029) + 30;
    assert.equal(await bal('PSP_CLEARING:USD') - before.clearing, 1000 - fee);
    assert.equal(await bal('PSP_FEES:USD') - before.fees, fee);
    assert.equal(await bal('USER_PAYMENT_IN:USD') - before.inn, 1000);
    const ev = await q(`SELECT payload FROM outbox WHERE topic = 'payment.succeeded' AND payload->>'paymentId' = $1`, [x.paymentId]);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].payload.userId, p.id);
  });

  it('yinelenen webhook (her olay iki kez + elle tekrar) defteri ikinci kez etkilemez', async () => {
    env.app.sandbox!.options.duplicateRate = 1;
    try {
      const before = await bal('PSP_CLEARING:USD');
      const x = await newPayment(p, 2500);
      await pay(x.intentId, x.secret, '4242424242424242');
      await flush();
      const fee = Math.round(2500 * 0.029) + 30;
      assert.equal(await bal('PSP_CLEARING:USD') - before, 2500 - fee);
      // Aynı olayı elle, geçerli imzayla tekrar gönder.
      const evRow = (await q<{ id: string; type: string; payload: { data: unknown } }>(
        `SELECT id, type, payload FROM psp_sandbox_events WHERE payload->'data'->'object'->>'id' = $1`, [x.intentId]))[0]!;
      const body = JSON.stringify({ id: evRow.id, type: evRow.type, created: 0, data: evRow.payload.data });
      const r = await fetch(`${env.base}/v1/webhooks/psp`, { method: 'POST', headers: { 'content-type': 'application/json', 'psp-signature': signPayload(SECRET, body) }, body });
      assert.deepEqual(await r.json(), { received: true, duplicate: true });
      assert.equal(await bal('PSP_CLEARING:USD') - before, 2500 - fee);
      assert.equal((await q(`SELECT 1 FROM outbox WHERE topic = 'payment.succeeded' AND payload->>'paymentId' = $1`, [x.paymentId])).length, 1);
    } finally {
      env.app.sandbox!.options.duplicateRate = 0;
    }
  });

  it('eşzamanlı aynı webhook: biri işler, diğeri yineleme sayılır', async () => {
    const x = await newPayment(p, 700);
    env.app.sandbox!.stop();
    try {
      await pay(x.intentId, x.secret, '4242424242424242');
      const evRow = (await q<{ id: string; type: string; payload: { data: unknown } }>(
        `SELECT id, type, payload FROM psp_sandbox_events WHERE delivered_at IS NULL AND payload->'data'->'object'->>'id' = $1`, [x.intentId]))[0]!;
      const body = JSON.stringify({ id: evRow.id, type: evRow.type, created: 0, data: evRow.payload.data });
      const send = () => fetch(`${env.base}/v1/webhooks/psp`, { method: 'POST', headers: { 'content-type': 'application/json', 'psp-signature': signPayload(SECRET, body) }, body }).then((r) => r.json());
      const results = await Promise.all([send(), send(), send(), send()]);
      assert.equal(results.filter((r: any) => r.duplicate === false).length, 1);
      assert.equal((await q(`SELECT 1 FROM ledger_transactions WHERE idempotency_key = $1`, [`payment:${x.paymentId}:received`])).length, 1);
    } finally {
      await flush();
      env.app.sandbox!.start();
    }
  });

  it('reddedilen kart: FAILED + neden; aynı ödeme başka kartla tamamlanabilir', async () => {
    const x = await newPayment(p, 1000);
    const r = await pay(x.intentId, x.secret, '4000 0000 0000 0002');
    assert.equal(r.body.status, 'failed');
    await flush();
    let st = await p.client.get(`/v1/payments/${x.paymentId}`);
    assert.equal(st.body.status, 'FAILED');
    assert.equal(st.body.failureReason, 'card_declined');
    assert.ok(st.body.checkoutUrl, 'yeniden deneme için ödeme sayfası adresi döner');
    const r2 = await pay(x.intentId, x.secret, '4242424242424242');
    assert.equal(r2.body.status, 'succeeded');
    await flush();
    st = await p.client.get(`/v1/payments/${x.paymentId}`);
    assert.equal(st.body.status, 'SUCCEEDED');
    assert.equal(st.body.failureReason, null);
  });

  it('yetersiz bakiye ve geçersiz kart/tarih/CVC', async () => {
    const x = await newPayment(p, 1000);
    assert.equal((await pay(x.intentId, x.secret, '4000000000009995')).body.reason, 'insufficient_funds');
    assert.equal((await pay(x.intentId, x.secret, '4242424242424241')).body.code, 'PSP_INVALID_CARD');
    const c = new Client(env.base);
    assert.equal((await c.post(`/sandbox-psp/v1/checkout/${x.intentId}/pay`, { secret: x.secret, card: '4242424242424242', exp: '01/20', cvc: '123' })).body.code, 'PSP_INVALID_EXPIRY');
    assert.equal((await c.post(`/sandbox-psp/v1/checkout/${x.intentId}/pay`, { secret: x.secret, card: '4242424242424242', exp: '12/39', cvc: '1' })).body.code, 'PSP_INVALID_CVC');
    assert.equal((await c.post(`/sandbox-psp/v1/checkout/${x.intentId}/pay`, { secret: 'yanlis', card: '4242424242424242', exp: '12/39', cvc: '123' })).status, 404);
  });

  it('3D Secure: onay → başarılı; red → authentication_failed', async () => {
    const x = await newPayment(p, 1000);
    assert.equal((await pay(x.intentId, x.secret, '4000000000003220')).body.status, 'requires_action');
    const ok = await new Client(env.base).post(`/sandbox-psp/v1/checkout/${x.intentId}/3ds`, { secret: x.secret, approve: true });
    assert.equal(ok.body.status, 'succeeded');
    const y = await newPayment(p, 1000);
    await pay(y.intentId, y.secret, '4000000000003220');
    const no = await new Client(env.base).post(`/sandbox-psp/v1/checkout/${y.intentId}/3ds`, { secret: y.secret, approve: false });
    assert.equal(no.body.reason, 'authentication_failed');
    await flush();
    assert.equal((await p.client.get(`/v1/payments/${x.paymentId}`)).body.status, 'SUCCEEDED');
    assert.equal((await p.client.get(`/v1/payments/${y.paymentId}`)).body.failureReason, 'authentication_failed');
  });

  it('başkasının ödemesi görünmez; kendi ödeme listesi', async () => {
    const x = await newPayment(p, 1000);
    const other = await newPlayer(env.base);
    assert.equal((await other.client.get(`/v1/payments/${x.paymentId}`)).status, 404);
    assert.equal((await new Client(env.base).get(`/v1/payments/${x.paymentId}`)).status, 401);
    const mine = await p.client.get('/v1/me/payments');
    assert.ok(mine.body.payments.some((m: any) => m.id === x.paymentId));
  });

  it('iptal edilmiş (süresi dolmuş) ödemeye geç gelen para yine kaydedilir; olay önceki durumu taşır', async () => {
    const x = await newPayment(p, 1000);
    await env.app.payments.cancelPending(env.app.pool, x.paymentId);
    await pay(x.intentId, x.secret, '4242424242424242');
    await flush();
    const ev = await q(`SELECT payload FROM outbox WHERE topic = 'payment.succeeded' AND payload->>'paymentId' = $1`, [x.paymentId]);
    assert.equal(ev[0].payload.previousStatus, 'CANCELED');
  });
});

describe('iade, ters ibraz, mutabakat', () => {
  it('yetim iade: kuyruk → sağlayıcı → webhook → defter; ikinci talep reddedilir', async () => {
    const p = await playerWithEntry();
    const x = await newPayment(p, 1000);
    await pay(x.intentId, x.secret, '4242424242424242');
    await flush();
    const inBefore = await bal('USER_PAYMENT_IN:USD');
    const after: (() => void)[] = [];
    assert.equal(await env.app.payments.requestRefund(env.app.pool, { paymentId: x.paymentId, source: 'orphan', reason: 'test' }, after), true);
    assert.equal(await env.app.payments.requestRefund(env.app.pool, { paymentId: x.paymentId, source: 'orphan', reason: 'test' }), false);
    assert.equal(await env.app.payments.processRefunds(), 1);
    assert.equal(await env.app.payments.processRefunds(), 0, 'gönderilmiş iade tekrar gönderilmez');
    await flush();
    const st = await p.client.get(`/v1/payments/${x.paymentId}`);
    assert.equal(st.body.status, 'REFUNDED');
    assert.equal(st.body.refundStatus, 'SUCCEEDED');
    assert.equal(inBefore - (await bal('USER_PAYMENT_IN:USD')), 1000);
    const rep = await env.app.payments.reconcile('USD');
    assert.equal(rep.diffCents, 0, JSON.stringify(rep));
    assert.ok(rep.ok);
  });

  it('başarısız olmayan ödeme iade edilemez (CREATED/FAILED)', async () => {
    const p = await playerWithEntry();
    const x = await newPayment(p, 1000);
    assert.equal(await env.app.payments.requestRefund(env.app.pool, { paymentId: x.paymentId, source: 'orphan', reason: 'test' }), false);
  });

  it('sağlayıcı hatasında iade yeniden denenir (aynı idempotency anahtarı)', async () => {
    const p = await playerWithEntry();
    const x = await newPayment(p, 1000);
    await pay(x.intentId, x.secret, '4242424242424242');
    await flush();
    const prov = env.app.payments.provider as any;
    const real = prov.refund.bind(prov);
    let calls = 0;
    prov.refund = async (i: any) => {
      calls++;
      if (calls === 1) throw new Error('ağ hatası');
      return real(i);
    };
    try {
      await env.app.payments.requestRefund(env.app.pool, { paymentId: x.paymentId, source: 'orphan', reason: 'test' });
      await env.app.payments.processRefunds();
      const r1 = (await q('SELECT * FROM refunds WHERE payment_id = $1', [x.paymentId]))[0];
      assert.equal(r1.attempts, 1);
      assert.equal(r1.last_error, 'ağ hatası');
      assert.equal(r1.provider_ref, null);
      await env.app.pool.query(`UPDATE refunds SET updated_at = now() - interval '1 hour' WHERE payment_id = $1`, [x.paymentId]);
      assert.equal(await env.app.payments.processRefunds(), 1);
      await flush();
      assert.equal((await q('SELECT status FROM refunds WHERE payment_id = $1', [x.paymentId]))[0].status, 'SUCCEEDED');
    } finally {
      prov.refund = real;
    }
  });

  it('ters ibraz: gider kaydı, hesap dondurulur, girişi engellenir, denetim kaydı', async () => {
    const p = await playerWithEntry();
    const x = await newPayment(p, 1000);
    await pay(x.intentId, x.secret, '4242424242424242');
    await flush();
    const cb = await bal('CHARGEBACKS:USD');
    const d = await new Client(env.base).post('/sandbox-psp/v1/test/disputes', { intentId: x.intentId });
    assert.ok(d.body.disputeId);
    await flush();
    assert.equal((await q('SELECT status FROM payments WHERE id = $1', [x.paymentId]))[0].status, 'DISPUTED');
    assert.equal(await bal('CHARGEBACKS:USD') - cb, 1000);
    assert.equal((await q('SELECT status FROM users WHERE id = $1', [p.id]))[0].status, 'frozen');
    const login = await new Client(env.base).post('/v1/auth/login', { email: p.email, password: STRONG_PASSWORD });
    assert.equal(login.body.code, 'ACCOUNT_LOCKED');
    assert.equal((await q(`SELECT 1 FROM audit_log WHERE action = 'user.frozen' AND target_id = $1`, [p.id])).length, 1);
    const rep = await env.app.payments.reconcile('USD');
    assert.equal(rep.diffCents, 0, JSON.stringify(rep));
  });

  it('mutabakat, teslim edilmemiş webhook\'u fark olarak yakalar; teslimden sonra fark kapanır', async () => {
    const p = await playerWithEntry();
    env.app.sandbox!.stop();
    try {
      const x = await newPayment(p, 1500);
      await pay(x.intentId, x.secret, '4242424242424242');
      const rep = await env.app.payments.reconcile('USD');
      assert.equal(rep.ok, false);
      assert.equal(rep.diffCents, 1500 - (Math.round(1500 * 0.029) + 30));
    } finally {
      await flush();
      env.app.sandbox!.start();
    }
    const rep2 = await env.app.payments.reconcile('USD');
    assert.ok(rep2.ok, JSON.stringify(rep2));
    const saved = await q('SELECT * FROM reconciliation_reports ORDER BY id DESC LIMIT 2');
    assert.equal(saved[0].diff_cents, 0);
    assert.notEqual(saved[1].diff_cents, 0);
  });

  it('defter her an dengeli; kullanıcı yükümlülüğü negatife düşmedi', async () => {
    const inv = await env.app.ledger.invariants();
    assert.ok(inv.balanced);
    assert.equal(inv.negativeUserBalances, 0);
  });
});
