/**
 * Turnuva motorunun saf parçaları (veritabanı yok): durum makinesi, doğrulanabilir
 * rastgele yerleştirme (commit-reveal), bracket yapısı, mini maç kararı, sıralama.
 */
import { createHash, createHmac } from 'node:crypto';

// ---- durum makinesi (doküman 4.2) --------------------------------------------

export type TournamentStatus =
  | 'DRAFT' | 'OPEN' | 'FULL' | 'STARTING' | 'RUNNING' | 'FINISHED'
  | 'SETTLING' | 'SETTLED' | 'DISPUTED' | 'CANCELLED' | 'ABORTED';

export const TRANSITIONS: Readonly<Record<TournamentStatus, readonly TournamentStatus[]>> = {
  DRAFT: ['OPEN'],
  OPEN: ['FULL', 'CANCELLED'],
  FULL: ['STARTING'],
  STARTING: ['RUNNING', 'CANCELLED'],
  RUNNING: ['FINISHED', 'ABORTED'],
  FINISHED: ['SETTLING'],
  SETTLING: ['SETTLED', 'DISPUTED'],
  DISPUTED: ['SETTLED', 'CANCELLED'],
  ABORTED: ['SETTLING', 'CANCELLED'],
  SETTLED: [],
  CANCELLED: [],
};

export function canTransition(from: TournamentStatus, to: TournamentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

// ---- commit-reveal (doküman 11.2.1) ------------------------------------------

export function seedCommitment(secretHex: string): string {
  return createHash('sha256').update(secretHex).digest('hex');
}

/**
 * Doğrulanabilir karıştırma: oyuncu kimlikleri sıralanır, sonra Fisher–Yates
 * uygulanır; her adımın rastgele sayısı HMAC-SHA256(seed, "turnuvaId:i") ile üretilir.
 * Seed açıklandığında herkes aynı sırayı yeniden üretebilir. Modülo yanlılığı
 * reddetme örneklemesiyle giderilir.
 */
export function verifiableShuffle(playerIds: readonly string[], secretHex: string, tournamentId: string): string[] {
  const a = [...playerIds].sort();
  for (let i = a.length - 1; i > 0; i--) {
    const n = i + 1;
    const limit = Math.floor(0x1_0000_0000 / n) * n;
    let counter = 0;
    let x: number;
    do {
      const h = createHmac('sha256', Buffer.from(secretHex, 'hex')).update(`${tournamentId}:${i}:${counter++}`).digest();
      x = h.readUInt32BE(0);
    } while (x >= limit);
    const j = x % n;
    [a[i], a[j]] = [a[j] as string, a[i] as string];
  }
  return a;
}

/**
 * Klasik tohum yerleşimi (doküman 11.2): 1–N, 2–(N−1) ve güçlüler finale kadar
 * karşılaşmaz. 8 için [1,8,4,5,2,7,3,6]. Bantsız ve rating sıralı turnuvalar için.
 */
export function seedPositions(n: number): number[] {
  let pos = [1, 2];
  while (pos.length < n) {
    const size = pos.length * 2;
    pos = pos.flatMap((s) => [s, size + 1 - s]);
  }
  return pos;
}

// ---- bracket ------------------------------------------------------------------

export interface BracketSlot {
  round: number;
  slot: number;
  next: { round: number; slot: number; side: 'a' | 'b' } | null;
}

export function roundsFor(capacity: number): number {
  const r = Math.log2(capacity);
  if (!Number.isInteger(r) || r < 2 || r > 5) throw new Error(`Kontenjan 4, 8, 16 ya da 32 olmalı: ${capacity}`);
  return r;
}

export function buildBracket(capacity: number): BracketSlot[] {
  const rounds = roundsFor(capacity);
  const out: BracketSlot[] = [];
  let count = capacity / 2;
  for (let r = 1; r <= rounds; r++) {
    for (let s = 1; s <= count; s++) {
      out.push({
        round: r,
        slot: s,
        next: r < rounds ? { round: r + 1, slot: Math.ceil(s / 2), side: s % 2 === 1 ? 'a' : 'b' } : null,
      });
    }
    count /= 2;
  }
  return out;
}

/** K8: bu turda elenenin sıralaması. Final kaybedeni 2, yarı final 3, çeyrek 5, son 16'da 9, son 32'de 17. */
export function eliminationRank(round: number, totalRounds: number): number {
  return 2 ** (totalRounds - round) + 1;
}

export function roundName(round: number, totalRounds: number): string {
  const left = totalRounds - round;
  return ['Final', 'Yarı final', 'Çeyrek final', 'Son 16', 'Son 32'][left] ?? `${round}. tur`;
}

// ---- maç: tek oyun + beraberlikte kısa tekrar oyunları -------------------------

/** Beraberlikte oynanan tekrar oyunlarının zaman kontrolü: 1 dk, artışsız. */
export const TIEBREAK_TIME_CONTROL = '60+0';

export interface GameOutcome {
  gameNo: number;
  /** Oyunda beyazla oynayan, maçtaki A oyuncusu mu? */
  aWasWhite: boolean;
  result: '1-0' | '0-1' | '1/2-1/2';
}

export type MatchVerdict =
  | { kind: 'tiebreak'; gameNo: number; aWhite: boolean }
  | { kind: 'decided'; winner: 'a' | 'b'; scoreA: number; scoreB: number; by: 'game' | 'tiebreak' };

export function pointsFor(o: GameOutcome): { a: number; b: number } {
  const white = o.result === '1-0' ? 1 : o.result === '0-1' ? 0 : 0.5;
  return o.aWasWhite ? { a: white, b: 1 - white } : { a: 1 - white, b: white };
}

/**
 * Her tur tek oyundur. Oyun berabere biterse 1'er dakikalık tekrar oyunu oynanır;
 * her tekrar oyununda renkler değişir. Biri kazanana kadar devam eder (süre veya
 * başka bir yolla bitmez). Skor tüm oyunların toplamıdır.
 */
export function judgeMatch(outcomes: readonly GameOutcome[]): MatchVerdict {
  const games = [...outcomes].sort((x, y) => x.gameNo - y.gameNo);
  let a = 0;
  let b = 0;
  for (const o of games) {
    const p = pointsFor(o);
    a += p.a;
    b += p.b;
  }
  const last = games[games.length - 1];
  if (!last) return { kind: 'tiebreak', gameNo: 1, aWhite: true };
  if (last.result !== '1/2-1/2') {
    const aWon = pointsFor(last).a === 1;
    return { kind: 'decided', winner: aWon ? 'a' : 'b', scoreA: a, scoreB: b, by: last.gameNo === 1 ? 'game' : 'tiebreak' };
  }
  return { kind: 'tiebreak', gameNo: last.gameNo + 1, aWhite: !last.aWasWhite };
}
