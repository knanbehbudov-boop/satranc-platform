// Test masası derlemesi (Bölüm 1): chess-core'u paketleyip apps/demo-chess/template.html içine gömer.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundleCore, root } from './lib/bundle-core.mjs';

let bundle = bundleCore();
// Testlerle aynı perft değerleri ve Opera Oyunu; son FEN sunucu tarafında hesaplanır.
const fixtures = await import(join(root, 'packages/chess-core/test/fixtures.ts'));
const core = await import(join(root, 'packages/chess-core/src/index.ts'));
const operaFinalFen = core.parsePgn(fixtures.OPERA_GAME).game.fen();
const fixtureJson = JSON.stringify({ perft: fixtures.PERFT_CASES, opera: fixtures.OPERA_GAME, operaFinalFen });
bundle += `window.__FIXTURES__ = ${fixtureJson.replace(/</g, '\\u003c')};\n`;

const template = readFileSync(join(root, 'apps/demo-chess/template.html'), 'utf8');
const app = readFileSync(join(root, 'apps/demo-chess/app.js'), 'utf8');
const html = template.replace('/*__CORE__*/', () => bundle).replace('/*__APP__*/', () => app);

mkdirSync(join(root, 'dist'), { recursive: true });
const outPath = join(root, 'dist/satranc-test-masasi.html');
writeFileSync(outPath, html);
console.log(`Yazıldı: ${outPath} (${(html.length / 1024).toFixed(1)} KB)`);
