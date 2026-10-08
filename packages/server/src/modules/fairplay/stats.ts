/**
 * Oyun analizi istatistikleri (doküman 12.4, 14.2 Katman 3). Saf: motor yok, veritabanı yok.
 * Girdi hamle başına motor çıktısıdır; çıktı oyuncu başına özet (ACPL, top-1/top-3,
 * karmaşık pozisyonda uyum, düşünme süresi profili).
 */

export interface MoveAnalysis {
  ply: number;
  color: 'w' | 'b';
  uci: string;
  san: string;
  thinkMs: number;
  /** Motorun en iyi hamlesi ve puanı (oynayan tarafın bakışından). */
  best: string;
  bestCp: number;
  playedCp: number;
  /** Oynanan hamlenin motor sırası (1–MultiPV) ya da listede yoksa null. */
  rank: number | null;
  /** Centipawn kaybı (0–1000 arası kırpılır). */
  loss: number;
  legal: number;
  /** En iyi hamleye 60 cp yakın aday sayısı (1–MultiPV): pozisyondaki "makul hamle" sayısı. */
  reasonable: number;
  /** İstatistik dışı bırakılma nedeni. */
  excluded: 'opening' | 'forced' | 'decided' | null;
}

export interface PlayerSummary {
  analysedMoves: number;
  acpl: number | null;
  top1: number | null;
  top3: number | null;
  blunders: number;
  mistakes: number;
  avgThinkMs: number | null;
  /** Düşünme süresi değişim katsayısı (std/ort): çok düşükse makine ritmi. */
  thinkCv: number | null;
  complexMoves: number;
  complexTop1: number | null;
  /** Düşünme süresi ile karmaşıklık korelasyonu (insan zor pozisyonda daha uzun düşünür). */
  timeComplexityCorr: number | null;
}

export const LOSS_CAP = 1000;
export const BLUNDER_CP = 200;
export const MISTAKE_CP = 100;
/** Bu değerden büyük üstünlükte pozisyon "karar verilmiş" sayılır; hamle kalitesi anlamsızlaşır. */
export const DECIDED_CP = 800;

const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

export function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] as number) - mx;
    const dy = (ys[i] as number) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

export function exclusionFor(ply: number, legal: number, bestCp: number, skipPlies: number): MoveAnalysis['excluded'] {
  if (ply <= skipPlies) return 'opening';
  if (legal <= 1) return 'forced';
  if (Math.abs(bestCp) >= DECIDED_CP) return 'decided';
  return null;
}

export function summarize(moves: MoveAnalysis[], color: 'w' | 'b'): PlayerSummary {
  const mine = moves.filter((m) => m.color === color && !m.excluded);
  const n = mine.length;
  const think = moves.filter((m) => m.color === color && m.excluded !== 'forced').map((m) => m.thinkMs);
  const avg = think.length ? think.reduce((s, x) => s + x, 0) / think.length : null;
  const sd = avg !== null && think.length > 1 ? Math.sqrt(think.reduce((s, x) => s + (x - avg) ** 2, 0) / (think.length - 1)) : null;
  const complex = mine.filter((m) => m.reasonable >= 3 && m.legal >= 10);
  return {
    analysedMoves: n,
    acpl: n ? round(mine.reduce((s, m) => s + m.loss, 0) / n, 1) : null,
    top1: n ? round(mine.filter((m) => m.rank === 1).length / n) : null,
    top3: n ? round(mine.filter((m) => m.rank !== null && m.rank <= 3).length / n) : null,
    blunders: mine.filter((m) => m.loss >= BLUNDER_CP).length,
    mistakes: mine.filter((m) => m.loss >= MISTAKE_CP && m.loss < BLUNDER_CP).length,
    avgThinkMs: avg === null ? null : Math.round(avg),
    thinkCv: avg && sd !== null ? round(sd / avg) : null,
    complexMoves: complex.length,
    complexTop1: complex.length ? round(complex.filter((m) => m.rank === 1).length / complex.length) : null,
    timeComplexityCorr: (() => {
      const r = pearson(mine.map((m) => m.reasonable * 10 + Math.min(m.legal, 40) / 4), mine.map((m) => m.thinkMs));
      return r === null ? null : round(r);
    })(),
  };
}
