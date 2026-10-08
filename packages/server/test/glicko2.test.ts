import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_RATING, update } from '../src/modules/rating/glicko2.ts';

describe('M6 Glicko-2', () => {
  // Makaledeki 1464,06 ara adımların yuvarlanmasıyla elde edilir; tam hesap 1464,05 verir.
  it("Glickman'ın yayınladığı örnek: ≈1464,06 / 151,52 / 0,05999", () => {
    const r = update({ rating: 1500, rd: 200, vol: 0.06 }, [
      { opponent: { rating: 1400, rd: 30 }, score: 1 },
      { opponent: { rating: 1550, rd: 100 }, score: 0 },
      { opponent: { rating: 1700, rd: 300 }, score: 0 },
    ], 0.5, false);
    assert.ok(Math.abs(r.rating - 1464.06) < 0.02, String(r.rating));
    assert.equal(r.rd.toFixed(2), '151.52');
    assert.ok(Math.abs(r.vol - 0.05999) < 1e-5, String(r.vol));
  });

  it('kazanan yükselir, kaybeden düşer; toplam yaklaşık korunur', () => {
    const a = { ...DEFAULT_RATING };
    const b = { ...DEFAULT_RATING };
    const a2 = update(a, [{ opponent: b, score: 1 }]);
    const b2 = update(b, [{ opponent: a, score: 0 }]);
    assert.ok(a2.rating > 1500 && b2.rating < 1500);
    assert.ok(Math.abs(a2.rating - 1500 - (1500 - b2.rating)) < 1e-9);
    assert.ok(a2.rd < 350, 'belirsizlik azalır');
  });

  it('beraberlikte eşit oyuncuların puanı değişmez', () => {
    const r = update(DEFAULT_RATING, [{ opponent: DEFAULT_RATING, score: 0.5 }]);
    assert.ok(Math.abs(r.rating - 1500) < 1e-9);
  });

  it('beklenen sonuç (güçlü oyuncu zayıfı yener) az puan kazandırır', () => {
    const strong = { rating: 2000, rd: 60, vol: 0.06 };
    const weak = { rating: 1400, rd: 60, vol: 0.06 };
    const won = update(strong, [{ opponent: weak, score: 1 }]);
    const lost = update(strong, [{ opponent: weak, score: 0 }]);
    assert.ok(won.rating - 2000 < 2);
    assert.ok(2000 - lost.rating > 10);
  });

  it('RD sınırları: 45–350', () => {
    let r = { rating: 1500, rd: 50, vol: 0.06 };
    for (let i = 0; i < 200; i++) r = update(r, [{ opponent: { rating: 1500, rd: 50 }, score: 0.5 }]);
    assert.ok(r.rd >= 45);
    assert.equal(update({ rating: 1500, rd: 349.9, vol: 0.06 }, []).rd, 350);
  });
});
