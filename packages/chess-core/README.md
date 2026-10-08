# @satranc/chess-core (M2)

Satranç kurallarının tek kaynağı. Oyun sunucusu (M3), analiz işçisi (M4b) ve tarayıcıdaki
tahta (M14) aynı kodu kullanır; böylece istemci ve sunucu bir hamle için asla farklı karar vermez.

## Neden böyle

- **Saf:** veritabanına, ağa, saate, rastgeleliğe erişmez. Saat M3'te tutulur; süre bitimi
  `flag()` ile içeri verilir.
- **Bağımlılıksız:** lisans riski yok (Lichess AGPL, Stockfish GPL konularından bağımsız).
- **Doğruluk kanıtı:** 6 standart pozisyonda 20 perft sayımı. Tek bir eksik kural (ör. açmazdaki
  geçerken alma) sayıyı bozar.

## Kullanım

```ts
import { ChessGame, rulesFor, parseTimeControl, toPgn } from '@satranc/chess-core';

const rules = rulesFor({ paid: true, timeControl: parseTimeControl('300+3') });
const game = new ChessGame({ rules });

game.move('e4');                               // SAN
game.move('e7e5');                             // UCI
game.move({ from: 'g1', to: 'f3' });           // nesne (istemciden gelen biçim)
game.moves('b8');                              // b8'deki atın yasal hamleleri
game.status();                                 // { over, result, reason, winner }
game.flag('b');                                // süre bitimi (M3 çağırır)
toPgn(game, { White: 'Ali', Black: 'Ayşe' });  // arşiv
```

Hatalar `ChessError` olarak döner: `{ code, message, details }`. Kodlar: `ILLEGAL_MOVE`,
`GAME_OVER`, `DRAW_OFFER_TOO_EARLY`, `DRAW_OFFER_PENDING`, `NO_DRAW_OFFER`, `TAKEBACK_DISABLED`,
`INVALID_FEN`, `INVALID_SQUARE`, `INVALID_TIME_CONTROL`, `INVALID_PGN`.

## Bitiş nedenleri

`mate`, `stalemate`, `insufficient_material`, `threefold_repetition`, `fifty_move`, `agreement`,
`resign`, `timeout`, `timeout_vs_insufficient`, `abandon`, `forfeit`, `adjudication`.

## Kabul kriterleri (plan, M2)

- [x] Bilinen pozisyon ve PGN setinde tüm hamleler ve sonuçlar doğru (20 perft + Opera Oyunu).
- [x] Aynı paket sunucuda ve tarayıcıda aynı sonucu veriyor (`npm run test:browser`).
- [x] Modül veritabanına ve ağa erişmiyor; 62 birim testi.
