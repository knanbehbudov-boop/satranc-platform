/**
 * Bağımlılıksız PostgreSQL istemcisi (protokol v3).
 *
 * Neden kendi istemcimiz: bu geliştirme ortamında npm deposu kapalı. Arayüz
 * `pg` paketine benzer tutuldu (query(text, params) → {rows, rowCount}); ileride
 * `pg`ye geçmek yalnızca bu dosyayı değiştirmeyi gerektirir.
 *
 * Desteklenenler: SCRAM-SHA-256 / MD5 / düz şifre kimlik doğrulama, parametreli
 * sorgu (genişletilmiş protokol, metin biçimi), işlem (transaction), bağlantı havuzu,
 * yaygın tiplerin dönüşümü. Kullanılmayanlar: COPY, LISTEN/NOTIFY, TLS.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { connect, type Socket } from 'node:net';

export interface QueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number;
  command: string;
}

export interface Queryable {
  query<R = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<R>>;
}

export class DbError extends Error {
  readonly code: string;
  readonly detail: string | undefined;
  readonly constraint: string | undefined;
  readonly severity: string | undefined;

  constructor(fields: Record<string, string>) {
    super(fields.M ?? 'Veritabanı hatası');
    this.name = 'DbError';
    this.code = fields.C ?? 'XX000';
    this.detail = fields.D;
    this.constraint = fields.n;
    this.severity = fields.S;
  }
}

export interface ConnectionConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export function parseDatabaseUrl(url: string): ConnectionConfig {
  const u = new URL(url);
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new Error(`Desteklenmeyen veritabanı adresi: ${u.protocol}`);
  return {
    host: u.hostname || '127.0.0.1',
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')) || decodeURIComponent(u.username),
  };
}

// ---- tip dönüşümleri --------------------------------------------------------

type Parser = (v: string) => unknown;

function parseArray(text: string, item: Parser): unknown[] {
  // Basit tek boyutlu dizi: {a,"b c",NULL}
  const out: unknown[] = [];
  if (text === '{}') return out;
  let i = 1;
  while (i < text.length - 1) {
    let value = '';
    let quoted = false;
    if (text[i] === '"') {
      quoted = true;
      i++;
      while (text[i] !== '"') {
        if (text[i] === '\\') i++;
        value += text[i];
        i++;
      }
      i++;
    } else {
      while (text[i] !== ',' && text[i] !== '}') value += text[i++];
    }
    out.push(!quoted && value === 'NULL' ? null : item(value));
    i++; // virgül
  }
  return out;
}

const int8: Parser = (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`int8 değeri güvenli tamsayı aralığında değil: ${v}`);
  return n;
};
const PARSERS: Record<number, Parser> = {
  16: (v) => v === 't',
  20: int8,
  21: Number,
  23: Number,
  700: Number,
  701: Number,
  1700: Number,
  114: (v) => JSON.parse(v),
  3802: (v) => JSON.parse(v),
  1114: (v) => new Date(`${v.replace(' ', 'T')}Z`),
  1184: (v) => new Date(v.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')),
  1000: (v) => parseArray(v, (x) => x === 't'),
  1005: (v) => parseArray(v, Number),
  1007: (v) => parseArray(v, Number),
  1016: (v) => parseArray(v, int8),
  1009: (v) => parseArray(v, (x) => x),
  1015: (v) => parseArray(v, (x) => x),
  2951: (v) => parseArray(v, (x) => x),
};

function serializeArrayItem(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  const s = String(v);
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function serializeParam(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'boolean') return v ? 't' : 'f';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (Buffer.isBuffer(v)) return `\\x${v.toString('hex')}`;
  if (Array.isArray(v)) return `{${v.map(serializeArrayItem).join(',')}}`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ---- mesaj yazımı -----------------------------------------------------------

function cstr(s: string): Buffer {
  return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
}

function message(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.write(type, 0, 'ascii');
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

function int16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
}

function int32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
}

// ---- SCRAM-SHA-256 ----------------------------------------------------------

class Scram {
  private readonly clientNonce = randomBytes(18).toString('base64');
  private clientFirstBare = '';
  private serverSignature: Buffer | null = null;
  private readonly password: string;

  constructor(password: string) {
    this.password = password;
  }

  first(): string {
    this.clientFirstBare = `n=*,r=${this.clientNonce}`;
    return `n,,${this.clientFirstBare}`;
  }

  final(serverFirst: string): string {
    const attrs = Object.fromEntries(serverFirst.split(',').map((p) => [p[0], p.slice(2)]));
    const nonce = attrs.r ?? '';
    if (!nonce.startsWith(this.clientNonce)) throw new Error('SCRAM: sunucu nonce değeri geçersiz');
    const salt = Buffer.from(attrs.s ?? '', 'base64');
    const iterations = Number(attrs.i);
    const salted = pbkdf2Sync(this.password, salt, iterations, 32, 'sha256');
    const clientKey = createHmac('sha256', salted).update('Client Key').digest();
    const storedKey = createHash('sha256').update(clientKey).digest();
    const withoutProof = `c=biws,r=${nonce}`;
    const authMessage = `${this.clientFirstBare},${serverFirst},${withoutProof}`;
    const clientSig = createHmac('sha256', storedKey).update(authMessage).digest();
    const proof = Buffer.alloc(clientKey.length);
    for (let i = 0; i < proof.length; i++) proof[i] = (clientKey[i] as number) ^ (clientSig[i] as number);
    const serverKey = createHmac('sha256', salted).update('Server Key').digest();
    this.serverSignature = createHmac('sha256', serverKey).update(authMessage).digest();
    return `${withoutProof},p=${proof.toString('base64')}`;
  }

  verify(serverFinal: string): void {
    const v = serverFinal.split(',').find((p) => p.startsWith('v='));
    const sig = Buffer.from((v ?? '').slice(2), 'base64');
    if (!this.serverSignature || sig.length !== this.serverSignature.length || !timingSafeEqual(sig, this.serverSignature)) {
      throw new Error('SCRAM: sunucu imzası doğrulanamadı');
    }
  }
}

// ---- bağlantı ---------------------------------------------------------------

interface Field {
  name: string;
  typeOid: number;
}

interface Pending {
  resolve: (r: QueryResult) => void;
  reject: (e: Error) => void;
  fields: Field[];
  rows: Record<string, unknown>[];
  command: string;
  rowCount: number;
  error: Error | null;
}

export class Connection implements Queryable {
  private socket: Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private readonly queue: Pending[] = [];
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;
  private scram: Scram | null = null;
  private closed = false;
  /** Bağlantı koptuğunda havuz bu bağlantıyı atar. */
  broken = false;
  private readonly cfg: ConnectionConfig;

  constructor(cfg: ConnectionConfig) {
    this.cfg = cfg;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      const socket = connect({ host: this.cfg.host, port: this.cfg.port });
      this.socket = socket;
      socket.setNoDelay(true);
      socket.on('connect', () => {
        const params = Buffer.concat([
          int32(196608),
          cstr('user'), cstr(this.cfg.user),
          cstr('database'), cstr(this.cfg.database),
          cstr('client_encoding'), cstr('UTF8'),
          cstr('TimeZone'), cstr('UTC'),
          cstr('application_name'), cstr('satranc-server'),
          Buffer.from([0]),
        ]);
        socket.write(Buffer.concat([int32(params.length + 4), params]));
      });
      socket.on('data', (chunk: Buffer) => this.onData(chunk));
      socket.on('error', (err) => this.fail(err));
      socket.on('close', () => this.fail(new Error('Veritabanı bağlantısı kapandı')));
    });
  }

  private fail(err: Error): void {
    this.broken = true;
    if (this.readyReject) {
      this.readyReject(err);
      this.readyReject = null;
      this.readyResolve = null;
    }
    while (this.queue.length) this.queue.shift()?.reject(err);
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 5) {
      const type = String.fromCharCode(this.buffer[0] as number);
      const len = this.buffer.readInt32BE(1);
      if (this.buffer.length < len + 1) return;
      const body = this.buffer.subarray(5, len + 1);
      this.buffer = this.buffer.subarray(len + 1);
      try {
        this.handle(type, body);
      } catch (e) {
        this.fail(e instanceof Error ? e : new Error(String(e)));
        this.socket?.destroy();
        return;
      }
    }
  }

  private handle(type: string, body: Buffer): void {
    switch (type) {
      case 'R': this.onAuth(body); break;
      case 'S': case 'K': case 'N': break; // parametre durumu, anahtar, bildirim
      case 'Z': {
        if (this.readyResolve) {
          this.readyResolve();
          this.readyResolve = null;
          this.readyReject = null;
          return;
        }
        const p = this.queue.shift();
        if (!p) return;
        if (p.error) p.reject(p.error);
        else p.resolve({ rows: p.rows, rowCount: p.rowCount, command: p.command });
        break;
      }
      case 'E': {
        const fields: Record<string, string> = {};
        let i = 0;
        while (i < body.length && body[i] !== 0) {
          const code = String.fromCharCode(body[i] as number);
          const end = body.indexOf(0, i + 1);
          fields[code] = body.toString('utf8', i + 1, end);
          i = end + 1;
        }
        const err = new DbError(fields);
        if (this.readyReject) {
          this.readyReject(err);
          this.readyReject = null;
          this.readyResolve = null;
          return;
        }
        const p = this.queue[0];
        if (p) p.error = err;
        break;
      }
      case 'T': {
        const p = this.queue[0];
        if (!p) return;
        const n = body.readInt16BE(0);
        let i = 2;
        p.fields = [];
        for (let k = 0; k < n; k++) {
          const end = body.indexOf(0, i);
          const name = body.toString('utf8', i, end);
          i = end + 1;
          const typeOid = body.readInt32BE(i + 6);
          i += 18;
          p.fields.push({ name, typeOid });
        }
        break;
      }
      case 'D': {
        const p = this.queue[0];
        if (!p) return;
        const n = body.readInt16BE(0);
        let i = 2;
        const row: Record<string, unknown> = {};
        for (let k = 0; k < n; k++) {
          const len = body.readInt32BE(i);
          i += 4;
          const f = p.fields[k] as Field;
          if (len === -1) {
            row[f.name] = null;
          } else {
            const text = body.toString('utf8', i, i + len);
            i += len;
            const parser = PARSERS[f.typeOid];
            row[f.name] = parser ? parser(text) : text;
          }
        }
        p.rows.push(row);
        break;
      }
      case 'C': {
        const p = this.queue[0];
        if (!p) return;
        const tag = body.toString('utf8', 0, body.length - 1);
        p.command = tag.split(' ')[0] ?? '';
        const last = Number(tag.split(' ').at(-1));
        p.rowCount = Number.isFinite(last) ? last : p.rows.length;
        break;
      }
      case '1': case '2': case 'n': case 'I': case 's': break;
      default: break;
    }
  }

  private onAuth(body: Buffer): void {
    const kind = body.readInt32BE(0);
    const socket = this.socket as Socket;
    if (kind === 0) return; // başarılı
    if (kind === 3) {
      socket.write(message('p', cstr(this.cfg.password)));
    } else if (kind === 5) {
      const salt = body.subarray(4, 8);
      const inner = createHash('md5').update(this.cfg.password + this.cfg.user).digest('hex');
      const outer = createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex');
      socket.write(message('p', cstr(`md5${outer}`)));
    } else if (kind === 10) {
      const mechanisms = body.toString('utf8', 4).split('\0');
      if (!mechanisms.includes('SCRAM-SHA-256')) throw new Error('Desteklenen SASL mekanizması yok');
      this.scram = new Scram(this.cfg.password);
      const first = Buffer.from(this.scram.first());
      socket.write(message('p', Buffer.concat([cstr('SCRAM-SHA-256'), int32(first.length), first])));
    } else if (kind === 11) {
      const serverFirst = body.toString('utf8', 4);
      socket.write(message('p', Buffer.from((this.scram as Scram).final(serverFirst))));
    } else if (kind === 12) {
      (this.scram as Scram).verify(body.toString('utf8', 4));
    } else {
      throw new Error(`Desteklenmeyen kimlik doğrulama türü: ${kind}`);
    }
  }

  query<R = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
    if (this.closed || this.broken || !this.socket) return Promise.reject(new Error('Bağlantı kullanılamaz'));
    return new Promise((resolve, reject) => {
      this.queue.push({
        resolve: resolve as (r: QueryResult) => void,
        reject,
        fields: [],
        rows: [],
        command: '',
        rowCount: 0,
        error: null,
      });
      const values = params.map(serializeParam);
      const parse = message('P', Buffer.concat([cstr(''), cstr(text), int16(0)]));
      const bindParts: Buffer[] = [cstr(''), cstr(''), int16(0), int16(values.length)];
      for (const v of values) {
        if (v === null) bindParts.push(int32(-1));
        else {
          const b = Buffer.from(v, 'utf8');
          bindParts.push(int32(b.length), b);
        }
      }
      bindParts.push(int16(0));
      const bind = message('B', Buffer.concat(bindParts));
      const describe = message('D', Buffer.concat([Buffer.from('P'), cstr('')]));
      const execute = message('E', Buffer.concat([cstr(''), int32(0)]));
      const sync = message('S', Buffer.alloc(0));
      (this.socket as Socket).write(Buffer.concat([parse, bind, describe, execute, sync]));
    });
  }

  /** Parametresiz, çok komutlu metin (migrasyonlar için). */
  simpleQuery(text: string): Promise<QueryResult> {
    if (this.closed || this.broken || !this.socket) return Promise.reject(new Error('Bağlantı kullanılamaz'));
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject, fields: [], rows: [], command: '', rowCount: 0, error: null });
      (this.socket as Socket).write(message('Q', cstr(text)));
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.socket && !this.broken) {
      this.socket.end(message('X', Buffer.alloc(0)));
    }
    this.socket?.destroy();
  }
}

