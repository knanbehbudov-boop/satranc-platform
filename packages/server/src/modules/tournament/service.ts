/**
 * M5 Turnuva motoru (ücretsiz ve ücretli).
 *
 * Tüm durum geçişleri tek yerde (transition), işlem içinde ve denetim kaydıyla yapılır.
 * Maç ilerletme 'game.ended' olayından tetiklenir; olay bir kez işlenir ve ilerletme
 * aynı işlemde yapılır (oyun bitti → skor → sonraki oyun ya da tur → bracket).
 *
 * Ücretli akış (Bölüm 8):
 *   katıl → koltuk RESERVED (10 dk) + ödeme sayfası
 *   'payment.succeeded' olayı → koltuk CONFIRMED + para emanete (aynı işlemde);
 *     koltuk artık yoksa (süre doldu, ayrıldı, turnuva başladı) → para yetim iade
 *   ayrılma / iptal → emanetten tam iade
 *   final → SETTLING: komisyon + ödüller bekletmede (USER_PRIZE_PENDING)
 *   bekletme bitti ve risk kapısı temiz → çekilebilir bakiye, SETTLED; değilse DISPUTED.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { armageddonClocks, parseTimeControl } from '@satranc/chess-core';
import type { Config } from '../../config.ts';
import type { Connection, Pool, Queryable } from '../../infra/db/pg.ts';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../infra/errors.ts';
import { publish, type HandlerHooks, type OutboxEvent } from '../../infra/events/outbox.ts';
import type { Logger } from '../../infra/log.ts';
import type { WsHub } from '../../infra/ws/hub.ts';
import type { GameService } from '../game/service.ts';
import type { IdentityService } from '../identity/service.ts';
import { poolFor, type RatingService } from '../rating/service.ts';
import type { FlagService } from '../admin/flags.ts';
import type { LedgerService } from '../ledger/service.ts';
import { distribute, holdSecondsFor, schemeFor, splitGross, type PrizeGroup } from '../ledger/prizes.ts';
import type { PaymentService } from '../payments/service.ts';
import {
  buildBracket,
  canTransition,
  eliminationRank,
  judgeMatch,
  roundName,
  roundsFor,
  seedCommitment,
  verifiableShuffle,
  type GameOutcome,
  type TournamentStatus,
} from './rules.ts';

export interface TemplateSnapshot {
  id: string;
  code: string;
  name: string;
  kind: 'sng' | 'scheduled' | 'private' | 'free';
  capacity: number;
  entry_fee_cents: number;
  currency: string;
  rake_bps: number;
  time_control: string;
  rating_min: number | null;
  rating_max: number | null;
  allowed_countries: string[];
  ready_seconds: number;
  break_seconds: number;
  prize_scheme?: unknown;
}

/**
 * Ödül kapısı (M10): analiz bitmeden hiçbir ödül serbest kalmaz (wait); yüksek riskli
 * oyuncunun ödülü insan incelemesine kalır (hold → turnuva DISPUTED); orta riskte bekletme uzar (delay).
 */
export type RiskGate = (q: Queryable, tournamentId: string) => Promise<{ wait: boolean; hold: string[] | 'all'; delay: string[] }>;

export interface JoinResult {
  status: 'OPEN' | 'STARTING' | 'RESERVED';
  entryId: string;
  expiresAt?: string;
  paymentId?: string | null;
  checkoutUrl?: string | null;
}

interface TournamentRow {
  id: string;
  template_id: string;
  template: TemplateSnapshot;
  name: string;
  capacity: number;
  status: TournamentStatus;
  starts_at: Date | null;
  ready_deadline: Date | null;
  seed_hash: string;
  seed_secret: string;
  seed_revealed: boolean;
  status_changed_at: Date;
  created_at: Date;
}

interface MatchRow {
  id: string;
  tournament_id: string;
  round_no: number;
  slot_no: number;
  player_a: string | null;
  player_b: string | null;
  score_a: number;
  score_b: number;
  winner_id: string | null;
  status: 'PENDING' | 'PLAYING' | 'DONE' | 'WALKOVER' | 'VOID';
  next_match_id: string | null;
  next_side: 'a' | 'b' | null;
  decided_by: string | null;
}

type Notes = (() => void)[];

const ACTIVE_STATUSES: TournamentStatus[] = ['OPEN', 'FULL', 'STARTING', 'RUNNING'];

/** Faz 0'da her zaman açık tutulan ücretsiz SNG şablonları. */
const DEFAULT_TEMPLATES = [
  { code: 'ucretsiz-4-blitz', name: 'Ücretsiz 4 kişilik Blitz', kind: 'free', fee: 0, rake: 0, capacity: 4, time_control: '180+2', ready_seconds: 60, break_seconds: 30 },
  { code: 'ucretsiz-8-blitz', name: 'Ücretsiz 8 kişilik Blitz', kind: 'free', fee: 0, rake: 0, capacity: 8, time_control: '300+3', ready_seconds: 90, break_seconds: 60 },
  // Ücretli SNG'ler (doküman 3.9 örneği: %12 komisyon). paid_tournaments bayrağı kapalıyken açılmaz.
  { code: 'sng-4-blitz-5usd', name: '5 USD · 4 kişilik Blitz', kind: 'sng', fee: 500, rake: 1200, capacity: 4, time_control: '180+2', ready_seconds: 60, break_seconds: 30 },
  { code: 'sng-8-blitz-10usd', name: '10 USD · 8 kişilik Blitz', kind: 'sng', fee: 1000, rake: 1200, capacity: 8, time_control: '300+3', ready_seconds: 90, break_seconds: 60 },
];

export class TournamentService {
  private readonly pool: Pool;
  private readonly cfg: Config;
  private readonly logger: Logger;
  private readonly hub: WsHub;
  private readonly games: GameService;
  private readonly identity: IdentityService;
  private readonly ratings: RatingService;
  private readonly payments: PaymentService;
  private readonly ledger: LedgerService;
  private readonly flags: FlagService;
  riskGate: RiskGate = async () => ({ wait: false, hold: [], delay: [] });
  private lastRelease = 0;
  private ticker: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private readonly notifyTimers = new Map<string, NodeJS.Timeout>();
  /** İlk oyunun başlamasından önceki hazırlık süresi (ms). */
  firstGameDelayMs = 3_000;

  constructor(deps: {
    pool: Pool; cfg: Config; logger: Logger; hub: WsHub; games: GameService; identity: IdentityService; ratings: RatingService;
    payments: PaymentService; ledger: LedgerService; flags: FlagService;
  }) {
    this.pool = deps.pool;
    this.cfg = deps.cfg;
    this.logger = deps.logger;
    this.hub = deps.hub;
    this.games = deps.games;
    this.identity = deps.identity;
    this.ratings = deps.ratings;
    this.payments = deps.payments;
    this.ledger = deps.ledger;
    this.flags = deps.flags;
    this.registerWs();
  }

  // ---- yaşam döngüsü -------------------------------------------------------

  async start(): Promise<void> {
    await this.seedDefaults();
    await this.ensureOpen();
    this.ticker = setInterval(() => void this.tick().catch((e) => this.logger.error('Turnuva zamanlayıcısı hatası', { error: e })), 500);
    this.ticker.unref();
    this.watchdog = setInterval(() => void this.checkStuck().catch(() => undefined), 30_000);
    this.watchdog.unref();
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    if (this.watchdog) clearInterval(this.watchdog);
    for (const t of this.notifyTimers.values()) clearTimeout(t);
    this.notifyTimers.clear();
  }

  private async seedDefaults(): Promise<void> {
    for (const t of DEFAULT_TEMPLATES) {
      await this.pool.query(
        `INSERT INTO tournament_templates (code, name, kind, entry_fee_cents, rake_bps, capacity, time_control, ready_seconds, break_seconds)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (code) DO NOTHING`,
        [t.code, t.name, t.kind, t.fee, t.rake, t.capacity, t.time_control, t.ready_seconds, t.break_seconds],
      );
    }
  }

