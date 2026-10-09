/**
 * Seviye belirleme (K47): yeni oyuncu bota karşı 5 kısa oyun oynar. Bot her oyunda oyuncunun
 * sonucuna göre güçlenir ya da zayıflar (kazanırsa bir seviye yukarı, kaybederse aşağı). Sonuçtan
 * bir performans puanı hesaplanır ve oyuncunun henüz oyunu olmayan insan havuzlarına GEÇİCİ
 * başlangıç rating'i olarak yazılır (yüksek belirsizlik: gerçek maçlarla hızla düzelir).
 *
 * Kum torbası (bilerek kötü oynayıp düşük puan alma) önlemi: seviye belirlemeden sonra ilk 20
 * maçında puanı tahmininin 350 üstüne çıkan oyuncu için adil oyun vakası açılır (insan inceler).
 * Seviye belirleme bir kez yapılır; insan rakiple rated oyunu olan oyuncu için gerekmez.
 */
import type { Connection, Pool } from '../../infra/db/pg.ts';
import { AppError, conflict } from '../../infra/errors.ts';
import type { OutboxEvent } from '../../infra/events/outbox.ts';
import type { WsHub } from '../../infra/ws/hub.ts';
import { BOT_LEVELS } from '../bot/levels.ts';
import type { BotService } from '../bot/service.ts';
import type { GameEnded } from './service.ts';

export const PLACEMENT_GAMES = 5;
export const PLACEMENT_TIME_CONTROL = '300+3';
const LADDER = ['baslangic', 'kolay', 'orta', 'ileri', 'usta', 'maksimum'];
const START_IDX = 1;
const PROVISIONAL_START_RD = 150;
const JUMP_LIMIT = 350;
const JUMP_WINDOW_GAMES = 20;
const HUMAN_POOLS = ['bullet', 'blitz', 'rapid', 'classical'];

interface Result {
  gameId: string;
  level: string;
  elo: number;
  score: number;
}

interface PlacementRow {
  user_id: string;
  status: 'active' | 'done';
  step: number;
  level_idx: number;
  current_game: string | null;
  results: Result[];
  estimate: number | null;
  jump_flagged: boolean;
}

/** Performans puanı: rakiplerin ortalaması + 400 × (galibiyet − mağlubiyet) / oyun. */
export function performanceEstimate(results: readonly { elo: number; score: number }[]): number {
  if (!results.length) return 1500;
  const avg = results.reduce((s, r) => s + r.elo, 0) / results.length;
  const net = results.reduce((s, r) => s + (r.score === 1 ? 1 : r.score === 0 ? -1 : 0), 0);
  return Math.round(Math.max(600, Math.min(2400, avg + (400 * net) / results.length)));
}

export function nextLevel(idx: number, score: number): number {
  if (score === 1) return Math.min(LADDER.length - 1, idx + 1);
  if (score === 0) return Math.max(0, idx - 1);
  return idx;
}

export class PlacementService {
  private readonly pool: Pool;
  private readonly bots: BotService;
  private readonly hub: WsHub;

  constructor(deps: { pool: Pool; bots: BotService; hub: WsHub }) {
    this.pool = deps.pool;
    this.bots = deps.bots;
    this.hub = deps.hub;
  }

  private async row(userId: string): Promise<PlacementRow | null> {
    const r = await this.pool.query<PlacementRow>('SELECT * FROM user_placement WHERE user_id = $1', [userId]);
    return r.rows[0] ?? null;
  }

  private async humanGames(userId: string): Promise<number> {
    const r = await this.pool.query<{ n: number }>(`SELECT COALESCE(sum(games), 0)::int AS n FROM user_ratings WHERE user_id = $1 AND pool <> 'bot'`, [userId]);
    return (r.rows[0] as { n: number }).n;
  }

  async status(userId: string) {
    const p = await this.row(userId);
    const needed = !p && (await this.humanGames(userId)) === 0;
    return {
      status: p ? p.status : 'none',
      needed,
      step: p?.step ?? 0,
      total: PLACEMENT_GAMES,
      estimate: p?.estimate ?? null,
      currentGameId: p?.status === 'active' ? p.current_game : null,
      nextLevel: p?.status === 'active' ? BOT_LEVELS.find((l) => l.id === LADDER[p.level_idx])?.name ?? null : null,
    };
  }

