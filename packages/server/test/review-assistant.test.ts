/**
 * K45 — oyun sonu analizi (oyuncu yüzü), şikayet ve satranç asistanı.
 * Asistanın yapay zekâ sağlayıcısı testte sahte bir sağlayıcıyla değiştirilir.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ChessGame, START_FEN } from '@satranc/chess-core';
import type { AssistantProvider, ChatMessage, ContentBlock } from '../src/modules/assistant/service.ts';
import { buildReview, classify, moveAccuracy, winPercent } from '../src/modules/review/service.ts';
import { newPlayer, sleep, startTestApp, type TestEnv } from './helpers.ts';

const OPERA = 'e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#'.split(' ');

describe('K45 analiz matematiği', () => {
  it('kazanma yüzdesi ve hamle doğruluğu', () => {
    assert.equal(Math.round(winPercent(0)), 50);
    assert.ok(winPercent(500) > 80 && winPercent(-500) < 20);
    assert.equal(Math.round(moveAccuracy(100, 100)), 100, 'en iyi hamle %100');
    assert.ok(moveAccuracy(300, -300) < 20, 'büyük kayıp düşük doğruluk');
  });

  it('hamle sınıfları', () => {
    assert.equal(classify({ rank: 1, bestCp: 50, playedCp: 50, loss: 0 }), 'best');
    assert.equal(classify({ rank: 2, bestCp: 50, playedCp: 30, loss: 20 }), 'good');
    assert.equal(classify({ rank: null, bestCp: 0, playedCp: -120, loss: 120 }), 'inaccuracy');
    assert.equal(classify({ rank: null, bestCp: 0, playedCp: -250, loss: 250 }), 'mistake');
    assert.equal(classify({ rank: null, bestCp: 0, playedCp: -600, loss: 600 }), 'blunder');
  });

  it('özet: sayımlar hamle sayısına eşit; daha iyi hamle SAN olarak verilir', () => {
    const moves = [
      { ply: 1, color: 'w' as const, uci: 'e2e4', san: 'e4', thinkMs: 1, best: 'e2e4', bestCp: 30, playedCp: 30, rank: 1, loss: 0, legal: 20, reasonable: 3, excluded: null },
      { ply: 2, color: 'b' as const, uci: 'f7f6', san: 'f6', thinkMs: 1, best: 'e7e5', bestCp: -30, playedCp: -600, rank: null, loss: 570, legal: 20, reasonable: 3, excluded: null },
    ];
    const r = buildReview('g', START_FEN, 'w', 'b', moves);
    assert.equal(r.players.white.counts.best, 1);
    assert.equal(r.players.black.counts.blunder, 1);
    assert.equal(r.moves[1]!.bestSan, 'e5');
    assert.deepEqual(r.evalGraph, [30, 600]);
  });
});

/** Sahte sağlayıcı: senaryoya göre cevap verir, gönderilen istemleri kaydeder. */
class FakeProvider implements AssistantProvider {
  calls: { system: string; messages: ChatMessage[]; tools: string[] }[] = [];
  script: ((req: { system: string; messages: ChatMessage[] }) => { content: ContentBlock[]; stopReason: string })[] = [];
  async complete(req: { system: string; messages: ChatMessage[]; tools: { name: string }[]; maxTokens: number }) {
    this.calls.push({ system: req.system, messages: JSON.parse(JSON.stringify(req.messages)), tools: req.tools.map((t) => t.name) });
    const step = this.script.shift();
    if (step) return step(req);
    return { content: [{ type: 'text' as const, text: 'Merhaba, nasıl yardımcı olabilirim?' }], stopReason: 'end_turn' };
  }
}

