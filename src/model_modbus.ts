/**
 * Modbus busz-felderites + sablon-gyujtemeny (MODBUS_PLAN.md 9., D6 2026-11-18) - a web-felulet (SD_Files/js/modbus.js + mbtpl.js)
 * megfelelo logikajanak TS-parja, tiszta fuggvenyekkel (halozat nelkul; a tools/mbdisc.ts hasznalja):
 *   - azonosito alairasok (sablon.probe[]): nyers proba-adat dekodolasa, illesztes, a felderites probalistaja, sablon-tipp;
 *   - a felderites allapota / eredmenye (mbscan.json) olvashato szoveggel, a tanacs-kodok (H1..H13) szovegei;
 *   - sablon alkalmazasa parancsokka (az IRO-SLOTOK KIKAPCSOLVA jonnek letre), sablon az eszkoz soraibol, konnyu sema-ellenorzes.
 * A sablon-formatum leirasa: tools/mb_tpl_add.py fejlece (a V4-repoban) es az API-referencia 10/E.7.
 */
import { readFileSync } from 'node:fs';

type J = Record<string, unknown>;
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export const MB_BAUDS = [9600, 19200, 38400, 57600, 115200, 4800, 2400, 1200];
export const MB_FRAMES = ['8N1', '8E1', '8O1', '8N2'];
export const MB_CATS = ['meter', 'inverter', 'heatpump', 'sensor', 'hvac', 'io', 'other'];
export const MB_DT = ['-', 'u16', 'i16', 'u32', 'i32', 'f32', 'u64', 'i64', 'f64', 'bit', 'bool'];
export const MB_ORD = ['ABCD', 'CDAB', 'BADC', 'DCBA'];
export const MB_VERIFIED = ['starting point - check it against the device manual', 'community - tested on hardware', 'tested by myIO'];
const SDM_AB = ['P', 'U', 'I', 'S', 'Q', 'PF', 'phi'];
export const sdmName = (t: number): string => (t >= 201 && t <= 221 ? `SDM ${SDM_AB[Math.floor((t - 201) / 3)]} L${((t - 201) % 3) + 1}` : '');

export interface MbProbe { fc?: number; reg?: number; n?: number; ofs?: number; dt?: number; ord?: number; sc?: number; min?: number; max?: number; in?: number[]; hex?: string; opt?: number; id?: string; }
export interface MbBlk { func: number; start: number; count: number; period?: number; fast?: number; }
export interface MbFld { b: number; ofs: number; dt: number; ord?: number; bit?: number; sc?: number; sf?: number; n?: string; u?: string; s?: number; inv?: number; }
export interface MbWr { func: number; reg: number; dt?: number; ord?: number; mode?: number; off?: number; on?: number; per?: number; n?: string; }
export interface MbTemplate {
  id: string; name: string; vendor?: string; model?: string; cat?: string; ver?: number; date?: string; verified?: number; author?: string; manual?: string; addr?: number;
  baud: number; frame: number; notes_hu?: string; notes_en?: string; note?: string; probe?: MbProbe[]; fw?: string; blk: MbBlk[]; fld: MbFld[]; wr?: MbWr[];
}
/** egy sablon meta-adatai torzs nelkul (a CDN-index v2 sora / a csomagolt masolat / a vezerlo sajat fajlja) */
export interface MbMeta {
  id: string; src: 'cdn' | 'bundled' | 'own'; name: string; vendor: string; model: string; cat: string; verified: number; wr: number; manual: string;
  baud: number; frame: number; addr: number; ver: number; date: string; probe?: MbProbe[];
}

export const cleanName = (n: unknown): string => str(n).replace(/ \*$/, '').trim();
export function metaOfTemplate(t: MbTemplate, src: MbMeta['src']): MbMeta {
  return { id: t.id, src, name: cleanName(t.name) || t.id, vendor: t.vendor ?? '', model: t.model ?? '', cat: t.cat ?? '', verified: num(t.verified), wr: arr(t.wr).length, manual: t.manual ?? '',
    baud: num(t.baud), frame: num(t.frame, -1), addr: num(t.addr), ver: num(t.ver), date: t.date ?? '', probe: t.probe };
}
/** a CDN-index (v1: id/name/file/verified, v2: + vendor, model, cat, ver, date, manual, bus {baud, frame "8N1", addr}, wr, probe) egy sora */
export function metaOfIndex(e: J): MbMeta | null {
  const id = str(e.id); if (!id) return null;
  const bus = (e.bus as J) ?? {};
  const fr = typeof bus.frame === 'string' ? MB_FRAMES.indexOf(bus.frame) : num(bus.frame, -1);
  return { id, src: 'cdn', name: cleanName(e.name) || id, vendor: str(e.vendor), model: str(e.model), cat: str(e.cat), verified: num(e.verified), wr: typeof e.wr === 'number' ? e.wr : arr(e.wr).length,
    manual: str(e.manual), baud: num(bus.baud), frame: fr, addr: num(bus.addr), ver: num(e.ver), date: str(e.date), probe: Array.isArray(e.probe) ? (e.probe as MbProbe[]) : undefined };
}

// ---- a csomagolt sablon-masolat (modbus_templates.json = a V4-repo WEB_cdn/modbus/ pillanatkepe, `npm run sync-modbus`) ---------------
let bundleCache: Record<string, MbTemplate> | undefined;
export function bundledTemplates(): Record<string, MbTemplate> {
  if (bundleCache === undefined) {
    try { bundleCache = (JSON.parse(readFileSync(new URL('../modbus_templates.json', import.meta.url), 'utf8')) as { tpl?: Record<string, MbTemplate> }).tpl ?? {}; }
    catch { bundleCache = {}; }
  }
  return bundleCache;
}

