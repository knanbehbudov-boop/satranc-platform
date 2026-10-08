/**
 * Bölüm 9 — M4b analiz ve M10 temel adil oyun.
 *  - Saf: istatistikler ve açıklanabilir risk modeli.
 *  - Motor: MultiPV / searchmoves analizi (yerleşik motor, gerçek UCI süreci).
 *  - Uçtan uca: ücretli turnuva → oyunlar analiz kuyruğuna → risk → vaka → ödül kapısı;
 *    işaretli oyuncunun ödülü bekler, temiz oyuncununki serbest kalır; insan kararıyla
 *    ödül iptali FAIR_PLAY_RESERVE'e gider (K29).
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ChessGame, START_FEN } from '@satranc/chess-core';
import { UciEngine } from '../src/modules/bot/uci.ts';
import { computeRisk, expectedAcpl, levelOf, THRESHOLDS, WEIGHTS, type RiskInput } from '../src/modules/fairplay/risk.ts';
import { exclusionFor, pearson, summarize, type MoveAnalysis } from '../src/modules/fairplay/stats.ts';
import { Client, newPlayer, sleep, startTestApp, type TestEnv, uniqueName, WsClient } from './helpers.ts';
import { ScriptedPlayer } from './scripted-player.ts';

const OPERA = 'e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#'.split(' ');

describe('analiz istatistikleri (saf)', () => {
  const mv = (o: Partial<MoveAnalysis>): MoveAnalysis => ({
    ply: 30, color: 'w', uci: 'e2e4', san: 'e4', thinkMs: 3000, best: 'e2e4', bestCp: 20, playedCp: 20, rank: 1, loss: 0, legal: 30, reasonable: 1, excluded: null, ...o,
  });

  it('ACPL, top-1/top-3, hata sayıları; hariç tutulanlar sayılmaz', () => {
    const moves = [
      mv({ loss: 0, rank: 1 }), mv({ loss: 30, rank: 2 }), mv({ loss: 250, rank: null }), mv({ loss: 120, rank: 3 }),
      mv({ loss: 900, rank: null, excluded: 'opening' }), mv({ color: 'b', loss: 500 }),
    ];
    const s = summarize(moves, 'w');
    assert.equal(s.analysedMoves, 4);
    assert.equal(s.acpl, 100);
    assert.equal(s.top1, 0.25);
    assert.equal(s.top3, 0.75);
    assert.equal(s.blunders, 1);
    assert.equal(s.mistakes, 1);
  });

  it('açılış, zorunlu ve kararlaşmış pozisyonlar hariç tutulur', () => {
    assert.equal(exclusionFor(10, 30, 0, 20), 'opening');
    assert.equal(exclusionFor(30, 1, 0, 20), 'forced');
    assert.equal(exclusionFor(30, 20, 950, 20), 'decided');
    assert.equal(exclusionFor(30, 20, 50, 20), null);
  });

  it('pearson: doğrusal ilişki 1, sabit dizi null', () => {
    assert.equal(pearson([1, 2, 3, 4], [2, 4, 6, 8]), 1);
    assert.equal(pearson([1, 2, 3], [5, 5, 5]), null);
  });
});

describe('risk modeli (saf, açıklanabilir)', () => {
  const clean: RiskInput = {
    summary: { analysedMoves: 30, acpl: 55, top1: 0.45, top3: 0.75, blunders: 2, mistakes: 3, avgThinkMs: 8000, thinkCv: 0.9, complexMoves: 8, complexTop1: 0.4, timeComplexityCorr: 0.45 },
    rating: 1500, opponentRating: 1520, score: 1,
    focus: { hiddenOnMyTurn: 0, hiddenMsOnMyTurn: 0 },
    link: { sharedAccounts: 0, restrictedShared: 0 },
    behav: { accountAgeHours: 24 * 90, paidEntries: 20 },
    collusion: { shortResign: false, repeatPairings: 1 },
  };

  it('ağırlıklar toplamı 1 (doküman 14.3); eşikler sıralı', () => {
    assert.equal(Math.round(Object.values(WEIGHTS).reduce((s, w) => s + w, 0) * 1000), 1000);
    assert.ok(THRESHOLDS.medium < THRESHOLDS.high && THRESHOLDS.high < THRESHOLDS.critical);
    assert.equal(levelOf(0.29), 'low');
    assert.equal(levelOf(0.3), 'medium');
    assert.equal(levelOf(0.85), 'critical');
  });

  it('rating arttıkça beklenen ACPL azalır', () => {
    let prev = Infinity;
    for (const r of [600, 1000, 1400, 1800, 2200, 2600, 3000]) {
      const e = expectedAcpl(r);
      assert.ok(e <= prev);
      prev = e;
    }
  });

  it('normal insan profili düşük risk', () => {
    const r = computeRisk(clean);
    assert.equal(r.level, 'low', JSON.stringify(r));
  });

  it('motor profili + düzenli ritim + sekme değişimi + yeni hesap → yüksek risk, sebepleriyle', () => {
    const r = computeRisk({
      ...clean,
      summary: { analysedMoves: 30, acpl: 4, top1: 0.93, top3: 1, blunders: 0, mistakes: 0, avgThinkMs: 4000, thinkCv: 0.08, complexMoves: 10, complexTop1: 0.95, timeComplexityCorr: -0.05 },
      rating: 1300, opponentRating: 1900,
      focus: { hiddenOnMyTurn: 7, hiddenMsOnMyTurn: 70_000 },
      behav: { accountAgeHours: 5, paidEntries: 1 },
    });
    assert.ok(r.score >= THRESHOLDS.high, JSON.stringify(r));
    assert.ok(r.components.engine > 0.8);
    assert.ok(r.reasons.some((x) => x.includes('ACPL')));
    assert.ok(r.reasons.some((x) => x.includes('sekmeden çıktı')));
  });

  it('yetersiz veri motor bileşenini sıfırlar (kısa oyun tek başına suçlama değildir)', () => {
    const r = computeRisk({ ...clean, summary: { ...clean.summary!, analysedMoves: 3, acpl: 0, top1: 1 } });
    assert.equal(r.components.engine, 0);
    assert.ok(r.reasons.some((x) => x.includes('yetersiz veri')));
  });

  it('tek başına odak kaybı yüksek risk yaratmaz (doküman: tek başına delil değil)', () => {
    const r = computeRisk({ ...clean, focus: { hiddenOnMyTurn: 50, hiddenMsOnMyTurn: 600_000 } });
    assert.ok(r.score < THRESHOLDS.medium, JSON.stringify(r));
  });
});

describe('motor analizi (UCI MultiPV + searchmoves)', () => {
  let engine: UciEngine;
  before(async () => {
    engine = new UciEngine({ command: process.execPath, args: ['--disable-warning=ExperimentalWarning', join(import.meta.dirname, '../src/modules/bot/builtin-engine.ts')] });
    await engine.start();
  });
  after(() => engine.quit());

  it('MultiPV 3: matı ilk sırada mat puanıyla bulur', async () => {
    const lines = await engine.analyse('r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 2 3', { multiPv: 3, depth: 3 });
    assert.equal(lines.length, 3);
    assert.equal(lines[0]!.move, 'h5f7');
    assert.equal(lines[0]!.mate, 1);
    assert.ok(lines[0]!.cp > 9000);
    assert.ok(lines[1]!.cp <= lines[0]!.cp && lines[2]!.cp <= lines[1]!.cp);
  });

  it('searchmoves: yalnız istenen hamleyi puanlar', async () => {
    const lines = await engine.analyse(START_FEN, { multiPv: 1, depth: 2, searchmoves: ['g1h3'] });
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.move, 'g1h3');
  });
});

describe('uçtan uca: analiz kuyruğu, risk, vaka ve ödül kapısı', () => {
  let env: TestEnv;
  before(async () => {
    env = await startTestApp({
      firstMoveTimeoutMs: 20_000, paidMinRatedGames: 0, prizeHoldSec: 1, sandboxDeliveryDelayMs: 0, sandboxDuplicateRate: 0,
      analysisSkipPlies: 0, analysisDepth: 2, riskMediumExtraHoldSec: 1,
    });
    env.app.tournaments.firstGameDelayMs = 0;
  });
  after(async () => env.close());

  const q = <T = any>(sql: string, params: unknown[] = []) => env.app.pool.query<T>(sql, params).then((r) => r.rows);

  async function flush() {
    for (let i = 0; i < 200; i++) {
      await env.app.sandbox!.deliver();
      await env.app.payments.processRefunds();
      await env.app.events.settle();
      const p = await q<{ n: number }>(`SELECT count(*)::int AS n FROM psp_sandbox_events WHERE delivered_at IS NULL`);
      if (p[0]!.n === 0) return;
      await sleep(20);
    }
  }

  it('Opera Oyunu analizi: hamle başına ayrıntı, oyuncu özeti, mat hamlesi motorun ilk tercihi', async () => {
    const w = await newPlayer(env.base);
    const b = await newPlayer(env.base);
    const g = (await q<{ id: string }>(
      `INSERT INTO games (kind, white_id, black_id, time_control, white_initial_ms, black_initial_ms, increment_ms, paid, initial_fen, status, white_ms, black_ms, result, end_reason, winner_color, ended_at)
       VALUES ('casual', $1, $2, '300+0', 300000, 300000, 0, true, $3, 'finished', 100000, 100000, '1-0', 'mate', 'w', now()) RETURNING id`,
      [w.id, b.id, START_FEN],
    ))[0]!;
    const chess = new ChessGame();
    for (let i = 0; i < OPERA.length; i++) {
      const m = chess.move(OPERA[i]!);
      await q('INSERT INTO moves (game_id, ply, uci, san, think_ms, clock_ms) VALUES ($1, $2, $3, $4, $5, 100000)', [g.id, i + 1, m.uci, m.san, 1000 + ((i * 7919) % 5000)]);
    }
    assert.equal(await env.app.analysis.enqueue(env.app.pool, g.id, 'test', 5), true);
    while ((await q(`SELECT status FROM analysis_jobs WHERE game_id = $1`, [g.id]))[0].status !== 'done') {
      await env.app.analysis.workOnce();
      await sleep(20);
    }
    const r = await env.app.analysis.result(g.id);
    assert.ok(r);
    const sum = r.summary as any;
    assert.equal(sum.players.white.userId, w.id);
    assert.ok(sum.players.white.analysedMoves >= 8, JSON.stringify(sum.players.white));
    // Not: yerleşik motor sığdır; Morphy'nin taş fedalarını (Nxb5, Rxd7) hata sayar. Bu yüzden
    // üretimde hile analizi Stockfish ile yapılır (K33: üretimde STOCKFISH_PATH zorunlu).
    assert.ok(typeof sum.players.white.acpl === 'number' && typeof sum.players.black.top1 === 'number');
    assert.equal(sum.depth, 2);
    const moves = r.moves as MoveAnalysis[];
    assert.equal(moves.length, OPERA.length);
    assert.equal(moves.at(-1)!.san, 'Rd8#');
    assert.equal(moves.at(-1)!.rank, 1, 'mat hamlesi motorun ilk tercihi');
    assert.equal(moves.at(-1)!.loss, 0);
    assert.equal(moves.at(-3)!.san, 'Qb8+');
    assert.ok(moves.every((m) => m.loss >= 0 && m.loss <= 1000 && m.legal >= 1));
    // Risk skoru olay ile hesaplandı (turnuva dışı oyun: vaka açılabilir ama turnuvaya bağlı değil).
    await env.app.events.settle();
    const rs = await q('SELECT user_id, score, level, reasons FROM risk_scores WHERE game_id = $1', [g.id]);
    assert.equal(rs.length, 2);
  });

  it('odak telemetrisi: yalnız kendi canlı oyununda, sunucu zamanıyla; sırası gelmişken çıkışlar sayılır', async () => {
    const p = await newPlayer(env.base);
    const other = await newPlayer(env.base);
    const g = await p.client.post('/v1/bots/games', { level: 'baslangic', color: 'white', timeControl: '300+3' });
    const gameId = g.body.gameId;
    const ws = await WsClient.open(env.base, p.client.token);
    ws.send({ type: 'game.join', gameId });
    await ws.next((m) => m.type === 'game.state');
    ws.send({ type: 'game.focus', gameId, hidden: true });
    await sleep(150);
    ws.send({ type: 'game.focus', gameId, hidden: false });
    await sleep(100);
    // Başkasının oyunu için gönderilen telemetri yok sayılır.
    const ws2 = await WsClient.open(env.base, other.client.token);
    ws2.send({ type: 'game.focus', gameId, hidden: true });
    await sleep(100);
    const st = await env.app.fairplay.focusStats(env.app.pool, gameId, p.id);
    assert.equal(st.hiddenOnMyTurn, 1);
    assert.ok(st.hiddenMsOnMyTurn >= 100, String(st.hiddenMsOnMyTurn));
    assert.equal((await q('SELECT 1 FROM focus_events WHERE user_id = $1', [other.id])).length, 0);
    await p.client.post(`/v1/games/${gameId}/resign`);
    ws.close();
    ws2.close();
    await env.app.events.settle();
    assert.equal((await q('SELECT 1 FROM analysis_jobs WHERE game_id = $1', [gameId])).length, 0, 'bot oyunu analiz edilmez');
  });

  it('ücretli turnuva: oyunlar analiz edilmeden ödül serbest kalmaz; işaretli şampiyon bekler, temiz ikinci serbest; iptal kararı rezerve', async () => {
    const code = uniqueName('fp').toLowerCase();
    await q(`INSERT INTO tournament_templates (code, name, kind, capacity, entry_fee_cents, currency, rake_bps, time_control, ready_seconds, break_seconds)
             VALUES ($1, $1, 'sng', 4, 1000, 'USD', 1200, '180+2', 10, 0)`, [code]);
    await env.app.tournaments.ensureOpen();
    const tid = (await q<{ id: string }>(`SELECT t.id FROM tournaments t JOIN tournament_templates p ON p.id = t.template_id WHERE p.code = $1 AND t.status = 'OPEN'`, [code]))[0]!.id;

    // Analiz işçisini durdur: kapı "bekle" demeli.
    env.app.analysis.stop();
    const strength = new Map<string, number>();
    const players: ScriptedPlayer[] = [];
    for (let i = 0; i < 4; i++) {
      const p = await ScriptedPlayer.create(env.base, (g) => ((strength.get(p.id) ?? 0) > (strength.get(g.opponentId) ?? 0) ? 'win' : 'lose'));
      strength.set(p.id, i);
      players.push(p);
      const j = await p.client.post(`/v1/tournaments/${tid}/join`);
      const u = new URL(j.body.checkoutUrl, env.base);
      await new Client(env.base).post(`/sandbox-psp/v1/checkout/${u.pathname.split('/').pop()}/pay`, { secret: u.searchParams.get('secret'), card: '4242424242424242', exp: '12/39', cvc: '123' });
    }
    const champ = players[3]!;
    let d: any;
    for (let i = 0; i < 300; i++) {
      await flush();
      d = await env.app.tournaments.detail(tid);
      if (d.status === 'SETTLING' && d.awards.length) break;
      await sleep(100);
    }
    assert.equal(d.status, 'SETTLING');
    await sleep(1200); // bekletme süresi (1 sn) doldu
    await env.app.tournaments.releaseDuePrizes();
    d = await env.app.tournaments.detail(tid);
    assert.ok(d.awards.every((a: any) => a.status === 'PENDING'), 'analiz bitmeden ödül serbest kalmaz');
    const jobs = await q(`SELECT j.status FROM analysis_jobs j JOIN games g ON g.id = j.game_id JOIN matches m ON m.id = g.match_id WHERE m.tournament_id = $1`, [tid]);
    assert.ok(jobs.length >= 4 && jobs.every((j) => j.status === 'queued'), JSON.stringify(jobs));

    // Analizler biter; şampiyonun final oyunu için motor profili + sekme kaybı (sentetik kanıt).
    while (await env.app.analysis.workOnce()) { /* kuyruk boşalana kadar */ }
    await env.app.events.settle();
    const finalGame = (await q<{ id: string }>(
      `SELECT g.id FROM games g JOIN matches m ON m.id = g.match_id WHERE m.tournament_id = $1 AND m.round_no = 2 ORDER BY g.game_no LIMIT 1`, [tid]))[0]!.id;
    const engineLike = { analysedMoves: 30, acpl: 3, top1: 0.95, top3: 1, blunders: 0, mistakes: 0, avgThinkMs: 3000, thinkCv: 0.05, complexMoves: 12, complexTop1: 1, timeComplexityCorr: -0.1 };
    const col = (await q<{ white_id: string }>('SELECT white_id FROM games WHERE id = $1', [finalGame]))[0]!.white_id === champ.id ? 'white' : 'black';
    await q(`UPDATE analysis_results SET summary = jsonb_set(summary, $2, (summary #> $2) || $3::jsonb) WHERE game_id = $1`, [finalGame, `{players,${col}}`, JSON.stringify(engineLike)]);
    await q(`INSERT INTO focus_events (game_id, user_id, hidden, my_turn, ply, at) SELECT $1, $2, h, true, 10, now() + (i || ' seconds')::interval
             FROM (VALUES (true, 0), (false, 20), (true, 30), (false, 50), (true, 60), (false, 90)) v(h, i)`, [finalGame, champ.id]);
    const risk = await env.app.pool.tx((tx) => env.app.fairplay.scoreGame(tx, finalGame));
    assert.ok(risk[champ.id]!.score >= THRESHOLDS.high, JSON.stringify(risk[champ.id]));
    const cases = await q(`SELECT id, level, status, reasons FROM fair_play_cases WHERE user_id = $1 AND tournament_id = $2`, [champ.id, tid]);
    assert.equal(cases.length, 1);
    assert.ok(['high', 'critical'].includes(cases[0].level));
    if (cases[0].level === 'critical') {
      assert.equal((await q('SELECT status FROM users WHERE id = $1', [champ.id]))[0].status, 'frozen', 'kritik: hesap geçici dondurulur');
    }

    await env.app.tournaments.releaseDuePrizes();
    d = await env.app.tournaments.detail(tid);
    assert.equal(d.status, 'DISPUTED');
    const by = new Map(d.awards.map((a: any) => [a.id, a.status]));
    // Finalde şampiyona kaybeden (eşleşme kurası rastgele olduğundan ödül tablosundan okunur).
    const runnerUp = { id: d.awards.find((a: any) => a.rank === 2).id as string };
    assert.equal(by.get(champ.id), 'PENDING', 'işaretli şampiyonun ödülü incelemede');
    assert.equal(by.get(runnerUp.id), 'RELEASED', 'temiz oyuncunun ödülü beklemez');

    // İnsan kararı: ihlal doğrulandı → ödül iptal → FAIR_PLAY_RESERVE (K29).
    const champCents = d.awards.find((a: any) => a.id === champ.id).cents;
    await env.app.pool.tx(async (tx) => {
      const notes: (() => void)[] = [];
      await env.app.fairplay.closeCase(tx, cases[0].id, 'confirm', runnerUp.id, 'test kararı');
      await env.app.tournaments.voidAward(tx, tid, champ.id, cases[0].id, notes);
    });
    d = await env.app.tournaments.detail(tid);
    assert.equal(d.status, 'SETTLED');
    assert.equal(d.awards.find((a: any) => a.id === champ.id).status, 'VOID');
    assert.equal(await env.app.ledger.balance(env.app.pool, 'FAIR_PLAY_RESERVE:USD'), champCents);
    assert.equal(await env.app.ledger.balance(env.app.pool, `USER_PRIZE_PENDING:${champ.id}:USD`), 0);
    const inv = await env.app.ledger.invariants();
    assert.ok(inv.balanced && inv.negativeUserBalances === 0);
    for (const p of players) p.close();
    env.app.analysis.start();
  });
});
