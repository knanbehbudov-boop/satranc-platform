/**
 * @satranc/chess-core — M2 Satranç çekirdeği.
 * Sunucu (oyun yöneticisi, analiz işçisi) ve tarayıcı (tahta) aynı paketi kullanır.
 */
export * from './types.ts';
export { ChessError, type ChessErrorCode } from './errors.ts';
export { START_FEN, parseFen, toFen, positionKey } from './fen.ts';
export { toSquare, toIndex, opposite } from './board.ts';
export { legalMoves, applyMove, inCheck, perft } from './movegen.ts';
export { toSan, toUci, resolveMove, type MoveObjectInput } from './notation.ts';
export { isInsufficientMaterial, canCheckmate } from './material.ts';
export {
  parseTimeControl,
  categorize,
  armageddonClocks,
  type TimeControl,
  type TimeCategory,
  type ArmageddonClocks,
} from './timecontrol.ts';
export { CASUAL_RULES, rulesFor, type RuleSet } from './rules.ts';
export { ChessGame, type GameOptions, type HistoryEntry } from './game.ts';
export { toPgn, parsePgn, type PgnHeaders, type ParsedPgn } from './pgn.ts';
