/**
 * M13 Yönetim. İlkeler:
 *  - Rol her istekte veritabanından doğrulanır (token'daki rol 15 dk eskiyebilir).
 *  - Para ve hesap üzerinde kalıcı etkisi olan işlemler DÖRT GÖZ ister: biri önerir, başka biri
 *    onaylar; onay anında işlem aynı veritabanı işleminde yürütülür (yarım kalan karar olmaz).
 *  - Güvenliği artıran işlemler tek kişiyle ve hemen yapılır: ücretli kaydı durdurma (kill switch),
 *    hesabı geçici dondurma, açık turnuvayı iptal (herkese iade).
 *  - Her işlem audit_log'a yazılır.
 */
import type { Connection, Pool, Queryable } from '../../infra/db/pg.ts';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../infra/errors.ts';
import type { Logger } from '../../infra/log.ts';
import type { FairPlayService } from '../fairplay/service.ts';
import type { AnalysisService } from '../fairplay/analysis.ts';
import type { IdentityService } from '../identity/service.ts';
import type { LedgerService } from '../ledger/service.ts';
import type { PaymentService } from '../payments/service.ts';
import type { TournamentService } from '../tournament/service.ts';
import type { FlagService } from './flags.ts';

export type StaffRole = 'admin' | 'finance' | 'fairplay';
export type ApprovalAction = 'fairplay.decide' | 'user.ban' | 'user.unban' | 'user.unfreeze' | 'payment.refund' | 'flag.enable';

/** Hangi rol hangi onayı verebilir (admin her şeyi). */
const ACTION_ROLES: Record<ApprovalAction, StaffRole[]> = {
  'fairplay.decide': ['fairplay'],
  'user.ban': [],
  'user.unban': [],
  'user.unfreeze': ['fairplay'],
  'payment.refund': ['finance'],
  'flag.enable': [],
};

interface ApprovalRow {
  id: string;
  action: ApprovalAction;
  target_type: string;
  target_id: string;
  payload: Record<string, unknown>;
  reason: string;
  status: string;
  requested_by: string;
}

export class AdminService {
  private readonly pool: Pool;
  private readonly logger: Logger;
  private readonly identity: IdentityService;
  private readonly tournaments: TournamentService;
  private readonly fairplay: FairPlayService;
  private readonly analysis: AnalysisService;
  private readonly payments: PaymentService;
  private readonly ledger: LedgerService;
  private readonly flags: FlagService;

  constructor(deps: {
    pool: Pool; logger: Logger; identity: IdentityService; tournaments: TournamentService; fairplay: FairPlayService;
    analysis: AnalysisService; payments: PaymentService; ledger: LedgerService; flags: FlagService;
  }) {
    this.pool = deps.pool;
    this.logger = deps.logger;
    this.identity = deps.identity;
    this.tournaments = deps.tournaments;
    this.fairplay = deps.fairplay;
    this.analysis = deps.analysis;
    this.payments = deps.payments;
    this.ledger = deps.ledger;
    this.flags = deps.flags;
  }

  /** Personel yetkisi: rol ve hesap durumu her istekte veritabanından. */
  async requireStaff(userId: string, allowed: StaffRole[]): Promise<{ id: string; roles: string[] }> {
    const r = await this.pool.query<{ roles: string[]; status: string }>('SELECT roles, status FROM users WHERE id = $1', [userId]);
    const u = r.rows[0];
    if (!u || u.status !== 'active') throw forbidden();
    const ok = u.roles.includes('admin') || allowed.some((x) => u.roles.includes(x));
    if (!ok) throw forbidden('STAFF_ONLY', 'Bu işlem için yetkiniz yok');
    return { id: userId, roles: u.roles };
  }

