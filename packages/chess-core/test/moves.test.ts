import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChessError, ChessGame } from '../src/index.ts';

function illegal(fn: () => unknown): void {
  assert.throws(fn, (e: unknown) => e instanceof ChessError && e.code === 'ILLEGAL_MOVE');
}

const sans = (g: ChessGame, sq?: string): string[] => g.moves(sq).map((m) => m.san).sort();

describe('özel hamleler', () => {
  it('kısa ve uzun rok, kale doğru kareye gider', () => {
    const g = new ChessGame({ fen: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1' });
    assert.ok(sans(g, 'e1').includes('O-O'));
    assert.ok(sans(g, 'e1').includes('O-O-O'));
    g.move('O-O');
    assert.equal(g.get('g1')?.type, 'k');
    assert.equal(g.get('f1')?.type, 'r');
    assert.equal(g.get('h1'), null);
    g.move('e8c8'); // UCI ile uzun rok
    assert.equal(g.get('c8')?.type, 'k');
    assert.equal(g.get('d8')?.type, 'r');
    assert.equal(g.fen().split(' ')[2], '-');
  });

  it('şah çekilmişken, tehdit altındaki kareden geçerek ya da araya taş varken rok yok', () => {
    const inCheck = new ChessGame({ fen: '4k3/8/8/8/8/8/4r3/R3K2R w KQ - 0 1' });
    assert.ok(!sans(inCheck).some((s) => s.startsWith('O-O')));

    const through = new ChessGame({ fen: '4k3/8/8/8/8/8/5r2/R3K2R w KQ - 0 1' });
    assert.ok(!sans(through).includes('O-O'), 'f1 tehdit altında');
    assert.ok(sans(through).includes('O-O-O'), 'vezir kanadı serbest');

    // b1 tehdit altında olsa da uzun rok yasaldır; yalnız şahın geçtiği kareler önemli.
    const bAttacked = new ChessGame({ fen: '1r2k3/8/8/8/8/8/8/R3K3 w Q - 0 1' });
    assert.ok(sans(bAttacked).includes('O-O-O'));

    const blocked = new ChessGame({ fen: '4k3/8/8/8/8/8/8/RN2K2R w KQ - 0 1' });
    assert.ok(!sans(blocked).includes('O-O-O'));
  });

  it('kale oynayınca ya da alınınca rok hakkı düşer', () => {
    const g = new ChessGame({ fen: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1' });
    g.move('Rh2');
    g.move('h8h7');
    assert.equal(g.fen().split(' ')[2], 'Qq');

    const c = new ChessGame({ fen: 'r3k2r/8/8/8/8/8/6B1/R3K2R w KQkq - 0 1' });
    c.move('Bxa8');
    assert.equal(c.fen().split(' ')[2], 'KQk');
  });

  it('geçerken alma yalnızca hemen ardından yapılabilir', () => {
    const g = new ChessGame({ fen: 'k7/3p4/8/4P3/8/8/8/K7 b - - 0 1' });
    g.move('d5');
    const ep = g.moves('e5').find((m) => m.flag === 'e');
    assert.equal(ep?.san, 'exd6');
    g.move('exd6');
    assert.equal(g.get('d5'), null, 'alınan piyon tahtadan kalkar');

    const late = new ChessGame({ fen: 'k7/3p4/8/4P3/8/8/8/K7 b - - 0 1' });
    late.move('d5');
    late.move('Kb1');
    late.move('Kb8');
    illegal(() => late.move('exd6'));
  });

  it('terfi: taş belirtilmeden yapılamaz, dört taşa da terfi edilebilir', () => {
    const g = new ChessGame({ fen: '7k/P7/8/8/8/8/8/K7 w - - 0 1' });
    assert.deepEqual(sans(g, 'a7'), ['a8=B', 'a8=N', 'a8=Q+', 'a8=R+']);
    assert.throws(
      () => g.move({ from: 'a7', to: 'a8' }),
      (e: unknown) => e instanceof ChessError && e.details?.needsPromotion === true,
    );
    const m = g.move({ from: 'a7', to: 'a8', promotion: 'n' });
    assert.equal(m.san, 'a8=N');
    assert.equal(g.get('a8')?.type, 'n');
  });

  it('terfi SAN, UCI ve "=" olmadan yazılabilir', () => {
    for (const input of ['a8=Q', 'a8=Q+', 'a7a8q', 'a8Q']) {
      const g = new ChessGame({ fen: '7k/P7/8/8/8/8/8/K7 w - - 0 1' });
      g.move(input);
      assert.equal(g.get('a8')?.type, 'q', input);
    }
  });

  it('açmazdaki taş oynayamaz, şahı tehdide sokan hamle yok', () => {
    const g = new ChessGame({ fen: '4k3/4r3/8/8/8/8/4N3/4K3 w - - 0 1' });
    assert.deepEqual(g.moves('e2'), []);
    illegal(() => g.move('Nc3'));
    const k = new ChessGame({ fen: '4k3/8/8/8/8/8/3r4/4K3 w - - 0 1' });
    assert.deepEqual(sans(k, 'e1'), ['Kf1', 'Kxd2']);
  });
});

describe('SAN', () => {
  it('belirsizlik: önce sütun, sonra yatay, gerekirse ikisi', () => {
    const files = new ChessGame({ fen: '4k3/8/8/8/8/8/K7/R6R w - - 0 1' });
    assert.ok(sans(files).includes('Rad1'));
    assert.ok(sans(files).includes('Rhd1'));

    const ranks = new ChessGame({ fen: '4k3/R7/8/8/8/8/R7/4K3 w - - 0 1' });
    assert.ok(sans(ranks).includes('R2a5'));
    assert.ok(sans(ranks).includes('R7a5'));

    const both = new ChessGame({ fen: '7k/8/8/8/2Q1Q3/8/2Q5/K7 w - - 0 1' });
    assert.ok(sans(both).includes('Qc4d3'), sans(both).join(' '));
  });

  it('şah ve mat işaretleri', () => {
    const g = new ChessGame();
    for (const m of ['f3', 'e5', 'g4']) g.move(m);
    const mate = g.move('Qh4');
    assert.equal(mate.san, 'Qh4#');
  });

  it('SAN girdisinde süsler ve 0-0 yazımı kabul edilir', () => {
    const g = new ChessGame({ fen: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1' });
    g.move('0-0!?');
    assert.equal(g.get('g1')?.type, 'k');
  });

  it('nesne girdisi ve hatalı kare', () => {
    const g = new ChessGame();
    g.move({ from: 'g1', to: 'f3' });
    assert.throws(() => g.move({ from: 'z9', to: 'e5' }), (e: unknown) => e instanceof ChessError && e.code === 'INVALID_SQUARE');
    illegal(() => g.move('e4e5'));
    illegal(() => g.move('Ke2'));
  });
});
