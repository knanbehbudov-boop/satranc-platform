/**
 * Yerleşik UCI motoru (Stockfish yokken ve testlerde kullanılır).
 *
 * Ayrı bir süreç olarak çalışır ve UCI protokolünü konuşur; böylece bot servisi
 * gerçek Stockfish'i de bunu da AYNI sürücüyle kullanır ve sürücü gerçekten test edilir.
 * Güç: alfa-beta + sükunet araması + taş-kare tabloları. Kulüp seviyesinin altıdır;
 * üretimde Stockfish kullanılır (STOCKFISH_PATH).
 *
 * Desteklenen komutlar: uci, isready, ucinewgame, setoption (BotNoise, BotDepth,
 * Skill Level), position [startpos|fen ...] [moves ...], go [depth N] [movetime N], stop, quit.
 */
import { randomInt } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  applyMove,
  inCheck,
  legalMoves,
  parseFen,
  START_FEN,
  toUci,
  type InternalMove,
  type PieceType,
  type Position,
} from '@satranc/chess-core';

const VALUE: Record<PieceType, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

// Taş-kare tabloları (beyaz açısından, 8. yataydan 1. yataya).
const PST: Record<PieceType, number[]> = {
  p: [0,0,0,0,0,0,0,0, 50,50,50,50,50,50,50,50, 10,10,20,30,30,20,10,10, 5,5,10,25,25,10,5,5, 0,0,0,20,20,0,0,0, 5,-5,-10,0,0,-10,-5,5, 5,10,10,-20,-20,10,10,5, 0,0,0,0,0,0,0,0],
  n: [-50,-40,-30,-30,-30,-30,-40,-50, -40,-20,0,0,0,0,-20,-40, -30,0,10,15,15,10,0,-30, -30,5,15,20,20,15,5,-30, -30,0,15,20,20,15,0,-30, -30,5,10,15,15,10,5,-30, -40,-20,0,5,5,0,-20,-40, -50,-40,-30,-30,-30,-30,-40,-50],
  b: [-20,-10,-10,-10,-10,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,10,10,5,0,-10, -10,5,5,10,10,5,5,-10, -10,0,10,10,10,10,0,-10, -10,10,10,10,10,10,10,-10, -10,5,0,0,0,0,5,-10, -20,-10,-10,-10,-10,-10,-10,-20],
  r: [0,0,0,0,0,0,0,0, 5,10,10,10,10,10,10,5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, 0,0,0,5,5,0,0,0],
  q: [-20,-10,-10,-5,-5,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,5,5,5,0,-10, -5,0,5,5,5,5,0,-5, 0,0,5,5,5,5,0,-5, -10,5,5,5,5,5,0,-10, -10,0,5,0,0,0,0,-10, -20,-10,-10,-5,-5,-10,-10,-20],
  k: [-30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -20,-30,-30,-40,-40,-30,-30,-20, -10,-20,-20,-20,-20,-20,-20,-10, 20,20,0,0,0,0,20,20, 20,30,10,0,0,10,30,20],
};

const MATE = 100_000;

/** Sırası gelen tarafın bakış açısından değerlendirme (centipawn). */
export function evaluate(pos: Position): number {
  let score = 0;
  for (let i = 0; i < 128; i++) {
    if (i & 0x88) {
      i += 7;
      continue;
    }
    const p = pos.board[i];
    if (!p) continue;
    const rank = i >> 4;
    const file = i & 7;
    const idx = p.color === 'w' ? (7 - rank) * 8 + file : rank * 8 + file;
    const v = VALUE[p.type] + (PST[p.type][idx] as number);
    score += p.color === 'w' ? v : -v;
  }
  return pos.turn === 'w' ? score : -score;
}

function orderKey(m: InternalMove): number {
  let k = 0;
  if (m.promotion) k += 800 + VALUE[m.promotion];
  if (m.captured) k += 10 * VALUE[m.captured] - VALUE[m.piece] + 1000;
  return -k;
}

function ordered(pos: Position): InternalMove[] {
  return legalMoves(pos).sort((a, b) => orderKey(a) - orderKey(b));
}

export class Search {
  nodes = 0;
  private deadline = Infinity;
  aborted = false;

  setDeadline(ms: number): void {
    this.deadline = ms;
  }

  private tick(): void {
    if ((++this.nodes & 1023) === 0 && Date.now() > this.deadline) this.aborted = true;
  }

