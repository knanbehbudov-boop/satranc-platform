/**
 * Hata kodları M0'daki standart hata biçimine ({code, message, details})
 * doğrudan eşlenir. Mesajlar geliştirici içindir; kullanıcıya gösterilecek
 * metin i18n anahtarıyla (code) arayüzde üretilir.
 */
export type ChessErrorCode =
  | 'INVALID_FEN'
  | 'INVALID_SQUARE'
  | 'ILLEGAL_MOVE'
  | 'GAME_OVER'
  | 'DRAW_OFFER_TOO_EARLY'
  | 'DRAW_OFFER_PENDING'
  | 'NO_DRAW_OFFER'
  | 'TAKEBACK_DISABLED'
  | 'INVALID_TIME_CONTROL'
  | 'INVALID_PGN';

export class ChessError extends Error {
  readonly code: ChessErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ChessErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ChessError';
    this.code = code;
    this.details = details;
  }

  toJSON(): { code: ChessErrorCode; message: string; details?: Record<string, unknown> } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}
