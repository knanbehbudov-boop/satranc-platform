/**
 * M7 Ödeme servisi. Sağlayıcıdan bağımsızdır (PaymentProvider arayüzü).
 *
 * Doğruluk kuralları:
 *  - Ödeme durumu YALNIZ imzalı webhook ile kesinleşir; tarayıcının "ödendi" demesine güvenilmez.
 *  - Her webhook (sağlayıcı, olay kimliği) ile bir kez işlenir: webhook_events'e ekleme, işleme ve
 *    defter kaydı TEK veritabanı işlemindedir. Yinelenen/gecikmeli/sırası bozuk teslim zararsızdır.
 *  - Defter kayıtları da kendi idempotency anahtarlarını taşır (çift koruma).
 *  - Sağlayıcıya yapılan ağ çağrıları veritabanı işlemi dışında yapılır; iade bir iş kuyruğundan
 *    (refunds tablosu, PENDING) idempotency anahtarıyla gönderilir, sonucu yine webhook kesinleştirir.
 *  - Koltuk/ödül kararlarını bu modül vermez: 'payment.succeeded' olayını yayınlar, turnuva modülü tüketir.
 */
import type { Pool, Queryable } from '../../infra/db/pg.ts';
import { AppError, notFound } from '../../infra/errors.ts';
import { publish } from '../../infra/events/outbox.ts';
import { isUuid } from '../../infra/http/validate.ts';
import type { Logger } from '../../infra/log.ts';
import type { IdentityService } from '../identity/service.ts';
import type { LedgerService } from '../ledger/service.ts';
import { WebhookSignatureError, type PaymentProvider, type WebhookEvent } from './provider.ts';
import type { GeoService } from '../geo/service.ts';

export interface PaymentRow {
  id: string;
  user_id: string;
  tournament_id: string | null;
  entry_id: string | null;
  purpose: 'entry' | 'deposit';
  provider: string;
  provider_ref: string | null;
  amount_cents: number;
  currency: string;
  fee_cents: number;
  status: 'CREATED' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED' | 'DISPUTED' | 'CANCELED';
  idempotency_key: string;
  checkout_url: string | null;
  failure_reason: string | null;
  card_last4: string | null;
  created_at: Date;
}

interface RefundRow {
  id: string;
  payment_id: string;
  amount_cents: number;
  source: 'pool' | 'orphan';
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  provider_ref: string | null;
  idempotency_key: string;
  attempts: number;
}

export interface CreatePaymentInput {
  userId: string;
  /** Turnuva koltuğu dışında bir ödeme için boş bırakılır (bu durumda turnuva modülü olayı yok sayar). */
  tournamentId: string | null;
  entryId: string | null;
  /** 'deposit': bakiye yükleme (K43); varsayılan 'entry'. */
  purpose?: 'entry' | 'deposit';
  amountCents: number;
  currency: string;
  /** Aynı anahtar aynı ödemeyi döndürür (çift tıklama, yeniden deneme). */
  idempotencyKey: string;
  description: string;
  returnUrl: (paymentId: string) => string;
}

export interface ReconciliationReport {
  currency: string;
  ledgerCents: number;
  providerCents: number | null;
  inFlightRefundCents: number;
  diffCents: number | null;
  unbalancedTx: number;
  ok: boolean;
}

export class PaymentService {
  private readonly pool: Pool;
  private readonly logger: Logger;
  readonly provider: PaymentProvider;
  private readonly ledger: LedgerService;
  private readonly identity: IdentityService;
  private readonly geo: GeoService | null;
  private timer: NodeJS.Timeout | null = null;
  private refunding = false;

