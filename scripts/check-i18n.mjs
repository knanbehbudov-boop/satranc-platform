// K48: arayüz metinlerinin İngilizce/Rusça karşılığı var mı? Eksikleri listeler.
// app.js'deki (yönetim paneli hariç) ve sunucu hata mesajlarındaki Türkçe metinleri çıkarır,
// i18n.js'ye verir ve çevrilemeyenleri yazar. TypeScript ayrıştırıcısı gerekir.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
let ts;
for (const p of ['typescript', '/opt/npm-tools/node_modules/typescript']) {
  try { ts = require(p); break; } catch { /* */ }
}
if (!ts) {
  console.log('typescript bulunamadı; kontrol atlandı');
  process.exit(0);
}

export function loadI18n(lang) {
  const ctx = {
    window: {},
    navigator: { language: lang },
    localStorage: { getItem: () => null, setItem() {} },
    document: { readyState: 'loading', addEventListener() {} },
    location: {},
  };
  vm.runInNewContext(readFileSync(join(root, 'apps/web/public/i18n.js'), 'utf8'), ctx);
  return ctx.window.I18N;
}

const TR = /[çğıöşüÇĞİÖŞÜ]/;
function keep(key) {
  const bare = key.replace(/\{\d+\}/g, '').trim();
  if (!/\p{L}{2}/u.test(bare)) return false;
  if (TR.test(bare)) return true;
  if (/^[a-z0-9_.\/#:?=&%-]*$/.test(bare) || /^[a-z-]+( [a-z-]+)*$/.test(bare)) return false;
  if (/^[\w.-]+$/.test(bare) && !/^[A-Z][a-z]+$/.test(bare)) return false;
  if (/[<>{};=]|=>/.test(bare)) return false;
  return true;
}
const lit = (n) => {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) {
    let k = n.head.text;
    n.templateSpans.forEach((sp, i) => { k += `{${i}}${sp.literal.text}`; });
    return k;
  }
  return null;
};

const keys = new Map();
// 1) Web arayüzü (yönetim paneli ekip içidir, Türkçe kalır).
const app = readFileSync(join(root, 'apps/web/public/app.js'), 'utf8');
const cut = app.indexOf('// ---- yönetim paneli');
const src = ts.createSourceFile('app.js', app.slice(0, cut > 0 ? cut : undefined), ts.ScriptTarget.Latest, true);
const IGNORE = new Set(['Bearer {0}', '.acc-bar i', 'Notification', '(display-mode: standalone)', 'Azerbaycan', 'Türkçe', 'English', 'Русский']);
(function visit(n) {
  const k = lit(n);
  if (k !== null && keep(k) && !IGNORE.has(k) && !n.parent?.getText(src).startsWith('api(')) keys.set(k, `app.js:${src.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
  ts.forEachChild(n, visit);
})(src);

// 2) Sunucu hata mesajları (kullanıcıya gösterilir).
const ERR = new Set(['badRequest', 'conflict', 'forbidden', 'notFound', 'unauthorized', 'AppError']);
const SKIP_DIRS = ['admin', 'demo', 'fairplay'];
function files(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return SKIP_DIRS.includes(f) ? [] : files(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}
for (const f of files(join(root, 'packages/server/src'))) {
  const s = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
  (function visit(n) {
    if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && n.arguments && ERR.has(n.expression.getText(s).split('.').pop())) {
      for (const a of n.arguments) {
        const k = lit(a);
        if (k && /\s/.test(k) && TR.test(k)) keys.set(k, `${f.slice(root.length)}:${s.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
      }
    }
    ts.forEachChild(n, visit);
  })(s);
}

let missing = 0;
for (const lang of ['en', 'ru']) {
  const I = loadI18n(lang);
  for (const [k, where] of keys) {
    const sample = k.replace(/\{(\d+)\}/g, (_, n) => `7${n}`);
    if (I.t(sample) === sample && !I.known(sample)) {
      missing++;
      console.log(`[${lang}] eksik: ${JSON.stringify(k)}  (${where})`);
    }
  }
}
console.log(`${keys.size} metin denetlendi; eksik: ${missing}`);
process.exit(missing ? 1 : 0);
