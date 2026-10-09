// Taş seti üreticisi: Kanan'ın 9 Ekim 2026'da onayladığı, online oyun için optimize edilmiş
// kendi taş setimiz (dış kaynak yok). 12 SVG dosyası apps/web/public/pieces/ altına yazılır.
//   node scripts/build-pieces.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './lib/bundle-core.mjs';

const BASE = '<path d="M10.5 37.5h24c0-2-1.4-3.4-3.6-3.8H14.1c-2.2.4-3.6 1.8-3.6 3.8z"/>';
// [gövde, iç ayrıntılar]
const P = {
  p: ['<path d="M18.2 21.6c0-1.4 1.6-2.4 4.3-2.4s4.3 1 4.3 2.4c0 .8-.6 1.3-1.4 1.6.4 4 2.4 7 5.1 9.4.9.8 1.5 2 1.5 3.3v1.6h-19v-1.6c0-1.3.6-2.5 1.5-3.3 2.7-2.4 4.7-5.4 5.1-9.4-.8-.3-1.4-.8-1.4-1.6z"/><circle cx="22.5" cy="14.2" r="5"/>', ''],
  r: ['<path d="M11 37.5h23v-2.4c0-.5-.4-.8-.8-.8H11.8c-.4 0-.8.3-.8.8z"/><path d="M13.6 34.3c.6-1.4 1-2.6 1.4-3.8h15c.4 1.2.8 2.4 1.4 3.8z"/><path d="M15.4 30.5c.6-4.2.9-8.4.9-12.5h12.4c0 4.1.3 8.3.9 12.5z"/><path d="M12 18v-7.2c0-.5.4-.8.8-.8h3c.5 0 .8.3.8.8V13h4v-2.2c0-.5.4-.8.8-.8h2.2c.5 0 .8.3.8.8V13h4v-2.2c0-.5.4-.8.8-.8h3c.4 0 .8.3.8.8V18z"/>', '<path d="M16.4 18h12.2M15.6 30.5h13.8"/>'],
  b: [BASE + '<path d="M17 33.7c1-2.4 1.6-4.4 1.4-6.4h8.2c-.2 2 .4 4 1.4 6.4z"/><path d="M17.2 27.3h10.6c.9-.8.9-2 0-2.8H17.2c-.9.8-.9 2 0 2.8z"/><path d="M22.5 8.6c-5.2 3.6-7.4 8.4-5.6 15.9h11.2c1.8-7.5-.4-12.3-5.6-15.9z"/><circle cx="22.5" cy="6.6" r="2.3"/>', '<path d="M25 13.4l-3.6 5.4"/>'],
  n: [BASE + '<path d="M14.8 33.7C14.2 29.4 16.6 24.6 19.2 23 19.8 22.4 19.6 21.6 18.8 21.4 16.8 21.2 14.6 22.6 12.8 23.6 11 24.6 9.2 23.6 9.4 21.8 9.6 20 10.6 18.8 12 17.4 14.6 14.4 17 11.6 20 10.2L21.6 5.8 23.6 9.2 25.4 5.4 26.6 9.8Q30.6 10 29.6 12.8Q33 13.4 31.6 16.6Q34.6 18 32.8 21.2Q35 23.4 33 26.2Q34.6 28.8 32.2 30.6L30.8 33.7Z"/>', '<circle cx="19.2" cy="14.4" r="1.25" class="dot"/><circle cx="11.4" cy="20" r="1" class="dot"/><path d="M23.4 9.6c-.6 1.4-1.8 2.4-3.2 2.8M26.4 11.8c1.6 1.2 2.6 2.8 3 4.6M28.4 16.6c1.4 1.6 2 3.6 2 5.8M29.4 23c.8 2 1 4.2.6 6.4"/>'],
  q: [BASE + '<path d="M13.6 33.7c.4-1.8.2-3.2-.4-4.6 6-1.8 12.6-1.8 18.6 0-.6 1.4-.8 2.8-.4 4.6z"/><path d="M13.2 29.1L9.6 14.6Q14.2 19.6 15.6 22 16 16 16.8 11.6 18.8 17 20.2 21 21.2 14.6 22.5 9 23.8 14.6 24.8 21 26.2 17 28.2 11.6 29 16 29.4 22 30.8 19.6 35.4 14.6L31.8 29.1C25.8 27.3 19.2 27.3 13.2 29.1Z"/><circle cx="9.6" cy="13.2" r="2"/><circle cx="16.8" cy="10.2" r="2"/><circle cx="22.5" cy="7.4" r="2.1"/><circle cx="28.2" cy="10.2" r="2"/><circle cx="35.4" cy="13.2" r="2"/>', '<path d="M14 29.6c5.8-1.6 11.2-1.6 17 0"/>'],
  k: [BASE + '<path d="M15.3 29.3c4.8-1.4 9.6-1.4 14.4 0 .6 1.4.6 2.8 0 4.2-4.8-1.4-9.6-1.4-14.4 0-.6-1.4-.6-2.8 0-4.2z"/><path d="M22.5 12.5c-5.6 0-10 3.2-10 8.2 0 3.4 2 6.2 2.8 8.6h14.4c.8-2.4 2.8-5.2 2.8-8.6 0-5-4.4-8.2-10-8.2z"/><path d="M21.2 2.4h2.6l-.4 2.6 2.8-.4v2.8l-2.8-.4.4 5.5h-2.6l.4-5.5-2.8.4V4.6l2.8.4z"/>', '<path d="M22.5 16v9.6M16 29.8c4.4-1.2 8.6-1.2 13 0"/>'],
};

export function pieceSvg(type, white) {
  const fill = white ? '#ffffff' : '#141414';
  const dc = white ? '#141414' : '#f2f2f2';
  const [body, det] = P[type];
  const details = det.replace(/class="dot"/g, `fill="${dc}" stroke="none"`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45">`
    + `<g fill="${fill}" stroke="#141414" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">${body}</g>`
    + (details ? `<g fill="none" stroke="${dc}" stroke-width="1.4" stroke-linecap="round">${details}</g>` : '')
    + `</svg>\n`;
}

const out = join(root, 'apps/web/public/pieces');
mkdirSync(out, { recursive: true });
for (const t of Object.keys(P)) {
  writeFileSync(join(out, `w${t.toUpperCase()}.svg`), pieceSvg(t, true));
  writeFileSync(join(out, `b${t.toUpperCase()}.svg`), pieceSvg(t, false));
}
console.log(`12 taş yazıldı: ${out}`);