  quiesce(pos: Position, alpha: number, beta: number, depth: number): number {
    this.tick();
    const stand = evaluate(pos);
    if (stand >= beta) return beta;
    if (alpha < stand) alpha = stand;
    if (depth <= 0 || this.aborted) return alpha;
    for (const m of ordered(pos)) {
      if (!m.captured && !m.promotion) continue;
      const score = -this.quiesce(applyMove(pos, m), -beta, -alpha, depth - 1);
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  negamax(pos: Position, depth: number, alpha: number, beta: number, ply: number): number {
    this.tick();
    if (this.aborted) return 0;
    const moves = ordered(pos);
    if (moves.length === 0) return inCheck(pos) ? -MATE + ply : 0;
    if (pos.halfmove >= 100) return 0;
    if (depth <= 0) return this.quiesce(pos, alpha, beta, 6);
    for (const m of moves) {
      const score = -this.negamax(applyMove(pos, m), depth - 1, -beta, -alpha, ply + 1);
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  /** Kök hamleleri ayrı ayrı puanlar (hata payıyla seçim için). */
  scoreRoot(pos: Position, depth: number): { move: InternalMove; score: number }[] {
    const out: { move: InternalMove; score: number }[] = [];
    for (const m of ordered(pos)) {
      const score = -this.negamax(applyMove(pos, m), depth - 1, -MATE - 1, MATE + 1, 1);
      if (this.aborted) break;
      out.push({ move: m, score });
    }
    return out;
  }
}

export function chooseMove(pos: Position, depth: number, noiseCp: number, movetimeMs: number): { move: InternalMove; score: number; nodes: number } | null {
  const moves = legalMoves(pos);
  if (!moves.length) return null;
  if (moves.length === 1) return { move: moves[0] as InternalMove, score: 0, nodes: 1 };
  const search = new Search();
  search.setDeadline(Date.now() + movetimeMs);
  let best: { move: InternalMove; score: number }[] = [];
  // Yinelemeli derinleştirme: süre biterse son tamamlanan derinlik kullanılır.
  for (let d = 1; d <= depth; d++) {
    const scored = search.scoreRoot(pos, d);
    if (search.aborted && best.length) break;
    if (scored.length) best = scored;
    if (search.aborted) break;
  }
  best.sort((a, b) => b.score - a.score);
  const top = best[0] as { move: InternalMove; score: number };
  const pool = noiseCp > 0 ? best.filter((x) => x.score >= top.score - noiseCp && Math.abs(top.score) < MATE - 1000) : best.filter((x) => x.score === top.score);
  const pick = pool.length ? (pool[randomInt(pool.length)] as { move: InternalMove; score: number }) : top;
  return { ...pick, nodes: search.nodes };
}

// ---- UCI döngüsü (yalnız doğrudan çalıştırıldığında) ------------------------

function main(): void {
  let pos = parseFen(START_FEN);
  let depth = 3;
  let noise = 0;
  const out = (s: string): void => {
    process.stdout.write(s + '\n');
  };
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const parts = line.trim().split(/\s+/);
    const cmd = parts[0];
    try {
      switch (cmd) {
        case 'uci':
          out('id name SatrancYerlesik 1.0');
          out('id author Satranc Platformu');
          out('option name BotDepth type spin default 3 min 1 max 6');
          out('option name BotNoise type spin default 0 min 0 max 1000');
          out('option name Skill Level type spin default 20 min 0 max 20');
          out('uciok');
          break;
        case 'isready':
          out('readyok');
          break;
        case 'ucinewgame':
          pos = parseFen(START_FEN);
          break;
        case 'setoption': {
          const nameIdx = parts.indexOf('name');
          const valueIdx = parts.indexOf('value');
          const name = parts.slice(nameIdx + 1, valueIdx).join(' ');
          const value = Number(parts.slice(valueIdx + 1).join(' '));
          if (name === 'BotDepth') depth = Math.max(1, Math.min(6, value));
          else if (name === 'BotNoise') noise = Math.max(0, value);
          else if (name === 'Skill Level') {
            depth = 1 + Math.round((value / 20) * 3);
            noise = Math.round((20 - value) * 15);
          }
          break;
        }
        case 'position': {
          const movesAt = parts.indexOf('moves');
          const head = movesAt >= 0 ? parts.slice(1, movesAt) : parts.slice(1);
          pos = parseFen(head[0] === 'startpos' ? START_FEN : head.slice(1).join(' '));
          if (movesAt >= 0) {
            for (const uci of parts.slice(movesAt + 1)) {
              const m = legalMoves(pos).find((x) => toUci(x) === uci);
              if (!m) throw new Error(`yasal olmayan hamle: ${uci}`);
              pos = applyMove(pos, m);
            }
          }
          break;
        }
        case 'go': {
          let d = depth;
          let movetime = 5_000;
          for (let i = 1; i < parts.length; i++) {
            if (parts[i] === 'depth') d = Number(parts[++i]);
            else if (parts[i] === 'movetime') movetime = Number(parts[++i]);
          }
          const r = chooseMove(pos, d, noise, movetime);
          if (!r) out('bestmove (none)');
          else {
            out(`info depth ${d} score cp ${r.score} nodes ${r.nodes}`);
            out(`bestmove ${toUci(r.move)}`);
          }
          break;
        }
        case 'stop':
          break;
        case 'quit':
          process.exit(0);
          break;
        default:
          break;
      }
    } catch (e) {
      out(`info string hata: ${e instanceof Error ? e.message : String(e)}`);
      if (cmd === 'go') out('bestmove (none)');
    }
  });
}

const invokedDirectly = process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
