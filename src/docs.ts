/**
 * A csomagolt API-referencia (API_REFERENCE.md = SD_Files/js/lang/HU/API_REFERENCE.md, `npm run sync-docs`): fejezetek,
 * a script-nyelv (10/G) es a Flow (10/D) kivonata, cimszo-kereses. A myio_reference eszkoz es a myio://docs/... resource-ok
 * kozos forrasa (5. kor 2026-10-26).
 */
import { readFileSync } from 'node:fs';
import { normalizeName } from './model.js';

let refCache: string | undefined;
export function apiReference(): string {
  if (refCache === undefined) {
    try { refCache = readFileSync(new URL('../API_REFERENCE.md', import.meta.url), 'utf8'); }
    catch { refCache = ''; }
  }
  return refCache;
}

/** egy "## <cim>" fejezet (a kovetkezo ## -ig); `keepSub` = csak az ilyen elotagu ### alfejezetek maradnak */
export function refSection(md: string, startsWith: string, keepSub?: string): string {
  const lines = md.split('\n');
  const a = lines.findIndex(l => l.startsWith(`## ${startsWith}`));
  if (a < 0) return '';
  let b = lines.findIndex((l, i) => i > a && /^## /.test(l));
  if (b < 0) b = lines.length;
  const sec = lines.slice(a, b);
  if (!keepSub) return sec.join('\n');
  const out: string[] = []; let keep = true; let fence = false;
  for (const l of sec) {
    if (l.startsWith('```')) fence = !fence;
    if (!fence && /^### /.test(l)) keep = l.startsWith(`### ${keepSub}`);
    if (keep) out.push(l);
  }
  return out.join('\n');
}

/** a myIO Script nyelv (10/G, a felrecsuszott 10/E.6 nelkul) es a Flow (10/D) */
export const scriptReference = (md = apiReference()): string => refSection(md, '10/G.', '10/G');
export const flowReference = (md = apiReference()): string => refSection(md, '10/D.');

export interface DocChapter { id: string; title: string; text: string; }
/** a "## " fejezetek: id = "4", "10-a", "10-g" ... (szam nelkul: a cim slugja) */
export function docChapters(md = apiReference()): DocChapter[] {
  const lines = md.split('\n');
  const out: DocChapter[] = [];
  let fence = false;
  const starts: number[] = [];
  lines.forEach((l, i) => { if (l.startsWith('```')) fence = !fence; if (!fence && /^## /.test(l)) starts.push(i); });
  starts.forEach((a, k) => {
    const b = starts[k + 1] ?? lines.length;
    const title = lines[a].slice(3).replace(/\*\*/g, '').replace(/`/g, '').trim();
    const m = /^(\d+)(?:\/([A-Z]))?\./.exec(title);
    let id = m ? (m[2] ? `${m[1]}-${m[2].toLowerCase()}` : m[1]) : normalizeName(title).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    while (out.some(c => c.id === id)) id += '-x';
    out.push({ id, title, text: lines.slice(a, b).join('\n').trimEnd() });
  });
  return out;
}

/** cimszo-kereses: a ##/### fejezetek, amelyek cime tartalmazza a kerdest (ekezet- es kisbetu-fuggetlen) */
export function searchHeadings(query: string, md = apiReference(), max = 40_000): string {
  const q = normalizeName(query);
  const lines = md.split('\n');
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (!/^#{2,3} /.test(l) || !normalizeName(l).includes(q)) return;
    const lvl = l.indexOf(' ');
    let j = i + 1;
    while (j < lines.length && !(new RegExp(`^#{2,${lvl}} `).test(lines[j]))) j++;
    out.push(lines.slice(i, j).join('\n'));
  });
  const res = out.join('\n\n');
  return res.length > max ? res.slice(0, max) + '\n... (truncated - narrow the query)' : res;
}

export const headingList = (md = apiReference()): string[] => md.split('\n').filter(l => /^#{2,3} /.test(l));