  constructor(deps: { pool: Pool; logger: Logger; provider: PaymentProvider; ledger: LedgerService; identity: IdentityService; geo?: GeoService }) {
    this.geo = deps.geo ?? null;
    this.pool = deps.pool;
    this.logger = deps.logger;
    this.provider = deps.provider;
    this.ledger = deps.ledger;
    this.identity = deps.identity;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.processRefunds().catch((e) => this.logger.error('İade kuyruğu hatası', { error: e })), 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- ödeme başlatma -----------------------------------------------------------

  /**
   * Ödeme kaydı oluşturur ve sağlayıcıda ödeme niyeti açar. Kart bilgisi bize hiç gelmez:
   * kullanıcı dönen checkoutUrl'de (sağlayıcının sayfası) öder.
   */
  async createPayment(input: CreatePaymentInput): Promise<{ paymentId: string; checkoutUrl: string | null; status: PaymentRow['status'] }> {
    const ins = await this.pool.query<PaymentRow>(
      `INSERT INTO payments (user_id, tournament_id, entry_id, provider, amount_cents, currency, idempotency_key, purpose)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = payments.updated_at RETURNING *`,
      [input.userId, input.tournamentId, input.entryId, this.provider.name, input.amountCents, input.currency, input.idempotencyKey, input.purpose ?? 'entry'],
    );
    const row = ins.rows[0] as PaymentRow;
    if (row.user_id !== input.userId) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Bu anahtar başka bir ödemeye ait');
    if (row.checkout_url || row.status !== 'CREATED') return { paymentId: row.id, checkoutUrl: row.checkout_url, status: row.status };

    // Ağ çağrısı işlem dışında; sağlayıcı tarafında da aynı idempotency anahtarı kullanılır.
    const intent = await this.provider.createIntent({
      amountCents: row.amount_cents,
      currency: row.currency,
      idempotencyKey: `payment:${row.id}`,
      metadata: { paymentId: row.id, userId: input.userId, tournamentId: input.tournamentId ?? '', entryId: input.entryId ?? '', purpose: row.purpose, description: input.description },
      returnUrl: input.returnUrl(row.id),
    });
    await this.pool.query(
      `UPDATE payments SET provider_ref = COALESCE(provider_ref, $2), checkout_url = $3, updated_at = now() WHERE id = $1`,
      [row.id, intent.ref, intent.checkoutUrl],
    );
    return { paymentId: row.id, checkoutUrl: intent.checkoutUrl, status: 'CREATED' };
  }

  /** Henüz ödenmemiş ödemeyi geçersiz sayar (rezervasyon süresi doldu). Sonradan para gelirse yetim iade edilir. */
  async cancelPending(q: Queryable, paymentId: string): Promise<void> {
    await q.query(`UPDATE payments SET status = 'CANCELED', updated_at = now() WHERE id = $1 AND status IN ('CREATED', 'FAILED')`, [paymentId]);
  }

  async get(q: Queryable, paymentId: string): Promise<PaymentRow | null> {
    if (!isUuid(paymentId)) return null;
    const r = await q.query<PaymentRow>('SELECT * FROM payments WHERE id = $1', [paymentId]);
    return r.rows[0] ?? null;
  }

  /** Kullanıcının kendi ödemesi (arayüz dönüş sayfası durum sorgusu). */
  async getForUser(userId: string, paymentId: string) {
    const p = await this.get(this.pool, paymentId);
    if (!p || p.user_id !== userId) throw notFound('PAYMENT_NOT_FOUND', 'Ödeme bulunamadı');
    const refund = await this.pool.query<{ status: string }>('SELECT status FROM refunds WHERE payment_id = $1', [p.id]);
    return {
      id: p.id,
      purpose: p.purpose,
      status: p.status,
      amountCents: p.amount_cents,
      currency: p.currency,
      tournamentId: p.tournament_id,
      failureReason: p.failure_reason,
      cardLast4: p.card_last4,
      refundStatus: refund.rows[0]?.status ?? null,
      checkoutUrl: p.status === 'CREATED' || p.status === 'FAILED' ? p.checkout_url : null,
      createdAt: p.created_at,
    };
  }

  async listForUser(userId: string, limit = 50) {
    const r = await this.pool.query<PaymentRow & { refund_status: string | null; tournament_name: string | null }>(
      `SELECT p.*, r.status AS refund_status, t.name AS tournament_name FROM payments p
       LEFT JOIN refunds r ON r.payment_id = p.id LEFT JOIN tournaments t ON t.id = p.tournament_id
       WHERE p.user_id = $1 ORDER BY p.created_at DESC LIMIT $2`,
      [userId, limit],
    );
    return r.rows.map((p) => ({
      id: p.id,
      purpose: p.purpose,
      status: p.status,
      amountCents: p.amount_cents,
      currency: p.currency,
      tournamentId: p.tournament_id,
      tournamentName: p.tournament_name,
      refundStatus: p.refund_status,
      cardLast4: p.card_last4,
      createdAt: p.created_at,
    }));
  }

  // ---- webhook -------------------------------------------------------------------

  async handleWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): Promise<{ duplicate: boolean; type: string }> {
    let ev: WebhookEvent;
    try {
      ev = this.provider.verifyWebhook(raw, headers);
    } catch (e) {
      if (e instanceof WebhookSignatureError) {
        this.logger.warn('Webhook imzası reddedildi', { reason: e.message });
        throw new AppError(400, 'WEBHOOK_SIGNATURE', e.message);
      }
      throw e;
    }
    // Ücret webhook'ta yoksa sağlayıcıdan sorulur (işlem dışında).
    if (ev.type === 'payment.succeeded' && ev.feeCents === undefined && ev.ref) {
      ev.feeCents = (await this.provider.retrieve(ev.ref)).feeCents;
    }
    const after: (() => void)[] = [];
    const duplicate = await this.pool.tx(async (tx) => {
      const ins = await tx.query(
        `INSERT INTO webhook_events (provider, event_id, type, payload) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING event_id`,
        [this.provider.name, ev.id, ev.providerType, ev.raw],
      );
      if (!ins.rowCount) return true;
      await this.apply(tx, ev, after);
      await tx.query('UPDATE webhook_events SET processed_at = now() WHERE provider = $1 AND event_id = $2', [this.provider.name, ev.id]);
      return false;
    });
    for (const f of after) f();
    return { duplicate, type: ev.type };
  }

