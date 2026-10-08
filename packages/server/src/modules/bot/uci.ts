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
