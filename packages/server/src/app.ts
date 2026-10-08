/**
 * Uygulamanın birleştirildiği yer (modüler monolit). Modüller birbirinin
 * tablolarına dokunmaz; servis arayüzleri ve outbox olaylarıyla konuşur.
 */
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { migrate } from './infra/db/migrate.ts';
import { Pool } from './infra/db/pg.ts';
import { OutboxDispatcher } from './infra/events/outbox.ts';
import { createLogger, type Logger } from './infra/log.ts';
import { RateLimiter } from './infra/http/ratelimit.ts';
import { clientIp, Router } from './infra/http/router.ts';
import { WsHub } from './infra/ws/hub.ts';
import { WsServer } from './infra/ws/server.ts';
import { identityRoutes } from './modules/identity/routes.ts';
import { IdentityService } from './modules/identity/service.ts';
import { GameService } from './modules/game/service.ts';
import { isUuid, parse } from './infra/http/validate.ts';
import { BotService } from './modules/bot/service.ts';
import { RatingService } from './modules/rating/service.ts';
import { TournamentService } from './modules/tournament/service.ts';
import { LedgerService } from './modules/ledger/service.ts';
import { FlagService } from './modules/admin/flags.ts';
import type { PaymentProvider } from './modules/payments/provider.ts';
import { SandboxPsp } from './modules/payments/sandbox.ts';
import { PaymentService } from './modules/payments/service.ts';
import { StripePsp } from './modules/payments/stripe.ts';
import { RULES } from './infra/http/ratelimit.ts';
import { badRequest, forbidden } from './infra/errors.ts';
import { notFound } from './infra/errors.ts';

export const WEB_DIR = join(import.meta.dirname, '..', '..', '..', 'apps', 'web', 'public');

export interface App {
  cfg: Config;
  pool: Pool;
  logger: Logger;
  http: Server;
  hub: WsHub;
  events: OutboxDispatcher;
  identity: IdentityService;
  games: GameService;
  bots: BotService;
  ratings: RatingService;
  tournaments: TournamentService;
  ledger: LedgerService;
  payments: PaymentService;
  flags: FlagService;
  /** Yalnız PAYMENT_PROVIDER=sandbox iken. */
  sandbox: SandboxPsp | null;
  /** Dinlenen gerçek port (0 verilirse işletim sisteminin seçtiği). */
  port: number;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createApp(cfg: Config, opts: { logger?: Logger; runMigrations?: boolean } = {}): Promise<App> {
  const logger = opts.logger ?? createLogger();
  const pool = Pool.fromUrl(cfg.databaseUrl, { max: 20 });
  if (opts.runMigrations !== false) {
    const m = await migrate(pool);
    if (m.applied.length) logger.info('Migrasyonlar uygulandı', { applied: m.applied });
  }

  const events = new OutboxDispatcher(pool, logger.child({ part: 'outbox' }));
  const ledger = new LedgerService(pool);
  const flags = new FlagService(pool);
  const identity = new IdentityService(pool, cfg);
  const limiter = new RateLimiter();
  const router = new Router({
    logger,
    authenticate: identity.authenticate,
    staticDir: cfg.serveWeb ? WEB_DIR : null,
    secureCookies: cfg.env === 'production',
    limiter,
  });
  const hub = new WsHub({ logger: logger.child({ part: 'ws' }), authenticate: identity.authenticate, sessionActive: (s) => identity.sessionActive(s) });
  const wss = new WsServer({ logger });

  router.get('/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true, ws: wss.size, db: pool.stats };
  });
  identityRoutes(router, identity, cfg);

  const games = new GameService({
    pool,
    cfg,
    logger: logger.child({ part: 'game' }),
    hub,
    profiles: (ids) => identity.publicProfiles(ids),
  });
  router.get('/v1/games/:id', async (ctx) => {
    if (!isUuid(ctx.params.id)) throw notFound('GAME_NOT_FOUND', 'Oyun bulunamadı');
    return games.state(ctx.params.id as string);
  });
  router.post('/v1/games/:id/resign', async (ctx) => {
    await games.resign(ctx.requireUser(), ctx.params.id as string);
    return { ok: true };
  });
  router.get('/v1/me/live-games', async (ctx) => ({ games: games.liveGamesOf(ctx.requireUser().id) }));

  // ---- M4a bot ve M6 rating ----
  const bots = new BotService({ cfg, games, pool, logger: logger.child({ part: 'bot' }) });
  games.setBotDriver(bots);
  const ratings = new RatingService(pool);
  events.subscribe('rating', ['game.ended'], ratings.onGameEnded);

