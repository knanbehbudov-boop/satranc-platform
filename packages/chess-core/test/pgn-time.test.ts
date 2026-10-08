import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  armageddonClocks,
  ChessError,
  ChessGame,
  parsePgn,
  parseTimeControl,
  rulesFor,
  toPgn,
} from '../src/index.ts';
import { OPERA_GAME } from './fixtures.ts';

describe('PGN', () => {
  it('Opera Oyunu: yorum, varyant ve NAG atlanır, 17. hamlede mat', () => {
    const { headers, game, declaredResult } = parsePgn(OPERA_GAME);
    assert.equal(headers.White, 'Paul Morphy');
    assert.equal(declaredResult, '1-0');
    assert.equal(game.plyCount(), 33);
    assert.deepEqual(game.status(), { over: true, result: '1-0', reason: 'mate', winner: 'w' });
    assert.equal(game.history().at(-1)?.move.san, 'Rd8#');
  });

  it('yazılan PGN tekrar okununca aynı pozisyon çıkar', () => {
    const original = parsePgn(OPERA_GAME).game;
    const text = toPgn(original, { White: 'Morphy', Black: 'Müttefikler' });
    const again = parsePgn(text).game;
    assert.equal(again.fen(), original.fen());
    assert.match(text, /\[Termination "Normal"\]/);
    for (const line of text.split('\n')) assert.ok(line.length <= 80, line);
  });

  it('özel başlangıç pozisyonu: SetUp/FEN etiketi ve "1..." numaralandırması', () => {
    const g = new ChessGame({ fen: '4k3/8/8/8/8/8/4P3/4K3 b - - 0 12' });
    g.move('Kd7');
    g.move('e4');
    const text = toPgn(g);
    assert.match(text, /\[SetUp "1"\]/);
    assert.match(text, /\[FEN "4k3\/8\/8\/8\/8\/8\/4P3\/4K3 b - - 0 12"\]/);
    assert.match(text, /12\.\.\. Kd7 13\. e4 \*/);
    assert.equal(parsePgn(text).game.fen(), g.fen());
  });

  it('teslimle biten oyun: sonuç etiketi ve Termination', () => {
    const g = new ChessGame();
    g.move('e4');
    g.resign('b');
    const text = toPgn(g);
    assert.match(text, /\[Result "1-0"\]/);
    assert.match(text, /1\. e4 1-0/);
  });

  it('süre bitimi Termination olarak yazılır', () => {
    const g = new ChessGame();
    g.move('e4');
    g.flag('b');
    assert.match(toPgn(g), /\[Termination "Time forfeit"\]/);
  });

  it('yasal olmayan hamlede hangi yarım hamlede bozulduğunu söyler', () => {
    assert.throws(
      () => parsePgn('1. e4 e5 2. Ke3 *'),
      (e: unknown) => e instanceof ChessError && e.code === 'INVALID_PGN' && e.details?.ply === 3,
    );
  });
});

describe('zaman kontrolü ve kural setleri', () => {
  it('kategori: 1+0 bullet, 3+2 ve 5+3 blitz, 10+5 rapid, 30+20 klasik', () => {
    const cat = (c: string): string => parseTimeControl(c).category;
    assert.equal(cat('60+0'), 'bullet');
    assert.equal(cat('120+1'), 'bullet');
    assert.equal(cat('180+2'), 'blitz');
    assert.equal(cat('300+3'), 'blitz');
    assert.equal(cat('600+5'), 'rapid');
    assert.equal(cat('1800+20'), 'classical');
  });

  it('etiket ve milisaniye', () => {
    const tc = parseTimeControl('300+3');
    assert.equal(tc.label, '5+3');
    assert.equal(tc.initialMs, 300_000);
    assert.equal(tc.incrementMs, 3_000);
    assert.equal(parseTimeControl('30+0').label, '½+0');
  });

  it('geçersiz zaman kontrolü', () => {
    for (const bad of ['5+3m', '', '0+0', '300', 'abc']) {
      assert.throws(() => parseTimeControl(bad), (e: unknown) => e instanceof ChessError && e.code === 'INVALID_TIME_CONTROL', bad);
    }
  });

  it('kurallar: ücretli → beraberlik 20. hamleden sonra; premove yalnız bullet', () => {
    const paidBlitz = rulesFor({ paid: true, timeControl: parseTimeControl('300+3') });
    assert.equal(paidBlitz.drawOfferMinFullMoves, 20);
    assert.equal(paidBlitz.premoveAllowed, false);
    assert.equal(paidBlitz.takebackAllowed, false);
    const freeBullet = rulesFor({ paid: false, timeControl: parseTimeControl('60+0') });
    assert.equal(freeBullet.drawOfferMinFullMoves, 0);
    assert.equal(freeBullet.premoveAllowed, true);
  });

  it('Armageddon (K5): beyaz 5 dk, siyah 4 dk, ana artış korunur, beraberlikte siyah', () => {
    assert.deepEqual(armageddonClocks(parseTimeControl('300+3')), {
      whiteMs: 300_000,
      blackMs: 240_000,
      incrementMs: 3_000,
      drawWinner: 'b',
    });
  });
});
