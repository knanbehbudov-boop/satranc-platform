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
    ...overrides,
  };
  if (prod && cfg.jwtSecret.length < 32) throw new Error('JWT_SECRET en az 32 karakter olmalı');
  if (prod && cfg.devMailbox) throw new Error('DEV_MAILBOX üretimde açılamaz');
  return cfg;
}
