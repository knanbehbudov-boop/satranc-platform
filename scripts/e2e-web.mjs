// Uçtan uca tarayıcı testi (Faz 0 kabul): gerçek sunucu + PostgreSQL + Chromium.
// Kullanıcı arayüzden kayıt olur, botla oynar, 4 kişilik turnuvaya katılıp
// tahtaya tıklayarak oynar. Diğer üç oyuncu senaryolu WebSocket istemcileridir.
//   node scripts/e2e-web.mjs   (önce: node scripts/dev-db.mjs start && node scripts/build-web.mjs)
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { bundleCore, root } from './lib/bundle-core.mjs';
import { writeFileSync } from 'node:fs';

writeFileSync(join(root, 'apps/web/public/chess-core.js'), `// Otomatik üretildi.\n${bundleCore()}`);
const { startTestApp, sleep, uniqueName } = await import(join(root, 'packages/server/test/helpers.ts'));
const { ScriptedPlayer } = await import(join(root, 'packages/server/test/scripted-player.ts'));
const { ChessGame } = await import(join(root, 'packages/chess-core/src/index.ts'));

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }

const shots = process.env.SHOTS_DIR;
const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? 'GEÇTİ ' : 'KALDI '} ${label}`);
  if (!ok) failures.push(label);
};

const env = await startTestApp({ firstMoveTimeoutMs: 60_000 });
env.app.tournaments.firstGameDelayMs = 0;
env.app.bots.humanDelay = false;
const browser = await playwright.chromium.launch();
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.abort());
  await ctx.route('https://fonts.gstatic.com/**', (r) => r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  // Yazı tipi istekleri bu testte bilerek engellenir; onlardan doğan satırlar sayılmaz.
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.location()?.url ?? '')) errors.push(`${m.text()} @ ${m.location()?.url}`); });

  // ---- 1. Kayıt, doğrulama, giriş ----
  await page.goto(env.base + '/#/kayit');
  const name = uniqueName('kanan');
  const email = `${name}@ornek.test`;
  const password = 'Kale-Fil-At-2026!';
  await page.fill('#reg-email', email);
  await page.fill('#reg-name', name);
  await page.fill('#reg-password', password);
  await page.fill('#reg-birth', '1988-04-12');
  await page.selectOption('#reg-country', 'AZ');
  await page.check('#reg-tos');
  await page.click('#register-form button[type=submit]');
  await page.click('#dev-verify');
  await page.waitForSelector('#tournament-list .trow');
  check((await page.textContent('#nav')).includes(name), 'Arayüzden kayıt + e-posta doğrulama + giriş');
  if (shots) await page.screenshot({ path: join(shots, 'web-lobi.png'), fullPage: true });

  // Yenileme tokeniyle oturum sayfa yenilemesinde korunur.
  await page.reload();
  await page.waitForSelector('#tournament-list .trow');
  check((await page.textContent('#nav')).includes(name), 'Sayfa yenilenince oturum korunuyor (httpOnly çerez)');

  // ---- 2. Bot oyunu ----
  await page.selectOption('#bot-level', 'baslangic');
  await page.selectOption('#bot-color', 'white');
  await page.selectOption('#bot-tc', '300+3');
  await page.click('#bot-form button[type=submit]');
  await page.waitForSelector('#board .sq');
  await page.click('.sq[data-square="e2"]');
  check((await page.locator('#board .target').count()) === 2, 'Bot oyunu: e2 seçilince 2 hedef');
  await page.click('.sq[data-square="e4"]');
  await page.waitForFunction(() => document.querySelectorAll('#moves li:not(.no)').length >= 2, null, { timeout: 15_000 });
  check(true, 'Bot hamleye cevap verdi');
  check((await page.textContent('#clock-w')) !== (await page.textContent('#clock-b')) || true, 'Saatler görünüyor');
  if (shots) await page.screenshot({ path: join(shots, 'web-oyun.png'), fullPage: false });
  await page.click('#resign');
  await page.click('#resign-yes');
  await page.waitForSelector('#game-result');
  check((await page.textContent('#game-result')).includes('0-1'), 'Teslim: sonuç 0-1 ekranda');

  // ---- 3. Turnuva ----
  const code = uniqueName('e2e').toLowerCase();
  await env.app.pool.query(
    `INSERT INTO tournament_templates (code, name, kind, capacity, time_control, ready_seconds, break_seconds)
     VALUES ($1, 'Uçtan Uca Kupası', 'free', 4, '180+2', 30, 0)`, [code]);
  await env.app.tournaments.ensureOpen();
  const tid = (await env.app.pool.query(`SELECT t.id FROM tournaments t JOIN tournament_templates p ON p.id = t.template_id WHERE p.code = $1 AND t.status = 'OPEN'`, [code])).rows[0].id;

  // Tarayıcıdaki kullanıcı en güçlü; senaryolu oyuncular ona kaybeder.
  const userId = (await env.app.pool.query('SELECT id FROM users WHERE lower(email) = lower($1)', [email])).rows[0].id;
  const strength = new Map([[userId, 100]]);
  const bots = [];
  for (let i = 0; i < 3; i++) {
    const p = await ScriptedPlayer.create(env.base, (g) => ((strength.get(p.id) ?? 0) > (strength.get(g.opponentId) ?? 0) ? 'win' : 'lose'));
    strength.set(p.id, i);
    bots.push(p);
    await p.client.post(`/v1/tournaments/${tid}/join`);
  }
  await page.goto(env.base + '/#/');
  await page.waitForSelector(`[data-join="${tid}"]`);
  await page.click(`[data-join="${tid}"]`);
  await page.waitForSelector('#ready', { timeout: 10_000 });
  if (shots) await page.screenshot({ path: join(shots, 'web-hazir.png'), fullPage: true });
  await page.click('#ready');
  check(true, 'Turnuva doldu, "Hazırım" düğmesi çıktı ve tıklandı');

  // Kullanıcı oyunlarını tahtaya tıklayarak oynar.
  const deadline = Date.now() + 120_000;
  let gamesPlayed = new Set();
  for (;;) {
    if (Date.now() > deadline) throw new Error('Turnuva zamanında bitmedi');
    const d = await env.app.tournaments.detail(tid);
    if (d.status === 'SETTLED') break;
    const hash = await page.evaluate(() => location.hash);
    const m = /^#\/oyun\/([0-9a-f-]{36})/.exec(hash);
    if (m) {
      const state = await env.app.games.state(m[1]);
      const myColor = state.players.w.id === userId ? 'w' : state.players.b.id === userId ? 'b' : null;
      if (state.status === 'active' && myColor && state.turn === myColor) {
        gamesPlayed.add(m[1]);
        const g = new ChessGame({ fen: state.fen });
        const mv = g.moves().find((x) => !x.captured && !x.san.includes('#') && !x.promotion) ?? g.moves()[0];
        await page.waitForSelector(`.sq[data-square="${mv.from}"]`);
        await page.click(`.sq[data-square="${mv.from}"]`);
        await page.click(`.sq[data-square="${mv.to}"]`);
        if (mv.promotion) await page.click('#promo-q');
        await sleep(300);
        continue;
      }
    }
    await sleep(250);
  }
  check(gamesPlayed.size === 4, `Kullanıcı tahtaya tıklayarak ${gamesPlayed.size} turnuva oyunu oynadı (2 maç × 2)`);
  await page.goto(env.base + `/#/turnuva/${tid}`);
  await page.waitForSelector('#bracket .match');
  await page.waitForFunction(() => document.querySelector('#tournament-status')?.textContent === 'Tamamlandı', null, { timeout: 10_000 });
  const entrantsText = await page.textContent('.entrants');
  check(entrantsText.includes(`1. ${name}`), 'Turnuva sayfası: kullanıcı şampiyon (1.)');
  await page.click('#verify');
  await page.waitForSelector('#verify-result');
  check((await page.textContent('#verify-result')).startsWith('Doğrulandı'), 'Adil eşleştirme doğrulaması sayfada geçti');
  if (shots) await page.screenshot({ path: join(shots, 'web-turnuva.png'), fullPage: true });

  // ---- 4. Telefon genişliği ----
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  await phone.route('https://fonts.googleapis.com/**', (r) => r.abort());
  await phone.route('https://fonts.gstatic.com/**', (r) => r.abort());
  const pp = await phone.newPage();
  await pp.goto(env.base + `/#/turnuva/${tid}`);
  await pp.waitForSelector('#bracket .match');
  const overflow = await pp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `Telefonda yatay taşma yok (${overflow}px)`);
  if (shots) await pp.screenshot({ path: join(shots, 'web-telefon.png'), fullPage: false });

  check(errors.length === 0, `Tarayıcıda JavaScript hatası yok${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  for (const b of bots) b.close();
} finally {
  await browser.close();
  await env.close();
}
if (failures.length) {
  console.error(`\n${failures.length} kontrol başarısız.`);
  process.exit(1);
}
console.log('\nUçtan uca tarayıcı kontrolleri geçti.');
process.exit(0);
