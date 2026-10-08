/**
 * Entegrasyon testi yardımcıları: her test dosyası kendi geçici veritabanını
 * oluşturur, sunucuyu rastgele portta başlatır ve sonunda her şeyi siler.
 * Gerekli: `node scripts/dev-db.mjs start` ile çalışan yerel PostgreSQL
 * (ya da TEST_DATABASE_ADMIN_URL).
 */
process.env.SCRYPT_N ??= '1024'; // testlerde hızlı şifre özeti

import { randomBytes } from 'node:crypto';
import { Pool } from '../src/infra/db/pg.ts';
import { silentLogger } from '../src/infra/log.ts';
import type { App } from '../src/app.ts';
import type { Config } from '../src/config.ts';

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://satranc:satranc-dev@127.0.0.1:54329/postgres';

export interface TestEnv {
  app: App;
  base: string;
  dbUrl: string;
  close(): Promise<void>;
  /** Sunucuyu kapatıp aynı veritabanıyla yeniden başlatır (kurtarma testleri). */
  restart(overrides?: Partial<Config>, downMs?: number): Promise<void>;
}

export async function startTestApp(overrides: Partial<Config> = {}): Promise<TestEnv> {
  const { createApp } = await import('../src/app.ts');
  const { loadConfig } = await import('../src/config.ts');
  const dbName = `satranc_t_${randomBytes(5).toString('hex')}`;
  const admin = Pool.fromUrl(ADMIN_URL, { max: 1 });
  await admin.query(`CREATE DATABASE ${dbName}`);
  const dbUrl = ADMIN_URL.replace(/\/[^/]*$/, `/${dbName}`);
  const cfg = loadConfig({
    env: 'test',
    port: 0,
    databaseUrl: dbUrl,
    devMailbox: true,
    antiMultiAccount: false,
    registrationsPerHourPerIp: 100_000,
    stockfishPath: null,
    serveWeb: true,
    ...overrides,
  });
  const env: TestEnv = {
    app: await createApp(cfg, { logger: process.env.TEST_LOG ? undefined : silentLogger }),
    base: '',
    dbUrl,
    async close() {
      await env.app.stop();
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.end();
    },
    async restart(o: Partial<Config> = {}, downMs = 0) {
      await env.app.stop();
      if (downMs) await sleep(downMs);
      // Aynı portta yeniden aç: istemciler aynı adrese yeniden bağlanabilsin.
      env.app = await createApp({ ...cfg, port: env.app.port, ...o }, { logger: process.env.TEST_LOG ? undefined : silentLogger });
      await env.app.start();
      env.base = `http://127.0.0.1:${env.app.port}`;
    },
  };
  await env.app.start();
  env.base = `http://127.0.0.1:${env.app.port}`;
  return env;
}

// ---- HTTP istemcisi -----------------------------------------------------------

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export class Client {
  readonly base: string;
  token: string | null = null;
  cookies = new Map<string, string>();
  deviceId = randomBytes(8).toString('hex');

  constructor(base: string) {
    this.base = base;
  }

  async req<T = any>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { 'x-device-id': this.deviceId, ...extraHeaders };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const [k, v] = (pair as string).split('=') as [string, string];
      if (attrs.some((a) => a.trim().toLowerCase() === 'max-age=0')) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  }

  get<T = any>(p: string) { return this.req<T>('GET', p); }
  post<T = any>(p: string, b: unknown = {}) { return this.req<T>('POST', p, b); }
  del<T = any>(p: string) { return this.req<T>('DELETE', p); }
}

let counter = 0;
export function uniqueName(prefix = 'oyuncu'): string {
  counter++;
  return `${prefix}${counter}${randomBytes(2).toString('hex')}`;
}

export const STRONG_PASSWORD = 'Kale-Fil-At-2026!';

/** Kayıt + e-posta doğrulama + giriş. */
export async function newPlayer(base: string, name = uniqueName()): Promise<{ client: Client; id: string; name: string; email: string }> {
  const client = new Client(base);
  const email = `${name}@ornek.test`;
  const reg = await client.post('/v1/auth/register', {
    email,
    password: STRONG_PASSWORD,
    displayName: name,
    birthDate: '1990-05-17',
    countryCode: 'GB',
    acceptTos: true,
  });
  if (reg.status !== 201) throw new Error(`kayıt başarısız: ${JSON.stringify(reg.body)}`);
  const mail = await client.get(`/v1/dev/mailbox?email=${encodeURIComponent(email)}`);
  await client.post('/v1/auth/verify-email', { token: mail.body.messages[0].token });
  const login = await client.post('/v1/auth/login', { email, password: STRONG_PASSWORD });
  if (login.status !== 200) throw new Error(`giriş başarısız: ${JSON.stringify(login.body)}`);
  client.token = login.body.accessToken;
  return { client, id: login.body.user.id, name, email };
}

// ---- WebSocket istemcisi ------------------------------------------------------

export class WsClient {
  readonly ws: WebSocket;
  readonly messages: any[] = [];
  private waiters: { pred: (m: any) => boolean; resolve: (m: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      this.messages.push(m);
      for (const w of [...this.waiters]) {
        if (w.pred(m)) {
          clearTimeout(w.timer);
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    });
    ws.addEventListener('close', () => {
      this.closed = true;
    });
  }

  static async open(base: string, token?: string | null): Promise<WsClient> {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + '/v1/ws');
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('WebSocket açılamadı')), { once: true });
    });
    const c = new WsClient(ws);
    if (token) {
      c.send({ type: 'auth', token });
      await c.next((m) => m.type === 'auth.ok' || m.type === 'auth.error');
    }
    return c;
  }

  send(m: unknown): void {
    this.ws.send(JSON.stringify(m));
  }

  /** Daha önce gelmiş ya da gelecek ilk eşleşen mesaj. */
  next(pred: (m: any) => boolean, timeoutMs = 5000, fromIndex = 0): Promise<any> {
    const existing = this.messages.slice(fromIndex).find(pred);
    if (existing) return Promise.resolve(existing);
    return this.wait(pred, timeoutMs);
  }

  /** Yalnızca bundan sonra gelecek ilk eşleşen mesaj. */
  wait(pred: (m: any) => boolean, timeoutMs = 5000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`Beklenen WebSocket mesajı gelmedi (${timeoutMs} ms). Son mesajlar: ${JSON.stringify(this.messages.slice(-5))}`));
      }, timeoutMs);
      this.waiters.push({ pred, resolve, reject, timer });
    });
  }

  close(): void {
    this.ws.close();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