// ---- azonosito alairas (probe) ----------------------------------------------------------------------------------------------
export const probeLen = (dt: number): number => (dt >= 3 && dt <= 5 ? 2 : dt >= 6 && dt <= 8 ? 4 : 1);       // regiszter / ertek
export const probeNeed = (p: MbProbe): number => (p.ofs ?? 0) + (p.hex ? Math.ceil(p.hex.length / 4) : probeLen(p.dt ?? 1));
/** nyers proba-adat (hex, a vezetek sorrendjeben) -> szam: dt 1 u16 .. 5 f32, 6..8 64 bites; ord 0 ABCD / 1 CDAB / 2 BADC / 3 DCBA */
export function probeVal(hex: string, dt: number, ord = 0): number {
  const n = probeLen(dt) * 2;
  if (!hex || hex.length < n * 2) return NaN;
  let b = Buffer.from(hex.slice(0, n * 2), 'hex');
  if (b.length < n) return NaN;
  if (ord === 3) b = Buffer.from(b).reverse();
  else if (ord === 2) { const t = Buffer.from(b); for (let i = 0; i + 1 < n; i += 2) { t[i] = b[i + 1]; t[i + 1] = b[i]; } b = t; }
  else if (ord === 1) { const t = Buffer.alloc(n); for (let i = 0; i < n; i += 2) b.copy(t, n - 2 - i, i, i + 2); b = t; }
  switch (dt) {
    case 2: return b.readInt16BE(0);
    case 3: return b.readUInt32BE(0);
    case 4: return b.readInt32BE(0);
    case 5: return b.readFloatBE(0);
    case 6: return b.readUInt32BE(0) * 4294967296 + b.readUInt32BE(4);
    case 7: return b.readInt32BE(0) * 4294967296 + b.readUInt32BE(4);
    case 8: return b.readDoubleBE(0);
    default: return b.readUInt16BE(0);
  }
}
export function probeOk(hex: string, p: MbProbe): boolean {
  const hx = hex.slice((p.ofs ?? 0) * 4);
  if (p.hex) return hx.slice(0, p.hex.length).toLowerCase() === p.hex.toLowerCase();
  let v = probeVal(hx, p.dt ?? 1, p.ord ?? 0);
  if (Number.isNaN(v)) return false;
  if (p.sc) v = v * Math.pow(10, p.sc);
  if (p.in) return p.in.includes(v);
  return (typeof p.min !== 'number' || v >= p.min) && (typeof p.max !== 'number' || v <= p.max);
}
export interface ProbeSlot { i: number; fc: number; reg: number; n: number; }
export interface ScanDev { addr: number; id: string[]; pr: { i: number; st: number; hex: string }[]; }
/** mennyire illik egy alairas a talalt eszkozre: 0 = nem illik / nem tudhato. Egyezo olvasas +1, egyezo Device ID +3; ami a panelen
 *  nem futott (nincs a slots kozt), az semleges; a nem egyezo vagy valasz nelkuli olvasas kizar - kiveve az `opt` jelut. */
export function tplScore(dev: ScanDev, slots: ProbeSlot[], probe: MbProbe[] | undefined): number {
  if (!probe) return 0;
  let s = 0;
  for (const p of probe) {
    if (p.id) {
      const ids = (dev.id ?? []).join(' ').replace(/\s+/g, ' ').trim();
      if (!ids) continue;
      let r = false;
      try { r = new RegExp(p.id, 'i').test(ids); } catch { r = false; }
      if (r) s += 3; else if (!p.opt) return 0;
      continue;
    }
    const slot = slots.find(x => x.fc === p.fc && x.reg === p.reg && x.n >= probeNeed(p));
    if (!slot) continue;
    const hx = dev.pr.find(x => x.i === slot.i && x.st === 1)?.hex ?? '';
    if (hx && probeOk(hx, p)) s++; else if (!p.opt) return 0;
  }
  return s;
}
/** a legjobban illo sablon (a legtobb pont; holtversenynel az ellenorzottebb, aztan a lista sorrendje) */
export function guessTemplate(dev: ScanDev, slots: ProbeSlot[], metas: MbMeta[]): MbMeta | undefined {
  let best: MbMeta | undefined, bs = 0;
  for (const m of metas) {
    const s = tplScore(dev, slots, m.probe);
    if (s > bs || (s && s === bs && best && m.verified > best.verified)) { best = m; bs = s; }
  }
  return best;
}
const fold = (t: string): string => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
/** a felderites probalistaja (max 8 olvasas): elol azok a sablonok, amikre a megjegyzes ("mit kotottel ra") illik, aztan az ellenorzottek;
 *  azonos olvasas egyszer (n = a nagyobb); a vegen, ha fer, holding 0..1 (altalanos adat az elemzeshez) */
