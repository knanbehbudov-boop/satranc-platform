import {
  BISHOP_DIRS,
  KING_OFFSETS,
  KNIGHT_OFFSETS,
  ROOK_DIRS,
  SQ,
  onBoard,
  opposite,
  piece,
  rankOf,
} from './board.ts';
import type {
  CastlingRights,
  Color,
  InternalMove,
  MoveFlag,
  PieceType,
  Position,
  PromotionPiece,
} from './types.ts';

const PROMOTIONS: readonly PromotionPiece[] = ['q', 'r', 'b', 'n'];

/** `by` renginin taşlarından biri `sq` karesine saldırıyor mu? */
export function isAttacked(pos: Position, sq: number, by: Color): boolean {
  const b = pos.board;

  // Piyonlar: beyaz piyon p, p+15 ve p+17'ye saldırır.
  if (by === 'w') {
    for (const d of [-15, -17]) {
      const s = sq + d;
      if (onBoard(s)) {
        const p = b[s];
        if (p && p.color === 'w' && p.type === 'p') return true;
      }
    }
  } else {
    for (const d of [15, 17]) {
      const s = sq + d;
      if (onBoard(s)) {
        const p = b[s];
        if (p && p.color === 'b' && p.type === 'p') return true;
      }
    }
  }

  for (const d of KNIGHT_OFFSETS) {
    const s = sq + d;
    if (onBoard(s)) {
      const p = b[s];
      if (p && p.color === by && p.type === 'n') return true;
    }
  }

  for (const d of KING_OFFSETS) {
    const s = sq + d;
    if (onBoard(s)) {
      const p = b[s];
      if (p && p.color === by && p.type === 'k') return true;
    }
  }

  for (const d of BISHOP_DIRS) {
    let s = sq + d;
    while (onBoard(s)) {
      const p = b[s];
      if (p) {
        if (p.color === by && (p.type === 'b' || p.type === 'q')) return true;
        break;
      }
      s += d;
    }
  }

  for (const d of ROOK_DIRS) {
    let s = sq + d;
    while (onBoard(s)) {
      const p = b[s];
      if (p) {
        if (p.color === by && (p.type === 'r' || p.type === 'q')) return true;
        break;
      }
      s += d;
    }
  }

  return false;
}

export function findKing(pos: Position, color: Color): number {
  for (let i = 0; i < 128; i++) {
    if (!onBoard(i)) {
      i += 7;
      continue;
    }
    const p = pos.board[i];
    if (p && p.type === 'k' && p.color === color) return i;
  }
  return -1;
}

export function inCheck(pos: Position, color: Color = pos.turn): boolean {
  const k = findKing(pos, color);
  return k >= 0 && isAttacked(pos, k, opposite(color));
}

function push(
  out: InternalMove[],
  pos: Position,
  from: number,
  to: number,
  type: PieceType,
  flag: MoveFlag,
  captured?: PieceType,
  promotion?: PromotionPiece,
): void {
  const m: {
    from: number;
    to: number;
    piece: PieceType;
    color: Color;
    flag: MoveFlag;
    captured?: PieceType;
    promotion?: PromotionPiece;
  } = { from, to, piece: type, color: pos.turn, flag };
  if (captured) m.captured = captured;
  if (promotion) m.promotion = promotion;
  out.push(m);
}

/** Şah kontrolü yapılmamış (pseudo-legal) hamleler. */
export function pseudoLegalMoves(pos: Position): InternalMove[] {
  const out: InternalMove[] = [];
  const b = pos.board;
  const us = pos.turn;
  const them = opposite(us);

  for (let from = 0; from < 128; from++) {
    if (!onBoard(from)) {
      from += 7;
      continue;
    }
    const p = b[from];
    if (!p || p.color !== us) continue;

    switch (p.type) {
      case 'p': {
        const dir = us === 'w' ? 16 : -16;
        const startRank = us === 'w' ? 1 : 6;
        const promoRank = us === 'w' ? 7 : 0;
        const one = from + dir;
        if (onBoard(one) && !b[one]) {
          if (rankOf(one) === promoRank) {
            for (const pr of PROMOTIONS) push(out, pos, from, one, 'p', 'p', undefined, pr);
          } else {
            push(out, pos, from, one, 'p', 'n');
            const two = one + dir;
            if (rankOf(from) === startRank && !b[two]) push(out, pos, from, two, 'p', 'b');
          }
        }
        for (const side of [-1, 1]) {
          const to = from + dir + side;
          if (!onBoard(to)) continue;
          const t = b[to];
          if (t && t.color === them) {
            if (rankOf(to) === promoRank) {
              for (const pr of PROMOTIONS) push(out, pos, from, to, 'p', 'pc', t.type, pr);
            } else {
              push(out, pos, from, to, 'p', 'c', t.type);
            }
          } else if (!t && to === pos.ep) {
            push(out, pos, from, to, 'p', 'e', 'p');
          }
        }
        break;
      }
      case 'n':
      case 'k': {
        const offsets = p.type === 'n' ? KNIGHT_OFFSETS : KING_OFFSETS;
        for (const d of offsets) {
          const to = from + d;
          if (!onBoard(to)) continue;
          const t = b[to];
          if (!t) push(out, pos, from, to, p.type, 'n');
          else if (t.color === them) push(out, pos, from, to, p.type, 'c', t.type);
        }
        if (p.type === 'k') addCastling(out, pos, from);
        break;
      }
      default: {
        const dirs =
          p.type === 'b' ? BISHOP_DIRS : p.type === 'r' ? ROOK_DIRS : [...BISHOP_DIRS, ...ROOK_DIRS];
        for (const d of dirs) {
          let to = from + d;
          while (onBoard(to)) {
            const t = b[to];
            if (!t) {
              push(out, pos, from, to, p.type, 'n');
            } else {
              if (t.color === them) push(out, pos, from, to, p.type, 'c', t.type);
              break;
            }
            to += d;
          }
        }
      }
    }
  }
  return out;
}

