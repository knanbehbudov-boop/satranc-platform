/**
 * Özellik bayrakları ve acil durdurma ("kill switch", plan M0/M13).
 * Okuma kısa süre önbelleklenir; yazma her zaman denetim kaydıyla yapılır.
 */
import type { Pool, Queryable } from '../../infra/db/pg.ts';

export class FlagService {
  private readonly pool: Pool;
  private cache = new Map<string, { value: boolean; at: number }>();
  private readonly ttlMs: number;

  constructor(pool: Pool, ttlMs = 2000) {
    this.pool = pool;
    this.ttlMs = ttlMs;
  }

  async isEnabled(key: string, fallback = false): Promise<boolean> {
    const c = this.cache.get(key);
    if (c && Date.now() - c.at < this.ttlMs) return c.value;
    const r = await this.pool.query<{ enabled: boolean }>('SELECT enabled FROM feature_flags WHERE key = $1', [key]);
    const value = r.rows[0]?.enabled ?? fallback;
    this.cache.set(key, { value, at: Date.now() });
    return value;
  }

  async list() {
    const r = await this.pool.query<{ key: string; enabled: boolean; note: string | null; updated_at: Date; updated_by: string | null }>(
      'SELECT key, enabled, note, updated_at, updated_by FROM feature_flags ORDER BY key',
    );
    return r.rows.map((f) => ({ key: f.key, enabled: f.enabled, note: f.note, updatedAt: f.updated_at, updatedBy: f.updated_by }));
  }

  async set(q: Queryable, key: string, enabled: boolean, actorId: string | null, reason: string): Promise<void> {
    await q.query(
      `INSERT INTO feature_flags (key, enabled, updated_by, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, enabled, actorId],
    );
    await q.query(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id, data) VALUES ($1::uuid, 'flag.set', 'feature_flag', $2, $3)`,
      [actorId, key, { enabled, reason }],
    );
    this.cache.delete(key);
  }

  /** Testler ve yönetim: önbelleği hemen boşalt. */
  invalidate(): void {
    this.cache.clear();
  }
}
