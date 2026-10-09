/**
 * K43 — cüzdan: bakiye yükleme, bakiyeden turnuvaya katılım, iade, para çekme
 * (en az 20 $, komisyon önizlemesi, yönetici ödemesi/reddi), hesap kapatma.
 * Her adımda defter dengesi ve mutabakat kontrol edilir.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client, newPlayer, sleep, startTestApp, STRONG_PASSWORD, type TestEnv, uniqueName } from './helpers.ts';
import { ScriptedPlayer } from './scripted-player.ts';

let env: TestEnv;
let finance: { client: Client; id: string };
before(async () => {
  env = await startTestApp({
    firstMoveTimeoutMs: 20_000,
    paidMinRatedGames: 0,
    prizeHoldSec: 1,
    sandboxDeliveryDelayMs: 0,
    sandboxDuplicateRate: 0.5,
  });
  env.app.tournaments.firstGameDelayMs = 0;
  const f = await newPlayer(env.base);
  await env.app.pool.query(`UPDATE users SET roles = '{player,finance}' WHERE id = $1`, [f.id]);
  finance = f;
});
after(async () => env.close());

const q = <T = any>(sql: string, params: unknown[] = []) => env.app.pool.query<T>(sql, params).then((r) => r.rows);
const bal = (code: string) => env.app.ledger.balance(env.app.pool, code);

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

async function payCheckout(checkoutUrl: string) {
  const u = new URL(checkoutUrl, env.base);
  return new Client(env.base).post(`/sandbox-psp/v1/checkout/${u.pathname.split('/').pop()}/pay`, { secret: u.searchParams.get('secret'), card: '4242424242424242', exp: '12/39', cvc: '123' });
}

async function topUp(c: Client, cents: number) {
  const d = await c.post('/v1/me/wallet/deposit', { amountCents: cents });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal((await payCheckout(d.body.checkoutUrl)).body.status, 'succeeded');
  await flush();
  return d.body.paymentId as string;
}

async function wallet(c: Client) {
  const w = await c.get('/v1/me/wallet');
  return { usd: w.body.balances.find((b: any) => b.currency === 'USD') ?? { totalCents: 0, depositCents: 0, availableCents: 0, pendingCents: 0 }, body: w.body };
}

async function openPaid(capacity = 4, fee = 500): Promise<string> {
  const code = uniqueName('cuzdan').toLowerCase();
  await env.app.pool.query(
    `INSERT INTO tournament_templates (code, name, kind, capacity, entry_fee_cents, currency, rake_bps, time_control, ready_seconds, break_seconds)
     VALUES ($1, $1, 'sng', $2, $3, 'USD', 1000, '180+2', 5, 0)`,
    [code, capacity, fee],
  );
  await env.app.tournaments.ensureOpen();
  return (await q<{ id: string }>(`SELECT t.id FROM tournaments t JOIN tournament_templates p ON p.id = t.template_id WHERE p.code = $1 AND t.status = 'OPEN'`, [code]))[0]!.id;
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

async function healthy() {
  const inv = await env.app.ledger.invariants();
  assert.ok(inv.balanced, 'defter dengeli');
  assert.equal(inv.negativeUserBalances, 0, 'negatif yükümlülük yok');
  const rep = await env.app.payments.reconcile('USD');
  assert.ok(rep.ok, `mutabakat: ${JSON.stringify(rep)}`);
}

describe('K43 bakiye yükleme ve bakiyeden katılım', () => {
  it('yükleme sınırları; yüklenen para webhook ile cüzdana geçer', async () => {
    const p = await newPlayer(env.base);
    assert.equal((await p.client.post('/v1/me/wallet/deposit', { amountCents: 1000 })).body.code, 'DEPOSIT_AMOUNT', 'en az 20 $');
    assert.equal((await p.client.post('/v1/me/wallet/deposit', { amountCents: 200_000 })).body.code, 'DEPOSIT_AMOUNT', 'en çok 1000 $');
    const pid = await topUp(p.client, 2500);
    const { usd } = await wallet(p.client);
    assert.equal(usd.depositCents, 2500);
    assert.equal(usd.totalCents, 2500);
    assert.equal((await p.client.get(`/v1/payments/${pid}`)).body.purpose, 'deposit');
    await healthy();
  });

  it('bakiye yeterliyse koltuk anında onaylanır; ayrılınca para bakiyeye döner; yetersizse kartla ödeme', async () => {
    const id = await openPaid(4, 1000);
    const rich = await newPlayer(env.base);
    await topUp(rich.client, 2000);
    const j = await rich.client.post(`/v1/tournaments/${id}/join`);
    assert.equal(j.status, 200, JSON.stringify(j.body));
    assert.deepEqual([j.body.status, j.body.paidFrom], ['CONFIRMED', 'wallet']);
    assert.equal(await bal(`TOURNAMENT_POOL:${id}`), 1000);
    assert.equal((await wallet(rich.client)).usd.totalCents, 1000);

    const l = await rich.client.post(`/v1/tournaments/${id}/leave`);
    assert.deepEqual(l.body, { ok: true, refund: true });
    assert.equal(await bal(`TOURNAMENT_POOL:${id}`), 0);
    assert.equal((await wallet(rich.client)).usd.depositCents, 2000, 'tam iade, anında');

    const poor = await newPlayer(env.base);
    const c = await poor.client.post(`/v1/tournaments/${id}/join`);
    assert.equal(c.body.status, 'RESERVED', 'bakiye yoksa kartla ödeme sayfasına gider');
    assert.ok(c.body.checkoutUrl);
    const forced = await newPlayer(env.base);
    const f = await forced.client.post(`/v1/tournaments/${id}/join`, { useWallet: true });
    assert.equal(f.body.code, 'INSUFFICIENT_BALANCE');
    await healthy();
  });

  it('dört oyuncu bakiyeden oynar; ödül çekilebilir bakiyeye geçer; iptal edilen turnuvada bakiyeye tam iade', async () => {
    const id = await openPaid(4, 500);
    const strength = new Map<string, number>();
    const players: ScriptedPlayer[] = [];
    for (let i = 0; i < 4; i++) {
      const p = await ScriptedPlayer.create(env.base, (g) => ((strength.get(p.id) ?? 0) > (strength.get(g.opponentId) ?? 0) ? 'win' : 'lose'));
      strength.set(p.id, i);
      players.push(p);
      await topUp(p.client, 2000);
      const j = await p.client.post(`/v1/tournaments/${id}/join`);
      assert.equal(j.body.paidFrom, 'wallet', JSON.stringify(j.body));
    }
    const done = await waitStatus(id, ['SETTLED'], 30_000);
    assert.equal(done.awards[0].cents, 1800);
    const champ = players[3]!;
    const w = (await wallet(champ.client)).usd;
    assert.deepEqual([w.depositCents, w.availableCents, w.totalCents], [1500, 1800, 3300]);

    // Ödül bakiyesiyle yeni turnuva: önce yüklenen bakiye harcanır.
    const id2 = await openPaid(4, 2000);
    const j = await champ.client.post(`/v1/tournaments/${id2}/join`);
    assert.equal(j.body.paidFrom, 'wallet');
    const e = (await q(`SELECT wallet_deposit_cents, wallet_winnings_cents FROM entries WHERE id = $1`, [j.body.entryId]))[0];
    assert.deepEqual([Number(e.wallet_deposit_cents), Number(e.wallet_winnings_cents)], [1500, 500]);
    const admin = await newPlayer(env.base);
    await env.app.pool.query(`UPDATE users SET roles = '{player,admin}' WHERE id = $1`, [admin.id]);
    assert.equal((await admin.client.post(`/v1/admin/tournaments/${id2}/cancel`, { reason: 'test iptali' })).status, 200);
    const back = (await wallet(champ.client)).usd;
    assert.deepEqual([back.depositCents, back.availableCents], [1500, 1800], 'geldiği hesaplara geri döndü');
    for (const p of players) p.close();
    await healthy();
  });
});

describe('K43 para çekme', () => {
  async function richPlayer(cents = 5000) {
    const p = await newPlayer(env.base);
    await topUp(p.client, cents);
    return p;
  }

  it('en az 20 $; komisyon önizlemesi ve uyarı metni; yönetici ödeyince bakiye düşer', async () => {
    const p = await richPlayer(5000);
    const quote = await p.client.get('/v1/me/wallet/quote?amountCents=3000&method=ewallet');
    assert.deepEqual([quote.body.amountCents, quote.body.feeCents, quote.body.netCents], [3000, 130, 2870], '1 $ + %1');
    assert.match(quote.body.notice.tr, /platformumuza ait değildir/);
    const bank = await p.client.get('/v1/me/wallet/quote?amountCents=3000&method=bank');
    assert.equal(bank.body.feeCents, 1500);

    const small = await p.client.post('/v1/me/withdrawals', { amountCents: 1999, method: 'ewallet', destination: 'oyuncu@example.com', holderName: 'Test Oyuncu' });
    assert.equal(small.body.code, 'WITHDRAW_MIN');
    const tooMuch = await p.client.post('/v1/me/withdrawals', { amountCents: 6000, method: 'ewallet', destination: 'oyuncu@example.com', holderName: 'Test Oyuncu' });
    assert.equal(tooMuch.body.code, 'INSUFFICIENT_BALANCE');
    const card = await p.client.post('/v1/me/withdrawals', { amountCents: 3000, method: 'ewallet', destination: '4242 4242 4242 4242', holderName: 'Test Oyuncu' });
    assert.equal(card.status, 400, 'kart numarası kabul edilmez');

    const w = await p.client.post('/v1/me/withdrawals', { amountCents: 3000, method: 'ewallet', destination: 'oyuncu@example.com', holderName: 'Test Oyuncu' });
    assert.equal(w.status, 201, JSON.stringify(w.body));
    assert.deepEqual([w.body.status, w.body.feeCents, w.body.netCents, w.body.destinationHint], ['REQUESTED', 130, 2870, 'oy***@example.com']);
    assert.equal((await wallet(p.client)).usd.totalCents, 2000, 'talep edilen tutar bakiyeden ayrıldı');
    const again = await p.client.post('/v1/me/withdrawals', { amountCents: 2000, method: 'ewallet', destination: 'oyuncu@example.com', holderName: 'Test Oyuncu' });
    assert.equal(again.body.code, 'WITHDRAWAL_OPEN', 'aynı anda tek açık talep');
    assert.equal(await bal('PAYOUTS_PENDING:USD') >= 3000, true);

    assert.equal((await p.client.post(`/v1/admin/withdrawals/${w.body.id}/paid`, { payoutRef: 'X123' })).status, 403, 'yalnız finans');
    const list = await finance.client.get('/v1/admin/withdrawals?status=REQUESTED');
    const row = list.body.withdrawals.find((x: any) => x.id === w.body.id);
    assert.equal(row.destination, 'oyuncu@example.com', 'finans tam hesap bilgisini görür');
    const paid = await finance.client.post(`/v1/admin/withdrawals/${w.body.id}/paid`, { payoutRef: 'DEKONT-2026-001' });
    assert.equal(paid.body.status, 'PAID');
    assert.equal((await finance.client.post(`/v1/admin/withdrawals/${w.body.id}/paid`, { payoutRef: 'DEKONT-2026-001' })).body.code, 'WITHDRAWAL_DONE');
    const mine = (await wallet(p.client)).body.withdrawals.items;
    assert.equal(mine[0].status, 'PAID');
    assert.equal(await bal('PAYOUTS_SENT:USD') <= -3000, true);
    await healthy();
  });

  it('reddedilen ve iptal edilen talep bakiyeye geri döner', async () => {
    const p = await richPlayer(4000);
    const w = await p.client.post('/v1/me/withdrawals', { amountCents: 2500, method: 'bank', destination: 'GB00TEST12345678', holderName: 'Test Oyuncu' });
    const r = await finance.client.post(`/v1/admin/withdrawals/${w.body.id}/reject`, { reason: 'Hesap sahibi adı uyuşmuyor' });
    assert.equal(r.body.status, 'REJECTED');
    assert.equal((await wallet(p.client)).usd.totalCents, 4000);
    const w2 = await p.client.post('/v1/me/withdrawals', { amountCents: 2500, method: 'ewallet', destination: 'oyuncu@example.com', holderName: 'Test Oyuncu' });
    const c = await p.client.post(`/v1/me/withdrawals/${w2.body.id}/cancel`);
    assert.equal(c.body.status, 'CANCELED');
    assert.equal((await wallet(p.client)).usd.totalCents, 4000);
    await healthy();
  });

  it('eşzamanlı iki talep bakiyeyi iki kez harcayamaz', async () => {
    const p = await richPlayer(3000);
    const body = { amountCents: 3000, method: 'ewallet', destination: 'oyuncu@example.com', holderName: 'Test Oyuncu' };
    const rs = await Promise.all([p.client.post('/v1/me/withdrawals', body), p.client.post('/v1/me/withdrawals', body)]);
    assert.equal(rs.filter((r) => r.status === 201).length, 1);
    assert.equal((await wallet(p.client)).usd.totalCents, 0);
    await healthy();
  });

  it('hesap kapatma: 20 $ altındaki bakiye de çekilir; ödeme yapılınca hesap kapanır ve giriş engellenir', async () => {
    const p = await richPlayer(2000);
    const id = await openPaid(4, 500);
    assert.equal((await p.client.post(`/v1/tournaments/${id}/join`)).body.paidFrom, 'wallet');
    const busy = await p.client.post('/v1/me/close-account', { method: 'ewallet', destination: 'oyuncu@example.com', holderName: 'Test Oyuncu' });
    assert.equal(busy.body.code, 'ACTIVE_TOURNAMENT');
    await p.client.post(`/v1/tournaments/${id}/leave`);
    // 15 $ çekip 5 $ bırakmak isteyen normal talepte reddedilir; kapatmada tamamı çekilir.
    const first = await p.client.post('/v1/me/withdrawals', { amountCents: 1500, method: 'ewallet', destination: 'oyuncu@example.com', holderName: 'Test Oyuncu' });
    assert.equal(first.body.code, 'WITHDRAW_MIN');
    const close = await p.client.post('/v1/me/close-account', { method: 'ewallet', destination: 'oyuncu@example.com', holderName: 'Test Oyuncu' });
    assert.equal(close.status, 200, JSON.stringify(close.body));
    assert.equal(close.body.withdrawal.amountCents, 2000);
    assert.equal(close.body.withdrawal.accountClosure, true);
    const blocked = await p.client.post(`/v1/tournaments/${id}/join`);
    assert.equal(blocked.body.code, 'ACCOUNT_CLOSING');
    assert.equal((await p.client.post('/v1/me/wallet/deposit', { amountCents: 2000 })).body.code, 'ACCOUNT_CLOSING');
    await finance.client.post(`/v1/admin/withdrawals/${close.body.withdrawal.id}/paid`, { payoutRef: 'KAPANIS-1' });
    const login = await new Client(env.base).post('/v1/auth/login', { email: p.email, password: STRONG_PASSWORD });
    assert.equal(login.body.code, 'ACCOUNT_CLOSED');
    await healthy();
  });

  it('bakiyesi sıfır olan hesap hemen kapanır', async () => {
    const p = await newPlayer(env.base);
    const r = await p.client.post('/v1/me/close-account', {});
    assert.deepEqual(r.body, { closed: true, withdrawal: null });
    assert.ok((await q('SELECT closed_at FROM users WHERE id = $1', [p.id]))[0].closed_at);
  });
});
