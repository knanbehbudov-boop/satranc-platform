/**
 * M3 Oyun sunucusu: sunucu otoriter. Hamle, saat, kopma ve sonuç kararları
 * yalnızca burada verilir; istemci yalnız istek gönderir ve gösterir.
 *
 * Faz 0 kararı (K18): tek düğüm. Canlı oyun durumu bellekte, her hamle aynı anda
 * PostgreSQL'e yazılır. Sunucu yeniden başlarsa oyunlar hamlelerden yeniden kurulur
 * ve kesinti süresi saatten düşülmez (doküman 3.6 "sistem kaynaklı kesinti").
 * Çok düğüme geçişte oda kiralama (lease) + Redis eklenir.
 */
import {
  ChessError,
  ChessGame,
  CASUAL_RULES,
  parseTimeControl,
  rulesFor,
  toPgn,
  type Color,
  type EndReason,
  type GameStatus,
} from '@satranc/chess-core';
import type { Config } from '../../config.ts';
import type { Pool, Queryable } from '../../infra/db/pg.ts';
import { AppError, forbidden, notFound } from '../../infra/errors.ts';
import { publish } from '../../infra/events/outbox.ts';
import type { Logger } from '../../infra/log.ts';
import type { AuthUser } from '../../infra/http/router.ts';
import type { WsHub, WsMessage } from '../../infra/ws/hub.ts';
import type { WsConnection } from '../../infra/ws/server.ts';
import { GameClock } from './clock.ts';
import { botLevel } from '../bot/levels.ts';

export interface CreateGameParams {
  kind: 'casual' | 'bot' | 'tournament';
  whiteId: string | null;
  blackId: string | null;
  botLevel?: string | null;
  botColor?: Color | null;
  timeControl: string;
  whiteMs?: number;
  blackMs?: number;
  incrementMs?: number;
  armageddon?: boolean;
  rated?: boolean;
  paid?: boolean;
  matchId?: string | null;
  gameNo?: number | null;
  startAt?: Date;
  initialFen?: string;
}

export interface GameSummary {
  id: string;
  matchId: string;
  gameNo: number;
  status: string;
  result: string | null;
  reason: string | null;
  whiteId: string | null;
  blackId: string | null;
  startAt: Date;
  armageddon: boolean;
}

interface GameRow {
  id: string;
  kind: 'casual' | 'bot' | 'tournament';
  match_id: string | null;
  game_no: number | null;
  white_id: string | null;
  black_id: string | null;
  bot_level: string | null;
  bot_color: Color | null;
  time_control: string;
  white_initial_ms: number;
  black_initial_ms: number;
  increment_ms: number;
  armageddon: boolean;
  rated: boolean;
  paid: boolean;
  initial_fen: string;
  status: 'scheduled' | 'active' | 'finished' | 'aborted';
  start_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
  white_ms: number;
  black_ms: number;
  result: string | null;
  end_reason: string | null;
  winner_color: Color | null;
  pgn: string | null;
}

interface Seat {
  userId: string | null;
  bot: string | null;
  name: string;
}

class Room {
  readonly row: GameRow;
  readonly chess: ChessGame;
  readonly clock: GameClock;
  readonly seats: Record<Color, Seat>;
  readonly presence: Record<Color, Set<string>> = { w: new Set(), b: new Set() };
  readonly lag: Record<Color, number> = { w: 0, b: 0 };
  flagTimer: NodeJS.Timeout | null = null;
  firstMoveTimer: NodeJS.Timeout | null = null;
  readonly reconnectTimers: Record<Color, NodeJS.Timeout | null> = { w: null, b: null };
  queue: Promise<unknown> = Promise.resolve();
  ended = false;
  lastMoveAt = 0;

  constructor(row: GameRow, chess: ChessGame, clock: GameClock, seats: Record<Color, Seat>) {
    this.row = row;
    this.chess = chess;
    this.clock = clock;
    this.seats = seats;
  }

  colorOf(userId: string | undefined): Color | null {
    if (!userId) return null;
    if (this.seats.w.userId === userId) return 'w';
    if (this.seats.b.userId === userId) return 'b';
    return null;
  }

