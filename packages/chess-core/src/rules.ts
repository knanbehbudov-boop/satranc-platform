import type { TimeControl } from './timecontrol.ts';

/**
 * Format kural seti (doküman 3.4). Turnuva açılırken şablondan üretilir ve
 * oyun boyunca değişmez.
 */
export interface RuleSet {
  /** Ücretli (para ödüllü) oyun mu? */
  readonly paid: boolean;
  /**
   * Beraberlik teklifinin açıldığı tam hamle sayısı. 0 = her zaman açık.
   * Ücretli oyunda 20: her iki taraf 20 hamle yapmadan (40 yarım hamle) teklif yok.
   */
  readonly drawOfferMinFullMoves: number;
  /** Ön hamle (premove): yalnızca bullet'ta açık. Arayüz ve M3 bu bayrağa bakar. */
  readonly premoveAllowed: boolean;
  /** Hamle geri alma: her formatta kapalı. */
  readonly takebackAllowed: false;
  /** Üç kez tekrar oluşunca oyun kendiliğinden berabere biter. */
  readonly autoDrawOnThreefold: boolean;
  /** 50 hamle kuralı dolunca oyun kendiliğinden berabere biter. */
  readonly autoDrawOnFiftyMove: boolean;
}

export const CASUAL_RULES: RuleSet = Object.freeze({
  paid: false,
  drawOfferMinFullMoves: 0,
  premoveAllowed: true,
  takebackAllowed: false,
  autoDrawOnThreefold: true,
  autoDrawOnFiftyMove: true,
});

export function rulesFor(opts: { paid: boolean; timeControl: TimeControl }): RuleSet {
  return Object.freeze({
    paid: opts.paid,
    drawOfferMinFullMoves: opts.paid ? 20 : 0,
    premoveAllowed: opts.timeControl.category === 'bullet',
    takebackAllowed: false,
    autoDrawOnThreefold: true,
    autoDrawOnFiftyMove: true,
  });
}
