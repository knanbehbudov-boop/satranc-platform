/**
 * Ödül matematiği (doküman 3.9, 5.1, 5.7). Saf: veritabanı yok, tamsayı cent.
 *  - Komisyon brüt üzerinden alınır, aşağı yuvarlanır (oyuncu lehine); PSP ücreti
 *    komisyondan karşılanır (Yaklaşım A, K9).
 *  - Her pay aşağı yuvarlanır; yuvarlama artığı şampiyona eklenir (K4).
 *  - Sahibi olmayan pay (ör. yarı finalde iki oyuncu da gelmedi) şampiyona eklenir (K27).
 *  - Dağıtılan toplam her zaman havuza eşittir; 1 cent bile fark olmaz.
 */

export interface PrizeGroup {
  /** Sıralama (K8): 1, 2, 3, 5, 9, 17 */
  rank: number;
  /** Bu sıralamadaki oyuncu sayısı (3.-4. için 2). */
  count: number;
  /** Kişi başı pay, baz puan (10000 = %100). */
  bpsEach: number;
}

export const DEFAULT_SCHEMES: Readonly<Record<number, readonly PrizeGroup[]>> = {
  4: [{ rank: 1, count: 1, bpsEach: 7000 }, { rank: 2, count: 1, bpsEach: 3000 }],
  8: [{ rank: 1, count: 1, bpsEach: 5500 }, { rank: 2, count: 1, bpsEach: 2500 }, { rank: 3, count: 2, bpsEach: 1000 }],
  16: [{ rank: 1, count: 1, bpsEach: 4000 }, { rank: 2, count: 1, bpsEach: 2000 }, { rank: 3, count: 2, bpsEach: 1000 }, { rank: 5, count: 4, bpsEach: 500 }],
  32: [
    { rank: 1, count: 1, bpsEach: 3000 }, { rank: 2, count: 1, bpsEach: 1600 }, { rank: 3, count: 2, bpsEach: 800 },
    { rank: 5, count: 4, bpsEach: 400 }, { rank: 9, count: 8, bpsEach: 275 },
  ],
};

export function validateScheme(scheme: readonly PrizeGroup[], capacity: number): void {
  const total = scheme.reduce((s, g) => s + g.count * g.bpsEach, 0);
  if (total !== 10_000) throw new Error(`Ödül şablonu %100 etmiyor: ${total / 100}%`);
  const ranks = scheme.map((g) => g.rank);
  if (ranks[0] !== 1) throw new Error('Ödül şablonu 1. sırayı içermeli');
  const seats = scheme.reduce((s, g) => s + g.count, 0);
  if (seats > capacity) throw new Error('Ödül alan kişi sayısı kontenjandan fazla');
  for (const g of scheme) if (!Number.isInteger(g.bpsEach) || g.bpsEach <= 0) throw new Error('Pay pozitif tamsayı baz puan olmalı');
}

export function schemeFor(capacity: number, custom?: unknown): readonly PrizeGroup[] {
  if (custom && Array.isArray(custom) && custom.length) {
    const scheme = custom as PrizeGroup[];
    validateScheme(scheme, capacity);
    return scheme;
  }
  const s = DEFAULT_SCHEMES[capacity];
  if (!s) throw new Error(`Bu kontenjan için ödül şablonu yok: ${capacity}`);
  return s;
}

export interface Split {
  grossCents: number;
  rakeCents: number;
  poolCents: number;
}

export function splitGross(entryFeeCents: number, paidEntries: number, rakeBps: number): Split {
  if (!Number.isSafeInteger(entryFeeCents) || entryFeeCents < 0) throw new Error('Giriş ücreti geçersiz');
  if (rakeBps < 0 || rakeBps > 3000) throw new Error('Komisyon 0–%30 arası olmalı');
  const grossCents = entryFeeCents * paidEntries;
  const rakeCents = Math.floor((grossCents * rakeBps) / 10_000);
  return { grossCents, rakeCents, poolCents: grossCents - rakeCents };
}

export interface Award {
  userId: string;
  rank: number;
  cents: number;
}

/**
 * Havuzu kesinleşmiş sıralamaya göre dağıtır. `ranks`: kullanıcı → final sırası.
 */
export function distribute(poolCents: number, scheme: readonly PrizeGroup[], ranks: ReadonlyMap<string, number>): Award[] {
  const champion = [...ranks].find(([, r]) => r === 1)?.[0];
  if (!champion) throw new Error('Şampiyon olmadan ödül dağıtılamaz');
  const awards = new Map<string, Award>();
  let paid = 0;
  for (const g of scheme) {
    const each = Math.floor((poolCents * g.bpsEach) / 10_000);
    const holders = [...ranks].filter(([, r]) => r === g.rank).map(([u]) => u).sort();
    for (const u of holders.slice(0, g.count)) {
      awards.set(u, { userId: u, rank: g.rank, cents: each });
      paid += each;
    }
  }
  // Yuvarlama artığı (K4) ve sahipsiz paylar (K27) şampiyona.
  const rest = poolCents - paid;
  const c = awards.get(champion) as Award;
  c.cents += rest;
  const out = [...awards.values()].filter((a) => a.cents > 0).sort((a, b) => a.rank - b.rank || a.userId.localeCompare(b.userId));
  const sum = out.reduce((s, a) => s + a.cents, 0);
  if (sum !== poolCents) throw new Error(`Dağıtım havuza eşit değil: ${sum} ≠ ${poolCents}`);
  return out;
}

/**
 * Ödül bekletme süresi (doküman 5.8): < 50 USD 12 sa, 50–500 USD 24 sa, 500+ USD 48 sa.
 * Alt sınırlar kullanılır; risk skoru düşükse erken serbest bırakma M10'un işidir.
 */
export function holdSecondsFor(amountCents: number): number {
  if (amountCents < 5_000) return 12 * 3600;
  if (amountCents < 50_000) return 24 * 3600;
  return 48 * 3600;
}

export function formatMoney(cents: number, currency: string): string {
  const sign = cents < 0 ? '-' : '';
  const v = Math.abs(cents);
  return `${sign}${Math.floor(v / 100)}.${String(v % 100).padStart(2, '0')} ${currency}`;
}
