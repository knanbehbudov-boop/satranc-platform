import { existsSync } from 'node:fs';
/**
 * Yapılandırma: yalnızca ortam değişkenlerinden okunur, koda gizli anahtar girmez.
 * Geliştirme varsayılanları yalnız NODE_ENV !== 'production' iken geçerlidir;
 * üretimde eksik zorunlu değer başlatmayı durdurur.
 */
export interface Config {
  env: 'development' | 'test' | 'production';
  port: number;
  host: string;
  databaseUrl: string;
  /** Erişim tokeni imzalama anahtarı (HS256). Üretimde en az 32 bayt. */
  jwtSecret: string;
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  /** Geçerli Kullanım Şartları sürümü; kayıtta kabul edilen sürüm saklanır. */
  tosVersion: string;
  /** Geliştirme posta kutusu uç noktası açık mı (gerçek e-posta sağlayıcısı yokken). */
  devMailbox: boolean;
  /** Aynı IP / cihazdan aynı turnuvaya ikinci giriş engeli (doküman 3.7). Yerel testte kapatılır. */
  antiMultiAccount: boolean;
  /** K3: gecikme telafisi üst sınırı. */
  lagCompensationCapMs: number;
  /** İlk hamle için süre (doküman 3.6). */
  firstMoveTimeoutMs: number;
  /** Kopan oyuncunun yeniden bağlanma süresi (doküman 3.6). */
  reconnectTimeoutMs: number;
  /** Stockfish ikili dosyası; yoksa yerleşik motor kullanılır. */
  stockfishPath: string | null;
  /** Sunucunun web arayüzü dosyalarını da sunup sunmayacağı. */
  serveWeb: boolean;
  minAge: number;
  /** Aynı IP'den saatlik kayıt sınırı (çoklu hesap açmayı yavaşlatır). */
  registrationsPerHourPerIp: number;
  /** M7: ödeme sağlayıcısı. 'sandbox' yalnız geliştirme/test içindir; üretimde reddedilir. */
  paymentProvider: 'sandbox' | 'stripe';
  /** Webhook imza anahtarı (Stripe: whsec_…). */
  pspWebhookSecret: string;
  stripeSecretKey: string | null;
  stripeApiBase: string;
  /** Uygulamanın dışarıdan görünen adresi (ödeme dönüş adresleri). Boşsa istek adresi kullanılır. */
  publicBaseUrl: string | null;
  /** Sandbox webhook teslim gecikmesi ve yineleme olasılığı (dayanıklılık testi). */
  sandboxDeliveryDelayMs: number;
  sandboxDuplicateRate: number;
  /** K6: ücretli turnuvaya girmek için insan rakiplere karşı en az rated oyun. */
  paidMinRatedGames: number;
  /** Ücretli kayıtta koltuk rezervasyon süresi (doküman 3.7: 10 dk). */
  seatReservationSec: number;
  /** Ödül bekletme süresini sabitler (yalnız geliştirme/test); boşsa doküman 5.8 tablosu. */
  prizeHoldSec: number | null;
  /** M4b analiz: sabit derinlik (karşılaştırılabilirlik için), MultiPV 3. Stockfish için 18, yerleşik motor için 3. */
  analysisDepth: number;
  analysisMovetimeMs: number;
  analysisWorkers: number;
  /** Açılış hariç tutma: ilk N yarım hamle istatistiğe girmez (doküman: ilk 10 hamle). */
  analysisSkipPlies: number;
  /** Ücretsiz turnuva oyunlarını da analiz et (geliştirme/demo; üretimde maliyet nedeniyle kapalı). */
  analyzeFreeGames: boolean;
  /** K43 cüzdan: tek seferde yüklenebilecek en az / en çok tutar (cent). */
  walletMinDepositCents: number;
  walletMaxDepositCents: number;
  /** K43: en az çekim tutarı (hesap kapatırken uygulanmaz). */
  withdrawMinCents: number;
  /** K43: tahmini çekim komisyonu (banka/sağlayıcı alır, platforma ait değildir). */
  payoutFeeEwalletFixedCents: number;
  payoutFeeEwalletBps: number;
  payoutFeeBankFixedCents: number;
  /** Orta risk: ödül bekletmesine eklenen süre (doküman 14.3). */
  riskMediumExtraHoldSec: number;
  /** Demo araçları (yalnız üretim dışı): ilk iki hesap yönetici, turnuvayı test botlarıyla doldurma. */
  demoTools: boolean;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} sayı olmalı`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v === '1' || v.toLowerCase() === 'true';
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = (process.env.NODE_ENV as Config['env'] | undefined) ?? 'development';
  const prod = env === 'production';
  const required = (name: string, devFallback: string): string => {
    const v = process.env[name];
    if (v) return v;
    if (prod) throw new Error(`${name} üretim ortamında zorunludur`);
    return devFallback;
  };
  const cfg: Config = {
    env,
    port: num('PORT', 8080),
    host: process.env.HOST ?? '127.0.0.1',
    databaseUrl: required('DATABASE_URL', 'postgres://satranc:satranc-dev@127.0.0.1:54329/satranc'),
    jwtSecret: required('JWT_SECRET', 'gelistirme-icin-gizli-anahtar-uretimde-degistirin-000000'),
    accessTokenTtlSec: num('ACCESS_TOKEN_TTL_SEC', 15 * 60),
    refreshTokenTtlSec: num('REFRESH_TOKEN_TTL_SEC', 30 * 24 * 3600),
    tosVersion: process.env.TOS_VERSION ?? '2026-10-01',
    devMailbox: bool('DEV_MAILBOX', !prod),
    antiMultiAccount: bool('ANTI_MULTI_ACCOUNT', prod),
    lagCompensationCapMs: num('LAG_COMP_CAP_MS', 300),
    firstMoveTimeoutMs: num('FIRST_MOVE_TIMEOUT_MS', 60_000),
    reconnectTimeoutMs: num('RECONNECT_TIMEOUT_MS', 60_000),
    stockfishPath: process.env.STOCKFISH_PATH || null,
    serveWeb: bool('SERVE_WEB', true),
    minAge: num('MIN_AGE', 18),
    registrationsPerHourPerIp: num('REGISTRATIONS_PER_HOUR_PER_IP', prod ? 5 : 100),
    paymentProvider: (process.env.PAYMENT_PROVIDER as Config['paymentProvider'] | undefined) ?? (prod ? 'stripe' : 'sandbox'),
    pspWebhookSecret: required('PSP_WEBHOOK_SECRET', 'whsec_gelistirme_sandbox_anahtari'),
    stripeSecretKey: process.env.STRIPE_SECRET_KEY || null,
    stripeApiBase: process.env.STRIPE_API_BASE ?? 'https://api.stripe.com',
    publicBaseUrl: process.env.PUBLIC_BASE_URL || null,
    sandboxDeliveryDelayMs: num('SANDBOX_DELIVERY_DELAY_MS', 300),
    sandboxDuplicateRate: num('SANDBOX_DUPLICATE_RATE', 0.2),
    paidMinRatedGames: num('PAID_MIN_RATED_GAMES', 10),
    seatReservationSec: num('SEAT_RESERVATION_SEC', 600),
    prizeHoldSec: process.env.PRIZE_HOLD_SEC ? num('PRIZE_HOLD_SEC', 0) : null,
    analysisDepth: num('ANALYSIS_DEPTH', process.env.STOCKFISH_PATH ? 18 : 3),
    analysisMovetimeMs: num('ANALYSIS_MOVETIME_MS', 3000),
    analysisWorkers: num('ANALYSIS_WORKERS', 1),
    analysisSkipPlies: num('ANALYSIS_SKIP_PLIES', 20),
    analyzeFreeGames: bool('ANALYZE_FREE_GAMES', false),
    riskMediumExtraHoldSec: num('RISK_MEDIUM_EXTRA_HOLD_SEC', 24 * 3600),
    demoTools: bool('DEMO_TOOLS', false),
    walletMinDepositCents: num('WALLET_MIN_DEPOSIT_CENTS', 2000),
    walletMaxDepositCents: num('WALLET_MAX_DEPOSIT_CENTS', 100_000),
    withdrawMinCents: num('WITHDRAW_MIN_CENTS', 2000),
    payoutFeeEwalletFixedCents: num('PAYOUT_FEE_EWALLET_FIXED_CENTS', 100),
    payoutFeeEwalletBps: num('PAYOUT_FEE_EWALLET_BPS', 100),
    payoutFeeBankFixedCents: num('PAYOUT_FEE_BANK_FIXED_CENTS', 1500),
    ...overrides,
  };
  if (prod && cfg.jwtSecret.length < 32) throw new Error('JWT_SECRET en az 32 karakter olmalı');
  if (prod && cfg.devMailbox) throw new Error('DEV_MAILBOX üretimde açılamaz');
  if (prod && cfg.demoTools) throw new Error('DEMO_TOOLS üretimde açılamaz');
  // Verilen Stockfish yolu yoksa: üretimde hata, geliştirmede yerleşik motora düşülür.
  if (cfg.stockfishPath && !existsSync(cfg.stockfishPath)) {
    if (prod) throw new Error(`STOCKFISH_PATH bulunamadı: ${cfg.stockfishPath}`);
    console.warn(`[uyarı] STOCKFISH_PATH bulunamadı (${cfg.stockfishPath}); yerleşik motor kullanılacak`);
    cfg.stockfishPath = null;
    if (!process.env.ANALYSIS_DEPTH) cfg.analysisDepth = 3;
  }
  // K33: hile analizi sığ yerleşik motorla anlamlı değildir; ücretli turnuva varken üretimde Stockfish şart.
  if (prod && !cfg.stockfishPath) throw new Error('Üretimde STOCKFISH_PATH zorunludur (adil oyun analizi)');
  if (prod && cfg.prizeHoldSec !== null) throw new Error('PRIZE_HOLD_SEC üretimde kullanılamaz (doküman 5.8 süreleri geçerli)');
  if (!['sandbox', 'stripe'].includes(cfg.paymentProvider)) throw new Error('PAYMENT_PROVIDER sandbox ya da stripe olmalı');
  if (prod && cfg.paymentProvider === 'sandbox') throw new Error('Sandbox ödeme sağlayıcısı üretimde kullanılamaz');
  if (cfg.paymentProvider === 'stripe') {
    if (!cfg.stripeSecretKey) throw new Error('PAYMENT_PROVIDER=stripe için STRIPE_SECRET_KEY gerekli');
    if (!cfg.publicBaseUrl) throw new Error('PAYMENT_PROVIDER=stripe için PUBLIC_BASE_URL gerekli');
  }
  return cfg;
}
