/**
 * Küçük HTTP yönlendirici (node:http üzerinde). Her rota bir işleyici alır;
 * işleyici veri döndürür ya da AppError fırlatır. Hata biçimi her yerde aynıdır.
 */
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { AppError, tooMany, unauthorized } from '../errors.ts';
import type { Logger } from '../log.ts';
import { RateLimiter, type RateRule } from './ratelimit.ts';

export interface AuthUser {
  id: string;
  roles: string[];
  sessionId: string;
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  ip: string;
  /** İstemcinin localStorage'da tuttuğu cihaz anahtarı (X-Device-Id). */
  deviceKey: string | null;
  userAgent: string;
  traceId: string;
  user: AuthUser | null;
  cookies: Record<string, string>;
  requireUser(): AuthUser;
  setCookie(name: string, value: string, opts: CookieOptions): void;
  clearCookie(name: string, path: string): void;
  limit(key: string, rule: RateRule): void;
  status: number;
  headers: Record<string, string>;
}

export interface CookieOptions {
  maxAgeSec: number;
  path: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax';
}

export type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

export interface RouterOptions {
  logger: Logger;
  authenticate: (token: string) => AuthUser | null;
  staticDir?: string | null;
  secureCookies: boolean;
  limiter?: RateLimiter;
  maxBodyBytes?: number;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

export function securityHeaders(res: ServerResponse, secure: boolean): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function clientIp(req: IncomingMessage): string {
  // Ters vekil arkasında X-Forwarded-For'un ilk değeri; vekil yapılandırması TRUST_PROXY ile açılır.
  if (process.env.TRUST_PROXY === '1') {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) return (xff.split(',')[0] as string).trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export class Router {
  private readonly routes: Route[] = [];
  private readonly opts: RouterOptions;
  private readonly limiter: RateLimiter;

  constructor(opts: RouterOptions) {
    this.opts = opts;
    this.limiter = opts.limiter ?? new RateLimiter();
  }

  add(method: string, path: string, handler: Handler): this {
    this.routes.push({ method, parts: path.split('/').filter(Boolean), handler });
    return this;
  }
  get(p: string, h: Handler): this { return this.add('GET', p, h); }
  post(p: string, h: Handler): this { return this.add('POST', p, h); }
  delete(p: string, h: Handler): this { return this.add('DELETE', p, h); }

  private match(method: string, path: string): { route: Route; params: Record<string, string> } | 'method' | null {
    const parts = path.split('/').filter(Boolean);
    let methodMismatch = false;
    for (const route of this.routes) {
      if (route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const rp = route.parts[i] as string;
        const pp = parts[i] as string;
        if (rp.startsWith(':')) params[rp.slice(1)] = decodeURIComponent(pp);
        else if (rp !== pp) { ok = false; break; }
      }
      if (!ok) continue;
      if (route.method !== method) { methodMismatch = true; continue; }
      return { route, params };
    }
    return methodMismatch ? 'method' : null;
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    if (req.method === 'GET' || req.method === 'HEAD') return undefined;
    const max = this.opts.maxBodyBytes ?? 64 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > max) throw new AppError(413, 'BODY_TOO_LARGE', 'İstek gövdesi çok büyük');
      chunks.push(chunk as Buffer);
    }
    if (!size) return {};
    const ct = req.headers['content-type'] ?? '';
    if (!ct.includes('application/json')) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'İçerik türü application/json olmalı');
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new AppError(400, 'INVALID_JSON', 'Geçersiz JSON');
    }
  }

  private serveStatic(req: IncomingMessage, res: ServerResponse, path: string): boolean {
    const dir = this.opts.staticDir;
    if (!dir || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
    const rel = path === '/' ? '/index.html' : path;
    const file = normalize(join(dir, rel));
    if (!file.startsWith(normalize(dir) + sep) || !existsSync(file) || !statSync(file).isFile()) return false;
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', extname(file) === '.html' ? 'no-cache' : 'public, max-age=300');
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
    return true;
  }

  handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = performance.now();
    const traceId = (req.headers['x-trace-id'] as string | undefined)?.slice(0, 64) || randomUUID();
    res.setHeader('X-Trace-Id', traceId);
    securityHeaders(res, this.opts.secureCookies);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const ip = clientIp(req);
    let status = 500;
    try {
      const m = this.match(req.method ?? 'GET', path);
      if (m === null) {
        if (!path.startsWith('/v1/') && this.serveStatic(req, res, path)) {
          status = 200;
          return;
        }
        throw new AppError(404, 'NOT_FOUND', 'Bulunamadı');
      }
      if (m === 'method') throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Yöntem desteklenmiyor');

      const cookies = parseCookies(req.headers.cookie);
      const authz = req.headers.authorization;
      const user = authz?.startsWith('Bearer ') ? this.opts.authenticate(authz.slice(7)) : null;
      const setCookies: string[] = [];
      const ctx: Ctx = {
        req,
        res,
        params: m.params,
        query: url.searchParams,
        body: await this.readBody(req),
        ip,
        deviceKey: ((req.headers['x-device-id'] as string | undefined) ?? '').slice(0, 64) || null,
        userAgent: ((req.headers['user-agent'] as string | undefined) ?? '').slice(0, 300),
        traceId,
        user,
        cookies,
        status: 200,
        headers: {},
        requireUser: () => {
          if (!user) throw unauthorized();
          return user;
        },
        setCookie: (name, value, o) => {
          const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${o.path}`, `Max-Age=${o.maxAgeSec}`, `SameSite=${o.sameSite ?? 'Strict'}`];
          if (o.httpOnly !== false) parts.push('HttpOnly');
          if (o.secure ?? this.opts.secureCookies) parts.push('Secure');
          setCookies.push(parts.join('; '));
        },
        clearCookie: (name, p) => setCookies.push(`${name}=; Path=${p}; Max-Age=0; SameSite=Strict; HttpOnly`),
        limit: (key, rule) => {
          const wait = this.limiter.take(key, rule);
          if (wait > 0) {
            res.setHeader('Retry-After', String(wait));
            throw tooMany(wait);
          }
        },
      };
      const data = await m.route.handler(ctx);
      if (setCookies.length) res.setHeader('Set-Cookie', setCookies);
      for (const [k, v] of Object.entries(ctx.headers)) res.setHeader(k, v);
      status = data === undefined ? 204 : ctx.status;
      res.statusCode = status;
      res.setHeader('Cache-Control', 'no-store');
      if (status === 204) res.end();
      else {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(data));
      }
    } catch (e) {
      const err = e instanceof AppError ? e : null;
      status = err?.status ?? 500;
      if (!err) this.opts.logger.error('İşlenmeyen hata', { traceId, path, error: e, stack: e instanceof Error ? e.stack : undefined });
      if (!res.headersSent) {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(err ? err.toJSON() : { code: 'INTERNAL', message: 'Beklenmeyen bir hata oluştu', details: { traceId } }));
      }
    } finally {
      this.opts.logger.debug('istek', { method: req.method, path, status, ms: Math.round(performance.now() - started), traceId });
    }
  };
}
