/**
 * M4a Bot rakip: ücretsiz antrenman ve rating kalibrasyonu (doküman 12.2).
 * Ücretli turnuvalarda bot yoktur; analiz tahtası turnuva süresince kapalıdır.
 *
 * Motor: STOCKFISH_PATH verilmişse Stockfish, yoksa yerleşik motor (ayrı süreç,
 * aynı UCI sürücüsü). Motor hata verirse oyun kilitlenmez: rastgele yasal hamle oynanır.
 */
import { randomInt } from 'node:crypto';
import { join } from 'node:path';
import { ChessGame, type Color } from '@satranc/chess-core';
import type { Config } from '../../config.ts';
import type { Pool } from '../../infra/db/pg.ts';
import { AppError, badRequest, conflict } from '../../infra/errors.ts';
import type { Logger } from '../../infra/log.ts';
import type { BotDriver, GameService } from '../game/service.ts';
import { BOT_LEVELS, botLevel } from './levels.ts';
import { EnginePool, type EngineCommand } from './uci.ts';

const BUILTIN = join(import.meta.dirname, 'builtin-engine.ts');

export class BotService implements BotDriver {
  private readonly engines: EnginePool;
  private readonly usingStockfish: boolean;
  private readonly games: GameService;
  private readonly pool: Pool;
  private readonly logger: Logger;
  /** Testlerde düşünme gecikmesini kapatmak için. */
  humanDelay = true;
  private readonly pending = new Set<NodeJS.Timeout>();

  constructor(deps: { cfg: Config; games: GameService; pool: Pool; logger: Logger }) {
    this.games = deps.games;
    this.pool = deps.pool;
    this.logger = deps.logger;
    this.usingStockfish = !!deps.cfg.stockfishPath;
    const cmd: EngineCommand = deps.cfg.stockfishPath
      ? { command: deps.cfg.stockfishPath, args: [] }
      : { command: process.execPath, args: ['--disable-warning=ExperimentalWarning', BUILTIN] };
    this.engines = new EnginePool(cmd, 2);
    if (!this.usingStockfish) this.logger.warn('Stockfish yolu verilmedi; yerleşik motor kullanılıyor (STOCKFISH_PATH)');
  }

  get engineKind(): 'stockfish' | 'builtin' {
    return this.usingStockfish ? 'stockfish' : 'builtin';
  }

  levels() {
    return BOT_LEVELS.map((l) => ({ id: l.id, name: l.name, elo: l.elo }));
  }

  async createGame(userId: string, input: { level: string; color: 'white' | 'black' | 'random'; timeControl: string }): Promise<{ gameId: string; color: Color }> {
    const level = botLevel(input.level);
    if (!level) throw badRequest('UNKNOWN_BOT_LEVEL', 'Bilinmeyen bot seviyesi');
    if (this.games.liveGamesOf(userId).length) throw conflict('ALREADY_PLAYING', 'Devam eden bir oyununuz var');
    const humanColor: Color = input.color === 'white' ? 'w' : input.color === 'black' ? 'b' : randomInt(2) === 0 ? 'w' : 'b';
    const gameId = await this.games.createGame(this.pool, {
      kind: 'bot',
      whiteId: humanColor === 'w' ? userId : null,
      blackId: humanColor === 'b' ? userId : null,
      botLevel: level.id,
      botColor: humanColor === 'w' ? 'b' : 'w',
      timeControl: input.timeControl,
      rated: true,
    });
    await this.games.activateDue();
    return { gameId, color: humanColor };
  }

  onBotTurn(gameId: string, fen: string, levelId: string, clock: { myMs: number; incrementMs: number }): void {
    const level = botLevel(levelId);
    if (!level) return;
    // İnsan benzeri gecikme: süre azsa kısalır (doküman 12.2).
    const [lo, hi] = level.thinkMs;
    const budget = Math.max(150, Math.min(hi, clock.myMs / 30 + clock.incrementMs * 0.5));
    const delay = this.humanDelay ? Math.min(budget, lo + randomInt(Math.max(1, hi - lo))) : 0;
    const t = setTimeout(() => {
      this.pending.delete(t);
      void this.play(gameId, fen, level.id, Math.max(100, Math.min(budget, 3_000)));
    }, delay);
    this.pending.add(t);
  }

  private async play(gameId: string, fen: string, levelId: string, movetimeMs: number): Promise<void> {
    const level = botLevel(levelId);
    if (!level) return;
    let uci: string | null = null;
    try {
      const engine = await this.engines.get();
      uci = this.usingStockfish
        ? await engine.bestMove(fen, { Threads: '1', Hash: '32', ...level.stockfish.options }, { movetimeMs: Math.min(movetimeMs, level.stockfish.movetimeMs) })
        : await engine.bestMove(fen, { BotDepth: String(level.builtin.depth), BotNoise: String(level.builtin.noiseCp) }, { depth: level.builtin.depth, movetimeMs });
    } catch (e) {
      this.logger.error('Motor hamle üretemedi; rastgele yasal hamle oynanıyor', { gameId, error: e });
    }
    const game = new ChessGame({ fen });
    const legal = game.moves();
    if (!legal.length) return;
    if (!uci || !legal.some((m) => m.uci === uci)) uci = (legal[randomInt(legal.length)] as { uci: string }).uci;
    // seq, oyun sunucusundaki gerçek yarım hamle sayısından gelir.
    const state = await this.games.state(gameId).catch(() => null);
    if (!state || state.status !== 'active' || state.fen !== fen) return; // pozisyon değişmiş ya da oyun bitmiş
    try {
      await this.games.botMove(gameId, uci, (state.ply as number) + 1);
    } catch (e) {
      if (!(e instanceof AppError)) this.logger.error('Bot hamlesi uygulanamadı', { gameId, error: e });
    }
  }

  stop(): void {
    for (const t of this.pending) clearTimeout(t);
    this.pending.clear();
    this.engines.close();
  }
}
