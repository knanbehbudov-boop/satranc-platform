/**
 * Oyun sonu analizi — oyuncunun gördüğü yüz (K45).
 *
 * Analiz işçisinin ürettiği ham sonuçtan (analysis_results) oyuncuya uygun bir özet üretir:
 * doğruluk yüzdesi, hamle sınıfları (en iyi, iyi, küçük hata, hata, büyük hata), değerlendirme grafiği
 * ve her hamle için daha iyi alternatif. Hile tespitinde kullanılan iç göstergeler (ilk tercih oranı,
 * düşünme süresi ritmi vb.) ve motorun adı burada asla verilmez.
 *
 * Ücretli oyunlar adil oyun için zaten otomatik analiz edilir; diğer oyunlarda oyuncu "Analiz et"
 * dediğinde iş kuyruğa öncelikli girer. CPU maliyeti için kişi başı günlük sınır vardır.
 */
import { ChessGame } from '@satranc/chess-core';
import type { Pool } from '../../infra/db/pg.ts';
import { AppError, forbidden, notFound } from '../../infra/errors.ts';
import { isUuid } from '../../infra/http/validate.ts';
import type { AnalysisService } from '../fairplay/analysis.ts';
import type { MoveAnalysis } from '../fairplay/stats.ts';

export type MoveClass = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';

/** Santipiyondan kazanma yüzdesi (0–100), hamle yapan tarafın gözünden. */
export function winPercent(cp: number): number {
  const c = Math.max(-1500, Math.min(1500, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
}

/** Tek hamlenin doğruluğu (0–100): kazanma yüzdesindeki düşüşten. */
export function moveAccuracy(bestCp: number, playedCp: number): number {
  const drop = Math.max(0, winPercent(bestCp) - winPercent(playedCp));
  const acc = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669;
  return Math.max(0, Math.min(100, acc));
}

export function classify(m: Pick<MoveAnalysis, 'rank' | 'bestCp' | 'playedCp' | 'loss'>): MoveClass {
  if (m.rank === 1 || m.loss <= 10) return 'best';
  const drop = winPercent(m.bestCp) - winPercent(m.playedCp);
  if (drop >= 30) return 'blunder';
  if (drop >= 20) return 'mistake';
  if (drop >= 10) return 'inaccuracy';
  return 'good';
}

export interface PlayerReview {
  userId: string | null;
  accuracy: number | null;
  moves: number;
  counts: Record<MoveClass, number>;
}

export interface Review {
  status: 'ready';
  gameId: string;
  players: { white: PlayerReview; black: PlayerReview };
  /** Her yarım hamleden sonra beyazın gözünden değerlendirme (santipiyon, ±1000 ile sınırlı). */
  evalGraph: number[];
  moves: { ply: number; color: 'w' | 'b'; san: string; class: MoveClass; bestSan: string | null; accuracy: number }[];
}

const emptyCounts = (): Record<MoveClass, number> => ({ best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 });

/** Ham analizden oyuncu özetini üretir (saf fonksiyon). */
export function buildReview(gameId: string, initialFen: string, whiteId: string | null, blackId: string | null, moves: MoveAnalysis[]): Review {
  const chess = new ChessGame({ fen: initialFen });
  const out: Review['moves'] = [];
  const evalGraph: number[] = [];
  const acc: Record<'w' | 'b', number[]> = { w: [], b: [] };
  const counts: Record<'w' | 'b', Record<MoveClass, number>> = { w: emptyCounts(), b: emptyCounts() };
  for (const m of moves) {
    let bestSan: string | null = null;
    try {
      const legal = chess.moves();
      bestSan = legal.find((x) => x.uci === m.best)?.san ?? null;
    } catch {
      bestSan = null;
    }
    const cls = classify(m);
    const a = moveAccuracy(m.bestCp, m.playedCp);
    acc[m.color].push(a);
    counts[m.color][cls]++;
    out.push({ ply: m.ply, color: m.color, san: m.san, class: cls, bestSan: cls === 'best' ? null : bestSan, accuracy: Math.round(a) });
    const whitePov = m.color === 'w' ? m.playedCp : -m.playedCp;
    evalGraph.push(Math.max(-1000, Math.min(1000, Math.round(whitePov))));
    try {
      chess.move(m.uci);
    } catch {
      break;
    }
  }
  const player = (c: 'w' | 'b', userId: string | null): PlayerReview => ({
    userId,
    accuracy: acc[c].length ? Math.round((acc[c].reduce((s, x) => s + x, 0) / acc[c].length) * 10) / 10 : null,
    moves: acc[c].length,
    counts: counts[c],
  });
  return { status: 'ready', gameId, players: { white: player('w', whiteId), black: player('b', blackId) }, evalGraph, moves: out };
}

export class ReviewService {
  private readonly pool: Pool;
  private readonly analysis: AnalysisService;
  /** Kişi başı günlük isteğe bağlı analiz sınırı. */
  dailyRequests = 20;

  constructor(deps: { pool: Pool; analysis: AnalysisService }) {
    this.pool = deps.pool;
    this.analysis = deps.analysis;
  }

  private async game(userId: string, gameId: string) {
    if (!isUuid(gameId)) throw notFound('GAME_NOT_FOUND', 'Oyun bulunamadı');
    const r = await this.pool.query<{ id: string; status: string; white_id: string | null; black_id: string | null; initial_fen: string; kind: string; paid: boolean }>(
      'SELECT id, status, white_id, black_id, initial_fen, kind, paid FROM games WHERE id = $1',
      [gameId],
    );
    const g = r.rows[0];
    if (!g) throw notFound('GAME_NOT_FOUND', 'Oyun bulunamadı');
    if (g.white_id !== userId && g.black_id !== userId) throw forbidden('NOT_A_PLAYER', 'Yalnız oyunu oynayanlar analizi görebilir');
    if (g.status !== 'finished') throw new AppError(409, 'GAME_NOT_FINISHED', 'Analiz oyun bitince açılır');
    return g;
  }

  /** Oyuncunun gördüğü analiz: hazırsa özet, değilse kuyruk durumu. */
  async review(userId: string, gameId: string): Promise<Review | { status: 'none' | 'queued' | 'running' | 'failed'; gameId: string }> {
    const g = await this.game(userId, gameId);
    const res = await this.analysis.result(gameId);
    if (res) return buildReview(gameId, g.initial_fen, g.white_id, g.black_id, res.moves as MoveAnalysis[]);
    const job = await this.pool.query<{ status: 'queued' | 'running' | 'failed' | 'done' }>('SELECT status FROM analysis_jobs WHERE game_id = $1', [gameId]);
    const st = job.rows[0]?.status;
    return { status: !st || st === 'done' ? 'none' : st, gameId };
  }

  /** Oyuncu analizi ister: kuyruğa öncelikli girer (günlük sınırla). */
  async request(userId: string, gameId: string) {
    await this.game(userId, gameId);
    if (await this.analysis.result(gameId)) return { status: 'ready' as const, gameId };
    const used = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM analysis_jobs WHERE requested_by = $1 AND created_at > now() - interval '1 day'`,
      [`user:${userId}`],
    );
    if ((used.rows[0] as { n: number }).n >= this.dailyRequests) {
      throw new AppError(429, 'REVIEW_LIMIT', `Günlük analiz sınırına ulaştın (${this.dailyRequests})`);
    }
    await this.analysis.enqueue(this.pool, gameId, `user:${userId}`, 2);
    return { status: 'queued' as const, gameId };
  }
}