  /** Her etkin SNG/ücretsiz şablon için bir açık turnuva bulunmasını sağlar. */
  async ensureOpen(): Promise<void> {
    const paidOn = await this.flags.isEnabled('paid_tournaments');
    const templates = await this.pool.query<TemplateSnapshot>(
      `SELECT t.* FROM tournament_templates t
       WHERE t.active AND t.kind IN ('sng', 'free') AND (t.entry_fee_cents = 0 OR $1)
         AND NOT EXISTS (SELECT 1 FROM tournaments x WHERE x.template_id = t.id AND x.status = 'OPEN')`,
      [paidOn],
    );
    for (const tpl of templates.rows) {
      try {
        await this.pool.tx(async (tx) => {
          await this.createFromTemplate(tx, tpl);
        });
      } catch (e) {
        // Aynı anda başka bir çağrı açtıysa benzersizlik kısıtı korur.
        if ((e as { code?: string }).code !== '23505') throw e;
      }
    }
    this.hub.publish('lobby', { type: 'lobby.update' });
  }

  async createFromTemplate(tx: Queryable, tpl: TemplateSnapshot): Promise<string> {
    roundsFor(tpl.capacity);
    if (Number(tpl.entry_fee_cents) > 0) schemeFor(tpl.capacity, tpl.prize_scheme); // geçersiz ödül şablonu turnuva açtırmaz
    parseTimeControl(tpl.time_control);
    const secret = randomBytes(32).toString('hex');
    const snapshot: TemplateSnapshot = {
      id: tpl.id, code: tpl.code, name: tpl.name, kind: tpl.kind, capacity: tpl.capacity,
      entry_fee_cents: Number(tpl.entry_fee_cents), currency: tpl.currency, rake_bps: tpl.rake_bps,
      time_control: tpl.time_control, rating_min: tpl.rating_min, rating_max: tpl.rating_max,
      allowed_countries: tpl.allowed_countries, ready_seconds: tpl.ready_seconds, break_seconds: tpl.break_seconds,
      prize_scheme: tpl.prize_scheme ?? null,
    };
    const r = await tx.query<{ id: string }>(
      `INSERT INTO tournaments (template_id, template, name, capacity, status, seed_hash, seed_secret)
       VALUES ($1, $2, $3, $4, 'DRAFT', $5, $6) RETURNING id`,
      [tpl.id, snapshot, tpl.name, tpl.capacity, seedCommitment(secret), secret],
    );
    const id = (r.rows[0] as { id: string }).id;
    await tx.query(
      `INSERT INTO tournament_events (tournament_id, from_status, to_status, reason, actor) VALUES ($1, NULL, 'DRAFT', 'created', 'system')`,
      [id],
    );
    await this.transition(tx, { id, status: 'DRAFT' }, 'OPEN', 'published', 'system');
    return id;
  }

  /** Tek durum yöneticisi: izinli olmayan geçiş kodda imkânsız (doküman 4.2). */
  private async transition(
    tx: Queryable,
    t: { id: string; status: TournamentStatus },
    to: TournamentStatus,
    reason: string,
    actor: string,
    extra: { readyDeadline?: Date } = {},
  ): Promise<void> {
    if (!canTransition(t.status, to)) throw new Error(`Geçersiz turnuva geçişi ${t.status} → ${to}`);
    const r = await tx.query(
      `UPDATE tournaments SET status = $2, status_changed_at = now(), version = version + 1,
              ready_deadline = COALESCE($4, ready_deadline)
       WHERE id = $1 AND status = $3`,
      [t.id, to, t.status, extra.readyDeadline ?? null],
    );
    if (!r.rowCount) throw new Error(`Turnuva durumu beklenmedik şekilde değişmiş: ${t.id}`);
    await tx.query(
      `INSERT INTO tournament_events (tournament_id, from_status, to_status, reason, actor) VALUES ($1, $2, $3, $4, $5)`,
      [t.id, t.status, to, reason, actor],
    );
    await publish(tx, 'tournament.status', { tournamentId: t.id, from: t.status, to, reason });
    t.status = to;
  }

  private async lock(tx: Queryable, id: string): Promise<TournamentRow> {
    const r = await tx.query<TournamentRow>('SELECT * FROM tournaments WHERE id = $1 FOR UPDATE', [id]);
    const t = r.rows[0];
    if (!t) throw notFound('TOURNAMENT_NOT_FOUND', 'Turnuva bulunamadı');
    return t;
  }

  private async withTx<T>(fn: (tx: Connection, notes: Notes) => Promise<T>): Promise<T> {
    const notes: Notes = [];
    const out = await this.pool.tx((tx) => fn(tx, notes));
    for (const n of notes) {
      try {
        n();
      } catch (e) {
        this.logger.error('Bildirim hatası', { error: e });
      }
    }
    return out;
  }

  // ---- katılım ---------------------------------------------------------------

