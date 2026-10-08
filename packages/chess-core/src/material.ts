import { onBoard, squareShade } from './board.ts';
import type { Color, Position } from './types.ts';

interface Inventory {
  pawns: number;
  knights: number;
  bishops: number;
  rooks: number;
  queens: number;
  /** Fillerin bulunduğu kare renkleri (0 koyu, 1 açık). */
  bishopShades: Set<0 | 1>;
}

function inventory(pos: Position, color: Color): Inventory {
  const inv: Inventory = { pawns: 0, knights: 0, bishops: 0, rooks: 0, queens: 0, bishopShades: new Set() };
  for (let i = 0; i < 128; i++) {
    if (!onBoard(i)) continue;
    const p = pos.board[i];
    if (!p || p.color !== color) continue;
    switch (p.type) {
      case 'p': inv.pawns++; break;
      case 'n': inv.knights++; break;
      case 'b': inv.bishops++; inv.bishopShades.add(squareShade(i)); break;
      case 'r': inv.rooks++; break;
      case 'q': inv.queens++; break;
      default: break;
    }
  }
  return inv;
}

function nonKingCount(inv: Inventory): number {
  return inv.pawns + inv.knights + inv.bishops + inv.rooks + inv.queens;
}

/**
 * Ölü pozisyon (otomatik beraberlik): iki taraf da hiçbir hamle dizisiyle mat
 * edemez. Kapsanan durumlar: Ş-Ş, Ş+hafif taş-Ş, ve tahtadaki tüm fillerin
 * aynı renk karede olduğu (at, piyon, kale, vezir olmayan) pozisyonlar.
 */
export function isInsufficientMaterial(pos: Position): boolean {
  const w = inventory(pos, 'w');
  const b = inventory(pos, 'b');
  const heavy = w.pawns + w.rooks + w.queens + b.pawns + b.rooks + b.queens;
  if (heavy > 0) return false;

  const minors = w.knights + w.bishops + b.knights + b.bishops;
  if (minors <= 1) return true;

  if (w.knights + b.knights === 0) {
    const shades = new Set<0 | 1>([...w.bishopShades, ...b.bishopShades]);
    return shades.size === 1;
  }
  return false;
}

/**
 * Süre bitiminde kullanılan kural (dokümandaki 3.4): süresi biten kaybeder,
 * ancak rakibin mat edecek materyali yoksa oyun berabere biter.
 *
 * `color` tarafının (rakip yardım etse bile) mat verebilme ihtimali var mı?
 * Yaklaşım lichess ile aynı ölçüdedir:
 *  - Piyon, kale veya vezir varsa: evet.
 *  - Hiç hafif taş yoksa: hayır.
 *  - Tek hafif taş: ancak karşı tarafta şah dışında taş varsa (şahı kapatacak
 *    engel olabilir) evet, yoksa hayır.
 *  - Yalnızca aynı renk karelerde filler: tek hafif taşla aynı kural.
 *  - Diğer tüm durumlar: evet.
 */
export function canCheckmate(pos: Position, color: Color): boolean {
  const us = inventory(pos, color);
  const them = inventory(pos, color === 'w' ? 'b' : 'w');
  if (us.pawns + us.rooks + us.queens > 0) return true;
  const minors = us.knights + us.bishops;
  if (minors === 0) return false;
  const opponentHasBlockers = nonKingCount(them) > 0;
  if (minors === 1) return opponentHasBlockers;
  if (us.knights === 0 && us.bishopShades.size === 1) {
    // Aynı renk filler ters renk kareleri hiç kontrol edemez; şahın kaçış
    // kareleri ancak rakibin kendi taşlarıyla kapanabilir.
    return opponentHasBlockers;
  }
  return true;
}
