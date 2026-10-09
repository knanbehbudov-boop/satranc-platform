/**
 * M1 Kimlik ve hesap: kayıt, e-posta doğrulama, giriş, oturum yenileme
 * (dönen yenileme tokeni + çalıntı tespiti), çıkış, cihaz kaydı.
 * Diğer modüller kullanıcıya yalnızca bu servis üzerinden erişir.
 */
import { randomUUID } from 'node:crypto';
import type { Config } from '../../config.ts';
import type { Pool, Queryable } from '../../infra/db/pg.ts';
import { DbError } from '../../infra/db/pg.ts';
import { AppError, badRequest, conflict, forbidden, unauthorized } from '../../infra/errors.ts';
import { publish } from '../../infra/events/outbox.ts';
import type { AuthUser } from '../../infra/http/router.ts';
import {
  DUMMY_HASH,
  hashPassword,
  needsRehash,
  passwordProblem,
  randomToken,
  sha256,
  signAccessToken,
  verifyAccessToken,
  verifyPassword,
} from './crypto.ts';

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  countryCode: string;
  status: string;
  roles: string[];
  emailVerified: boolean;
  createdAt: string;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  country_code: string;
  birth_year: number;
  status: string;
  roles: string[];
  email_verified_at: Date | null;
  created_at: Date;
  closing_requested_at?: Date | null;
  closed_at?: Date | null;
}

export interface RequestMeta {
  ip: string;
  userAgent: string;
  deviceKey: string | null;
}

export interface LoginResult {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

function toPublic(u: UserRow): PublicUser {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    countryCode: u.country_code,
    status: u.status,
    roles: u.roles,
    emailVerified: u.email_verified_at !== null,
    createdAt: u.created_at.toISOString(),
  };
}

/** Tam doğum tarihinden yaş; tarih yalnız kontrol için kullanılır, saklanmaz (veri en aza indirme). */
export function ageOn(birthDate: string, today: Date): number {
  const [y, m, d] = birthDate.split('-').map(Number) as [number, number, number];
  let age = today.getUTCFullYear() - y;
  const beforeBirthday = today.getUTCMonth() + 1 < m || (today.getUTCMonth() + 1 === m && today.getUTCDate() < d);
  if (beforeBirthday) age--;
  return age;
}

export class IdentityService {
  private readonly pool: Pool;
  private readonly cfg: Config;

  constructor(pool: Pool, cfg: Config) {
    this.pool = pool;
    this.cfg = cfg;
  }

  authenticate = (token: string): AuthUser | null => {
    const c = verifyAccessToken(token, this.cfg.jwtSecret);
    return c ? { id: c.sub, roles: c.roles, sessionId: c.sid } : null;
  };

