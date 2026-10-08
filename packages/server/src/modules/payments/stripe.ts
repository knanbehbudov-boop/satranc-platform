/**
 * Stripe bağdaştırıcısı (plan M7). Bağımlılıksız: Stripe REST API'si form
 * kodlamalı istekler ve fetch ile çağrılır. Akış:
 *   createIntent → Checkout Session (Stripe'ın barındırdığı ödeme sayfası, SAQ A),
 *     PaymentIntent metadata'sına bizim ödeme kimliğimiz konur;
 *   webhook'lar: payment_intent.succeeded / payment_failed, charge.refunded,
 *     charge.dispute.created (imza: Stripe-Signature, t=…,v1=… şeması);
 *   ücret webhook'ta gelmez → retrieve ile balance_transaction'dan okunur.
 *
 * Bu ortamda Stripe'a ağ erişimi olmadığı için testler yerel sahte sunucuyla yapılır
 * (test/payments-stripe.test.ts); gerçek anahtar ile ilk denemede Stripe'ın test modu kullanılmalı.
 */
import {
  verifySignature,
  WebhookSignatureError,
  type CreatedIntent,
  type CreateIntentInput,
  type PaymentProvider,
  type WebhookEvent,
} from './provider.ts';

export interface StripeOptions {
  secretKey: string;
  webhookSecret: string;
  /** Uygulamanın dışarıdan erişilen adresi (başarı/iptal dönüş adresleri için). */
  publicBaseUrl: string;
  apiBase?: string;
}

/** Stripe'ın iç içe form kodlaması: a[b][0][c]=d */
export function formEncode(obj: Record<string, unknown>, prefix = ''): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === 'object') parts.push(formEncode(item as Record<string, unknown>, `${key}[${i}]`));
        else parts.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof v === 'object') {
      parts.push(formEncode(v as Record<string, unknown>, key));
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.filter(Boolean).join('&');
}

export class StripeError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'StripeError';
    this.status = status;
    this.code = code;
  }
}

export class StripePsp implements PaymentProvider {
  readonly name = 'stripe';
  private readonly o: Required<StripeOptions>;

  constructor(o: StripeOptions) {
    this.o = { apiBase: 'https://api.stripe.com', ...o };
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.o.secretKey}`,
      'stripe-version': '2024-06-20',
    };
    if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const res = await fetch(this.o.apiBase + path, { method, headers, body: body ? formEncode(body) : undefined, signal: AbortSignal.timeout(15_000) });
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string } };
    if (!res.ok) throw new StripeError(res.status, data.error?.message ?? `Stripe hatası (${res.status})`, data.error?.code);
    return data as T;
  }

  async createIntent(input: CreateIntentInput): Promise<CreatedIntent> {
    const base = this.o.publicBaseUrl.replace(/\/$/, '');
    const abs = (u: string) => (/^https?:\/\//.test(u) ? u : base + u);
    const s = await this.call<{ id: string; url: string; payment_intent: string | null }>(
      'POST',
      '/v1/checkout/sessions',
      {
        mode: 'payment',
        success_url: abs(input.returnUrl),
        cancel_url: abs(input.returnUrl),
        client_reference_id: input.metadata.paymentId,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: input.currency.toLowerCase(),
            unit_amount: input.amountCents,
            product_data: { name: input.metadata.description ?? 'Turnuva giriş ücreti' },
          },
        }],
        payment_intent_data: { metadata: input.metadata },
        metadata: input.metadata,
      },
      input.idempotencyKey,
    );
    // PaymentIntent kimliği ödeme tamamlanınca webhook ile gelir; o zamana dek oturum kimliği referanstır.
    return { ref: s.payment_intent ?? s.id, checkoutUrl: s.url, clientSecret: '' };
  }

  async refund(input: { ref: string; amountCents: number; idempotencyKey: string }): Promise<{ refundRef: string }> {
    const r = await this.call<{ id: string }>('POST', '/v1/refunds', { payment_intent: input.ref, amount: input.amountCents }, input.idempotencyKey);
    return { refundRef: r.id };
  }

  async retrieve(ref: string): Promise<{ status: string; amountCents: number; feeCents: number }> {
    const pi = await this.call<{ status: string; amount_received: number; amount: number; latest_charge?: { balance_transaction?: { fee?: number } } }>(
      'GET',
      `/v1/payment_intents/${encodeURIComponent(ref)}?expand[]=latest_charge.balance_transaction`,
    );
    return { status: pi.status, amountCents: pi.amount_received || pi.amount, feeCents: pi.latest_charge?.balance_transaction?.fee ?? 0 };
  }

  verifyWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEvent {
    const h = headers['stripe-signature'];
    verifySignature(this.o.webhookSecret, raw, Array.isArray(h) ? h[0] : h);
    let ev: { id: string; type: string; data: { object: Record<string, any> } };
    try {
      ev = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new WebhookSignatureError('Gövde JSON değil');
    }
    const o = ev.data?.object ?? {};
    const cur = typeof o.currency === 'string' ? o.currency.toUpperCase() : undefined;
    switch (ev.type) {
      case 'payment_intent.succeeded':
        return {
          id: ev.id, type: 'payment.succeeded', providerType: ev.type, ref: o.id, paymentId: o.metadata?.paymentId,
          amountCents: o.amount_received, currency: cur, cardLast4: o.payment_method_details?.card?.last4, raw: ev,
        };
      case 'payment_intent.payment_failed':
        return {
          id: ev.id, type: 'payment.failed', providerType: ev.type, ref: o.id, paymentId: o.metadata?.paymentId,
          failureReason: o.last_payment_error?.decline_code ?? o.last_payment_error?.code ?? 'failed', raw: ev,
        };
      case 'charge.refunded':
        return {
          id: ev.id, type: 'refund.succeeded', providerType: ev.type, ref: o.payment_intent, paymentId: o.metadata?.paymentId,
          refundRef: o.refunds?.data?.[0]?.id, amountCents: o.amount_refunded, currency: cur, raw: ev,
        };
      case 'charge.dispute.created':
        return { id: ev.id, type: 'dispute.created', providerType: ev.type, ref: o.payment_intent, amountCents: o.amount, currency: cur, raw: ev };
      default:
        return { id: ev.id, type: 'ignored', providerType: ev.type, ref: null, raw: ev };
    }
  }
  // balance(): Stripe hesabının bakiyesi başka hareketleri de içerdiği için otomatik mutabakatta
  // Balance Transactions raporu kullanılmalı (Faz 2 işi); burada tanımlı değil.
}