export function probeList(metas: MbMeta[], note = ''): { fc: number; reg: number; n: number }[] {
  const words = fold(note).split(/[^a-z0-9]+/).filter(w => w.length >= 3);
  const cand = metas.filter(m => m.probe?.length).map((m, o) => {
    const hay = fold(`${m.name} ${m.vendor} ${m.model} ${m.id}`);
    return { p: m.probe!, pri: words.filter(w => hay.includes(w)).length * 10 + m.verified, o };
  }).sort((x, y) => y.pri - x.pri || x.o - y.o);
  const list: { fc: number; reg: number; n: number }[] = [];
  for (const c of cand) for (const p of c.p) {
    if (!(p.fc && p.fc >= 1 && p.fc <= 4) || p.reg === undefined) continue;
    const need = Math.max(p.n ?? 0, probeNeed(p));
    if (need > (p.fc <= 2 ? 64 : 4)) continue;
    const have = list.find(x => x.fc === p.fc && x.reg === p.reg);
    if (have) { if (need > have.n) have.n = need; }
    else if (list.length < 8) list.push({ fc: p.fc, reg: p.reg, n: need });
  }
  if (list.length < 8 && !list.some(x => x.fc === 3 && x.reg === 0)) list.push({ fc: 3, reg: 0, n: 2 });
  return list;
}
/** a probalista parancsai: csak ami elter attol, amit a vezerlo mar tud (mbscan.json "probes"); ha a vezerlo semmit nem tud, mind a 8 hely megy */
export function probeCmds(panel: number, list: { fc: number; reg: number; n: number }[], have: ProbeSlot[]): string[] {
  const cmds: string[] = [];
  for (let i = 0; i < 8; i++) {
    const want = list[i] ?? { fc: 0, reg: 0, n: 0 }, cur = have.find(x => x.i === i);
    if (cur ? cur.fc === want.fc && cur.reg === want.reg && cur.n === want.n : have.length > 0 && !want.fc) continue;
    cmds.push(`mb_dprobe*${panel}*${i}*${want.fc}*${want.reg}=${want.n}`);
  }
  return cmds;
}
export function probeText(p: MbProbe): string {
  if (p.id) return `Device ID ~ /${p.id}/`;
  let t = `FC${p.fc} @${p.reg}${p.ofs ? `+${p.ofs}` : ''}`;
  if (p.hex) t += ` = ${p.hex}`;
  else {
    t += ` (${MB_DT[p.dt ?? 1]}${p.ord ? ` ${MB_ORD[p.ord]}` : ''}${p.sc ? ` x10^${p.sc}` : ''})`;
    t += p.in ? ` in {${p.in.join(', ')}}` : ` ${typeof p.min === 'number' ? p.min : ''}..${typeof p.max === 'number' ? p.max : ''}`;
  }
  return t + (p.opt ? ' (optional)' : '');
}

