/**
 * Sunucu saati (plan M3, doküman 8.5). Saf: zamanı dışarıdan alır, kendi
 * zamanlayıcısı yoktur; böylece milisaniye düzeyinde deterministik test edilir.
 *
 * Gecikme telafisi (K3): oyuncunun ölçülen tek yön gecikmesi kadar süre,
 * en fazla `capMs` (varsayılan 300 ms) olmak üzere oyuncuya geri verilir.
 * Telafi hiçbir zaman o hamlede geçen süreden fazla olamaz.
 */
import type { Color } from '@satranc/chess-core';

export interface ClockSnapshot {
  whiteMs: number;
  blackMs: number;
  /** Saati işleyen taraf; oyun bitmiş ya da duraklatılmışsa null. */
  running: Color | null;
  incrementMs: number;
}

export type MoveTiming =
  | { ok: true; thinkMs: number; lagCompMs: number; clockMs: number }
  | { ok: false; flagged: true };

export class GameClock {
  private white: number;
  private black: number;
  private readonly incrementMs: number;
  private runningColor: Color | null = null;
  private turnStartedAt = 0;

  constructor(opts: { whiteMs: number; blackMs: number; incrementMs: number }) {
    this.white = opts.whiteMs;
    this.black = opts.blackMs;
    this.incrementMs = opts.incrementMs;
  }

  get running(): Color | null {
    return this.runningColor;
  }

  start(color: Color, now: number): void {
    this.runningColor = color;
    this.turnStartedAt = now;
  }

  /** Saati durdurur; işleyen tarafın geçen süresi düşülür (oyun sonu). */
  stop(now: number): void {
    if (this.runningColor) this.set(this.runningColor, this.remaining(this.runningColor, now));
    this.runningColor = null;
  }

  /** Sistem kaynaklı kesinti: süre dondurulur, geçen süre düşülmez (doküman 3.6). */
  freeze(): Color | null {
    const c = this.runningColor;
    this.runningColor = null;
    return c;
  }

  remaining(color: Color, now: number): number {
    const base = color === 'w' ? this.white : this.black;
    if (this.runningColor !== color) return base;
    return base - (now - this.turnStartedAt);
  }

  elapsedThisTurn(now: number): number {
    return this.runningColor ? now - this.turnStartedAt : 0;
  }

  /**
   * Hamle zamanlaması: hamleyi yapan tarafın süresinden geçen süre (telafi
   * düşülerek) çıkarılır; süre yettiyse artış eklenir ve saat rakibe geçer.
   * Hiçbir durumu değiştirmez; `commit` ile uygulanır.
   */
  timeMove(color: Color, now: number, lagEstimateMs: number, capMs: number): MoveTiming {
    if (this.runningColor !== color) throw new Error('Saat bu tarafta işlemiyor');
    const elapsed = Math.max(0, now - this.turnStartedAt);
    const lagCompMs = Math.max(0, Math.min(lagEstimateMs, capMs, elapsed));
    const charged = elapsed - lagCompMs;
    const before = color === 'w' ? this.white : this.black;
    const left = before - charged;
    if (left <= 0) return { ok: false, flagged: true };
    return { ok: true, thinkMs: Math.round(elapsed), lagCompMs: Math.round(lagCompMs), clockMs: Math.round(left + this.incrementMs) };
  }

  commit(color: Color, timing: Extract<MoveTiming, { ok: true }>, now: number): void {
    this.set(color, timing.clockMs);
    this.runningColor = color === 'w' ? 'b' : 'w';
    this.turnStartedAt = now;
  }

  /**
   * İşleyen tarafın süresinin bittiği an (ms, mutlak). Gecikme telafisi kadar
   * tolerans eklenir: hamlesi yoldaysa ve telafiyle zamanında sayılacaksa bayrak düşmez.
   */
  flagDeadline(lagEstimateMs: number, capMs: number): number | null {
    if (!this.runningColor) return null;
    const base = this.runningColor === 'w' ? this.white : this.black;
    return this.turnStartedAt + base + Math.max(0, Math.min(lagEstimateMs, capMs));
  }

  snapshot(now: number): ClockSnapshot {
    return {
      whiteMs: Math.max(0, Math.round(this.remaining('w', now))),
      blackMs: Math.max(0, Math.round(this.remaining('b', now))),
      running: this.runningColor,
      incrementMs: this.incrementMs,
    };
  }

  private set(color: Color, ms: number): void {
    if (color === 'w') this.white = ms;
    else this.black = ms;
  }
}
