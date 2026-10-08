import { ChessError } from './errors.ts';
import { START_FEN } from './fen.ts';
import { ChessGame } from './game.ts';
import { CASUAL_RULES, type RuleSet } from './rules.ts';
import type { EndReason, GameResult } from './types.ts';

export type PgnHeaders = Record<string, string>;

const TERMINATION: Record<EndReason, string> = {
  mate: 'Normal',
  resign: 'Normal',
  stalemate: 'Normal',
  insufficient_material: 'Normal',
  threefold_repetition: 'Normal',
  fifty_move: 'Normal',
  agreement: 'Normal',
  timeout: 'Time forfeit',
  timeout_vs_insufficient: 'Time forfeit',
  abandon: 'Abandoned',
  forfeit: 'Rules infraction',
  adjudication: 'Adjudication',
};

function escapeValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Oyunu PGN olarak yazar (arşiv ve analiz işçisi M4b için).
 * Yedi zorunlu etiket her zaman bulunur; başlangıç pozisyonu standart değilse
 * SetUp/FEN etiketleri eklenir. Satırlar 80 karakteri geçmez.
 */
export function toPgn(game: ChessGame, headers: PgnHeaders = {}): string {
  const status = game.status();
  const result: GameResult = status.result;
  const tags: PgnHeaders = {
    Event: '?',
    Site: '?',
    Date: '????.??.??',
    Round: '?',
    White: '?',
    Black: '?',
    ...headers,
    Result: result,
  };
  if (game.initialFen() !== START_FEN) {
    tags.SetUp = '1';
    tags.FEN = game.initialFen();
  }
  if (status.over && status.reason && !tags.Termination) tags.Termination = TERMINATION[status.reason];

  const head = Object.entries(tags)
    .map(([k, v]) => `[${k} "${escapeValue(v)}"]`)
    .join('\n');

  const tokens: string[] = [];
  const history = game.history();
  history.forEach((entry, i) => {
    const fullmove = Number(entry.fenBefore.split(' ')[5]);
    if (entry.move.color === 'w') tokens.push(`${fullmove}.`);
    else if (i === 0) tokens.push(`${fullmove}...`);
    tokens.push(entry.move.san);
  });
  tokens.push(result);

  const lines: string[] = [];
  let line = '';
  for (const t of tokens) {
    if (line && line.length + 1 + t.length > 80) {
      lines.push(line);
      line = t;
    } else {
      line = line ? `${line} ${t}` : t;
    }
  }
  if (line) lines.push(line);
  return `${head}\n\n${lines.join('\n')}\n`;
}

export interface ParsedPgn {
  readonly headers: PgnHeaders;
  readonly game: ChessGame;
  /** Hareket metninin sonundaki sonuç işareti (teslim gibi tahtada görünmeyen sonuçlar için). */
  readonly declaredResult: GameResult;
}

function stripVariations(text: string): string {
  let depth = 0;
  let out = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out;
}

/** Tek oyunluk PGN okur ve hamleleri yeniden oynayarak doğrular. */
export function parsePgn(text: string, rules?: RuleSet): ParsedPgn {
  if (typeof text !== 'string' || !text.trim()) throw new ChessError('INVALID_PGN', 'Boş PGN');
  const headers: PgnHeaders = {};
  const tagRe = /^\s*\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]\s*$/gm;
  let match: RegExpExecArray | null;
  let lastTagEnd = 0;
  while ((match = tagRe.exec(text)) !== null) {
    headers[match[1] as string] = (match[2] as string).replace(/\\(["\\])/g, '$1');
    lastTagEnd = tagRe.lastIndex;
  }

  let body = text.slice(lastTagEnd);
  body = body.replace(/\{[^}]*\}/g, ' ').replace(/;[^\n]*/g, ' ');
  body = stripVariations(body);
  body = body.replace(/\$\d+/g, ' ');

  const tokens = body.split(/\s+/).filter(Boolean);
  const fen = headers.SetUp === '1' || headers.FEN ? headers.FEN : undefined;
  // Dış kaynaklı PGN'lerde oyuncular talep edilebilir bir tekrardan sonra devam
  // etmiş olabilir; varsayılan olarak otomatik beraberlikler kapalı okunur.
  const effective: RuleSet = rules ?? { ...CASUAL_RULES, autoDrawOnThreefold: false, autoDrawOnFiftyMove: false };
  const game = new ChessGame(fen ? { fen, rules: effective } : { rules: effective });
  let declaredResult: GameResult = '*';

  for (const raw of tokens) {
    if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(raw)) {
      declaredResult = raw as GameResult;
      break;
    }
    const tok = raw.replace(/^\d+\.(\.\.)?/, '');
    if (!tok) continue;
    try {
      game.move(tok);
    } catch (e) {
      throw new ChessError('INVALID_PGN', `PGN'de yasal olmayan hamle: ${tok}`, {
        token: tok,
        ply: game.plyCount() + 1,
        cause: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { headers, game, declaredResult };
}
