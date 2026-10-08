// Test masası derlemesi: chess-core kaynak kodunu (TypeScript) tarayıcı için
// tek dosyaya paketler ve apps/demo-chess/template.html içine gömer.
// Harici paketleyici gerekmez; yalnızca TypeScript derleyicisi kullanılır.
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'packages/chess-core/src');

function loadTypeScript() {
  const require = createRequire(import.meta.url);
  try {
    return require('typescript');
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim();
    return require(join(globalRoot, 'typescript'));
  }
}
const ts = loadTypeScript();

// Bağımlılık sırası (her modül yalnızca kendinden öncekileri içe aktarır).
const ORDER = ['errors', 'board', 'movegen', 'fen', 'notation', 'material', 'timecontrol', 'rules', 'game', 'pgn', 'index'];

function transformImports(code, name) {
  // import { a, b as c } from './x.ts';  →  const { a, b: c } = __m.x;
  code = code.replace(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/(\w+)\.(?:ts|js)['"];?/g, (_, names, mod) => {
    const list = names
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/\s+as\s+/, ': '));
    return `const { ${list.join(', ')} } = __m.${mod};`;
  });
  const exported = [];
  // index.ts: export { a, b } from './x.ts';
  code = code.replace(/export\s*\{([^}]*)\}\s*from\s*['"]\.\/(\w+)\.(?:ts|js)['"];?/g, (_, names, mod) => {
    const list = names.split(',').map((s) => s.trim()).filter(Boolean);
    for (const n of list) exported.push(n);
    return `const { ${list.join(', ')} } = __m.${mod};`;
  });
  code = code.replace(/export\s*\*\s*from\s*['"]\.\/(\w+)\.(?:ts|js)['"];?/g, '');
  code = code.replace(/export\s+(function|class|const|let)\s+(\w+)/g, (_, kind, id) => {
    exported.push(id);
    return `${kind} ${id}`;
  });
  if (/^\s*(import|export)\s/m.test(code)) {
    throw new Error(`${name}.ts: paketleyicinin tanımadığı import/export kaldı`);
  }
  return { code, exported };
}

let bundle = 'const __m = {};\n';
for (const name of ORDER) {
  const source = readFileSync(join(src, `${name}.ts`), 'utf8');
  const out = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
      removeComments: false,
    },
    fileName: `${name}.ts`,
  });
  const { code, exported } = transformImports(out.outputText, name);
  bundle += `__m.${name} = (() => {\n${code}\nreturn { ${exported.join(', ')} };\n})();\n`;
}
bundle += 'window.ChessCore = Object.freeze({ ...__m.index });\n';

// Testlerle aynı perft değerleri ve Opera Oyunu; son FEN sunucu tarafında hesaplanır.
const fixtures = await import(join(root, 'packages/chess-core/test/fixtures.ts'));
const core = await import(join(src, 'index.ts'));
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
