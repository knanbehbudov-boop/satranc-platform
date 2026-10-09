/**
 * Cüzdan ve para çekme (K43).
 *
 *  - Bakiye yükleme: kart ödemesi (amaç 'deposit'); para webhook ile kesinleşince cüzdana geçer.
 *  - Bakiye = yüklenen + çekilebilir ödül. Turnuva ücreti önce yüklenen bakiyeden alınır.
 *  - Para çekme: kullanıcı talep eder → tutar çekim emanetine alınır → yönetici parayı gönderip
 *    "ödendi" işaretler ya da reddeder (tutar bakiyeye geri döner). İlk sürümde ödeme elle yapılır;
 *    otomatik ödeme sağlayıcısı bağlandığında yalnız markPaid adımı değişir.
 *  - En az çekim tutarı vardır (varsayılan 20 $); hesabını kapatan kullanıcı tutar ne olursa olsun
 *    bakiyesinin tamamını çekebilir.
 *  - Banka/sağlayıcı komisyonu platforma ait değildir; çekilen tutardan düşülür ve talepten önce gösterilir.
 *
 * Çift harcamayı önlemek için bakiyeye dokunan her işlem önce kullanıcı satırını kilitler.
 */
import type { Config } from '../../config.ts';
import type { Pool, Queryable } from '../../infra/db/pg.ts';
import { badRequest, conflict, forbidden, notFound } from '../../infra/errors.ts';
import { isUuid } from '../../infra/http/validate.ts';
import type { Logger } from '../../infra/log.ts';
import type { WsHub } from '../../infra/ws/hub.ts';
import type { LedgerService, WalletSplit } from '../ledger/service.ts';
import type { PaymentService } from '../payments/service.ts';

export type PayoutMethod = 'ewallet' | 'bank';

export const WITHDRAWAL_NOTICE_TR =
  'Para çekme işlemlerinde bankanız veya ödeme sağlayıcınız tarafından alınan komisyonlar platformumuza ait değildir ve çekilen tutardan düşülür. Komisyon tutarı, onaylamadan önce size gösterilir.';
export const WITHDRAWAL_NOTICE_EN =
  'Withdrawal fees charged by your bank or payment provider are not set by us and are deducted from the amount withdrawn. The fee is shown before you confirm.';

interface WithdrawalRow {
  id: string;
  user_id: string;
  amount_cents: number;
  fee_cents: number;
  currency: string;
  method: PayoutMethod;
  destination: string;
  holder_name: string;
  from_winnings_cents: number;
  from_deposit_cents: number;
  account_closure: boolean;
  status: 'REQUESTED' | 'PAID' | 'REJECTED' | 'CANCELED';
  payout_ref: string | null;
  note: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  created_at: Date;
}

export class WalletService {
  private readonly pool: Pool;
  private readonly cfg: Config;
  private readonly logger: Logger;
  private readonly hub: WsHub;
  private readonly ledger: LedgerService;
  private readonly payments: PaymentService;
  readonly currency = 'USD';

  constructor(deps: { pool: Pool; cfg: Config; logger: Logger; hub: WsHub; ledger: LedgerService; payments: PaymentService }) {
    this.pool = deps.pool;
    this.cfg = deps.cfg;
    this.logger = deps.logger;
    this.hub = deps.hub;
    this.ledger = deps.ledger;
    this.payments = deps.payments;
  }

  /** Bakiyeye dokunan işlemlerden önce: kullanıcı satırını kilitler ve durumunu döndürür. */
  async lockUser(tx: Queryable, userId: string) {
    const r = await tx.query<{ id: string; status: string; closing_requested_at: Date | null; closed_at: Date | null }>(
      'SELECT id, status, closing_requested_at, closed_at FROM users WHERE id = $1 FOR UPDATE',
      [userId],
    );
    const u = r.rows[0];
    if (!u) throw notFound('NOT_FOUND', 'Kullanıcı bulunamadı');
    return u;
  }

  // ---- komisyon ve kurallar ------------------------------------------------------

  feeFor(method: PayoutMethod, amountCents: number): number {
    if (method === 'bank') return Math.min(amountCents, this.cfg.payoutFeeBankFixedCents);
    const fee = this.cfg.payoutFeeEwalletFixedCents + Math.ceil((amountCents * this.cfg.payoutFeeEwalletBps) / 10_000);
    return Math.min(amountCents, fee);
  }

