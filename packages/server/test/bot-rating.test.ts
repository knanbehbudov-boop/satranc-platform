import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { UciEngine } from '../src/modules/bot/uci.ts';
import { newPlayer, sleep, startTestApp, type TestEnv, WsClient } from './helpers.ts';

let env: TestEnv;
before(async () => {
  env = await startTestApp();
  env.app.bots.humanDelay = false;
});
after(async () => {
  await env.close();
});

const ENGINE = { command: process.execPath, args: ['--disable-warning=ExperimentalWarning', join(import.meta.dirname, '../src/modules/bot/builtin-engine.ts')] };

describe('M4a UCI sürücüsü', () => {
  it('motor süreci açılır, tek hamlelik matı bulur', async () => {
    const e = new UciEngine(ENGINE);
    await e.start();
    assert.equal(e.name, 'SatrancYerlesik 1.0');
    const mv = await e.bestMove('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', { BotDepth: '2', BotNoise: '0' }, { depth: 2 });
    assert.equal(mv, 'h5f7');
    e.quit();
  });

  it('art arda istekler sırayla yanıtlanır', async () => {
    const e = new UciEngine(ENGINE);
    await e.start();
    const results = await Promise.all([
      e.bestMove('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', {}, { depth: 1 }),
      e.bestMove('7k/8/6Q1/8/8/8/8/K7 b - - 0 1', {}, { depth: 1 }),
      e.bestMove('k7/8/8/8/8/8/8/K7 w - - 0 1', {}, { depth: 1 }),
    ]);
    assert.equal(results.length, 3);
    assert.ok(results.every((r) => r === null || /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(r)));
    e.quit();
  });

  it('çalışmayan motor açılırken hata verir (askıda kalmaz)', async () => {
    const e = new UciEngine({ command: process.execPath, args: ['-e', 'process.exit(1)'] });
    await assert.rejects(e.start(2_000));
  });
});

describe('M4a bot oyunu', () => {
  it('seviyeler listelenir', async () => {
    const p = await newPlayer(env.base);
    const r = await p.client.get('/v1/bots/levels');
    assert.equal(r.body.engine, undefined, 'motorun adı dışarıya verilmez (K44)');
    assert.equal(env.app.bots.engineKind, 'builtin');
    assert.deepEqual(r.body.levels.map((l: any) => l.id), ['baslangic', 'kolay', 'orta', 'ileri', 'usta', 'maksimum']);
  });

  it('beyazla oynayan insana bot cevap verir; bot oyunu "bot" havuzunda rating değiştirir', async () => {
    const p = await newPlayer(env.base);
    const r = await p.client.post('/v1/bots/games', { level: 'kolay', color: 'white', timeControl: '300+3' });
    assert.equal(r.status, 201);
    assert.equal(r.body.color, 'w');
    const { gameId } = r.body;
    const ws = await WsClient.open(env.base, p.client.token);
    ws.send({ type: 'game.join', gameId });
    await ws.next((m) => m.type === 'game.state');

    // İkinci bot oyunu açılamaz (devam eden oyun var).
    const dup = await p.client.post('/v1/bots/games', { level: 'kolay', color: 'white', timeControl: '300+3' });
    assert.equal(dup.body.code, 'ALREADY_PLAYING');

    ws.send({ type: 'game.move', gameId, uci: 'e2e4', seq: 1 });
    const reply = await ws.next((m) => m.type === 'game.move' && m.ply === 2, 15_000);
    assert.match(reply.uci, /^[a-h][1-8][a-h][1-8]/);
    ws.send({ type: 'game.move', gameId, uci: 'd2d4', seq: 3 });
    const reply2 = await ws.next((m) => m.type === 'game.move' && m.ply === 4, 15_000);
    assert.ok(reply2);
    ws.send({ type: 'game.resign', gameId });
    await ws.next((m) => m.type === 'game.end');
    await env.app.events.settle();
    const ratings = await p.client.get('/v1/me/ratings');
    const bot = ratings.body.ratings.find((x: any) => x.pool === 'bot');
    assert.ok(bot && bot.rating < 1500 && bot.games === 1, JSON.stringify(ratings.body));
    assert.equal(await env.app.ratings.humanRatedGames(p.id), 0, 'bot oyunu ücretli giriş şartına sayılmaz (K6)');
    ws.close();
  });

  it('siyahla oynayınca bot ilk hamleyi kendisi yapar', async () => {
    const p = await newPlayer(env.base);
    const r = await p.client.post('/v1/bots/games', { level: 'baslangic', color: 'black', timeControl: '180+2' });
    const ws = await WsClient.open(env.base, p.client.token);
    ws.send({ type: 'game.join', gameId: r.body.gameId });
    const first = await ws.next((m) => (m.type === 'game.move' && m.ply === 1) || (m.type === 'game.state' && m.ply === 1), 15_000);
    assert.ok(first);
    ws.send({ type: 'game.resign', gameId: r.body.gameId });
    await ws.next((m) => m.type === 'game.end');
    ws.close();
  });
});