  private async findPayment(q: Queryable, ev: WebhookEvent): Promise<PaymentRow | null> {
    const pid = ev.paymentId && isUuid(ev.paymentId) ? ev.paymentId : null;
    const r = await q.query<PaymentRow>(
      `SELECT * FROM payments WHERE ($1::uuid IS NOT NULL AND id = $1::uuid) OR ($2::text IS NOT NULL AND provider_ref = $2::text)
       ORDER BY (id = $1::uuid) DESC NULLS LAST LIMIT 1 FOR UPDATE`,
      [pid, ev.ref],
    );
    return r.rows[0] ?? null;
  }

  private async apply(tx: Queryable, ev: WebhookEvent, after: (() => void)[]): Promise<void> {
    if (ev.type === 'ignored') return;
    const p = await this.findPayment(tx, ev);
    if (!p) {
      // Bilinmeyen ödeme: işlenmeden bırakmak yerine hata → sağlayıcı yeniden dener; kalıcıysa alarm.
      throw new Error(`Webhook bilinmeyen ödemeye ait: ${ev.providerType} ${ev.ref ?? ''}`);
    }
    switch (ev.type) {
      case 'payment.succeeded':
        return this.onSucceeded(tx, p, ev, after);
      case 'payment.failed':
        if (p.status === 'CREATED') {
          await tx.query(`UPDATE payments SET status = 'FAILED', failure_reason = $2, updated_at = now() WHERE id = $1`, [p.id, ev.failureReason ?? 'failed']);
          await publish(tx, 'payment.failed', { paymentId: p.id, userId: p.user_id, tournamentId: p.tournament_id, entryId: p.entry_id, reason: ev.failureReason });
        }
        return;
      case 'refund.succeeded':
        return this.onRefunded(tx, p, ev, after);
      case 'dispute.created':
        return this.onDispute(tx, p, ev);
    }
  }

