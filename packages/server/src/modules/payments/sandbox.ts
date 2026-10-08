/**
 * Sandbox ödeme sağlayıcısı: gerçek PSP (Stripe vb.) onayı ve ağ erişimi olmadan
 * ödeme akışını uçtan uca test etmek için. Davranışı Stripe'a yakındır:
 *  - ödeme niyeti (payment intent), idempotency anahtarı,
 *  - sağlayıcının barındırdığı ödeme sayfası (kart bilgisi uygulamaya hiç gelmez),
 *  - 3D Secure adımı, red senaryoları,
 *  - imzalı webhook'ların GERÇEK HTTP isteğiyle, gecikmeli, yinelenen ve tekrar
 *    denemeli teslimi (uygulamanın idempotency ve imza kodu gerçekten çalışır),
 *  - iade ve ters ibraz (dispute).
 * Üretimde kapalıdır (config: üretimde sandbox reddedilir).
 *
 * Test kartları:
 *   4242 4242 4242 4242  başarılı
 *   4000 0000 0000 3220  3D Secure ister
 *   4000 0000 0000 0002  reddedilir (card_declined)
 *   4000 0000 0000 9995  reddedilir (insufficient_funds)
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from '../../infra/db/pg.ts';
import { AppError, badRequest, notFound } from '../../infra/errors.ts';
import type { Logger } from '../../infra/log.ts';
import { RawResponse, type Router } from '../../infra/http/router.ts';
import {
  estimateFee,
  signPayload,
  verifySignature,
  WebhookSignatureError,
  type CreatedIntent,
  type CreateIntentInput,
  type PaymentProvider,
  type WebhookEvent,
} from './provider.ts';

const id = (prefix: string): string => `${prefix}_${randomBytes(12).toString('hex')}`;

export interface SandboxOptions {
  /** Webhook'ların ilk teslim gecikmesi (ms). */
  deliveryDelayMs: number;
  /** Aynı webhook'un ikinci kez gönderilme olasılığı (0–1). */
  duplicateRate: number;
}

interface IntentRow {
  id: string;
  amount_cents: number;
  currency: string;
  status: string;
  metadata: Record<string, string>;
  client_secret: string;
  card_last4: string | null;
  fee_cents: number;
  failure_reason: string | null;
}

