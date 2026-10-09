/**
 * Bölüm 8 — ücretli turnuva uçtan uca: rezervasyon → ödeme sayfası → webhook →
 * koltuk onayı → turnuva → hesaplaşma → bekletme → çekilebilir bakiye. Her adımda
 * defterin dengesi ve emanet = koltuk × ücret kontrol edilir.
 * Sandbox webhook'ları %50 olasılıkla iki kez gelir (idempotency sürekli sınanır).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client, newPlayer, sleep, startTestApp, type TestEnv, uniqueName } from './helpers.ts';
import { ScriptedPlayer } from './scripted-player.ts';

let env: TestEnv;
before(async () => {
  env = await startTestApp({
    firstMoveTimeoutMs: 20_000,
    paidMinRatedGames: 0,
    prizeHoldSec: 1,
    sandboxDeliveryDelayMs: 0,
    sandboxDuplicateRate: 0.5,
  });
  env.app.tournaments.firstGameDelayMs = 0;
});
after(async () => env.close());

const q = <T = any>(sql: string, params: unknown[] = []) => env.app.pool.query<T>(sql, params).then((r) => r.rows);
const bal = (code: string) => env.app.ledger.balance(env.app.pool, code);

async function openPaid(capacity = 4, fee = 500, rakeBps = 1200, ready = 5): Promise<string> {
  const code = uniqueName('ucretli').toLowerCase();
  await env.app.pool.query(
    `INSERT INTO tournament_templates (code, name, kind, capacity, entry_fee_cents, currency, rake_bps, time_control, ready_seconds, break_seconds)
     VALUES ($1, $2, 'sng', $3, $4, 'USD', $5, '180+2', $6, 0)`,
    [code, `Ücretli ${code}`, capacity, fee, rakeBps, ready],
  );
  await env.app.tournaments.ensureOpen();
  const r = await q<{ id: string }>(
    `SELECT t.id FROM tournaments t JOIN tournament_templates p ON p.id = t.template_id WHERE p.code = $1 AND t.status = 'OPEN'`,
    [code],
  );
  return r[0]!.id;
}

/** Bekleyen webhook'ları teslim et ve olay tüketicilerini çalıştır. */
async function flush(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    await env.app.sandbox!.deliver();
    await env.app.payments.processRefunds();
    await env.app.events.settle();
    const r = await q<{ n: number }>('SELECT count(*)::int AS n FROM psp_sandbox_events WHERE delivered_at IS NULL');
    const rf = await q<{ n: number }>(`SELECT count(*)::int AS n FROM refunds WHERE status = 'PENDING'`);
    if (r[0]!.n === 0 && rf[0]!.n === 0) {
      await env.app.events.settle();
      return;
    }
    await sleep(30);
  }
  throw new Error('flush zaman aşımı');
}

async function payCheckout(checkoutUrl: string, card = '4242424242424242') {
  const u = new URL(checkoutUrl, env.base);
  const intentId = u.pathname.split('/').pop()!;
  return new Client(env.base).post(`/sandbox-psp/v1/checkout/${intentId}/pay`, { secret: u.searchParams.get('secret'), card, exp: '12/39', cvc: '123' });
}

async function joinAndPay(c: Client, id: string) {
  const j = await c.post(`/v1/tournaments/${id}/join`);
  assert.equal(j.status, 200, JSON.stringify(j.body));
  assert.equal(j.body.status, 'RESERVED');
  const p = await payCheckout(j.body.checkoutUrl);
  assert.equal(p.body.status, 'succeeded');
  return j.body as { entryId: string; paymentId: string; checkoutUrl: string };
}

async function waitStatus(id: string, statuses: string[], timeoutMs = 60_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await flush();
    const d = await env.app.tournaments.detail(id);
    if (statuses.includes(d.status)) return d;
    if (Date.now() > deadline) throw new Error(`Turnuva ${statuses.join('/')} olmadı; şu an ${d.status}`);
    await sleep(100);
  }
}

