import { ChessError } from './errors.ts';
import type { Color, Piece, PieceType, Square } from './types.ts';

/*
 * 0x88 tahta temsili: indeks = sıra * 16 + sütun (sıra 0 = 1. yatay).
 * (i & 0x88) !== 0 ise kare tahta dışıdır; bu, sınır kontrolünü tek bir
 * bit işlemine indirir ve hamle üretimini basit tutar.
 */

export const FILES = 'abcdefgh';

export function onBoard(i: number): boolean {
  return (i & 0x88) === 0;
}

export function fileOf(i: number): number {
  return i & 7;
}

export function rankOf(i: number): number {
  return i >> 4;
}

export function toIndex(sq: Square): number {
  if (typeof sq !== 'string' || !/^[a-h][1-8]$/.test(sq)) {
    throw new ChessError('INVALID_SQUARE', `Geçersiz kare: ${String(sq)}`, { square: sq });
  }
  return (sq.charCodeAt(1) - 49) * 16 + (sq.charCodeAt(0) - 97);
}

export function toSquare(i: number): Square {
  return FILES.charAt(fileOf(i)) + String(rankOf(i) + 1);
}

/** Karenin rengi: 0 koyu, 1 açık (a1 koyudur). Fil eşleşmesi için gerekir. */
export function squareShade(i: number): 0 | 1 {
  return ((fileOf(i) + rankOf(i)) % 2) as 0 | 1;
}

export function opposite(c: Color): Color {
  return c === 'w' ? 'b' : 'w';
}

export const ALL_SQUARES: readonly number[] = (() => {
  const out: number[] = [];
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) out.push(r * 16 + f);
  return out;
})();

const PIECE_CACHE = new Map<string, Piece>();

/** Taş nesneleri değişmez ve paylaşımlıdır; her hamlede yeni nesne üretilmez. */
export function piece(color: Color, type: PieceType): Piece {
  const key = color + type;
  let p = PIECE_CACHE.get(key);
  if (!p) {
    p = Object.freeze({ color, type });
    PIECE_CACHE.set(key, p);
  }
  return p;
}

export function emptyBoard(): (Piece | null)[] {
  return new Array<Piece | null>(128).fill(null);
}

export const KNIGHT_OFFSETS = [33, 31, 18, 14, -33, -31, -18, -14] as const;
export const BISHOP_DIRS = [17, 15, -17, -15] as const;
export const ROOK_DIRS = [16, -16, 1, -1] as const;
export const KING_OFFSETS = [17, 16, 15, 1, -1, -15, -16, -17] as const;

/** Rok için gereken sabit kareler. */
export const SQ = {
  a1: 0, b1: 1, c1: 2, d1: 3, e1: 4, f1: 5, g1: 6, h1: 7,
  a8: 112, b8: 113, c8: 114, d8: 115, e8: 116, f8: 117, g8: 118, h8: 119,
} as const;