  router.get('/v1/bots/levels', () => ({ levels: bots.levels(), engine: bots.engineKind }));
  router.post('/v1/bots/games', async (ctx) => {
    const user = ctx.requireUser();
    const b = parse(
      {
        level: { type: 'string', enum: bots.levels().map((l) => l.id) },
        color: { type: 'string', enum: ['white', 'black', 'random'] as const },
        timeControl: { type: 'string', enum: ['60+0', '120+1', '180+2', '300+3', '300+0', '600+5', '900+10'] },
      },
      ctx.body,
    );
    ctx.status = 201;
    return bots.createGame(user.id, b as { level: string; color: 'white' | 'black' | 'random'; timeControl: string });
  });
  router.get('/v1/me/ratings', async (ctx) => ({ ratings: await ratings.ratingsOf(ctx.requireUser().id) }));
  router.get('/v1/users/:id', async (ctx) => {
    if (!isUuid(ctx.params.id)) throw notFound('USER_NOT_FOUND', 'Kullanıcı bulunamadı');
    const prof = (await identity.publicProfiles([ctx.params.id as string])).get(ctx.params.id as string);
    if (!prof) throw notFound('USER_NOT_FOUND', 'Kullanıcı bulunamadı');
    return { user: prof, ratings: await ratings.ratingsOf(prof.id) };
  });

  // ---- M7 ödeme ----
  let sandbox: SandboxPsp | null = null;
  let provider: PaymentProvider;
  if (cfg.paymentProvider === 'sandbox') {
    sandbox = new SandboxPsp({
      pool,
      logger: logger.child({ part: 'sandbox-psp' }),
      webhookSecret: cfg.pspWebhookSecret,
      // Sandbox aynı süreçte çalışır; webhook'u gerçek HTTP isteğiyle kendi adresimize gönderir.
      webhookUrl: () => `http://127.0.0.1:${app.port}/v1/webhooks/psp`,
      options: { deliveryDelayMs: cfg.sandboxDeliveryDelayMs, duplicateRate: cfg.sandboxDuplicateRate },
    });
    sandbox.routes(router);
    provider = sandbox;
  } else {
    provider = new StripePsp({
      secretKey: cfg.stripeSecretKey as string,
      webhookSecret: cfg.pspWebhookSecret,
      publicBaseUrl: cfg.publicBaseUrl as string,
      apiBase: cfg.stripeApiBase,
    });
  }
  const payments = new PaymentService({ pool, logger: logger.child({ part: 'payments' }), provider, ledger, identity });
  router.post('/v1/webhooks/psp', async (ctx) => {
    const r = await payments.handleWebhook(ctx.rawBody, ctx.req.headers);
    return { received: true, duplicate: r.duplicate };
  });
  router.get('/v1/payments/:id', async (ctx) => payments.getForUser(ctx.requireUser().id, ctx.params.id as string));
  router.get('/v1/me/payments', async (ctx) => ({ payments: await payments.listForUser(ctx.requireUser().id) }));

  // ---- M5 turnuva ----
  const tournaments = new TournamentService({ pool, cfg, logger: logger.child({ part: 'tournament' }), hub, games, identity, ratings, payments, ledger, flags });
  events.subscribe('tournament', ['game.ended'], tournaments.onGameEnded);
  events.subscribe('tournament-payments', ['payment.succeeded', 'payment.failed'], (ev, tx, hooks) =>
    ev.topic === 'payment.succeeded' ? tournaments.onPaymentSucceeded(ev, tx, hooks) : tournaments.onPaymentFailed(ev, tx, hooks));
  events.subscribe('settlement', ['tournament.finished'], tournaments.onTournamentFinished);
  const tid = (ctx: { params: Record<string, string> }): string => {
    if (!isUuid(ctx.params.id)) throw notFound('TOURNAMENT_NOT_FOUND', 'Turnuva bulunamadı');
    return ctx.params.id as string;
  };
  router.get('/v1/tournaments', async (ctx) => ({
    tournaments: await tournaments.list(),
    active: ctx.user ? await tournaments.activeOf(ctx.user.id) : null,
  }));
  router.get('/v1/tournaments/:id', async (ctx) => tournaments.detail(tid(ctx)));
  router.get('/v1/tournaments/:id/verify', async (ctx) => tournaments.verify(tid(ctx)));
  router.post('/v1/tournaments/:id/join', async (ctx) => {
    const u = ctx.requireUser();
    ctx.limit(`join:${u.id}`, RULES.join);
    return tournaments.join(u.id, tid(ctx), { ip: ctx.ip, deviceKey: ctx.deviceKey });
  });
  router.post('/v1/tournaments/:id/leave', async (ctx) => {
    const r = await tournaments.leave(ctx.requireUser().id, tid(ctx));
    return { ok: true, refund: r.refund };
  });
  router.post('/v1/tournaments/:id/pay', async (ctx) => {
    const u = ctx.requireUser();
    ctx.limit(`join:${u.id}`, RULES.join);
    return tournaments.resumePayment(u.id, tid(ctx));
  });
  router.get('/v1/me/wallet', async (ctx) => {
    const u = ctx.requireUser();
    const awards = await pool.query<{ tournament_id: string; name: string; rank: number; cents: number; currency: string; status: string; hold_until: Date; released_at: Date | null }>(
      `SELECT a.tournament_id, t.name, a.rank, a.cents, a.currency, a.status, a.hold_until, a.released_at
       FROM prize_awards a JOIN tournaments t ON t.id = a.tournament_id WHERE a.user_id = $1 ORDER BY a.created_at DESC LIMIT 50`,
      [u.id],
    );
    return {
      balances: await ledger.userBalances(u.id),
      awards: awards.rows.map((a) => ({
        tournamentId: a.tournament_id, tournamentName: a.name, rank: a.rank, cents: a.cents, currency: a.currency,
        status: a.status, holdUntil: a.hold_until, releasedAt: a.released_at,
      })),
      payments: await payments.listForUser(u.id, 20),
      history: await ledger.userHistory(u.id, 50),
      // Para çekme (payout) KYC ile birlikte açılır (doküman 5.4–5.5); bu sürümde yalnız bakiye görünür.
      withdrawals: { available: false, reason: 'KYC_REQUIRED' },
    };
  });
  router.post('/v1/tournaments/:id/ready', async (ctx) => {
    await tournaments.ready(ctx.requireUser().id, tid(ctx));
    return { ok: true };
  });

