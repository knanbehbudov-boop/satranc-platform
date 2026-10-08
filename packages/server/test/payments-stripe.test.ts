/**
 * Stripe bağdaştırıcısı: bu ortamda Stripe'a ağ erişimi yok; yerel sahte sunucu
 * Stripe API'sinin istek biçimini (form kodlama, kimlik doğrulama, idempotency başlığı)
 * doğrular. Webhook eşlemesi Stripe olay biçimiyle sınanır.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { signPayload } from '../src/modules/payments/provider.ts';
import { formEncode, StripeError, StripePsp } from '../src/modules/payments/stripe.ts';

interface Seen { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }
const seen: Seen[] = [];
let server: Server;
let base = '';

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== 'Bearer sk_test_abc') {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: { message: 'Invalid API Key', code: 'api_key_invalid' } }));
        return;
      }
      if (req.url === '/v1/checkout/sessions') res.end(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1', payment_intent: null }));
      else if (req.url === '/v1/refunds') res.end(JSON.stringify({ id: 're_1' }));
      else if (req.url?.startsWith('/v1/payment_intents/pi_1')) {
        res.end(JSON.stringify({ status: 'succeeded', amount: 1000, amount_received: 1000, latest_charge: { balance_transaction: { fee: 59 } } }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { message: 'No such route' } }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

const psp = () => new StripePsp({ secretKey: 'sk_test_abc', webhookSecret: 'whsec_s', publicBaseUrl: 'https://satranc.example/', apiBase: base });

describe('Stripe bağdaştırıcısı', () => {
  it('form kodlama: iç içe nesne ve diziler Stripe biçiminde', () => {
    assert.equal(
      decodeURIComponent(formEncode({ a: 1, b: { c: 'x y' }, d: [{ e: 2 }], f: ['p', 'q'], g: undefined })),
      'a=1&b[c]=x y&d[0][e]=2&f[0]=p&f[1]=q',
    );
  });

  it('Checkout Session açar: tutar, para birimi, dönüş adresi, metadata, idempotency başlığı', async () => {
    const r = await psp().createIntent({
      amountCents: 1000, currency: 'USD', idempotencyKey: 'payment:abc', returnUrl: '/#/odeme/abc',
      metadata: { paymentId: 'abc', description: 'Blitz 8' },
    });
    assert.equal(r.checkoutUrl, 'https://checkout.stripe.com/c/pay/cs_test_1');
    assert.equal(r.ref, 'cs_test_1');
    const s = seen.at(-1)!;
    assert.equal(s.headers['idempotency-key'], 'payment:abc');
    assert.equal(s.headers['content-type'], 'application/x-www-form-urlencoded');
    const form = new URLSearchParams(s.body);
    assert.equal(form.get('mode'), 'payment');
    assert.equal(form.get('line_items[0][price_data][unit_amount]'), '1000');
    assert.equal(form.get('line_items[0][price_data][currency]'), 'usd');
    assert.equal(form.get('success_url'), 'https://satranc.example/#/odeme/abc');
    assert.equal(form.get('payment_intent_data[metadata][paymentId]'), 'abc');
    assert.equal(form.get('client_reference_id'), 'abc');
  });

  it('iade ve ödeme sorgusu (ücret balance_transaction\'dan)', async () => {
    assert.deepEqual(await psp().refund({ ref: 'pi_1', amountCents: 1000, idempotencyKey: 'refund:abc' }), { refundRef: 're_1' });
    assert.equal(new URLSearchParams(seen.at(-1)!.body).get('payment_intent'), 'pi_1');
    assert.equal(seen.at(-1)!.headers['idempotency-key'], 'refund:abc');
    assert.deepEqual(await psp().retrieve('pi_1'), { status: 'succeeded', amountCents: 1000, feeCents: 59 });
  });

  it('Stripe hatası anlamlı hata olarak döner', async () => {
    const bad = new StripePsp({ secretKey: 'sk_yanlis', webhookSecret: 'x', publicBaseUrl: 'https://x', apiBase: base });
    await assert.rejects(bad.refund({ ref: 'pi_1', amountCents: 1, idempotencyKey: 'k' }), (e: unknown) => e instanceof StripeError && e.status === 401 && e.code === 'api_key_invalid');
  });

  it('webhook eşlemesi: Stripe olay türleri normalleşir, imza Stripe-Signature başlığından', () => {
    const p = psp();
    const ev = (type: string, object: Record<string, unknown>) => {
      const body = Buffer.from(JSON.stringify({ id: `evt_${type}`, type, data: { object } }));
      return p.verifyWebhook(body, { 'stripe-signature': signPayload('whsec_s', body) });
    };
    const ok = ev('payment_intent.succeeded', { id: 'pi_1', amount_received: 1000, currency: 'usd', metadata: { paymentId: 'abc' } });
    assert.equal(ok.type, 'payment.succeeded');
    assert.equal(ok.currency, 'USD');
    assert.equal(ok.paymentId, 'abc');
    assert.equal(ok.feeCents, undefined, 'ücret webhook\'ta yok → servis retrieve ile alır');
    assert.equal(ev('payment_intent.payment_failed', { id: 'pi_1', last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds' } }).failureReason, 'insufficient_funds');
    const rf = ev('charge.refunded', { payment_intent: 'pi_1', amount_refunded: 1000, currency: 'usd', refunds: { data: [{ id: 're_1' }] } });
    assert.deepEqual([rf.type, rf.ref, rf.refundRef], ['refund.succeeded', 'pi_1', 're_1']);
    assert.equal(ev('charge.dispute.created', { payment_intent: 'pi_1', amount: 1000, currency: 'usd' }).type, 'dispute.created');
    assert.equal(ev('customer.created', {}).type, 'ignored');
    const body = Buffer.from('{}');
    assert.throws(() => p.verifyWebhook(body, { 'psp-signature': signPayload('whsec_s', body) }), /başlığı yok/);
  });
});

describe('ödeme yapılandırması', () => {
  const withEnv = (vars: Record<string, string>, fn: () => void) => {
    const old = { ...process.env };
    Object.assign(process.env, vars);
    try {
      fn();
    } finally {
      for (const k of Object.keys(vars)) delete process.env[k];
      Object.assign(process.env, old);
    }
  };
  const prodBase = { NODE_ENV: 'production', DATABASE_URL: 'postgres://x@y/z', JWT_SECRET: 'x'.repeat(40), PSP_WEBHOOK_SECRET: 'whsec_x', DEV_MAILBOX: '0', STOCKFISH_PATH: '/usr/games/stockfish' };

  it('üretimde sandbox sağlayıcısı reddedilir', () => {
    withEnv({ ...prodBase, PAYMENT_PROVIDER: 'sandbox' }, () => assert.throws(() => loadConfig(), /Sandbox ödeme sağlayıcısı üretimde/));
  });
  it('üretimde webhook anahtarı zorunlu; stripe için anahtar ve dış adres zorunlu', () => {
    withEnv({ ...prodBase, PSP_WEBHOOK_SECRET: '', PAYMENT_PROVIDER: 'stripe' }, () => assert.throws(() => loadConfig(), /PSP_WEBHOOK_SECRET/));
    withEnv({ ...prodBase, PAYMENT_PROVIDER: 'stripe' }, () => assert.throws(() => loadConfig(), /STRIPE_SECRET_KEY/));
    withEnv({ ...prodBase, PAYMENT_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_live_x', PUBLIC_BASE_URL: 'https://satranc.example' }, () => {
      assert.equal(loadConfig().paymentProvider, 'stripe');
    });
  });
});