  rules() {
    return {
      currency: this.currency,
      minDepositCents: this.cfg.walletMinDepositCents,
      maxDepositCents: this.cfg.walletMaxDepositCents,
      minWithdrawCents: this.cfg.withdrawMinCents,
      methods: [
        { id: 'ewallet', fixedCents: this.cfg.payoutFeeEwalletFixedCents, bps: this.cfg.payoutFeeEwalletBps },
        { id: 'bank', fixedCents: this.cfg.payoutFeeBankFixedCents, bps: 0 },
      ],
      notice: { tr: WITHDRAWAL_NOTICE_TR, en: WITHDRAWAL_NOTICE_EN },
    };
  }

  quote(amountCents: number, method: PayoutMethod) {
    const fee = this.feeFor(method, amountCents);
    return { amountCents, feeCents: fee, netCents: amountCents - fee, currency: this.currency };
  }

  // ---- bakiye yükleme ---------------------------------------------------------------

  async deposit(userId: string, amountCents: number, clientKey: string | null) {
    if (!Number.isSafeInteger(amountCents) || amountCents < this.cfg.walletMinDepositCents || amountCents > this.cfg.walletMaxDepositCents) {
      throw badRequest('DEPOSIT_AMOUNT', `Yükleme tutarı ${this.cfg.walletMinDepositCents / 100}–${this.cfg.walletMaxDepositCents / 100} $ arasında olmalı`);
    }
    const u = await this.lockUser(this.pool, userId);
    if (u.status !== 'active') throw forbidden('ACCOUNT_RESTRICTED', 'Hesabınız bakiye yükleyemez');
    if (u.closing_requested_at || u.closed_at) throw forbidden('ACCOUNT_CLOSING', 'Hesabınız kapatılıyor; bakiye yüklenemez');
    const key = clientKey && /^[A-Za-z0-9_-]{8,64}$/.test(clientKey) ? clientKey : `${Date.now()}`;
    return this.payments.createPayment({
      userId,
      tournamentId: null,
      entryId: null,
      purpose: 'deposit',
      amountCents,
      currency: this.currency,
      idempotencyKey: `deposit:${userId}:${key}`,
      description: 'Bakiye yükleme',
      returnUrl: (pid) => `/#/cuzdan?odeme=${pid}`,
    });
  }

  // ---- para çekme ---------------------------------------------------------------------

