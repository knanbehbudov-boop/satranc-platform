/**
 * Bot seviyeleri (doküman 12.2). Stockfish varsa UCI_Elo/Skill Level kullanılır;
 * yoksa yerleşik motor için arama derinliği ve "hata payı" (centipawn) kullanılır.
 * Hata payı: kök hamleler değerlendirilir, en iyiye bu kadar yakın hamlelerden
 * biri rastgele seçilir; böylece zayıf botlar insan gibi hata yapar.
 */
export interface BotLevel {
  id: string;
  name: string;
  elo: number;
  stockfish: { options: Record<string, string>; movetimeMs: number };
  builtin: { depth: number; noiseCp: number };
  /** İnsan benzeri düşünme süresi aralığı (ms). */
  thinkMs: [number, number];
}

export const BOT_LEVELS: readonly BotLevel[] = [
  {
    id: 'baslangic', name: 'Başlangıç', elo: 900,
    stockfish: { options: { 'Skill Level': '0' }, movetimeMs: 50 },
    builtin: { depth: 1, noiseCp: 350 },
    thinkMs: [600, 2_000],
  },
  {
    id: 'kolay', name: 'Kolay', elo: 1200,
    stockfish: { options: { UCI_LimitStrength: 'true', UCI_Elo: '1320' }, movetimeMs: 100 },
    builtin: { depth: 2, noiseCp: 150 },
    thinkMs: [700, 2_500],
  },
  {
    id: 'orta', name: 'Orta', elo: 1600,
    stockfish: { options: { UCI_LimitStrength: 'true', UCI_Elo: '1600' }, movetimeMs: 300 },
    builtin: { depth: 2, noiseCp: 40 },
    thinkMs: [800, 3_000],
  },
  {
    id: 'ileri', name: 'İleri', elo: 2000,
    stockfish: { options: { UCI_LimitStrength: 'true', UCI_Elo: '2000' }, movetimeMs: 500 },
    builtin: { depth: 3, noiseCp: 15 },
    thinkMs: [900, 3_500],
  },
  {
    id: 'usta', name: 'Usta', elo: 2400,
    stockfish: { options: { UCI_LimitStrength: 'true', UCI_Elo: '2400' }, movetimeMs: 800 },
    builtin: { depth: 3, noiseCp: 0 },
    thinkMs: [1_000, 4_000],
  },
  {
    id: 'maksimum', name: 'Maksimum', elo: 3000,
    stockfish: { options: {}, movetimeMs: 1_000 },
    builtin: { depth: 4, noiseCp: 0 },
    thinkMs: [1_000, 4_000],
  },
];

export function botLevel(id: string): BotLevel | undefined {
  return BOT_LEVELS.find((l) => l.id === id);
}
