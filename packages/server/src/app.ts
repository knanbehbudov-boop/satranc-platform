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
import { adminRoutes } from './modules/admin/routes.ts';
import { AdminService } from './modules/admin/service.ts';
import { DemoService } from './modules/demo/service.ts';
import { AnalysisService } from './modules/fairplay/analysis.ts';
import { FairPlayService } from './modules/fairplay/service.ts';
import type { PaymentProvider } from './modules/payments/provider.ts';
import { SandboxPsp } from './modules/payments/sandbox.ts';
import { PaymentService } from './modules/payments/service.ts';
import { StripePsp } from './modules/payments/stripe.ts';
import { WalletService, type PayoutMethod } from './modules/wallet/service.ts';
import { RULES } from './infra/http/ratelimit.ts';
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
  wallet: WalletService;
  flags: FlagService;
  analysis: AnalysisService;
  fairplay: FairPlayService;
  admin: AdminService;
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

  // K44: arka plandaki motorun adı dışarıya verilmez.
  router.get('/v1/bots/levels', () => ({ levels: bots.levels() }));
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

  // ---- K43 cüzdan ve para çekme ----
  const wallet = new WalletService({ pool, cfg, logger: logger.child({ part: 'wallet' }), hub, ledger, payments });
  events.subscribe('wallet-notify', ['wallet.deposited'], async (ev, _tx, hooks) => {
    const e = ev.payload as { userId: string; paymentId: string; amountCents: number };
    hooks.afterCommit(() => hub.sendToUser(e.userId, { type: 'wallet.deposited', paymentId: e.paymentId, amountCents: e.amountCents }));
  });
  router.get('/v1/me/balance', async (ctx) => ({ balances: await ledger.userBalances(ctx.requireUser().id) }));
  router.post('/v1/me/wallet/deposit', async (ctx) => {
    const u = ctx.requireUser();
    ctx.limit(`deposit:${u.id}`, RULES.join);
    const b = parse({ amountCents: { type: 'int', min: 1, max: 10_000_000 }, key: { type: 'string', min: 8, max: 64, optional: true } }, ctx.body);
    return wallet.deposit(u.id, b.amountCents, b.key ?? null);
  });
  router.get('/v1/me/wallet/quote', async (ctx) => {
    ctx.requireUser();
    const amount = Number(ctx.query.get('amountCents'));
    const method = (ctx.query.get('method') === 'bank' ? 'bank' : 'ewallet') as PayoutMethod;
    if (!Number.isSafeInteger(amount) || amount <= 0) return { ...wallet.quote(0, method), notice: wallet.rules().notice };
    return { ...wallet.quote(amount, method), notice: wallet.rules().notice };
  });
  router.post('/v1/me/withdrawals', async (ctx) => {
    const u = ctx.requireUser();
    ctx.limit(`withdraw:${u.id}`, RULES.join);
    const b = parse(
      {
        amountCents: { type: 'int', min: 1, max: 100_000_000 },
        method: { type: 'string', pattern: /^(ewallet|bank)$/ },
        destination: { type: 'string', min: 3, max: 120 },
        holderName: { type: 'string', min: 2, max: 80 },
      },
      ctx.body,
    );
    ctx.status = 201;
    const r = await wallet.requestWithdrawal(u.id, { amountCents: b.amountCents, method: b.method as PayoutMethod, destination: b.destination, holderName: b.holderName });
    return r.withdrawal;
  });
  router.post('/v1/me/withdrawals/:id/cancel', async (ctx) => wallet.cancelWithdrawal(ctx.requireUser().id, ctx.params.id as string));
  router.post('/v1/me/close-account', async (ctx) => {
    const u = ctx.requireUser();
    const b = parse(
      {
        method: { type: 'string', pattern: /^(ewallet|bank)$/, optional: true },
        destination: { type: 'string', min: 3, max: 120, optional: true },
        holderName: { type: 'string', min: 2, max: 80, optional: true },
      },
      ctx.body ?? {},
    );
    return wallet.requestWithdrawal(u.id, {
      method: (b.method ?? 'ewallet') as PayoutMethod,
      destination: b.destination ?? 'yok',
      holderName: b.holderName ?? 'yok',
      closeAccount: true,
    });
  });

  // ---- M5 turnuva ----
  const tournaments = new TournamentService({ pool, cfg, logger: logger.child({ part: 'tournament' }), hub, games, identity, ratings, payments, ledger, flags });
  events.subscribe('tournament', ['game.ended'], tournaments.onGameEnded);
  events.subscribe('tournament-payments', ['payment.succeeded', 'payment.failed'], (ev, tx, hooks) =>
    ev.topic === 'payment.succeeded' ? tournaments.onPaymentSucceeded(ev, tx, hooks) : tournaments.onPaymentFailed(ev, tx, hooks));
  events.subscribe('settlement', ['tournament.finished'], tournaments.onTournamentFinished);

  // ---- M4b analiz ve M10 adil oyun ----
  const analysis = new AnalysisService({ pool, cfg, logger: logger.child({ part: 'analysis' }) });
  const fairplay = new FairPlayService({ pool, cfg, logger: logger.child({ part: 'fairplay' }), hub, games, identity, ratings });
  events.subscribe('analysis', ['game.ended'], analysis.onGameEnded);
  events.subscribe('fairplay', ['analysis.completed', 'analysis.failed'], (ev, tx, hooks) =>
    ev.topic === 'analysis.completed' ? fairplay.onAnalysisCompleted(ev, tx, hooks) : fairplay.onAnalysisFailed(ev, tx));
  tournaments.riskGate = fairplay.gate;
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
    const body = (ctx.body ?? {}) as { useWallet?: unknown };
    const useWallet = typeof body.useWallet === 'boolean' ? body.useWallet : undefined;
    return tournaments.join(u.id, tid(ctx), { ip: ctx.ip, deviceKey: ctx.deviceKey, ...(useWallet === undefined ? {} : { useWallet }) });
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
      // K43: para çekme talebi; ödeme yönetici tarafından yapılır ve işaretlenir.
      withdrawals: { available: true, rules: wallet.rules(), items: await wallet.myWithdrawals(u.id) },
    };
  });
  router.post('/v1/tournaments/:id/ready', async (ctx) => {
    await tournaments.ready(ctx.requireUser().id, tid(ctx));
    return { ok: true };
  });

  // ---- M13 yönetim ----
  const admin = new AdminService({ pool, logger: logger.child({ part: 'admin' }), identity, tournaments, fairplay, analysis, payments, ledger, flags });
  adminRoutes(router, { admin, fairplay, analysis, payments, tournaments, pool, wallet });

  // ---- arayüzün bilmesi gereken genel ayarlar ----
  router.get('/v1/config', () => ({
    demoTools: cfg.demoTools,
    paymentProvider: cfg.paymentProvider,
    paidMinRatedGames: cfg.paidMinRatedGames,
  }));

  // ---- demo araçları (yalnız DEMO_TOOLS=1, üretim dışı) ----
  const demo = cfg.demoTools
    ? new DemoService({ pool, cfg, logger: logger.child({ part: 'demo' }), identity, tournaments, games, baseUrl: () => `http://127.0.0.1:${app.port}` })
    : null;
  if (demo) {
    router.post('/v1/admin/tournaments/:id/fill-bots', async (ctx) => {
      const s = await admin.requireStaff(ctx.requireUser().id, []);
      if (!isUuid(ctx.params.id)) throw notFound('TOURNAMENT_NOT_FOUND', 'Turnuva bulunamadı');
      const b = (ctx.body ?? {}) as { leaveSeats?: number };
      const leave = Number.isInteger(b.leaveSeats) ? Math.max(0, Math.min(31, b.leaveSeats as number)) : 0;
      return demo.fill(ctx.params.id as string, s.id, leave);
    });
  }

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
    wallet,
    flags,
    analysis,
    fairplay,
    admin,
    sandbox,
    port: cfg.port,
    async start() {
      await new Promise<void>((resolve) => http.listen(cfg.port, cfg.host, resolve));
      const addr = http.address();
      app.port = typeof addr === 'object' && addr ? addr.port : cfg.port;
      events.start();
      payments.start();
      sandbox?.start();
      analysis.start();
      await games.start();
      await tournaments.start();
      await demo?.start().catch((e) => logger.error('Demo botları başlatılamadı', { error: e }));
      logger.info('Sunucu hazır', { url: `http://${cfg.host}:${app.port}` });
    },
    async stop() {
      events.stop();
      payments.stop();
      sandbox?.stop();
      analysis.stop();
      tournaments.stop();
      demo?.stop();
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