  private async onSucceeded(tx: Queryable, p: PaymentRow, ev: WebhookEvent, after: (() => void)[]): Promise<void> {
    if (p.status === 'SUCCEEDED' || p.status === 'REFUNDED' || p.status === 'DISPUTED') return;
    const cents = ev.amountCents ?? p.amount_cents;
    const currency = (ev.currency ?? p.currency).toUpperCase();
    await tx.query(
      `UPDATE payments SET status = 'SUCCEEDED', provider_ref = $2, fee_cents = $3, card_last4 = $4, card_country = $5, failure_reason = NULL, updated_at = now() WHERE id = $1`,
      [p.id, ev.ref ?? p.provider_ref, ev.feeCents ?? 0, ev.cardLast4 ?? null, ev.cardCountry ?? null],
    );
    // Para sağlayıcıda: önce geçici hesaba (koltuğa bağlama turnuva modülünün kararı).
    await this.ledger.recordReceipt(tx, { paymentId: p.id, cents, feeCents: ev.feeCents ?? 0, currency });
    if (this.geo?.isBlockedCountry(ev.cardCountry)) {
      // K49: hizmet verilmeyen ülkede çıkarılmış kart: kabul edilmez, otomatik iade edilir.
      await tx.query(
        `INSERT INTO audit_log (actor_id, action, target_type, target_id, data) VALUES ($1::uuid, 'geo.card_blocked', 'payment', $2::text, $3)`,
        [p.user_id, p.id, { cardCountry: ev.cardCountry, mode: this.geo.enforcing ? 'enforce' : 'log' }],
      );
      if (this.geo.enforcing) {
        this.logger.warn('Engelli ülke kartı; ödeme iade ediliyor', { paymentId: p.id, cardCountry: ev.cardCountry });
        await this.requestRefund(tx, { paymentId: p.id, source: 'orphan', reason: 'card_country_blocked', cents }, after);
        if (p.purpose !== 'deposit') {
          await publish(tx, 'payment.blocked', { paymentId: p.id, userId: p.user_id, tournamentId: p.tournament_id, entryId: p.entry_id, reason: 'card_country_blocked' });
        }
        return;
      }
    }
    if (cents !== p.amount_cents || currency !== p.currency) {
      // Beklenmeyen tutar: koltuğa bağlanmaz, iade edilir ve kayıt düşülür.
      this.logger.error('Ödeme tutarı uyuşmuyor; iade ediliyor', { paymentId: p.id, expected: p.amount_cents, got: cents, currency });
      await tx.query(
        `INSERT INTO audit_log (actor_id, action, target_type, target_id, data) VALUES (NULL, 'payment.amount_mismatch', 'payment', $1, $2)`,
        [p.id, { expected: p.amount_cents, got: cents, currency }],
      );
      await this.requestRefund(tx, { paymentId: p.id, source: 'orphan', reason: 'amount_mismatch', cents }, after);
      return;
    }
    if (p.purpose === 'deposit') {
      // K43: bakiye yükleme — para doğrudan kullanıcının cüzdanına.
      await this.ledger.creditDeposit(tx, { paymentId: p.id, userId: p.user_id, cents, currency });
      await publish(tx, 'wallet.deposited', { paymentId: p.id, userId: p.user_id, amountCents: cents, currency });
      return;
    }
    await publish(tx, 'payment.succeeded', {
      paymentId: p.id, userId: p.user_id, tournamentId: p.tournament_id, entryId: p.entry_id, amountCents: cents, currency, previousStatus: p.status,
    });
  }

