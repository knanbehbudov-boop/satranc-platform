/**
 * Migrasyon aracı: migrations/NNN_ad.sql dosyalarını sırayla, her biri ayrı
 * bir işlemde uygular. Uygulanan dosyaların sağlama toplamı saklanır; daha önce
 * uygulanmış bir dosya değiştirilirse çalışma durur (geriye dönük değişiklik yasak,
 * yeni migrasyon yazılır).
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from './pg.ts';

export const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', '..', 'migrations');

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<MigrationResult> {
  const conn = await pool.acquire();
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    // Aynı anda iki sunucu başlarsa migrasyonları yalnız biri uygular.
    await conn.query('SELECT pg_advisory_lock(727274)');
    try {
      const done = new Map(
        (await conn.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map(
          (r) => [r.name, r.checksum],
        ),
      );
      const files = readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
      const result: MigrationResult = { applied: [], skipped: [] };
      for (const file of files) {
        const sql = readFileSync(join(dir, file), 'utf8');
        const checksum = createHash('sha256').update(sql).digest('hex');
        const prev = done.get(file);
        if (prev) {
          if (prev !== checksum) {
            throw new Error(`Uygulanmış migrasyon değiştirilmiş: ${file}. Değişiklik için yeni bir migrasyon yazın.`);
          }
          result.skipped.push(file);
          continue;
        }
        await conn.simpleQuery(`BEGIN;\n${sql}\n;INSERT INTO schema_migrations (name, checksum) VALUES ('${file}', '${checksum}');\nCOMMIT;`)
          .catch(async (e: unknown) => {
            await conn.simpleQuery('ROLLBACK').catch(() => undefined);
            throw new Error(`Migrasyon başarısız: ${file}: ${e instanceof Error ? e.message : String(e)}`);
          });
        result.applied.push(file);
      }
      return result;
    } finally {
      await conn.query('SELECT pg_advisory_unlock(727274)');
    }
  } finally {
    pool.release(conn);
  }
}