  async audit(q: Queryable, actorId: string | null, action: string, targetType: string, targetId: string, data: Record<string, unknown>, ip?: string): Promise<void> {
    await q.query(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id, data, ip) VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
      [actorId, action, targetType, targetId, data, ip ?? null],
    );
  }

  // ---- genel bakış ----------------------------------------------------------------

  async overview() {
    const one = async <T>(sql: string, params: unknown[] = []) => (await this.pool.query<T>(sql, params)).rows[0] as T;
    const tournaments = await this.pool.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM tournaments WHERE status NOT IN ('SETTLED', 'CANCELLED') OR status_changed_at > now() - interval '24 hours' GROUP BY status`,
    );
    const cases = await this.pool.query<{ level: string; n: number }>(`SELECT level, count(*)::int AS n FROM fair_play_cases WHERE status = 'OPEN' GROUP BY level`);
    const payments = await one<{ n: number; cents: number; failed: number }>(
      `SELECT count(*) FILTER (WHERE status IN ('SUCCEEDED', 'REFUNDED', 'DISPUTED'))::int AS n,
              COALESCE(sum(amount_cents) FILTER (WHERE status IN ('SUCCEEDED', 'REFUNDED', 'DISPUTED')), 0)::bigint AS cents,
              count(*) FILTER (WHERE status = 'FAILED')::int AS failed
       FROM payments WHERE created_at > now() - interval '24 hours'`,
    );
    const users = await one<{ total: number; new24: number; frozen: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS new24,
              count(*) FILTER (WHERE status = 'frozen')::int AS frozen FROM users`,
    );
    const approvals = await one<{ n: number }>(`SELECT count(*)::int AS n FROM admin_approvals WHERE status = 'PENDING'`);
    const refunds = await one<{ pending: number; stuck: number }>(
      `SELECT count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
              count(*) FILTER (WHERE status = 'PENDING' AND attempts >= 3)::int AS stuck FROM refunds`,
    );
    const recon = await this.pool.query(`SELECT currency, diff_cents, unbalanced_tx, created_at FROM reconciliation_reports ORDER BY id DESC LIMIT 1`);
    return {
      tournaments: Object.fromEntries(tournaments.rows.map((r) => [r.status, r.n])),
      openCases: Object.fromEntries(cases.rows.map((r) => [r.level, r.n])),
      payments24h: payments,
      users,
      pendingApprovals: approvals.n,
      refunds,
      analysisQueue: await this.analysis.queueStats(),
      ledger: await this.ledger.invariants(),
      lastReconciliation: recon.rows[0] ?? null,
      flags: await this.flags.list(),
    };
  }

  async finance() {
    const recent = await this.pool.query(
      `SELECT p.id, p.status, p.amount_cents, p.fee_cents, p.currency, p.card_last4, p.created_at, u.display_name, t.name AS tournament_name,
              r.status AS refund_status, r.reason AS refund_reason, r.attempts AS refund_attempts, r.last_error AS refund_error
       FROM payments p JOIN users u ON u.id = p.user_id LEFT JOIN tournaments t ON t.id = p.tournament_id LEFT JOIN refunds r ON r.payment_id = p.id
       ORDER BY p.created_at DESC LIMIT 50`,
    );
    const reports = await this.pool.query('SELECT * FROM reconciliation_reports ORDER BY id DESC LIMIT 20');
    return {
      accounts: await this.ledger.accountsSummary(),
      invariants: await this.ledger.invariants(),
      payments: recent.rows,
      reconciliation: reports.rows,
    };
  }

  // ---- kullanıcılar ---------------------------------------------------------------

  async searchUsers(q: string) {
    const term = `%${q.trim().toLowerCase()}%`;
    const r = await this.pool.query(
      `SELECT id, email, display_name, country_code, status, roles, created_at FROM users
       WHERE $1 = '%%' OR lower(email) LIKE $1 OR lower(display_name) LIKE $1 OR id::text = $2
       ORDER BY created_at DESC LIMIT 50`,
      [term, q.trim()],
    );
    return r.rows;
  }

  async userDetail(userId: string) {
    const u = await this.pool.query('SELECT id, email, display_name, country_code, birth_year, status, roles, kyc_level, email_verified_at, created_at FROM users WHERE id = $1', [userId]);
    if (!u.rows[0]) throw notFound('USER_NOT_FOUND', 'Kullanıcı bulunamadı');
    const devices = await this.pool.query(
      `SELECT d.device_key, d.first_ip, d.last_ip, d.last_seen,
              (SELECT count(DISTINCT x.user_id)::int FROM devices x WHERE x.device_key = d.device_key AND x.user_id <> d.user_id) AS shared_with
       FROM devices d WHERE d.user_id = $1 ORDER BY d.last_seen DESC LIMIT 20`,
      [userId],
    );
    const cases = await this.pool.query('SELECT id, status, level, max_score, tournament_id, opened_at, decided_at FROM fair_play_cases WHERE user_id = $1 ORDER BY opened_at DESC', [userId]);
    const audit = await this.pool.query(`SELECT action, actor_id, data, created_at FROM audit_log WHERE target_id = $1 ORDER BY id DESC LIMIT 30`, [userId]);
    const risk = await this.pool.query('SELECT game_id, score, level, created_at FROM risk_scores WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20', [userId]);
    return {
      user: u.rows[0],
      balances: await this.ledger.userBalances(userId),
      payments: await this.payments.listForUser(userId, 30),
      devices: devices.rows,
      cases: cases.rows,
      riskScores: risk.rows,
      audit: audit.rows,
    };
  }

  /** Güvenlik önlemi: tek kişi, hemen (doküman 14.5 seviye 4 geçici). */
  async freezeUser(actorId: string, userId: string, reason: string, ip: string): Promise<boolean> {
    if (reason.trim().length < 3) throw badRequest('VALIDATION', 'Gerekçe gerekli');
    return this.pool.tx(async (tx) => {
      const ok = await this.identity.setStatus(tx, userId, 'frozen', `admin:${reason}`, actorId);
      if (ok) await this.audit(tx, actorId, 'admin.freeze', 'user', userId, { reason }, ip);
      return ok;
    });
  }

  async setFlag(actorId: string, key: string, enabled: boolean, reason: string, ip: string): Promise<{ applied: boolean; approvalId?: string }> {
    if (reason.trim().length < 3) throw badRequest('VALIDATION', 'Gerekçe gerekli');
    if (!enabled) {
      // Durdurmak tek kişiyle ve hemen (kill switch).
      await this.pool.tx(async (tx) => {
        await this.flags.set(tx, key, false, actorId, reason);
        await this.audit(tx, actorId, 'admin.kill_switch', 'feature_flag', key, { reason }, ip);
      });
      this.flags.invalidate();
      return { applied: true };
    }
    // Yeniden açmak dört göz ister.
    const approvalId = await this.propose(actorId, 'flag.enable', 'feature_flag', key, { key }, reason);
    return { applied: false, approvalId };
  }

  // ---- dört göz ----------------------------------------------------------------------

  async propose(actorId: string, action: ApprovalAction, targetType: string, targetId: string, payload: Record<string, unknown>, reason: string): Promise<string> {
    if (!reason || reason.trim().length < 3) throw badRequest('VALIDATION', 'Gerekçe gerekli (en az 3 karakter)');
    await this.requireStaff(actorId, ACTION_ROLES[action]);
    try {
      return await this.pool.tx(async (tx) => {
        const r = await tx.query<{ id: string }>(
          `INSERT INTO admin_approvals (action, target_type, target_id, payload, reason, requested_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [action, targetType, targetId, payload, reason.trim(), actorId],
        );
        const id = (r.rows[0] as { id: string }).id;
        if (action === 'fairplay.decide') {
          await tx.query(
            `UPDATE fair_play_cases SET proposed_by = $2, proposed_decision = $3, proposed_note = $4, proposed_at = now() WHERE id = $1`,
            [targetId, actorId, payload.decision, reason],
          );
        }
        await this.audit(tx, actorId, 'approval.request', targetType, targetId, { approvalId: id, action, payload, reason });
        return id;
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw conflict('APPROVAL_PENDING', 'Bu hedef için bekleyen bir talep zaten var');
      throw e;
    }
  }

  async listApprovals(status = 'PENDING') {
    const r = await this.pool.query(
      `SELECT a.*, ru.display_name AS requested_by_name, du.display_name AS decided_by_name FROM admin_approvals a
       JOIN users ru ON ru.id = a.requested_by LEFT JOIN users du ON du.id = a.decided_by
       WHERE $1 = 'ALL' OR a.status = $1 ORDER BY a.requested_at DESC LIMIT 100`,
      [status],
    );
    return r.rows;
  }

  async reject(actorId: string, approvalId: string, note: string): Promise<void> {
    await this.pool.tx(async (tx) => {
      const a = await this.lockApproval(tx, approvalId);
      await this.requireStaff(actorId, ACTION_ROLES[a.action]);
      // Talep eden kendi talebini geri çekebilir; başkası reddedebilir.
      await tx.query(`UPDATE admin_approvals SET status = 'REJECTED', decided_by = CASE WHEN requested_by = $2 THEN NULL ELSE $2 END, decided_at = now(), decision_note = $3 WHERE id = $1`,
        [approvalId, actorId, note || null]);
      if (a.action === 'fairplay.decide') {
        await tx.query('UPDATE fair_play_cases SET proposed_by = NULL, proposed_decision = NULL, proposed_note = NULL, proposed_at = NULL WHERE id = $1', [a.target_id]);
      }
      await this.audit(tx, actorId, 'approval.reject', a.target_type, a.target_id, { approvalId, note });
    });
  }

  private async lockApproval(tx: Connection, id: string): Promise<ApprovalRow> {
    const r = await tx.query<ApprovalRow>('SELECT * FROM admin_approvals WHERE id = $1 FOR UPDATE', [id]);
    const a = r.rows[0];
    if (!a) throw notFound('APPROVAL_NOT_FOUND', 'Talep bulunamadı');
    if (a.status !== 'PENDING') throw conflict('APPROVAL_CLOSED', 'Talep zaten sonuçlanmış');
    return a;
  }

  /** İkinci kişinin onayı: işlem onayla aynı veritabanı işleminde yürütülür. */
  async approve(actorId: string, approvalId: string, note: string): Promise<{ status: string; result?: unknown }> {
    const notes: (() => void)[] = [];
    try {
      const result = await this.pool.tx(async (tx) => {
        const a = await this.lockApproval(tx, approvalId);
        if (a.requested_by === actorId) throw forbidden('FOUR_EYES', 'Kendi talebinizi onaylayamazsınız (dört göz ilkesi)');
        await this.requireStaff(actorId, ACTION_ROLES[a.action]);
        const res = await this.execute(tx, a, actorId, note, notes);
        await tx.query(`UPDATE admin_approvals SET status = 'EXECUTED', decided_by = $2, decided_at = now(), decision_note = $3, result = $4 WHERE id = $1`,
          [approvalId, actorId, note || null, res ?? {}]);
        await this.audit(tx, actorId, 'approval.execute', a.target_type, a.target_id, { approvalId, action: a.action, requestedBy: a.requested_by, result: res });
        return res;
      });
      for (const n of notes) n();
      this.flags.invalidate();
      return { status: 'EXECUTED', result };
    } catch (e) {
      if (e instanceof AppError && (e.code === 'FOUR_EYES' || e.code === 'APPROVAL_CLOSED' || e.code === 'APPROVAL_NOT_FOUND' || e.status === 403)) throw e;
      // Yürütme hatası: talep FAILED olarak kapanır (hiçbir yan etki kalmadı; işlem geri alındı).
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn('Onaylanan işlem yürütülemedi', { approvalId, error: msg });
      await this.pool.query(
        `UPDATE admin_approvals SET status = 'FAILED', decided_by = $2, decided_at = now(), decision_note = $3, result = $4 WHERE id = $1 AND status = 'PENDING' AND requested_by <> $2`,
        [approvalId, actorId, note || null, { error: msg }],
      );
      throw e instanceof AppError ? e : new AppError(409, 'APPROVAL_FAILED', msg);
    }
  }

  private async execute(tx: Connection, a: ApprovalRow, actorId: string, note: string, notes: (() => void)[]): Promise<Record<string, unknown>> {
    switch (a.action) {
      case 'fairplay.decide': {
        const decision = a.payload.decision as 'clear' | 'confirm';
        const ban = a.payload.ban === true;
        const c = await this.fairplay.closeCase(tx, a.target_id, decision, actorId, `${a.reason}${note ? ` / ${note}` : ''}`);
        let prize: string | null = null;
        if (c.tournamentId) {
          if (decision === 'confirm') prize = (await this.tournaments.voidAward(tx, c.tournamentId, c.userId, a.target_id, notes)) ? 'voided' : 'none';
          else {
            await this.tournaments.clearAward(tx, c.tournamentId, c.userId, notes);
            prize = 'released';
          }
        }
        let account: string | null = null;
        if (decision === 'confirm' && ban) {
          await this.identity.setStatus(tx, c.userId, 'banned', `fairplay:${a.target_id}`, actorId);
          account = 'banned';
        } else if (decision === 'clear') {
          // Vaka nedeniyle geçici dondurulmuşsa ve başka açık vakası yoksa hesap açılır.
          const open = await tx.query(`SELECT 1 FROM fair_play_cases WHERE user_id = $1 AND status = 'OPEN' LIMIT 1`, [c.userId]);
          if (!open.rowCount && (await this.identity.setStatus(tx, c.userId, 'active', `fairplay_cleared:${a.target_id}`, actorId))) account = 'reactivated';
        }
        return { decision, prize, account };
      }
      case 'user.ban':
        return { changed: await this.identity.setStatus(tx, a.target_id, 'banned', a.reason, actorId) };
      case 'user.unban':
      case 'user.unfreeze':
        return { changed: await this.identity.setStatus(tx, a.target_id, 'active', a.reason, actorId) };
      case 'payment.refund': {
        const p = await this.payments.get(tx, a.target_id);
        if (!p) throw notFound('PAYMENT_NOT_FOUND', 'Ödeme bulunamadı');
        if (p.status !== 'SUCCEEDED') throw conflict('NOT_REFUNDABLE', 'Yalnız başarılı ödeme iade edilebilir');
        const seated = await tx.query<{ status: string }>(
          `SELECT t.status FROM ledger_transactions l JOIN tournaments t ON t.id = $2::uuid WHERE l.idempotency_key = $1`,
          [`payment:${p.id}:to-pool`, p.tournament_id],
        );
        let source: 'pool' | 'orphan';
        if (!seated.rowCount) source = 'orphan';
        else if (seated.rows[0]?.status === 'CANCELLED') source = 'pool';
        else throw conflict('POOL_IN_USE', 'Bu ödeme süren ya da hesaplaşmış bir turnuvanın emanetinde; önce turnuva iptal edilmeli');
        const ok = await this.payments.requestRefund(tx, { paymentId: p.id, source, reason: `admin:${a.reason}` }, { afterCommit: (fn) => notes.push(fn) });
        if (!ok) throw conflict('REFUND_EXISTS', 'Bu ödeme için iade zaten var');
        return { source };
      }
      case 'flag.enable':
        await this.flags.set(tx, a.target_id, true, actorId, a.reason);
        return { key: a.target_id, enabled: true };
    }
  }

  async auditLog(limit = 100, target?: string) {
    const r = await this.pool.query(
      `SELECT l.id, l.action, l.target_type, l.target_id, l.data, l.ip, l.created_at, u.display_name AS actor
       FROM audit_log l LEFT JOIN users u ON u.id = l.actor_id
       WHERE $2::text IS NULL OR l.target_id = $2 ORDER BY l.id DESC LIMIT $1`,
      [limit, target ?? null],
    );
    return r.rows;
  }

  async tournamentsForReview() {
    const r = await this.pool.query(
      `SELECT t.id, t.name, t.status, t.capacity, (t.template->>'entry_fee_cents')::bigint AS entry_fee_cents, t.template->>'currency' AS currency,
              t.gross_cents, t.rake_cents, t.prize_pool_cents, t.hold_until, t.status_changed_at,
              (SELECT count(*)::int FROM entries e WHERE e.tournament_id = t.id AND e.status IN ('RESERVED', 'CONFIRMED', 'ELIMINATED', 'WINNER', 'DISQUALIFIED')) AS players,
              (SELECT count(*)::int FROM fair_play_cases c WHERE c.tournament_id = t.id AND c.status = 'OPEN') AS open_cases,
              (SELECT json_agg(json_build_object('userId', a.user_id, 'rank', a.rank, 'cents', a.cents, 'status', a.status, 'holdUntil', a.hold_until) ORDER BY a.rank)
                 FROM prize_awards a WHERE a.tournament_id = t.id) AS awards
       FROM tournaments t
       WHERE t.status IN ('OPEN', 'FULL', 'STARTING', 'RUNNING', 'SETTLING', 'DISPUTED') OR t.status_changed_at > now() - interval '24 hours'
       ORDER BY CASE t.status WHEN 'DISPUTED' THEN 0 WHEN 'SETTLING' THEN 1 WHEN 'RUNNING' THEN 2 ELSE 3 END, t.created_at DESC LIMIT 100`,
    );
    return r.rows;
  }

  async cancelTournament(actorId: string, tournamentId: string, reason: string) {
    if (reason.trim().length < 3) throw badRequest('VALIDATION', 'Gerekçe gerekli');
    return this.tournaments.cancel(tournamentId, actorId, reason);
  }
}
