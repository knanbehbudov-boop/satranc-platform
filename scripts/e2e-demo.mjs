// Demo modu kontrolü: tek kullanıcı (iPad senaryosu) — kayıt (ilk hesap yönetici), ücretli
// turnuvayı test botlarıyla doldurma, ödeme, hazır olma, oyun, ödül, cüzdan.
//   node scripts/e2e-demo.mjs
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { bundleCore, root } from './lib/bundle-core.mjs';

writeFileSync(join(root, 'apps/web/public/chess-core.js'), `// Otomatik üretildi.\n${bundleCore()}`);
const { startTestApp, sleep, uniqueName } = await import(join(root, 'packages/server/test/helpers.ts'));
const { ChessGame } = await import(join(root, 'packages/chess-core/src/index.ts'));
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }

const failures = [];
const check = (ok, label) => { console.log(`${ok ? 'GEÇTİ ' : 'KALDI '} ${label}`); if (!ok) failures.push(label); };
const env = await startTestApp({ demoTools: true, paidMinRatedGames: 0, prizeHoldSec: 5, sandboxDeliveryDelayMs: 200, sandboxDuplicateRate: 0.3, firstMoveTimeoutMs: 60_000 });
const browser = await playwright.chromium.launch();
const shots = process.env.SHOTS_DIR;
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
try {
  // iPad boyutu
  const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true });
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.abort());
  await ctx.route('https://fonts.gstatic.com/**', (r) => r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => void d.accept());

  await page.goto(env.base + '/#/kayit');
  const name = uniqueName('ipad');
  await page.fill('#reg-email', `${name}@ornek.test`);
  await page.fill('#reg-name', name);
  await page.fill('#reg-password', 'Kale-Fil-At-2026!');
  await page.fill('#reg-birth', '1988-04-12');
  await page.selectOption('#reg-country', 'AZ');
  await page.check('#reg-tos');
  await page.click('#register-form button[type=submit]');
  await page.click('#dev-verify');
  await page.waitForSelector('#demo-banner');
  check(true, 'Test sürümü bilgisi lobide görünüyor');
  await page.waitForSelector('#nav-admin');
  check(true, 'İlk hesap otomatik yönetici oldu');
  const userId = (await env.app.pool.query('SELECT id FROM users WHERE display_name = $1', [name])).rows[0].id;

  const tid = (await env.app.pool.query(`SELECT t.id FROM tournaments t JOIN tournament_templates p ON p.id = t.template_id WHERE p.code = 'sng-4-blitz-5usd' AND t.status = 'OPEN'`)).rows[0].id;
  await page.goto(env.base + `/#/turnuva/${tid}`);
  await page.waitForSelector('#fill-bots');
  await page.click('#fill-bots');
  await page.waitForFunction(() => document.body.textContent.includes('TestBot'), null, { timeout: 30_000 });
  check(true, 'Botlar katıldı (bir koltuk kullanıcıya bırakıldı)');
  if (shots) await page.screenshot({ path: join(shots, 'demo-botlar.png'), fullPage: true });
  await page.click('#join');
  await page.waitForURL(/sandbox-psp\/checkout/);
  await page.waitForSelector('#pay-form:not(.hidden)');
  await page.fill('#card', '4242424242424242');
  await page.fill('#exp', '1230');
  await page.fill('#cvc', '123');
  await page.click('#pay-btn');
  await page.waitForSelector('#ready', { timeout: 30_000 });
  await page.click('#ready');
  check(true, 'Ödeme → turnuva doldu → Hazırım');

  const deadline = Date.now() + 25 * 60_000;
  const played = new Set();
  for (;;) {
    if (Date.now() > deadline) throw new Error('turnuva bitmedi');
    const d = await env.app.tournaments.detail(tid);
    if (['SETTLING', 'SETTLED', 'DISPUTED'].includes(d.status)) break;
    const hash = await page.evaluate(() => location.hash);
    const m = /^#\/oyun\/([0-9a-f-]{36})/.exec(hash);
    if (m) {
      const st = await env.app.games.state(m[1]);
      const my = st.players.w.id === userId ? 'w' : st.players.b.id === userId ? 'b' : null;
      if (st.status === 'active' && my && st.turn === my) {
        played.add(m[1]);
        const g = new ChessGame({ fen: st.fen });
        const ms = g.moves();
        const mv = ms.find((x) => x.san.includes('#')) ?? ms.filter((x) => x.captured).sort((a, b) => VALUE[b.captured] - VALUE[a.captured])[0] ?? ms[Math.floor(Math.random() * ms.length)];
        await page.click(`.sq[data-square="${mv.from}"]`);
        await page.click(`.sq[data-square="${mv.to}"]`);
        if (mv.promotion) await page.click('#promo-q').catch(() => undefined);
        await sleep(250);
        continue;
      }
    }
    await sleep(300);
  }
  check(played.size >= 1, `Kullanıcı ${played.size} oyunu tahtadan oynadı; botlar kendi aralarında da oynadı`);
  for (let i = 0; i < 120; i++) {
    const d = await env.app.tournaments.detail(tid);
    if (d.status === 'SETTLED') break;
    await sleep(1000);
  }
  const d = await env.app.tournaments.detail(tid);
  check(d.status === 'SETTLED', `Turnuva tamamlandı ve ödüller serbest kaldı (${d.status})`);
  await page.goto(env.base + '/#/cuzdan');
  await page.waitForSelector('#wallet-balance');
  if (shots) await page.screenshot({ path: join(shots, 'demo-cuzdan.png'), fullPage: true });
  check(true, `Cüzdan açıldı: ${(await page.textContent('#wallet-balance')).replace(/\s+/g, ' ').slice(0, 80)}`);
  const inv = await env.app.ledger.invariants();
  check(inv.balanced, 'Defter dengeli');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `iPad genişliğinde taşma yok (${overflow}px)`);
  check(errors.length === 0, `JavaScript hatası yok ${errors.slice(0, 2).join(' | ')}`);
} finally {
  await browser.close();
  await env.close();
}
if (failures.length) { console.error(`${failures.length} kontrol başarısız`); process.exit(1); }
console.log('Demo modu kontrolleri geçti.');
process.exit(0);
