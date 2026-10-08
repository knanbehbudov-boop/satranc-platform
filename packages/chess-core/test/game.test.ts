import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChessError, ChessGame, parseTimeControl, rulesFor } from '../src/index.ts';

const PAID_BLITZ = rulesFor({ paid: true, timeControl: parseTimeControl('300+3') });

function code(fn: () => unknown, expected: string): void {
  assert.throws(fn, (e: unknown) => e instanceof ChessError && e.code === expected);
}

describe('oyun sonu: tahtada biten durumlar', () => {
  it('mat', () => {
    const g = new ChessGame();
    for (const m of ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#']) g.move(m);
    assert.deepEqual(g.status(), { over: true, result: '1-0', reason: 'mate', winner: 'w' });
    assert.deepEqual(g.moves(), []);
    code(() => g.move('Ke7'), 'GAME_OVER');
  });

  it('pat', () => {
    const p = new ChessGame({ fen: '7k/8/6Q1/8/8/8/8/K7 w - - 0 1' });
    p.move('Qf7');
    assert.deepEqual(p.status(), { over: true, result: '1/2-1/2', reason: 'stalemate' });
  });

  it('yetersiz materyal: Ş–Ş, Ş+A–Ş, aynı renk filler', () => {
    const kk = new ChessGame({ fen: '8/8/4k3/8/3q4/2K5/8/8 w - - 0 1' });
    kk.move('Kxd4');
    assert.equal(kk.status().reason, 'insufficient_material');

    assert.equal(
      new ChessGame({ fen: 'k7/8/3b4/8/8/2B5/8/7K w - - 0 1' }).status().reason,
      'insufficient_material',
      'aynı renk filler: ölü pozisyon',
    );
    assert.equal(new ChessGame({ fen: 'k7/8/3b4/8/8/3B4/8/7K w - - 0 1' }).status().over, false, 'ters renk filler: devam');
    assert.equal(new ChessGame({ fen: '8/8/8/4k3/8/2N1K3/8/8 w - - 0 1' }).status().reason, 'insufficient_material');
    assert.equal(new ChessGame({ fen: '8/8/8/4k3/8/1NN1K3/8/8 w - - 0 1' }).status().over, false, 'iki at: devam');
  });

  it('üç kez tekrar (otomatik)', () => {
    const g = new ChessGame();
    const shuffle = ['Nf3', 'Nf6', 'Ng1', 'Ng8'];
    for (const m of [...shuffle, ...shuffle]) {
      if (!g.status().over) g.move(m);
    }
    assert.equal(g.status().reason, 'threefold_repetition');
    assert.equal(g.plyCount(), 8);
  });

  it('50 hamle kuralı (otomatik), ama mat önce gelir', () => {
    const g = new ChessGame({ fen: '7k/8/8/8/8/8/R7/K7 w - - 99 80' });
    g.move('Rb2');
    assert.equal(g.status().reason, 'fifty_move');

    const mate = new ChessGame({ fen: '7k/8/6K1/8/8/8/8/R7 w - - 99 80' });
    mate.move('Ra8#');
    assert.equal(mate.status().reason, 'mate');
  });
});

describe('oyun sonu: dışarıdan gelen kararlar', () => {
  it('teslim', () => {
    const g = new ChessGame();
    assert.deepEqual(g.resign('w'), { over: true, result: '0-1', reason: 'resign', winner: 'b' });
  });

  it('süre bitimi: rakip mat edebiliyorsa kayıp, edemiyorsa beraberlik', () => {
    const win = new ChessGame({ fen: '4k3/8/8/8/8/8/4P3/4K3 b - - 0 1' });
    assert.deepEqual(win.flag('b'), { over: true, result: '1-0', reason: 'timeout', winner: 'w' });

    const bare = new ChessGame({ fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1' });
    assert.equal(bare.flag('w').reason, 'timeout_vs_insufficient', 'siyahta yalnız şah');

  });

  it('süre bitimi: tek atı olan taraf, rakipte engel taşı varsa kazanır', () => {
    const g = new ChessGame({ fen: '4k3/4p3/8/8/8/8/8/2N1K3 b - - 0 1' });
    assert.equal(g.flag('b').reason, 'timeout');
    const h = new ChessGame({ fen: '4k3/8/8/8/8/8/8/2N1K3 w - - 0 1' });
    // Ş+A–Ş tahtada zaten ölü pozisyondur; oyun başlarken biter.
    assert.equal(h.status().reason, 'insufficient_material');
  });

  it('sistem kararları: gelmeme, terk, hakem', () => {
    assert.equal(new ChessGame().terminate('b', 'forfeit').result, '0-1');
    assert.equal(new ChessGame().terminate(null, 'adjudication').result, '1/2-1/2');
  });

  it('geri alma her zaman kapalı', () => {
    code(() => new ChessGame().undo(), 'TAKEBACK_DISABLED');
  });
});

describe('beraberlik teklifi', () => {
  it('ücretli oyunda 20. hamle tamamlanmadan kapalı', () => {
    const g = new ChessGame({ rules: PAID_BLITZ });
    // Gerçekçi bir İspanyol açılışı: 39 yarım hamle, tekrar yok.
    const line = [
      'e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7',
      'Re1', 'b5', 'Bb3', 'd6', 'c3', 'O-O', 'h3', 'Nb8', 'd4', 'Nbd7',
      'Nbd2', 'Bb7', 'Bc2', 'Re8', 'Nf1', 'Bf8', 'Ng3', 'g6', 'a4', 'c5',
      'd5', 'c4', 'Bg5', 'h6', 'Be3', 'Nc5', 'Qd2', 'h5', 'Bg5',
    ];
    for (const m of line) g.move(m);
    assert.equal(g.plyCount(), 39);
    assert.equal(g.canOfferDraw(), false);
    code(() => g.offerDraw('b'), 'DRAW_OFFER_TOO_EARLY');
    g.move('Be7');
    assert.equal(g.plyCount(), 40);
    assert.equal(g.canOfferDraw(), true);
    g.offerDraw('w');
    assert.equal(g.drawOfferedBy(), 'w');
    assert.deepEqual(g.acceptDraw('b'), { over: true, result: '1/2-1/2', reason: 'agreement' });
  });

  it('ücretsiz oyunda her zaman açık; karşılıklı teklif kabul sayılır', () => {
    const g = new ChessGame();
    g.offerDraw('w');
    code(() => g.offerDraw('w'), 'DRAW_OFFER_PENDING');
    g.offerDraw('b');
    assert.equal(g.status().reason, 'agreement');
  });

  it('teklif edilen taraf hamle yapınca teklif düşer; teklif yokken kabul edilemez', () => {
    const g = new ChessGame();
    g.move('e4');
    g.offerDraw('w');
    g.move('e5');
    assert.equal(g.drawOfferedBy(), null);
    code(() => g.acceptDraw('b'), 'NO_DRAW_OFFER');
  });

  it('teklif eden kendi teklifini kabul edemez', () => {
    const g = new ChessGame();
    g.offerDraw('w');
    code(() => g.acceptDraw('w'), 'NO_DRAW_OFFER');
  });
});
