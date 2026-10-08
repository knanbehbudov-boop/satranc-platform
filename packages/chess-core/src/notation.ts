import { fileOf, rankOf, toIndex, toSquare } from './board.ts';
import { ChessError } from './errors.ts';
import { applyMove, hasAnyLegalMove, inCheck, legalMoves } from './movegen.ts';
import type { InternalMove, Move, Position, PromotionPiece } from './types.ts';

export function toUci(m: InternalMove): string {
  return toSquare(m.from) + toSquare(m.to) + (m.promotion ?? '');
}

/**
 * Standart cebirsel notasyon (SAN). Belirsizlik giderme sırası FIDE'ye uygundur:
 * önce sütun, yetmezse yatay, o da yetmezse ikisi birden.
 */
export function toSan(pos: Position, m: InternalMove, legal: readonly InternalMove[] = legalMoves(pos)): string {
  let san: string;
  if (m.flag === 'k') san = 'O-O';
  else if (m.flag === 'q') san = 'O-O-O';
  else if (m.piece === 'p') {
    san = m.captured ? `${toSquare(m.from).charAt(0)}x${toSquare(m.to)}` : toSquare(m.to);
    if (m.promotion) san += `=${m.promotion.toUpperCase()}`;
  } else {
    const rivals = legal.filter(
      (o) => o.piece === m.piece && o.to === m.to && o.from !== m.from,
    );
    let dis = '';
    if (rivals.length > 0) {
      const sameFile = rivals.some((o) => fileOf(o.from) === fileOf(m.from));
      const sameRank = rivals.some((o) => rankOf(o.from) === rankOf(m.from));
      const sq = toSquare(m.from);
      if (!sameFile) dis = sq.charAt(0);
      else if (!sameRank) dis = sq.charAt(1);
      else dis = sq;
    }
    san = m.piece.toUpperCase() + dis + (m.captured ? 'x' : '') + toSquare(m.to);
  }

  const next = applyMove(pos, m);
  if (inCheck(next)) san += hasAnyLegalMove(next) ? '+' : '#';
  return san;
}

export function describe(pos: Position, m: InternalMove, legal: readonly InternalMove[]): Move {
  const out: {
    -readonly [K in keyof Move]: Move[K];
  } = {
    from: toSquare(m.from),
    to: toSquare(m.to),
    piece: m.piece,
    color: m.color,
    flag: m.flag,
    san: toSan(pos, m, legal),
    uci: toUci(m),
  };
  if (m.captured) out.captured = m.captured;
  if (m.promotion) out.promotion = m.promotion;
  return out;
}

export interface MoveObjectInput {
  readonly from: string;
  readonly to: string;
  readonly promotion?: PromotionPiece;
}

const UCI_RE = /^([a-h][1-8])([a-h][1-8])([nbrq])?$/;

/** SAN eki temizliği: +, #, !, ?, "e.p." gibi süsler eşleşmeyi bozmaz. */
function normalizeSan(s: string): string {
  return s
    .replace(/\s*e\.p\.$/i, '')
    .replace(/[+#!?]+$/g, '')
    .replace(/0/g, 'O');
}

/**
 * Kullanıcı ya da istemci girdisini yasal bir hamleye çevirir.
 * Kabul edilen biçimler: UCI ("e2e4", "e7e8q"), SAN ("Nf3", "exd5", "O-O"),
 * nesne ({from, to, promotion}). Bulunamazsa ILLEGAL_MOVE fırlatır.
 */
export function resolveMove(
  pos: Position,
  input: string | MoveObjectInput,
  legal: readonly InternalMove[] = legalMoves(pos),
): InternalMove {
  let from: number | undefined;
  let to: number | undefined;
  let promotion: PromotionPiece | undefined;

  if (typeof input === 'string') {
    const trimmed = input.trim();
    const uci = UCI_RE.exec(trimmed);
    if (uci) {
      from = toIndex(uci[1] as string);
      to = toIndex(uci[2] as string);
      promotion = uci[3] as PromotionPiece | undefined;
    } else {
      const wanted = normalizeSan(trimmed);
      for (const m of legal) {
        if (normalizeSan(toSan(pos, m, legal)) === wanted) return m;
      }
      // Gevşek eşleşme: "e8Q" gibi "=" olmadan yazılmış terfi.
      const loose = wanted.replace(/^([a-h](?:x[a-h])?[18])([NBRQ])$/, '$1=$2');
      if (loose !== wanted) {
        for (const m of legal) if (normalizeSan(toSan(pos, m, legal)) === loose) return m;
      }
      throw new ChessError('ILLEGAL_MOVE', `Yasal olmayan hamle: ${input}`, { move: input });
    }
  } else if (input && typeof input === 'object') {
    from = toIndex(input.from);
    to = toIndex(input.to);
    promotion = input.promotion;
  }

  const candidates = legal.filter((m) => m.from === from && m.to === to);
  if (candidates.length === 0) {
    throw new ChessError('ILLEGAL_MOVE', `Yasal olmayan hamle: ${JSON.stringify(input)}`, { move: input });
  }
  if (candidates.length > 1 || candidates[0]?.promotion) {
    // Terfi: parça belirtilmeli. Belirtilmemişse açıkça hata ver, varsayım yapma.
    const pick = candidates.find((m) => m.promotion === promotion);
    if (!pick) {
      throw new ChessError('ILLEGAL_MOVE', 'Terfi taşı belirtilmeli (q, r, b, n)', {
        move: input,
        needsPromotion: true,
      });
    }
    return pick;
  }
  if (promotion) {
    throw new ChessError('ILLEGAL_MOVE', 'Bu hamlede terfi yok', { move: input });
  }
  return candidates[0] as InternalMove;
}
