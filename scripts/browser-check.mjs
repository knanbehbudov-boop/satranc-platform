// Tarayıcı kontrolü (kabul kriteri: "aynı paket sunucuda ve tarayıcıda aynı sonucu veriyor").
// Derlenmiş test masasını Chromium'da açar, tarayıcı içi perft'in geçtiğini doğrular
// ve tahtaya tıklayarak birkaç senaryoyu uçtan uca oynar.
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require(join(execSync('npm root -g').toString().trim(), 'playwright'));
}

const shotsDir = process.env.SHOTS_DIR;
const page_url = pathToFileURL(join(root, 'dist/satranc-test-masasi.html')).href;
const browser = await playwright.chromium.launch();
const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? 'GEÇTİ ' : 'KALDI '} ${label}`);
  if (!ok) failures.push(label);
};

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Yazı tipi CDN'i bu ortamda erişilemeyebilir; sayfa yedek yazı tipleriyle çalışmalı.
  await page.route('https://fonts.googleapis.com/**', (r) => r.abort());
  await page.route('https://fonts.gstatic.com/**', (r) => r.abort());
  await page.goto(page_url);

  await page.waitForFunction(() => ['pass', 'fail'].includes(document.body.dataset.selftest), null, { timeout: 60_000 });
  check((await page.evaluate(() => document.body.dataset.selftest)) === 'pass', 'Tarayıcı içi perft (20 sayım) ve Opera PGN son pozisyonu');
  console.log('       ' + (await page.textContent('#selftest-summary')));
  if (shotsDir) await page.screenshot({ path: join(shotsDir, 'masaustu.png'), fullPage: true });

  const sizes = await page.evaluate(() => [...document.querySelectorAll('.sq')].map((e) => {
    const r = e.getBoundingClientRect();
    return [Math.round(r.width), Math.round(r.height)];
  }));
  const ws = sizes.map((s) => s[0]);
  const hs = sizes.map((s) => s[1]);
  check(
    Math.max(...ws, ...hs) - Math.min(...ws, ...hs) <= 1,
    `Tahta kareleri eşit ve kare (${Math.min(...ws)}–${Math.max(...ws)} × ${Math.min(...hs)}–${Math.max(...hs)} px)`,
  );

  const sq = (s) => page.click(`.sq[data-square="${s}"]`);
  const pill = () => page.textContent('#status-pill');
  const msg = async () => ((await page.isHidden('#msg')) ? '' : await page.textContent('#msg'));

  // 1) Başlangıç: e2 seçilince iki hedef işaretlenir, e4 oynanır.
  await sq('e2');
  check((await page.locator('.target').count()) === 2, 'e2 piyonu için 2 hedef (e3, e4)');
  await sq('e4');
  check((await page.textContent('#moves')).includes('e4'), 'Tıklayarak e4 oynandı ve hamle listesine yazıldı');

  // 2) Geri alma kapalı
  await page.click('#btn-undo');
  check((await msg()).includes('TAKEBACK_DISABLED'), 'Geri alma reddedildi');

  // 3) Mat senaryosu
  await page.click('#scn-mate');
  await sq('d8');
  await sq('h4');
  check((await pill()).trim() === '0-1', 'Aptal matı: sonuç 0-1');
  check((await page.textContent('#status-detail')).includes('Mat'), 'Durum: Mat');

  // 4) Terfi seçimi
  await page.click('#scn-promo');
  await sq('b7');
  await sq('b8');
  check(await page.isVisible('#promo-n'), 'Terfi seçim penceresi açıldı');
  await page.click('#promo-n');
  check((await page.textContent('#moves')).includes('b8=N'), 'Ata terfi: b8=N');

  // 5) Geçerken alma
  await page.click('#scn-ep');
  await sq('e5');
  await sq('f6');
  check((await page.textContent('#moves')).includes('exf6'), 'Geçerken alma: exf6');
  check((await page.locator('.sq[data-square="f5"] .piece').count()) === 0, 'Alınan f5 piyonu tahtadan kalktı');

  // 6) Pat
  await page.click('#scn-stalemate');
  await sq('g6');
  await sq('f7');
  check((await page.textContent('#status-detail')).includes('Pat'), 'Pat ile beraberlik');

  // 7) Süre bitimi ve materyal kuralı
  await page.click('#scn-flag');
  await page.click('#flag-w');
  check((await pill()).includes('½'), 'Beyazın süresi bitti, siyahta yalnız şah: beraberlik');
  await page.click('#scn-flag');
  await page.click('#flag-b');
  check((await pill()).trim() === '1-0', 'Siyahın süresi bitti: beyaz kazandı');

  // 8) Ücretli mod: beraberlik kilidi
  await page.click('#mode-paid');
  await page.click('#offer-w');
  check((await msg()).includes('DRAW_OFFER_TOO_EARLY'), 'Ücretli modda erken beraberlik teklifi reddedildi');

  // 9) Açmaz: e2 atı için hiç hedef yok
  await page.click('#mode-casual');
  await page.click('#scn-pin');
  await sq('e2');
  check((await page.locator('.target').count()) === 0, 'Açmazdaki at oynayamıyor');

  // 10) Tüm senaryolar hatasız yükleniyor
  for (const id of ['castle', 'repeat', 'insufficient', 'fifty']) {
    await page.click(`#scn-${id}`);
    check(!(await msg()).includes('INVALID'), `Senaryo yüklendi: ${id}`);
  }

  check(errors.length === 0, `Sayfada JavaScript hatası yok${errors.length ? ': ' + errors.join(' | ') : ''}`);

  if (shotsDir) {
    await page.click('#scn-castle');
    await sq('e1');
    const phone = await browser.newPage({ viewport: { width: 400, height: 900 }, colorScheme: 'dark' });
    await phone.route('https://fonts.googleapis.com/**', (r) => r.abort());
    await phone.route('https://fonts.gstatic.com/**', (r) => r.abort());
    await phone.goto(page_url);
    await phone.waitForFunction(() => ['pass', 'fail'].includes(document.body.dataset.selftest), null, { timeout: 60_000 });
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `Telefon genişliğinde yatay kaydırma yok (taşma: ${overflow}px)`);
    await phone.screenshot({ path: join(shotsDir, 'telefon-koyu.png'), fullPage: false });
    await page.screenshot({ path: join(shotsDir, 'masaustu-rok.png'), fullPage: false });
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} kontrol başarısız.`);
  process.exit(1);
}
console.log('\nTüm tarayıcı kontrolleri geçti.');
