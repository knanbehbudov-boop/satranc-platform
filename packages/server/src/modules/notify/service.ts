/**
 * Bildirimler (K46).
 *
 * Kayıtlı oyuncuya (izin gerekmez — hizmetin parçası):
 *  - Turnuvaya kaydı alınınca e-posta.
 *  - Turnuva dolup başlarken ("Hazırım" de) telefon bildirimi; uygulama kapalıysa e-posta da.
 *  - Sıradaki maçı başlarken telefon bildirimi.
 *  - Ödül çekilebilir olunca, çekim ödenince/reddedilince e-posta.
 * Yeni turnuva duyuruları yalnız izin verene (kayıtta kutucuk boş gelir), günde en fazla bir özet
 * e-posta, kullanıcının sık oynadığı turnuvalar önce; her e-postada abonelikten çıkma bağlantısı.
 *
 * Telefon bildirimi Web Push ile gider; tarayıcı uygulamayı açık ve önde görüyorsa servis çalışanı
 * bildirimi göstermez (çift uyarı olmaz). E-posta SMTP ile (Gmail uygulama şifresiyle de olur).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from '../../config.ts';
import type { Pool, Queryable } from '../../infra/db/pg.ts';
import { badRequest } from '../../infra/errors.ts';
import { asLocale, emailText, localizeRound, localizeTournamentName, type EmailTexts, type Locale } from '../../infra/i18n.ts';
import type { Logger } from '../../infra/log.ts';
import { sendMail, type MailMessage, type SmtpOptions } from '../../infra/mail/smtp.ts';
import { generateVapidKeys, sendPush, type VapidKeys } from '../../infra/push/webpush.ts';
import type { WsHub } from '../../infra/ws/hub.ts';

const MAX_MAIL_ATTEMPTS = 6;

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

export class NotificationService {
  private readonly pool: Pool;
  private readonly cfg: Config;
  private readonly logger: Logger;
  private readonly hub: WsHub;
  private vapidKeys: VapidKeys | null = null;
  private mailTimer: NodeJS.Timeout | null = null;
  private digestTimer: NodeJS.Timeout | null = null;
  private sending = false;
  /** Testler gönderimi yakalamak için değiştirebilir. */
  mailer: ((m: MailMessage) => Promise<void>) | null;
  pusher: (sub: { endpoint: string; p256dh: string; auth: string }, payload: PushPayload, keys: VapidKeys) => Promise<number>;

  constructor(deps: { pool: Pool; cfg: Config; logger: Logger; hub: WsHub }) {
    this.pool = deps.pool;
    this.cfg = deps.cfg;
    this.logger = deps.logger;
    this.hub = deps.hub;
    // Kimlik bilgisi olmadan yalnız yerel SMTP'ye gönderilir (Gmail gibi servisler şifre ister).
    const canSend = !!deps.cfg.smtpHost && ((!!deps.cfg.smtpUser && !!deps.cfg.smtpPass) || /^(localhost|127\.0\.0\.1)$/.test(deps.cfg.smtpHost));
    const smtp: SmtpOptions | null = canSend && deps.cfg.smtpHost
      ? {
          host: deps.cfg.smtpHost, port: deps.cfg.smtpPort, secure: deps.cfg.smtpSecure, starttls: deps.cfg.smtpStarttls,
          ...(deps.cfg.smtpUser ? { user: deps.cfg.smtpUser } : {}), ...(deps.cfg.smtpPass ? { pass: deps.cfg.smtpPass } : {}),
        }
      : null;
    this.mailer = smtp ? (m) => sendMail(smtp, m) : null;
    this.pusher = (sub, payload, keys) => sendPush(sub, payload, keys, `mailto:${addressOnly(this.cfg.mailFrom)}`);
    this.hub.observeUserMessages((userId, msg) => void this.onUserMessage(userId, msg as { type?: string }).catch((e) => this.logger.warn('Bildirim hatası', { error: e })));
  }

  start(): void {
    if (!this.mailTimer) {
      this.mailTimer = setInterval(() => void this.deliverMail().catch((e) => this.logger.error('E-posta işçisi hatası', { error: e })), 2000);
      this.mailTimer.unref();
    }
    if (!this.digestTimer) {
      this.digestTimer = setInterval(() => {
        if (new Date().getUTCHours() === this.cfg.digestHourUtc) void this.sendDigests().catch((e) => this.logger.error('Özet e-postası hatası', { error: e }));
      }, 10 * 60_000);
      this.digestTimer.unref();
    }
    if (!this.mailer) this.logger.warn('E-posta gönderimi kapalı: SMTP_HOST, SMTP_USER ve SMTP_PASS verilince açılır; e-postalar o zamana kadar kuyrukta bekler');
  }

  stop(): void {
    if (this.mailTimer) clearInterval(this.mailTimer);
    if (this.digestTimer) clearInterval(this.digestTimer);
    this.mailTimer = null;
    this.digestTimer = null;
  }

  // ---- anahtarlar ve tercihler ----------------------------------------------------

  async vapid(): Promise<VapidKeys> {
    if (this.vapidKeys) return this.vapidKeys;
    if (this.cfg.vapidPublicKey && this.cfg.vapidPrivateKey) {
      this.vapidKeys = { publicKey: this.cfg.vapidPublicKey, privateKey: this.cfg.vapidPrivateKey };
      return this.vapidKeys;
    }
    const fresh = generateVapidKeys();
    await this.pool.query(`INSERT INTO app_secrets (key, value) VALUES ('vapid', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(fresh)]);
    const r = await this.pool.query<{ value: string }>(`SELECT value FROM app_secrets WHERE key = 'vapid'`);
    this.vapidKeys = JSON.parse((r.rows[0] as { value: string }).value) as VapidKeys;
    return this.vapidKeys;
  }

  async prefs(userId: string) {
    const r = await this.pool.query<{ notify_new_tournaments: boolean; n: number }>(
      `SELECT u.notify_new_tournaments, (SELECT count(*)::int FROM push_subscriptions p WHERE p.user_id = u.id) AS n FROM users u WHERE u.id = $1`,
      [userId],
    );
    const row = r.rows[0];
    return { newTournamentsEmail: !!row?.notify_new_tournaments, pushDevices: row?.n ?? 0, vapidPublicKey: (await this.vapid()).publicKey };
  }

  async setPrefs(userId: string, p: { newTournamentsEmail?: boolean }) {
    if (typeof p.newTournamentsEmail === 'boolean') {
      await this.pool.query(
        `UPDATE users SET notify_new_tournaments = $2, notify_consent_at = CASE WHEN $2 THEN now() ELSE notify_consent_at END WHERE id = $1`,
        [userId, p.newTournamentsEmail],
      );
      await this.pool.query(`INSERT INTO audit_log (actor_id, action, target_type, target_id, data) VALUES ($1::uuid, 'notify.prefs', 'user', $1::text, $2)`, [userId, p]);
    }
    return this.prefs(userId);
  }

  async subscribe(userId: string, sub: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }, userAgent: string | null) {
    const endpoint = String(sub?.endpoint ?? '');
    const p256dh = String(sub?.keys?.p256dh ?? '');
    const auth = String(sub?.keys?.auth ?? '');
    if (!/^https:\/\/[^\s]{8,2000}$/.test(endpoint) || !/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(auth)) {
      throw badRequest('VALIDATION', 'Geçersiz bildirim aboneliği');
    }
    await this.pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, failures = 0`,
      [userId, endpoint, p256dh, auth, userAgent?.slice(0, 200) ?? null],
    );
    return { ok: true };
  }

  async unsubscribePush(userId: string, endpoint: string) {
    await this.pool.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [userId, endpoint]);
    return { ok: true };
  }

  // ---- abonelikten çıkma bağlantısı ---------------------------------------------------

  unsubscribeToken(userId: string): string {
    return createHmac('sha256', this.cfg.jwtSecret).update(`unsub:${userId}`).digest('base64url');
  }

  unsubscribeUrl(userId: string): string {
    return `${this.cfg.publicBaseUrl ?? ''}/v1/notifications/unsubscribe?u=${userId}&t=${this.unsubscribeToken(userId)}`;
  }

  async unsubscribeByLink(userId: string, token: string): Promise<boolean> {
    const want = Buffer.from(this.unsubscribeToken(userId));
    const got = Buffer.from(String(token));
    if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
    await this.pool.query('UPDATE users SET notify_new_tournaments = false WHERE id = $1', [userId]);
    await this.pool.query(`INSERT INTO audit_log (actor_id, action, target_type, target_id, data) VALUES ($1::uuid, 'notify.unsubscribe_link', 'user', $1::text, '{}')`, [userId]);
    return true;
  }

  // ---- gönderim ---------------------------------------------------------------------

  /** E-postayı kullanıcının dilinde kuyruğa yazar (K48). */
  async email(q: Queryable, userId: string, template: string, build: (t: EmailTexts, l: Locale) => { subject: string; body: string }, data: Record<string, unknown> = {}) {
    const u = (await q.query<{ email: string; display_name: string; closed_at: Date | null; locale: string }>(
      'SELECT email, display_name, closed_at, locale FROM users WHERE id = $1', [userId])).rows[0];
    if (!u || u.closed_at) return;
    const l = asLocale(u.locale);
    const t = emailText(l);
    const m = build(t, l);
    await q.query(
      `INSERT INTO mail_outbox (to_email, template, subject, body, data) VALUES ($1, $2, $3, $4, $5)`,
      [u.email, template, m.subject, `${t.greeting(u.display_name)}\n\n${m.body}\n\n${t.signature}`, { userId, ...data }],
    );
  }

  private async localeOf(userId: string): Promise<Locale> {
    const r = await this.pool.query<{ locale: string }>('SELECT locale FROM users WHERE id = $1', [userId]);
    return asLocale(r.rows[0]?.locale);
  }

  async push(userId: string, payload: PushPayload): Promise<number> {
    const subs = await this.pool.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
      'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
      [userId],
    );
    if (!subs.rows.length) return 0;
    const keys = await this.vapid();
    let ok = 0;
    for (const s of subs.rows) {
      try {
        const status = await this.pusher(s, payload, keys);
        if (status === 404 || status === 410) await this.pool.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]);
        else if (status >= 200 && status < 300) {
          ok++;
          await this.pool.query('UPDATE push_subscriptions SET last_ok_at = now(), failures = 0 WHERE id = $1', [s.id]);
        } else await this.pool.query('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = $1', [s.id]);
      } catch (e) {
        this.logger.warn('Bildirim gönderilemedi', { error: e });
        await this.pool.query('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = $1', [s.id]);
      }
    }
    await this.pool.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND failures >= 10', [userId]);
    return ok;
  }

  /** E-posta kuyruğunu işler (SMTP ayarlıysa). Testler doğrudan çağırabilir. */
  async deliverMail(): Promise<number> {
    if (!this.mailer || this.sending) return 0;
    this.sending = true;
    let sent = 0;
    try {
      const due = await this.pool.query<{ id: number; to_email: string; subject: string; body: string; template: string; data: { userId?: string } }>(
        `UPDATE mail_outbox SET attempts = attempts + 1, next_attempt_at = now() + make_interval(mins => LEAST(360, power(2, attempts)::int))
         WHERE id IN (SELECT id FROM mail_outbox WHERE sent_at IS NULL AND attempts < $1 AND next_attempt_at <= now() ORDER BY id LIMIT 10 FOR UPDATE SKIP LOCKED)
         RETURNING id, to_email, subject, body, template, data`,
        [MAX_MAIL_ATTEMPTS],
      );
      for (const m of due.rows) {
        const headers: Record<string, string> = {};
        if (m.template === 'digest' && m.data.userId) {
          headers['List-Unsubscribe'] = `<${this.unsubscribeUrl(m.data.userId)}>`;
          headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
        }
        try {
          await this.mailer({ from: this.cfg.mailFrom, to: m.to_email, subject: m.subject, text: m.body, headers });
          await this.pool.query('UPDATE mail_outbox SET sent_at = now(), last_error = NULL WHERE id = $1', [m.id]);
          sent++;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.logger.warn('E-posta gönderilemedi', { id: m.id, error: msg });
          await this.pool.query('UPDATE mail_outbox SET last_error = $2 WHERE id = $1', [m.id, msg.slice(0, 500)]);
        }
      }
    } finally {
      this.sending = false;
    }
    return sent;
  }

  // ---- olaylardan bildirime ------------------------------------------------------------

  private link(path: string) {
    return `${this.cfg.publicBaseUrl ?? ''}/#${path}`;
  }

  async onUserMessage(userId: string, m: { type?: string; [k: string]: unknown }): Promise<void> {
    switch (m.type) {
      case 'tournament.joined': {
        const tLink = this.link(`/turnuva/${m.tournamentId}`);
        await this.email(this.pool, userId, 'tournament_joined', (t, l) => t.tournamentJoined({
          name: localizeTournamentName(String(m.name), l), feeCents: Number(m.entryFeeCents ?? 0), capacity: Number(m.capacity), readySeconds: Number(m.readySeconds ?? 60), link: tLink,
        }), { tournamentId: m.tournamentId });
        return;
      }
      case 'tournament.readyCheck': {
        const t = emailText(await this.localeOf(userId));
        await this.push(userId, { title: t.push.readyTitle, body: t.push.readyBody(Number(m.readySeconds)), url: `/#/turnuva/${m.tournamentId}`, tag: `ready-${m.tournamentId}` });
        if (!this.hub.isUserOnline(userId)) {
          const tLink = this.link(`/turnuva/${m.tournamentId}`);
          await this.email(this.pool, userId, 'tournament_starting', (x) => x.tournamentStarting({ readySeconds: Number(m.readySeconds), link: tLink }), { tournamentId: m.tournamentId });
        }
        return;
      }
      case 'match.ready': {
        const l = await this.localeOf(userId);
        const t = emailText(l);
        const when = Math.max(0, Math.round((new Date(String(m.startAt)).getTime() - Date.now()) / 1000));
        await this.push(userId, {
          title: m.tiebreak ? t.push.tiebreakTitle : t.push.roundStarting(localizeRound(String(m.round), l)),
          body: t.push.matchBody(when, m.color === 'w'),
          url: `/#/oyun/${m.gameId}`,
          tag: `match-${m.matchId}`,
        });
        return;
      }
      case 'prize.released': {
        const link = this.link('/cuzdan');
        await this.email(this.pool, userId, 'prize_released', (t) => t.prizeReleased({ cents: Number(m.cents), link }));
        return;
      }
      case 'withdrawal.paid': {
        const link = this.link('/cuzdan');
        await this.email(this.pool, userId, 'withdrawal_paid', (t) => t.withdrawalPaid({ link }));
        return;
      }
      case 'withdrawal.rejected': {
        const link = this.link('/cuzdan');
        await this.email(this.pool, userId, 'withdrawal_rejected', (t) => t.withdrawalRejected({ link }));
        return;
      }
      default:
    }
  }

  // ---- yeni turnuva özeti (izin verenlere, günde en fazla bir) -----------------------------

  async sendDigests(limit = 500): Promise<number> {
    const open = await this.pool.query<{ id: string; name: string; capacity: number; fee: number; tc: string; joined: number }>(
      `SELECT t.id, t.name, t.capacity, (t.template->>'entry_fee_cents')::int AS fee, t.template->>'time_control' AS tc,
              (SELECT count(*)::int FROM entries e WHERE e.tournament_id = t.id AND e.status IN ('RESERVED', 'CONFIRMED')) AS joined
       FROM tournaments t WHERE t.status = 'OPEN' AND (t.template->>'entry_fee_cents')::int > 0
       ORDER BY t.capacity, (t.template->>'entry_fee_cents')::int`,
    );
    if (!open.rows.length) return 0;
    const users = await this.pool.query<{ id: string }>(
      `SELECT id FROM users WHERE notify_new_tournaments AND status = 'active' AND closed_at IS NULL AND email_verified_at IS NOT NULL
         AND (last_digest_at IS NULL OR last_digest_at < now() - interval '20 hours')
       ORDER BY id LIMIT $1`,
      [limit],
    );
    let n = 0;
    for (const u of users.rows) {
      // Kişiye göre: son 60 günde en sık oynadığı (kontenjan, süre) önce.
      const fav = await this.pool.query<{ capacity: number; tc: string }>(
        `SELECT t.capacity, t.template->>'time_control' AS tc FROM entries e JOIN tournaments t ON t.id = e.tournament_id
         WHERE e.user_id = $1 AND e.status IN ('CONFIRMED', 'ELIMINATED', 'WINNER') AND e.joined_at > now() - interval '60 days'
         GROUP BY 1, 2 ORDER BY count(*) DESC LIMIT 1`,
        [u.id],
      );
      const f = fav.rows[0];
      const list = [...open.rows].sort((a, b) => Number(!!f && !(b.capacity === f.capacity && b.tc === f.tc)) - Number(!!f && !(a.capacity === f.capacity && a.tc === f.tc))).slice(0, 6);
      const home = this.link('/');
      const unsubscribe = this.unsubscribeUrl(u.id);
      await this.pool.tx(async (tx) => {
        const upd = await tx.query(`UPDATE users SET last_digest_at = now() WHERE id = $1 AND (last_digest_at IS NULL OR last_digest_at < now() - interval '20 hours')`, [u.id]);
        if (!upd.rowCount) return;
        await this.email(tx, u.id, 'digest', (t, l) => t.digest({
          lines: list.map((x) => ({ name: localizeTournamentName(x.name, l), joined: x.joined, capacity: x.capacity })), link: home, unsubscribe,
        }));
        n++;
      });
    }
    return n;
  }
}

function addressOnly(s: string): string {
  const m = /<([^>]+)>/.exec(s);
  return (m?.[1] ?? s).trim();
}

