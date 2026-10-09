/**
 * Bölge engeli (K49): platform hizmet vermediği ülkelerden (varsayılan: Azerbaycan) kullanılamaz.
 *
 * Nasıl anlaşılır:
 *  - IP adresi: Avrupa/Orta Doğu/Orta Asya IP adreslerini dağıtan resmî bölgesel kayıt kuruluşunun
 *    (RIPE NCC) her gün yayımladığı tahsis listesi indirilir; ülkeye ait aralıklar veritabanına yazılır.
 *    Önde Cloudflare varsa (TRUST_COUNTRY_HEADER=1) onun ülke başlığı da kullanılır.
 *  - Hesabın ülkesi: kayıtta seçilen ülke engelliyse kayıt alınmaz; eski hesaplar ücretli işlem yapamaz.
 *  - Kart: ödeme sağlayıcısı kartı çıkaran bankanın ülkesini bildirir; engelli ülke kartıyla yapılan
 *    ödeme kabul edilmez ve otomatik iade edilir (payments modülü).
 *
 * Engellenen işlemler: kayıt, bakiye yükleme, turnuvaya katılma/ödeme. Para çekme ENGELLENMEZ
 * (kullanıcının içerideki parası her durumda kendisine dönebilmeli). Yönetim ekibi muaf.
 * 'log' kipinde (test sunucusu) hiçbir şey engellenmez, yalnız denetim kaydına yazılır.
 */
import type { IncomingMessage } from 'node:http';
import { isIPv4, isIPv6 } from 'node:net';
import type { Config } from '../../config.ts';
import type { Pool } from '../../infra/db/pg.ts';
import { AppError } from '../../infra/errors.ts';
import type { Logger } from '../../infra/log.ts';

export interface IpKey {
  family: 4 | 6;
  n: bigint;
}

/** IP adresini sayıya çevirir: IPv4 → 32 bit, IPv6 → ilk 48 bit. IPv4-eşlemeli IPv6 IPv4 sayılır. */
export function ipKey(ip: string): IpKey | null {
  let s = ip.trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (mapped) s = mapped[1] as string;
  if (isIPv4(s)) {
    const n = s.split('.').reduce((acc, p) => (acc << 8n) + BigInt(Number(p)), 0n);
    return { family: 4, n };
  }
  if (isIPv6(s)) {
    s = s.replace(/%.*$/, '');
    const [head = '', tail] = s.split('::');
    const h = head ? head.split(':') : [];
    const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
    const groups = tail === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t];
    if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
    const n = groups.slice(0, 3).reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g, 16)), 0n);
    return { family: 6, n };
  }
  return null;
}

export interface GeoRange {
  country: string;
  family: 4 | 6;
  start: bigint;
  end: bigint;
}

/**
 * Bölgesel kayıt kuruluşunun "delegated" dosyasını ayrıştırır:
 *   ripencc|AZ|ipv4|5.10.192.0|8192|20120116|allocated
 *   ripencc|AZ|ipv6|2a00:1d38::|32|20100618|allocated
 */
export function parseDelegated(text: string, countries: ReadonlySet<string>): GeoRange[] {
  const out: GeoRange[] = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const f = line.split('|');
    if (f.length < 7) continue;
    const cc = (f[1] ?? '').toUpperCase();
    if (!countries.has(cc)) continue;
    const status = f[6]?.trim();
    if (status !== 'allocated' && status !== 'assigned') continue;
    const type = f[2];
    const start = f[3] ?? '';
    const value = Number(f[4]);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (type === 'ipv4') {
      const k = ipKey(start);
      if (k?.family !== 4) continue;
      out.push({ country: cc, family: 4, start: k.n, end: k.n + BigInt(value) - 1n });
    } else if (type === 'ipv6') {
      const k = ipKey(start);
      if (k?.family !== 6 || value > 128) continue;
      const span = value >= 48 ? 1n : 1n << BigInt(48 - value);
      out.push({ country: cc, family: 6, start: k.n, end: k.n + span - 1n });
    }
  }
  return out;
}

export const REGION_BLOCKED = 'REGION_BLOCKED';

