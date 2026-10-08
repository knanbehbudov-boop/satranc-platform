/**
 * WebSocket merkezi: bağlantı kimliği, mesaj yönlendirme, konu abonelikleri.
 *
 * Kimlik: bağlantıdan sonraki ilk mesaj {type:'auth', token} olabilir (token URL'de
 * taşınmaz, loglara düşmez). Kimliksiz bağlantı yalnız izleyici olabilir.
 */
import type { Logger } from '../log.ts';
import type { AuthUser } from '../http/router.ts';
import type { WsConnection } from './server.ts';

export interface WsMessage {
  type: string;
  [k: string]: unknown;
}

export type WsHandler = (conn: WsConnection, msg: WsMessage, user: AuthUser | null) => unknown | Promise<unknown>;

export interface HubOptions {
  logger: Logger;
  authenticate: (token: string) => AuthUser | null;
  sessionActive: (sessionId: string) => Promise<boolean>;
}

const MAX_MESSAGES_PER_10S = 120;

export class WsHub {
  private readonly handlers = new Map<string, WsHandler>();
  private readonly topics = new Map<string, Set<WsConnection>>();
  private readonly byUser = new Map<string, Set<WsConnection>>();
  private readonly opts: HubOptions;
  private readonly disconnectListeners: ((conn: WsConnection, user: AuthUser | null) => void)[] = [];
  private readonly authListeners: ((conn: WsConnection, user: AuthUser) => void)[] = [];

  constructor(opts: HubOptions) {
    this.opts = opts;
  }

  on(type: string, handler: WsHandler): void {
    this.handlers.set(type, handler);
  }

  onDisconnect(fn: (conn: WsConnection, user: AuthUser | null) => void): void {
    this.disconnectListeners.push(fn);
  }

  onAuthenticated(fn: (conn: WsConnection, user: AuthUser) => void): void {
    this.authListeners.push(fn);
  }

  userOf(conn: WsConnection): AuthUser | null {
    return (conn.data.user as AuthUser | undefined) ?? null;
  }

  isUserOnline(userId: string): boolean {
    return (this.byUser.get(userId)?.size ?? 0) > 0;
  }

  connectionsOf(userId: string): WsConnection[] {
    return [...(this.byUser.get(userId) ?? [])];
  }

  accept = (conn: WsConnection): void => {
    let windowStart = Date.now();
    let count = 0;
    conn.on('message', (raw: unknown) => {
      const now = Date.now();
      if (now - windowStart > 10_000) {
        windowStart = now;
        count = 0;
      }
      if (++count > MAX_MESSAGES_PER_10S) {
        conn.send({ type: 'error', code: 'RATE_LIMITED', message: 'Çok fazla mesaj' });
        if (count > MAX_MESSAGES_PER_10S * 2) conn.close(1008, 'hız sınırı');
        return;
      }
      void this.dispatch(conn, raw);
    });
    conn.on('close', () => {
      for (const set of this.topics.values()) set.delete(conn);
      const user = this.userOf(conn);
      if (user) {
        const set = this.byUser.get(user.id);
        set?.delete(conn);
        if (set && !set.size) this.byUser.delete(user.id);
      }
      for (const fn of this.disconnectListeners) fn(conn, user);
    });
    conn.send({ type: 'hello', serverTime: Date.now() });
  };

  private async dispatch(conn: WsConnection, raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object' || typeof (raw as WsMessage).type !== 'string') {
      conn.send({ type: 'error', code: 'INVALID_MESSAGE', message: 'Mesajın type alanı olmalı' });
      return;
    }
    const msg = raw as WsMessage;
    const reqId = typeof msg.reqId === 'string' || typeof msg.reqId === 'number' ? msg.reqId : undefined;
    try {
      if (msg.type === 'auth') {
        await this.authenticate(conn, msg);
        return;
      }
      if (msg.type === 'ping') {
        conn.send({ type: 'pong', t: msg.t, serverTime: Date.now() });
        return;
      }
      const h = this.handlers.get(msg.type);
      if (!h) {
        conn.send({ type: 'error', code: 'UNKNOWN_TYPE', message: `Bilinmeyen mesaj türü: ${msg.type}`, reqId });
        return;
      }
      const out = await h(conn, msg, this.userOf(conn));
      if (out !== undefined && reqId !== undefined) conn.send({ type: 'ack', reqId, ...(out as object) });
    } catch (e) {
      const err = e as { code?: string; message?: string; details?: unknown; status?: number };
      if (!err.code) this.opts.logger.error('WebSocket işleyici hatası', { type: msg.type, error: e, stack: (e as Error).stack });
      conn.send({ type: 'error', code: err.code ?? 'INTERNAL', message: err.code ? err.message : 'Beklenmeyen hata', details: err.details, reqId, for: msg.type });
    }
  }

  private async authenticate(conn: WsConnection, msg: WsMessage): Promise<void> {
    const user = typeof msg.token === 'string' ? this.opts.authenticate(msg.token) : null;
    if (!user || !(await this.opts.sessionActive(user.sessionId))) {
      conn.send({ type: 'auth.error', code: 'UNAUTHORIZED', message: 'Oturum geçersiz' });
      return;
    }
    const prev = this.userOf(conn);
    if (prev && prev.id !== user.id) {
      conn.send({ type: 'auth.error', code: 'ALREADY_AUTHENTICATED', message: 'Bağlantı başka bir kullanıcıya ait' });
      return;
    }
    conn.data.user = user;
    let set = this.byUser.get(user.id);
    if (!set) this.byUser.set(user.id, (set = new Set()));
    set.add(conn);
    conn.send({ type: 'auth.ok', userId: user.id });
    for (const fn of this.authListeners) fn(conn, user);
  }

  subscribe(conn: WsConnection, topic: string): void {
    let set = this.topics.get(topic);
    if (!set) this.topics.set(topic, (set = new Set()));
    set.add(conn);
  }

  unsubscribe(conn: WsConnection, topic: string): void {
    this.topics.get(topic)?.delete(conn);
  }

  publish(topic: string, message: unknown, filter?: (c: WsConnection) => boolean): void {
    const set = this.topics.get(topic);
    if (!set) return;
    for (const c of set) if (!filter || filter(c)) c.send(message);
  }

  sendToUser(userId: string, message: unknown): void {
    for (const c of this.byUser.get(userId) ?? []) c.send(message);
  }
}
