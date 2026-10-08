import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { newPlayer, sleep, startTestApp, type TestEnv, WsClient } from './helpers.ts';

let env: TestEnv;
before(async () => {
  env = await startTestApp({ firstMoveTimeoutMs: 1_500, reconnectTimeoutMs: 800 });
});
after(async () => {
  await env.close();
});

interface Pair {
  gameId: string;
  white: { id: string; ws: WsClient; token: string };
  black: { id: string; ws: WsClient; token: string };
}

async function startGame(timeControl = '300+3', extra: Record<string, unknown> = {}): Promise<Pair> {
  const w = await newPlayer(env.base);
  const b = await newPlayer(env.base);
  const gameId = await env.app.games.createGame(env.app.pool, { kind: 'casual', whiteId: w.id, blackId: b.id, timeControl, ...extra });
  await env.app.games.activateDue();
  const wws = await WsClient.open(env.base, w.client.token);
  const bws = await WsClient.open(env.base, b.client.token);
  wws.send({ type: 'game.join', gameId });
  bws.send({ type: 'game.join', gameId });
  await wws.next((m) => m.type === 'game.state' && m.gameId === gameId);
  await bws.next((m) => m.type === 'game.state' && m.gameId === gameId);
  return {
    gameId,
    white: { id: w.id, ws: wws, token: w.client.token as string },
    black: { id: b.id, ws: bws, token: b.client.token as string },
  };
}

async function move(p: Pair, side: 'white' | 'black', uci: string, seq: number): Promise<any> {
  p[side].ws.send({ type: 'game.move', gameId: p.gameId, uci, seq });
  return p.white.ws.next((m) => m.type === 'game.move' && m.gameId === p.gameId && m.ply === seq);
}

function closeAll(p: Pair): void {
  p.white.ws.close();
  p.black.ws.close();
}