export class GeoService {
  private readonly pool: Pool;
  private readonly cfg: Config;
  private readonly logger: Logger;
  private readonly blocked: Set<string>;
  private readonly cache = new Map<string, { cc: string | null; at: number }>();
  private timer: NodeJS.Timeout | null = null;
  /** Testler indirme işlevini değiştirebilir. */
  fetchText: (url: string) => Promise<string> = async (url) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`IP listesi indirilemedi: HTTP ${r.status}`);
    return r.text();
  };

  constructor(deps: { pool: Pool; cfg: Config; logger: Logger }) {
    this.pool = deps.pool;
    this.cfg = deps.cfg;
    this.logger = deps.logger;
    this.blocked = new Set(deps.cfg.geoBlockedCountries);
  }

  get enforcing(): boolean {
    return this.cfg.geoBlockMode === 'enforce' && this.blocked.size > 0;
  }

  isBlockedCountry(cc: string | null | undefined): boolean {
    return !!cc && this.blocked.has(cc.toUpperCase());
  }

  start(): void {
    if (!this.cfg.geoDataUrl || !this.blocked.size || this.timer) return;
    const run = () => void this.refreshIfStale().catch((e) => this.logger.warn('IP ülke listesi yenilenemedi', { error: e instanceof Error ? e.message : String(e) }));
    run();
    this.timer = setInterval(run, 6 * 3600_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async refreshIfStale(): Promise<void> {
    const r = await this.pool.query<{ value: string }>(`SELECT value FROM app_secrets WHERE key = 'geo_refreshed_at'`);
    const last = r.rows[0] ? Date.parse(r.rows[0].value) : 0;
    if (Date.now() - last < 20 * 3600_000) return;
    await this.refresh();
  }

  /** IP listesini indirip tabloyu yeniler. Dönen: yazılan aralık sayısı. */
  async refresh(): Promise<number> {
    if (!this.cfg.geoDataUrl) return 0;
    const ranges = parseDelegated(await this.fetchText(this.cfg.geoDataUrl), this.blocked);
    if (!ranges.length) throw new Error('IP listesinde engelli ülkelere ait aralık bulunamadı; tablo değiştirilmedi');
    await this.pool.tx(async (tx) => {
      await tx.query('DELETE FROM geo_ip_ranges');
      for (let i = 0; i < ranges.length; i += 500) {
        const part = ranges.slice(i, i + 500);
        const vals = part.map((_, j) => `($${j * 4 + 1}::smallint, $${j * 4 + 2}::bigint, $${j * 4 + 3}::bigint, $${j * 4 + 4})`).join(',');
        await tx.query(
          `INSERT INTO geo_ip_ranges (family, start_ip, end_ip, country) VALUES ${vals} ON CONFLICT (family, start_ip) DO UPDATE SET end_ip = EXCLUDED.end_ip, country = EXCLUDED.country`,
          part.flatMap((x) => [x.family, x.start.toString(), x.end.toString(), x.country]),
        );
      }
      await tx.query(
        `INSERT INTO app_secrets (key, value) VALUES ('geo_refreshed_at', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [new Date().toISOString()],
      );
    });
    this.cache.clear();
    this.logger.info('IP ülke listesi yenilendi', { ranges: ranges.length });
    return ranges.length;
  }

  /** IP'nin ülkesi (yalnız engelli ülkeler tabloda; diğerleri için null). */
  async countryOfIp(ip: string): Promise<string | null> {
    const hit = this.cache.get(ip);
    if (hit && Date.now() - hit.at < 3600_000) return hit.cc;
    const k = ipKey(ip);
    let cc: string | null = null;
    if (k) {
      const r = await this.pool.query<{ country: string; end_ip: string }>(
        'SELECT country, end_ip FROM geo_ip_ranges WHERE family = $1 AND start_ip <= $2 ORDER BY start_ip DESC LIMIT 1',
        [k.family, k.n.toString()],
      );
      const row = r.rows[0];
      if (row && BigInt(row.end_ip) >= k.n) cc = row.country.trim();
    }
    if (this.cache.size > 20_000) this.cache.clear();
    this.cache.set(ip, { cc, at: Date.now() });
    return cc;
  }

  /** İsteğin geldiği ülke: güvenilen başlık varsa o, yoksa IP listesi. */
  async requestCountry(ctx: { ip: string; req?: IncomingMessage }): Promise<string | null> {
    if (this.cfg.trustCountryHeader) {
      const h = ctx.req?.headers['cf-ipcountry'];
      if (typeof h === 'string' && /^[A-Z]{2}$/i.test(h)) return h.toUpperCase();
    }
    return this.countryOfIp(ctx.ip);
  }

  /**
   * İşleme izin var mı? Engelliyse ve kip 'enforce' ise REGION_BLOCKED hatası atar; her durumda
   * denetim kaydına yazar. Yönetim ekibi muaftır.
   */
  async assertAllowed(
    ctx: { ip: string; req?: IncomingMessage },
    action: 'register' | 'deposit' | 'join' | 'pay',
    who: { userId?: string; roles?: readonly string[]; countryCode?: string | null } = {},
  ): Promise<void> {
    if (!this.blocked.size) return;
    let roles = who.roles ?? [];
    let accountCountry = who.countryCode ?? null;
    if (who.userId) {
      // Güncel roller ve ülke veritabanından (erişim belirtecindeki roller eski olabilir).
      const r = await this.pool.query<{ country_code: string; roles: string[] }>('SELECT country_code, roles FROM users WHERE id = $1', [who.userId]);
      roles = r.rows[0]?.roles ?? roles;
      accountCountry ??= r.rows[0]?.country_code ?? null;
    }
    if (roles.some((r) => r !== 'player')) return;
    const ipCountry = await this.requestCountry(ctx);
    const by = this.isBlockedCountry(ipCountry) ? 'ip' : this.isBlockedCountry(accountCountry) ? 'account' : null;
    if (!by) return;
    await this.pool.query(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id, data, ip) VALUES ($1::uuid, 'geo.blocked', 'user', $2::text, $3, $4)`,
      [who.userId ?? null, who.userId ?? '-', { action, by, ipCountry, accountCountry, mode: this.cfg.geoBlockMode }, ctx.ip],
    );
    if (!this.enforcing) return;
    if (action === 'register' && by === 'account') throw new AppError(403, REGION_BLOCKED, 'Bu ülkeden kayıt kabul edilmiyor');
    throw new AppError(403, REGION_BLOCKED, 'Platformumuz bulunduğun bölgede hizmet vermiyor');
  }
}