// ---- havuz ------------------------------------------------------------------

export interface PoolOptions {
  max?: number;
  /** Bir bağlantıyı beklemenin üst sınırı (ms). */
  acquireTimeoutMs?: number;
}

export class Pool implements Queryable {
  private readonly idle: Connection[] = [];
  private readonly waiters: { resolve: (c: Connection) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  private total = 0;
  private ended = false;
  private readonly max: number;
  private readonly acquireTimeoutMs: number;
  private readonly cfg: ConnectionConfig;

  constructor(cfg: ConnectionConfig, opts: PoolOptions = {}) {
    this.cfg = cfg;
    this.max = opts.max ?? 10;
    this.acquireTimeoutMs = opts.acquireTimeoutMs ?? 10_000;
  }

  static fromUrl(url: string, opts?: PoolOptions): Pool {
    return new Pool(parseDatabaseUrl(url), opts);
  }

  get stats(): { total: number; idle: number; waiting: number } {
    return { total: this.total, idle: this.idle.length, waiting: this.waiters.length };
  }

  async acquire(): Promise<Connection> {
    if (this.ended) throw new Error('Havuz kapatıldı');
    while (this.idle.length) {
      const c = this.idle.pop() as Connection;
      if (!c.broken) return c;
      this.total--;
    }
    if (this.total < this.max) {
      this.total++;
      const c = new Connection(this.cfg);
      try {
        await c.connect();
        return c;
      } catch (e) {
        this.total--;
        throw e;
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.timer === timer);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('Veritabanı bağlantısı beklenirken zaman aşımı'));
      }, this.acquireTimeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  release(c: Connection): void {
    if (c.broken || this.ended) {
      this.total--;
      void c.close();
      // Bekleyen varsa yeni bağlantı açması için tetikle.
      const w = this.waiters.shift();
      if (w) {
        clearTimeout(w.timer);
        this.acquire().then(w.resolve, w.reject);
      }
      return;
    }
    const w = this.waiters.shift();
    if (w) {
      clearTimeout(w.timer);
      w.resolve(c);
    } else {
      this.idle.push(c);
    }
  }

  async query<R = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<R>> {
    const c = await this.acquire();
    try {
      return await c.query<R>(text, params);
    } finally {
      this.release(c);
    }
  }

  /**
   * İşlem: fn başarılıysa COMMIT, hata fırlatırsa ROLLBACK. Para ve turnuva durum
   * geçişleri yalnızca bunun içinde yapılır (plan, M5 5a ve M8).
   */
  async tx<T>(fn: (q: Connection) => Promise<T>): Promise<T> {
    const c = await this.acquire();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      if (!c.broken) {
        try {
          await c.query('ROLLBACK');
        } catch {
          c.broken = true;
        }
      }
      throw e;
    } finally {
      this.release(c);
    }
  }

  async end(): Promise<void> {
    this.ended = true;
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error('Havuz kapatıldı'));
    }
    await Promise.all(this.idle.splice(0).map((c) => c.close()));
    this.total = 0;
  }
}
