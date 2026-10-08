/**
 * Token kovası hız sınırlayıcı (bellek içi, tek düğüm). Çok düğüme geçişte
 * aynı arayüz Redis ile uygulanır.
 */
export interface RateRule {
  /** Kovadaki en fazla jeton (ani istek kapasitesi). */
  capacity: number;
  /** Saniyede eklenen jeton. */
  refillPerSec: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** İzin verilirse 0, verilmezse yeniden deneme için beklenecek saniye. */
  take(key: string, rule: RateRule): number {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: rule.capacity, at: t };
    b.tokens = Math.min(rule.capacity, b.tokens + ((t - b.at) / 1000) * rule.refillPerSec);
    b.at = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(key, b);
      return 0;
    }
    this.buckets.set(key, b);
    return Math.ceil((1 - b.tokens) / rule.refillPerSec);
  }

  /** Bellek sızıntısını önlemek için eski kovaları temizler. */
  sweep(maxIdleMs = 10 * 60_000): void {
    const t = this.now();
    for (const [k, b] of this.buckets) if (t - b.at > maxIdleMs) this.buckets.delete(k);
  }
}

export const RULES = {
  login: { capacity: 5, refillPerSec: 5 / 60 },
  register: { capacity: 5, refillPerSec: 5 / 3600 },
  api: { capacity: 60, refillPerSec: 20 },
  join: { capacity: 10, refillPerSec: 10 / 60 },
} as const satisfies Record<string, RateRule>;
