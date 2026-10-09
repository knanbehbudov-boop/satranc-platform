/**
 * K47 — seviye belirleme: bota karşı 5 oyun, uyarlanan bot seviyesi, geçici başlangıç rating'i,
 * kum torbası önlemi (tahminden hızlı yükselen incelemeye alınır).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { nextLevel, performanceEstimate, PLACEMENT_GAMES } from '../src/modules/rating/placement.ts';
import { newPlayer, startTestApp, type TestEnv } from './helpers.ts';

describe('K47 hesap', () => {
  it('performans puanı ve seviye merdiveni', () => {
    assert.equal(performanceEstimate([{ elo: 1200, score: 1 }, { elo: 1600, score: 0 }]), 1400);
    assert.equal(performanceEstimate(Array.from({ length: 5 }, () => ({ elo: 900, score: 0 }))), 600, 'alt sınır');
    assert.equal(performanceEstimate(Array.from({ length: 5 }, () => ({ elo: 3000, score: 1 }))), 2400, 'üst sınır');
    assert.equal(nextLevel(1, 1), 2);
    assert.equal(nextLevel(1, 0), 0);
    assert.equal(nextLevel(0, 0), 0);
    assert.equal(nextLevel(5, 1), 5);
    assert.equal(nextLevel(2, 0.5), 2);
  });
});

describe('K47 uçtan uca', () => {
  let env: TestEnv;
  before(async () => {
    env = await startTestApp({});
  });
  after(async () => env.close());
  const q = <T = any>(sql: string, params: unknown[] = []) => env.app.pool.query<T>(sql, params).then((r) => r.rows);

  it('5 oyun; her kayıpta bot zayıflar; sonunda geçici rating yazılır; ikinci kez yapılamaz', async () => {
    const p = await newPlayer(env.base);
    assert.deepEqual((await p.client.get('/v1/me/placement')).body, { status: 'none', needed: true, step: 0, total: 5, estimate: null, currentGameId: null, nextLevel: null });
    const levels: string[] = [];
    for (let i = 0; i < PLACEMENT_GAMES; i++) {
      const n = await p.client.post('/v1/me/placement/next');
      assert.equal(n.status, 201, JSON.stringify(n.body));
      assert.equal(n.body.step, i + 1);
      const again = await p.client.post('/v1/me/placement/next');
      assert.equal(again.body.gameId, n.body.gameId, 'süren oyun tekrar döner');
      levels.push((await q('SELECT bot_level FROM games WHERE id = $1', [n.body.gameId]))[0].bot_level);
      await p.client.post(`/v1/games/${n.body.gameId}/resign`);
      await env.app.events.settle();
    }
    assert.deepEqual(levels, ['kolay', 'baslangic', 'baslangic', 'baslangic', 'baslangic']);
    const st = (await p.client.get('/v1/me/placement')).body;
    assert.equal(st.status, 'done');
    assert.equal(st.estimate, 600);
    const blitz = (await p.client.get('/v1/me/ratings')).body.ratings.find((r: any) => r.pool === 'blitz');
    assert.deepEqual([blitz.rating, blitz.provisional, blitz.games], [600, true, 0]);
    assert.equal((await p.client.post('/v1/me/placement/next')).body.code, 'PLACEMENT_DONE');
  });

  it('rated insan oyunu olan için gerekmez; tahminden hızlı yükselen incelemeye alınır', async () => {
    const vet = await newPlayer(env.base);
    await q(`INSERT INTO user_ratings (user_id, pool, rating, rd, volatility, peak, games) VALUES ($1, 'blitz', 1500, 80, 0.06, 1500, 12)`, [vet.id]);
    assert.equal((await vet.client.get('/v1/me/placement')).body.needed, false);
    assert.equal((await vet.client.post('/v1/me/placement/next')).body.code, 'PLACEMENT_NOT_NEEDED');

    const s = await newPlayer(env.base);
    const o = await newPlayer(env.base);
    await q(`INSERT INTO user_placement (user_id, status, step, level_idx, estimate, finished_at) VALUES ($1, 'done', 5, 0, 700, now())`, [s.id]);
    await q(`INSERT INTO user_ratings (user_id, pool, rating, rd, volatility, peak, games) VALUES ($1, 'blitz', 1200, 90, 0.06, 1200, 6)`, [s.id]);
    await env.app.pool.tx(async (tx) => {
      await env.app.placement.onGameEnded(
        { id: 1, topic: 'game.ended', payload: { gameId: '00000000-0000-0000-0000-000000000001', kind: 'casual', whiteId: s.id, blackId: o.id, rated: true, result: '1-0' } } as any,
        tx as any, { afterCommit: () => undefined },
      );
    });
    const c = await q(`SELECT level, source, reasons FROM fair_play_cases WHERE user_id = $1`, [s.id]);
    assert.equal(c.length, 1);
    assert.deepEqual([c[0].level, c[0].source], ['medium', 'rating_jump']);
    assert.match(c[0].reasons[0].reason, /tahmin 700/);
  });
});
