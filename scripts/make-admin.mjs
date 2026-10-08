// Kullanıcıya personel rolü verir ya da alır (ilk yönetici için; sonrası panelden/denetimli).
//   node scripts/make-admin.mjs <e-posta> [admin|finance|fairplay] [--remove]
// DATABASE_URL ortam değişkeninden okunur (varsayılan: yerel geliştirme veritabanı).
import { join } from 'node:path';
import { root } from './lib/bundle-core.mjs';

const [email, role = 'admin', flag] = process.argv.slice(2);
if (!email || !['admin', 'finance', 'fairplay'].includes(role)) {
  console.error('Kullanım: node scripts/make-admin.mjs <e-posta> [admin|finance|fairplay] [--remove]');
  process.exit(2);
}
const { Pool } = await import(join(root, 'packages/server/src/infra/db/pg.ts'));
const url = process.env.DATABASE_URL ?? 'postgres://satranc:satranc-dev@127.0.0.1:54329/satranc';
const pool = Pool.fromUrl(url, { max: 1 });
try {
  const remove = flag === '--remove';
  const r = await pool.query(
    remove
      ? `UPDATE users SET roles = array_remove(roles, $2) WHERE lower(email) = lower($1) RETURNING id, display_name, roles`
      : `UPDATE users SET roles = CASE WHEN $2 = ANY(roles) THEN roles ELSE array_append(roles, $2) END WHERE lower(email) = lower($1) RETURNING id, display_name, roles`,
    [email, role],
  );
  const u = r.rows[0];
  if (!u) {
    console.error(`Kullanıcı bulunamadı: ${email}`);
    process.exit(1);
  }
  await pool.query(
    `INSERT INTO audit_log (actor_id, action, target_type, target_id, data) VALUES (NULL, $1, 'user', $2, $3)`,
    [remove ? 'role.remove' : 'role.grant', u.id, { role, via: 'make-admin script' }],
  );
  console.log(`${u.display_name}: roller = ${u.roles.join(', ')}. Yönetim API'si rolü her istekte veritabanından okur; menünün görünmesi için sayfayı yenileyin.`);
} finally {
  await pool.end();
}