  async register(
    input: { email: string; password: string; displayName: string; birthDate: string; countryCode: string; acceptTos: boolean },
    meta: RequestMeta,
  ): Promise<PublicUser> {
    const birth = new Date(`${input.birthDate}T00:00:00Z`);
    if (Number.isNaN(birth.getTime())) throw badRequest('VALIDATION', 'Doğum tarihi geçersiz', { fields: { birthDate: 'biçim geçersiz' } });
    const age = ageOn(input.birthDate, new Date());
    if (age < this.cfg.minAge) {
      // Reşit olmayan kişinin verisi saklanmaz (doküman 7.5).
      throw new AppError(403, 'AGE_RESTRICTED', `Kayıt için en az ${this.cfg.minAge} yaşında olmalısınız`);
    }
    if (age > 120) throw badRequest('VALIDATION', 'Doğum tarihi geçersiz', { fields: { birthDate: 'geçersiz' } });
    const problem = passwordProblem(input.password, [input.email.split('@')[0] ?? '', input.displayName]);
    if (problem) throw badRequest('WEAK_PASSWORD', `Şifre ${problem}`, { fields: { password: problem } });

    const hash = await hashPassword(input.password);
    try {
      return await this.pool.tx(async (tx) => {
        const r = await tx.query<UserRow>(
          `INSERT INTO users (email, display_name, password_hash, country_code, birth_year, tos_version, tos_accepted_at)
           VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING *`,
          [input.email, input.displayName, hash, input.countryCode, birth.getUTCFullYear(), this.cfg.tosVersion],
        );
        let user = r.rows[0] as UserRow;
        if (this.cfg.demoTools) {
          // Demo: ilk iki gerçek hesap yönetici olur (dört göz onayı iki kişi ister).
          const admins = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE 'admin' = ANY(roles)`);
          if ((admins.rows[0] as { n: number }).n < 2) {
            user = (await tx.query<UserRow>(`UPDATE users SET roles = '{player,admin}' WHERE id = $1 RETURNING *`, [user.id])).rows[0] as UserRow;
          }
        }
        await this.issueEmailToken(tx, user);
        await tx.query(
          `INSERT INTO audit_log (actor_id, action, target_type, target_id, data, ip) VALUES ($1::uuid, 'user.register', 'user', $1::text, $2, $3)`,
          [user.id, { tosVersion: this.cfg.tosVersion, deviceKey: meta.deviceKey }, meta.ip],
        );
        await publish(tx, 'user.registered', { userId: user.id });
        return toPublic(user);
      });
    } catch (e) {
      if (e instanceof DbError && e.code === '23505') {
        const field = e.constraint === 'users_display_name_uq' ? 'displayName' : 'email';
        throw conflict(field === 'email' ? 'EMAIL_TAKEN' : 'DISPLAY_NAME_TAKEN', field === 'email' ? 'Bu e-posta ile kayıtlı bir hesap var' : 'Bu kullanıcı adı alınmış', { fields: { [field]: 'kullanımda' } });
      }
      throw e;
    }
  }

  private async issueEmailToken(q: Queryable, user: UserRow): Promise<void> {
    const token = randomToken();
    await q.query(
      `INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at) VALUES ($1, $2, 'verify_email', now() + interval '48 hours')`,
      [sha256(token), user.id],
    );
    await q.query(
      `INSERT INTO mail_outbox (to_email, template, subject, body, data) VALUES ($1, 'verify_email', $2, $3, $4)`,
      [
        user.email,
        'E-posta adresinizi doğrulayın',
        `Merhaba ${user.display_name}, hesabınızı doğrulamak için bağlantıyı açın: /#/dogrula?token=${token}\nBağlantı 48 saat geçerlidir.`,
        { token, displayName: user.display_name },
      ],
    );
  }

  async resendVerification(userId: string): Promise<void> {
    const u = await this.getRow(userId);
    if (u.email_verified_at) return;
    await this.issueEmailToken(this.pool, u);
  }

  async verifyEmail(token: string): Promise<PublicUser> {
    return this.pool.tx(async (tx) => {
      const r = await tx.query<{ user_id: string }>(
        `UPDATE email_tokens SET used_at = now()
         WHERE token_hash = $1 AND purpose = 'verify_email' AND used_at IS NULL AND expires_at > now()
         RETURNING user_id`,
        [sha256(token)],
      );
      const row = r.rows[0];
      if (!row) throw badRequest('INVALID_TOKEN', 'Doğrulama bağlantısı geçersiz ya da süresi dolmuş');
      const u = await tx.query<UserRow>(
        'UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1 RETURNING *',
        [row.user_id],
      );
      await publish(tx, 'user.email_verified', { userId: row.user_id });
      return toPublic(u.rows[0] as UserRow);
    });
  }

  async login(email: string, password: string, meta: RequestMeta): Promise<LoginResult> {
    const r = await this.pool.query<UserRow>('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
    const user = r.rows[0];
    const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) {
      if (user) await this.audit(user.id, 'user.login_failed', meta);
      throw unauthorized('INVALID_CREDENTIALS', 'E-posta veya şifre hatalı');
    }
    if (user.status === 'banned' || user.status === 'frozen') {
      throw forbidden('ACCOUNT_LOCKED', user.status === 'banned' ? 'Hesap kapatılmış' : 'Hesap geçici olarak dondurulmuş');
    }
    if (user.closed_at) throw forbidden('ACCOUNT_CLOSED', 'Bu hesap kullanıcının isteğiyle kapatıldı');
    if (needsRehash(user.password_hash)) {
      await this.pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(password)]);
    }
    const deviceId = await this.recordDevice(user.id, meta);
    const familyId = randomUUID();
    const { refreshToken, sessionId } = await this.createSession(this.pool, user.id, familyId, deviceId, meta);
    await this.audit(user.id, 'user.login', meta, { deviceId });
    return {
      user: toPublic(user),
      accessToken: this.access(user, sessionId),
      refreshToken,
      expiresIn: this.cfg.accessTokenTtlSec,
    };
  }

  private access(user: { id: string; roles: string[] }, sessionId: string): string {
    return signAccessToken({ sub: user.id, sid: sessionId, roles: user.roles }, this.cfg.jwtSecret, this.cfg.accessTokenTtlSec);
  }

  private async createSession(q: Queryable, userId: string, familyId: string, deviceId: string | null, meta: RequestMeta) {
    const refreshToken = randomToken(32);
    const r = await q.query<{ id: string }>(
      `INSERT INTO sessions (user_id, family_id, refresh_hash, device_id, ip, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7)) RETURNING id`,
      [userId, familyId, sha256(refreshToken), deviceId, meta.ip, meta.userAgent, this.cfg.refreshTokenTtlSec],
    );
    return { refreshToken, sessionId: (r.rows[0] as { id: string }).id };
  }

  /**
   * Yenileme tokeni her kullanımda değişir. Daha önce kullanılmış (döndürülmüş) bir
   * token tekrar gelirse token çalınmış kabul edilir ve o oturum ailesinin tamamı kapatılır.
   */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<LoginResult> {
    // Kapatma kararları işlem içinde verilir ama hata işlemden SONRA fırlatılır;
    // aksi halde hata geri almaya (ROLLBACK) yol açar ve kapatma kaybolur.
    const outcome = await this.pool.tx(async (tx) => {
      const r = await tx.query<{ id: string; user_id: string; family_id: string; device_id: string | null; rotated_at: Date | null; revoked_at: Date | null; expires_at: Date }>(
        'SELECT * FROM sessions WHERE refresh_hash = $1 FOR UPDATE',
        [sha256(refreshToken)],
      );
      const s = r.rows[0];
      if (!s) return { kind: 'invalid' as const };
      if (s.rotated_at || s.revoked_at) {
        await tx.query('UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE family_id = $1', [s.family_id]);
        await tx.query(
          `INSERT INTO audit_log (actor_id, action, target_type, target_id, data, ip) VALUES ($1::uuid, 'session.reuse_detected', 'session', $2::text, '{}', $3)`,
          [s.user_id, s.family_id, meta.ip],
        );
        return { kind: 'reused' as const };
      }
      if (s.expires_at.getTime() <= Date.now()) return { kind: 'expired' as const };
      const u = await tx.query<UserRow>('SELECT * FROM users WHERE id = $1', [s.user_id]);
      const user = u.rows[0] as UserRow;
      if (user.status === 'banned' || user.status === 'frozen') {
        await tx.query('UPDATE sessions SET revoked_at = now() WHERE family_id = $1', [s.family_id]);
        return { kind: 'locked' as const };
      }
      await tx.query('UPDATE sessions SET rotated_at = now() WHERE id = $1', [s.id]);
      const next = await this.createSession(tx, user.id, s.family_id, s.device_id, meta);
      return {
        kind: 'ok' as const,
        result: { user: toPublic(user), accessToken: this.access(user, next.sessionId), refreshToken: next.refreshToken, expiresIn: this.cfg.accessTokenTtlSec },
      };
    });
    switch (outcome.kind) {
      case 'ok': return outcome.result;
      case 'invalid': throw unauthorized('INVALID_SESSION', 'Oturum bulunamadı');
      case 'reused': throw unauthorized('SESSION_REVOKED', 'Oturum sonlandırıldı; tekrar giriş yapın');
      case 'expired': throw unauthorized('SESSION_EXPIRED', 'Oturum süresi doldu');
      case 'locked': throw forbidden('ACCOUNT_LOCKED', 'Hesap kilitli');
    }
  }

  async logout(refreshToken: string | undefined, sessionId: string | undefined): Promise<void> {
    if (refreshToken) {
      await this.pool.query(
        `UPDATE sessions SET revoked_at = now() WHERE family_id = (SELECT family_id FROM sessions WHERE refresh_hash = $1) AND revoked_at IS NULL`,
        [sha256(refreshToken)],
      );
    } else if (sessionId) {
      await this.pool.query(
        `UPDATE sessions SET revoked_at = now() WHERE family_id = (SELECT family_id FROM sessions WHERE id = $1) AND revoked_at IS NULL`,
        [sessionId],
      );
    }
  }

  async listSessions(userId: string, currentSessionId: string) {
    const r = await this.pool.query<{ family_id: string; ip: string; user_agent: string; created_at: Date; last_used: Date; current: boolean }>(
      `SELECT family_id, (array_agg(ip ORDER BY created_at DESC))[1] AS ip,
              (array_agg(user_agent ORDER BY created_at DESC))[1] AS user_agent,
              min(created_at) AS created_at, max(created_at) AS last_used,
              bool_or(id = $2) AS current
       FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
       GROUP BY family_id ORDER BY max(created_at) DESC`,
      [userId, currentSessionId],
    );
    return r.rows.map((s) => ({ id: s.family_id, ip: s.ip, userAgent: s.user_agent, createdAt: s.created_at, lastUsedAt: s.last_used, current: s.current }));
  }

  async revokeSessionFamily(userId: string, familyId: string): Promise<void> {
    const r = await this.pool.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND family_id = $2 AND revoked_at IS NULL', [userId, familyId]);
    if (!r.rowCount) throw new AppError(404, 'NOT_FOUND', 'Oturum bulunamadı');
  }

  /** Oturum hâlâ geçerli mi? (WebSocket bağlantısında ve hassas işlemlerde kullanılır.) */
  async sessionActive(sessionId: string): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.family_id = (SELECT family_id FROM sessions WHERE id = $1)
         AND s.revoked_at IS NULL AND u.status NOT IN ('banned', 'frozen') LIMIT 1`,
      [sessionId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async me(userId: string): Promise<PublicUser> {
    return toPublic(await this.getRow(userId));
  }

  async getRow(userId: string): Promise<UserRow> {
    const r = await this.pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
    const u = r.rows[0];
    if (!u) throw new AppError(404, 'NOT_FOUND', 'Kullanıcı bulunamadı');
    return u;
  }

  /** Oyun ve turnuva modüllerinin ihtiyaç duyduğu özet bilgiler. */
  async publicProfiles(ids: string[]): Promise<Map<string, { id: string; displayName: string; countryCode: string }>> {
    if (!ids.length) return new Map();
    const r = await this.pool.query<{ id: string; display_name: string; country_code: string }>(
      'SELECT id, display_name, country_code FROM users WHERE id = ANY($1)',
      [ids],
    );
    return new Map(r.rows.map((u) => [u.id, { id: u.id, displayName: u.display_name, countryCode: u.country_code }]));
  }

  /** Turnuva katılımı gibi işlemlerden önce: hesap durumu ve doğrulama kontrolü. */
  async assertCanCompete(userId: string): Promise<UserRow> {
    const u = await this.getRow(userId);
    if (u.status !== 'active') throw forbidden('ACCOUNT_RESTRICTED', 'Hesabınız turnuvaya katılamaz');
    if (u.closing_requested_at || u.closed_at) throw forbidden('ACCOUNT_CLOSING', 'Hesabınız kapatılıyor; yeni turnuvaya katılamazsınız');
    if (!u.email_verified_at) throw forbidden('EMAIL_NOT_VERIFIED', 'Turnuvaya katılmak için e-posta adresinizi doğrulayın');
    return u;
  }

  /**
   * Hesabı dondurur (ters ibraz, hile şüphesi, yönetici kararı). Açık oturumlar
   * sessionActive kontrolüyle düşer; aynı işlemde denetim kaydı yazılır.
   */
  async setStatus(q: Queryable, userId: string, status: 'active' | 'frozen' | 'banned', reason: string, actorId: string | null): Promise<boolean> {
    const cur = await q.query<{ status: string }>('SELECT status FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const old = cur.rows[0]?.status;
    // Kendini dışlama yalnız kullanıcının kendi süreciyle kalkar (doküman 5.10).
    if (!old || old === status || old === 'self_excluded') return false;
    await q.query('UPDATE users SET status = $2 WHERE id = $1', [userId, status]);
    await q.query(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id, data) VALUES ($1::uuid, $2, 'user', $3::text, $4)`,
      [actorId, `user.${status}`, userId, { reason, from: old }],
    );
    await publish(q, 'user.status', { userId, status, reason });
    return true;
  }

  private async recordDevice(userId: string, meta: RequestMeta): Promise<string | null> {
    if (!meta.deviceKey) return null;
    const r = await this.pool.query<{ id: string }>(
      `INSERT INTO devices (user_id, device_key, first_ip, last_ip, user_agent) VALUES ($1, $2, $3, $3, $4)
       ON CONFLICT (user_id, device_key) DO UPDATE SET last_ip = EXCLUDED.last_ip, last_seen = now(), user_agent = EXCLUDED.user_agent
       RETURNING id`,
      [userId, meta.deviceKey, meta.ip, meta.userAgent],
    );
    return (r.rows[0] as { id: string }).id;
  }

  private async audit(userId: string, action: string, meta: RequestMeta, data: Record<string, unknown> = {}): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id, data, ip) VALUES ($1::uuid, $2, 'user', $1::text, $3, $4)`,
      [userId, action, { ...data, deviceKey: meta.deviceKey, userAgent: meta.userAgent }, meta.ip],
    );
  }

  /** Geliştirme posta kutusu: son postalar (yalnız DEV_MAILBOX açıkken rotası vardır). */
  async devMailbox(email: string) {
    const r = await this.pool.query<{ id: number; subject: string; body: string; data: { token?: string }; created_at: Date }>(
      'SELECT id, subject, body, data, created_at FROM mail_outbox WHERE lower(to_email) = lower($1) ORDER BY id DESC LIMIT 10',
      [email],
    );
    return r.rows.map((m) => ({ id: m.id, subject: m.subject, body: m.body, token: m.data.token ?? null, createdAt: m.created_at }));
  }
}
