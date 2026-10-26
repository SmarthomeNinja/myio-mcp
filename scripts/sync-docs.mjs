// npm run sync-docs - a kanonikus API-referencia (a V4-repo SD_Files/js/lang/HU/API_REFERENCE.md-je, 10-25 ota ott el) atmasolasa
// a csomag API_REFERENCE.md-jebe (ezt olvassa a myio_reference eszkoz es a myio://docs/... resource). A `pack` is ezzel kezd.
//   --check   csak ellenoriz: kilepesi kod 1, ha elter vagy a forras hianyzik
//   MYIO_DOCS_SRC=<ut>   mas forras
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = process.env.MYIO_DOCS_SRC || path.resolve(ROOT, '..', 'SD_Files', 'js', 'lang', 'HU', 'API_REFERENCE.md');
const dst = path.join(ROOT, 'API_REFERENCE.md');
const check = process.argv.includes('--check');
const md5 = b => crypto.createHash('md5').update(b).digest('hex').slice(0, 12);
const heads = b => b.toString('utf8').split('\n').filter(l => /^## /.test(l)).length;

if (!fs.existsSync(src)) {
  console.warn(`sync-docs: source not found (${src}) - the bundled API_REFERENCE.md is kept as it is`);
  process.exit(check ? 1 : 0);
}
const a = fs.readFileSync(src);
const b = fs.existsSync(dst) ? fs.readFileSync(dst) : Buffer.alloc(0);
if (a.equals(b)) { console.log(`sync-docs: up to date (${a.length} B, ${heads(a)} chapters, md5 ${md5(a)})`); process.exit(0); }
if (check) { console.error(`sync-docs: API_REFERENCE.md is OUT OF DATE (bundle ${b.length} B md5 ${md5(b)}, source ${a.length} B md5 ${md5(a)}) - run npm run sync-docs`); process.exit(1); }
fs.writeFileSync(dst, a);
console.log(`sync-docs: copied ${path.relative(ROOT, src)} -> API_REFERENCE.md (${b.length} -> ${a.length} B, ${heads(b)} -> ${heads(a)} chapters, md5 ${md5(a)})`);
