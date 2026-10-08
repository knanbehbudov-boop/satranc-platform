/**
 * Standart hata biçimi (plan M0): { code, message, details }.
 * `code` arayüzde i18n anahtarı olarak kullanılır; `message` geliştirici içindir.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toJSON(): { code: string; message: string; details?: Record<string, unknown> } {
    return this.details ? { code: this.code, message: this.message, details: this.details } : { code: this.code, message: this.message };
  }
}

export const badRequest = (code: string, message: string, details?: Record<string, unknown>) => new AppError(400, code, message, details);
export const unauthorized = (code = 'UNAUTHORIZED', message = 'Giriş gerekli') => new AppError(401, code, message);
export const forbidden = (code = 'FORBIDDEN', message = 'Bu işlem için yetkiniz yok') => new AppError(403, code, message);
export const notFound = (code = 'NOT_FOUND', message = 'Bulunamadı') => new AppError(404, code, message);
export const conflict = (code: string, message: string, details?: Record<string, unknown>) => new AppError(409, code, message, details);
export const tooMany = (retryAfterSec: number) =>
  new AppError(429, 'RATE_LIMITED', 'Çok fazla istek; biraz sonra tekrar deneyin', { retryAfterSec });
