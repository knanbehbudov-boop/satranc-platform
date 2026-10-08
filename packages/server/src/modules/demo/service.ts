/**
 * Demo araçları (yalnız DEMO_TOOLS=1 ve üretim dışı): platformu tek başına, örneğin bir
 * iPad'den denemek için.
 *  - İlk iki gerçek hesap yönetici olur (dört göz onayını iki hesapla denemek için).
 *  - Yönetici, açık bir turnuvanın boş koltuklarını "test botları" ile doldurabilir. Botlar
 *    gerçek kullanıcı gibi davranır: giriş yapar, WebSocket'e bağlanır, ücretliyse sandbox
 *    sayfasından öder, "Hazırım" der ve oynar. İnsana karşı yavaş ve zayıf oynarlar
 *    (kazanılabilir); iki bot karşılaşırsa biri kısa sürede teslim olur.
 *  - Sunucu yeniden başlarsa (ücretsiz barındırmada uyku) botlar kaldıkları yerden bağlanır.
 */
import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { ChessGame } from '@satranc/chess-core';
import type { Config } from '../../config.ts';
import type { Pool } from '../../infra/db/pg.ts';
import { conflict, notFound } from '../../infra/errors.ts';
import type { Logger } from '../../infra/log.ts';
import { hashPassword } from '../identity/crypto.ts';
import type { IdentityService } from '../identity/service.ts';
import type { TournamentService } from '../tournament/service.ts';

export const BOT_EMAIL_DOMAIN = 'demo-bot.invalid';

class DemoBot {
  readonly id: string;
  readonly name: string;
  private ws: WebSocket | null = null;
  private readonly busy = new Set<string>();
  private readonly games = new Map<string, { myColor: 'w' | 'b'; opponentId: string }>();
  private readonly svc: DemoService;
  private closed = false;
  token: string;

  constructor(svc: DemoService, id: string, name: string, token: string) {
    this.svc = svc;
    this.id = id;
    this.name = name;
    this.token = token;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.svc.baseUrl().replace(/^http/, 'ws') + '/v1/ws');
      this.ws = ws;
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: this.token }));
        resolve();
      }, { once: true });
      ws.addEventListener('error', () => reject(new Error('bot bağlanamadı')), { once: true });
      ws.addEventListener('message', (ev) => {
        let m: any;
        try { m = JSON.parse(String(ev.data)); } catch { return; }
        void this.onMessage(m).catch((e) => this.svc.logger.warn('Demo bot hatası', { bot: this.name, error: e }));
      });
      ws.addEventListener('close', () => {
        if (!this.closed) setTimeout(() => void this.reconnect(), 2000).unref();
      });
    });
  }

  private async reconnect(): Promise<void> {
    if (this.closed) return;
    try {
      this.token = await this.svc.tokenFor(this.id);
      await this.connect();
      for (const g of this.svc.games.liveGamesOf(this.id)) this.send({ type: 'game.join', gameId: g });
    } catch {
      setTimeout(() => void this.reconnect(), 5000).unref();
    }
  }

  send(m: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  private async onMessage(m: any): Promise<void> {
    if (m.type === 'auth.ok') {
      for (const g of this.svc.games.liveGamesOf(this.id)) this.send({ type: 'game.join', gameId: g });
    } else if (m.type === 'tournament.readyCheck') {
      setTimeout(() => this.send({ type: 'tournament.ready', tournamentId: m.tournamentId }), 500 + randomInt(1500)).unref();
    } else if (m.type === 'game.started' || m.type === 'match.ready') {
      this.send({ type: 'game.join', gameId: m.gameId });
    } else if (m.type === 'game.state' && m.status === 'active') {
      const myColor = m.players.w.id === this.id ? 'w' : m.players.b.id === this.id ? 'b' : null;
      if (!myColor) return;
      this.games.set(m.gameId, { myColor, opponentId: myColor === 'w' ? m.players.b.id : m.players.w.id });
      this.act(m.gameId, m.fen, m.ply);
    } else if (m.type === 'game.move') {
      if (this.games.has(m.gameId)) this.act(m.gameId, m.fen, m.ply);
    } else if (m.type === 'game.end') {
      this.games.delete(m.gameId);
      if (!this.svc.games.liveGamesOf(this.id).length && !(await this.svc.stillActive(this.id))) this.svc.retire(this);
    }
  }

  private act(gameId: string, fen: string, ply: number): void {
    const g = this.games.get(gameId);
    if (!g) return;
    const chess = new ChessGame({ fen });
    if (chess.turn !== g.myColor) return;
    const key = `${gameId}:${ply}`;
    if (this.busy.has(key)) return;
    this.busy.add(key);
    const vsBot = this.svc.isBot(g.opponentId);
    // İki bot karşılaşırsa oyun uzamasın: kimliği küçük olan 12. yarım hamleden sonra teslim olur.
    if (vsBot && ply >= 12 && this.id < g.opponentId) {
      setTimeout(() => this.send({ type: 'game.resign', gameId }), 300).unref();
      return;
    }
    const moves = chess.moves();
    if (!moves.length) return;
    const mate = moves.find((x) => x.san.includes('#'));
    const captures = moves.filter((x) => x.captured);
    // İnsana karşı zayıf: çoğu zaman rastgele, bazen taş alır.
    const pick = mate ?? (captures.length && randomInt(3) === 0 ? captures[randomInt(captures.length)] : moves[randomInt(moves.length)]);
    const delay = vsBot ? 200 + randomInt(300) : 800 + randomInt(1700);
    setTimeout(() => this.send({ type: 'game.move', gameId, uci: pick!.uci, seq: ply + 1 }), delay).unref();
  }
}