function luhn(num: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let n = Number(num[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export class SandboxPsp implements PaymentProvider {
  readonly name = 'sandbox';
  private readonly pool: Pool;
  private readonly logger: Logger;
  private readonly secret: string;
  private webhookUrl: () => string;
  private timer: NodeJS.Timeout | null = null;
  private delivering = false;
  options: SandboxOptions;

  constructor(deps: { pool: Pool; logger: Logger; webhookSecret: string; webhookUrl: () => string; options?: Partial<SandboxOptions> }) {
    this.pool = deps.pool;
    this.logger = deps.logger;
    this.secret = deps.webhookSecret;
    this.webhookUrl = deps.webhookUrl;
    this.options = { deliveryDelayMs: 0, duplicateRate: 0, ...deps.options };
  }

  // ---- PaymentProvider (uygulamanın gördüğü API) --------------------------------

  async createIntent(input: CreateIntentInput): Promise<CreatedIntent> {
    const existing = await this.pool.query<IntentRow>('SELECT * FROM psp_sandbox_intents WHERE idempotency_key = $1', [input.idempotencyKey]);
    let row = existing.rows[0];
    if (!row) {
      const r = await this.pool.query<IntentRow>(
        `INSERT INTO psp_sandbox_intents (id, amount_cents, currency, status, metadata, idempotency_key, client_secret)
         VALUES ($1, $2, $3, 'requires_payment_method', $4, $5, $6)
         ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key RETURNING *`,
        [id('pi'), input.amountCents, input.currency, { ...input.metadata, returnUrl: input.returnUrl }, input.idempotencyKey, id('secret')],
      );
      row = r.rows[0] as IntentRow;
    }
    return { ref: row.id, clientSecret: row.client_secret, checkoutUrl: `/sandbox-psp/checkout/${row.id}?secret=${row.client_secret}` };
  }

  async refund(input: { ref: string; amountCents: number; idempotencyKey: string }): Promise<{ refundRef: string }> {
    return this.pool.tx(async (tx) => {
      const ex = await tx.query<{ id: string }>('SELECT id FROM psp_sandbox_refunds WHERE idempotency_key = $1', [input.idempotencyKey]);
      if (ex.rows[0]) return { refundRef: ex.rows[0].id };
      const it = await tx.query<IntentRow>('SELECT * FROM psp_sandbox_intents WHERE id = $1 FOR UPDATE', [input.ref]);
      const intent = it.rows[0];
      if (!intent) throw notFound('PSP_NO_SUCH_INTENT', 'Ödeme bulunamadı');
      if (intent.status !== 'succeeded') throw badRequest('PSP_NOT_REFUNDABLE', 'Başarılı olmayan ödeme iade edilemez');
      const already = await tx.query<{ s: number }>('SELECT COALESCE(sum(amount_cents), 0)::bigint AS s FROM psp_sandbox_refunds WHERE intent_id = $1', [intent.id]);
      if ((already.rows[0] as { s: number }).s + input.amountCents > intent.amount_cents) throw badRequest('PSP_REFUND_EXCEEDS', 'İade tutarı ödemeyi aşıyor');
      const refundId = id('re');
      await tx.query('INSERT INTO psp_sandbox_refunds (id, intent_id, amount_cents, idempotency_key) VALUES ($1, $2, $3, $4)', [refundId, intent.id, input.amountCents, input.idempotencyKey]);
      await this.emit(tx, 'charge.refunded', { object: { id: refundId, payment_intent: intent.id, amount_refunded: input.amountCents, currency: intent.currency } });
      return { refundRef: refundId };
    });
  }

  async retrieve(ref: string): Promise<{ status: string; amountCents: number; feeCents: number }> {
    const r = await this.pool.query<IntentRow>('SELECT * FROM psp_sandbox_intents WHERE id = $1', [ref]);
    const row = r.rows[0];
    if (!row) throw notFound('PSP_NO_SUCH_INTENT', 'Ödeme bulunamadı');
    return { status: row.status, amountCents: row.amount_cents, feeCents: row.fee_cents };
  }

  verifyWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEvent {
    const h = headers['psp-signature'];
    verifySignature(this.secret, raw, Array.isArray(h) ? h[0] : h);
    let ev: { id: string; type: string; data: { object: Record<string, any> } };
    try {
      ev = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new WebhookSignatureError('Gövde JSON değil');
    }
    const o = ev.data?.object ?? {};
    switch (ev.type) {
      case 'payment_intent.succeeded':
        return { id: ev.id, type: 'payment.succeeded', providerType: ev.type, ref: o.id, paymentId: o.metadata?.paymentId, amountCents: o.amount_received, feeCents: o.fee, currency: o.currency, cardLast4: o.card_last4, raw: ev };
      case 'payment_intent.payment_failed':
        return { id: ev.id, type: 'payment.failed', providerType: ev.type, ref: o.id, paymentId: o.metadata?.paymentId, failureReason: o.last_payment_error?.code ?? 'failed', raw: ev };
      case 'charge.refunded':
        return { id: ev.id, type: 'refund.succeeded', providerType: ev.type, ref: o.payment_intent, refundRef: o.id, amountCents: o.amount_refunded, currency: o.currency, raw: ev };
      case 'charge.dispute.created':
        return { id: ev.id, type: 'dispute.created', providerType: ev.type, ref: o.payment_intent, amountCents: o.amount, currency: o.currency, raw: ev };
      default:
        return { id: ev.id, type: 'ignored', providerType: ev.type, ref: null, raw: ev };
    }
  }

  async balance(currency: string): Promise<number> {
    const r = await this.pool.query<{ captured: number; fees: number; refunded: number; disputed: number }>(
      `SELECT
         (SELECT COALESCE(sum(amount_cents), 0) FROM psp_sandbox_intents WHERE status = 'succeeded' AND currency = $1)::bigint AS captured,
         (SELECT COALESCE(sum(fee_cents), 0) FROM psp_sandbox_intents WHERE status = 'succeeded' AND currency = $1)::bigint AS fees,
         (SELECT COALESCE(sum(r.amount_cents), 0) FROM psp_sandbox_refunds r JOIN psp_sandbox_intents i ON i.id = r.intent_id WHERE i.currency = $1)::bigint AS refunded,
         (SELECT COALESCE(sum(d.amount_cents), 0) FROM psp_sandbox_disputes d JOIN psp_sandbox_intents i ON i.id = d.intent_id WHERE i.currency = $1)::bigint AS disputed`,
      [currency],
    );
    const x = r.rows[0] as { captured: number; fees: number; refunded: number; disputed: number };
    return x.captured - x.fees - x.refunded - x.disputed;
  }

  // ---- olay üretimi ve teslimi ----------------------------------------------------

  private async emit(q: { query: Pool['query'] }, type: string, data: { object: Record<string, unknown> }): Promise<void> {
    await q.query(
      `INSERT INTO psp_sandbox_events (id, type, payload, next_attempt_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
      [id('evt'), type, { data }, this.options.deliveryDelayMs / 1000],
    );
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.deliver(), 100);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Teslim edilmemiş olayları gönderir (testler beklemeden çağırabilir). */
  async deliver(): Promise<number> {
    if (this.delivering) return 0;
    this.delivering = true;
    let sent = 0;
    try {
      const due = await this.pool.tx(async (tx) => {
        const r = await tx.query<{ id: string; type: string; payload: { data: unknown }; attempts: number }>(
          `SELECT id, type, payload, attempts FROM psp_sandbox_events
           WHERE delivered_at IS NULL AND next_attempt_at <= now() ORDER BY created_at LIMIT 25 FOR UPDATE SKIP LOCKED`,
        );
        for (const e of r.rows) {
          // Bekleyen denemeyi ileriye at; başarılı olursa aşağıda teslim edildi işaretlenir.
          await tx.query(`UPDATE psp_sandbox_events SET attempts = attempts + 1, next_attempt_at = now() + make_interval(secs => $2) WHERE id = $1`,
            [e.id, Math.min(60, 2 ** e.attempts)]);
        }
        return r.rows;
      });
      for (const e of due) {
        const body = JSON.stringify({ id: e.id, type: e.type, created: Math.floor(Date.now() / 1000), data: e.payload.data });
        const times = Math.random() < this.options.duplicateRate ? 2 : 1;
        let ok = false;
        for (let i = 0; i < times; i++) {
          try {
            const res = await fetch(this.webhookUrl(), {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'psp-signature': signPayload(this.secret, body) },
              body,
            });
            ok = ok || res.ok;
          } catch (err) {
            this.logger.warn('Sandbox webhook teslim edilemedi', { eventId: e.id, error: err });
          }
        }
        if (ok) {
          await this.pool.query('UPDATE psp_sandbox_events SET delivered_at = now() WHERE id = $1', [e.id]);
          sent++;
        }
      }
    } finally {
      this.delivering = false;
    }
    return sent;
  }

  // ---- barındırılan ödeme sayfası (PSP'nin arayüzü) --------------------------------

  private async intentForCheckout(intentId: string, secret: unknown): Promise<IntentRow> {
    const r = await this.pool.query<IntentRow>('SELECT * FROM psp_sandbox_intents WHERE id = $1', [intentId]);
    const row = r.rows[0];
    if (!row || row.client_secret !== secret) throw notFound('PSP_NO_SUCH_INTENT', 'Ödeme bulunamadı');
    return row;
  }

  private async succeed(row: IntentRow, last4: string): Promise<void> {
    await this.pool.tx(async (tx) => {
      const fee = estimateFee(row.amount_cents);
      const r = await tx.query(
        `UPDATE psp_sandbox_intents SET status = 'succeeded', card_last4 = $2, fee_cents = $3, updated_at = now()
         WHERE id = $1 AND status IN ('requires_payment_method', 'requires_action', 'failed')`,
        [row.id, last4, fee],
      );
      if (!r.rowCount) return;
      await this.emit(tx, 'payment_intent.succeeded', {
        object: { id: row.id, amount_received: row.amount_cents, currency: row.currency, fee, card_last4: last4, metadata: row.metadata },
      });
    });
  }

  private async fail(row: IntentRow, code: string, last4: string): Promise<void> {
    await this.pool.tx(async (tx) => {
      await tx.query(`UPDATE psp_sandbox_intents SET status = 'failed', failure_reason = $2, card_last4 = $3, updated_at = now() WHERE id = $1`, [row.id, code, last4]);
      await this.emit(tx, 'payment_intent.payment_failed', { object: { id: row.id, last_payment_error: { code }, metadata: row.metadata } });
    });
  }

  /** Test amaçlı ters ibraz (yalnız sandbox). */
  async createDispute(intentId: string): Promise<string> {
    return this.pool.tx(async (tx) => {
      const it = await tx.query<IntentRow>(`SELECT * FROM psp_sandbox_intents WHERE id = $1 AND status = 'succeeded'`, [intentId]);
      const row = it.rows[0];
      if (!row) throw notFound('PSP_NO_SUCH_INTENT', 'Başarılı ödeme bulunamadı');
      const disputeId = id('dp');
      await tx.query('INSERT INTO psp_sandbox_disputes (id, intent_id, amount_cents) VALUES ($1, $2, $3)', [disputeId, row.id, row.amount_cents]);
      await this.emit(tx, 'charge.dispute.created', { object: { id: disputeId, payment_intent: row.id, amount: row.amount_cents, currency: row.currency } });
      return disputeId;
    });
  }

  routes(router: Router): void {
    const page = readFileSync(join(import.meta.dirname, 'sandbox-checkout.html'), 'utf8');
    const script = readFileSync(join(import.meta.dirname, 'sandbox-checkout.js'), 'utf8');
    const css = readFileSync(join(import.meta.dirname, 'sandbox-checkout.css'), 'utf8');
    router.get('/sandbox-psp/checkout/:id', () => new RawResponse('text/html; charset=utf-8', page));
    router.get('/sandbox-psp/checkout.js', () => new RawResponse('text/javascript; charset=utf-8', script));
    router.get('/sandbox-psp/checkout.css', () => new RawResponse('text/css; charset=utf-8', css));
    router.get('/sandbox-psp/v1/checkout/:id', async (ctx) => {
      const row = await this.intentForCheckout(ctx.params.id as string, ctx.query.get('secret'));
      return {
        id: row.id,
        amountCents: row.amount_cents,
        currency: row.currency,
        status: row.status,
        description: row.metadata.description ?? '',
        returnUrl: row.metadata.returnUrl ?? '/',
        failureReason: row.failure_reason,
      };
    });
    router.post('/sandbox-psp/v1/checkout/:id/pay', async (ctx) => {
      const b = (ctx.body ?? {}) as { secret?: string; card?: string; exp?: string; cvc?: string };
      const row = await this.intentForCheckout(ctx.params.id as string, b.secret);
      if (row.status === 'succeeded') return { status: 'succeeded', returnUrl: row.metadata.returnUrl };
      const card = String(b.card ?? '').replace(/\s+/g, '');
      if (!/^\d{13,19}$/.test(card) || !luhn(card)) throw badRequest('PSP_INVALID_CARD', 'Kart numarası geçersiz');
      const m = /^(\d{2})\s*\/\s*(\d{2})$/.exec(String(b.exp ?? ''));
      const now = new Date();
      if (!m || Number(m[1]) < 1 || Number(m[1]) > 12 || 2000 + Number(m[2]) < now.getUTCFullYear() ||
          (2000 + Number(m[2]) === now.getUTCFullYear() && Number(m[1]) < now.getUTCMonth() + 1)) {
        throw badRequest('PSP_INVALID_EXPIRY', 'Son kullanma tarihi geçersiz');
      }
      if (!/^\d{3,4}$/.test(String(b.cvc ?? ''))) throw badRequest('PSP_INVALID_CVC', 'Güvenlik kodu geçersiz');
      const last4 = card.slice(-4);
      if (card === '4000000000000002') {
        await this.fail(row, 'card_declined', last4);
        return { status: 'failed', reason: 'card_declined' };
      }
      if (card === '4000000000009995') {
        await this.fail(row, 'insufficient_funds', last4);
        return { status: 'failed', reason: 'insufficient_funds' };
      }
      if (card === '4000000000003220') {
        await this.pool.query(`UPDATE psp_sandbox_intents SET status = 'requires_action', card_last4 = $2, updated_at = now() WHERE id = $1`, [row.id, last4]);
        return { status: 'requires_action' };
      }
      await this.succeed(row, last4);
      return { status: 'succeeded', returnUrl: row.metadata.returnUrl };
    });
    router.post('/sandbox-psp/v1/checkout/:id/3ds', async (ctx) => {
      const b = (ctx.body ?? {}) as { secret?: string; approve?: boolean };
      const row = await this.intentForCheckout(ctx.params.id as string, b.secret);
      if (row.status !== 'requires_action') throw new AppError(409, 'PSP_NO_ACTION', '3D Secure adımı beklenmiyor');
      if (b.approve) {
        await this.succeed(row, row.card_last4 ?? '0000');
        return { status: 'succeeded', returnUrl: row.metadata.returnUrl };
      }
      await this.fail(row, 'authentication_failed', row.card_last4 ?? '0000');
      return { status: 'failed', reason: 'authentication_failed' };
    });
    router.post('/sandbox-psp/v1/test/disputes', async (ctx) => {
      const b = (ctx.body ?? {}) as { intentId?: string };
      return { disputeId: await this.createDispute(String(b.intentId ?? '')) };
    });
  }
}
