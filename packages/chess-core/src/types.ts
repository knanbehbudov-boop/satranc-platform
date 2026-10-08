/**
 * Ortak tipler. Bu paket saf (yan etkisiz) kalır: veritabanına, ağa, saate
 * veya rastgeleliğe erişmez. Sunucu (M3) ve tarayıcı (M14) aynı kodu kullanır.
 */

export type Color = 'w' | 'b';
export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export type PromotionPiece = 'n' | 'b' | 'r' | 'q';

export interface Piece {
  readonly color: Color;
  readonly type: PieceType;
}

/** Cebirsel kare adı: "a1" … "h8". */
export type Square = string;

/**
 * Hamle bayrakları:
 * n normal, c alış, b iki kare piyon, e geçerken alma,
 * k kısa rok, q uzun rok, p terfi (alışla birlikte "pc" olabilir).
 */
export type MoveFlag = 'n' | 'c' | 'b' | 'e' | 'k' | 'q' | 'p' | 'pc';

/** İç temsil: 0x88 tahta indeksleriyle hamle. */
export interface InternalMove {
  readonly from: number;
  readonly to: number;
  readonly piece: PieceType;
  readonly color: Color;
  readonly captured?: PieceType;
  readonly promotion?: PromotionPiece;
  readonly flag: MoveFlag;
}

/** Dışarıya verilen hamle: insan ve makine okunabilir. */
export interface Move {
  readonly from: Square;
  readonly to: Square;
  readonly piece: PieceType;
  readonly color: Color;
  readonly captured?: PieceType;
  readonly promotion?: PromotionPiece;
  readonly flag: MoveFlag;
  /** Standart cebirsel notasyon, ör. "Nxf7+" */
  readonly san: string;
  /** UCI notasyonu, ör. "e7e8q" */
  readonly uci: string;
}

export interface CastlingRights {
  readonly wk: boolean;
  readonly wq: boolean;
  readonly bk: boolean;
  readonly bq: boolean;
}

export interface Position {
  /** 128 hücrelik 0x88 dizi; geçerli kareler (i & 0x88) === 0 olanlar. */
  readonly board: ReadonlyArray<Piece | null>;
  readonly turn: Color;
  readonly castling: CastlingRights;
  /** Geçerken alma hedef karesi (0x88 indeks) ya da -1. */
  readonly ep: number;
  readonly halfmove: number;
  readonly fullmove: number;
}

export type GameResult = '1-0' | '0-1' | '1/2-1/2' | '*';

/**
 * Oyun bitiş nedenleri. Dokümandaki (9.2 games.end_reason) liste
 * beraberlik alt türleriyle genişletildi.
 */
export type EndReason =
  | 'mate'
  | 'resign'
  | 'timeout'
  | 'timeout_vs_insufficient'
  | 'stalemate'
  | 'insufficient_material'
  | 'threefold_repetition'
  | 'fifty_move'
  | 'agreement'
  | 'abandon'
  | 'forfeit'
  | 'adjudication';

export interface GameStatus {
  readonly over: boolean;
  readonly result: GameResult;
  readonly reason?: EndReason;
  readonly winner?: Color;
}
