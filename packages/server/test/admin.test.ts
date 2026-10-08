/**
 * Bölüm 10 — M13 yönetim: rol denetimi (veritabanından), dört göz onayı, acil durdurma,
 * finans/mutabakat, vaka kararı, elle iade, şablon ve iptal; her işlem denetim kaydında.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client, newPlayer, sleep, startTestApp, STRONG_PASSWORD, type TestEnv, uniqueName } from './helpers.ts';

let env: TestEnv;
let A: Awaited<ReturnType<typeof newPlayer>>;
let B: Awaited<ReturnType<typeof newPlayer>>;
let F: Awaited<ReturnType<typeof newPlayer>>;
let P: Awaited<ReturnType<typeof newPlayer>>;

const q = <T = any>(sql: string, params: unknown[] = []) => env.app.pool.query<T>(sql, params).then((r) => r.rows);

async function flush() {
  for (let i = 0; i < 100; i++) {
    await env.app.sandbox!.deliver();
    await env.app.payments.processRefunds();
    await env.app.events.settle();
    const r = await q<{ n: number }>(`SELECT count(*)::int AS n FROM psp_sandbox_events WHERE delivered_at IS NULL`);
    if (r[0]!.n === 0) return;
    await sleep(20);
  }
}

async function paidPayment(user: typeof P) {
  const r = await env.app.payments.createPayment({
    userId: user.id, tournamentId: null, entryId: null, amountCents: 1000, currency: 'USD',
    idempotencyKey: uniqueName('adm'), description: 'test', returnUrl: () => '/',
  });
  const u = new URL(r.checkoutUrl!, env.base);
  await new Client(env.base).post(`/sandbox-psp/v1/checkout/${u.pathname.split('/').pop()}/pay`, { secret: u.searchParams.get('secret'), card: '4242424242424242', exp: '12/39', cvc: '123' });
  await flush();
  return r.paymentId;
}

before(async () => {
  env = await startTestApp({ sandboxDeliveryDelayMs: 0, sandboxDuplicateRate: 0, paidMinRatedGames: 0 });
  [A, B, F, P] = [await newPlayer(env.base), await newPlayer(env.base), await newPlayer(env.base), await newPlayer(env.base)];
  await q(`UPDATE users SET roles = '{player,admin}' WHERE id = ANY($1)`, [[A.id, B.id]]);
  await q(`UPDATE users SET roles = '{player,finance}' WHERE id = $1`, [F.id]);
});
after(async () => env.close());

describe('rol denetimi', () => {
  it('oyuncu yönetim API\'sine erişemez; finans rolü finansa erişir ama vakalara erişemez', async () => {
    assert.equal((await P.client.get('/v1/admin/overview')).status, 403);
    assert.equal((await new Client(env.base).get('/v1/admin/overview')).status, 401);
    assert.equal((await F.client.get('/v1/admin/finance')).status, 200);
    assert.equal((await F.client.get('/v1/admin/cases')).status, 403);
    const o = await A.client.get('/v1/admin/overview');
    assert.equal(o.status, 200);
    assert.ok(o.body.ledger.balanced);
    assert.ok(Array.isArray(o.body.flags));
  });

  it('rol veritabanından okunur: rolü alınan kişi eski token\'la da erişemez', async () => {
    const X = await newPlayer(env.base);
    await q(`UPDATE users SET roles = '{player,admin}' WHERE id = $1`, [X.id]);
    const login = await X.client.post('/v1/auth/login', { email: X.email, password: STRONG_PASSWORD });
    X.client.token = login.body.accessToken;
    assert.equal((await X.client.get('/v1/admin/overview')).status, 200);
    await q(`UPDATE users SET roles = '{player}' WHERE id = $1`, [X.id]);
    assert.equal((await X.client.get('/v1/admin/overview')).status, 403, 'token hâlâ admin rolü taşısa da reddedilir');
  });
});

describe('dört göz', () => {
  it('ban önerisi: öneren onaylayamaz, ikinci yönetici onaylar ve işlem aynı anda yürür', async () => {
    const X = await newPlayer(env.base);
    const p = await A.client.post(`/v1/admin/users/${X.id}/propose`, { action: 'ban', reason: 'tekrarlayan ihlal' });
    assert.equal(p.status, 202);
    assert.equal(p.body.needsApproval, true);
    assert.equal((await A.client.post(`/v1/admin/users/${X.id}/propose`, { action: 'ban', reason: 'ikinci kez' })).body.code, 'APPROVAL_PENDING');
    const self = await A.client.post(`/v1/admin/approvals/${p.body.approvalId}/approve`, {});
    assert.equal(self.status, 403);
    assert.equal(self.body.code, 'FOUR_EYES');
    assert.equal((await q('SELECT status FROM users WHERE id = $1', [X.id]))[0].status, 'active');
    const ok = await B.client.post(`/v1/admin/approvals/${p.body.approvalId}/approve`, { note: 'kanıt yeterli' });
    assert.equal(ok.body.status, 'EXECUTED');
    assert.equal((await q('SELECT status FROM users WHERE id = $1', [X.id]))[0].status, 'banned');
    assert.equal((await X.client.post('/v1/auth/login', { email: X.email, password: STRONG_PASSWORD })).body.code, 'ACCOUNT_LOCKED');
    const audit = await q(`SELECT action FROM audit_log WHERE target_id = $1 ORDER BY id`, [X.id]);
    assert.deepEqual(audit.map((a) => a.action).filter((a) => a.startsWith('approval.') || a === 'user.banned'), ['approval.request', 'user.banned', 'approval.execute']);
    // Onaylanmış talep ikinci kez onaylanamaz.
    assert.equal((await B.client.post(`/v1/admin/approvals/${p.body.approvalId}/approve`, {})).body.code, 'APPROVAL_CLOSED');
  });

  it('veritabanı da öneren = onaylayan kaydını reddeder', async () => {
    const id = (await q<{ id: string }>(`INSERT INTO admin_approvals (action, target_type, target_id, reason, requested_by) VALUES ('user.ban', 'user', 'x', 'deneme', $1) RETURNING id`, [A.id]))[0]!.id;
    await assert.rejects(q(`UPDATE admin_approvals SET decided_by = requested_by WHERE id = $1`, [id]), /check/i);
  });

  it('acil durdurma tek kişiyle hemen; yeniden açma dört göz', async () => {
    const off = await A.client.post('/v1/admin/flags/paid_tournaments', { enabled: false, reason: 'ödeme sağlayıcısında sorun' });
    assert.equal(off.status, 200);
    assert.equal(off.body.applied, true);
    assert.equal(await env.app.flags.isEnabled('paid_tournaments'), false);
    const on = await A.client.post('/v1/admin/flags/paid_tournaments', { enabled: true, reason: 'sorun giderildi' });
    assert.equal(on.status, 202);
    assert.equal(await env.app.flags.isEnabled('paid_tournaments'), false, 'onaysız açılmaz');
    await B.client.post(`/v1/admin/approvals/${on.body.approvalId}/approve`, {});
    assert.equal(await env.app.flags.isEnabled('paid_tournaments'), true);
    assert.ok((await q(`SELECT 1 FROM audit_log WHERE action = 'admin.kill_switch'`)).length >= 1);
  });

  it('elle iade: finans önerir, admin onaylar; yürütme hatası talebi FAILED kapatır', async () => {
    const pid = await paidPayment(P);
    const prop = await F.client.post(`/v1/admin/payments/${pid}/refund`, { reason: 'müşteri talebi, çift ödeme' });
    assert.equal(prop.status, 202);
    const ok = await A.client.post(`/v1/admin/approvals/${prop.body.approvalId}/approve`, {});
    assert.equal(ok.body.status, 'EXECUTED');
    assert.equal(ok.body.result.source, 'orphan');
    await flush();
    assert.equal((await q('SELECT status FROM payments WHERE id = $1', [pid]))[0].status, 'REFUNDED');
    // Aynı ödeme için ikinci iade: yürütmede reddedilir, talep FAILED.
    const again = await F.client.post(`/v1/admin/payments/${pid}/refund`, { reason: 'yanlışlıkla ikinci' });
    const fail = await A.client.post(`/v1/admin/approvals/${again.body.approvalId}/approve`, {});
    assert.equal(fail.status, 409);
    assert.equal((await q('SELECT status FROM admin_approvals WHERE id = $1', [again.body.approvalId]))[0].status, 'FAILED');
    const inv = await env.app.ledger.invariants();
    assert.ok(inv.balanced);
  });

  it('talep eden geri çekebilir; başkası reddedebilir', async () => {
    const X = await newPlayer(env.base);
    const p = await A.client.post(`/v1/admin/users/${X.id}/propose`, { action: 'ban', reason: 'şüphe' });
    await A.client.post(`/v1/admin/approvals/${p.body.approvalId}/reject`, { note: 'vazgeçtim' });
    assert.equal((await q('SELECT status, decided_by FROM admin_approvals WHERE id = $1', [p.body.approvalId]))[0].status, 'REJECTED');
    const list = await B.client.get('/v1/admin/approvals?status=ALL');
    assert.ok(list.body.approvals.some((a: any) => a.id === p.body.approvalId && a.status === 'REJECTED'));
  });
});

describe('adil oyun vakası kararı', () => {
  it('elle açılan vaka: dondurulmuş hesap temize çıkınca yeniden açılır', async () => {
    const X = await newPlayer(env.base);
    assert.equal((await A.client.post(`/v1/admin/users/${X.id}/freeze`, { reason: 'şikâyet incelemesi' })).body.changed, true);
    const c = await A.client.post('/v1/admin/cases/manual', { userId: X.id, reason: 'oyuncu şikâyeti' });
    assert.equal(c.status, 201);
    const list = await A.client.get('/v1/admin/cases');
    assert.ok(list.body.cases.some((x: any) => x.id === c.body.caseId));
    const detail = await A.client.get(`/v1/admin/cases/${c.body.caseId}`);
    assert.equal(detail.body.case.user_id, X.id);
    const p = await A.client.post(`/v1/admin/cases/${c.body.caseId}/propose`, { decision: 'clear', reason: 'kanıt yok' });
    assert.equal((await q('SELECT proposed_decision FROM fair_play_cases WHERE id = $1', [c.body.caseId]))[0].proposed_decision, 'clear');
    const ok = await B.client.post(`/v1/admin/approvals/${p.body.approvalId}/approve`, {});
    assert.equal(ok.body.result.account, 'reactivated');
    const row = (await q('SELECT status, decided_by FROM fair_play_cases WHERE id = $1', [c.body.caseId]))[0];
    assert.deepEqual(row, { status: 'CLEARED', decided_by: B.id });
    assert.equal((await q('SELECT status FROM users WHERE id = $1', [X.id]))[0].status, 'active');
  });
});

describe('turnuva yönetimi', () => {
  it('ücretli şablon: K10 komisyon bandı denetlenir; şablon açılınca turnuva açılır; iptal herkese iade', async () => {
    const code = uniqueName('adm').toLowerCase();
    const base = { code, name: 'Yönetim Kupası', capacity: 4, timeControl: '180+2', readySeconds: 30, breakSeconds: 0, entryFeeCents: 500, currency: 'USD' };
    assert.equal((await A.client.post('/v1/admin/tournament-templates', { ...base, rakeBps: 500 })).status, 400);
    assert.equal((await F.client.post('/v1/admin/tournament-templates', { ...base, rakeBps: 1200 })).status, 403, 'şablonu yalnız admin açar');
    const t = await A.client.post('/v1/admin/tournament-templates', { ...base, rakeBps: 1200 });
    assert.equal(t.status, 201);
    const tid = (await q<{ id: string }>(`SELECT id FROM tournaments WHERE template_id = $1 AND status = 'OPEN'`, [t.body.template.id]))[0]!.id;
    const j = await P.client.post(`/v1/tournaments/${tid}/join`);
    const u = new URL(j.body.checkoutUrl, env.base);
    await new Client(env.base).post(`/sandbox-psp/v1/checkout/${u.pathname.split('/').pop()}/pay`, { secret: u.searchParams.get('secret'), card: '4242424242424242', exp: '12/39', cvc: '123' });
    await flush();
    assert.equal(await env.app.ledger.balance(env.app.pool, `TOURNAMENT_POOL:${tid}`), 500);
    const list = await A.client.get('/v1/admin/tournaments');
    assert.ok(list.body.tournaments.some((x: any) => x.id === tid && x.players === 1));
    const c = await A.client.post(`/v1/admin/tournaments/${tid}/cancel`, { reason: 'test iptali' });
    assert.equal(c.body.refunds, 1);
    await flush();
    assert.equal(await env.app.ledger.balance(env.app.pool, `TOURNAMENT_POOL:${tid}`), 0);
    assert.equal((await q('SELECT status FROM payments WHERE id = $1', [j.body.paymentId]))[0].status, 'REFUNDED');
    // Şablon pasifleştirilir.
    assert.equal((await A.client.post(`/v1/admin/tournament-templates/${t.body.template.id}/active`, { active: false })).status, 200);
  });

  it('finans: mutabakat çalışır ve denetime yazılır; denetim kaydı listelenir', async () => {
    const r = await F.client.post('/v1/admin/finance/reconcile', { currency: 'USD' });
    assert.equal(r.status, 200);
    assert.equal(r.body.diffCents, 0);
    const fin = await F.client.get('/v1/admin/finance');
    assert.ok(fin.body.accounts.some((a: any) => a.code === 'PSP_CLEARING'));
    assert.ok(fin.body.reconciliation.length >= 1);
    const audit = await A.client.get('/v1/admin/audit?limit=50');
    assert.ok(audit.body.entries.some((e: any) => e.action === 'finance.reconcile'));
  });
});
