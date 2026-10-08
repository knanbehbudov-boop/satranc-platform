/**
 * Bağımlılıksız WebSocket sunucusu (RFC 6455): yalnız metin (JSON) mesajları,
 * parçalı mesaj birleştirme, ping/pong ile canlılık kontrolü, boyut sınırı.
 * Tarayıcının yerleşik WebSocket istemcisiyle ve Node 22'nin `WebSocket`iyle uyumlu.
 */
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Logger } from '../log.ts';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface WsServerOptions {
  logger: Logger;
  maxPayloadBytes?: number;
  pingIntervalMs?: number;
  /** Boş değilse yalnız bu Origin'lerden gelen bağlantılar kabul edilir (CSWSH koruması). */
  allowedOrigins?: string[];
}

export class WsConnection extends EventEmitter {
  readonly id = randomUUID();
  readonly ip: string;
  /** Uygulamanın bağlantıya iliştirdiği veri (kimlik, abonelikler). */
  data: Record<string, unknown> = {};
  /** Ölçülen gidiş-dönüş süresi (ms), üstel ortalama. Gecikme telafisinde kullanılır. */
  rttMs: number | null = null;
  private alive = true;
  private closed = false;
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private readonly socket: Duplex;
  private readonly maxPayload: number;
  private lastPingAt = 0;

  constructor(socket: Duplex, ip: string, maxPayload: number) {
    super();
    this.socket = socket;
    this.ip = ip;
    this.maxPayload = maxPayload;
    socket.on('data', (c: Buffer) => this.onData(c));
    socket.on('close', () => this.finish(1006, 'bağlantı koptu'));
    socket.on('error', () => this.finish(1006, 'soket hatası'));
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  send(message: unknown): void {
    if (this.closed) return;
    this.writeFrame(0x1, Buffer.from(JSON.stringify(message), 'utf8'));
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this.writeFrame(0x8, body);
    this.socket.end();
    this.finish(code, reason);
  }

  /** Kalp atışı: önceki ping yanıtsızsa bağlantıyı düşürür. */
  heartbeat(): void {
    if (this.closed) return;
    if (!this.alive) {
      this.socket.destroy();
      this.finish(1006, 'ping yanıtsız');
      return;
    }
    this.alive = false;
    this.lastPingAt = performance.now();
    this.writeFrame(0x9, Buffer.alloc(0));
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code, reason);
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    const len = payload.length;
    let head: Buffer;
    if (len < 126) {
      head = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | opcode;
      head[1] = 126;
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | opcode;
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([head, payload]));
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0] as number;
      const b1 = this.buffer[1] as number;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) return this.close(1009, 'mesaj çok büyük');
        len = Number(big);
        offset = 10;
      }
      if (!masked) return this.close(1002, 'istemci çerçevesi maskesiz');
      if (len > this.maxPayload) return this.close(1009, 'mesaj çok büyük');
      if (this.buffer.length < offset + 4 + len) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] as number) ^ (mask[i & 3] as number);
      this.buffer = this.buffer.subarray(offset + 4 + len);

      switch (opcode) {
        case 0x0: // devam çerçevesi
        case 0x1:
        case 0x2: {
          if (opcode !== 0) {
            this.fragmentOpcode = opcode;
            this.fragments = [];
          }
          this.fragments.push(payload);
          const total = this.fragments.reduce((n, b) => n + b.length, 0);
          if (total > this.maxPayload) return this.close(1009, 'mesaj çok büyük');
          if (fin) {
            const data = Buffer.concat(this.fragments);
            this.fragments = [];
            if (this.fragmentOpcode === 0x2) return this.close(1003, 'ikili mesaj desteklenmiyor');
            let parsed: unknown;
            try {
              parsed = JSON.parse(data.toString('utf8'));
            } catch {
              this.send({ type: 'error', code: 'INVALID_JSON', message: 'Mesaj JSON olmalı' });
              break;
            }
            this.emit('message', parsed);
          }
          break;
        }
        case 0x8:
          this.close(1000, '');
          return;
        case 0x9:
          this.writeFrame(0xa, payload);
          break;
        case 0xa: {
          this.alive = true;
          if (this.lastPingAt) {
            const rtt = performance.now() - this.lastPingAt;
            this.rttMs = this.rttMs === null ? rtt : this.rttMs * 0.7 + rtt * 0.3;
          }
          break;
        }
        default:
          return this.close(1002, 'bilinmeyen işlem kodu');
      }
    }
  }
}

export class WsServer {
  private readonly conns = new Set<WsConnection>();
  private readonly timer: NodeJS.Timeout;
  private readonly opts: Required<Omit<WsServerOptions, 'allowedOrigins'>> & { allowedOrigins: string[] };

  constructor(opts: WsServerOptions) {
    this.opts = {
      logger: opts.logger,
      maxPayloadBytes: opts.maxPayloadBytes ?? 16 * 1024,
      pingIntervalMs: opts.pingIntervalMs ?? 15_000,
      allowedOrigins: opts.allowedOrigins ?? [],
    };
    this.timer = setInterval(() => {
      for (const c of this.conns) c.heartbeat();
    }, this.opts.pingIntervalMs);
    this.timer.unref();
  }

  get size(): number {
    return this.conns.size;
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, ip: string, onConnection: (c: WsConnection) => void): void {
    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    const upgrade = (req.headers.upgrade ?? '').toLowerCase();
    const origin = req.headers.origin;
    const reject = (status: number, text: string): void => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (upgrade !== 'websocket' || typeof key !== 'string' || version !== '13') return reject(400, 'Bad Request');
    if (origin && this.opts.allowedOrigins.length && !this.opts.allowedOrigins.includes(origin)) return reject(403, 'Forbidden');
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const conn = new WsConnection(socket, ip, this.opts.maxPayloadBytes);
    this.conns.add(conn);
    conn.on('close', () => this.conns.delete(conn));
    onConnection(conn);
    // İlk RTT ölçümü hemen yapılsın.
    conn.heartbeat();
  }

  closeAll(code = 1001, reason = 'sunucu kapanıyor'): void {
    clearInterval(this.timer);
    for (const c of this.conns) c.close(code, reason);
  }
}