describe('K45 uçtan uca', () => {
  let env: TestEnv;
  const fake = new FakeProvider();
  before(async () => {
    env = await startTestApp({ analysisSkipPlies: 0, analysisDepth: 2, paidMinRatedGames: 0 });
    env.app.assistant.provider = fake;
  });
  after(async () => env.close());
  const q = <T = any>(sql: string, params: unknown[] = []) => env.app.pool.query<T>(sql, params).then((r) => r.rows);

  async function finishedGame(w: string, b: string, kind = 'casual'): Promise<string> {
    const g = (await q<{ id: string }>(
      `INSERT INTO games (kind, white_id, black_id, time_control, white_initial_ms, black_initial_ms, increment_ms, paid, initial_fen, status, white_ms, black_ms, result, end_reason, winner_color, ended_at)
       VALUES ($4, $1, $2, '300+0', 300000, 300000, 0, false, $3, 'finished', 100000, 100000, '1-0', 'mate', 'w', now()) RETURNING id`,
      [w, b, START_FEN, kind],
    ))[0]!;
    const chess = new ChessGame();
    for (let i = 0; i < OPERA.length; i++) {
      const m = chess.move(OPERA[i]!);
      await q('INSERT INTO moves (game_id, ply, uci, san, think_ms, clock_ms) VALUES ($1, $2, $3, $4, 1500, 100000)', [g.id, i + 1, m.uci, m.san]);
    }
    return g.id;
  }

  async function drain(gameId: string) {
    for (let i = 0; i < 500; i++) {
      const j = (await q(`SELECT status FROM analysis_jobs WHERE game_id = $1`, [gameId]))[0];
      if (j?.status === 'done') return;
      await env.app.analysis.workOnce();
      await sleep(20);
    }
    throw new Error('analiz bitmedi');
  }

  it('oyuncu analizi: istek → kuyruk → hazır; doğruluk ve sınıflar; motor adı ve hile göstergeleri yok', async () => {
    const w = await newPlayer(env.base);
    const b = await newPlayer(env.base);
    const other = await newPlayer(env.base);
    const gameId = await finishedGame(w.id, b.id);
    assert.equal((await w.client.get(`/v1/games/${gameId}/review`)).body.status, 'none');
    assert.equal((await other.client.get(`/v1/games/${gameId}/review`)).status, 403, 'yalnız oynayanlar');
    assert.equal((await w.client.post(`/v1/games/${gameId}/review`)).body.status, 'queued');
    await drain(gameId);
    const r = await b.client.get(`/v1/games/${gameId}/review`);
    assert.equal(r.body.status, 'ready');
    const white = r.body.players.white;
    assert.equal(white.userId, w.id);
    assert.ok(white.accuracy >= 0 && white.accuracy <= 100);
    const sum = (c: Record<string, number>) => Object.values(c).reduce((s, x) => s + x, 0);
    assert.equal(sum(white.counts) + sum(r.body.players.black.counts), OPERA.length);
    assert.equal(r.body.moves.length, OPERA.length);
    assert.equal(r.body.evalGraph.length, OPERA.length);
    const json = JSON.stringify(r.body).toLowerCase();
    for (const banned of ['engine', 'stockfish', 'top1', 'thinkcv', 'acpl', 'builtin']) assert.ok(!json.includes(banned), `yanıtta "${banned}" olmamalı`);
  });

  it('şikayet: yalnız oyuncu, oyun başına bir kez; vaka "orta" seviyede açılır ve oyun analize alınır', async () => {
    const w = await newPlayer(env.base);
    const b = await newPlayer(env.base);
    const outsider = await newPlayer(env.base);
    const gameId = await finishedGame(w.id, b.id);
    assert.equal((await outsider.client.post(`/v1/games/${gameId}/report`, { category: 'cheating', text: 'çok hızlı oynadı' })).status, 403);
    const r = await b.client.post(`/v1/games/${gameId}/report`, { category: 'cheating', text: 'Her hamlesi motor gibiydi' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const c = (await q('SELECT user_id, level, source, status, reasons FROM fair_play_cases WHERE id = $1', [r.body.caseId]))[0];
    assert.deepEqual([c.user_id, c.level, c.source, c.status], [w.id, 'medium', 'player_report', 'OPEN']);
    assert.match(c.reasons[0].reason, /oyuncu şikayeti \(hile şüphesi\): Her hamlesi motor gibiydi/);
    assert.equal((await q('SELECT 1 FROM analysis_jobs WHERE game_id = $1', [gameId])).length, 1, 'şikayet edilen oyun analize alındı');
    assert.equal((await b.client.post(`/v1/games/${gameId}/report`, { category: 'cheating', text: 'tekrar' })).body.code, 'ALREADY_REPORTED');
    // Aynı oyuncu için ikinci şikayet açık vakaya eklenir.
    const third = await newPlayer(env.base);
    const g2 = await finishedGame(w.id, third.id);
    const r2 = await third.client.post(`/v1/games/${g2}/report`, { category: 'abuse', text: 'Sohbette hakaret etti' });
    assert.equal(r2.body.caseId, r.body.caseId);
    assert.equal((await q('SELECT jsonb_array_length(reasons) AS n FROM fair_play_cases WHERE id = $1', [r.body.caseId]))[0].n, 2);
  });

  it('asistan: kapalıyken açıkça söylenir; destek modunda şikayeti araçla iletir; günlük sınır', async () => {
    const w = await newPlayer(env.base);
    const b = await newPlayer(env.base);
    const gameId = await finishedGame(w.id, b.id);

    env.app.assistant.provider = null;
    assert.equal((await b.client.get('/v1/assistant')).body.enabled, false);
    assert.equal((await b.client.post('/v1/assistant/messages', { text: 'merhaba' })).body.code, 'ASSISTANT_DISABLED');
    env.app.assistant.provider = fake;

    fake.calls = [];
    fake.script = [
      () => ({ content: [{ type: 'tool_use', id: 't1', name: 'list_recent_games', input: {} }], stopReason: 'tool_use' }),
      (req) => {
        const last = req.messages.at(-1)!.content as ContentBlock[];
        const listing = (last[0] as { content: string }).content;
        assert.ok(listing.includes(gameId), 'araç sonucu oyunu listeledi');
        return { content: [{ type: 'tool_use', id: 't2', name: 'file_complaint', input: { game_id: gameId, category: 'cheating', description: 'Rakip hamle başına hep aynı sürede oynadı' } }], stopReason: 'tool_use' };
      },
      () => ({ content: [{ type: 'text', text: 'Şikayetini ilettim; inceleme ekibi değerlendirecek.' }], stopReason: 'end_turn' }),
    ];
    const r = await b.client.post('/v1/assistant/messages', { text: 'Son oyunumdaki rakibimi şikayet etmek istiyorum, hile yaptı bence' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.mode, 'support');
    assert.match(r.body.reply, /ilettim/);
    assert.equal(r.body.actions[0].type, 'complaint');
    const comp = (await q('SELECT via, reported_id FROM complaints WHERE id = $1', [r.body.actions[0].complaintId]))[0];
    assert.deepEqual([comp.via, comp.reported_id], ['assistant', w.id]);
    const sys = fake.calls[0]!.system;
    assert.match(sys, /Satranç Asistanı/);
    assert.ok(!/stockfish/i.test(sys), 'istemde motor adı yok');
    assert.deepEqual(fake.calls[0]!.tools, ['list_recent_games', 'file_complaint']);

    env.app.cfg.assistantDailyFree = 2;
    try {
      assert.equal((await b.client.post('/v1/assistant/messages', { text: 'kurallar neler?' })).status, 200);
      const over = await b.client.post('/v1/assistant/messages', { text: 'bir soru daha' });
      assert.equal(over.body.code, 'ASSISTANT_LIMIT');
      assert.equal((await b.client.get('/v1/assistant')).body.remainingToday, 0);
    } finally {
      env.app.cfg.assistantDailyFree = 5;
    }
  });

  it('koç: yalnız kendi bitmiş oyununda; oyun bağlamı istemde; canlı oyun sırasında asistan kilitli', async () => {
    const w = await newPlayer(env.base);
    const b = await newPlayer(env.base);
    const gameId = await finishedGame(w.id, b.id);
    await w.client.post(`/v1/games/${gameId}/review`);
    await drain(gameId);
    fake.calls = [];
    fake.script = [() => ({ content: [{ type: 'text', text: '17. hamlede ...' }], stopReason: 'end_turn' })];
    const r = await w.client.post('/v1/assistant/messages', { text: 'Bu oyunda nerede hata yaptım?', gameId });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.mode, 'coach');
    const sys = fake.calls[0]!.system;
    assert.match(sys, /KOÇLUK/);
    assert.match(sys, /Doğruluk: beyaz %/);
    assert.match(sys, /Rd8#/);
    assert.deepEqual(fake.calls[0]!.tools, [], 'koç modunda araç yok');

    const stranger = await newPlayer(env.base);
    assert.equal((await stranger.client.post('/v1/assistant/messages', { text: 'analiz et', gameId })).status, 403);

    const live = await w.client.post('/v1/bots/games', { level: 'baslangic', color: 'white', timeControl: '300+3' });
    assert.equal(live.status, 201, JSON.stringify(live.body));
    const locked = await w.client.post('/v1/assistant/messages', { text: 'bu pozisyonda ne oynamalıyım?' });
    assert.equal(locked.body.code, 'ASSISTANT_LOCKED');
    assert.equal((await w.client.get('/v1/assistant')).body.locked, 'LIVE_GAME');
    await w.client.post(`/v1/games/${live.body.gameId}/resign`);
  });
});