  private async onRefunded(tx: Queryable, p: PaymentRow, ev: WebhookEvent, after: (() => void)[]): Promise<void> {
    let r = (await tx.query<RefundRow>('SELECT * FROM refunds WHERE payment_id = $1 FOR UPDATE', [p.id])).rows[0];
    if (!r) {
      // Sağlayıcı panelinden yapılmış iade: kaynağı defterden belirlenir.
      const seated = await tx.query(`SELECT 1 FROM ledger_transactions WHERE idempotency_key = $1`, [`payment:${p.id}:to-pool`]);
      await this.requestRefund(tx, { paymentId: p.id, source: seated.rowCount ? 'pool' : 'orphan', reason: 'external', cents: ev.amountCents ?? p.amount_cents }, after);
      r = (await tx.query<RefundRow>('SELECT * FROM refunds WHERE payment_id = $1 FOR UPDATE', [p.id])).rows[0] as RefundRow;
    }
    if (r.status === 'SUCCEEDED') return;
    await tx.query(
      `UPDATE refunds SET status = 'SUCCEEDED', provider_ref = COALESCE(provider_ref, $2), updated_at = now() WHERE id = $1`,
      [r.id, ev.refundRef ?? null],
    );
    if (r.source === 'pool') {
      await this.ledger.refundEntry(tx, { paymentId: p.id, tournamentId: p.tournament_id as string, cents: r.amount_cents, currency: p.currency });
    } else {
      await this.ledger.refundOrphan(tx, { paymentId: p.id, cents: r.amount_cents, currency: p.currency });
    }
    if (p.status !== 'DISPUTED') await tx.query(`UPDATE payments SET status = 'REFUNDED', updated_at = now() WHERE id = $1`, [p.id]);
    await publish(tx, 'payment.refunded', { paymentId: p.id, userId: p.user_id, tournamentId: p.tournament_id, amountCents: r.amount_cents, currency: p.currency });
  }

  private async onDispute(tx: Queryable, p: PaymentRow, ev: WebhookEvent): Promise<void> {
    if (p.status === 'DISPUTED') return;
    await tx.query(`UPDATE payments SET status = 'DISPUTED', updated_at = now() WHERE id = $1`, [p.id]);
    // Ters ibrazda para sağlayıcı tarafından geri alınır: gider olarak kaydedilir.
    await this.ledger.chargeback(tx, { paymentId: p.id, cents: ev.amountCents ?? p.amount_cents, currency: p.currency });
    // Doküman 5.9: ters ibraz açan hesap, inceleme bitene kadar dondurulur.
    await this.identity.setStatus(tx, p.user_id, 'frozen', `chargeback:${p.id}`, null);
    await publish(tx, 'payment.disputed', { paymentId: p.id, userId: p.user_id, tournamentId: p.tournament_id, amountCents: ev.amountCents ?? p.amount_cents });
  }

  // ---- iade --------------------------------------------------------------------------

  /**
   * İade talebi (işlem içinde). Bir ödeme en fazla bir kez iade edilir; talep kuyruğa yazılır,
   * işlem tamamlandıktan sonra sağlayıcıya gönderilir. Defter kaydı sağlayıcı onayıyla (webhook) yapılır.
   */
  async requestRefund(
    q: Queryable,
    r: { paymentId: string; source: 'pool' | 'orphan'; reason: string; cents?: number },
    after?: (() => void)[] | { afterCommit(fn: () => void): void },
  ): Promise<boolean> {
    const ins = await q.query(
      `INSERT INTO refunds (payment_id, amount_cents, source, reason, idempotency_key)
       SELECT id, COALESCE($4, amount_cents), $2, $3, 'refund:' || id FROM payments WHERE id = $1 AND status IN ('SUCCEEDED', 'REFUNDED')
       ON CONFLICT DO NOTHING RETURNING id`,
      [r.paymentId, r.source, r.reason, r.cents ?? null],
    );
    if (ins.rowCount) {
      const kick = () => void this.processRefunds().catch((e) => this.logger.error('İade gönderilemedi', { error: e }));
      if (Array.isArray(after)) after.push(kick);
      else after?.afterCommit(kick);
    }
    return (ins.rowCount ?? 0) > 0;
  }