async function assertLedgerHealthy() {
  const inv = await env.app.ledger.invariants();
  assert.ok(inv.balanced, 'defter dengeli');
  assert.equal(inv.negativeUserBalances, 0, 'negatif yükümlülük yok');
  const rep = await env.app.payments.reconcile('USD');
  assert.ok(rep.ok, `mutabakat: ${JSON.stringify(rep)}`);
}

async function strongestWins(n: number) {
  const strength = new Map<string, number>();
  const players: ScriptedPlayer[] = [];
  for (let i = 0; i < n; i++) {
    const p = await ScriptedPlayer.create(env.base, (g) => ((strength.get(p.id) ?? 0) > (strength.get(g.opponentId) ?? 0) ? 'win' : 'lose'));
    strength.set(p.id, i);
    players.push(p);
  }
  return players;
}

describe('ücretli kayıt ve koltuk', () => {
  it('K6: yeterli rated oyunu olmayan ücretli turnuvaya giremez (bot oyunları sayılmaz)', async () => {
    const id = await openPaid();
    const p = await newPlayer(env.base);
    env.app.cfg.paidMinRatedGames = 10;
    try {
      const r = await p.client.post(`/v1/tournaments/${id}/join`);
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 'NOT_ENOUGH_RATED_GAMES');
    } finally {
      env.app.cfg.paidMinRatedGames = 0;
    }
  });

  it('ödeme yapılana kadar koltuk RESERVED; webhook sonrası CONFIRMED ve para emanette', async () => {
    const id = await openPaid();
    const p = await newPlayer(env.base);
    const j = await p.client.post(`/v1/tournaments/${id}/join`);
    assert.equal(j.body.status, 'RESERVED');
    assert.ok(j.body.checkoutUrl.startsWith('/sandbox-psp/checkout/'));
    assert.ok(new Date(j.body.expiresAt).getTime() > Date.now() + 9 * 60_000, '10 dk rezervasyon');
    let d = await env.app.tournaments.detail(id);
    assert.equal(d.entries[0]!.status, 'RESERVED');
    assert.ok(d.entries[0]!.reservedUntil);
    // Yeniden ödeme isteği aynı ödemeyi döndürür (idempotent).
    const again = await p.client.post(`/v1/tournaments/${id}/pay`);
    assert.equal(again.body.paymentId, j.body.paymentId);
    await payCheckout(j.body.checkoutUrl);
    await flush();
    d = await env.app.tournaments.detail(id);
    assert.equal(d.entries[0]!.status, 'CONFIRMED');
    assert.equal(await bal(`TOURNAMENT_POOL:${id}`), 500);
    assert.equal(await bal('USER_PAYMENT_IN:USD'), 0, 'geçici hesapta para kalmadı');
    await assertLedgerHealthy();
  });

  it('rezervasyonlar koltuk tutar: 4 rezervasyondan sonra 5. kişi giremez', async () => {
    const id = await openPaid(4);
    for (let i = 0; i < 4; i++) {
      const p = await newPlayer(env.base);
      assert.equal((await p.client.post(`/v1/tournaments/${id}/join`)).body.status, 'RESERVED');
    }
    const late = await newPlayer(env.base);
    const r = await late.client.post(`/v1/tournaments/${id}/join`);
    assert.equal(r.body.code, 'TOURNAMENT_FULL');
    assert.equal((await env.app.tournaments.detail(id)).status, 'OPEN', 'ödenmeden turnuva dolmaz');
  });

  it('süresi dolan rezervasyon koltuğu bırakır; geç gelen ödeme yetim olarak iade edilir', async () => {
    const id = await openPaid();
    const p = await newPlayer(env.base);
    env.app.cfg.seatReservationSec = 1;
    let j;
    try {
      j = await p.client.post(`/v1/tournaments/${id}/join`);
    } finally {
      env.app.cfg.seatReservationSec = 600;
    }
    for (let i = 0; i < 50; i++) {
      const e = await q('SELECT status, exit_reason FROM entries WHERE id = $1', [j.body.entryId]);
      if (e[0].status === 'WITHDRAWN') break;
      await sleep(100);
    }
    assert.deepEqual((await q('SELECT status, exit_reason FROM entries WHERE id = $1', [j.body.entryId]))[0], { status: 'WITHDRAWN', exit_reason: 'reservation_expired' });
    assert.equal((await q('SELECT status FROM payments WHERE id = $1', [j.body.paymentId]))[0].status, 'CANCELED');
    assert.equal((await p.client.post(`/v1/tournaments/${id}/pay`)).body.code, 'NO_RESERVATION');
    // Kullanıcı eski sekmeden yine de öderse:
    await payCheckout(j.body.checkoutUrl);
    await flush();
    const pay = await p.client.get(`/v1/payments/${j.body.paymentId}`);
    assert.equal(pay.body.status, 'REFUNDED');
    assert.equal(pay.body.refundStatus, 'SUCCEEDED');
    assert.equal((await q('SELECT reason, source FROM refunds WHERE payment_id = $1', [j.body.paymentId]))[0].source, 'orphan');
    assert.equal(await bal(`TOURNAMENT_POOL:${id}`), 0);
    await assertLedgerHealthy();
  });

  it('başlamadan ayrılan oyuncuya emanetten tam iade; yeniden katılım yeni ödeme ister', async () => {
    const id = await openPaid();
    const p = await newPlayer(env.base);
    const first = await joinAndPay(p.client, id);
    await flush();
    assert.equal(await bal(`TOURNAMENT_POOL:${id}`), 500);
    const l = await p.client.post(`/v1/tournaments/${id}/leave`);
    assert.deepEqual(l.body, { ok: true, refund: true });
    await flush();
    assert.equal((await p.client.get(`/v1/payments/${first.paymentId}`)).body.status, 'REFUNDED');
    assert.equal(await bal(`TOURNAMENT_POOL:${id}`), 0);
    const second = await p.client.post(`/v1/tournaments/${id}/join`);
    assert.equal(second.body.status, 'RESERVED');
    assert.notEqual(second.body.paymentId, first.paymentId);
    await p.client.post(`/v1/tournaments/${id}/leave`); // ödenmemiş rezervasyondan çıkış: iade yok
    await assertLedgerHealthy();
  });

  it('kill switch: paid_tournaments kapalıyken ücretli kayıt alınmaz, yeni ücretli turnuva açılmaz', async () => {
    const id = await openPaid();
    await env.app.flags.set(env.app.pool, 'paid_tournaments', false, null, 'test');
    try {
      const p = await newPlayer(env.base);
      const r = await p.client.post(`/v1/tournaments/${id}/join`);
      assert.equal(r.status, 503);
      assert.equal(r.body.code, 'PAID_TOURNAMENTS_PAUSED');
    } finally {
      await env.app.flags.set(env.app.pool, 'paid_tournaments', true, null, 'test');
    }
  });

  it('yönetici iptali: ödenen her koltuk iade edilir, ödenmemiş rezervasyonlar bırakılır', async () => {
    const id = await openPaid(4);
    const a = await newPlayer(env.base);
    const b = await newPlayer(env.base);
    const c = await newPlayer(env.base);
    const pa = await joinAndPay(a.client, id);
    const pb = await joinAndPay(b.client, id);
    const rc = await c.client.post(`/v1/tournaments/${id}/join`);
    await flush();
    assert.equal(await bal(`TOURNAMENT_POOL:${id}`), 1000);
    const res = await env.app.tournaments.cancel(id, a.id, 'test');
    assert.equal(res.refunds, 2);
    await flush();
    assert.equal(await bal(`TOURNAMENT_POOL:${id}`), 0);
    for (const pid of [pa.paymentId, pb.paymentId]) assert.equal((await q('SELECT status FROM payments WHERE id = $1', [pid]))[0].status, 'REFUNDED');
    assert.equal((await q('SELECT status FROM payments WHERE id = $1', [rc.body.paymentId]))[0].status, 'CANCELED');
    assert.equal((await env.app.tournaments.detail(id)).status, 'CANCELLED');
    await assertLedgerHealthy();
  });
});