describe('M3 oyun akışı', () => {
  it('aptal matı: hamleler yayınlanır, kaydedilir, oyun mat ile biter, olay yazılır', async () => {
    const p = await startGame();
    await move(p, 'white', 'f2f3', 1);
    await move(p, 'black', 'e7e5', 2);
    await move(p, 'white', 'g2g4', 3);
    const last = await move(p, 'black', 'd8h4', 4);
    assert.equal(last.san, 'Qh4#');
    const end = await p.white.ws.next((m) => m.type === 'game.end');
    assert.equal(end.result, '0-1');
    assert.equal(end.reason, 'mate');
    assert.match(end.pgn, /1\. f3 e5 2\. g4 Qh4# 0-1/);

    const g = await env.app.pool.query('SELECT status, result, end_reason, winner_color FROM games WHERE id = $1', [p.gameId]);
    assert.deepEqual(g.rows[0], { status: 'finished', result: '0-1', end_reason: 'mate', winner_color: 'b' });
    const mv = await env.app.pool.query('SELECT ply, uci, san, think_ms, clock_ms FROM moves WHERE game_id = $1 ORDER BY ply', [p.gameId]);
    assert.deepEqual(mv.rows.map((r) => r.san), ['f3', 'e5', 'g4', 'Qh4#']);
    for (const r of mv.rows) {
      assert.ok((r.think_ms as number) >= 0);
      assert.ok((r.clock_ms as number) > 300_000 - 10_000, 'artış eklendi, süre makul');
    }
    const ev = await env.app.pool.query(`SELECT payload FROM outbox WHERE topic = 'game.ended' AND payload->>'gameId' = $1`, [p.gameId]);
    assert.equal(ev.rows.length, 1);
    assert.equal((ev.rows[0]?.payload as any).reason, 'mate');
    closeAll(p);
  });

  it('sıra dışı, yasal olmayan, eski seq ve oyuncu olmayan hamleler reddedilir; kayıt oluşmaz', async () => {
    const p = await startGame();
    p.black.ws.send({ type: 'game.move', gameId: p.gameId, uci: 'e7e5', seq: 1 });
    assert.equal((await p.black.ws.next((m) => m.type === 'error')).code, 'NOT_YOUR_TURN');
    p.white.ws.send({ type: 'game.move', gameId: p.gameId, uci: 'e2e5', seq: 1 });
    assert.equal((await p.white.ws.next((m) => m.code === 'ILLEGAL_MOVE')).type, 'error');
    p.white.ws.send({ type: 'game.move', gameId: p.gameId, uci: 'e2e4', seq: 7 });
    assert.equal((await p.white.ws.next((m) => m.code === 'STALE_MOVE')).details.expectedSeq, 1);

    const stranger = await newPlayer(env.base);
    const sws = await WsClient.open(env.base, stranger.client.token);
    sws.send({ type: 'game.move', gameId: p.gameId, uci: 'e2e4', seq: 1 });
    assert.equal((await sws.next((m) => m.type === 'error')).code, 'NOT_A_PLAYER');
    const anon = await WsClient.open(env.base);
    anon.send({ type: 'game.move', gameId: p.gameId, uci: 'e2e4', seq: 1 });
    assert.equal((await anon.next((m) => m.type === 'error')).code, 'UNAUTHORIZED');

    const mv = await env.app.pool.query('SELECT count(*)::int AS n FROM moves WHERE game_id = $1', [p.gameId]);
    assert.equal(mv.rows[0]?.n, 0);
    sws.close();
    anon.close();
    closeAll(p);
  });

  it('aynı hamle iki kez gönderilirse yalnız biri işlenir', async () => {
    const p = await startGame();
    p.white.ws.send({ type: 'game.move', gameId: p.gameId, uci: 'e2e4', seq: 1 });
    p.white.ws.send({ type: 'game.move', gameId: p.gameId, uci: 'e2e4', seq: 1 });
    await p.white.ws.next((m) => m.code === 'STALE_MOVE');
    const mv = await env.app.pool.query('SELECT count(*)::int AS n FROM moves WHERE game_id = $1', [p.gameId]);
    assert.equal(mv.rows[0]?.n, 1);
    closeAll(p);
  });

  it('izleyici hamleleri görür ama oynayamaz', async () => {
    const p = await startGame();
    const viewer = await WsClient.open(env.base);
    viewer.send({ type: 'game.join', gameId: p.gameId });
    const st = await viewer.next((m) => m.type === 'game.state');
    assert.equal(st.players.w.id, p.white.id);
    await move(p, 'white', 'd2d4', 1);
    assert.equal((await viewer.next((m) => m.type === 'game.move')).san, 'd4');
    viewer.close();
    closeAll(p);
  });

  it('teslim ve beraberlik teklifi/kabulü', async () => {
    const p = await startGame();
    p.black.ws.send({ type: 'game.resign', gameId: p.gameId });
    const end = await p.white.ws.next((m) => m.type === 'game.end');
    assert.deepEqual([end.result, end.reason], ['1-0', 'resign']);
    closeAll(p);

    const q = await startGame();
    q.white.ws.send({ type: 'game.drawOffer', gameId: q.gameId });
    const offer = await q.black.ws.next((m) => m.type === 'game.draw' && m.action === 'offer');
    assert.equal(offer.by, 'w');
    q.black.ws.send({ type: 'game.drawAccept', gameId: q.gameId });
    const e2 = await q.white.ws.next((m) => m.type === 'game.end');
    assert.deepEqual([e2.result, e2.reason], ['1/2-1/2', 'agreement']);
    closeAll(q);
  });

  it('ücretli oyunda beraberlik teklifi 20. hamleden önce reddedilir', async () => {
    const p = await startGame('300+3', { paid: true });
    p.white.ws.send({ type: 'game.drawOffer', gameId: p.gameId });
    assert.equal((await p.white.ws.next((m) => m.type === 'error')).code, 'DRAW_OFFER_TOO_EARLY');
    const viewer = await WsClient.open(env.base);
    viewer.send({ type: 'game.join', gameId: p.gameId });
    assert.equal((await viewer.next((m) => m.type === 'error')).code, 'SPECTATE_DELAYED');
    viewer.close();
    closeAll(p);
  });
});

describe('M3 süre kuralları', () => {
  it('süre biten taraf kaybeder (bayrak zamanlayıcısı)', async () => {
    const p = await startGame('2+0');
    await move(p, 'white', 'e2e4', 1);
    await move(p, 'black', 'e7e5', 2);
    // Beyaz bir daha oynamaz: kalan ~2 sn içinde bayrak düşer.
    const end = await p.white.ws.next((m) => m.type === 'game.end', 5_000);
    assert.deepEqual([end.result, end.reason], ['0-1', 'timeout']);
    assert.equal(end.clock.whiteMs, 0);
    closeAll(p);
  });

  it('süre bitiminde rakip mat edemiyorsa beraberlik', async () => {
    const p = await startGame('2+0', { initialFen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1' });
    await move(p, 'white', 'e1d1', 1);
    await move(p, 'black', 'e8d8', 2);
    // Beyazın süresi biter; siyahta yalnız şah var.
    const end = await p.white.ws.next((m) => m.type === 'game.end', 5_000);
    assert.deepEqual([end.result, end.reason], ['1/2-1/2', 'timeout_vs_insufficient']);
    closeAll(p);
  });

  it('artış her hamlede eklenir ve kayıtlı saat doğru', async () => {
    const p = await startGame('10+5');
    const m1 = await move(p, 'white', 'e2e4', 1);
    assert.ok(m1.clock.whiteMs > 14_000 && m1.clock.whiteMs <= 15_000, `beyaz: ${m1.clock.whiteMs}`);
    assert.equal(m1.clock.running, 'b');
    const row = await env.app.pool.query('SELECT white_ms, black_ms FROM games WHERE id = $1', [p.gameId]);
    assert.equal(row.rows[0]?.white_ms, m1.clock.whiteMs);
    closeAll(p);
  });

  it('ilk hamle süresi: beyaz oynamazsa hükmen kaybeder', async () => {
    const p = await startGame();
    const end = await p.black.ws.next((m) => m.type === 'game.end', 5_000);
    assert.deepEqual([end.result, end.reason], ['0-1', 'forfeit']);
    closeAll(p);
  });

  it('ilk hamle süresi: siyah, beyazın ilk hamlesinden sonra oynamazsa kaybeder', async () => {
    const p = await startGame();
    await move(p, 'white', 'e2e4', 1);
    const end = await p.white.ws.next((m) => m.type === 'game.end', 5_000);
    assert.deepEqual([end.result, end.reason], ['1-0', 'forfeit']);
    closeAll(p);
  });
});

describe('M3 kopma ve kurtarma', () => {
  it('kopan oyuncu süre içinde dönerse oyun sürer; dönmezse terk ile kaybeder', async () => {
    const p = await startGame();
    await move(p, 'white', 'e2e4', 1);
    await move(p, 'black', 'e7e5', 2);
    p.white.ws.close();
    const off = await p.black.ws.next((m) => m.type === 'game.presence' && m.online === false);
    assert.equal(off.color, 'w');
    // 300 ms içinde geri dön.
    await sleep(300);
    const back = await WsClient.open(env.base, p.white.token);
    back.send({ type: 'game.join', gameId: p.gameId });
    const st = await back.next((m) => m.type === 'game.state');
    assert.equal(st.ply, 2, 'yeniden bağlanınca tam durum gelir');
    await sleep(900);
    back.send({ type: 'game.move', gameId: p.gameId, uci: 'g1f3', seq: 3 });
    assert.equal((await p.black.ws.next((m) => m.type === 'game.move' && m.ply === 3)).san, 'Nf3');

    // Bu kez dönmez.
    back.close();
    const end = await p.black.ws.next((m) => m.type === 'game.end', 5_000);
    assert.deepEqual([end.result, end.reason], ['0-1', 'abandon']);
    p.black.ws.close();
  });

  it('sunucu yeniden başlayınca oyun kaldığı yerden sürer, kesinti süreden düşülmez', async () => {
    const p = await startGame('60+0');
    await move(p, 'white', 'e2e4', 1);
    await move(p, 'black', 'e7e5', 2);
    const before = await env.app.pool.query('SELECT white_ms, black_ms FROM games WHERE id = $1', [p.gameId]);
    closeAll(p);
    await env.restart({}, 1_200); // 1,2 sn kesinti
    const w = await WsClient.open(env.base, p.white.token);
    const b = await WsClient.open(env.base, p.black.token);
    w.send({ type: 'game.join', gameId: p.gameId });
    b.send({ type: 'game.join', gameId: p.gameId });
    const st = await w.next((m) => m.type === 'game.state');
    assert.equal(st.status, 'active');
    assert.equal(st.ply, 2);
    assert.deepEqual(st.moves.map((m: any) => m.san), ['e4', 'e5']);
    const whiteNow = st.clock.whiteMs as number;
    assert.ok(before.rows[0]?.white_ms as number - whiteNow < 800, `kesinti düşülmemeli: önce ${before.rows[0]?.white_ms}, sonra ${whiteNow}`);
    await env.app.games.activateDue();
    w.send({ type: 'game.move', gameId: p.gameId, uci: 'g1f3', seq: 3 });
    assert.equal((await b.next((m) => m.type === 'game.move' && m.ply === 3)).san, 'Nf3');
    w.close();
    b.close();
  });

  it('zamanı gelmemiş oyun başlamaz; zamanı gelince başlar ve oyunculara bildirilir', async () => {
    const w = await newPlayer(env.base);
    const b = await newPlayer(env.base);
    const wws = await WsClient.open(env.base, w.client.token);
    const gameId = await env.app.games.createGame(env.app.pool, {
      kind: 'casual', whiteId: w.id, blackId: b.id, timeControl: '300+3', startAt: new Date(Date.now() + 600),
    });
    assert.deepEqual(await env.app.games.activateDue(), []);
    const started = await wws.next((m) => m.type === 'game.started' && m.gameId === gameId, 3_000);
    assert.equal(started.gameId, gameId);
    wws.close();
  });
});