  async join(userId: string, tournamentId: string, meta: { ip: string; deviceKey: string | null }): Promise<JoinResult> {
    const user = await this.identity.assertCanCompete(userId);
    const pre = await this.pool.query<TournamentRow>('SELECT * FROM tournaments WHERE id = $1', [tournamentId]);
    if (!pre.rows[0]) throw notFound('TOURNAMENT_NOT_FOUND', 'Turnuva bulunamadı');
    const paid = Number(pre.rows[0].template.entry_fee_cents) > 0;
    if (paid) {
      if (!(await this.flags.isEnabled('paid_tournaments'))) {
        throw new AppError(503, 'PAID_TOURNAMENTS_PAUSED', 'Ücretli turnuvalara kayıt geçici olarak durduruldu');
      }
      // K6: ücretli girişten önce insan rakiplere karşı yeterli rated oyun (bot oyunları sayılmaz).
      const have = await this.ratings.humanRatedGames(userId);
      if (have < this.cfg.paidMinRatedGames) {
        throw forbidden('NOT_ENOUGH_RATED_GAMES', `Ücretli turnuvalar için en az ${this.cfg.paidMinRatedGames} rated oyun gerekli (şu an ${have})`);
      }
    }
    let filled = false;
    const seat = await this.withTx(async (tx, notes) => {
      const t = await this.lock(tx, tournamentId);
      if (t.status !== 'OPEN') throw conflict('TOURNAMENT_NOT_OPEN', 'Bu turnuva kayıt almıyor');
      const tpl = t.template;
      if (tpl.allowed_countries.length && !tpl.allowed_countries.includes(user.country_code)) {
        throw forbidden('COUNTRY_NOT_ALLOWED', 'Bu turnuva ülkenizde sunulmuyor');
      }
      if (tpl.rating_min !== null || tpl.rating_max !== null) {
        // Bant sınıflaması güncel değil, zirve (peak) rating ile yapılır (doküman 13.3).
        const r = await this.ratings.ratingFor(userId, poolFor(tpl.time_control));
        if (tpl.rating_max !== null && r.peak > tpl.rating_max) throw forbidden('RATING_TOO_HIGH', 'Rating bandınız bu turnuvanın üstünde');
        if (tpl.rating_min !== null && r.rating < tpl.rating_min) throw forbidden('RATING_TOO_LOW', 'Rating bandınız bu turnuvanın altında');
      }
      // K22: aynı anda tek aktif turnuva.
      const other = await tx.query(
        `SELECT 1 FROM entries e JOIN tournaments x ON x.id = e.tournament_id
         WHERE e.user_id = $1 AND e.status IN ('RESERVED', 'CONFIRMED') AND x.status = ANY($2) AND x.id <> $3 LIMIT 1`,
        [userId, ACTIVE_STATUSES, tournamentId],
      );
      if (other.rowCount) throw conflict('ALREADY_IN_TOURNAMENT', 'Başka bir aktif turnuvadasınız');
      if (this.cfg.antiMultiAccount) {
        // Doküman 3.7: aynı IP ya da cihazdan iki hesap aynı turnuvaya giremez.
        const clash = await tx.query(
          `SELECT 1 FROM entries WHERE tournament_id = $1 AND status IN ('RESERVED', 'CONFIRMED') AND user_id <> $2
             AND (ip = $3 OR (device_key IS NOT NULL AND device_key = $4)) LIMIT 1`,
          [tournamentId, userId, meta.ip, meta.deviceKey],
        );
        if (clash.rowCount) throw forbidden('MULTI_ACCOUNT_BLOCKED', 'Aynı cihaz veya ağdan bu turnuvada başka bir hesap var');
      }
      // Koltuk sayımı rezervasyonları da içerir: ödeme bekleyen koltuk başkasına verilmez.
      const count = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM entries WHERE tournament_id = $1 AND status IN ('RESERVED', 'CONFIRMED')`,
        [tournamentId],
      );
      if ((count.rows[0] as { n: number }).n >= t.capacity) throw conflict('TOURNAMENT_FULL', 'Turnuva doldu');
      const isPaid = Number(tpl.entry_fee_cents) > 0;
      const ins = await tx.query<{ id: string; joined_at: Date; expires_at: Date | null }>(
        `INSERT INTO entries (tournament_id, user_id, status, ip, device_key, expires_at)
         VALUES ($1, $2, $5, $3, $4, CASE WHEN $5 = 'RESERVED' THEN now() + make_interval(secs => $6) END)
         ON CONFLICT (tournament_id, user_id) DO UPDATE SET status = EXCLUDED.status, joined_at = now(), ready_at = NULL,
           ip = EXCLUDED.ip, device_key = EXCLUDED.device_key, expires_at = EXCLUDED.expires_at, payment_id = NULL, exit_reason = NULL
           WHERE entries.status = 'WITHDRAWN'
         RETURNING id, joined_at, expires_at`,
        [tournamentId, userId, meta.ip, meta.deviceKey, isPaid ? 'RESERVED' : 'CONFIRMED', this.cfg.seatReservationSec],
      );
      const row = ins.rows[0];
      if (!row) throw conflict('ALREADY_JOINED', 'Bu turnuvaya zaten katıldınız');
      if (!isPaid) filled = await this.seatConfirmed(tx, t, notes);
      notes.push(() => this.notify(tournamentId));
      return { t, entryId: row.id, joinedAt: row.joined_at, expiresAt: row.expires_at, isPaid };
    });
    if (filled) await this.ensureOpen();
    if (!seat.isPaid) return { status: filled ? 'STARTING' : 'OPEN', entryId: seat.entryId };
    // Ödeme sağlayıcısı çağrısı işlem dışında; başarısız olursa koltuk rezervede kalır, /pay ile tekrar denenir.
    let pay: { paymentId: string; checkoutUrl: string | null } | null = null;
    try {
      pay = await this.startPayment(userId, seat.t, seat.entryId, seat.joinedAt);
    } catch (e) {
      this.logger.error('Ödeme başlatılamadı', { tournamentId, userId, error: e });
    }
    return {
      status: 'RESERVED',
      entryId: seat.entryId,
      expiresAt: (seat.expiresAt as Date).toISOString(),
      paymentId: pay?.paymentId ?? null,
      checkoutUrl: pay?.checkoutUrl ?? null,
    };
  }

  /** Rezerve koltuk için ödeme (idempotent: aynı rezervasyon → aynı ödeme). */
  private async startPayment(userId: string, t: TournamentRow, entryId: string, joinedAt: Date) {
    const tpl = t.template;
    const p = await this.payments.createPayment({
      userId,
      tournamentId: t.id,
      entryId,
      amountCents: Number(tpl.entry_fee_cents),
      currency: tpl.currency,
      idempotencyKey: `entry:${entryId}:${joinedAt.getTime()}`,
      description: `${t.name} — giriş ücreti`,
      returnUrl: (pid) => `/#/turnuva/${t.id}?odeme=${pid}`,
    });
    await this.pool.query(`UPDATE entries SET payment_id = $2 WHERE id = $1 AND status = 'RESERVED' AND payment_id IS NULL`, [entryId, p.paymentId]);
    return p;
  }

  /** Rezervasyonu süren kullanıcı ödeme sayfasına yeniden döner (sekmeyi kapattı, kart reddedildi…). */
  async resumePayment(userId: string, tournamentId: string): Promise<JoinResult> {
    const r = await this.pool.query<{ id: string; status: string; joined_at: Date; expires_at: Date | null }>(
      `SELECT id, status, joined_at, expires_at FROM entries WHERE tournament_id = $1 AND user_id = $2`,
      [tournamentId, userId],
    );
    const e = r.rows[0];
    if (!e || e.status !== 'RESERVED') throw conflict('NO_RESERVATION', 'Ödeme bekleyen bir koltuğunuz yok');
    if (e.expires_at && e.expires_at.getTime() < Date.now()) throw conflict('RESERVATION_EXPIRED', 'Rezervasyon süresi doldu');
    const t = (await this.pool.query<TournamentRow>('SELECT * FROM tournaments WHERE id = $1', [tournamentId])).rows[0] as TournamentRow;
    const p = await this.startPayment(userId, t, e.id, e.joined_at);
    return { status: 'RESERVED', entryId: e.id, expiresAt: e.expires_at?.toISOString(), paymentId: p.paymentId, checkoutUrl: p.checkoutUrl };
  }