function addCastling(out: InternalMove[], pos: Position, from: number): void {
  const us = pos.turn;
  const them = opposite(us);
  const b = pos.board;
  const home = us === 'w' ? SQ.e1 : SQ.e8;
  if (from !== home) return;
  const kingSide = us === 'w' ? pos.castling.wk : pos.castling.bk;
  const queenSide = us === 'w' ? pos.castling.wq : pos.castling.bq;
  if (!kingSide && !queenSide) return;
  if (isAttacked(pos, home, them)) return; // şah çekilmişken rok yok

  const rookOk = (sq: number): boolean => {
    const r = b[sq];
    return !!r && r.color === us && r.type === 'r';
  };

  if (kingSide) {
    const f = home + 1;
    const g = home + 2;
    if (!b[f] && !b[g] && rookOk(home + 3) && !isAttacked(pos, f, them) && !isAttacked(pos, g, them)) {
      push(out, pos, home, g, 'k', 'k');
    }
  }
  if (queenSide) {
    const d = home - 1;
    const c = home - 2;
    const bsq = home - 3;
    if (
      !b[d] && !b[c] && !b[bsq] && rookOk(home - 4) &&
      !isAttacked(pos, d, them) && !isAttacked(pos, c, them)
    ) {
      push(out, pos, home, c, 'k', 'q');
    }
  }
}

/** Hamleyi uygular ve YENİ bir pozisyon döndürür; girdi değişmez. */
export function applyMove(pos: Position, m: InternalMove): Position {
  const board = pos.board.slice();
  const us = pos.turn;
  const moving = board[m.from];
  board[m.from] = null;

  if (m.flag === 'e') {
    board[m.to + (us === 'w' ? -16 : 16)] = null;
  }
  board[m.to] = m.promotion ? piece(us, m.promotion) : (moving ?? piece(us, m.piece));

  if (m.flag === 'k') {
    board[m.to + 1] = null;
    board[m.to - 1] = piece(us, 'r');
  } else if (m.flag === 'q') {
    board[m.to - 2] = null;
    board[m.to + 1] = piece(us, 'r');
  }

  let { wk, wq, bk, bq } = pos.castling;
  if (m.piece === 'k') {
    if (us === 'w') wk = wq = false;
    else bk = bq = false;
  }
  // Kale oynarsa ya da köşedeki kale alınırsa ilgili hak düşer.
  for (const sq of [m.from, m.to]) {
    if (sq === SQ.h1) wk = false;
    else if (sq === SQ.a1) wq = false;
    else if (sq === SQ.h8) bk = false;
    else if (sq === SQ.a8) bq = false;
  }
  const castling: CastlingRights = { wk, wq, bk, bq };

  const ep = m.flag === 'b' ? m.from + (us === 'w' ? 16 : -16) : -1;
  const resetsClock = m.piece === 'p' || m.captured !== undefined;

  return {
    board,
    turn: opposite(us),
    castling,
    ep,
    halfmove: resetsClock ? 0 : pos.halfmove + 1,
    fullmove: us === 'b' ? pos.fullmove + 1 : pos.fullmove,
  };
}

/** Kendi şahını açıkta bırakmayan hamleler. */
export function legalMoves(pos: Position): InternalMove[] {
  const us = pos.turn;
  const out: InternalMove[] = [];
  for (const m of pseudoLegalMoves(pos)) {
    const next = applyMove(pos, m);
    if (!inCheck(next, us)) out.push(m);
  }
  return out;
}

export function hasAnyLegalMove(pos: Position): boolean {
  const us = pos.turn;
  for (const m of pseudoLegalMoves(pos)) {
    if (!inCheck(applyMove(pos, m), us)) return true;
  }
  return false;
}

/**
 * Geçerken alma gerçekten yapılabiliyor mu? FEN ve tekrar anahtarı için
 * kullanılır: yasal geçerken alma yoksa iki pozisyon "aynı" sayılır (FIDE 9.2).
 */
export function hasLegalEpCapture(pos: Position): boolean {
  if (pos.ep < 0) return false;
  for (const m of legalMoves(pos)) if (m.flag === 'e') return true;
  return false;
}

/** Hamle üreticinin doğruluğunu ölçen standart sayım (perft). */
export function perft(pos: Position, depth: number): number {
  if (depth <= 0) return 1;
  const moves = legalMoves(pos);
  if (depth === 1) return moves.length;
  let n = 0;
  for (const m of moves) n += perft(applyMove(pos, m), depth - 1);
  return n;
}
