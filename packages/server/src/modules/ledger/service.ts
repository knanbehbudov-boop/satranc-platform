/**
 * M8 Ledger: çift taraflı defter. Diğer modüller defter tablolarına yazmaz;
 * yalnız buradaki alan işlemlerini çağırır. Her işlem idempotency anahtarı taşır:
 * aynı anahtar ikinci kez gelirse hiçbir şey yazılmaz.
 *
 * Hesap planı (K7, K9):
 *   PSP_CLEARING:<cur>           VARLIK      ödeme sağlayıcısında duran para
 *   USER_PAYMENT_IN:<cur>        YÜKÜMLÜLÜK  koltuğa bağlanmamış geçici tahsilat
 *   TOURNAMENT_POOL:<tid>        YÜKÜMLÜLÜK  turnuva emaneti (brüt giriş ücretleri)
 *   USER_PRIZE_PENDING:<uid>:<cur>   YÜKÜMLÜLÜK  bekletmedeki ödül
 *   USER_PRIZE_AVAILABLE:<uid>:<cur> YÜKÜMLÜLÜK  çekilebilir ödül
 *   FAIR_PLAY_RESERVE:<cur>      YÜKÜMLÜLÜK  hile kararıyla iptal edilen ödüller (K29)
 *   PLATFORM_REVENUE:<cur>       GELİR       komisyon
 *   PSP_FEES:<cur>               GİDER       ödeme sağlayıcı ücreti
 *   CHARGEBACKS:<cur>            GİDER       ters ibraz kayıpları
 */
import { Pool, type Queryable } from '../../infra/db/pg.ts';
import type { Award } from './prizes.ts';

export type AccountType = 'ASSET' | 'LIABILITY' | 'REVENUE' | 'EXPENSE';
export type Reason =
  | 'ENTRY_PAID' | 'ENTRY_REFUND' | 'PAYMENT_ORPHAN_REFUND' | 'PSP_FEE' | 'TOURNAMENT_SETTLE'
  | 'PRIZE_RELEASE' | 'PRIZE_VOID' | 'CHARGEBACK' | 'PAYOUT' | 'PAYOUT_REVERSAL' | 'ADJUSTMENT';

export interface AccountRef {
  code: string;
  type: AccountType;
  owner?: string | null;
}

export interface Line {
  account: AccountRef;
  dir: 'D' | 'C';
  cents: number;
}

export const ACC = {
  pspClearing: (cur: string): AccountRef => ({ code: `PSP_CLEARING:${cur}`, type: 'ASSET' }),
  paymentIn: (cur: string): AccountRef => ({ code: `USER_PAYMENT_IN:${cur}`, type: 'LIABILITY' }),
  pool: (tid: string): AccountRef => ({ code: `TOURNAMENT_POOL:${tid}`, type: 'LIABILITY' }),
  pending: (uid: string, cur: string): AccountRef => ({ code: `USER_PRIZE_PENDING:${uid}:${cur}`, type: 'LIABILITY', owner: uid }),
  available: (uid: string, cur: string): AccountRef => ({ code: `USER_PRIZE_AVAILABLE:${uid}:${cur}`, type: 'LIABILITY', owner: uid }),
  fairPlayReserve: (cur: string): AccountRef => ({ code: `FAIR_PLAY_RESERVE:${cur}`, type: 'LIABILITY' }),
  revenue: (cur: string): AccountRef => ({ code: `PLATFORM_REVENUE:${cur}`, type: 'REVENUE' }),
  pspFees: (cur: string): AccountRef => ({ code: `PSP_FEES:${cur}`, type: 'EXPENSE' }),
  chargebacks: (cur: string): AccountRef => ({ code: `CHARGEBACKS:${cur}`, type: 'EXPENSE' }),
};

export interface PostResult {
  transactionId: string;
  duplicate: boolean;
}