  /** Onaylı koltuk sayısı kontenjana ulaştıysa turnuvayı doldurur ve hazır olma kontrolünü başlatır. */
  private async seatConfirmed(tx: Connection, t: TournamentRow, notes: Notes): Promise<boolean> {
    const c = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM entries WHERE tournament_id = $1 AND status = 'CONFIRMED'`, [t.id]);
    if ((c.rows[0] as { n: number }).n < t.capacity) return false;
    const tpl = t.template;
    await this.transition(tx, t, 'FULL', 'capacity_reached', 'system');
    const deadline = new Date(Date.now() + tpl.ready_seconds * 1000);
    await this.transition(tx, t, 'STARTING', 'ready_check', 'system', { readyDeadline: deadline });
    const players = await tx.query<{ user_id: string }>(`SELECT user_id FROM entries WHERE tournament_id = $1 AND status = 'CONFIRMED'`, [t.id]);
    notes.push(() => {
      for (const p of players.rows) {
        this.hub.sendToUser(p.user_id, { type: 'tournament.readyCheck', tournamentId: t.id, deadline: deadline.toISOString(), readySeconds: tpl.ready_seconds });
      }
    });
    return true;
  }

  /** İade talebini işlem sonrası adımlarla bağlar. */
  private refundHook(notes: Notes) {
    return { afterCommit: (fn: () => void) => notes.push(fn) };
  }

  async leave(userId: string, tournamentId: string): Promise<{ refund: boolean }> {
    return this.withTx(async (tx, notes) => {
      const t = await this.lock(tx, tournamentId);
      if (t.status !== 'OPEN') throw conflict('CANNOT_LEAVE', 'Turnuva başladıktan sonra ayrılınamaz; maçınız hükmen kaybedilir');
      const r = await tx.query<{ id: string; status: string; payment_id: string | null }>(
        `SELECT id, status, payment_id FROM entries WHERE tournament_id = $1 AND user_id = $2 AND status IN ('RESERVED', 'CONFIRMED') FOR UPDATE`,
        [tournamentId, userId],
      );
      const e = r.rows[0];
      if (!e) throw notFound('NOT_JOINED', 'Bu turnuvada kaydınız yok');
      await tx.query(`UPDATE entries SET status = 'WITHDRAWN', exit_reason = 'left', expires_at = NULL, ready_at = NULL WHERE id = $1`, [e.id]);
      let refund = false;
      if (e.payment_id && e.status === 'RESERVED') {
        // Ödenmemiş: ödeme iptal; yine de para gelirse koltuksuz kaldığı için yetim iade edilir.
        await this.payments.cancelPending(tx, e.payment_id);
      } else if (e.payment_id && e.status === 'CONFIRMED') {
        // Başlangıçtan önce ayrılan oyuncuya tam iade (emanetten).
        refund = await this.payments.requestRefund(tx, { paymentId: e.payment_id, source: 'pool', reason: 'left_before_start' }, this.refundHook(notes));
      }
      notes.push(() => this.notify(tournamentId));
      return { refund };
    });
  }

  /** Ödeme onayı (outbox tüketicisi): koltuk varsa onaylanır, yoksa para yetim iade edilir. */
  onPaymentSucceeded = async (event: OutboxEvent, tx: Connection, hooks: HandlerHooks): Promise<void> => {
    const e = event.payload as { paymentId: string; userId: string; tournamentId: string | null; entryId: string | null; amountCents: number; currency: string };
    if (!e.tournamentId || !e.entryId) return;
    const notes: Notes = [];
    const t = await this.lock(tx, e.tournamentId);
    const er = await tx.query<{ id: string; user_id: string; status: string; payment_id: string | null }>(
      'SELECT id, user_id, status, payment_id FROM entries WHERE id = $1 FOR UPDATE',
      [e.entryId],
    );
    const en = er.rows[0];
    const tpl = t.template;
    const seatOk = !!en && en.user_id === e.userId && en.status === 'RESERVED' && (en.payment_id === null || en.payment_id === e.paymentId) && t.status === 'OPEN';
    const amountOk = e.amountCents === Number(tpl.entry_fee_cents) && e.currency === tpl.currency;
    if (seatOk && amountOk) {
      await tx.query(`UPDATE entries SET status = 'CONFIRMED', payment_id = $2, expires_at = NULL WHERE id = $1`, [en.id, e.paymentId]);
      await this.ledger.assignToPool(tx, { paymentId: e.paymentId, tournamentId: t.id, userId: e.userId, cents: e.amountCents, currency: e.currency });
      const filled = await this.seatConfirmed(tx, t, notes);
      notes.push(() => this.hub.sendToUser(e.userId, { type: 'payment.confirmed', tournamentId: t.id, paymentId: e.paymentId }));
      if (filled) notes.push(() => void this.ensureOpen().catch((err) => this.logger.error('Yeni turnuva açılamadı', { error: err })));
    } else {
      const reason = !amountOk ? 'amount_mismatch' : t.status !== 'OPEN' ? 'tournament_not_open' : 'seat_unavailable';
      await this.payments.requestRefund(tx, { paymentId: e.paymentId, source: 'orphan', reason }, hooks);
      notes.push(() => this.hub.sendToUser(e.userId, { type: 'payment.orphaned', tournamentId: t.id, paymentId: e.paymentId, reason }));
    }
    notes.push(() => this.notify(t.id));
    hooks.afterCommit(() => {
      for (const n of notes) n();
    });
  };

  onPaymentFailed = async (event: OutboxEvent, _tx: Connection, hooks: HandlerHooks): Promise<void> => {
    const e = event.payload as { paymentId: string; userId: string; tournamentId: string | null; reason?: string };
    hooks.afterCommit(() => this.hub.sendToUser(e.userId, { type: 'payment.failed', tournamentId: e.tournamentId, paymentId: e.paymentId, reason: e.reason ?? null }));
  };

  /** Süresi dolan rezervasyonlar koltuğu bırakır (ödenmiş ama henüz işlenmemiş olanlar beklenir). */
  private async expireReservations(): Promise<void> {
    const due = await this.pool.query<{ id: string; tournament_id: string }>(
      `SELECT e.id, e.tournament_id FROM entries e LEFT JOIN payments p ON p.id = e.payment_id
       WHERE e.status = 'RESERVED' AND e.expires_at < now() AND (p.id IS NULL OR p.status <> 'SUCCEEDED') LIMIT 50`,
    );
    for (const d of due.rows) {
      await this.withTx(async (tx, notes) => {
        await this.lock(tx, d.tournament_id);
        const r = await tx.query<{ payment_id: string | null; user_id: string }>(
          `UPDATE entries SET status = 'WITHDRAWN', exit_reason = 'reservation_expired', expires_at = NULL
           WHERE id = $1 AND status = 'RESERVED' AND expires_at < now() RETURNING payment_id, user_id`,
          [d.id],
        );
        const row = r.rows[0];
        if (!row) return;
        if (row.payment_id) await this.payments.cancelPending(tx, row.payment_id);
        notes.push(() => {
          this.hub.sendToUser(row.user_id, { type: 'reservation.expired', tournamentId: d.tournament_id });
          this.notify(d.tournament_id);
        });
      });
    }
  }

  /** İptal edilen turnuvada ödenmiş tüm koltuklara emanetten tam iade. */
  private async refundAll(tx: Connection, tournamentId: string, reason: string, notes: Notes): Promise<number> {
    const paid = await tx.query<{ payment_id: string }>(
      `SELECT payment_id FROM entries WHERE tournament_id = $1 AND payment_id IS NOT NULL AND status IN ('CONFIRMED', 'ELIMINATED', 'WINNER', 'DISQUALIFIED')`,
      [tournamentId],
    );
    let n = 0;
    for (const p of paid.rows) {
      if (await this.payments.requestRefund(tx, { paymentId: p.payment_id, source: 'pool', reason }, this.refundHook(notes))) n++;
    }
    // Rezervede kalan ödenmemiş koltuklar da bırakılır.
    const reserved = await tx.query<{ payment_id: string | null }>(
      `UPDATE entries SET status = 'WITHDRAWN', exit_reason = $2, expires_at = NULL WHERE tournament_id = $1 AND status = 'RESERVED' RETURNING payment_id`,
      [tournamentId, reason],
    );
    for (const r of reserved.rows) if (r.payment_id) await this.payments.cancelPending(tx, r.payment_id);
    return n;
  }

  async ready(userId: string, tournamentId: string): Promise<void> {
    await this.withTx(async (tx, notes) => {
      const t = await this.lock(tx, tournamentId);
      if (t.status !== 'STARTING') throw conflict('NOT_IN_READY_CHECK', 'Hazır olma aşamasında değil');
      const r = await tx.query(
        `UPDATE entries SET ready_at = COALESCE(ready_at, now()) WHERE tournament_id = $1 AND user_id = $2 AND status = 'CONFIRMED'`,
        [tournamentId, userId],
      );
      if (!r.rowCount) throw notFound('NOT_JOINED', 'Bu turnuvada kaydınız yok');
      const pending = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM entries WHERE tournament_id = $1 AND status = 'CONFIRMED' AND ready_at IS NULL`,
        [tournamentId],
      );
      if ((pending.rows[0] as { n: number }).n === 0) await this.begin(tx, t, notes, 'all_ready');
      notes.push(() => this.notify(tournamentId));
    });
  }

  private async tick(): Promise<void> {
    const due = await this.pool.query<{ id: string }>(
      `SELECT id FROM tournaments WHERE status = 'STARTING' AND ready_deadline <= now()`,
    );
    for (const { id } of due.rows) {
      await this.withTx(async (tx, notes) => {
        const t = await this.lock(tx, id);
        if (t.status !== 'STARTING') return;
        await this.begin(tx, t, notes, 'ready_deadline');
        notes.push(() => this.notify(id));
      });
    }
    await this.expireReservations();
    // Ödül serbest bırakma birkaç saniyede bir yeter.
    if (Date.now() - this.lastRelease > 2000) {
      this.lastRelease = Date.now();
      await this.releaseDuePrizes();
    }
  }

  private async checkStuck(): Promise<void> {
    const r = await this.pool.query<{ id: string; status: string; age: number }>(
      `SELECT id, status, extract(epoch FROM now() - status_changed_at)::int AS age FROM tournaments
       WHERE (status IN ('FULL', 'SETTLING', 'DISPUTED') AND status_changed_at < now() - interval '5 minutes')
          OR (status = 'STARTING' AND ready_deadline < now() - interval '1 minute')`,
    );
    for (const row of r.rows) this.logger.warn('Takılı turnuva', { tournamentId: row.id, status: row.status, ageSec: row.age });
  }

  // ---- başlangıç ve bracket ------------------------------------------------

  private async begin(tx: Connection, t: TournamentRow, notes: Notes, reason: string): Promise<void> {
    const entries = await tx.query<{ user_id: string; ready_at: Date | null }>(
      `SELECT user_id, ready_at FROM entries WHERE tournament_id = $1 AND status = 'CONFIRMED'`,
      [t.id],
    );
    const ready = new Set(entries.rows.filter((e) => e.ready_at).map((e) => e.user_id));
    if (ready.size === 0) {
      await this.transition(tx, t, 'CANCELLED', 'nobody_ready', 'system');
      // Kimse gelmediyse oyun oynanmadı: ücretler iade edilir.
      await this.refundAll(tx, t.id, 'nobody_ready', notes);
      await tx.query(`UPDATE entries SET status = 'WITHDRAWN', exit_reason = 'nobody_ready' WHERE tournament_id = $1 AND status = 'CONFIRMED'`, [t.id]);
      return;
    }
    // Commit-reveal: seed şimdi açıklanır; kayıtlı oyuncu listesi + seed ile sıra doğrulanabilir.
    const order = verifiableShuffle(entries.rows.map((e) => e.user_id), t.seed_secret, t.id);
    await tx.query('UPDATE tournaments SET seed_revealed = true, starts_at = now() WHERE id = $1', [t.id]);
    for (let i = 0; i < order.length; i++) {
      await tx.query('UPDATE entries SET seed = $3 WHERE tournament_id = $1 AND user_id = $2', [t.id, order[i], i + 1]);
    }

    const slots = buildBracket(t.capacity);
    const ids = new Map<string, string>();
    const key = (r: number, s: number) => `${r}:${s}`;
    // Final önce eklenir ki alt turlar üst maça bağlanabilsin.
    for (const s of [...slots].sort((x, y) => y.round - x.round || x.slot - y.slot)) {
      const isFirst = s.round === 1;
      const r = await tx.query<{ id: string }>(
        `INSERT INTO matches (tournament_id, round_no, slot_no, player_a, player_b, next_match_id, next_side)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          t.id, s.round, s.slot,
          isFirst ? order[2 * (s.slot - 1)] ?? null : null,
          isFirst ? order[2 * (s.slot - 1) + 1] ?? null : null,
          s.next ? ids.get(key(s.next.round, s.next.slot)) : null,
          s.next?.side ?? null,
        ],
      );
      ids.set(key(s.round, s.slot), (r.rows[0] as { id: string }).id);
    }
    await this.transition(tx, t, 'RUNNING', reason, 'system');

    const firstRound = await tx.query<MatchRow>(`SELECT * FROM matches WHERE tournament_id = $1 AND round_no = 1 ORDER BY slot_no FOR UPDATE`, [t.id]);
    const rounds = roundsFor(t.capacity);
    for (const m of firstRound.rows) {
      const aReady = !!m.player_a && ready.has(m.player_a);
      const bReady = !!m.player_b && ready.has(m.player_b);
      if (aReady && bReady) {
        await this.startGame(tx, t, m, 1, true, notes, new Date(Date.now() + this.firstGameDelayMs));
      } else {
        // K1: hazır olmayan hükmen elenir; ikisi de hazır değilse ikisi de elenir (K2).
        const losers = [m.player_a, m.player_b].filter((p): p is string => !!p && !ready.has(p));
        for (const l of losers) await this.eliminate(tx, t.id, l, eliminationRank(1, rounds));
        const winner = aReady ? m.player_a : bReady ? m.player_b : null;
        await this.close(tx, t, m, winner, winner ? 'WALKOVER' : 'VOID', 'no_show', notes);
      }
    }
  }

  private async eliminate(tx: Queryable, tournamentId: string, userId: string, rank: number): Promise<void> {
    await tx.query(
      `UPDATE entries SET status = 'ELIMINATED', final_rank = $3 WHERE tournament_id = $1 AND user_id = $2 AND status = 'CONFIRMED'`,
      [tournamentId, userId, rank],
    );
  }

  private async startGame(tx: Connection, t: TournamentRow, m: MatchRow, gameNo: 1 | 2 | 3, aWhite: boolean, notes: Notes, startAt: Date, armageddon = false): Promise<void> {
    const existing = await this.games.summariesForMatches(tx, [m.id]);
    if (existing.some((g) => g.gameNo === gameNo)) return;
    const a = m.player_a as string;
    const b = m.player_b as string;
    const tc = parseTimeControl(t.template.time_control);
    const clocks = armageddon ? armageddonClocks(tc) : null;
    const gameId = await this.games.createGame(tx, {
      kind: 'tournament',
      matchId: m.id,
      gameNo,
      whiteId: aWhite ? a : b,
      blackId: aWhite ? b : a,
      timeControl: t.template.time_control,
      ...(clocks ? { whiteMs: clocks.whiteMs, blackMs: clocks.blackMs, incrementMs: clocks.incrementMs } : {}),
      armageddon,
      rated: true,
      paid: t.template.entry_fee_cents > 0,
      startAt,
    });
    await tx.query(`UPDATE matches SET status = 'PLAYING', updated_at = now() WHERE id = $1`, [m.id]);
    const rounds = roundsFor(t.capacity);
    notes.push(() => {
      for (const [uid, color] of [[a, aWhite ? 'w' : 'b'], [b, aWhite ? 'b' : 'w']] as const) {
        this.hub.sendToUser(uid, {
          type: 'match.ready',
          tournamentId: t.id,
          matchId: m.id,
          gameId,
          gameNo,
          armageddon,
          color,
          round: roundName(m.round_no, rounds),
          startAt: startAt.toISOString(),
        });
      }
    });
  }

  /** Maçı kapatır (kazanan ya da boş) ve bracket'ta ilerletir. */
  private async close(
    tx: Connection,
    t: TournamentRow,
    m: MatchRow,
    winner: string | null,
    status: 'DONE' | 'WALKOVER' | 'VOID',
    by: string,
    notes: Notes,
  ): Promise<void> {
    await tx.query(
      `UPDATE matches SET status = $2, winner_id = $3, decided_by = $4, updated_at = now() WHERE id = $1`,
      [m.id, status, winner, by],
    );
    if (!m.next_match_id) {
      await this.finishTournament(tx, t, winner, notes);
      return;
    }
    if (winner) {
      await tx.query(`UPDATE matches SET player_${m.next_side === 'a' ? 'a' : 'b'} = $2 WHERE id = $1`, [m.next_match_id, winner]);
    }
    const feeders = await tx.query<{ status: string }>('SELECT status FROM matches WHERE next_match_id = $1', [m.next_match_id]);
    const allClosed = feeders.rows.every((f) => f.status === 'DONE' || f.status === 'WALKOVER' || f.status === 'VOID');
    if (!allClosed) return;
    const nr = await tx.query<MatchRow>('SELECT * FROM matches WHERE id = $1 FOR UPDATE', [m.next_match_id]);
    const next = nr.rows[0] as MatchRow;
    if (next.status !== 'PENDING') return;
    const present = [next.player_a, next.player_b].filter((p): p is string => !!p);
    if (present.length === 2) {
      await this.startGame(tx, t, next, 1, true, notes, new Date(Date.now() + t.template.break_seconds * 1000));
    } else {
      await this.close(tx, t, next, present[0] ?? null, present.length ? 'WALKOVER' : 'VOID', 'walkover', notes);
    }
  }

  private async finishTournament(tx: Connection, t: TournamentRow, winner: string | null, notes: Notes): Promise<void> {
    if (winner) {
      await tx.query(`UPDATE entries SET status = 'WINNER', final_rank = 1 WHERE tournament_id = $1 AND user_id = $2`, [t.id, winner]);
    }
    await this.transition(tx, t, 'FINISHED', 'final_decided', 'system');
    if (Number(t.template.entry_fee_cents) > 0) {
      // Ücretli: hesaplaşma ayrı tüketicide ('tournament.finished' → settle), kendi işleminde yapılır.
      await this.transition(tx, t, 'SETTLING', 'awaiting_settlement', 'system');
    } else {
      // Ücretsiz turnuvada ödül yok: bekletme ve hile incelemesi adımı doğrudan kapanır.
      await this.transition(tx, t, 'SETTLING', 'no_prizes', 'system');
      await this.transition(tx, t, 'SETTLED', 'no_prizes', 'system');
    }
    await publish(tx, 'tournament.finished', { tournamentId: t.id, winnerId: winner, paid: Number(t.template.entry_fee_cents) > 0 });
    notes.push(() => this.hub.publish('lobby', { type: 'lobby.update' }));
  }

  // ---- hesaplaşma ve ödül -----------------------------------------------------

  /**
   * Ücretli turnuva kapanışı (outbox: 'tournament.finished'). Emanet = koltuk × ücret olmalı;
   * değilse para dağıtılmaz, turnuva DISPUTED'a alınır ve alarm verilir.
   */
  onTournamentFinished = async (event: OutboxEvent, tx: Connection, hooks: HandlerHooks): Promise<void> => {
    const e = event.payload as { tournamentId: string; paid?: boolean };
    if (!e.paid) return;
    const notes: Notes = [];
    await this.settle(tx, e.tournamentId, notes);
    hooks.afterCommit(() => {
      for (const n of notes) n();
    });
  };

  async settle(tx: Connection, tournamentId: string, notes: Notes): Promise<void> {
    const t = await this.lock(tx, tournamentId);
    if (t.status !== 'SETTLING') return;
    const done = await tx.query('SELECT 1 FROM tournaments WHERE id = $1 AND gross_cents IS NOT NULL', [t.id]);
    if (done.rowCount) return;
    const tpl = t.template;
    const fee = Number(tpl.entry_fee_cents);
    const seated = await tx.query<{ user_id: string; status: string; final_rank: number | null }>(
      `SELECT user_id, status, final_rank FROM entries WHERE tournament_id = $1 AND seed IS NOT NULL`,
      [t.id],
    );
    const split = splitGross(fee, seated.rows.length, tpl.rake_bps);
    // Emanet kontrolü: ayrılan oyuncuların iadesi yolda olabilir (webhook gelmeden).
    const poolCents = await this.ledger.balance(tx, `TOURNAMENT_POOL:${t.id}`);
    const pend = await tx.query<{ s: number }>(
      `SELECT COALESCE(sum(r.amount_cents), 0)::bigint AS s FROM refunds r JOIN payments p ON p.id = r.payment_id
       WHERE p.tournament_id = $1 AND r.source = 'pool' AND r.status = 'PENDING'`,
      [t.id],
    );
    const available = poolCents - (pend.rows[0] as { s: number }).s;
    if (available !== split.grossCents) {
      this.logger.error('Emanet tutarı beklenenle uyuşmuyor; hesaplaşma durduruldu', { tournamentId: t.id, available, expected: split.grossCents });
      await this.transition(tx, t, 'DISPUTED', 'pool_mismatch', 'system');
      return;
    }
    const ranks = new Map<string, number>();
    for (const r of seated.rows) if (r.final_rank !== null && r.status !== 'DISQUALIFIED') ranks.set(r.user_id, r.final_rank);
    if (![...ranks.values()].includes(1)) {
      await this.transition(tx, t, 'DISPUTED', 'no_champion', 'system');
      return;
    }
    const awards = distribute(split.poolCents, schemeFor(t.capacity, tpl.prize_scheme), ranks);
    await this.ledger.settleTournament(tx, { tournamentId: t.id, currency: tpl.currency, rakeCents: split.rakeCents, awards });
    let maxHold = new Date();
    for (const a of awards) {
      const hold = new Date(Date.now() + (this.cfg.prizeHoldSec ?? holdSecondsFor(a.cents)) * 1000);
      if (hold > maxHold) maxHold = hold;
      await tx.query(
        `INSERT INTO prize_awards (tournament_id, user_id, rank, cents, currency, hold_until) VALUES ($1, $2, $3, $4, $5, $6)`,
        [t.id, a.userId, a.rank, a.cents, tpl.currency, hold],
      );
      notes.push(() => this.hub.sendToUser(a.userId, { type: 'prize.awarded', tournamentId: t.id, rank: a.rank, cents: a.cents, currency: tpl.currency, holdUntil: hold.toISOString() }));
    }
    await tx.query(
      `UPDATE tournaments SET gross_cents = $2, rake_cents = $3, prize_pool_cents = $4, hold_until = $5 WHERE id = $1`,
      [t.id, split.grossCents, split.rakeCents, split.poolCents, maxHold],
    );
    notes.push(() => this.notify(t.id));
  }

  /**
   * Bekletmesi biten ödüller çekilebilir bakiyeye geçer. Risk kapısı 'hold' derse turnuva
   * DISPUTED olur ve karar yönetim panelinde verilir (Bölüm 9–10).
   */
  async releaseDuePrizes(): Promise<number> {
    const due = await this.pool.query<{ tournament_id: string }>(
      `SELECT DISTINCT a.tournament_id FROM prize_awards a JOIN tournaments t ON t.id = a.tournament_id
       WHERE a.status = 'PENDING' AND a.hold_until <= now() AND t.status IN ('SETTLING', 'DISPUTED') LIMIT 20`,
    );
    let released = 0;
    for (const { tournament_id: id } of due.rows) {
      released += await this.withTx(async (tx, notes) => {
        const t = await this.lock(tx, id);
        if (t.status !== 'SETTLING' && t.status !== 'DISPUTED') return 0;
        const gate = await this.riskGate(tx, id);
        if (gate.wait) return 0;
        const awardees = (await tx.query<{ user_id: string }>(`SELECT user_id FROM prize_awards WHERE tournament_id = $1 AND status = 'PENDING'`, [id])).rows.map((r) => r.user_id);
        const hold = new Set(gate.hold === 'all' ? awardees : gate.hold.filter((u) => awardees.includes(u)));
        const skip = new Set([...hold, ...gate.delay]);
        // Temiz oyuncular beklemez; yalnız işaretli oyuncunun ödülü incelemede kalır.
        const n = await this.releaseAwards(tx, t, notes, true, skip);
        if (hold.size && t.status === 'SETTLING') {
          await this.transition(tx, t, 'DISPUTED', 'fair_play_review', 'system');
          notes.push(() => this.notify(id));
        }
        return n;
      });
    }
    return released;
  }

  /** Ödülleri serbest bırakır; hepsi bittiyse SETTLED. `onlyDue=false`: yönetici kararıyla hemen. */
  async releaseAwards(tx: Connection, t: TournamentRow, notes: Notes, onlyDue: boolean, skip: ReadonlySet<string> = new Set(), only?: string): Promise<number> {
    const r = await tx.query<{ user_id: string; cents: number; currency: string }>(
      `SELECT user_id, cents, currency FROM prize_awards WHERE tournament_id = $1 AND status = 'PENDING' AND ($2 = false OR hold_until <= now())
         AND ($3::uuid IS NULL OR user_id = $3::uuid) FOR UPDATE`,
      [t.id, onlyDue, only ?? null],
    );
    const rows = { rows: r.rows.filter((a) => !skip.has(a.user_id)) };
    for (const a of rows.rows) {
      await this.ledger.releasePrize(tx, { tournamentId: t.id, userId: a.user_id, cents: a.cents, currency: a.currency });
      await tx.query(`UPDATE prize_awards SET status = 'RELEASED', released_at = now() WHERE tournament_id = $1 AND user_id = $2`, [t.id, a.user_id]);
      notes.push(() => this.hub.sendToUser(a.user_id, { type: 'prize.released', tournamentId: t.id, cents: a.cents, currency: a.currency }));
    }
    const left = await tx.query(`SELECT 1 FROM prize_awards WHERE tournament_id = $1 AND status = 'PENDING' LIMIT 1`, [t.id]);
    if (!left.rowCount && (t.status === 'SETTLING' || t.status === 'DISPUTED')) {
      await this.transition(tx, t, 'SETTLED', onlyDue ? 'hold_elapsed' : 'admin_release', 'system');
      await tx.query('UPDATE tournaments SET settled_at = now() WHERE id = $1', [t.id]);
      notes.push(() => this.notify(t.id));
    }
    return rows.rows.length;
  }

  /**
   * Hile kararı (insan onayıyla): bekletmedeki ödül iptal edilir ve FAIR_PLAY_RESERVE'e gider (K29).
   * Kalan ödüller yoksa turnuva kapanır. Mağdurlara dağıtım ayrı bir yönetim kararıdır.
   */
  async voidAward(tx: Connection, tournamentId: string, userId: string, caseId: string, notes: Notes): Promise<boolean> {
    const t = await this.lock(tx, tournamentId);
    const a = await tx.query<{ cents: number; currency: string }>(
      `SELECT cents, currency FROM prize_awards WHERE tournament_id = $1 AND user_id = $2 AND status = 'PENDING' FOR UPDATE`,
      [tournamentId, userId],
    );
    const row = a.rows[0];
    if (row) {
      await this.ledger.voidPrize(tx, { tournamentId, userId, cents: row.cents, currency: row.currency, caseId });
      await tx.query(`UPDATE prize_awards SET status = 'VOID', note = $3 WHERE tournament_id = $1 AND user_id = $2`, [tournamentId, userId, `fair_play_case:${caseId}`]);
      notes.push(() => this.hub.sendToUser(userId, { type: 'prize.voided', tournamentId }));
    }
    await tx.query(`UPDATE entries SET status = 'DISQUALIFIED' WHERE tournament_id = $1 AND user_id = $2`, [tournamentId, userId]);
    await this.closeIfDone(tx, t, notes, 'fair_play_decided');
    return !!row;
  }

  /** İnceleme temiz çıktı: oyuncunun ödülü (bekletme süresini beklemeden) serbest kalır. */
  async clearAward(tx: Connection, tournamentId: string, userId: string, notes: Notes): Promise<void> {
    const t = await this.lock(tx, tournamentId);
    await this.releaseAwards(tx, t, notes, false, new Set(), userId);
    await this.closeIfDone(tx, t, notes, 'fair_play_decided');
  }

  /** İncelemedeki turnuvanın bekleyen ödülü kalmadıysa kapanır. */
  private async closeIfDone(tx: Connection, t: TournamentRow, notes: Notes, reason: string): Promise<void> {
    if (t.status !== 'DISPUTED' && t.status !== 'SETTLING') return;
    const left = await tx.query(`SELECT 1 FROM prize_awards WHERE tournament_id = $1 AND status = 'PENDING' LIMIT 1`, [t.id]);
    const any = await tx.query(`SELECT 1 FROM prize_awards WHERE tournament_id = $1 LIMIT 1`, [t.id]);
    if (left.rowCount || !any.rowCount) return;
    await this.transition(tx, t, 'SETTLED', reason, 'system');
    await tx.query('UPDATE tournaments SET settled_at = now() WHERE id = $1', [t.id]);
    notes.push(() => this.notify(t.id));
  }

  /** Yönetici: açık ya da hazır olma aşamasındaki turnuvayı iptal eder; ödenen her koltuk iade edilir. */
  async cancel(tournamentId: string, actorId: string, reason: string): Promise<{ refunds: number }> {
    return this.withTx(async (tx, notes) => {
      const t = await this.lock(tx, tournamentId);
      if (t.status !== 'OPEN' && t.status !== 'STARTING') throw conflict('CANNOT_CANCEL', 'Yalnız açık ya da başlamamış turnuva iptal edilebilir');
      await this.transition(tx, t, 'CANCELLED', `admin:${reason}`, actorId);
      const refunds = await this.refundAll(tx, t.id, 'tournament_cancelled', notes);
      await tx.query(`UPDATE entries SET status = 'WITHDRAWN', exit_reason = 'tournament_cancelled' WHERE tournament_id = $1 AND status = 'CONFIRMED'`, [t.id]);
      await tx.query(
        `INSERT INTO audit_log (actor_id, action, target_type, target_id, data) VALUES ($1::uuid, 'tournament.cancel', 'tournament', $2, $3)`,
        [actorId, t.id, { reason, refunds }],
      );
      notes.push(() => this.notify(t.id));
      notes.push(() => void this.ensureOpen().catch(() => undefined));
      return { refunds };
    });
  }

  /** Şablondan tahmini ödül tablosu (kontenjan dolarsa). */
  private prizeTable(t: TournamentRow): { rank: number; count: number; cents: number }[] {
    const fee = Number(t.template.entry_fee_cents);
    if (!fee) return [];
    const split = splitGross(fee, t.capacity, t.template.rake_bps);
    const scheme: readonly PrizeGroup[] = schemeFor(t.capacity, t.template.prize_scheme);
    const table = scheme.map((g) => ({ rank: g.rank, count: g.count, cents: Math.floor((split.poolCents * g.bpsEach) / 10_000) }));
    const rest = split.poolCents - table.reduce((s, g) => s + g.count * g.cents, 0);
    (table[0] as { cents: number }).cents += rest; // K4
    return table;
  }

  // ---- oyun sonu → maç ilerletme (outbox tüketicisi) ----------------------------

  onGameEnded = async (event: OutboxEvent, tx: Connection, hooks: HandlerHooks): Promise<void> => {
    const e = event.payload as { kind: string; matchId: string | null; gameId: string };
    if (e.kind !== 'tournament' || !e.matchId) return;
    const notes: Notes = [];
    const mr = await tx.query<{ tournament_id: string }>('SELECT tournament_id FROM matches WHERE id = $1', [e.matchId]);
    if (!mr.rows[0]) return;
    // Kilit sırası: önce turnuva, sonra maç (kilitlenmeyi önler).
    const t = await this.lock(tx, mr.rows[0].tournament_id);
    const lr = await tx.query<MatchRow>('SELECT * FROM matches WHERE id = $1 FOR UPDATE', [e.matchId]);
    const m = lr.rows[0] as MatchRow;
    if (m.status !== 'PLAYING' || t.status !== 'RUNNING') return;

    const summaries = await this.games.summariesForMatches(tx, [m.id]);
    const outcomes: GameOutcome[] = summaries
      .filter((g) => g.status === 'finished' && g.result)
      .map((g) => ({ gameNo: g.gameNo, aWasWhite: g.whiteId === m.player_a, result: g.result as GameOutcome['result'] }));
    const verdict = judgeMatch(outcomes);
    let a = 0;
    let b = 0;
    for (const o of outcomes.filter((x) => x.gameNo <= 2)) {
      const white = o.result === '1-0' ? 1 : o.result === '0-1' ? 0 : 0.5;
      a += o.aWasWhite ? white : 1 - white;
      b += o.aWasWhite ? 1 - white : white;
    }
    await tx.query('UPDATE matches SET score_a = $2, score_b = $3, updated_at = now() WHERE id = $1', [m.id, a, b]);
    const breakAt = new Date(Date.now() + t.template.break_seconds * 1000);

    if (verdict.kind === 'next-game') {
      await this.startGame(tx, t, m, 2, false, notes, breakAt);
    } else if (verdict.kind === 'armageddon') {
      // K5: Armageddon rengi sunucuda rastgele atanır ve oyun kaydında saklanır.
      await this.startGame(tx, t, m, 3, randomInt(2) === 0, notes, breakAt, true);
    } else {
      const winner = verdict.winner === 'a' ? m.player_a : m.player_b;
      const loser = verdict.winner === 'a' ? m.player_b : m.player_a;
      if (loser) await this.eliminate(tx, t.id, loser, eliminationRank(m.round_no, roundsFor(t.capacity)));
      await this.close(tx, t, m, winner, 'DONE', verdict.by, notes);
    }
    notes.push(() => this.notify(t.id));
    hooks.afterCommit(() => {
      for (const n of notes) n();
    });
  };

  // ---- okuma ----------------------------------------------------------------

  async list() {
    const r = await this.pool.query<TournamentRow & { joined: number }>(
      `SELECT t.*, (SELECT count(*)::int FROM entries e WHERE e.tournament_id = t.id AND e.status IN ('RESERVED','CONFIRMED','ELIMINATED','WINNER')) AS joined
       FROM tournaments t
       WHERE t.status = ANY($1) OR (t.status IN ('SETTLED', 'FINISHED', 'CANCELLED') AND t.status_changed_at > now() - interval '6 hours')
       ORDER BY CASE t.status WHEN 'RUNNING' THEN 1 WHEN 'STARTING' THEN 2 WHEN 'OPEN' THEN 3 ELSE 4 END, t.created_at DESC
       LIMIT 50`,
      [ACTIVE_STATUSES],
    );
    return r.rows.map((t) => ({
      id: t.id,
      name: t.name,
      status: t.status,
      capacity: t.capacity,
      joined: t.joined,
      timeControl: t.template.time_control,
      timeControlLabel: parseTimeControl(t.template.time_control).label,
      entryFeeCents: t.template.entry_fee_cents,
      currency: t.template.currency,
      kind: t.template.kind,
      readyDeadline: t.ready_deadline,
      createdAt: t.created_at,
    }));
  }

  async detail(id: string) {
    const r = await this.pool.query<TournamentRow>('SELECT * FROM tournaments WHERE id = $1', [id]);
    const t = r.rows[0];
    if (!t) throw notFound('TOURNAMENT_NOT_FOUND', 'Turnuva bulunamadı');
    const entries = await this.pool.query<{ user_id: string; status: string; seed: number | null; final_rank: number | null; ready_at: Date | null; expires_at: Date | null }>(
      `SELECT user_id, status, seed, final_rank, ready_at, expires_at FROM entries WHERE tournament_id = $1 AND status <> 'WITHDRAWN' ORDER BY joined_at`,
      [id],
    );
    const awards = await this.pool.query<{ user_id: string; rank: number; cents: number; status: string; hold_until: Date }>(
      'SELECT user_id, rank, cents, status, hold_until FROM prize_awards WHERE tournament_id = $1 ORDER BY rank, user_id',
      [id],
    );
    const money = await this.pool.query<{ gross_cents: number | null; rake_cents: number | null; prize_pool_cents: number | null; hold_until: Date | null }>(
      'SELECT gross_cents, rake_cents, prize_pool_cents, hold_until FROM tournaments WHERE id = $1',
      [id],
    );
    const matches = await this.pool.query<MatchRow>('SELECT * FROM matches WHERE tournament_id = $1 ORDER BY round_no, slot_no', [id]);
    const games = await this.games.summariesForMatches(this.pool, matches.rows.map((m) => m.id));
    const profiles = await this.identity.publicProfiles(entries.rows.map((e) => e.user_id));
    const name = (uid: string | null) => (uid ? { id: uid, name: profiles.get(uid)?.displayName ?? '?' } : null);
    const rounds = roundsFor(t.capacity);
    return {
      id: t.id,
      name: t.name,
      status: t.status,
      capacity: t.capacity,
      rounds,
      roundNames: Array.from({ length: rounds }, (_, i) => roundName(i + 1, rounds)),
      timeControl: t.template.time_control,
      timeControlLabel: parseTimeControl(t.template.time_control).label,
      entryFeeCents: t.template.entry_fee_cents,
      currency: t.template.currency,
      kind: t.template.kind,
      rakeBps: t.template.rake_bps,
      /** Kontenjan dolarsa ödül tablosu (şablondan). */
      prizes: this.prizeTable(t),
      settlement: money.rows[0]?.gross_cents != null ? {
        grossCents: money.rows[0].gross_cents, rakeCents: money.rows[0].rake_cents, prizePoolCents: money.rows[0].prize_pool_cents, holdUntil: money.rows[0].hold_until,
      } : null,
      awards: awards.rows.map((a) => ({ ...name(a.user_id), rank: a.rank, cents: a.cents, status: a.status, holdUntil: a.hold_until })),
      readySeconds: t.template.ready_seconds,
      breakSeconds: t.template.break_seconds,
      readyDeadline: t.ready_deadline,
      startsAt: t.starts_at,
      seedHash: t.seed_hash,
      seed: t.seed_revealed ? t.seed_secret : null,
      createdAt: t.created_at,
      entries: entries.rows.map((e) => ({
        ...name(e.user_id),
        status: e.status,
        seed: e.seed,
        finalRank: e.final_rank,
        ready: !!e.ready_at,
        reservedUntil: e.status === 'RESERVED' ? e.expires_at : null,
      })),
      matches: matches.rows.map((m) => ({
        id: m.id,
        round: m.round_no,
        slot: m.slot_no,
        a: name(m.player_a),
        b: name(m.player_b),
        scoreA: m.score_a,
        scoreB: m.score_b,
        winnerId: m.winner_id,
        status: m.status,
        decidedBy: m.decided_by,
        games: games
          .filter((g) => g.matchId === m.id)
          .map((g) => ({ id: g.id, gameNo: g.gameNo, status: g.status, result: g.result, reason: g.reason, whiteId: g.whiteId, armageddon: g.armageddon, startAt: g.startAt })),
      })),
    };
  }

  /** Commit-reveal doğrulaması: açıklanan seed ile sıra herkesçe yeniden üretilebilir. */
  async verify(id: string) {
    const r = await this.pool.query<TournamentRow>('SELECT * FROM tournaments WHERE id = $1', [id]);
    const t = r.rows[0];
    if (!t) throw notFound('TOURNAMENT_NOT_FOUND', 'Turnuva bulunamadı');
    if (!t.seed_revealed) return { seedHash: t.seed_hash, revealed: false };
    const entries = await this.pool.query<{ user_id: string; seed: number }>(
      `SELECT user_id, seed FROM entries WHERE tournament_id = $1 AND seed IS NOT NULL ORDER BY seed`,
      [id],
    );
    const players = entries.rows.map((e) => e.user_id);
    const recomputed = verifiableShuffle(players, t.seed_secret, t.id);
    return {
      revealed: true,
      seedHash: t.seed_hash,
      seed: t.seed_secret,
      hashMatches: seedCommitment(t.seed_secret) === t.seed_hash,
      algorithm: 'Oyuncu kimlikleri sıralanır; i = n-1..1 için j = HMAC-SHA256(seed, "<turnuvaId>:<i>:<sayaç>") ilk 4 bayt (reddetme örneklemesi) mod (i+1); a[i] ↔ a[j].',
      sortedPlayers: [...players].sort(),
      order: recomputed,
      orderMatches: recomputed.every((p, i) => p === players[i]),
    };
  }

  /** Kullanıcının aktif turnuvası (lobide göstermek için). */
  async activeOf(userId: string): Promise<string | null> {
    const r = await this.pool.query<{ id: string }>(
      `SELECT t.id FROM entries e JOIN tournaments t ON t.id = e.tournament_id
       WHERE e.user_id = $1 AND e.status IN ('RESERVED', 'CONFIRMED') AND t.status = ANY($2) LIMIT 1`,
      [userId, ACTIVE_STATUSES],
    );
    return r.rows[0]?.id ?? null;
  }

  // ---- bildirim ----------------------------------------------------------------

  notify(tournamentId: string): void {
    if (this.notifyTimers.has(tournamentId)) return;
    const timer = setTimeout(() => {
      this.notifyTimers.delete(tournamentId);
      void this.detail(tournamentId)
        .then((d) => {
          this.hub.publish(`tournament:${tournamentId}`, { type: 'tournament.update', tournament: d });
          this.hub.publish('lobby', { type: 'lobby.update' });
        })
        .catch((e) => this.logger.error('Turnuva bildirimi başarısız', { error: e }));
    }, 30);
    timer.unref();
    this.notifyTimers.set(tournamentId, timer);
  }

  private registerWs(): void {
    this.hub.on('tournament.subscribe', async (conn, msg) => {
      const id = String(msg.tournamentId ?? '');
      const d = await this.detail(id);
      this.hub.subscribe(conn, `tournament:${id}`);
      conn.send({ type: 'tournament.update', tournament: d });
      return undefined;
    });
    this.hub.on('tournament.unsubscribe', (conn, msg) => {
      this.hub.unsubscribe(conn, `tournament:${String(msg.tournamentId ?? '')}`);
      return undefined;
    });
    this.hub.on('tournament.ready', async (_conn, msg, user) => {
      if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Giriş gerekli');
      await this.ready(user.id, String(msg.tournamentId ?? ''));
      return { ok: true };
    });
    this.hub.on('lobby.subscribe', (conn) => {
      this.hub.subscribe(conn, 'lobby');
      return undefined;
    });
  }
}