describe('M6 rating güncellemesi', () => {
  async function playedGame(opts: { armageddon?: boolean; timeControl?: string; plies?: number } = {}) {
    const w = await newPlayer(env.base);
    const b = await newPlayer(env.base);
    const gameId = await env.app.games.createGame(env.app.pool, {
      kind: 'casual', whiteId: w.id, blackId: b.id, timeControl: opts.timeControl ?? '300+3', armageddon: opts.armageddon ?? false,
    });
    await env.app.games.activateDue();
    const ws = await WsClient.open(env.base, w.client.token);
    const bs = await WsClient.open(env.base, b.client.token);
    ws.send({ type: 'game.join', gameId });
    bs.send({ type: 'game.join', gameId });
    await ws.next((m) => m.type === 'game.state');
    await bs.next((m) => m.type === 'game.state');
    const line = ['e2e4', 'e7e5', 'g1f3', 'b8c6'].slice(0, opts.plies ?? 2);
    for (let i = 0; i < line.length; i++) {
      (i % 2 === 0 ? ws : bs).send({ type: 'game.move', gameId, uci: line[i], seq: i + 1 });
      await ws.next((m) => m.type === 'game.move' && m.ply === i + 1);
    }
    bs.send({ type: 'game.resign', gameId });
    await ws.next((m) => m.type === 'game.end');
    ws.close();
    bs.close();
    await env.app.events.settle();
    return { w, b, gameId };
  }

  it('insan–insan blitz oyunu: kazanan +, kaybeden −, simetrik; geçmiş kaydı', async () => {
    const { w, b, gameId } = await playedGame();
    const wr = await env.app.ratings.ratingFor(w.id, 'blitz');
    const br = await env.app.ratings.ratingFor(b.id, 'blitz');
    assert.ok(wr.rating > 1500 && br.rating < 1500);
    assert.equal(wr.rating - 1500, 1500 - br.rating);
    assert.equal(wr.games, 1);
    assert.equal(await env.app.ratings.humanRatedGames(w.id), 1);
    const hist = await env.app.pool.query('SELECT count(*)::int AS n FROM rating_history WHERE game_id = $1', [gameId]);
    assert.equal(hist.rows[0]?.n, 2);
  });

  it('olay tekrar işlense de rating bir kez değişir', async () => {
    const { w } = await playedGame();
    const before = await env.app.ratings.ratingFor(w.id, 'blitz');
    // Tüketim kaydı varken olayı yeniden işletmeyi dene.
    await env.app.events.settle();
    await env.app.pool.query(`UPDATE outbox_cursor SET last_id = 0 WHERE consumer = 'rating'`);
    await env.app.events.settle();
    const after = await env.app.ratings.ratingFor(w.id, 'blitz');
    assert.deepEqual(after, before);
  });

  it('2 yarım hamleden kısa oyun rating değiştirmez (K20)', async () => {
    const { w } = await playedGame({ plies: 1 });
    const r = await env.app.ratings.ratingsOf(w.id);
    assert.deepEqual(r, []);
  });

  it('Armageddon yarım ağırlıkla işlenir (K21)', async () => {
    const normal = await playedGame();
    const arma = await playedGame({ armageddon: true });
    const dn = (await env.app.ratings.ratingFor(normal.w.id, 'blitz')).rating - 1500;
    const da = (await env.app.ratings.ratingFor(arma.w.id, 'blitz')).rating - 1500;
    assert.ok(Math.abs(da - dn / 2) <= 1, `normal ${dn}, armageddon ${da}`);
  });

  it('zaman kontrolüne göre havuz: 1+0 bullet, 10+5 rapid', async () => {
    const bullet = await playedGame({ timeControl: '60+0' });
    assert.equal((await env.app.ratings.ratingsOf(bullet.w.id))[0]?.pool, 'bullet');
    const rapid = await playedGame({ timeControl: '600+5' });
    assert.equal((await env.app.ratings.ratingsOf(rapid.w.id))[0]?.pool, 'rapid');
    await sleep(10);
  });
});
