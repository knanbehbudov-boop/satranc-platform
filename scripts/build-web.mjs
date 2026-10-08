// Web arayüzü derlemesi: chess-core'u apps/web/public/chess-core.js olarak yazar.
// Sunucu bu klasörü statik olarak sunar (SERVE_WEB=1).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundleCore, root } from './lib/bundle-core.mjs';

const out = join(root, 'apps/web/public/chess-core.js');
writeFileSync(out, `// Otomatik üretildi: scripts/build-web.mjs. Elle düzenlemeyin.\n${bundleCore()}`);
console.log(`Yazıldı: ${out}`);
