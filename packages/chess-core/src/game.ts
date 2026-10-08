import { opposite, toIndex } from './board.ts';
import { ChessError } from './errors.ts';
import { parseFen, positionKey, START_FEN, toFen } from './fen.ts';
import { canCheckmate, isInsufficientMaterial } from './material.ts';
import { applyMove, inCheck, legalMoves } from './movegen.ts';
import { describe, resolveMove, type MoveObjectInput } from './notation.ts';
import { CASUAL_RULES, type RuleSet } from './rules.ts';
import type { Color, EndReason, GameResult, GameStatus, InternalMove, Move, Piece, Position, Square } from './types.ts';

export interface HistoryEntry {
  readonly move: Move;
  readonly fenBefore: string;
  readonly fenAfter: string;
}

export interface GameOptions {
  readonly fen?: string;
  readonly rules?: RuleSet;
}

const ONGOING: GameStatus = Object.freeze({ over: false, result: '*' as GameResult });

/**
 * Tek bir satranç oyununun kural motoru. Saat tutmaz (saat M3'te, sunucuda);
 * süre bitimini `flag()` ile dışarıdan alır. Tüm durum geçişleri burada
 * doğrulanır, böylece istemci ve sunucu aynı kararı verir.
 */
export class ChessGame {
  private pos: Position;
  private readonly startFen: string;
  private readonly rules: RuleSet;
  private readonly entries: HistoryEntry[] = [];
  private readonly repetitions = new Map<string, number>();
  private legalCache: InternalMove[] | null = null;
  private statusValue: GameStatus = ONGOING;
  private pendingDrawOfferBy: Color | null = null;

  constructor(opts: GameOptions = {}) {
    this.pos = parseFen(opts.fen ?? START_FEN);
    this.startFen = toFen(this.pos);
    this.rules = opts.rules ?? CASUAL_RULES;
    this.bumpRepetition();
    this.statusValue = this.evaluate();
  }

  // ---- okuma -------------------------------------------------------------

  get turn(): Color {
    return this.pos.turn;
  }

  get ruleSet(): RuleSet {
    return this.rules;
  }

  fen(): string {
    return toFen(this.pos);
  }

  initialFen(): string {
    return this.startFen;
  }

  position(): Position {
    return this.pos;
  }

  get(square: Square): Piece | null {
    return this.pos.board[toIndex(square)] ?? null;
  }

  isCheck(): boolean {
    return inCheck(this.pos);
  }

  status(): GameStatus {
    return this.statusValue;
  }

  history(): readonly HistoryEntry[] {
    return this.entries;
  }

  /** Oynanan yarım hamle sayısı (ply). */
  plyCount(): number {
    return this.entries.length;
  }

  drawOfferedBy(): Color | null {
    return this.pendingDrawOfferBy;
  }

  /** Yasal hamleler; `square` verilirse yalnız o kareden çıkanlar. */
  moves(square?: Square): Move[] {
    if (this.statusValue.over) return [];
    const legal = this.legal();
    const from = square === undefined ? undefined : toIndex(square);
    return legal.filter((m) => from === undefined || m.from === from).map((m) => describe(this.pos, m, legal));
  }

  // ---- hamle ve sonuç ----------------------------------------------------

  /** Hamle yapar. Girdi UCI, SAN ya da {from, to, promotion} olabilir. */
  move(input: string | MoveObjectInput): Move {
    this.assertOngoing();
    const legal = this.legal();
    const m = resolveMove(this.pos, input, legal);
    const described = describe(this.pos, m, legal);
    const fenBefore = this.fen();
    const mover = this.pos.turn;

    this.pos = applyMove(this.pos, m);
    this.legalCache = null;
    this.bumpRepetition();
    this.entries.push({ move: described, fenBefore, fenAfter: this.fen() });

    // Teklif, teklif edilen taraf hamle yapınca reddedilmiş sayılır.
    if (this.pendingDrawOfferBy && this.pendingDrawOfferBy !== mover) this.pendingDrawOfferBy = null;

    this.statusValue = this.evaluate();
    return described;
  }

  resign(color: Color): GameStatus {
    this.assertOngoing();
    return this.finish(opposite(color), 'resign');
  }

