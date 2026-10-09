// Uygulama simgeleri (K46): kendi atımızdan, koyu zeminde. Tarayıcıyla bir kez üretilir ve depoya konur.
//   node scripts/build-icons.mjs   (playwright gerekir)
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { root } from './lib/bundle-core.mjs';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const knight = readFileSync(join(root, 'apps/web/public/pieces/wN.svg'), 'utf8');
const out = join(root, 'apps/web/public/icons');
mkdirSync(out, { recursive: true });
const browser = await playwright.chromium.launch();
for (const size of [192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const pad = Math.round(size * 0.14);
  await page.setContent(`<html><body style="margin:0;background:#161512;display:grid;place-items:center;width:${size}px;height:${size}px">
    <div style="width:${size - 2 * pad}px;height:${size - 2 * pad}px">${knight.replace('<svg ', '<svg width="100%" height="100%" ')}</div></body></html>`);
  await page.screenshot({ path: join(out, `icon-${size}.png`) });
  await page.close();
}
await browser.close();
console.log('Simgeler yazıldı:', out);
