import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GameClock } from '../src/modules/game/clock.ts';

const CAP = 300;

describe('M3 saat', () => {
  it('5+3: süre düşer, artış eklenir, saat rakibe geçer', () => {
    const c = new GameClock({ whiteMs: 300_000, blackMs: 300_000, incrementMs: 3_000 });
    c.start('w', 1_000);
    const t = c.timeMove('w', 11_000, 0, CAP);
    assert.deepEqual(t, { ok: true, thinkMs: 10_000, lagCompMs: 0, clockMs: 293_000 });
    if (!t.ok) return;
    c.commit('w', t, 11_000);
    assert.equal(c.running, 'b');
    assert.equal(c.remaining('w', 50_000), 293_000, 'beyazın saati durdu');
    assert.equal(c.remaining('b', 15_000), 296_000, 'siyahın saati işliyor');
  });

  it('gecikme telafisi en fazla 300 ms ve geçen süreden fazla olamaz', () => {
    const c = new GameClock({ whiteMs: 60_000, blackMs: 60_000, incrementMs: 0 });
    c.start('w', 0);
    const big = c.timeMove('w', 2_000, 900, CAP);
    assert.ok(big.ok && big.lagCompMs === 300 && big.clockMs === 58_300);
    const tiny = c.timeMove('w', 100, 900, CAP);
    assert.ok(tiny.ok && tiny.lagCompMs === 100 && tiny.clockMs === 60_000, 'telafi geçen süreyi aşmaz');
    const none = c.timeMove('w', 2_000, -50, CAP);
    assert.ok(none.ok && none.lagCompMs === 0);
  });

  it('süre biterse hamle kabul edilmez (bayrak)', () => {
    const c = new GameClock({ whiteMs: 5_000, blackMs: 5_000, incrementMs: 2_000 });
    c.start('w', 0);
    assert.deepEqual(c.timeMove('w', 5_000, 0, CAP), { ok: false, flagged: true });
    assert.deepEqual(c.timeMove('w', 5_300, 300, CAP), { ok: false, flagged: true }, 'telafi sonrası tam sıfır da bayrak');
    const saved = c.timeMove('w', 5_100, 300, CAP);
    assert.ok(saved.ok, 'gecikmesi ölçülmüş oyuncu 100 ms ile kurtulur');
  });

  it('bayrak zamanı: kalan süre + telafi toleransı', () => {
    const c = new GameClock({ whiteMs: 10_000, blackMs: 10_000, incrementMs: 0 });
    c.start('w', 1_000);
    assert.equal(c.flagDeadline(0, CAP), 11_000);
    assert.equal(c.flagDeadline(150, CAP), 11_150);
    assert.equal(c.flagDeadline(5_000, CAP), 11_300);
  });

  it('dondurma (sistem kesintisi) geçen süreyi düşmez; durdurma düşer', () => {
    const c = new GameClock({ whiteMs: 10_000, blackMs: 10_000, incrementMs: 0 });
    c.start('w', 0);
    const was = c.freeze();
    assert.equal(was, 'w');
    assert.equal(c.remaining('w', 99_999), 10_000);
    c.start('w', 100_000);
    c.stop(103_000);
    assert.equal(c.remaining('w', 200_000), 7_000);
    assert.equal(c.running, null);
  });

  it('anlık görüntü negatif süre göstermez', () => {
    const c = new GameClock({ whiteMs: 1_000, blackMs: 1_000, incrementMs: 0 });
    c.start('b', 0);
    assert.deepEqual(c.snapshot(5_000), { whiteMs: 1_000, blackMs: 0, running: 'b', incrementMs: 0 });
  });

  it('Armageddon saatleri farklı başlar', () => {
    const c = new GameClock({ whiteMs: 300_000, blackMs: 240_000, incrementMs: 3_000 });
    assert.deepEqual(c.snapshot(0), { whiteMs: 300_000, blackMs: 240_000, running: null, incrementMs: 3_000 });
  });
});