export class DemoService {
  private readonly pool: Pool;
  private readonly cfg: Config;
  readonly logger: Logger;
  private readonly identity: IdentityService;
  private readonly tournaments: TournamentService;
  readonly games: { liveGamesOf(userId: string): string[] };
  readonly baseUrl: () => string;
  private readonly bots = new Map<string, DemoBot>();

  constructor(deps: { pool: Pool; cfg: Config; logger: Logger; identity: IdentityService; tournaments: TournamentService; games: { liveGamesOf(userId: string): string[] }; baseUrl: () => string }) {
    this.pool = deps.pool;
    this.cfg = deps.cfg;
    this.logger = deps.logger;
    this.identity = deps.identity;
    this.tournaments = deps.tournaments;
    this.games = deps.games;
    this.baseUrl = deps.baseUrl;
  }

  private password(email: string): string {
    return `Bot-${createHmac('sha256', this.cfg.jwtSecret).update(email).digest('hex').slice(0, 24)}!`;
  }

  isBot(userId: string): boolean {
    return this.bots.has(userId);
  }

  async tokenFor(userId: string): Promise<string> {
    const r = await this.pool.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId]);
    const email = (r.rows[0] as { email: string }).email;
    const login = await this.identity.login(email, this.password(email), { ip: '127.0.0.1', userAgent: 'demo-bot', deviceKey: `bot-${userId.slice(0, 8)}` });
    return login.accessToken;
  }

  async stillActive(userId: string): Promise<boolean> {
    return !!(await this.tournaments.activeOf(userId));
  }

  retire(bot: DemoBot): void {
    bot.close();
    this.bots.delete(bot.id);
  }

  private async createBot(): Promise<DemoBot> {
    const tag = randomBytes(3).toString('hex');
    const email = `demo-bot-${tag}@${BOT_EMAIL_DOMAIN}`;
    const name = `TestBot_${tag}`;
    const hash = await hashPassword(this.password(email));
    const r = await this.pool.query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash, country_code, birth_year, tos_version, tos_accepted_at, email_verified_at)
       VALUES ($1, $2, $3, 'GB', 1990, $4, now(), now()) RETURNING id`,
      [email, name, hash, this.cfg.tosVersion],
    );
    const id = (r.rows[0] as { id: string }).id;
    return this.attach(id, name);
  }

  private async attach(id: string, name: string): Promise<DemoBot> {
    const bot = new DemoBot(this, id, name, await this.tokenFor(id));
    this.bots.set(id, bot);
    await bot.connect();
    return bot;
  }

  /** Açık turnuvanın boş koltuklarını botlarla doldurur; ücretliyse botlar sandbox'ta öder. */
  async fill(tournamentId: string, actorId: string, leaveSeats = 0): Promise<{ added: number }> {
    const d = await this.tournaments.detail(tournamentId);
    if (d.status !== 'OPEN') throw conflict('TOURNAMENT_NOT_OPEN', 'Yalnız kayıt açık turnuva doldurulabilir');
    const taken = d.entries.filter((e: { status: string }) => e.status === 'RESERVED' || e.status === 'CONFIRMED').length;
    const free = d.capacity - taken - leaveSeats;
    if (free <= 0) throw conflict('NO_FREE_SEATS', 'Boş koltuk yok');
    let added = 0;
    for (let i = 0; i < free; i++) {
      const bot = await this.createBot();
      const j = await this.tournaments.join(bot.id, tournamentId, { ip: `demo-${bot.id.slice(0, 8)}`, deviceKey: `bot-${bot.id.slice(0, 8)}` });
      if (j.status === 'RESERVED') {
        if (!j.checkoutUrl) throw new Error('Bot için ödeme sayfası açılamadı');
        const u = new URL(j.checkoutUrl, this.baseUrl());
        const res = await fetch(`${this.baseUrl()}/sandbox-psp/v1/checkout/${u.pathname.split('/').pop()}/pay`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ secret: u.searchParams.get('secret'), card: '4242424242424242', exp: '12/39', cvc: '123' }),
        });
        if (!res.ok) throw new Error(`Bot ödemesi başarısız: ${res.status}`);
      }
      added++;
    }
    await this.pool.query(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id, data) VALUES ($1::uuid, 'demo.fill_bots', 'tournament', $2, $3)`,
      [actorId, tournamentId, { added }],
    );
    return { added };
  }

  /** Sunucu yeniden başladığında aktif botları yeniden bağlar. */
  async start(): Promise<void> {
    const r = await this.pool.query<{ id: string; display_name: string }>(
      `SELECT DISTINCT u.id, u.display_name FROM users u
       WHERE u.email LIKE $1 AND (
         EXISTS (SELECT 1 FROM entries e JOIN tournaments t ON t.id = e.tournament_id
                 WHERE e.user_id = u.id AND e.status IN ('RESERVED', 'CONFIRMED') AND t.status IN ('OPEN', 'FULL', 'STARTING', 'RUNNING'))
         OR EXISTS (SELECT 1 FROM games g WHERE g.status IN ('scheduled', 'active') AND (g.white_id = u.id OR g.black_id = u.id)))`,
      [`%@${BOT_EMAIL_DOMAIN}`],
    );
    for (const b of r.rows) {
      try {
        await this.attach(b.id, b.display_name);
      } catch (e) {
        this.logger.warn('Demo bot yeniden bağlanamadı', { bot: b.display_name, error: e });
      }
    }
    if (r.rows.length) this.logger.info('Demo botları yeniden bağlandı', { count: r.rows.length });
  }

  stop(): void {
    for (const b of this.bots.values()) b.close();
    this.bots.clear();
  }

  async assertExists(tournamentId: string): Promise<void> {
    const r = await this.pool.query('SELECT 1 FROM tournaments WHERE id = $1', [tournamentId]);
    if (!r.rowCount) throw notFound('TOURNAMENT_NOT_FOUND', 'Turnuva bulunamadı');
  }
}