// ---- a felderites allapota / eredmenye (mbscan.json egy panelje) -----------------------------------------------------------------
const PHASE = ['', 'listening on the bus', 'checking the known devices', 'scanning', 'identifying', 'final check'];
const STATE = ['never run', 'RUNNING', 'DONE', 'STOPPED', 'NOT STARTED: another master is talking on the bus'];
const FP = ['not tried', 'ok', 'exception', 'silent'];
export const HINT_TEXT: Record<string, string> = {
  H1: 'Only the already connected device(s) answer (address %1). The new one is probably on the same factory address: disconnect the old device(s) (A/B wires), search again, give the new one another address (see its manual), then reconnect the old one.',
  H2: 'Garbled answers from one address: two devices may share an address - disconnect one of them.',
  H3: 'A and B are swapped: the device answers only with reversed polarity. Set the A/B polarity of the bus to automatic or swapped, or swap the two wires.',
  H4: 'No signal at all: check the power, the A/B wiring, GND and the termination; is the Modbus port enabled on the device (often a menu setting); is it really Modbus RTU?',
  H5: 'Bytes arrive but make no sense: a speed outside the list, not Modbus RTU (ASCII, M-Bus, proprietary), or interference / missing termination. A deep search may find it.',
  H6: 'Another master is talking on the bus (%1; addresses: %2). Two masters collide - this device needs its own bus / panel.',
  H7: 'The new device is on another setting (%1) than the bus (%2). One bus has one speed: change it on the device, or use this setting for the bus.',
  H8: 'Slow answers (up to %1 ms): set the bus timeout to at least %2 ms.',
  H9: 'The device is alive but register 0 is not readable - that is normal, its register map is needed.',
  H12: 'A device answered at the start but not at the end (address %1): it may have locked up from the frames sent at other speeds - switch its power off and on.',
  H13: 'The new device is wired with A/B reversed compared with the others - swap the two wires on it (software cannot fix it because the others are right).',
};
const combo = (o: J): string => `${num(o.baud)} ${str(o.frame)}${num(o.pol) ? ' (A/B swapped)' : ''}`;
const secs = (s: number): string => (s < 90 ? `${s} s` : `${Math.round(s / 60)} min`);
export const isRunning = (p: J | undefined): boolean => num((p?.run as J)?.st) === 1;
/** a tanacs-kodok szoveggel (a parameterek a web-felulettel azonosan az eszkozlistabol) */
export function hintLines(p: J): string[] {
  const devs = arr<J>(p.dev), bus = (p.bus as J) ?? {}, sniff = p.sniff as J | null;
  const known = devs.filter(d => num(d.known) && num(d.ans)).map(d => num(d.addr));
  const stuck = devs.filter(d => num(d.stuck)).map(d => num(d.addr));
  const combos = [...new Set(devs.filter(d => num(d.new) && num(d.ans) && (d.baud !== bus.baud || d.frame !== bus.frame)).map(d => `${num(d.baud)} ${str(d.frame)}`))];
  const dmax = Math.max(0, ...devs.map(d => num(d.delay)));
  return arr<string>(p.hints).map(code => {
    let t = HINT_TEXT[code]; if (!t) return `${code}`;
    if (code === 'H1') t = t.replace('%1', known.join(', '));
    if (code === 'H6') t = t.replace('%1', sniff && num(sniff.baud) ? combo(sniff) : '?').replace('%2', sniff && arr(sniff.addr).length ? arr<number>(sniff.addr).join(', ') : '?');
    if (code === 'H7') t = t.replace('%1', combos.join(', ')).replace('%2', `${num(bus.baud)} ${str(bus.frame)}`);
    if (code === 'H8') t = t.replace('%1', String(dmax)).replace('%2', String(Math.ceil((dmax * 1.5 + 50) / 10) * 10));
    if (code === 'H12') t = t.replace('%1', stuck.join(', '));
    return `${code}: ${t}`;
  });
}
const hexDecodes = (hx: string): string => {
  if (hx.length === 4) { const u = parseInt(hx, 16); return `u16 ${u}${u > 32767 ? ` / i16 ${u - 65536}` : ''}`; }
  if (hx.length === 8) { const f = probeVal(hx, 5), u = probeVal(hx, 3); return `${Number.isFinite(f) && Math.abs(f) >= 1e-3 && Math.abs(f) < 1e7 ? `f32 ${Math.round(f * 1000) / 1000} / ` : ''}u32 ${u} / u16 ${parseInt(hx.slice(0, 4), 16)}, ${parseInt(hx.slice(4), 16)}`; }
  return '';
};
/** a futo felderites egy sora (status / wait) */
export function discStatusLine(p: J): string {
  const run = p.run as J | null;
  if (!num(p.cap)) return `panel #${num(p.a)}: this panel firmware has no bus discovery (needs panel firmware 0.8+)`;
  if (!run || !num(run.st)) return `panel #${num(p.a)}: no discovery has run yet${num(p.on) ? '' : ' (panel OFFLINE)'}`;
  if (num(run.st) === 1) return `panel #${num(p.a)}: discovery RUNNING (${num(run.mode) ? 'deep' : 'search'}) - ${PHASE[num(run.ph)] ?? ''}: ${combo(run)}${num(run.ph) === 3 ? `, address ${num(run.addr)}` : ''}, ${num(run.pct)} % (${secs(num(run.el))} of ~${secs(num(run.tot))}); new devices so far: ${num(p.nnew)}`;
  return `panel #${num(p.a)}: discovery ${STATE[num(run.st)] ?? run.st} (${num(run.mode) ? 'deep' : 'search'}, ${secs(num(run.el))}) - new devices: ${num(p.nnew)}, known: ${num(p.ndev) - num(p.nnew)}${num(p.detail) ? '' : ' (details are still being read from the panel - ask again in a few seconds)'}`;
}
/** a teljes eredmeny szoveggel: allapot, busz, jelzok, tanacsok, eszkozok (ujjlenyomat, azonosito, nyers probak), sablon-tipp, kovetkezo lepesek */
export function discResultText(p: J, metas: MbMeta[], known: Map<number, string> = new Map()): string {
  const L = [discStatusLine(p)];
  const run = p.run as J | null;
  if (!run || !num(run.st)) return L[0];
  const bus = (p.bus as J) ?? {}, slots = arr<ProbeSlot>(p.probes), devs = arr<J>(p.dev);
  L.push(`  bus setting before the run: ${combo(bus)}${str(p.note) ? `; installer's note: "${str(p.note)}"` : ''}`);
  if (arr(p.flags).length) L.push(`  flags: ${arr<string>(p.flags).join(', ')}`);
  const hints = hintLines(p);
  if (hints.length) L.push('  advice:', ...hints.map(h => `    ${h}`));
  if (!devs.length) L.push('  no device in the result');
  const next: string[] = [];
  const running = num(run.st) === 1;
  const tableAddrs = new Set(devs.filter(d => num(d.known)).map(d => num(d.addr)));
  for (const d of devs) {
    // A/B: a panel jelzoje (D_OTHER_POL 0x20) - automatikus A/B modban rogzites nelkul a pol mezo nem mervado (MODBUS_PLAN 9.12 / 5. lelet)
    const opol = !!(num(d.fl) & 0x20);
    const isNew = !!num(d.new), same = d.baud === bus.baud && d.frame === bus.frame && !opol, addr = num(d.addr);
    const st = [isNew ? 'NEW' : `known${known.get(addr) ? ` ("${known.get(addr)}")` : ''}`, num(d.ans) ? `answers${num(d.delay) ? ` (~${num(d.delay)} ms)` : ''}` : 'NO ANSWER'];
    if (num(d.garbled)) st.push('garbled answers'); if (num(d.stuck)) st.push('STOPPED ANSWERING during the run'); if (num(d.slow)) st.push('slow');
    if (isNew && opol) st.push('A/B reversed'); if (isNew && (d.baud !== bus.baud || d.frame !== bus.frame)) st.push('other bus setting');
    const fp = arr<number>(d.fp), ids = arr<string>(d.id).filter(Boolean);
    L.push(`  address ${addr} @ ${combo({ ...d, pol: opol ? 1 : 0 })} - ${st.join(', ')}`);
    if (num(d.ans)) L.push(`     functions: ${fp.map((v, i) => `FC${i + 1} ${FP[v] ?? v}`).join(', ')}${num(d.exc) ? `; first exception code ${num(d.exc)}` : ''}; Device ID: ${ids.length ? ids.join(' / ') : 'none'}${str(d.sid) ? `; Server ID (hex) ${str(d.sid)}` : ''}`);
    const pr = arr<{ i: number; st: number; hex: string }>(d.pr);
    if (pr.length) L.push('     probe reads: ' + pr.map(x => { const s = slots.find(q => q.i === x.i); const w = s ? `FC${s.fc} @${s.reg} x${s.n}` : `#${x.i}`; return x.st === 1 ? `${w} = ${x.hex}${hexDecodes(x.hex) ? ` (${hexDecodes(x.hex)})` : ''}` : `${w} = exception`; }).join('; '));
    if (isNew && num(d.ans) && running && !pr.length) L.push('     identification (Device ID, probe reads, template match) follows at the end of the run');
    else if (isNew && num(d.ans) && !same && tableAddrs.has(addr)) {
      // a cim mar a tablaban (ismert eszkoz, ami a regi beallitason most nem valaszolt): valoszinuleg UGYANAZ az eszkoz mas beallitason
      L.push('     this address is already in the table: probably the same device on another bus setting');
      next.push(`address ${addr} is already in the table and now answers on ${combo(d)}: it is probably the same device with changed settings - set the bus to it (myio_modbus_set action=bus panel=${num(p.a)} baud=${MB_BAUDS.indexOf(num(d.baud))} frame=${MB_FRAMES.indexOf(str(d.frame))}; ask first, devices on the old setting stop answering) and the existing rows work again - no template needed; or change the device back`);
    } else if (isNew && num(d.ans)) {
      const g = guessTemplate({ addr, id: arr<string>(d.id), pr }, slots, metas);
      if (g) {
        L.push(`     looks like: template "${g.id}" - ${g.name} [${MB_VERIFIED[Math.min(g.verified, 2)]}]${g.wr ? ' - it also WRITES to the device' : ''}`);
        next.push(same ? `add it: myio_modbus_templates action=apply id=${g.id} panel=${num(p.a)} slave=${addr}`
          : `address ${addr} is on ${combo(d)}: either set the bus to it (myio_modbus_set action=bus panel=${num(p.a)} baud=${MB_BAUDS.indexOf(num(d.baud))} frame=${MB_FRAMES.indexOf(str(d.frame))}; devices on the old setting stop answering) or change the device, then myio_modbus_templates action=apply id=${g.id} panel=${num(p.a)} slave=${addr}`);
      } else {
        L.push('     no template signature matches');
        next.push(`address ${addr}: unknown device - ask the installer what it is, look for it with myio_modbus_templates action=list query=..., otherwise find its Modbus register map on the web${ids.length ? ` ("${ids.slice(0, 2).join(' ')} modbus register map")` : ''} and verify 2-3 registers with myio_modbus_set action=raw before building blocks and fields`);
      }
    }
  }
  if (next.length && num(run.st) !== 1) L.push('  next:', ...next.map(n => `    - ${n}`));
  return L.join('\n');
}

// ---- sablon -> parancsok (js/modbus.js mbTplApply parja) ------------------------------------------------------------------------
export interface ApplyOpts { bus?: boolean; toSdm?: boolean; }
export interface ApplyPlan { cmds: string[]; blocks: number[]; fields: number[]; writers: number[]; warnings: string[]; }
const u16 = (lo: number, hi: number) => lo | (hi << 8);
/** a panel (modbus.json egy panels[] eleme) szabad soraira: blokkok / mezok (nevvel) / iro-slotok + az eszkoz neve es sablonja.
 *  Az IRO-SLOT KIKAPCSOLVA jon letre (flags b0 = 0): a sablon parancsot kuldene az eszkoznek - a felhasznalo kapcsolja be. */
export function applyPlan(pn: J, tpl: MbTemplate, slave: number, o: ApplyOpts = {}): ApplyPlan | string {
  if (!(slave >= 1 && slave <= 247)) return 'slave must be 1..247';
  const a = num(pn.a), blk = arr<number[]>(pn.blk), fld = arr<number[]>(pn.fld), wr = arr<number[]>(pn.wr), cfg = arr<number>(pn.cfg), twr = arr<MbWr>(tpl.wr);
  const freeB = blk.map((b, i) => (b[0] ? -1 : i)).filter(i => i >= 0), freeF = fld.map((f, i) => (f[0] !== 255 ? -1 : i)).filter(i => i >= 0), freeW = wr.map((w, i) => (w[0] ? -1 : i)).filter(i => i >= 0);
  if (freeB.length < tpl.blk.length || freeF.length < tpl.fld.length || freeW.length < twr.length)
    return `not enough free rows on panel #${a} for "${tpl.id}": needs ${tpl.blk.length} blocks / ${tpl.fld.length} fields / ${twr.length} write slots, free ${freeB.length} / ${freeF.length} / ${freeW.length}`;
  const fast = !!(num(pn.feat) & 16), warnings: string[] = [], cmds: string[] = [];
  if (blk.some(b => b[0] === slave) || wr.some(w => w[0] === slave)) warnings.push(`slave address ${slave} already had rows on panel #${a}: the template rows were ADDED to that device`);
  const enc = (s: string) => encodeURIComponent(s);
  if (o.bus) { let bi = MB_BAUDS.indexOf(tpl.baud); if (bi < 0) bi = 0; cmds.push(`mb_cfg*${a}*${bi}*${tpl.frame || 0}*25*1*10=${num(cfg[5]) & 15}`); }
  const bmap = tpl.blk.map((b, k) => {
    const i = freeB[k];
    if (b.fast && !fast) warnings.push(`block ${i}: the template asks for a fast (x0.1 s) block but this panel firmware has none - created with a period of ${b.period ?? 1} s`);
    cmds.push(`mb_blk*${a}*${i}*${slave}*${b.func}*${b.start}*${b.count}*${b.period ?? 1}=${1 | (b.fast && fast ? 2 : 0)}`);
    return i;
  });
  const fields = tpl.fld.map((f, m) => {
    const i = freeF[m], sf = typeof f.sf === 'number' && f.sf >= 0 ? f.sf : 255, mod = (f.ord ?? 0) | ((f.bit ?? 0) << 4);
    cmds.push(`mb_fld*${a}*${i}*${bmap[f.b]}*${f.ofs}*${f.dt}*${mod}*${f.sc ?? 0}*${sf}*${o.toSdm && f.s ? f.s : 0}=${1 | (f.inv ? 2 : 0)}`);
    cmds.push(`mb_n${a}_${i}=${enc(`${f.n ?? ''}${f.u ? ` ${f.u}` : ''}`.slice(0, 16))}`);
    return i;
  });
  const writers = twr.map((w, n) => {
    const i = freeW[n], mod = (w.ord ?? 0) | (w.mode ? 16 : 0) | 32;       // push-forras: az elemet a felhasznalo valasztja utana
    cmds.push(`mb_wr*${a}*${i}*${slave}*${w.func}*${w.reg}*${w.dt ?? 1}*${mod}*${w.off ?? 0}*${w.on ?? 1}*${w.per ?? 0}=0`);
    if (w.n) cmds.push(`mb_w${a}_${i}=${enc(w.n.slice(0, 16))}`);
    return i;
  });
  if (twr.length) warnings.push(`this template also WRITES to the device: ${twr.length} write slot(s) were created DISABLED - choose their source, have the user confirm each register against the device manual, then enable them`);
  if (pn.dev !== undefined) {
    cmds.push(`mb_dt${a}_${slave}=${enc(tpl.id.slice(0, 16))}`);
    if (!arr<J>(pn.dev).some(d => num(d.a) === slave && str(d.n))) cmds.push(`mb_dn${a}_${slave}=${enc(cleanName(tpl.name).slice(0, 24))}`);
  }
  if (cmds.some(c => c.includes('%26'))) return 'a name in the template contains "&" - the controller cannot receive that character';
  return { cmds, blocks: bmap, fields, writers, warnings };
}

// ---- az eszkoz sorai -> sablon (js/modbus.js mbTplFromDev + mbtpl.js mbtBuild parja) ----------------------------------------------
const UNIT = /^(.*\S)\s+(V|A|W|kW|kWh|Wh|VA|kVA|var|kvar|Hz|°C|%|bar|Pa|ppm|lux|rpm|K|l\/h|m3|m³)$/;
export function templateFromDevice(pn: J, slave: number, meta: Partial<MbTemplate> & { id: string; name: string }): MbTemplate | string {
  const blk = arr<number[]>(pn.blk), fld = arr<number[]>(pn.fld), wr = arr<number[]>(pn.wr), fn = arr<string>(pn.fn), wn = arr<string>(pn.wn), cfg = arr<number>(pn.cfg);
  const bl = blk.map((b, i) => (b[0] === slave ? i : -1)).filter(i => i >= 0);
  const wl = wr.map((w, i) => (w[0] === slave ? i : -1)).filter(i => i >= 0);
  if (!bl.length && !wl.length) return `no blocks or write slots for slave address ${slave} on panel #${num(pn.a)}`;
  const t: MbTemplate = { id: meta.id, name: meta.name, vendor: meta.vendor ?? '', model: meta.model ?? '', cat: meta.cat ?? 'other', ver: meta.ver ?? 1, date: meta.date ?? new Date().toISOString().slice(0, 10),
    verified: meta.verified ? 1 : 0, baud: MB_BAUDS[num(cfg[0])] ?? 9600, frame: num(cfg[1]), blk: [], fld: [], wr: [] };
  if (meta.author) t.author = meta.author;
  if (meta.manual) t.manual = meta.manual;
  if (meta.addr) t.addr = meta.addr;
  if (meta.notes_hu) t.notes_hu = meta.notes_hu;
  if (meta.notes_en) t.notes_en = meta.notes_en;
  if (meta.probe?.length) t.probe = meta.probe;
  for (const i of bl) { const e = blk[i]; const b: MbBlk = { func: e[1], start: u16(e[2], e[3]), count: e[4], period: e[5] }; if (e[6] & 2) b.fast = 1; t.blk.push(b); }
  fld.forEach((e, i) => {
    if (e[0] === 255 || !bl.includes(e[0])) return;
    const f: MbFld = { b: bl.indexOf(e[0]), ofs: e[1], dt: e[2], n: fn[i] || sdmName(e[6]) || `#${i}`, u: '' };
    const m = UNIT.exec(f.n ?? ''); if (m) { f.n = m[1]; f.u = m[2]; }
    if (e[3] & 3) f.ord = e[3] & 3; if (e[3] >> 4) f.bit = e[3] >> 4;
    if (e[4]) f.sc = e[4] > 127 ? e[4] - 256 : e[4];
    if (e[5] !== 255) f.sf = e[5];
    if (e[6] >= 201 && e[6] <= 221) f.s = e[6];
    if (e[7] & 2) f.inv = 1;
    t.fld.push(f);
  });
  for (const i of wl) { const e = wr[i]; t.wr!.push({ func: e[1], reg: u16(e[2], e[3]), dt: e[4], ord: e[5] & 3, mode: e[5] & 16 ? 1 : 0, off: u16(e[6], e[7]), on: u16(e[8], e[9]), per: e[10], n: wn[i] || '' }); }
  return t;
}
/** azonosito alairas javaslata az eszkoz ELO ertekeibol (mint a web-felulet mbtProbeFrom-ja): feszultseg + frekvencia, kulonben ho / para */
export function probeFromDevice(pn: J, slave: number): MbProbe[] {
  const blk = arr<number[]>(pn.blk), fld = arr<number[]>(pn.fld), fn = arr<string>(pn.fn), val = arr<unknown[]>(pn.val);
  let volt: MbProbe | undefined, freq: MbProbe | undefined; const weak: MbProbe[] = [], seen = new Set<string>();
  fld.forEach((e, i) => {
    const b = blk[e[0]], v = val[i];
    if (e[0] === 255 || !b || b[0] !== slave || (b[1] !== 3 && b[1] !== 4) || !v || num(v[1]) !== 1) return;
    if (e[2] < 1 || e[2] > 5 || e[5] !== 255) return;
    const u = (/\s(V|Hz|°C|%)$/.exec(fn[i] ?? '') ?? [])[1] ?? '', x = num(v[0], NaN);
    let rng: [number, number] | undefined, kind = 0;
    if ((u === 'V' || (e[6] >= 204 && e[6] <= 206)) && x >= 80 && x <= 300) { rng = [50, 500]; kind = 1; }
    else if (u === 'Hz' && x >= 45 && x <= 65) { rng = [40, 70]; kind = 2; }
    else if (u === '°C' && x >= -40 && x <= 125) rng = [-40, 125];
    else if (u === '%' && x >= 0 && x <= 100) rng = [0, 100];
    if (!rng) return;
    const p: MbProbe = { fc: b[1], reg: u16(b[2], b[3]) + e[1], n: probeLen(e[2]), dt: e[2] };
    if (seen.has(`${p.fc}:${p.reg}`)) return; seen.add(`${p.fc}:${p.reg}`);
    if (e[3] & 3) p.ord = e[3] & 3;
    const sc = e[4] > 127 ? e[4] - 256 : e[4]; if (sc) p.sc = sc;
    p.min = rng[0]; p.max = rng[1];
    if (kind === 1) volt ??= p; else if (kind === 2) freq ??= p; else weak.push(p);
  });
  const out = [volt, freq].filter((p): p is MbProbe => !!p);
  for (const w of weak) if (out.length < 2) out.push(w);
  return out;
}

// ---- konnyu sema-ellenorzes (a teljes a V4-repo tools/mb_tpl_add.py-jaban; itt az, ami a vezerlore irashoz kell) -------------------
export function checkTemplate(t: unknown): string[] {
  const e: string[] = [];
  if (!t || typeof t !== 'object') return ['the template is not a JSON object'];
  const o = t as MbTemplate;
  if (typeof o.id !== 'string' || !/^[a-z0-9_-]{1,16}$/.test(o.id)) e.push('id must be 1..16 characters of a-z, 0-9, _ -');
  if (typeof o.name !== 'string' || !o.name.trim() || o.name.length > 64) e.push('name is required (max 64 characters)');
  if (!MB_BAUDS.includes(o.baud)) e.push(`baud must be one of ${MB_BAUDS.slice().sort((a, b) => a - b).join(', ')}`);
  if (!(Number.isInteger(o.frame) && o.frame >= 0 && o.frame <= 3)) e.push('frame must be 0 (8N1), 1 (8E1), 2 (8O1) or 3 (8N2)');
  if (o.cat !== undefined && !MB_CATS.includes(o.cat)) e.push(`cat must be one of ${MB_CATS.join(', ')}`);
  if (o.manual && !/^https?:\/\/\S+$/i.test(o.manual)) e.push('manual must be an http(s) link');
  if (!Array.isArray(o.blk) || !o.blk.length || o.blk.length > 16) e.push('blk: 1..16 blocks');
  if (!Array.isArray(o.fld) || o.fld.length > 64) e.push('fld: at most 64 fields');
  if (o.wr !== undefined && (!Array.isArray(o.wr) || o.wr.length > 32)) e.push('wr: at most 32 write slots');
  if (!Array.isArray(o.blk) || !Array.isArray(o.fld) || (o.wr !== undefined && !Array.isArray(o.wr))) return e;
  o.blk.forEach((b, i) => { if (!(b.func >= 1 && b.func <= 4) || !(b.start >= 0 && b.start <= 65535) || !(b.count >= 1 && b.count <= 125)) e.push(`blk[${i}]: func 1..4, start 0..65535, count 1..125`); });
  o.fld.forEach((f, i) => {
    const b = o.blk[f.b];
    if (!b) { e.push(`fld[${i}]: block index ${f.b} does not exist`); return; }
    if (!(f.dt >= 1 && f.dt <= 10)) e.push(`fld[${i}]: dt 1..10`);
    else if (f.ofs + (f.dt >= 9 || b.func <= 2 ? 1 : probeLen(f.dt)) > b.count) e.push(`fld[${i}]: offset + length is outside its block`);
    if (`${f.n ?? ''}${f.u ? ` ${f.u}` : ''}`.includes('&')) e.push(`fld[${i}]: the name cannot contain "&"`);
  });
  (o.wr ?? []).forEach((w, i) => { if (![5, 6, 16].includes(w.func) || !(w.reg >= 0 && w.reg <= 65535)) e.push(`wr[${i}]: func 5 / 6 / 16, reg 0..65535`); });
  (o.probe ?? []).forEach((p, i) => {
    if (p.id) { try { new RegExp(p.id); } catch { e.push(`probe[${i}]: id is not a valid regular expression`); } return; }
    if (!(p.fc && p.fc >= 1 && p.fc <= 4) || p.reg === undefined) e.push(`probe[${i}]: fc 1..4 and reg are required`);
    else if (probeNeed(p) > (p.fc <= 2 ? 64 : 4)) e.push(`probe[${i}]: one probe can read at most 4 registers`);
  });
  if ((o.probe ?? []).length > 8) e.push('probe: at most 8 entries');
  return e;
}

/** a sablon olvashato leirasa (get): meta, busz, megjegyzes, regisztertabla, iro-slotok, alairas */
export function templateText(t: MbTemplate, src: string): string {
  const L = [`Template "${t.id}" - ${cleanName(t.name)} [${src}${src === 'own' ? '' : `; ${MB_VERIFIED[Math.min(num(t.verified), 2)]}`}]`];
  L.push(`  ${[t.vendor, t.model].filter(Boolean).join(' / ') || '-'}; category ${t.cat ?? '-'}; version ${t.ver ?? '-'}${t.date ? `, ${t.date}` : ''}${t.author ? `, by ${t.author}` : ''}`);
  L.push(`  bus: ${t.baud} baud ${MB_FRAMES[t.frame] ?? t.frame}${t.addr ? `, factory address ${t.addr}` : ''}${t.manual ? `; manual: ${t.manual}` : ''}`);
  const note = t.notes_hu || t.notes_en || t.note;
  if (t.notes_hu) L.push(`  notes (hu): ${t.notes_hu}`);
  if (t.notes_en) L.push(`  notes (en): ${t.notes_en}`);
  if (!t.notes_hu && !t.notes_en && note) L.push(`  notes: ${note}`);
  L.push('  blocks: ' + t.blk.map((b, i) => `${i}: FC${b.func} @${b.start} x${b.count} every ${b.period ?? 1}${b.fast ? ' x0.1' : ''} s`).join('; '));
  L.push('  fields (0-based register addresses):');
  for (const f of t.fld) {
    const b = t.blk[f.b] ?? { func: 0, start: 0 };
    L.push(`    ${f.n ?? ''}${f.u ? ` [${f.u}]` : ''}: FC${b.func} @${b.start + f.ofs} ${MB_DT[f.dt] ?? f.dt}${probeLen(f.dt) > 1 ? ` ${MB_ORD[f.ord ?? 0]}` : ''}${f.dt === 9 ? ` bit ${f.bit ?? 0}` : ''}${f.sc ? ` x10^${f.sc}` : ''}${typeof f.sf === 'number' && f.sf >= 0 ? ` SF@${b.start + f.sf}` : ''}${f.s ? ` -> ${sdmName(f.s)}` : ''}`);
  }
  const wr = arr<MbWr>(t.wr);
  if (wr.length) {
    L.push(`  WRITE SLOTS (${wr.length}) - commands to the device; created DISABLED when the template is applied:`);
    for (const w of wr) L.push(`    ${w.n ?? ''}: FC${w.func} @${w.reg} ${MB_DT[w.dt ?? 1]} ${w.mode ? `level 0..255 -> ${w.off ?? 0}..${w.on ?? 1}` : `off ${w.off ?? 0} / on ${w.on ?? 1}`}${w.per ? `, rewrite every ${w.per} s` : ''}`);
  }
  if (t.probe?.length) L.push('  identification signature: ' + t.probe.map(probeText).join('; '));
  return L.join('\n');
}

export const GUIDE = `Modbus device setup - work order for the assistant (Ext-RS485 panel, controller firmware 4.29+)
1. Ask the installer what was connected (make, model, what the label says) and what they want from it (which values, any control).
2. Look in the template collection: myio_modbus_templates action=list query=<make or model>. If there is a template, go to step 6.
3. Start a Search: myio_modbus_discover action=start panel=<n> note="<make model>". It takes about 1.5-2 minutes and Modbus PAUSES on
   that panel while it runs (measured values, writes) - say so first. Use action=wait to be told as soon as a new device appears or
   the run ends, then action=result.
4. Follow the advice in the result: H1 only the old device answers -> have them disconnect it (A/B), search again, re-address the new
   one, reconnect; H3 / H13 A and B swapped; H4 no signal -> wiring, power, is the Modbus port enabled on the device; H6 another master
   on the bus; H7 the new device is on another bus setting; H12 a device locked up -> power-cycle it.
   If the Search finds nothing new: ASK before a Deep search. Call action=estimate mode=deep and tell them the time (20-40 minutes);
   start it only after a yes (confirm=true). It stops by itself after the first new device; action=stop ends it any time.
5. Unknown device: find its Modbus register map / manual on the web (your own web search - the controller cannot browse). Summarise
   it in the user's language: bus settings, how to change the address and speed, the register table, writable registers, warnings.
6. Verify 2-3 registers with myio_modbus_set action=raw before building anything (plausible values: voltage about 230, frequency
   about 50, a temperature in range ...). Register addresses are 0-based (the manuals' 40001 = holding register 0, 30001 = input 0).
7. Build the table: from a template (myio_modbus_templates action=apply) or by hand (myio_modbus_set action=block / field), and bind
   the fields to universal sensors (target) as the user needs. Write slots created from a template are DISABLED: enable one only after
   the user has confirmed its register. Never write to a device register (raw FC5/6/16, write slots) without the user's explicit yes.
8. Save the result as a template with notes: myio_modbus_templates action=save (notes_hu / notes_en: how to change the address and
   speed, what to watch out for; manual = link; tested=true only if the values were checked on the real device).
9. Offer to send it to myIO: on the controller's /modbus page the device card has "Save as template" -> "Send to myIO" (it opens an
   e-mail to sablon@myio.hu; the downloaded file has to be attached by hand). The collection is curated by myIO - nothing is uploaded
   automatically.`;
