/**
 * Yapısal (JSON satırı) log. Hassas alanlar (şifre, token, kart) asla yazılmaz:
 * aşağıdaki anahtarlar otomatik maskelenir.
 */
const SENSITIVE = /pass(word)?|token|secret|authorization|cookie|card|refresh/i;

export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function scrub(v: unknown, depth = 0): unknown {
  if (depth > 4 || v === null || typeof v !== 'object') return v;
  if (v instanceof Error) return { name: v.name, message: v.message, code: (v as { code?: unknown }).code };
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) out[k] = SENSITIVE.test(k) ? '[gizli]' : scrub(val, depth + 1);
  return out;
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(minLevel: Level = (process.env.LOG_LEVEL as Level) ?? 'info', bindings: Record<string, unknown> = {}): Logger {
  const write = (level: Level, msg: string, data?: Record<string, unknown>): void => {
    if (ORDER[level] < ORDER[minLevel]) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...bindings, ...(scrub(data ?? {}) as object) });
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  };
  return {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
    child: (b) => createLogger(minLevel, { ...bindings, ...b }),
  };
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};
