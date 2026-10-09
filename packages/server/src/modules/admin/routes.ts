/**
 * Yönetim paneli API'si (/v1/admin/*). Her rota rolü veritabanından doğrular.
 *   admin    : her şey
 *   finance  : finans ekranı, mutabakat, iade onayı
 *   fairplay : vaka kuyruğu, analiz, vaka kararı onayı
 */
import type { Router } from '../../infra/http/router.ts';
import { badRequest, notFound } from '../../infra/errors.ts';
import { isUuid, parse } from '../../infra/http/validate.ts';
import type { AnalysisService } from '../fairplay/analysis.ts';
import type { FairPlayService } from '../fairplay/service.ts';
import type { PaymentService } from '../payments/service.ts';
import type { TournamentService } from '../tournament/service.ts';
import type { WalletService } from '../wallet/service.ts';
import { PLATFORM_RAKE_BPS, schemeFor } from '../ledger/prizes.ts';
import type { Pool } from '../../infra/db/pg.ts';
import type { AdminService, StaffRole } from './service.ts';

export function adminRoutes(router: Router, d: {
  admin: AdminService; fairplay: FairPlayService; analysis: AnalysisService; payments: PaymentService; tournaments: TournamentService; pool: Pool; wallet: WalletService;
}): void {
  const { admin, fairplay, analysis, payments, tournaments, pool, wallet } = d;
  const staff = (ctx: { requireUser(): { id: string } }, roles: StaffRole[] = []) => admin.requireStaff(ctx.requireUser().id, roles);
  const id = (ctx: { params: Record<string, string> }, what = 'Kayıt'): string => {
    if (!isUuid(ctx.params.id)) throw notFound('NOT_FOUND', `${what} bulunamadı`);
    return ctx.params.id as string;
  };
  const reasonSchema = { reason: { type: 'string', min: 3, max: 500 } } as const;

  router.get('/v1/admin/me', async (ctx) => {
    const s = await staff(ctx, ['finance', 'fairplay']);
    return { id: s.id, roles: s.roles };
  });
  router.get('/v1/admin/overview', async (ctx) => {
    await staff(ctx, ['finance', 'fairplay']);
    return admin.overview();
  });

  // ---- K43 para çekme talepleri ----
  router.get('/v1/admin/withdrawals', async (ctx) => {
    await staff(ctx, ['finance']);
    const st = ctx.query.get('status');
    return { withdrawals: await wallet.list(st && ['REQUESTED', 'PAID', 'REJECTED', 'CANCELED'].includes(st) ? st : null) };
  });
  router.post('/v1/admin/withdrawals/:id/paid', async (ctx) => {
    const s = await staff(ctx, ['finance']);
    const b = parse({ payoutRef: { type: 'string', min: 3, max: 120 } }, ctx.body);
    return wallet.markPaid(s.id, ctx.params.id as string, b.payoutRef);
  });
  router.post('/v1/admin/withdrawals/:id/reject', async (ctx) => {
    const s = await staff(ctx, ['finance']);
    const b = parse(reasonSchema, ctx.body);
    return wallet.reject(s.id, ctx.params.id as string, b.reason);
  });

  // ---- finans ----
  router.get('/v1/admin/finance', async (ctx) => {
    await staff(ctx, ['finance']);
    return admin.finance();
  });
  router.post('/v1/admin/finance/reconcile', async (ctx) => {
    const s = await staff(ctx, ['finance']);
    const b = parse({ currency: { type: 'string', pattern: /^[A-Z]{3}$/, upper: true, optional: true } }, ctx.body);
    const rep = await payments.reconcile(b.currency ?? 'USD');
    await admin.audit(pool, s.id, 'finance.reconcile', 'currency', rep.currency, { ...rep }, ctx.ip);
    return rep;
  });
  router.post('/v1/admin/payments/:id/refund', async (ctx) => {
    const s = await staff(ctx, ['finance']);
    const b = parse(reasonSchema, ctx.body);
    ctx.status = 202;
    return { approvalId: await admin.propose(s.id, 'payment.refund', 'payment', id(ctx, 'Ödeme'), {}, b.reason), needsApproval: true };
  });

  // ---- adil oyun ----
  router.get('/v1/admin/cases', async (ctx) => {
    await staff(ctx, ['fairplay']);
    const st = (ctx.query.get('status') ?? 'OPEN').toUpperCase();
    if (!['OPEN', 'CLEARED', 'CONFIRMED', 'ALL'].includes(st)) throw badRequest('VALIDATION', 'Geçersiz durum');
    return { cases: await fairplay.listCases(st as 'OPEN') };
  });
  router.get('/v1/admin/cases/:id', async (ctx) => {
    await staff(ctx, ['fairplay']);
    return fairplay.caseDetail(id(ctx, 'Vaka'));
  });
  router.post('/v1/admin/cases/:id/propose', async (ctx) => {
    const s = await staff(ctx, ['fairplay']);
    const b = parse({ decision: { type: 'string', enum: ['clear', 'confirm'] as const }, ban: { type: 'boolean', optional: true }, ...reasonSchema }, ctx.body);
    ctx.status = 202;
    return { approvalId: await admin.propose(s.id, 'fairplay.decide', 'fair_play_case', id(ctx, 'Vaka'), { decision: b.decision, ban: b.ban === true }, b.reason), needsApproval: true };
  });
  router.post('/v1/admin/cases/manual', async (ctx) => {
    const s = await staff(ctx, ['fairplay']);
    const b = parse({ userId: { type: 'uuid' }, tournamentId: { type: 'uuid', optional: true }, ...reasonSchema }, ctx.body);
    ctx.status = 201;
    return { caseId: await fairplay.openManualCase(b.userId, b.tournamentId ?? null, s.id, b.reason) };
  });
  router.get('/v1/admin/games/:id/analysis', async (ctx) => {
    await staff(ctx, ['fairplay']);
    const r = await analysis.result(id(ctx, 'Oyun'));
    const job = await pool.query('SELECT status, attempts, error, created_at, finished_at FROM analysis_jobs WHERE game_id = $1', [ctx.params.id]);
    return { result: r, job: job.rows[0] ?? null };
  });
  router.post('/v1/admin/games/:id/analyse', async (ctx) => {
    const s = await staff(ctx, ['fairplay']);
    const gid = id(ctx, 'Oyun');
    const ok = await analysis.enqueue(pool, gid, s.id, 10);
    await admin.audit(pool, s.id, 'analysis.request', 'game', gid, {}, ctx.ip);
    ctx.status = 202;
    return { queued: ok };
  });

  // ---- onaylar (dört göz) ----
  router.get('/v1/admin/approvals', async (ctx) => {
    await staff(ctx, ['finance', 'fairplay']);
    return { approvals: await admin.listApprovals((ctx.query.get('status') ?? 'PENDING').toUpperCase()) };
  });
  router.post('/v1/admin/approvals/:id/approve', async (ctx) => {
    const s = await staff(ctx, ['finance', 'fairplay']);
    const b = parse({ note: { type: 'string', max: 500, optional: true } }, ctx.body ?? {});
    return admin.approve(s.id, id(ctx, 'Talep'), b.note ?? '');
  });
  router.post('/v1/admin/approvals/:id/reject', async (ctx) => {
    const s = await staff(ctx, ['finance', 'fairplay']);
    const b = parse({ note: { type: 'string', max: 500, optional: true } }, ctx.body ?? {});
    await admin.reject(s.id, id(ctx, 'Talep'), b.note ?? '');
    return { ok: true };
  });

  // ---- kullanıcılar ----
  router.get('/v1/admin/users', async (ctx) => {
    await staff(ctx, ['fairplay', 'finance']);
    return { users: await admin.searchUsers(ctx.query.get('q') ?? '') };
  });
  router.get('/v1/admin/users/:id', async (ctx) => {
    await staff(ctx, ['fairplay', 'finance']);
    return admin.userDetail(id(ctx, 'Kullanıcı'));
  });
  router.post('/v1/admin/users/:id/freeze', async (ctx) => {
    const s = await staff(ctx, ['fairplay']);
    const b = parse(reasonSchema, ctx.body);
    return { changed: await admin.freezeUser(s.id, id(ctx, 'Kullanıcı'), b.reason, ctx.ip) };
  });
  router.post('/v1/admin/users/:id/propose', async (ctx) => {
    const s = await staff(ctx, ['fairplay']);
    const b = parse({ action: { type: 'string', enum: ['ban', 'unban', 'unfreeze'] as const }, ...reasonSchema }, ctx.body);
    ctx.status = 202;
    return { approvalId: await admin.propose(s.id, `user.${b.action}` as 'user.ban', 'user', id(ctx, 'Kullanıcı'), {}, b.reason), needsApproval: true };
  });

  // ---- turnuvalar ve şablonlar ----
  router.get('/v1/admin/tournaments', async (ctx) => {
    await staff(ctx, ['fairplay', 'finance']);
    return { tournaments: await admin.tournamentsForReview() };
  });
  router.post('/v1/admin/tournaments/:id/cancel', async (ctx) => {
    const s = await staff(ctx, []);
    const b = parse(reasonSchema, ctx.body);
    return admin.cancelTournament(s.id, id(ctx, 'Turnuva'), b.reason);
  });
  router.get('/v1/admin/tournament-templates', async (ctx) => {
    await staff(ctx, ['finance']);
    return { templates: (await pool.query('SELECT * FROM tournament_templates ORDER BY created_at')).rows };
  });
  router.post('/v1/admin/tournament-templates', async (ctx) => {
    const s = await staff(ctx, []);
    const b = parse(
      {
        code: { type: 'string', pattern: /^[a-z0-9-]{3,40}$/ },
        name: { type: 'string', min: 3, max: 80 },
        capacity: { type: 'int', min: 4, max: 32 },
        timeControl: { type: 'string', pattern: /^\d{1,5}\+\d{1,3}$/ },
        readySeconds: { type: 'int', min: 5, max: 600 },
        breakSeconds: { type: 'int', min: 0, max: 600 },
        entryFeeCents: { type: 'int', min: 0, max: 100_000, optional: true },
        currency: { type: 'string', pattern: /^[A-Z]{3}$/, upper: true, optional: true },
        rakeBps: { type: 'int', min: 0, max: 3000, optional: true },
      },
      ctx.body,
    );
    // K41: ilk sürümde 4, 8 ve 16 kişilik turnuvalar; 32 kişilik sonra açılacak.
    if (![4, 8, 16].includes(b.capacity)) throw badRequest('VALIDATION', 'Kontenjan 4, 8 ya da 16 olmalı');
    const fee = b.entryFeeCents ?? 0;
    // K41: ücretli turnuvada sistem payı her zaman %10.
    if (fee > 0 && b.rakeBps !== undefined && b.rakeBps !== PLATFORM_RAKE_BPS) throw badRequest('VALIDATION', 'Ücretli turnuvada sistem payı %10 olmalı');
    if (fee > 0 && fee < 100) throw badRequest('VALIDATION', 'Giriş ücreti en az 1,00 olmalı');
    schemeFor(b.capacity);
    const r = await pool.query<{ id: string }>(
      `INSERT INTO tournament_templates (code, name, kind, capacity, time_control, ready_seconds, break_seconds, entry_fee_cents, currency, rake_bps)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [b.code, b.name, fee > 0 ? 'sng' : 'free', b.capacity, b.timeControl, b.readySeconds, b.breakSeconds, fee, b.currency ?? 'USD', fee > 0 ? PLATFORM_RAKE_BPS : 0],
    );
    await admin.audit(pool, s.id, 'template.create', 'tournament_template', (r.rows[0] as { id: string }).id, b, ctx.ip);
    await tournaments.ensureOpen();
    ctx.status = 201;
    return { template: r.rows[0] };
  });
  router.post('/v1/admin/tournament-templates/:id/active', async (ctx) => {
    const s = await staff(ctx, []);
    const b = parse({ active: { type: 'boolean' } }, ctx.body);
    const r = await pool.query('UPDATE tournament_templates SET active = $2 WHERE id = $1 RETURNING id', [id(ctx, 'Şablon'), b.active]);
    if (!r.rowCount) throw notFound('NOT_FOUND', 'Şablon bulunamadı');
    await admin.audit(pool, s.id, 'template.active', 'tournament_template', ctx.params.id as string, { active: b.active }, ctx.ip);
    if (b.active) await tournaments.ensureOpen();
    return { ok: true };
  });

  // ---- bayraklar (kill switch) ----
  router.get('/v1/admin/flags', async (ctx) => {
    await staff(ctx, ['finance', 'fairplay']);
    return { flags: await admin.overview().then((o) => o.flags) };
  });
  router.post('/v1/admin/flags/:key', async (ctx) => {
    const s = await staff(ctx, []);
    const key = String(ctx.params.key);
    if (!/^[a-z_]{3,40}$/.test(key)) throw badRequest('VALIDATION', 'Geçersiz bayrak');
    const b = parse({ enabled: { type: 'boolean' }, ...reasonSchema }, ctx.body);
    const r = await admin.setFlag(s.id, key, b.enabled, b.reason, ctx.ip);
    if (!r.applied) ctx.status = 202;
    if (r.applied && key === 'paid_tournaments' && !b.enabled) await tournaments.ensureOpen();
    return r;
  });

  // ---- denetim kaydı ----
  router.get('/v1/admin/audit', async (ctx) => {
    await staff(ctx, ['finance', 'fairplay']);
    const target = ctx.query.get('target') ?? undefined;
    return { entries: await admin.auditLog(Math.min(500, Number(ctx.query.get('limit') ?? 100) || 100), target) };
  });
}
