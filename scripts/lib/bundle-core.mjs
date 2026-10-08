// chess-core kaynak kodunu (TypeScript) tarayıcı için tek bir betiğe paketler.
// Sonuç `window.ChessCore` olarak kullanılır. Harici paketleyici gerekmez.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
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

// Bağımlılık sırası (her modül yalnızca kendinden öncekileri içe aktarır).
const ORDER = ['errors', 'board', 'movegen', 'fen', 'notation', 'material', 'timecontrol', 'rules', 'game', 'pgn', 'index'];

function transformImports(code, name) {
  code = code.replace(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/(\w+)\.(?:ts|js)['"];?/g, (_, names, mod) => {
    const list = names.split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/\s+as\s+/, ': '));
    return `const { ${list.join(', ')} } = __m.${mod};`;
  });
  const exported = [];
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
  if (/^\s*(import|export)\s/m.test(code)) throw new Error(`${name}.ts: paketleyicinin tanımadığı import/export kaldı`);
  return { code, exported };
}

/**
 * TypeScript → JavaScript: Node 22.13+ yerleşik tip ayıklayıcısı varsa onu kullanır
 * (hiçbir paket gerekmez, Docker imajında da çalışır); yoksa TypeScript derleyicisine düşer.
 */
function stripper() {
  const require = createRequire(import.meta.url);
  const mod = require('node:module');
  if (typeof mod.stripTypeScriptTypes === 'function') {
    process.removeAllListeners('warning');
    return (source) => mod.stripTypeScriptTypes(source, { mode: 'strip' });
  }
  const ts = loadTypeScript();
  return (source, name) =>
    ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true },
      fileName: `${name}.ts`,
    }).outputText;
}

export function bundleCore() {
  const strip = stripper();
  let bundle = '(() => {\nconst __m = {};\n';
  for (const name of ORDER) {
    const source = readFileSync(join(src, `${name}.ts`), 'utf8');
    const { code, exported } = transformImports(strip(source, name), name);
    bundle += `__m.${name} = (() => {\n${code}\nreturn { ${exported.join(', ')} };\n})();\n`;
  }
  bundle += 'window.ChessCore = Object.freeze({ ...__m.index });\n})();\n';
  return bundle;
}
