/**
 * Senaryolu oyuncu: gerçek bir istemci gibi WebSocket'ten bildirimleri alır,
 * maç oyununa katılır ve verilen stratejiye göre oynar. Turnuva ve simülasyon
 * testlerinde kullanılır.
 */
import { ChessGame } from '@satranc/chess-core';
import { newPlayer, WsClient, type Client } from './helpers.ts';

export type Intent = 'win' | 'lose' | 'draw' | 'idle';

export interface GameInfo {
  gameId: string;
  gameNo: number;
  armageddon: boolean;
  myColor: 'w' | 'b';
  opponentId: string;
}

export class ScriptedPlayer {
  readonly id: string;
  readonly name: string;
  readonly client: Client;
  readonly base: string;
  ws!: WsClient;
  /** Oyunda ne yapacağına karar verir. */
  strategy: (g: GameInfo) => Intent = () => 'win';
  readonly games = new Map<string, GameInfo>();
  readonly finished: { gameId: string; result: string; reason: string }[] = [];
  readyChecks = 0;
  autoReady = true;
  private busy = new Set<string>();

  private constructor(p: { id: string; name: string; client: Client }, base: string) {
    this.id = p.id;
    this.name = p.name;
    this.client = p.client;
    this.base = base;
  }

  static async create(base: string, strategy?: (g: GameInfo) => Intent): Promise<ScriptedPlayer> {
    const p = await newPlayer(base);
    const sp = new ScriptedPlayer(p, base);
    if (strategy) sp.strategy = strategy;
    await sp.connect();
    return sp;
  }

  async connect(): Promise<void> {
    this.ws = await WsClient.open(this.base, this.client.token);
    this.ws.ws.addEventListener('message', (ev) => void this.onMessage(JSON.parse(String(ev.data))));
    // Yeniden bağlanınca devam eden oyunlara dön.
    for (const g of this.games.values()) this.ws.send({ type: 'game.join', gameId: g.gameId });
    const live = await this.client.get('/v1/me/live-games');
    for (const id of live.body?.games ?? []) this.ws.send({ type: 'game.join', gameId: id });
  }

  private async onMessage(m: any): Promise<void> {
    if (m.type === 'tournament.readyCheck') {
      this.readyChecks++;
      if (this.autoReady) this.ws.send({ type: 'tournament.ready', tournamentId: m.tournamentId });
    } else if (m.type === 'game.started') {
      this.ws.send({ type: 'game.join', gameId: m.gameId });
    } else if (m.type === 'game.state' && m.status === 'active') {
      const myColor = m.players.w.id === this.id ? 'w' : m.players.b.id === this.id ? 'b' : null;
      if (!myColor) return;
      const opp = myColor === 'w' ? m.players.b.id : m.players.w.id;
      this.games.set(m.gameId, { gameId: m.gameId, gameNo: m.gameNo ?? 1, armageddon: m.armageddon, myColor, opponentId: opp });
      await this.act(m.gameId, m.fen, m.ply, m.drawOfferBy);
    } else if (m.type === 'game.move') {
      if (this.games.has(m.gameId)) await this.act(m.gameId, m.fen, m.ply, m.drawOfferBy);
    } else if (m.type === 'game.draw') {
      const g = this.games.get(m.gameId);
      if (g && m.action === 'offer' && m.by !== g.myColor && this.strategy(g) === 'draw') {
        this.ws.send({ type: 'game.drawAccept', gameId: m.gameId });
      }
    } else if (m.type === 'game.end') {
      if (this.games.has(m.gameId)) this.finished.push({ gameId: m.gameId, result: m.result, reason: m.reason });
      this.games.delete(m.gameId);
    }
  }

  private async act(gameId: string, fen: string, ply: number, drawOfferBy: string | null): Promise<void> {
    const g = this.games.get(gameId);
    if (!g) return;
    const chess = new ChessGame({ fen });
    if (chess.turn !== g.myColor) return;
    const intent = this.strategy(g);
    if (intent === 'idle') return;
    const key = `${gameId}:${ply}`;
    if (this.busy.has(key)) return;
    this.busy.add(key);
    // Kaybedecek taraf en az bir hamle yapar ki oyun 2 yarım hamleyi geçsin (K20: rating'e işlensin).
    if (intent === 'lose' && ply >= 2) {
      this.ws.send({ type: 'game.resign', gameId });
      return;
    }
    if (intent === 'draw') {
      if (drawOfferBy && drawOfferBy !== g.myColor) this.ws.send({ type: 'game.drawAccept', gameId });
      else this.ws.send({ type: 'game.drawOffer', gameId });
    }
    // Kazanmaya oynayan (ya da teklifini yapıp bekleyen) taraf güvenli bir hamle yapar.
    const moves = chess.moves();
    const safe = moves.find((mv) => !mv.captured && !mv.san.includes('#')) ?? moves[0];
    if (safe && intent !== 'draw') this.ws.send({ type: 'game.move', gameId, uci: safe.uci, seq: ply + 1 });
  }

  close(): void {
    this.ws.close();
  }
}
