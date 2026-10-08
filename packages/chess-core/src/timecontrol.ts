import { ChessError } from './errors.ts';

export type TimeCategory = 'bullet' | 'blitz' | 'rapid' | 'classical';

export interface TimeControl {
  /** Her oyuncunun başlangıç süresi (ms). */
  readonly initialMs: number;
  /** Her hamleden sonra eklenen süre (ms). */
  readonly incrementMs: number;
  /** Veritabanı biçimi, ör. "300+3" (saniye). */
  readonly code: string;
  /** Arayüz etiketi, ör. "5+3" (dakika + saniye). */
  readonly label: string;
  readonly category: TimeCategory;
}

/**
 * Kategori, tahmini oyun süresinden belirlenir: başlangıç + 40 × artış.
 * Eşikler (saniye): < 180 bullet, < 480 blitz, < 1500 rapid, aksi klasik.
 * Örnek: 1+0 → bullet, 3+2 → blitz (260 sn), 5+3 → blitz (420 sn), 10+5 → rapid.
 */
export function categorize(initialSec: number, incrementSec: number): TimeCategory {
  const estimate = initialSec + 40 * incrementSec;
  if (estimate < 180) return 'bullet';
  if (estimate < 480) return 'blitz';
  if (estimate < 1500) return 'rapid';
  return 'classical';
}

function minutesLabel(sec: number): string {
  if (sec % 60 === 0) return String(sec / 60);
  if (sec === 15) return '¼';
  if (sec === 30) return '½';
  if (sec === 45) return '¾';
  return (sec / 60).toFixed(1);
}

/** "300+3" biçimini (saniye+saniye) okur. Şablon tablosundaki time_control alanı budur. */
export function parseTimeControl(code: string): TimeControl {
  const m = /^(\d{1,5})\+(\d{1,3})$/.exec(String(code).trim());
  if (!m) {
    throw new ChessError('INVALID_TIME_CONTROL', `Zaman kontrolü "saniye+saniye" olmalı: ${code}`, { code });
  }
  const initialSec = Number(m[1]);
  const incrementSec = Number(m[2]);
  if (initialSec <= 0 && incrementSec <= 0) {
    throw new ChessError('INVALID_TIME_CONTROL', 'Süre sıfır olamaz', { code });
  }
  return {
    initialMs: initialSec * 1000,
    incrementMs: incrementSec * 1000,
    code: `${initialSec}+${incrementSec}`,
    label: `${minutesLabel(initialSec)}+${incrementSec}`,
    category: categorize(initialSec, incrementSec),
  };
}

export interface ArmageddonClocks {
  readonly whiteMs: number;
  readonly blackMs: number;
  readonly incrementMs: number;
  /** Beraberlikte kazanan renk. */
  readonly drawWinner: 'b';
}

/**
 * Armageddon (doküman 3.5, K5): beyaz 5 dk, siyah 4 dk, beraberlikte siyah kazanır.
 * Artış, mini maçın ana zaman kontrolüyle aynıdır; doküman bu konuda değer
 * vermediği için ücretli turnuvada artışın tercih edilmesi ilkesi (3.3) uygulandı.
 */
export function armageddonClocks(main: TimeControl): ArmageddonClocks {
  return { whiteMs: 300_000, blackMs: 240_000, incrementMs: main.incrementMs, drawWinner: 'b' };
}
