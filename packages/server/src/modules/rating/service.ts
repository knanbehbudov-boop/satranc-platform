/**
 * M6 Rating: oyun bitince (outbox 'game.ended') Glicko-2 ile güncellenir.
 *
 * Havuzlar: insan rakipli oyunlar zaman kategorisine göre (bullet/blitz/rapid/klasik);
 * bot oyunları ayrı "bot" havuzunda (doküman 13.2: botla rating şişirilmez).
 * Kararlar:
 *  - K20: 2 yarım hamleden kısa oyunlar (gelmeme, ilk hamle süresi) rating'e işlenmez.
 *  - K21: Armageddon oyunları yarım ağırlıkla işlenir (puan değişimi ½), doküman 13.4.
 */
import { categorize, parseTimeControl, type TimeCategory } from '@satranc/chess-core';
import type { Connection, Pool } from '../../infra/db/pg.ts';
import type { OutboxEvent } from '../../infra/events/outbox.ts';
import { DEFAULT_RATING, update, type Glicko } from './glicko2.ts';
import { BOT_LEVELS } from '../bot/levels.ts';

export type Pool_ = TimeCategory | 'bot';

export interface RatingView {
  pool: Pool_;
  rating: number;
  rd: number;
  games: number;
  peak: number;
  provisional: boolean;
}

interface Row {
  user_id: string;
  pool: string;
  rating: number;
  rd: number;
  volatility: number;
  games: number;
  peak: number;
}

export interface GameEnded {
  gameId: string;
  kind: string;
  result: '1-0' | '0-1' | '1/2-1/2';
  whiteId: string | null;
  blackId: string | null;
  botLevel: string | null;
  botColor: 'w' | 'b' | null;
  timeControl: string;
  armageddon: boolean;
  rated: boolean;
  plies: number;
}

/** Bu RD'nin üstündeki rating "geçici" (kalibre olmamış) gösterilir. */
const PROVISIONAL_RD = 110;
const ARMAGEDDON_WEIGHT = 0.5;
const BOT_RD = 60;

export function poolFor(timeControl: string): TimeCategory {
  const tc = parseTimeControl(timeControl);
  return categorize(tc.initialMs / 1000, tc.incrementMs / 1000);
}

export class RatingService {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** outbox tüketicisi: olay işleyiciyle aynı işlemde çalışır (bir kez işlenir). */
  onGameEnded = async (event: OutboxEvent, tx: Connection): Promise<void> => {
    const e = event.payload as unknown as GameEnded;
    if (!e.rated || e.plies < 2) return;
    const scoreWhite = e.result === '1-0' ? 1 : e.result === '0-1' ? 0 : 0.5;
    const weight = e.armageddon ? ARMAGEDDON_WEIGHT : 1;

    if (e.kind === 'bot') {
      const humanColor = e.botColor === 'w' ? 'b' : 'w';
      const userId = humanColor === 'w' ? e.whiteId : e.blackId;
      if (!userId) return;
      const level = BOT_LEVELS.find((l) => l.id === e.botLevel);
      const botRating = { rating: level?.elo ?? 1500, rd: BOT_RD };
      const me = await this.lock(tx, userId, 'bot');
      const score = humanColor === 'w' ? scoreWhite : 1 - scoreWhite;
      await this.save(tx, userId, 'bot', me, update(me, [{ opponent: botRating, score }]), e.gameId, weight);
      return;
    }

    if (!e.whiteId || !e.blackId) return;
    const pool = poolFor(e.timeControl);
    // Kilitleme sırası sabit (kimliğe göre): eşzamanlı iki oyunda kilitlenme olmaz.
    const [first, second] = [e.whiteId, e.blackId].sort();
    const locked = new Map<string, Glicko>();
    locked.set(first as string, await this.lock(tx, first as string, pool));
    locked.set(second as string, await this.lock(tx, second as string, pool));
    const w = locked.get(e.whiteId) as Glicko;
    const b = locked.get(e.blackId) as Glicko;
    const w2 = update(w, [{ opponent: b, score: scoreWhite }]);
    const b2 = update(b, [{ opponent: w, score: 1 - scoreWhite }]);
    await this.save(tx, e.whiteId, pool, w, w2, e.gameId, weight);
    await this.save(tx, e.blackId, pool, b, b2, e.gameId, weight);
  };

  private async lock(tx: Connection, userId: string, pool: string): Promise<Glicko> {
    await tx.query(
      `INSERT INTO user_ratings (user_id, pool, rating, rd, volatility, peak) VALUES ($1, $2, $3, $4, $5, $3)
       ON CONFLICT (user_id, pool) DO NOTHING`,
      [userId, pool, DEFAULT_RATING.rating, DEFAULT_RATING.rd, DEFAULT_RATING.vol],
    );
    const r = await tx.query<Row>('SELECT * FROM user_ratings WHERE user_id = $1 AND pool = $2 FOR UPDATE', [userId, pool]);
    const row = r.rows[0] as Row;
    return { rating: row.rating, rd: row.rd, vol: row.volatility };
  }

  private async save(tx: Connection, userId: string, pool: string, before: Glicko, after: Glicko, gameId: string, weight: number): Promise<void> {
    const rating = before.rating + (after.rating - before.rating) * weight;
    await tx.query(
      `UPDATE user_ratings SET rating = $3, rd = $4, volatility = $5, games = games + 1,
              peak = GREATEST(peak, $3), updated_at = now()
       WHERE user_id = $1 AND pool = $2`,
      [userId, pool, rating, after.rd, after.vol],
    );
    await tx.query(
      `INSERT INTO rating_history (user_id, pool, game_id, rating_before, rating_after, rd_after) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, game_id) DO NOTHING`,
      [userId, pool, gameId, before.rating, rating, after.rd],
    );
  }

  async ratingsOf(userId: string): Promise<RatingView[]> {
    const r = await this.pool.query<Row>('SELECT * FROM user_ratings WHERE user_id = $1 ORDER BY pool', [userId]);
    return r.rows.map((x) => ({
      pool: x.pool as Pool_,
      rating: Math.round(x.rating),
      rd: Math.round(x.rd),
      games: x.games,
      peak: Math.round(x.peak),
      provisional: x.rd > PROVISIONAL_RD,
    }));
  }

  async ratingFor(userId: string, pool: Pool_): Promise<RatingView> {
    const all = await this.ratingsOf(userId);
    return (
      all.find((x) => x.pool === pool) ?? {
        pool,
        rating: DEFAULT_RATING.rating,
        rd: DEFAULT_RATING.rd,
        games: 0,
        peak: DEFAULT_RATING.rating,
        provisional: true,
      }
    );
  }

  /** K6: ücretli turnuva uygunluğu için insan rakiplere karşı rated oyun sayısı. */
  async humanRatedGames(userId: string): Promise<number> {
    const r = await this.pool.query<{ n: number }>(
      `SELECT COALESCE(sum(games), 0)::int AS n FROM user_ratings WHERE user_id = $1 AND pool <> 'bot'`,
      [userId],
    );
    return (r.rows[0] as { n: number }).n;
  }

  async history(userId: string, pool: Pool_, limit = 100) {
    const r = await this.pool.query<{ game_id: string; rating_after: number; created_at: Date }>(
      `SELECT game_id, rating_after, created_at FROM rating_history WHERE user_id = $1 AND pool = $2 ORDER BY id DESC LIMIT $3`,
      [userId, pool, limit],
    );
    return r.rows.reverse().map((x) => ({ gameId: x.game_id, rating: Math.round(x.rating_after), at: x.created_at }));
  }
}