  async requestWithdrawal(
    userId: string,
    input: { amountCents?: number; method: PayoutMethod; destination: string; holderName: string; closeAccount?: boolean },
  ) {
    if (input.method !== 'ewallet' && input.method !== 'bank') throw badRequest('VALIDATION', 'Geçersiz ödeme yöntemi');
    const destination = String(input.destination ?? '').trim();
    const holderName = String(input.holderName ?? '').trim();
    if (destination.length < 3 || destination.length > 120) throw badRequest('VALIDATION', 'Hesap bilgisi 3–120 karakter olmalı');
    if (holderName.length < 2 || holderName.length > 80) throw badRequest('VALIDATION', 'Hesap sahibinin adı 2–80 karakter olmalı');
    // Kart numarası gibi görünen bilgi kabul edilmez (kart verisi bu sisteme girmez).
    if (/\b(?:\d[ -]?){13,19}\b/.test(destination) && input.method === 'ewallet') {
      throw badRequest('VALIDATION', 'Kart numarası girmeyin; e-cüzdan hesap e-postanızı veya numaranızı yazın');
    }
    const after: (() => void)[] = [];
    const out = await this.pool.tx(async (tx) => {
      const u = await this.lockUser(tx, userId);
      if (u.status !== 'active') throw forbidden('ACCOUNT_RESTRICTED', 'Hesabınız şu anda para çekemez; destekle iletişime geçin');
      if (u.closed_at) throw forbidden('ACCOUNT_CLOSED', 'Hesap kapatılmış');
      const open = await tx.query('SELECT 1 FROM withdrawals WHERE user_id = $1 AND status = $2', [userId, 'REQUESTED']);
      if (open.rowCount) throw conflict('WITHDRAWAL_OPEN', 'Bekleyen bir çekim talebiniz var');
      const have = await this.ledger.spendable(tx, userId, this.currency);
      const total = have.depositCents + have.winningsCents;
      let amount: number;
      if (input.closeAccount) {
        // Hesap kapatma: aktif turnuva ve bekletmedeki ödül bitmeden kapanmaz; tüm bakiye çekilir.
        const active = await tx.query(
          `SELECT 1 FROM entries e JOIN tournaments t ON t.id = e.tournament_id
           WHERE e.user_id = $1 AND e.status IN ('RESERVED', 'CONFIRMED') AND t.status IN ('OPEN', 'FULL', 'STARTING', 'RUNNING') LIMIT 1`,
          [userId],
        );
        if (active.rowCount) throw conflict('ACTIVE_TOURNAMENT', 'Devam eden bir turnuvanız var; bitince hesabınızı kapatabilirsiniz');
        const pending = await this.ledger.balance(tx, `USER_PRIZE_PENDING:${userId}:${this.currency}`);
        if (pending > 0) throw conflict('PRIZE_PENDING', 'İncelemedeki ödülünüz serbest kalınca hesabınızı kapatabilirsiniz');
        await tx.query('UPDATE users SET closing_requested_at = COALESCE(closing_requested_at, now()) WHERE id = $1', [userId]);
        if (total === 0) {
          await tx.query('UPDATE users SET closed_at = now() WHERE id = $1', [userId]);
          await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
          await this.audit(tx, userId, 'account.closed', userId, { withdrawal: null });
          return { closed: true, withdrawal: null };
        }
        amount = total;
      } else {
        amount = Number(input.amountCents);
        if (!Number.isSafeInteger(amount) || amount <= 0) throw badRequest('VALIDATION', 'Geçersiz tutar');
        if (amount < this.cfg.withdrawMinCents) {
          throw badRequest('WITHDRAW_MIN', `En az çekim tutarı ${(this.cfg.withdrawMinCents / 100).toFixed(2)} $`);
        }
        if (amount > total) throw badRequest('INSUFFICIENT_BALANCE', 'Bakiyeniz yetersiz');
      }
      // Önce ödül bakiyesinden, sonra yüklenen bakiyeden.
      const fromWinnings = Math.min(have.winningsCents, amount);
      const split: WalletSplit = { winningsCents: fromWinnings, depositCents: amount - fromWinnings };
      const fee = this.feeFor(input.method, amount);
      const ins = await tx.query<WithdrawalRow>(
        `INSERT INTO withdrawals (user_id, amount_cents, fee_cents, currency, method, destination, holder_name,
                                  from_winnings_cents, from_deposit_cents, account_closure)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [userId, amount, fee, this.currency, input.method, destination, holderName, split.winningsCents, split.depositCents, !!input.closeAccount],
      );
      const w = ins.rows[0] as WithdrawalRow;
      await this.ledger.requestPayout(tx, { withdrawalId: w.id, userId, split, currency: this.currency });
      await this.audit(tx, userId, 'withdrawal.request', w.id, { amount, fee, method: input.method, closure: !!input.closeAccount });
      after.push(() => this.hub.publish('staff', { type: 'withdrawal.requested', withdrawalId: w.id }));
      return { closed: false, withdrawal: this.view(w) };
    });
    for (const f of after) f();
    return out;
  }

  async cancelWithdrawal(userId: string, id: string) {
    if (!isUuid(id)) throw notFound('WITHDRAWAL_NOT_FOUND', 'Talep bulunamadı');
    return this.pool.tx(async (tx) => {
      await this.lockUser(tx, userId);
      const w = await this.lockWithdrawal(tx, id);
      if (w.user_id !== userId) throw notFound('WITHDRAWAL_NOT_FOUND', 'Talep bulunamadı');
      if (w.status !== 'REQUESTED') throw conflict('WITHDRAWAL_DONE', 'Bu talep artık iptal edilemez');
      await this.unwind(tx, w, 'CANCELED', userId, 'Kullanıcı iptal etti');
      return this.view({ ...w, status: 'CANCELED' });
    });
  }

  async myWithdrawals(userId: string) {
    const r = await this.pool.query<WithdrawalRow>('SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [userId]);
    return r.rows.map((w) => this.view(w));
  }

  // ---- yönetici: ödeme ve red -------------------------------------------------------------

  async list(status: string | null) {
    const r = await this.pool.query<WithdrawalRow & { display_name: string; email: string }>(
      `SELECT w.*, u.display_name, u.email FROM withdrawals w JOIN users u ON u.id = w.user_id
       WHERE ($1::text IS NULL OR w.status = $1) ORDER BY (w.status = 'REQUESTED') DESC, w.created_at DESC LIMIT 200`,
      [status],
    );
    return r.rows.map((w) => ({ ...this.view(w), user: { id: w.user_id, displayName: w.display_name, email: w.email }, holderName: w.holder_name, destination: w.destination }));
  }

  async markPaid(staffId: string, id: string, payoutRef: string) {
    const ref = String(payoutRef ?? '').trim();
    if (ref.length < 3 || ref.length > 120) throw badRequest('VALIDATION', 'Ödeme referansı (dekont/işlem no) 3–120 karakter olmalı');
    const after: (() => void)[] = [];
    const out = await this.pool.tx(async (tx) => {
      const w0 = await this.lockWithdrawal(tx, id);
      await this.lockUser(tx, w0.user_id);
      const w = await this.lockWithdrawal(tx, id);
      if (w.status !== 'REQUESTED') throw conflict('WITHDRAWAL_DONE', 'Bu talep zaten sonuçlandı');
      await tx.query(
        `UPDATE withdrawals SET status = 'PAID', payout_ref = $2, decided_by = $3, decided_at = now() WHERE id = $1`,
        [w.id, ref, staffId],
      );
      await this.ledger.completePayout(tx, { withdrawalId: w.id, cents: w.amount_cents, currency: w.currency });
      if (w.account_closure) {
        await tx.query('UPDATE users SET closed_at = now() WHERE id = $1', [w.user_id]);
        await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [w.user_id]);
        await this.audit(tx, staffId, 'account.closed', w.user_id, { withdrawal: w.id });
      }
      await this.audit(tx, staffId, 'withdrawal.paid', w.id, { ref, amount: w.amount_cents, user: w.user_id });
      after.push(() => this.hub.sendToUser(w.user_id, { type: 'withdrawal.paid', withdrawalId: w.id }));
      return this.view({ ...w, status: 'PAID', payout_ref: ref });
    });
    for (const f of after) f();
    return out;
  }

  async reject(staffId: string, id: string, note: string) {
    const n = String(note ?? '').trim();
    if (n.length < 3) throw badRequest('VALIDATION', 'Red gerekçesi en az 3 karakter olmalı');
    const after: (() => void)[] = [];
    const out = await this.pool.tx(async (tx) => {
      const w0 = await this.lockWithdrawal(tx, id);
      await this.lockUser(tx, w0.user_id);
      const w = await this.lockWithdrawal(tx, id);
      if (w.status !== 'REQUESTED') throw conflict('WITHDRAWAL_DONE', 'Bu talep zaten sonuçlandı');
      await this.unwind(tx, w, 'REJECTED', staffId, n);
      after.push(() => this.hub.sendToUser(w.user_id, { type: 'withdrawal.rejected', withdrawalId: w.id }));
      return this.view({ ...w, status: 'REJECTED', note: n });
    });
    for (const f of after) f();
    return out;
  }

  // ---- yardımcılar ------------------------------------------------------------------------

  private async lockWithdrawal(tx: Queryable, id: string): Promise<WithdrawalRow> {
    if (!isUuid(id)) throw notFound('WITHDRAWAL_NOT_FOUND', 'Talep bulunamadı');
    const r = await tx.query<WithdrawalRow>('SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [id]);
    const w = r.rows[0];
    if (!w) throw notFound('WITHDRAWAL_NOT_FOUND', 'Talep bulunamadı');
    return w;
  }

  /** Talebi geri alır: tutar bakiyeye döner; hesap kapatma talebiyse kapatma da geri alınır. */
  private async unwind(tx: Queryable, w: WithdrawalRow, status: 'CANCELED' | 'REJECTED', actorId: string, note: string) {
    await tx.query(`UPDATE withdrawals SET status = $2, note = $3, decided_by = $4, decided_at = now() WHERE id = $1`, [w.id, status, note, actorId]);
    await this.ledger.returnPayout(tx, {
      withdrawalId: w.id,
      userId: w.user_id,
      split: { winningsCents: Number(w.from_winnings_cents), depositCents: Number(w.from_deposit_cents) },
      currency: w.currency,
    });
    if (w.account_closure) await tx.query('UPDATE users SET closing_requested_at = NULL WHERE id = $1 AND closed_at IS NULL', [w.user_id]);
    await this.audit(tx, actorId, `withdrawal.${status.toLowerCase()}`, w.id, { note, user: w.user_id });
  }

  private view(w: WithdrawalRow) {
    return {
      id: w.id,
      amountCents: Number(w.amount_cents),
      feeCents: Number(w.fee_cents),
      netCents: Number(w.amount_cents) - Number(w.fee_cents),
      currency: w.currency,
      method: w.method,
      destinationHint: maskDestination(w.destination),
      accountClosure: w.account_closure,
      status: w.status,
      payoutRef: w.payout_ref,
      note: w.note,
      createdAt: w.created_at,
      decidedAt: w.decided_at,
    };
  }

  private async audit(q: Queryable, actorId: string | null, action: string, targetId: string, data: unknown) {
    const type = action.startsWith('account.') ? 'user' : 'withdrawal';
    await q.query(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id, data) VALUES ($1, $2, $3, $4, $5)`,
      [actorId, action, type, targetId, data],
    );
  }
}

/** Hesap bilgisinin yalnız son birkaç karakteri gösterilir. */
export function maskDestination(d: string): string {
  const s = String(d);
  if (s.includes('@')) {
    const [name, host] = s.split('@') as [string, string];
    return `${name.slice(0, 2)}***@${host}`;
  }
  return s.length <= 4 ? s : `•••• ${s.slice(-4)}`;
}

