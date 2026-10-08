/**
 * Perft referans değerleri: satranç programcılığında hamle üreticisini
 * doğrulamak için kullanılan standart pozisyonlar ve kanıtlanmış sayımlar
 * (Chess Programming Wiki "Perft Results"). Rok, geçerken alma, terfi,
 * açmaz ve şah çekme durumlarının hepsini kapsar.
 */
export interface PerftCase {
  readonly name: string;
  readonly fen: string;
  /** counts[d-1] = derinlik d'deki yaprak sayısı */
  readonly counts: readonly number[];
}

export const PERFT_CASES: readonly PerftCase[] = [
  {
    name: 'Başlangıç pozisyonu',
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    counts: [20, 400, 8902, 197281],
  },
  {
    name: 'Kiwipete (rok, açmaz, geçerken alma)',
    fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    counts: [48, 2039, 97862],
  },
  {
    name: 'Pozisyon 3 (oyun sonu, yatay açmaz)',
    fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
    counts: [14, 191, 2812, 43238],
  },
  {
    name: 'Pozisyon 4 (terfi, şah altında rok)',
    fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
    counts: [6, 264, 9467],
  },
  {
    name: 'Pozisyon 5 (alışla terfi)',
    fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
    counts: [44, 1486, 62379],
  },
  {
    name: 'Pozisyon 6 (orta oyun)',
    fen: 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10',
    counts: [46, 2079, 89890],
  },
];

/** Morphy – Duke Karl / Count Isouard, Paris 1858 ("Opera Oyunu"). 17 hamlede mat. */
export const OPERA_GAME = `[Event "Paris Opera"]
[Site "Paris FRA"]
[Date "1858.??.??"]
[Round "?"]
[White "Paul Morphy"]
[Black "Duke Karl / Count Isouard"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 {zayıf bir hamle} 4. dxe5 Bxf3 5. Qxf3 dxe5
6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 $2 (9... Qb4 10. Qxb4) 10. Nxb5 cxb5
11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7
16. Qb8+ Nxb8 17. Rd8# 1-0`;
