// Çalışma alanı bağlantısı: node_modules/@satranc/chess-core → packages/chess-core.
// `npm install` bunu zaten yapar; bu betik npm install yapılmadan çalıştırmak içindir.
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'node_modules', '@satranc', 'chess-core');
if (!existsSync(target)) {
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(join('..', '..', 'packages', 'chess-core'), target, process.platform === 'win32' ? 'junction' : 'dir');
  console.log('Bağlantı kuruldu: node_modules/@satranc/chess-core');
}