  /** Oda işlemleri sırayla çalışır; aynı anda iki hamle işlenmez. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => undefined);
    return p;
  }
}

export interface BotDriver {
  /** Sıra bota geçtiğinde çağrılır; bot hamlesini GameService.botMove ile yapar. */
  onBotTurn(gameId: string, fen: string, level: string, clock: { myMs: number; incrementMs: number }): void;
}

export class GameService {
  private readonly rooms = new Map<string, Room>();
  private readonly pool: Pool;
  private readonly cfg: Config;
  private readonly logger: Logger;
  private readonly hub: WsHub;
  private readonly profiles: (ids: string[]) => Promise<Map<string, { displayName: string }>>;
  private scheduler: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private bot: BotDriver | null = null;
  private now: () => number = Date.now;

  constructor(deps: {
    pool: Pool;
    cfg: Config;
    logger: Logger;
    hub: WsHub;
    profiles: (ids: string[]) => Promise<Map<string, { displayName: string }>>;
  }) {
    this.pool = deps.pool;
    this.cfg = deps.cfg;
    this.logger = deps.logger;
    this.hub = deps.hub;
    this.profiles = deps.profiles;
    this.registerWs();
  }

  setBotDriver(bot: BotDriver): void {
    this.bot = bot;
  }

  get liveCount(): number {
    return this.rooms.size;
  }

  // ---- oluşturma ve başlatma ---------------------------------------------

  async createGame(q: Queryable, p: CreateGameParams): Promise<string> {
    const tc = parseTimeControl(p.timeControl);
    const whiteMs = p.whiteMs ?? tc.initialMs;
    const blackMs = p.blackMs ?? tc.initialMs;
    const r = await q.query<{ id: string }>(
      `INSERT INTO games (kind, match_id, game_no, white_id, black_id, bot_level, bot_color, time_control,
                          white_initial_ms, black_initial_ms, increment_ms, armageddon, rated, paid, initial_fen,
                          start_at, white_ms, black_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$9,$10) RETURNING id`,
      [
        p.kind, p.matchId ?? null, p.gameNo ?? null, p.whiteId, p.blackId, p.botLevel ?? null, p.botColor ?? null,
        tc.code, whiteMs, blackMs, p.incrementMs ?? tc.incrementMs, p.armageddon ?? false, p.rated ?? true,
        p.paid ?? false, p.initialFen ?? new ChessGame().fen(), p.startAt ?? new Date(),
      ],
    );
    return (r.rows[0] as { id: string }).id;
  }

  async start(): Promise<void> {
    await this.recover();
    this.scheduler = setInterval(() => void this.activateDue().catch((e) => this.logger.error('Zamanlayıcı hatası', { error: e })), 200);
    this.scheduler.unref();
    // İkinci güvenlik: zamanlayıcı kaçırırsa süresi biten oyunları yakala (doküman 8.5 watchdog).
    this.watchdog = setInterval(() => this.sweepFlags(), 1000);
    this.watchdog.unref();
  }

  stop(): void {
    if (this.scheduler) clearInterval(this.scheduler);
    if (this.watchdog) clearInterval(this.watchdog);
    for (const room of this.rooms.values()) this.clearTimers(room);
    this.rooms.clear();
  }

