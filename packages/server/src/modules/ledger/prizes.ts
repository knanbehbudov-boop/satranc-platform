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
  /** Kişi başı pay, baz puan (10000 = %100). `share` verilmişse kullanılmaz. */
  bpsEach?: number;
  /** Kişi başı pay, tam kesir [pay, payda] — havuzun tam oranı (ör. 2/9). */
  share?: readonly [number, number];
}

/** Bir payın havuz içindeki kesri. */
export function shareOf(g: PrizeGroup): [number, number] {
  if (g.share) return [g.share[0], g.share[1]];
  return [g.bpsEach ?? 0, 10_000];
}

/** Kişi başı pay (cent), aşağı yuvarlanır. */
export function shareCents(poolCents: number, g: PrizeGroup): number {
  const [n, d] = shareOf(g);
  return Math.floor((poolCents * n) / d);
}

/**
 * Varsayılan ödül şablonları. Sistem payı (%10) havuzdan önce alınır; havuz brütün %90'ıdır.
 *  - 4 kişi: tüm havuz birinciye (brütün %90'ı).
 *  - 8 ve 16 kişi: birinci brütün %70'i (havuzun 7/9'u), ikinci brütün %20'si (havuzun 2/9'u).
 *  - 32 kişi: ilk sürümde kapalı; şablon ileride açılmak üzere 8/16 ile aynı.
 */
export const DEFAULT_SCHEMES: Readonly<Record<number, readonly PrizeGroup[]>> = {
  4: [{ rank: 1, count: 1, share: [1, 1] }],
  8: [{ rank: 1, count: 1, share: [7, 9] }, { rank: 2, count: 1, share: [2, 9] }],
  16: [{ rank: 1, count: 1, share: [7, 9] }, { rank: 2, count: 1, share: [2, 9] }],
  32: [{ rank: 1, count: 1, share: [7, 9] }, { rank: 2, count: 1, share: [2, 9] }],
};

/** Platform payı: brütün %10'u. */
export const PLATFORM_RAKE_BPS = 1000;

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : Math.abs(a);
}

export function validateScheme(scheme: readonly PrizeGroup[], capacity: number): void {
  // Tam kesir toplamı: Σ count·n/d = 1 olmalı.
  let num = 0;
  let den = 1;
  for (const g of scheme) {
    const [n, d] = shareOf(g);
    if (!Number.isInteger(n) || !Number.isInteger(d) || n <= 0 || d <= 0) throw new Error('Pay pozitif tam kesir olmalı');
    num = num * d + g.count * n * den;
    den = den * d;
    const k = gcd(num, den);
    num /= k;
    den /= k;
  }
  if (num !== den) throw new Error(`Ödül şablonu %100 etmiyor: ${((num / den) * 100).toFixed(2)}%`);
  const ranks = scheme.map((g) => g.rank);
  if (ranks[0] !== 1) throw new Error('Ödül şablonu 1. sırayı içermeli');
  const seats = scheme.reduce((s, g) => s + g.count, 0);
  if (seats > capacity) throw new Error('Ödül alan kişi sayısı kontenjandan fazla');
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
    const each = shareCents(poolCents, g);
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