  // ---- yönetim (M13 iskeleti): şablonlar ----
  const requireAdmin = (ctx: { requireUser(): { roles: string[] } }) => {
    if (!ctx.requireUser().roles.includes('admin')) throw forbidden();
  };
  router.get('/v1/admin/tournament-templates', async (ctx) => {
    requireAdmin(ctx);
    return { templates: (await pool.query('SELECT * FROM tournament_templates ORDER BY created_at')).rows };
  });
  router.post('/v1/admin/tournament-templates', async (ctx) => {
    requireAdmin(ctx);
    const b = parse(
      {
        code: { type: 'string', pattern: /^[a-z0-9-]{3,40}$/ },
        name: { type: 'string', min: 3, max: 80 },
        capacity: { type: 'int', min: 4, max: 32 },
        timeControl: { type: 'string', pattern: /^\d{1,5}\+\d{1,3}$/ },
        readySeconds: { type: 'int', min: 5, max: 600 },
        breakSeconds: { type: 'int', min: 0, max: 600 },
      },
      ctx.body,
    );
    if (![4, 8, 16, 32].includes(b.capacity)) throw badRequest('VALIDATION', 'Kontenjan 4, 8, 16 ya da 32 olmalı');
    const r = await pool.query(
      `INSERT INTO tournament_templates (code, name, kind, capacity, time_control, ready_seconds, break_seconds)
       VALUES ($1, $2, 'free', $3, $4, $5, $6) RETURNING *`,
      [b.code, b.name, b.capacity, b.timeControl, b.readySeconds, b.breakSeconds],
    );
    await pool.query(`INSERT INTO audit_log (actor_id, action, target_type, target_id, data, ip) VALUES ($1::uuid, 'template.create', 'tournament_template', $2::text, $3, $4)`,
      [ctx.requireUser().id, (r.rows[0] as { id: string }).id, b, ctx.ip]);
    await tournaments.ensureOpen();
    ctx.status = 201;
    return { template: r.rows[0] };
  });

  const http = createServer((req, res) => void router.handle(req, res));
  http.on('upgrade', (req, socket) => {
    if (!req.url?.startsWith('/v1/ws')) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, clientIp(req), hub.accept);
  });

  const sweeper = setInterval(() => limiter.sweep(), 60_000);
  sweeper.unref();

  const app: App = {
    cfg,
    pool,
    logger,
    http,
    hub,
    events,
    identity,
    games,
    bots,
    ratings,
    tournaments,
    ledger,
    payments,
    flags,
    sandbox,
    port: cfg.port,
    async start() {
      await new Promise<void>((resolve) => http.listen(cfg.port, cfg.host, resolve));
      const addr = http.address();
      app.port = typeof addr === 'object' && addr ? addr.port : cfg.port;
      events.start();
      payments.start();
      sandbox?.start();
      await games.start();
      await tournaments.start();
      logger.info('Sunucu hazır', { url: `http://${cfg.host}:${app.port}` });
    },
    async stop() {
      events.stop();
      payments.stop();
      sandbox?.stop();
      tournaments.stop();
      games.stop();
      bots.stop();
      clearInterval(sweeper);
      wss.closeAll();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      http.closeAllConnections?.();
      await pool.end();
    },
  };
  return app;
}