  /** Süre bitimi. Rakip mat edemiyorsa oyun berabere biter. */
  flag(color: Color): GameStatus {
    this.assertOngoing();
    const opponent = opposite(color);
    if (canCheckmate(this.pos, opponent)) return this.finish(opponent, 'timeout');
    return this.finish(null, 'timeout_vs_insufficient');
  }

  /** Oyunu sistem kararıyla bitirir (gelmeme, terk, hakem kararı). */
  terminate(winner: Color | null, reason: Extract<EndReason, 'abandon' | 'forfeit' | 'adjudication'>): GameStatus {
    this.assertOngoing();
    return this.finish(winner, reason);
  }

  /** Beraberliğe izin verilen ilk an: kurallarda belirtilen tam hamle sayısı tamamlandığında. */
  canOfferDraw(): boolean {
    if (this.statusValue.over) return false;
    return this.entries.length >= this.rules.drawOfferMinFullMoves * 2;
  }

  offerDraw(color: Color): void {
    this.assertOngoing();
    if (!this.canOfferDraw()) {
      throw new ChessError(
        'DRAW_OFFER_TOO_EARLY',
        `Beraberlik teklifi ${this.rules.drawOfferMinFullMoves}. hamleden sonra açılır`,
        { minFullMoves: this.rules.drawOfferMinFullMoves, plies: this.entries.length },
      );
    }
    if (this.pendingDrawOfferBy === color) {
      throw new ChessError('DRAW_OFFER_PENDING', 'Bekleyen bir teklifiniz zaten var');
    }
    if (this.pendingDrawOfferBy === opposite(color)) {
      // Karşı taraf zaten teklif etmişse, karşı teklif kabul demektir.
      this.finish(null, 'agreement');
      return;
    }
    this.pendingDrawOfferBy = color;
  }

  acceptDraw(color: Color): GameStatus {
    this.assertOngoing();
    if (this.pendingDrawOfferBy !== opposite(color)) {
      throw new ChessError('NO_DRAW_OFFER', 'Kabul edilecek bir beraberlik teklifi yok');
    }
    return this.finish(null, 'agreement');
  }

  declineDraw(color: Color): void {
    if (this.pendingDrawOfferBy === opposite(color)) this.pendingDrawOfferBy = null;
  }

  undo(): never {
    throw new ChessError('TAKEBACK_DISABLED', 'Hamle geri alma bu platformda kapalıdır');
  }

  // ---- iç işler ----------------------------------------------------------

  private legal(): InternalMove[] {
    if (!this.legalCache) this.legalCache = legalMoves(this.pos);
    return this.legalCache;
  }

  private bumpRepetition(): void {
    const key = positionKey(this.pos);
    this.repetitions.set(key, (this.repetitions.get(key) ?? 0) + 1);
  }

  /** Kendi kendine biten durumlar: mat, pat, ölü pozisyon, tekrar, 50 hamle. */
  private evaluate(): GameStatus {
    if (this.legal().length === 0) {
      return inCheck(this.pos)
        ? this.result(opposite(this.pos.turn), 'mate')
        : this.result(null, 'stalemate');
    }
    if (isInsufficientMaterial(this.pos)) return this.result(null, 'insufficient_material');
    if (this.rules.autoDrawOnThreefold && (this.repetitions.get(positionKey(this.pos)) ?? 0) >= 3) {
      return this.result(null, 'threefold_repetition');
    }
    if (this.rules.autoDrawOnFiftyMove && this.pos.halfmove >= 100) return this.result(null, 'fifty_move');
    return ONGOING;
  }

  private result(winner: Color | null, reason: EndReason): GameStatus {
    const result: GameResult = winner === null ? '1/2-1/2' : winner === 'w' ? '1-0' : '0-1';
    return winner === null
      ? Object.freeze({ over: true, result, reason })
      : Object.freeze({ over: true, result, reason, winner });
  }

  private finish(winner: Color | null, reason: EndReason): GameStatus {
    this.statusValue = this.result(winner, reason);
    this.pendingDrawOfferBy = null;
    this.legalCache = [];
    return this.statusValue;
  }

  private assertOngoing(): void {
    if (this.statusValue.over) {
      throw new ChessError('GAME_OVER', 'Oyun bitti', { result: this.statusValue.result, reason: this.statusValue.reason });
    }
  }
}
