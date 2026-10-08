import { emptyBoard, onBoard, opposite, piece, rankOf, toIndex, toSquare } from './board.ts';
import { ChessError } from './errors.ts';
import { hasLegalEpCapture, inCheck } from './movegen.ts';
import type { Color, Piece, PieceType, Position } from './types.ts';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const PIECE_CHARS = 'pnbrqk';

function bad(fen: string, why: string): never {
  throw new ChessError('INVALID_FEN', `Geçersiz FEN (${why}): ${fen}`, { fen, reason: why });
}

/**
 * FEN okur ve pozisyonun gerçekten oynanabilir olduğunu doğrular:
 * her renkte tek şah, 1. ve 8. yatayda piyon yok, sırası olmayan taraf şahta değil,
 * rok hakları ile taş yerleşimi tutarlı. Hamle sayaçları verilmezse 0 ve 1 kabul edilir.
 */
export function parseFen(fen: string): Position {
  if (typeof fen !== 'string') bad(String(fen), 'metin değil');
  const parts = fen.trim().split(/\s+/);
  if (parts.length !== 4 && parts.length !== 6) bad(fen, '4 veya 6 alan olmalı');
  const [placement, turnStr, castleStr, epStr, halfStr = '0', fullStr = '1'] = parts as [
    string, string, string, string, string?, string?,
  ];

  const board = emptyBoard();
  const rows = placement.split('/');
  if (rows.length !== 8) bad(fen, '8 yatay olmalı');
  rows.forEach((row, idx) => {
    const rank = 7 - idx;
    let file = 0;
    for (const ch of row) {
      if (/[1-8]/.test(ch)) {
        file += Number(ch);
      } else {
        const lower = ch.toLowerCase();
        if (!PIECE_CHARS.includes(lower)) bad(fen, `bilinmeyen taş "${ch}"`);
        if (file > 7) bad(fen, `${rank + 1}. yatay taşıyor`);
        const color: Color = ch === lower ? 'b' : 'w';
        board[rank * 16 + file] = piece(color, lower as PieceType);
        file += 1;
      }
    }
    if (file !== 8) bad(fen, `${rank + 1}. yatay 8 kare değil`);
  });

  if (turnStr !== 'w' && turnStr !== 'b') bad(fen, 'sıra w veya b olmalı');
  const turn: Color = turnStr;

  if (!/^(-|K?Q?k?q?)$/.test(castleStr) || castleStr === '') bad(fen, 'rok alanı');
  const castling = {
    wk: castleStr.includes('K'),
    wq: castleStr.includes('Q'),
    bk: castleStr.includes('k'),
    bq: castleStr.includes('q'),
  };

  let ep = -1;
  if (epStr !== '-') {
    if (!/^[a-h][36]$/.test(epStr)) bad(fen, 'geçerken alma karesi');
    ep = toIndex(epStr);
    const expectedRank = turn === 'w' ? 5 : 2;
    if (rankOf(ep) !== expectedRank) bad(fen, 'geçerken alma karesi sıraya uymuyor');
    const pawnSq = ep + (turn === 'w' ? -16 : 16);
    const pawn = board[pawnSq];
    if (!pawn || pawn.type !== 'p' || pawn.color !== opposite(turn) || board[ep]) {
      bad(fen, 'geçerken alma karesinin arkasında piyon yok');
    }
  }

  if (!/^\d+$/.test(halfStr) || !/^\d+$/.test(fullStr)) bad(fen, 'hamle sayaçları');
  const halfmove = Number(halfStr);
  const fullmove = Number(fullStr);
  if (fullmove < 1) bad(fen, 'tam hamle sayısı 1 veya üzeri olmalı');

  const pos: Position = { board, turn, castling, ep, halfmove, fullmove };
  validatePosition(pos, fen);
  return pos;
}

function validatePosition(pos: Position, fen: string): void {
  let wk = 0;
  let bk = 0;
  for (let i = 0; i < 128; i++) {
    if (!onBoard(i)) continue;
    const p = pos.board[i];
    if (!p) continue;
    if (p.type === 'k') p.color === 'w' ? wk++ : bk++;
    if (p.type === 'p' && (rankOf(i) === 0 || rankOf(i) === 7)) bad(fen, `${toSquare(i)} karesinde piyon olamaz`);
  }
  if (wk !== 1 || bk !== 1) bad(fen, 'her renkte tam bir şah olmalı');
  if (inCheck(pos, opposite(pos.turn))) bad(fen, 'sırası olmayan taraf şahta');

  const has = (sq: string, p: Piece): boolean => {
    const x = pos.board[toIndex(sq)];
    return !!x && x.color === p.color && x.type === p.type;
  };
  const c = pos.castling;
  if ((c.wk || c.wq) && !has('e1', piece('w', 'k'))) bad(fen, 'beyaz rok hakkı var ama şah e1de değil');
  if ((c.bk || c.bq) && !has('e8', piece('b', 'k'))) bad(fen, 'siyah rok hakkı var ama şah e8de değil');
  if (c.wk && !has('h1', piece('w', 'r'))) bad(fen, 'K hakkı var ama h1de kale yok');
  if (c.wq && !has('a1', piece('w', 'r'))) bad(fen, 'Q hakkı var ama a1de kale yok');
  if (c.bk && !has('h8', piece('b', 'r'))) bad(fen, 'k hakkı var ama h8de kale yok');
  if (c.bq && !has('a8', piece('b', 'r'))) bad(fen, 'q hakkı var ama a8de kale yok');
}

function placementString(pos: Position): string {
  const rows: string[] = [];
  for (let r = 7; r >= 0; r--) {
    let row = '';
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = pos.board[r * 16 + f];
      if (!p) {
        empty++;
        continue;
      }
      if (empty) {
        row += String(empty);
        empty = 0;
      }
      row += p.color === 'w' ? p.type.toUpperCase() : p.type;
    }
    if (empty) row += String(empty);
    rows.push(row);
  }
  return rows.join('/');
}

function castleString(pos: Position): string {
  const c = pos.castling;
  const s = (c.wk ? 'K' : '') + (c.wq ? 'Q' : '') + (c.bk ? 'k' : '') + (c.bq ? 'q' : '');
  return s || '-';
}

/**
 * FEN üretir. Geçerken alma karesi yalnızca yasal bir geçerken alma varsa
 * yazılır; böylece aynı pozisyon her zaman aynı FEN'i verir.
 */
export function toFen(pos: Position): string {
  const ep = hasLegalEpCapture(pos) ? toSquare(pos.ep) : '-';
  return `${placementString(pos)} ${pos.turn} ${castleString(pos)} ${ep} ${pos.halfmove} ${pos.fullmove}`;
}

/** Tekrar (üç kez tekrar kuralı) için pozisyon kimliği: FEN'in ilk 4 alanı. */
export function positionKey(pos: Position): string {
  const ep = hasLegalEpCapture(pos) ? toSquare(pos.ep) : '-';
  return `${placementString(pos)} ${pos.turn} ${castleString(pos)} ${ep}`;
}
