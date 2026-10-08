import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChessError, ChessGame, parseFen, START_FEN, toFen } from '../src/index.ts';
import { PERFT_CASES } from './fixtures.ts';

function expectFenError(fen: string): void {
  assert.throws(() => parseFen(fen), (e: unknown) => e instanceof ChessError && e.code === 'INVALID_FEN');
}

describe('FEN', () => {
  it('başlangıç pozisyonu aynen geri yazılır', () => {
    assert.equal(toFen(parseFen(START_FEN)), START_FEN);
  });

  it('perft pozisyonları aynen geri yazılır', () => {
    for (const c of PERFT_CASES) assert.equal(toFen(parseFen(c.fen)), c.fen, c.name);
  });

  it('4 alanlı FEN kabul edilir, sayaçlar 0 ve 1 olur', () => {
    assert.equal(toFen(parseFen('8/8/8/8/8/8/8/K6k w - -')), '8/8/8/8/8/8/8/K6k w - - 0 1');
  });

  it('geçersiz FENler reddedilir', () => {
    expectFenError('');
    expectFenError('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP w KQkq - 0 1'); // 7 yatay
    expectFenError('rnbqkbnr/pppppppp/9/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'); // 9 kare
    expectFenError('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1'); // sıra
    expectFenError('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNX w KQkq - 0 1'); // taş
    expectFenError('8/8/8/8/8/8/8/K7 w - - 0 1'); // siyah şah yok
    expectFenError('k7/8/8/8/8/8/8/KK6 w - - 0 1'); // iki beyaz şah
    expectFenError('P6k/8/8/8/8/8/8/K7 w - - 0 1'); // 8. yatayda piyon
    expectFenError('k6R/8/8/8/8/8/8/K7 w - - 0 1'); // sırası olmayan siyah şahta
    expectFenError('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBN1 w KQkq - 0 1'); // K hakkı ama h1 boş
    expectFenError('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq e3 0 1'); // e3 arkasında piyon yok
    expectFenError('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - -1 1'); // sayaç
  });

  it('geçerken alma karesi yalnızca alma mümkünse yazılır', () => {
    const g = new ChessGame();
    g.move('e4');
    // Siyahın e3'e alacak piyonu yok: FEN'de "-".
    assert.equal(g.fen().split(' ')[3], '-');

    const h = new ChessGame({ fen: 'rnbqkbnr/ppp1pppp/8/8/3p4/8/PPPPPPPP/RNBQKBNR w KQkq - 0 3' });
    h.move('e4');
    assert.equal(h.fen().split(' ')[3], 'e3');
  });

  it('yatay açmazdaki geçerken alma yasal sayılmaz', () => {
    // Beyaz şah a5, piyon b5; siyah c7-c5 sonrası bxc6 kaleyle şahı açar.
    const g = new ChessGame({ fen: '8/2p5/8/KP5r/8/8/8/7k b - - 0 1' });
    g.move('c5');
    assert.equal(g.fen().split(' ')[3], '-');
    assert.ok(!g.moves().some((m) => m.flag === 'e'));
  });
});
