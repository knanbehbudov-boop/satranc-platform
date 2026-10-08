/**
 * UCI sürücüsü (doküman 12.2, 12.5): Stockfish ya da yerleşik motor gibi UCI
 * konuşan her programı ayrı süreçte çalıştırır. Süreç çökerse bekleyen istek
 * hata ile döner ve havuz yeni süreç açar. Motor ağ erişimi olmayan, kaynak
 * sınırlı konteynerde çalıştırılmalıdır (dağıtım notu, README).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface EngineCommand {
  command: string;
  args: string[];
}

export interface AnalysisLine {
  rank: number;
  move: string;
  /** Sırası gelen tarafın bakışından centipawn (mat: ±(10000 − 10·mesafe)). */
  cp: number;
  mate: number | null;
}

export interface GoOptions {
  depth?: number;
  movetimeMs?: number;
}

export class UciEngine {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private lineWaiters: { pred: (l: string) => boolean; resolve: (l: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private readonly cmd: EngineCommand;
  name = '';
  dead = false;
  private appliedOptions = '';

  constructor(cmd: EngineCommand) {
    this.cmd = cmd;
  }

  async start(timeoutMs = 10_000): Promise<void> {
    const p = spawn(this.cmd.command, this.cmd.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = p;
    p.on('exit', () => this.die(new Error('Motor süreci kapandı')));
    p.on('error', (e) => this.die(e));
    createInterface({ input: p.stdout }).on('line', (line) => {
      if (line.startsWith('id name ')) this.name = line.slice(8);
      for (const w of [...this.lineWaiters]) {
        if (w.pred(line)) {
          clearTimeout(w.timer);
          this.lineWaiters.splice(this.lineWaiters.indexOf(w), 1);
          w.resolve(line);
        }
      }
    });
    p.stderr.resume();
    this.send('uci');
    await this.waitLine((l) => l === 'uciok', timeoutMs);
    this.send('isready');
    await this.waitLine((l) => l === 'readyok', timeoutMs);
  }

  private die(e: Error): void {
    if (this.dead) return;
    this.dead = true;
    for (const w of this.lineWaiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(e);
    }
  }

  private send(line: string): void {
    if (this.dead || !this.proc) throw new Error('Motor çalışmıyor');
    this.proc.stdin.write(line + '\n');
  }

  private waitLine(pred: (l: string) => boolean, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(new Error('Motor çalışmıyor'));
      const timer = setTimeout(() => {
        this.lineWaiters = this.lineWaiters.filter((w) => w.timer !== timer);
        reject(new Error('Motor yanıt vermedi (zaman aşımı)'));
      }, timeoutMs);
      this.lineWaiters.push({ pred, resolve, reject, timer });
    });
  }

  /** Pozisyon için en iyi hamle (UCI). İstekler sırayla işlenir. */
  bestMove(fen: string, options: Record<string, string>, go: GoOptions): Promise<string | null> {
    const run = async (): Promise<string | null> => {
      const key = JSON.stringify(options);
      if (key !== this.appliedOptions) {
        for (const [name, value] of Object.entries(options)) this.send(`setoption name ${name} value ${value}`);
        this.appliedOptions = key;
      }
      this.send('ucinewgame');
      this.send(`position fen ${fen}`);
      this.send('isready');
      await this.waitLine((l) => l === 'readyok', 5_000);
      const parts = ['go'];
      if (go.depth) parts.push('depth', String(go.depth));
      if (go.movetimeMs) parts.push('movetime', String(go.movetimeMs));
      this.send(parts.join(' '));
      const line = await this.waitLine((l) => l.startsWith('bestmove'), (go.movetimeMs ?? 5_000) + 5_000);
      const mv = line.split(/\s+/)[1];
      return mv && mv !== '(none)' ? mv : null;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /**
   * Analiz (doküman 12.4): MultiPV ile en iyi N hamle ve puanları; `searchmoves` verilirse
   * yalnız o hamleler. Puanlar sırası gelen tarafın bakışından, mat ±(10000 − mesafe) olarak.
   * Stockfish ara derinlik satırları da yazar; her multipv için en derin son satır alınır.
   */
  analyse(fen: string, opts: { multiPv: number; depth?: number; movetimeMs?: number; searchmoves?: string[] }): Promise<AnalysisLine[]> {
    const run = async (): Promise<AnalysisLine[]> => {
      const key = JSON.stringify({ MultiPV: String(opts.multiPv) });
      if (key !== this.appliedOptions) {
        this.send(`setoption name MultiPV value ${opts.multiPv}`);
        this.appliedOptions = key;
      }
      this.send(`position fen ${fen}`);
      this.send('isready');
      await this.waitLine((l) => l === 'readyok', 5_000);
      const lines = new Map<number, AnalysisLine & { depth: number }>();
      const collect = (l: string): boolean => {
        if (l.startsWith('info ') && l.includes(' pv ') && l.includes(' score ')) {
          const t = l.split(/\s+/);
          const depth = Number(t[t.indexOf('depth') + 1]);
          const mpIdx = t.indexOf('multipv');
          const k = mpIdx >= 0 ? Number(t[mpIdx + 1]) : 1;
          const sIdx = t.indexOf('score');
          const kind = t[sIdx + 1];
          const val = Number(t[sIdx + 2]);
          if (t.includes('lowerbound') || t.includes('upperbound')) return false;
          const cp = kind === 'mate' ? Math.sign(val || -1) * (10_000 - Math.abs(val) * 10) : val;
          const move = t[t.indexOf('pv') + 1] as string;
          const prev = lines.get(k);
          if (!prev || depth >= prev.depth) lines.set(k, { rank: k, move, cp, mate: kind === 'mate' ? val : null, depth });
          return false;
        }
        return l.startsWith('bestmove');
      };
      const parts = ['go'];
      if (opts.depth) parts.push('depth', String(opts.depth));
      if (opts.movetimeMs) parts.push('movetime', String(opts.movetimeMs));
      if (opts.searchmoves?.length) parts.push('searchmoves', ...opts.searchmoves);
      this.send(parts.join(' '));
      await this.waitLine(collect, (opts.movetimeMs ?? 30_000) + 10_000);
      return [...lines.values()].sort((a, b) => a.rank - b.rank).map(({ depth: _d, ...x }) => x);
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  quit(): void {
    if (this.proc && !this.dead) {
      try {
        this.send('quit');
      } catch {
        /* zaten kapalı */
      }
      this.proc.kill();
    }
    this.die(new Error('Motor kapatıldı'));
  }
}

/** Sabit boyutlu motor havuzu; ölen motor yerine yenisi açılır. */
export class EnginePool {
  private readonly engines: UciEngine[] = [];
  private next = 0;
  private readonly cmd: EngineCommand;
  private readonly size: number;

  constructor(cmd: EngineCommand, size = 2) {
    this.cmd = cmd;
    this.size = size;
  }

  async get(): Promise<UciEngine> {
    for (let i = 0; i < this.engines.length; i++) {
      if (this.engines[i]?.dead) this.engines.splice(i--, 1);
    }
    if (this.engines.length < this.size) {
      const e = new UciEngine(this.cmd);
      await e.start();
      this.engines.push(e);
      return e;
    }
    const e = this.engines[this.next++ % this.engines.length] as UciEngine;
    return e;
  }

  close(): void {
    for (const e of this.engines.splice(0)) e.quit();
  }
}