export class LedgerService {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  private async accountId(q: Queryable, a: AccountRef, currency: string): Promise<string> {
    const r = await q.query<{ id: string }>(
      `INSERT INTO ledger_accounts (code, type, currency, owner_user) VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`,
      [a.code, a.type, currency, a.owner ?? null],
    );
    return (r.rows[0] as { id: string }).id;
  }

  /**
   * Tek bir dengeli işlem yazar. Denge ayrıca veritabanında COMMIT anında kontrol edilir.
   * Aynı anahtarla ikinci çağrı hiçbir şey yazmaz ve `duplicate: true` döner.
   */
  async post(
    q: Queryable,
    tx: { key: string; reason: Reason; currency: string; refType?: string; refId?: string; memo?: string; lines: Line[] },
  ): Promise<PostResult> {
    // İşlem satırı ve kayıtları aynı veritabanı işleminde yazılmalı (denge COMMIT'te kontrol edilir).
    if (q instanceof Pool) return q.tx((c) => this.post(c, tx));
    const lines = tx.lines.filter((l) => l.cents !== 0);
    for (const l of lines) {
      if (!Number.isSafeInteger(l.cents) || l.cents < 0) throw new Error(`Defter tutarı geçersiz: ${l.cents}`);
    }
    const d = lines.filter((l) => l.dir === 'D').reduce((s, l) => s + l.cents, 0);
    const c = lines.filter((l) => l.dir === 'C').reduce((s, l) => s + l.cents, 0);
    if (d !== c) throw new Error(`Defter dengesiz: borç ${d} ≠ alacak ${c} (${tx.key})`);
    if (!lines.length) throw new Error('Boş defter işlemi');
    const ins = await q.query<{ id: string }>(
      `INSERT INTO ledger_transactions (idempotency_key, reason, ref_type, ref_id, memo) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [tx.key, tx.reason, tx.refType ?? null, tx.refId ?? null, tx.memo ?? null],
    );
    if (!ins.rows[0]) {
      const ex = await q.query<{ id: string }>('SELECT id FROM ledger_transactions WHERE idempotency_key = $1', [tx.key]);
      return { transactionId: (ex.rows[0] as { id: string }).id, duplicate: true };
    }
    const id = ins.rows[0].id;
    for (const l of lines) {
      const acc = await this.accountId(q, l.account, tx.currency);
      await q.query(
        'INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_cents, currency) VALUES ($1, $2, $3, $4, $5)',
        [id, acc, l.dir, l.cents, tx.currency],
      );
    }
    return { transactionId: id, duplicate: false };
  }

  // ---- alan işlemleri ---------------------------------------------------------

  /** Ödeme alındı ve koltuğa bağlandı (doküman 5.6 örneği; K9: ücret ayrı gider). */
  async recordEntryPayment(q: Queryable, p: { paymentId: string; tournamentId: string; userId: string; cents: number; feeCents: number; currency: string }): Promise<void> {
    await this.recordReceipt(q, p);
    await this.post(q, {
      key: `payment:${p.paymentId}:to-pool`,
      reason: 'ENTRY_PAID',
      currency: p.currency,
      refType: 'payment',
      refId: p.paymentId,
      memo: `Turnuva ${p.tournamentId} giriş ücreti (${p.userId})`,
      lines: [
        { account: ACC.paymentIn(p.currency), dir: 'D', cents: p.cents },
        { account: ACC.pool(p.tournamentId), dir: 'C', cents: p.cents },
      ],
    });
  }

  /** Para PSP'de; henüz koltuğa bağlanmadı (geç ödeme, dolu turnuva). */
  async recordReceipt(q: Queryable, p: { paymentId: string; cents: number; feeCents: number; currency: string }): Promise<void> {
    await this.post(q, {
      key: `payment:${p.paymentId}:received`,
      reason: 'ENTRY_PAID',
      currency: p.currency,
      refType: 'payment',
      refId: p.paymentId,
      lines: [
        { account: ACC.pspClearing(p.currency), dir: 'D', cents: p.cents },
        { account: ACC.paymentIn(p.currency), dir: 'C', cents: p.cents },
      ],
    });
    if (p.feeCents > 0) {
      await this.post(q, {
        key: `payment:${p.paymentId}:fee`,
        reason: 'PSP_FEE',
        currency: p.currency,
        refType: 'payment',
        refId: p.paymentId,
        lines: [
          { account: ACC.pspFees(p.currency), dir: 'D', cents: p.feeCents },
          { account: ACC.pspClearing(p.currency), dir: 'C', cents: p.feeCents },
        ],
      });
    }
  }

  /** Koltuğa bağlanamayan ödemenin iadesi (geçici hesaptan). */
  async refundOrphan(q: Queryable, p: { paymentId: string; cents: number; currency: string }): Promise<void> {
    await this.post(q, {
      key: `payment:${p.paymentId}:orphan-refund`,
      reason: 'PAYMENT_ORPHAN_REFUND',
      currency: p.currency,
      refType: 'payment',
      refId: p.paymentId,
      lines: [
        { account: ACC.paymentIn(p.currency), dir: 'D', cents: p.cents },
        { account: ACC.pspClearing(p.currency), dir: 'C', cents: p.cents },
      ],
    });
  }

  /** Koltuğa bağlanmış ödemenin iadesi (ayrılma, iptal): emanetten geri. */
  async refundEntry(q: Queryable, p: { paymentId: string; tournamentId: string; cents: number; currency: string }): Promise<void> {
    await this.post(q, {
      key: `payment:${p.paymentId}:entry-refund`,
      reason: 'ENTRY_REFUND',
      currency: p.currency,
      refType: 'payment',
      refId: p.paymentId,
      lines: [
        { account: ACC.pool(p.tournamentId), dir: 'D', cents: p.cents },
        { account: ACC.pspClearing(p.currency), dir: 'C', cents: p.cents },
      ],
    });
  }

  /** Turnuva kapanışı: emanet → komisyon + bekletmedeki ödüller. */
  async settleTournament(q: Queryable, p: { tournamentId: string; currency: string; rakeCents: number; awards: Award[] }): Promise<PostResult> {
    const total = p.rakeCents + p.awards.reduce((s, a) => s + a.cents, 0);
    return this.post(q, {
      key: `tournament:${p.tournamentId}:settle`,
      reason: 'TOURNAMENT_SETTLE',
      currency: p.currency,
      refType: 'tournament',
      refId: p.tournamentId,
      lines: [
        { account: ACC.pool(p.tournamentId), dir: 'D', cents: total },
        { account: ACC.revenue(p.currency), dir: 'C', cents: p.rakeCents },
        ...p.awards.map((a): Line => ({ account: ACC.pending(a.userId, p.currency), dir: 'C', cents: a.cents })),
      ],
    });
  }

  async releasePrize(q: Queryable, p: { tournamentId: string; userId: string; cents: number; currency: string }): Promise<void> {
    await this.post(q, {
      key: `tournament:${p.tournamentId}:release:${p.userId}`,
      reason: 'PRIZE_RELEASE',
      currency: p.currency,
      refType: 'tournament',
      refId: p.tournamentId,
      lines: [
        { account: ACC.pending(p.userId, p.currency), dir: 'D', cents: p.cents },
        { account: ACC.available(p.userId, p.currency), dir: 'C', cents: p.cents },
      ],
    });
  }

  /** Hile kararıyla bekletmedeki ödülün iptali (K29: rezerv hesabına, mağdur kararı ayrıca verilir). */
  async voidPrize(q: Queryable, p: { tournamentId: string; userId: string; cents: number; currency: string; caseId: string }): Promise<void> {
    await this.post(q, {
      key: `tournament:${p.tournamentId}:void:${p.userId}`,
      reason: 'PRIZE_VOID',
      currency: p.currency,
      refType: 'fair_play_case',
      refId: p.caseId,
      lines: [
        { account: ACC.pending(p.userId, p.currency), dir: 'D', cents: p.cents },
        { account: ACC.fairPlayReserve(p.currency), dir: 'C', cents: p.cents },
      ],
    });
  }

  async chargeback(q: Queryable, p: { paymentId: string; cents: number; currency: string }): Promise<void> {
    await this.post(q, {
      key: `payment:${p.paymentId}:chargeback`,
      reason: 'CHARGEBACK',
      currency: p.currency,
      refType: 'payment',
      refId: p.paymentId,
      lines: [
        { account: ACC.chargebacks(p.currency), dir: 'D', cents: p.cents },
        { account: ACC.pspClearing(p.currency), dir: 'C', cents: p.cents },
      ],
    });
  }

  // ---- okuma -----------------------------------------------------------------

  async balance(q: Queryable, code: string): Promise<number> {
    const r = await q.query<{ balance_cents: number }>('SELECT balance_cents FROM ledger_balances WHERE code = $1', [code]);
    return r.rows[0]?.balance_cents ?? 0;
  }

  async userBalances(userId: string): Promise<{ currency: string; pendingCents: number; availableCents: number }[]> {
    const r = await this.pool.query<{ code: string; currency: string; balance_cents: number }>(
      `SELECT code, currency, balance_cents FROM ledger_balances WHERE owner_user = $1`,
      [userId],
    );
    const byCur = new Map<string, { currency: string; pendingCents: number; availableCents: number }>();
    for (const row of r.rows) {
      const b = byCur.get(row.currency) ?? { currency: row.currency, pendingCents: 0, availableCents: 0 };
      if (row.code.startsWith('USER_PRIZE_PENDING:')) b.pendingCents += row.balance_cents;
      if (row.code.startsWith('USER_PRIZE_AVAILABLE:')) b.availableCents += row.balance_cents;
      byCur.set(row.currency, b);
    }
    return [...byCur.values()];
  }

  async userHistory(userId: string, limit = 50) {
    const r = await this.pool.query<{ created_at: Date; reason: string; ref_type: string; ref_id: string; code: string; direction: string; amount_cents: number; currency: string }>(
      `SELECT t.created_at, t.reason, t.ref_type, t.ref_id, a.code, e.direction, e.amount_cents, e.currency
       FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id JOIN ledger_transactions t ON t.id = e.transaction_id
       WHERE a.owner_user = $1 ORDER BY e.id DESC LIMIT $2`,
      [userId, limit],
    );
    return r.rows.map((x) => ({
      at: x.created_at,
      reason: x.reason,
      ref: { type: x.ref_type, id: x.ref_id },
      bucket: x.code.startsWith('USER_PRIZE_PENDING:') ? 'pending' : 'available',
      cents: x.direction === 'C' ? x.amount_cents : -x.amount_cents,
      currency: x.currency,
    }));
  }

  /** Tüm defterin değişmezleri (yönetim paneli ve simülasyon için). */
  async invariants(): Promise<{ balanced: boolean; byCurrency: { currency: string; debit: number; credit: number }[]; negativeUserBalances: number }> {
    const r = await this.pool.query<{ currency: string; d: number; c: number }>(
      `SELECT currency, COALESCE(sum(CASE WHEN direction = 'D' THEN amount_cents END), 0)::bigint AS d,
              COALESCE(sum(CASE WHEN direction = 'C' THEN amount_cents END), 0)::bigint AS c
       FROM ledger_entries GROUP BY currency`,
    );
    const neg = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ledger_balances WHERE type = 'LIABILITY' AND balance_cents < 0`,
    );
    return {
      balanced: r.rows.every((x) => x.d === x.c),
      byCurrency: r.rows.map((x) => ({ currency: x.currency, debit: x.d, credit: x.c })),
      negativeUserBalances: (neg.rows[0] as { n: number }).n,
    };
  }

  async accountsSummary() {
    const r = await this.pool.query<{ code: string; type: string; currency: string; balance_cents: number }>(
      `SELECT split_part(code, ':', 1) AS code, type, currency, sum(balance_cents)::bigint AS balance_cents
       FROM ledger_balances GROUP BY 1, 2, 3 ORDER BY 1, 3`,
    );
    return r.rows;
  }
}