  /** PENDING iadeleri sağlayıcıya gönderir (idempotent; yeniden denemeli). */
  async processRefunds(): Promise<number> {
    if (this.refunding) return 0;
    this.refunding = true;
    let sent = 0;
    try {
      const due = await this.pool.query<RefundRow & { provider_ref_payment: string }>(
        `SELECT r.*, p.provider_ref AS provider_ref_payment FROM refunds r JOIN payments p ON p.id = r.payment_id
         WHERE r.status = 'PENDING' AND r.provider_ref IS NULL
           AND (r.attempts = 0 OR r.updated_at < now() - make_interval(secs => LEAST(300, power(2, r.attempts)::int)))
         ORDER BY r.created_at LIMIT 20`,
      );
      for (const r of due.rows) {
        try {
          const res = await this.provider.refund({ ref: r.provider_ref_payment, amountCents: r.amount_cents, idempotencyKey: r.idempotency_key });
          await this.pool.query(
            `UPDATE refunds SET provider_ref = COALESCE(provider_ref, $2), attempts = attempts + 1, last_error = NULL, updated_at = now() WHERE id = $1`,
            [r.id, res.refundRef],
          );
          sent++;
        } catch (e) {
          this.logger.warn('İade sağlayıcıya gönderilemedi; tekrar denenecek', { refundId: r.id, error: e });
          await this.pool.query(
            `UPDATE refunds SET attempts = attempts + 1, last_error = $2, updated_at = now() WHERE id = $1`,
            [r.id, e instanceof Error ? e.message.slice(0, 500) : String(e)],
          );
        }
      }
    } finally {
      this.refunding = false;
    }
    return sent;
  }

  // ---- mutabakat -----------------------------------------------------------------------

  /**
   * Defterdeki PSP_CLEARING bakiyesi ile sağlayıcının bildirdiği net bakiyeyi karşılaştırır (doküman 5.6).
   * Sağlayıcıya gönderilmiş ama webhook'u henüz gelmemiş iadeler "yolda" sayılır.
   */
  async reconcile(currency: string): Promise<ReconciliationReport> {
    const ledgerCents = await this.ledger.balance(this.pool, `PSP_CLEARING:${currency}`);
    const providerCents = this.provider.balance ? await this.provider.balance(currency) : null;
    const inflight = await this.pool.query<{ s: number }>(
      `SELECT COALESCE(sum(r.amount_cents), 0)::bigint AS s FROM refunds r JOIN payments p ON p.id = r.payment_id
       WHERE r.status = 'PENDING' AND r.provider_ref IS NOT NULL AND p.currency = $1`,
      [currency],
    );
    const unbalanced = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (
         SELECT transaction_id FROM ledger_entries GROUP BY transaction_id, currency
         HAVING sum(CASE WHEN direction = 'D' THEN amount_cents ELSE 0 END) <> sum(CASE WHEN direction = 'C' THEN amount_cents ELSE 0 END)) x`,
    );
    const inFlightRefundCents = (inflight.rows[0] as { s: number }).s;
    const unbalancedTx = (unbalanced.rows[0] as { n: number }).n;
    const diffCents = providerCents === null ? null : providerCents - (ledgerCents - inFlightRefundCents);
    const report: ReconciliationReport = {
      currency, ledgerCents, providerCents, inFlightRefundCents, diffCents, unbalancedTx,
      ok: unbalancedTx === 0 && (diffCents === null || diffCents === 0),
    };
    await this.pool.query(
      `INSERT INTO reconciliation_reports (currency, ledger_cents, provider_cents, diff_cents, unbalanced_tx, details) VALUES ($1, $2, $3, $4, $5, $6)`,
      [currency, ledgerCents, providerCents ?? 0, diffCents ?? 0, unbalancedTx, { provider: this.provider.name, inFlightRefundCents, providerReported: providerCents !== null }],
    );
    if (!report.ok) this.logger.error('Mutabakat farkı', { ...report });
    return report;
  }
}