  /** Sıradaki seviye belirleme oyununu başlatır (ya da süreni döndürür). */
  async next(userId: string) {
    let p = await this.row(userId);
    if (p?.status === 'done') throw conflict('PLACEMENT_DONE', 'Seviye belirleme tamamlandı');
    if (!p) {
      if ((await this.humanGames(userId)) > 0) throw conflict('PLACEMENT_NOT_NEEDED', 'Rated oyunların olduğu için seviye belirleme gerekmiyor');
      await this.pool.query(`INSERT INTO user_placement (user_id, level_idx) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, START_IDX]);
      p = (await this.row(userId)) as PlacementRow;
    }
    if (p.current_game) {
      const g = await this.pool.query<{ status: string }>('SELECT status FROM games WHERE id = $1', [p.current_game]);
      if (g.rows[0] && g.rows[0].status !== 'finished' && g.rows[0].status !== 'aborted') return { gameId: p.current_game, step: p.step + 1, total: PLACEMENT_GAMES };
    }
    const level = LADDER[p.level_idx] as string;
    let game: { gameId: string };
    try {
      game = await this.bots.createGame(userId, { level, color: p.step % 2 === 0 ? 'white' : 'black', timeControl: PLACEMENT_TIME_CONTROL });
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw e;
    }
    await this.pool.query('UPDATE user_placement SET current_game = $2 WHERE user_id = $1', [userId, game.gameId]);
    return { gameId: game.gameId, step: p.step + 1, total: PLACEMENT_GAMES };
  }

  /** outbox: biten bot oyunu seviye belirleme oyunuysa kaydeder; 5. oyundan sonra tahmini yazar. */
  onGameEnded = async (event: OutboxEvent, tx: Connection, hooks: { afterCommit(fn: () => void): void }): Promise<void> => {
    const e = event.payload as unknown as GameEnded;
    if (e.kind === 'bot') return this.recordPlacementGame(e, tx, hooks);
    if (e.whiteId && e.blackId && e.rated) return this.watchJump(tx, [e.whiteId, e.blackId]);
  };

  private async recordPlacementGame(e: GameEnded, tx: Connection, hooks: { afterCommit(fn: () => void): void }) {
    const r = await tx.query<PlacementRow>('SELECT * FROM user_placement WHERE current_game = $1 FOR UPDATE', [e.gameId]);
    const p = r.rows[0];
    if (!p || p.status !== 'active') return;
    const humanWhite = e.botColor === 'b';
    const scoreWhite = e.result === '1-0' ? 1 : e.result === '0-1' ? 0 : 0.5;
    const score = humanWhite ? scoreWhite : 1 - scoreWhite;
    const level = LADDER[p.level_idx] as string;
    const elo = BOT_LEVELS.find((l) => l.id === level)?.elo ?? 1500;
    const results = [...p.results, { gameId: e.gameId, level, elo, score }];
    const step = p.step + 1;
    if (step >= PLACEMENT_GAMES) {
      const estimate = performanceEstimate(results);
      await tx.query(
        `UPDATE user_placement SET status = 'done', step = $2, results = $3, estimate = $4, current_game = NULL, finished_at = now() WHERE user_id = $1`,
        [p.user_id, step, JSON.stringify(results), estimate],
      );
      for (const pool of HUMAN_POOLS) {
        await tx.query(
          `INSERT INTO user_ratings (user_id, pool, rating, rd, volatility, peak) VALUES ($1, $2, $3, $4, 0.06, $3)
           ON CONFLICT (user_id, pool) DO UPDATE SET rating = EXCLUDED.rating, rd = EXCLUDED.rd, peak = EXCLUDED.peak, updated_at = now()
           WHERE user_ratings.games = 0`,
          [p.user_id, pool, estimate, PROVISIONAL_START_RD],
        );
      }
      hooks.afterCommit(() => this.hub.sendToUser(p.user_id, { type: 'placement.done', estimate }));
    } else {
      await tx.query(
        `UPDATE user_placement SET step = $2, results = $3, level_idx = $4, current_game = NULL WHERE user_id = $1`,
        [p.user_id, step, JSON.stringify(results), nextLevel(p.level_idx, score)],
      );
      hooks.afterCommit(() => this.hub.sendToUser(p.user_id, { type: 'placement.step', step, total: PLACEMENT_GAMES }));
    }
  }

  /** Kum torbası önlemi: tahminden hızlı yükselen oyuncu incelemeye alınır (bir kez). */
  private async watchJump(tx: Connection, userIds: string[]) {
    for (const uid of userIds) {
      const r = await tx.query<{ estimate: number; jump_flagged: boolean; rating: number; games: number }>(
        `SELECT p.estimate, p.jump_flagged, max(u.rating) AS rating, sum(u.games)::int AS games
         FROM user_placement p JOIN user_ratings u ON u.user_id = p.user_id AND u.pool <> 'bot'
         WHERE p.user_id = $1 AND p.status = 'done' GROUP BY p.estimate, p.jump_flagged`,
        [uid],
      );
      const x = r.rows[0];
      if (!x || x.jump_flagged || x.games > JUMP_WINDOW_GAMES || x.rating - x.estimate <= JUMP_LIMIT) continue;
      await tx.query('UPDATE user_placement SET jump_flagged = true WHERE user_id = $1', [uid]);
      await tx.query(
        `INSERT INTO fair_play_cases (user_id, level, max_score, reasons, source) VALUES ($1, 'medium', 0, $2, 'rating_jump')
         ON CONFLICT DO NOTHING`,
        [uid, JSON.stringify([{ reason: `seviye belirlemeden hızlı yükseliş: tahmin ${x.estimate}, ${x.games} maçta ${Math.round(x.rating)}` }])],
      );
    }
  }
}
