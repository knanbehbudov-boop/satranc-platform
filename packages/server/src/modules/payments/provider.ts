/**
 * Ödeme sağlayıcı arayüzü (plan M7). Uygulama yalnız bu arayüzü bilir; Stripe,
 * Adyen ya da sandbox aynı şekilde takılır. Faz 3'teki yönlendirme katmanı
 * (payment orchestration) da bu arayüzün üzerine kurulur.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface CreateIntentInput {
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  metadata: Record<string, string>;
  returnUrl: string;
}

export interface CreatedIntent {
  ref: string;
  /** Kart bilgisinin girileceği, sağlayıcının barındırdığı sayfa. */
  checkoutUrl: string | null;
  clientSecret: string;
}

export type NormalizedType = 'payment.succeeded' | 'payment.failed' | 'refund.succeeded' | 'dispute.created' | 'ignored';

export interface WebhookEvent {
  id: string;
  type: NormalizedType;
  providerType: string;
  ref: string | null;
  /** Ödeme oluşturulurken metadata'ya konan bizim ödeme kimliğimiz (varsa). */
  paymentId?: string;
  refundRef?: string;
  amountCents?: number;
  feeCents?: number;
  currency?: string;
  failureReason?: string;
  cardLast4?: string;
  /** K49: kartı çıkaran bankanın ülkesi (ISO kodu), sağlayıcı bildiriyorsa. */
  cardCountry?: string;
  raw: unknown;
}

export interface PaymentProvider {
  readonly name: string;
  createIntent(input: CreateIntentInput): Promise<CreatedIntent>;
  refund(input: { ref: string; amountCents: number; idempotencyKey: string }): Promise<{ refundRef: string }>;
  /** Ücret bilgisi webhook'ta yoksa buradan alınır. */
  retrieve(ref: string): Promise<{ status: string; amountCents: number; feeCents: number }>;
  /** İmzayı doğrular ve olayı normalleştirir; geçersizse hata fırlatır. */
  verifyWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEvent;
  /** Mutabakat: sağlayıcıdaki net bakiye (tahsilat − iade − ücret − ters ibraz). */
  balance?(currency: string): Promise<number>;
}

export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}

/**
 * Stripe ile aynı imza şeması: başlık "t=<unix>,v1=<hex>", imza = HMAC-SHA256(secret, "<t>.<ham gövde>").
 * Zaman damgası penceresi tekrar (replay) saldırısını önler.
 */
export function signPayload(secret: string, raw: string | Buffer, t = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex');
  return `t=${t},v1=${sig}`;
}

export function verifySignature(secret: string, raw: Buffer, header: string | undefined, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)): void {
  if (!header) throw new WebhookSignatureError('İmza başlığı yok');
  const parts = Object.fromEntries(header.split(',').map((p) => {
    const i = p.indexOf('=');
    return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  }));
  const t = Number(parts.t);
  if (!Number.isFinite(t)) throw new WebhookSignatureError('İmza zaman damgası yok');
  if (Math.abs(nowSec - t) > toleranceSec) throw new WebhookSignatureError('İmza zaman penceresi dışında (tekrar saldırısı?)');
  const expected = createHmac('sha256', secret).update(`${t}.`).update(raw).digest();
  const candidates = header.split(',').filter((p) => p.trim().startsWith('v1=')).map((p) => Buffer.from(p.trim().slice(3), 'hex'));
  if (!candidates.some((c) => c.length === expected.length && timingSafeEqual(c, expected))) {
    throw new WebhookSignatureError('İmza doğrulanamadı');
  }
}

/** Örnek ücret modeli (doküman 5.3): %2,9 + 0,30 USD; yarım cent yukarı yuvarlanır. */
export function estimateFee(amountCents: number): number {
  return Math.round(amountCents * 0.029) + 30;
}
