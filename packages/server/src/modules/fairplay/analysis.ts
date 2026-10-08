/**
 * M4b Analiz işçisi (doküman 12.4): biten ücretli oyunlar kuyruğa girer; işçi her pozisyonu
 * sabit derinlikte MultiPV 3 ile analiz eder, oynanan hamle ilk 3'te değilse yalnız o
 * hamleyi (searchmoves) ayrıca puanlar. Sonuç analysis_results'a yazılır ve
 * 'analysis.completed' olayı yayınlanır (risk modeli tüketir).
 *
 * Kuyruk PostgreSQL tablosudur (FOR UPDATE SKIP LOCKED): çok düğümde güvenle paylaşılır;
 * çöken işçinin işi kilit süresi dolunca başka işçiye geçer.
 */
import { join } from 'node:path';
import { ChessGame } from '@satranc/chess-core';
import type { Config } from '../../config.ts';
import type { Connection, Pool, Queryable } from '../../infra/db/pg.ts';
import { publish, type OutboxEvent } from '../../infra/events/outbox.ts';
import type { Logger } from '../../infra/log.ts';
import { EnginePool, type EngineCommand } from '../bot/uci.ts';
import { exclusionFor, LOSS_CAP, summarize, type MoveAnalysis } from './stats.ts';

const BUILTIN = join(import.meta.dirname, '..', 'bot', 'builtin-engine.ts');
const MULTI_PV = 3;
const MAX_ATTEMPTS = 3;

export class AnalysisService {
  private readonly pool: Pool;
  private readonly cfg: Config;
  private readonly logger: Logger;
  private readonly engines: EnginePool;
  private timer: NodeJS.Timeout | null = null;
  private running = 0;
  engineName = '';