describe('ücretli turnuva sonu: hesaplaşma, bekletme, cüzdan', () => {
  it('4 kişi × 5 USD, %10: 18,00 havuz → birinciye 18,00; bekletme sonrası çekilebilir; emanet sıfır', async () => {
    const id = await openPaid(4, 500, 1000);
    const players = await strongestWins(4);
    for (const p of players) await joinAndPay(p.client, id);
    const done = await waitStatus(id, ['SETTLING', 'SETTLED']);
    assert.deepEqual(done.settlement && [done.settlement.grossCents, done.settlement.rakeCents, done.settlement.prizePoolCents], [2000, 200, 1800]);
    const champ = players[3]!;
    const byUser = new Map(done.awards.map((a: any) => [a.id, a]));
    assert.equal((byUser.get(champ.id) as any).cents, 1800);
    assert.equal(done.awards.length, 1, '4 kişide yalnız birinci ödül alır');
    assert.equal(await bal(`TOURNAMENT_POOL:${id}`), 0, 'emanet tamamen dağıtıldı');

    const settled = await waitStatus(id, ['SETTLED'], 10_000);
    assert.ok(settled.awards.every((a: any) => a.status === 'RELEASED'));
    const w = await champ.client.get('/v1/me/wallet');
    const usd = w.body.balances.find((b: any) => b.currency === 'USD');
    assert.equal(usd.availableCents, 1800);
    assert.equal(usd.pendingCents, 0);
    assert.equal(w.body.awards[0].status, 'RELEASED');
    assert.equal(w.body.payments[0].status, 'SUCCEEDED');
    assert.equal(w.body.withdrawals.available, true);
    assert.equal(w.body.withdrawals.rules.minWithdrawCents, 2000);
    const events = await q<{ to_status: string }>('SELECT to_status FROM tournament_events WHERE tournament_id = $1 ORDER BY id', [id]);
    assert.deepEqual(events.map((e) => e.to_status), ['DRAFT', 'OPEN', 'FULL', 'STARTING', 'RUNNING', 'FINISHED', 'SETTLING', 'SETTLED']);
    await assertLedgerHealthy();
  });

  it('risk kapısı "bekle" derse ödül serbest kalmaz (DISPUTED); yönetici kararıyla serbest bırakılır', async () => {
    const id = await openPaid(4, 1000, 1500);
    const players = await strongestWins(4);
    env.app.tournaments.riskGate = async () => ({ wait: false, hold: 'all', delay: [] });
    try {
      for (const p of players) await joinAndPay(p.client, id);
      const d = await waitStatus(id, ['DISPUTED']);
      assert.ok(d.awards.every((a: any) => a.status === 'PENDING'));
      const champ = players[3]!;
      const w = await champ.client.get('/v1/me/wallet');
      assert.equal(w.body.balances.find((b: any) => b.currency === 'USD').pendingCents, d.awards.find((a: any) => a.id === champ.id).cents);
    } finally {
      env.app.tournaments.riskGate = env.app.fairplay.gate;
    }
    await env.app.pool.tx(async (tx) => {
      const t = (await tx.query<any>('SELECT * FROM tournaments WHERE id = $1 FOR UPDATE', [id])).rows[0];
      const notes: (() => void)[] = [];
      await env.app.tournaments.releaseAwards(tx, t, notes, false);
    });
    assert.equal((await env.app.tournaments.detail(id)).status, 'SETTLED');
    await assertLedgerHealthy();
  });

  it('kimse hazır değilse turnuva iptal olur ve ücretler iade edilir', async () => {
    const id = await openPaid(4, 500, 1200, 5);
    const ps = [await newPlayer(env.base), await newPlayer(env.base), await newPlayer(env.base), await newPlayer(env.base)];
    for (const p of ps) await joinAndPay(p.client, id);
    await waitStatus(id, ['STARTING']);
    const d = await waitStatus(id, ['CANCELLED'], 15_000);
    assert.ok(d);
    await flush();
    assert.equal(await bal(`TOURNAMENT_POOL:${id}`), 0);
    const st = await q(`SELECT p.status FROM payments p JOIN entries e ON e.payment_id = p.id WHERE e.tournament_id = $1`, [id]);
    assert.ok(st.length === 4 && st.every((r) => r.status === 'REFUNDED'));
    await assertLedgerHealthy();
  });
});
