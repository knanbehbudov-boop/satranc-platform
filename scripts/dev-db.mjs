// Yerel geliştirme veritabanı: proje klasöründe (.data/pg) bağımsız bir PostgreSQL
// kümesi kurar ve başlatır. Docker gerekmez; makinede PostgreSQL 14+ kurulu olmalı.
// Docker tercih edilirse: docker compose up -d (docker-compose.yml).
//
//   node scripts/dev-db.mjs start   # yoksa oluşturur, başlatır
//   node scripts/dev-db.mjs stop
//   node scripts/dev-db.mjs reset   # siler ve yeniden oluşturur
//   node scripts/dev-db.mjs url     # bağlantı adresini yazar
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, '.data', 'pg');
const port = Number(process.env.DEV_PG_PORT ?? 54329);
const dbName = process.env.DEV_PG_DB ?? 'satranc';
const user = 'satranc';
const password = 'satranc-dev';

function pgBin(name) {
  const fromPath = spawnSync('which', [name]).stdout?.toString().trim();
  if (fromPath) return fromPath;
  const base = '/usr/lib/postgresql';
  if (existsSync(base)) {
    const versions = readdirSync(base).sort((a, b) => Number(b) - Number(a));
    for (const v of versions) {
      const p = join(base, v, 'bin', name);
      if (existsSync(p)) return p;
    }
  }
  throw new Error(`${name} bulunamadı. PostgreSQL kurun ya da docker compose kullanın.`);
}

// PostgreSQL root olarak çalışmaz; root isek "postgres" kullanıcısıyla çalıştır.
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
function run(bin, args, opts = {}) {
  const cmd = asRoot ? 'runuser' : bin;
  const fullArgs = asRoot ? ['-u', 'postgres', '--', bin, ...args] : args;
  return execFileSync(cmd, fullArgs, { stdio: opts.quiet ? 'pipe' : 'inherit', ...opts });
}

function ownForPostgres(path) {
  if (!asRoot) return;
  const uid = Number(execFileSync('id', ['-u', 'postgres']).toString());
  const gid = Number(execFileSync('id', ['-g', 'postgres']).toString());
  chownSync(path, uid, gid);
}

function isRunning() {
  if (!existsSync(join(dataDir, 'postmaster.pid'))) return false;
  const r = spawnSync(asRoot ? 'runuser' : pgBin('pg_ctl'),
    asRoot ? ['-u', 'postgres', '--', pgBin('pg_ctl'), 'status', '-D', dataDir] : ['status', '-D', dataDir]);
  return r.status === 0;
}

function init() {
  mkdirSync(join(root, '.data'), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  ownForPostgres(dataDir);
  chmodSync(dataDir, 0o700);
  const pwFile = join(root, '.data', 'pwfile');
  writeFileSync(pwFile, password + '\n');
  ownForPostgres(pwFile);
  run(pgBin('initdb'), ['-D', dataDir, '-U', user, '--pwfile', pwFile, '-A', 'scram-sha-256', '-E', 'UTF8', '--locale=C'], { quiet: true });
  rmSync(pwFile);
}

function start() {
  if (!existsSync(join(dataDir, 'PG_VERSION'))) init();
  if (isRunning()) return;
  const sockDir = join(root, '.data');
  if (asRoot) ownForPostgres(sockDir);
  run(pgBin('pg_ctl'), [
    'start', '-D', dataDir, '-w', '-l', join(dataDir, 'server.log'),
    '-o', `-p ${port} -k ${sockDir} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off`,
  ], { quiet: true });
  // Veritabanı yoksa oluştur.
  const env = { ...process.env, PGPASSWORD: password };
  const exists = spawnSync(pgBin('psql'), ['-h', '127.0.0.1', '-p', String(port), '-U', user, '-d', 'postgres', '-tAc',
    `SELECT 1 FROM pg_database WHERE datname='${dbName}'`], { env }).stdout.toString().trim();
  if (exists !== '1') {
    execFileSync(pgBin('createdb'), ['-h', '127.0.0.1', '-p', String(port), '-U', user, dbName], { env });
  }
}

function stop() {
  if (isRunning()) run(pgBin('pg_ctl'), ['stop', '-D', dataDir, '-m', 'fast', '-w'], { quiet: true });
}

const url = `postgres://${user}:${password}@127.0.0.1:${port}/${dbName}`;
const cmd = process.argv[2] ?? 'start';
if (cmd === 'start') {
  start();
  console.log(`PostgreSQL hazır: ${url}`);
} else if (cmd === 'stop') {
  stop();
  console.log('PostgreSQL durduruldu.');
} else if (cmd === 'reset') {
  stop();
  rmSync(dataDir, { recursive: true, force: true });
  start();
  console.log(`PostgreSQL sıfırlandı: ${url}`);
} else if (cmd === 'url') {
  console.log(url);
} else {
  console.error('Kullanım: node scripts/dev-db.mjs start|stop|reset|url');
  process.exit(2);
}