  constructor(deps: { pool: Pool; cfg: Config; logger: Logger }) {
    this.pool = deps.pool;
    this.cfg = deps.cfg;
    this.logger = deps.logger;
    const cmd: EngineCommand = deps.cfg.stockfishPath
      ? { command: deps.cfg.stockfishPath, args: [] }
      : { command: process.execPath, args: ['--disable-warning=ExperimentalWarning', BUILTIN] };
    this.engines = new EnginePool(cmd, Math.max(1, deps.cfg.analysisWorkers));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.pump(), 300);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.engines.close();
  }

  /** Oyun bitti → ücretli oyunsa (ya da ayar açıksa ücretsiz turnuva oyunu) kuyruğa. */
  onGameEnded = async (event: OutboxEvent, tx: Connection): Promise<void> => {
    const e = event.payload as { gameId: string; kind: string; plies?: number };
    if (e.kind === 'bot') return;
    const g = await tx.query<{ paid: boolean }>('SELECT paid FROM games WHERE id = $1', [e.gameId]);
    const paid = g.rows[0]?.paid ?? false;
    if (!paid && !(this.cfg.analyzeFreeGames && e.kind === 'tournament')) return;
    await this.enqueue(tx, e.gameId, 'system', paid ? 1 : 0);
  };

  async enqueue(q: Queryable, gameId: string, by: string, priority = 0): Promise<boolean> {
    const r = await q.query(
      `INSERT INTO analysis_jobs (game_id, priority, requested_by) VALUES ($1, $2, $3)
       ON CONFLICT (game_id) DO UPDATE SET status = 'queued', attempts = 0, error = NULL, priority = GREATEST(analysis_jobs.priority, EXCLUDED.priority)
         WHERE analysis_jobs.status = 'failed' OR EXCLUDED.requested_by <> 'system'
       RETURNING game_id`,
      [gameId, priority, by],
    );
    return (r.rowCount ?? 0) > 0;
  }

  private pump(): void {
    while (this.running < Math.max(1, this.cfg.analysisWorkers)) {
      this.running++;
      void this.workOnce()
        .catch((e) => this.logger.error('Analiz işçisi hatası', { error: e }))
        .finally(() => {
          this.running--;
        });
      break; // her tikte en fazla bir yeni iş
    }
  }

  /** Kuyruktan bir iş alıp işler. Testler doğrudan çağırabilir. Dönen: işlenen oyun ya da null. */
  async workOnce(): Promise<string | null> {
    const claimed = await this.pool.query<{ game_id: string; attempts: number }>(
      `UPDATE analysis_jobs SET status = 'running', attempts = attempts + 1, started_at = now(), locked_until = now() + interval '10 minutes'
       WHERE game_id = (
         SELECT game_id FROM analysis_jobs
         WHERE status = 'queued' OR (status = 'running' AND locked_until < now())
         ORDER BY priority DESC, created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING game_id, attempts`,
    );
    const job = claimed.rows[0];
    if (!job) return null;
    try {
      const result = await this.analyseGame(job.game_id);
      await this.pool.tx(async (tx) => {
        await tx.query(
          `INSERT INTO analysis_results (game_id, engine, depth, multipv, summary, moves) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (game_id) DO UPDATE SET engine = EXCLUDED.engine, depth = EXCLUDED.depth, multipv = EXCLUDED.multipv,
             summary = EXCLUDED.summary, moves = EXCLUDED.moves, created_at = now()`,
          [job.game_id, result.engine, result.depth, MULTI_PV, result.summary, JSON.stringify(result.moves)],
        );
        await tx.query(`UPDATE analysis_jobs SET status = 'done', finished_at = now(), error = NULL WHERE game_id = $1`, [job.game_id]);
        await publish(tx, 'analysis.completed', { gameId: job.game_id });
      });
      return job.game_id;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const final = job.attempts >= MAX_ATTEMPTS;
      this.logger.warn('Oyun analizi başarısız', { gameId: job.game_id, attempts: job.attempts, final, error: msg });
      await this.pool.query(
        `UPDATE analysis_jobs SET status = $2, error = $3, locked_until = NULL, finished_at = CASE WHEN $2 = 'failed' THEN now() END WHERE game_id = $1`,
        [job.game_id, final ? 'failed' : 'queued', msg.slice(0, 500)],
      );
      if (final) await publish(this.pool, 'analysis.failed', { gameId: job.game_id, error: msg.slice(0, 200) });
      return null;
    }
  }

  /** Kuyruk boşalana kadar işler (testler ve yönetim için). */
  async drain(max = 100): Promise<number> {
    let n = 0;
    while (n < max && (await this.workOnce())) n++;
    return n;
  }

  async analyseGame(gameId: string): Promise<{ engine: string; depth: number; summary: Record<string, unknown>; moves: MoveAnalysis[] }> {
    const g = await this.pool.query<{ initial_fen: string; white_id: string | null; black_id: string | null; status: string }>(
      'SELECT initial_fen, white_id, black_id, status FROM games WHERE id = $1',
      [gameId],
    );
    const row = g.rows[0];
    if (!row) throw new Error('Oyun bulunamadı');
    const mv = await this.pool.query<{ ply: number; uci: string; san: string; think_ms: number }>(
      'SELECT ply, uci, san, think_ms FROM moves WHERE game_id = $1 ORDER BY ply',
      [gameId],
    );
    const engine = await this.engines.get();
    this.engineName = engine.name;
    const depth = this.cfg.analysisDepth;
    const go = { depth, movetimeMs: this.cfg.analysisMovetimeMs };
    const chess = new ChessGame({ fen: row.initial_fen });
    const out: MoveAnalysis[] = [];
    for (const m of mv.rows) {
      const fen = chess.fen();
      const color = chess.turn;
      const legal = chess.moves().length;
      const lines = await engine.analyse(fen, { multiPv: MULTI_PV, ...go });
      const top = lines[0];
      if (!top) break; // oyun bitmiş pozisyon
      let played = lines.find((l) => l.move === m.uci);
      let rank: number | null = played ? played.rank : null;
      if (!played) {
        const only = await engine.analyse(fen, { multiPv: 1, ...go, searchmoves: [m.uci] });
        played = only[0];
        rank = null;
      }
      const playedCp = played ? played.cp : top.cp;
      // MultiPV'deki eşit puanlı hamleler de "ilk tercih" sayılır (motorun kararsız kaldığı durum).
      if (rank !== null && rank > 1 && playedCp >= top.cp) rank = 1;
      const loss = Math.min(LOSS_CAP, Math.max(0, top.cp - playedCp));
      out.push({
        ply: m.ply,
        color,
        uci: m.uci,
        san: m.san,
        thinkMs: m.think_ms,
        best: top.move,
        bestCp: top.cp,
        playedCp,
        rank,
        loss,
        legal,
        reasonable: lines.filter((l) => top.cp - l.cp <= 60).length,
        excluded: exclusionFor(m.ply, legal, top.cp, this.cfg.analysisSkipPlies),
      });
      chess.move(m.uci);
    }
    const summary = {
      gameId,
      engine: engine.name || 'bilinmiyor',
      depth,
      multiPv: MULTI_PV,
      skipPlies: this.cfg.analysisSkipPlies,
      players: {
        white: { userId: row.white_id, ...summarize(out, 'w') },
        black: { userId: row.black_id, ...summarize(out, 'b') },
      },
    };
    return { engine: engine.name || 'bilinmiyor', depth, summary, moves: out };
  }

  async result(gameId: string) {
    const r = await this.pool.query<{ engine: string; depth: number; summary: unknown; moves: unknown; created_at: Date }>(
      'SELECT engine, depth, summary, moves, created_at FROM analysis_results WHERE game_id = $1',
      [gameId],
    );
    return r.rows[0] ?? null;
  }

  async queueStats() {
    const r = await this.pool.query<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM analysis_jobs GROUP BY status');
    return Object.fromEntries(r.rows.map((x) => [x.status, x.n]));
  }
}