  /** Testler ve yönetim: zamanı gelmiş oyunları hemen başlat. */
  async activateDue(): Promise<string[]> {
    const r = await this.pool.query<GameRow>(
      `UPDATE games SET status = 'active', started_at = now()
       WHERE id IN (SELECT id FROM games WHERE status = 'scheduled' AND start_at <= now()
                    ORDER BY start_at LIMIT 50 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
    );
    for (const row of r.rows) {
      const room = await this.loadRoom(row, []);
      this.rooms.set(row.id, room);
      room.clock.start('w', this.now());
      this.armTimers(room);
      const msg = { type: 'game.started', gameId: row.id, kind: row.kind, matchId: row.match_id };
      for (const c of ['w', 'b'] as const) if (room.seats[c].userId) this.hub.sendToUser(room.seats[c].userId as string, msg);
      this.hub.publish(`game:${row.id}`, this.stateMessage(room));
      this.maybeBotTurn(room);
    }
    return r.rows.map((x) => x.id);
  }

  private async recover(): Promise<void> {
    const r = await this.pool.query<GameRow>(`SELECT * FROM games WHERE status = 'active'`);
    for (const row of r.rows) {
      const moves = await this.pool.query<{ uci: string }>('SELECT uci FROM moves WHERE game_id = $1 ORDER BY ply', [row.id]);
      try {
        const room = await this.loadRoom(row, moves.rows.map((m) => m.uci));
        this.rooms.set(row.id, room);
        if (room.chess.status().over) {
          // Son hamle yazıldı ama sonuç yazılamadan kapanmış: şimdi tamamla.
          await this.finish(room, room.chess.status());
          continue;
        }
        // Kesinti süresi düşülmez: saat kaldığı yerden yeniden başlar.
        room.clock.start(room.chess.turn, this.now());
        this.armTimers(room);
        this.maybeBotTurn(room);
      } catch (e) {
        this.logger.error('Oyun kurtarılamadı', { gameId: row.id, error: e });
      }
    }
    if (r.rows.length) this.logger.info('Devam eden oyunlar kurtarıldı', { count: r.rows.length });
  }

  private async loadRoom(row: GameRow, moves: string[]): Promise<Room> {
    const rules = row.paid ? rulesFor({ paid: true, timeControl: parseTimeControl(row.time_control) }) : CASUAL_RULES;
    const chess = new ChessGame({ fen: row.initial_fen, rules });
    for (const uci of moves) chess.move(uci);
    const clock = new GameClock({ whiteMs: row.white_ms, blackMs: row.black_ms, incrementMs: row.increment_ms });
    const ids = [row.white_id, row.black_id].filter((x): x is string => !!x);
    const prof = await this.profiles(ids);
    const seat = (id: string | null, color: Color): Seat =>
      id ? { userId: id, bot: null, name: prof.get(id)?.displayName ?? '?' } : { userId: null, bot: row.bot_level, name: `Bot · ${botLevel(row.bot_level ?? '')?.name ?? row.bot_level}` };
    return new Room(row, chess, clock, { w: seat(row.white_id, 'w'), b: seat(row.black_id, 'b') });
  }

  // ---- zamanlayıcılar ----------------------------------------------------

  private clearTimers(room: Room): void {
    if (room.flagTimer) clearTimeout(room.flagTimer);
    if (room.firstMoveTimer) clearTimeout(room.firstMoveTimer);
    for (const c of ['w', 'b'] as const) {
      const t = room.reconnectTimers[c];
      if (t) clearTimeout(t);
      room.reconnectTimers[c] = null;
    }
    room.flagTimer = null;
    room.firstMoveTimer = null;
  }

  private armTimers(room: Room): void {
    if (room.flagTimer) clearTimeout(room.flagTimer);
    const running = room.clock.running;
    if (!running || room.ended) return;
    const deadline = room.clock.flagDeadline(room.lag[running], this.cfg.lagCompensationCapMs);
    if (deadline !== null) {
      room.flagTimer = setTimeout(() => void this.checkFlag(room), Math.max(0, deadline - this.now()) + 5);
    }
    // İlk hamle süresi (doküman 3.6): beyaz başlangıçtan, siyah beyazın ilk hamlesinden itibaren.
    const ply = room.chess.plyCount();
    if (room.firstMoveTimer) clearTimeout(room.firstMoveTimer);
    room.firstMoveTimer = null;
    if (ply < 2 && room.seats[running].userId) {
      room.firstMoveTimer = setTimeout(() => {
        void room.run(async () => {
          if (room.ended || room.chess.plyCount() !== ply) return;
          await this.finishBy(room, running === 'w' ? 'b' : 'w', 'forfeit');
        });
      }, this.cfg.firstMoveTimeoutMs);
    }
  }

  private async checkFlag(room: Room): Promise<void> {
    await room.run(async () => {
      if (room.ended) return;
      const color = room.clock.running;
      if (!color) return;
      const now = this.now();
      const grace = Math.min(room.lag[color], this.cfg.lagCompensationCapMs);
      if (room.clock.remaining(color, now) + grace <= 0) {
        await this.finish(room, room.chess.flag(color));
      } else {
        this.armTimers(room);
      }
    });
  }

  private sweepFlags(): void {
    const now = this.now();
    for (const room of this.rooms.values()) {
      const c = room.clock.running;
      if (!room.ended && c && room.clock.remaining(c, now) + Math.min(room.lag[c], this.cfg.lagCompensationCapMs) <= 0) {
        void this.checkFlag(room);
      }
    }
  }

  // ---- hamle ve eylemler -------------------------------------------------

  private room(gameId: unknown): Room {
    const room = typeof gameId === 'string' ? this.rooms.get(gameId) : undefined;
    if (!room) throw new AppError(404, 'GAME_NOT_LIVE', 'Oyun canlı değil');
    return room;
  }

  async playerMove(user: AuthUser, gameId: string, uci: string, seq: number, conn: WsConnection | null): Promise<void> {
    const room = this.room(gameId);
    await room.run(async () => {
      const color = room.colorOf(user.id);
      if (!color) throw forbidden('NOT_A_PLAYER', 'Bu oyunda oyuncu değilsiniz');
      if (conn?.rttMs !== null && conn?.rttMs !== undefined) room.lag[color] = conn.rttMs / 2;
      await this.applyMove(room, color, uci, seq);
    });
  }

  async botMove(gameId: string, uci: string, seq: number): Promise<void> {
    const room = this.rooms.get(gameId);
    if (!room) return;
    await room.run(async () => {
      const color = room.chess.turn;
      if (!room.seats[color].bot || room.ended) return;
      await this.applyMove(room, color, uci, seq);
    });
  }

  private async applyMove(room: Room, color: Color, uci: string, seq: number): Promise<void> {
    if (room.ended) throw new ChessError('GAME_OVER', 'Oyun bitti');
    // seq: yapılacak hamlenin yarım hamle numarası. Yinelenen ya da eski mesaj, sıra
    // kontrolünden önce reddedilir ki istemci tahtayı yenilemesi gerektiğini anlasın.
    if (seq !== room.chess.plyCount() + 1) {
      throw new AppError(409, 'STALE_MOVE', 'Hamle sırası eşleşmiyor; tahta yenilendi', { expectedSeq: room.chess.plyCount() + 1 });
    }
    if (room.chess.turn !== color) throw new AppError(409, 'NOT_YOUR_TURN', 'Sıra sizde değil');
    const legal = room.chess.moves().find((m) => m.uci === uci);
    if (!legal) throw new ChessError('ILLEGAL_MOVE', `Yasal olmayan hamle: ${uci}`, { move: uci });

    const now = this.now();
    const timing = room.clock.timeMove(color, now, room.lag[color], this.cfg.lagCompensationCapMs);
    if (!timing.ok) {
      await this.finish(room, room.chess.flag(color));
      throw new AppError(409, 'FLAGGED', 'Süreniz doldu');
    }
    const ply = room.chess.plyCount() + 1;
    const whiteMs = color === 'w' ? timing.clockMs : Math.round(room.clock.remaining('w', now));
    const blackMs = color === 'b' ? timing.clockMs : Math.round(room.clock.remaining('b', now));
    // Önce kalıcı kayıt, sonra bellek ve yayın: kayıt başarısızsa hamle hiç olmamış sayılır.
    await this.pool.tx(async (tx) => {
      await tx.query(
        'INSERT INTO moves (game_id, ply, uci, san, think_ms, clock_ms, lag_comp_ms) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [room.row.id, ply, uci, legal.san, timing.thinkMs, timing.clockMs, timing.lagCompMs],
      );
      await tx.query('UPDATE games SET white_ms = $2, black_ms = $3 WHERE id = $1', [room.row.id, whiteMs, blackMs]);
    });
    room.chess.move(uci);
    room.clock.commit(color, timing, now);
    room.lastMoveAt = now;

    this.hub.publish(`game:${room.row.id}`, {
      type: 'game.move',
      gameId: room.row.id,
      uci,
      san: legal.san,
      ply,
      fen: room.chess.fen(),
      clock: { ...room.clock.snapshot(now), serverTime: now },
      drawOfferBy: room.chess.drawOfferedBy(),
    });

    const st = room.chess.status();
    if (st.over) {
      await this.finish(room, st);
      return;
    }
    this.armTimers(room);
    this.maybeBotTurn(room);
  }

  private maybeBotTurn(room: Room): void {
    const turn = room.chess.turn;
    const seat = room.seats[turn];
    if (!this.bot || room.ended || !seat.bot) return;
    this.bot.onBotTurn(room.row.id, room.chess.fen(), seat.bot, {
      myMs: Math.round(room.clock.remaining(turn, this.now())),
      incrementMs: room.row.increment_ms,
    });
  }

  async resign(user: AuthUser, gameId: string): Promise<void> {
    const room = this.room(gameId);
    await room.run(async () => {
      const color = room.colorOf(user.id);
      if (!color) throw forbidden('NOT_A_PLAYER', 'Bu oyunda oyuncu değilsiniz');
      if (room.ended) throw new ChessError('GAME_OVER', 'Oyun bitti');
      await this.finish(room, room.chess.resign(color));
    });
  }

  async drawAction(user: AuthUser, gameId: string, action: 'offer' | 'accept' | 'decline'): Promise<void> {
    const room = this.room(gameId);
    await room.run(async () => {
      const color = room.colorOf(user.id);
      if (!color) throw forbidden('NOT_A_PLAYER', 'Bu oyunda oyuncu değilsiniz');
      if (room.ended) throw new ChessError('GAME_OVER', 'Oyun bitti');
      if (action === 'offer') room.chess.offerDraw(color);
      else if (action === 'accept') room.chess.acceptDraw(color);
      else room.chess.declineDraw(color);
      const st = room.chess.status();
      if (st.over) {
        await this.finish(room, st);
        return;
      }
      this.hub.publish(`game:${room.row.id}`, { type: 'game.draw', gameId: room.row.id, action, by: color, drawOfferBy: room.chess.drawOfferedBy() });
    });
  }

  /** Sistem kararıyla bitirme (gelmeme, terk, hakem). Kazanan null ise beraberlik. */
  private async finishBy(room: Room, winner: Color | null, reason: Extract<EndReason, 'abandon' | 'forfeit' | 'adjudication'>): Promise<void> {
    if (room.ended) return;
    await this.finish(room, room.chess.terminate(winner, reason));
  }

  private async finish(room: Room, st: GameStatus): Promise<void> {
    if (room.ended) return;
    room.ended = true;
    const now = this.now();
    room.clock.stop(now);
    this.clearTimers(room);
    const row = room.row;
    const pgn = toPgn(room.chess, {
      Event: row.kind === 'tournament' ? 'Turnuva' : row.kind === 'bot' ? 'Bot oyunu' : 'Serbest oyun',
      Site: 'Satranç Turnuva Platformu',
      Date: new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
      White: room.seats.w.name,
      Black: room.seats.b.name,
      TimeControl: row.time_control,
      ...(row.armageddon ? { Variant: 'Armageddon' } : {}),
    });
    const snap = room.clock.snapshot(now);
    await this.pool.tx(async (tx) => {
      const upd = await tx.query(
        `UPDATE games SET status = 'finished', ended_at = now(), result = $2, end_reason = $3, winner_color = $4,
                          pgn = $5, white_ms = $6, black_ms = $7
         WHERE id = $1 AND status = 'active'`,
        [row.id, st.result, st.reason, st.winner ?? null, pgn, snap.whiteMs, snap.blackMs],
      );
      if (!upd.rowCount) return; // başka bir yol zaten bitirdi
      await publish(tx, 'game.ended', {
        gameId: row.id,
        kind: row.kind,
        matchId: row.match_id,
        gameNo: row.game_no,
        result: st.result,
        reason: st.reason ?? null,
        winnerColor: st.winner ?? null,
        whiteId: row.white_id,
        blackId: row.black_id,
        botLevel: row.bot_level,
        botColor: row.bot_color,
        timeControl: row.time_control,
        armageddon: row.armageddon,
        rated: row.rated,
        plies: room.chess.plyCount(),
      });
    });
    this.hub.publish(`game:${row.id}`, {
      type: 'game.end',
      gameId: row.id,
      result: st.result,
      reason: st.reason,
      winner: st.winner ?? null,
      clock: { ...snap, serverTime: now },
      pgn,
    });
    // Oda bir süre bellekte kalır (geç gelen mesajlara anlamlı hata için), sonra silinir.
    setTimeout(() => this.rooms.delete(row.id), 30_000).unref();
  }

  // ---- bağlantı ve durum -------------------------------------------------

  private stateMessage(room: Room): Record<string, unknown> {
    const now = this.now();
    const st = room.chess.status();
    const rules = room.chess.ruleSet;
    return {
      type: 'game.state',
      gameId: room.row.id,
      kind: room.row.kind,
      matchId: room.row.match_id,
      gameNo: room.row.game_no,
      armageddon: room.row.armageddon,
      tiebreak: room.row.kind === 'tournament' && Number(room.row.game_no) > 1,
      timeControl: room.row.time_control,
      initialFen: room.chess.initialFen(),
      fen: room.chess.fen(),
      moves: room.chess.history().map((h) => ({ uci: h.move.uci, san: h.move.san })),
      ply: room.chess.plyCount(),
      turn: room.chess.turn,
      status: room.ended ? 'finished' : 'active',
      result: st.result,
      reason: st.reason ?? null,
      winner: st.winner ?? null,
      drawOfferBy: room.chess.drawOfferedBy(),
      clock: { ...room.clock.snapshot(now), serverTime: now },
      players: {
        w: { id: room.seats.w.userId, name: room.seats.w.name, bot: room.seats.w.bot },
        b: { id: room.seats.b.userId, name: room.seats.b.name, bot: room.seats.b.bot },
      },
      rules: { drawOfferMinFullMoves: rules.drawOfferMinFullMoves, premoveAllowed: rules.premoveAllowed },
    };
  }

  /** REST ve kapanmış oyunlar için durum (canlı değilse veritabanından). */
  async state(gameId: string): Promise<Record<string, unknown>> {
    const live = this.rooms.get(gameId);
    if (live) return this.stateMessage(live);
    const r = await this.pool.query<GameRow>('SELECT * FROM games WHERE id = $1', [gameId]);
    const row = r.rows[0];
    if (!row) throw notFound('GAME_NOT_FOUND', 'Oyun bulunamadı');
    const moves = await this.pool.query<{ uci: string }>('SELECT uci FROM moves WHERE game_id = $1 ORDER BY ply', [gameId]);
    const room = await this.loadRoom(row, row.status === 'scheduled' ? [] : moves.rows.map((m) => m.uci));
    const msg = this.stateMessage(room);
    return {
      ...msg,
      status: row.status,
      result: row.result ?? '*',
      reason: row.end_reason,
      winner: row.winner_color,
      startAt: row.start_at,
      pgn: row.pgn,
      clock: { whiteMs: row.white_ms, blackMs: row.black_ms, running: null, incrementMs: row.increment_ms, serverTime: this.now() },
    };
  }

  private registerWs(): void {
    const hub = this.hub;
    hub.on('game.join', async (conn, msg, user) => {
      const gameId = String(msg.gameId ?? '');
      const room = this.rooms.get(gameId);
      if (!room) {
        // Bitmiş ya da henüz başlamamış oyun: son durumu gönder.
        conn.send(await this.state(gameId));
        hub.subscribe(conn, `game:${gameId}`);
        return undefined;
      }
      const color = room.colorOf(user?.id);
      if (room.row.paid && !color) throw forbidden('SPECTATE_DELAYED', 'Ücretli oyunlar yalnız bittikten sonra izlenebilir');
      hub.subscribe(conn, `game:${gameId}`);
      if (color) {
        room.presence[color].add(conn.id);
        conn.data[`game:${gameId}`] = color;
        const t = room.reconnectTimers[color];
        if (t) {
          clearTimeout(t);
          room.reconnectTimers[color] = null;
          hub.publish(`game:${gameId}`, { type: 'game.presence', gameId, color, online: true });
        }
      }
      conn.send(this.stateMessage(room));
      return undefined;
    });
    hub.on('game.leave', (conn, msg) => {
      hub.unsubscribe(conn, `game:${String(msg.gameId)}`);
      this.onConnGone(conn, String(msg.gameId));
      return undefined;
    });
    hub.on('game.move', async (conn, msg: WsMessage, user) => {
      if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Giriş gerekli');
      if (typeof msg.uci !== 'string' || typeof msg.seq !== 'number') throw new AppError(400, 'VALIDATION', 'uci ve seq gerekli');
      await this.playerMove(user, String(msg.gameId), msg.uci, msg.seq, conn);
      return undefined;
    });
    hub.on('game.resign', async (_c, msg, user) => {
      if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Giriş gerekli');
      await this.resign(user, String(msg.gameId));
      return undefined;
    });
    for (const [type, action] of [['game.drawOffer', 'offer'], ['game.drawAccept', 'accept'], ['game.drawDecline', 'decline']] as const) {
      hub.on(type, async (_c, msg, user) => {
        if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Giriş gerekli');
        await this.drawAction(user, String(msg.gameId), action);
        return undefined;
      });
    }
    hub.onDisconnect((conn) => {
      for (const key of Object.keys(conn.data)) if (key.startsWith('game:')) this.onConnGone(conn, key.slice(5));
    });
  }

  /** Oyuncunun o oyuna bağlı son bağlantısı da gittiyse yeniden bağlanma süresi başlar. */
  private onConnGone(conn: WsConnection, gameId: string): void {
    const room = this.rooms.get(gameId);
    const color = conn.data[`game:${gameId}`] as Color | undefined;
    delete conn.data[`game:${gameId}`];
    if (!room || !color || room.ended) return;
    room.presence[color].delete(conn.id);
    if (room.presence[color].size || room.reconnectTimers[color]) return;
    this.hub.publish(`game:${gameId}`, { type: 'game.presence', gameId, color, online: false, graceMs: this.cfg.reconnectTimeoutMs });
    room.reconnectTimers[color] = setTimeout(() => {
      room.reconnectTimers[color] = null;
      void room.run(async () => {
        if (room.ended || room.presence[color].size) return;
        await this.finishBy(room, color === 'w' ? 'b' : 'w', 'abandon');
      });
    }, this.cfg.reconnectTimeoutMs);
  }

  /** Turnuva modülü için maç oyunlarının özeti (turnuva oyun tablosuna doğrudan dokunmaz). */
  async summariesForMatches(q: Queryable, matchIds: string[]): Promise<GameSummary[]> {
    if (!matchIds.length) return [];
    const r = await q.query<{
      id: string; match_id: string; game_no: number; status: string; result: string | null; end_reason: string | null;
      white_id: string | null; black_id: string | null; start_at: Date; armageddon: boolean;
    }>(
      `SELECT id, match_id, game_no, status, result, end_reason, white_id, black_id, start_at, armageddon
       FROM games WHERE match_id = ANY($1) ORDER BY game_no`,
      [matchIds],
    );
    return r.rows.map((g) => ({
      id: g.id, matchId: g.match_id, gameNo: g.game_no, status: g.status, result: g.result, reason: g.end_reason,
      whiteId: g.white_id, blackId: g.black_id, startAt: g.start_at, armageddon: g.armageddon,
    }));
  }

  /** Kullanıcının oynadığı canlı oyunlar (lobide "oyununa dön" için). */
  /** Canlı oyunda kullanıcının koltuğu (odak telemetrisi için): renk, sıra kimde, kaçıncı yarım hamle. */
  liveSeat(gameId: string, userId: string): { color: 'w' | 'b'; myTurn: boolean; ply: number; paid: boolean } | null {
    const r = this.rooms.get(gameId);
    if (!r || r.ended) return null;
    const color = r.colorOf(userId);
    if (!color) return null;
    return { color, myTurn: r.chess.turn === color, ply: r.chess.plyCount(), paid: r.row.paid };
  }

  liveGamesOf(userId: string): string[] {
    const out: string[] = [];
    for (const r of this.rooms.values()) if (!r.ended && r.colorOf(userId)) out.push(r.row.id);
    return out;
  }
}
