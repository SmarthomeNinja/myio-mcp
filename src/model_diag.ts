/**
 * Diagnosztika-, naplo- es fajl-modell (MYIO_MCP_PLAN.md 4.5, 3. kor 2026-10-25). Forras: API_REFERENCE.md 5.3/5.4/6,
 * a fw _SysDiag.ino / _FileManager.ino / fm_vols.h (4.x) es a Due 3.12 _FileMan.ino / _Diagnostics.ino.
 */

// ---- sysdiag.json --------------------------------------------------------------------------------------------------------
export const RESET_CAUSE: Record<number, string> = { 0: 'power-on', 1: 'backup', 2: 'WATCHDOG', 3: 'software restart', 4: 'reset button (NRST)' };
const SNSR: Record<number, string> = {
  0: 'CLOSED', 0x13: 'INIT', 0x14: 'LISTEN', 0x15: 'SYN_SENT', 0x16: 'SYN_RECV', 0x17: 'ESTABLISHED', 0x18: 'FIN_WAIT', 0x1a: 'CLOSING',
  0x1b: 'TIME_WAIT', 0x1c: 'CLOSE_WAIT', 0x1d: 'LAST_ACK', 0x22: 'UDP', 0x32: 'IPRAW', 0x42: 'MACRAW',
};
const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));
const dur = (s: number): string => { const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return `${d ? `${d}d ` : ''}${h}h ${m}m`; };
const kib = (k: number): string => (k >= 1024 ? `${(k / 1024).toFixed(1)} MiB` : `${k} KiB`);

export function fmtSysdiag(j: Record<string, unknown>, v4: boolean): string {
  const L: string[] = [];
  L.push(`uptime ${dur(n(j.up))}, last reset: ${RESET_CAUSE[n(j.reset)] ?? j.reset}${j.crashphase !== undefined ? ` (previous run ended in loop phase ${j.crashphase})` : ''}`);
  L.push(`main loop ${j.loops} rounds/s; longest step since boot ${j.stepmax ?? '?'} ms in phase ${j.stepmaxph ?? '?'}${j.loopmax !== undefined ? `; longest round ${j.loopmax} ms (phase ${j.loopmaxph})` : ''}`);
  L.push(`free RAM ${n(j.ramfree)} B (minimum since boot ${n(j.rammin)} B)`);
  if (j.m4alive !== undefined) L.push(`M4 button core: ${n(j.m4alive) ? 'alive' : 'NOT RESPONDING'}, button events ${j.m4btn}, timeouts ${j.m4to}, CRC errors ${j.m4crc}, gaps ${j.m4gap}, duplicates ${j.m4dup}, bad ${j.m4bad}${n(j.m4snap) ? `, OLD M4 image snapshots ${j.m4snap} (flash the M4)` : ''}`);
  const link = n(j.link);
  L.push(`LAN link: ${link === 1 ? 'UP' : link === 2 ? 'DOWN' : 'no LAN hardware'}${j.reinits !== undefined ? `, W5500 re-inits ${j.reinits}` : ''}${j.reaped !== undefined ? `, reaped sockets ${j.reaped}` : ''}`);
  if (j.wmode !== undefined) {
    const wm = n(j.wmode);
    L.push(`WiFi: ${wm === 1 ? 'STA' : wm === 2 ? 'AP' : 'off'}${n(j.wup) ? ` connected ${j.wip || ''}` : ''}${n(j.apup) ? ' (access point up)' : ''}${n(j.rssi) ? `, RSSI ${j.rssi} dBm` : ''}, sockets ${j.wsock}/${j.wsockmax} ${JSON.stringify(j.wsvc ?? [])}`);
  }
  if (Array.isArray(j.sock) && j.sock.length) {
    L.push('sockets [state, local port, remote, busy]:');
    for (const s of j.sock as unknown[][]) L.push(`  ${SNSR[n(s[0])] ?? `0x${n(s[0]).toString(16)}`} :${s[1]} <-> ${s[2]}:${s[3]}${v4 ? ` ${s[4]}%` : ''}`);
  }
  if (Array.isArray(j.outq)) {
    const names = ['Shelly', 'Link', 'webhook'];
    const busy = (j.outq as unknown[][]).map((q, i) => (n(q[0]) ? `${names[i] ?? i}: state ${q[0]} for ${q[2]} ms` : '')).filter(Boolean);
    L.push(`outgoing HTTP slots: ${busy.length ? busy.join(', ') : 'idle'}`);
  }
  if (j.qspit !== undefined) L.push(`storage: internal flash ${n(j.qspit) ? `${kib(n(j.qspif))} free of ${kib(n(j.qspit))}` : '(size not cached yet)'}, SD card ${n(j.sdok) ? `${kib(n(j.sdf))} free of ${kib(n(j.sdt))}` : 'not present'}`);
  if (j.viewers !== undefined) L.push(`diagnostic viewers ${j.viewers}, aggregate poll ${j.pollhz} Hz`);
  if (Array.isArray(j.ntp)) L.push(fmtNtp(j.ntp as unknown[]));
  L.push(`login brake: ${j.authfail ?? 0} distinct wrong passwords, ${j.authlock ?? 0} IP locks, ${j.authrej ?? 0} rejected while locked; WAN throttle hits ${j.wanthr ?? 0}`);
  if (Array.isArray(j.i2c)) L.push(`I2C error counters: ${JSON.stringify(j.i2c)}`);
  return L.join('\n');
}

/** [Due 3.12.35+] sysdiag "ntp": [utolso eredmeny (0 nem volt / 1 OK / 2 SD-n belul kihagyva / 4 nincs valasz), mp-e, OK-k, SD-kihagyasok,
 *  valasz nelkuliek, hatalyos eltolas (ora), dst_now] - a 3.12 _Diagnostics.ino szerint */
export function fmtNtp(a: unknown[]): string {
  const res: Record<number, string> = { 0: 'none yet', 1: 'OK', 2: 'skipped (inside an SD access)', 4: 'NO ANSWER' };
  const off = n(a[5]);
  return `NTP: last attempt ${res[n(a[0])] ?? `code ${a[0]}`}${n(a[0]) ? ` ${dur(n(a[1]))} ago` : ''}; ${n(a[2])} OK, ${n(a[3])} skipped, ${n(a[4])} without answer; clock offset UTC${off >= 0 ? '+' : ''}${off}${n(a[6]) ? ' (summer time)' : ''}`;
}

// ---- fajlkezelo ----------------------------------------------------------------------------------------------------------
export interface FmEntry { n: string; s: number; d: number; t?: string; }
export interface FmList { path?: string; total?: number; free?: number; entries?: FmEntry[]; ok?: number; err?: string; }
export const fmtSize = (b: number): string => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`);
export function fmtFmList(l: FmList, vol: string): string {
  const es = [...(l.entries ?? [])].sort((a, b) => b.d - a.d || a.n.localeCompare(b.n));
  const head = `${vol}:${l.path ?? '/'}${l.total ? ` (${kib(n(l.free))} free of ${kib(n(l.total))})` : ''} - ${es.length} entries`;
  return [head, ...es.map(e => (e.d ? `  [dir]  ${e.n}/${e.t ? `   ${e.t}` : ''}` : `  ${fmtSize(e.s).padStart(9)}  ${e.n}${e.t ? `   ${e.t}` : ''}`))].join('\n');
}

/** a fw nem URL-dekodolja a statikus GET/PUT utat: csak ASCII-biztos nev mehet (A-Z a-z 0-9 . _ - /) */
export const SAFE_PATH = /^\/?[A-Za-z0-9._\-/]+$/;
export function normPath(p: string): string {
  let s = p.trim().replace(/\\/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}
/** rendszerfajlok: ezekhez az admin iras-szint kell (halozat, jelszavak, licenc, OTA, felhos kulcsok, health-jelzo) */
export function isSystemPath(p: string): boolean {
  const s = normPath(p).toLowerCase();
  return /^\/(net\.jsn|username\.xml|u_desc\.xml|cloud\.jsn|lic\.jsn|vmsg\.jsn|mqtt\.jsn|myio_upd\.bin|myio_new\.bin|\.qhealth|mirror\.tag|info\.json)$/.test(s)
    || /^\/(htm|js|dict|lang)(\/|$)/.test(s) || /^\/slot_\d+$/.test(s);
}
/** szovegnek latszik-e (utf8 + kevés vezerlo-karakter) */
export function looksText(b: Buffer): boolean {
  if (!b.length) return true;
  const sample = b.subarray(0, 4096);
  let bad = 0;
  for (const c of sample) if (c === 0 || (c < 9) || (c > 13 && c < 32)) bad++;
  if (bad > sample.length / 100) return false;
  return !sample.toString('utf8').includes('�') || bad === 0;
}

// ---- naplok --------------------------------------------------------------------------------------------------------------
/** naplo-fajtak: konyvtar + fajl-elotag (a fw LogCsvAppend utjai; 4.x: SD-first, kulonben QSPI) */
export const LOG_KINDS: Record<string, { dir: (ch?: number) => string; prefix: string; what: string }> = {
  event: { dir: () => 'ev_log', prefix: 'e_', what: 'event log (boots, switching, errors, logins, file operations, ...)' },
  consumption: { dir: () => 'c_log', prefix: 'c_', what: 'pulse-meter consumption' },
  sdm: { dir: () => 'sdm_log', prefix: 's_', what: 'SDM energy meter' },
  temperature: { dir: ch => `t_log_${ch}`, prefix: 't_', what: '1-Wire temperature (channel = sensor index)' },
  humidity: { dir: ch => `h_log_${ch}`, prefix: 'h_', what: 'humidity (channel = humidity index)' },
  usens: { dir: ch => `u_log_${ch}`, prefix: 'u_', what: 'universal sensor (channel = usens id, 4.x)' },
};
export function logKindOfDir(dir: string): { kind: string; ch?: number } | undefined {
  const m = /^(ev_log|c_log|sdm_log)$/.exec(dir); if (m) return { kind: m[1] === 'ev_log' ? 'event' : m[1] === 'c_log' ? 'consumption' : 'sdm' };
  const k = /^([thu])_log_(\d+)$/.exec(dir); if (k) return { kind: k[1] === 't' ? 'temperature' : k[1] === 'h' ? 'humidity' : 'usens', ch: parseInt(k[2], 10) };
  return undefined;
}
/** YYYY-MM-DD | YYMMDD | 'today' | 'yesterday' -> YYMMDD (a vezerlo helyi idejeben szamolt nap: a hivo adja a "ma"-t) */
export function yymmdd(date: string | undefined, today: Date): string {
  const d = new Date(today);
  if (!date || date === 'today') { /* ma */ }
  else if (date === 'yesterday') d.setDate(d.getDate() - 1);
  else if (/^\d{6}$/.test(date)) return date;
  else { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date); if (!m) throw new Error(`date must be YYYY-MM-DD, YYMMDD, today or yesterday (got "${date}")`); return `${m[1].slice(2)}${m[2]}${m[3]}`; }
  return `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

export interface LogFilter { level?: string; contains?: string; since?: string; until?: string; }
/** esemenynaplo-sor: 4.x "L,YYYY/MM/DD HH:MM:SS,...", Due "YYYY/MM/DD HH:MM:SS,..." */
export function logLineLevel(line: string): string | undefined { const m = /^([EID]),\d{4}\//.exec(line); return m ? m[1] : undefined; }
export function logLineTime(line: string): string | undefined { const m = /(\d{2}:\d{2}(?::\d{2})?)/.exec(line.slice(0, 32)); return m ? m[1] : undefined; }
export function filterLog(lines: string[], f: LogFilter): string[] {
  const lv = f.level?.toUpperCase();
  const want = lv ? (lv.startsWith('E') ? ['E'] : lv.startsWith('I') ? ['E', 'I'] : ['E', 'I', 'D']) : undefined;
  const q = f.contains?.toLowerCase();
  return lines.filter(l => {
    if (!l.trim()) return false;
    if (want) { const L = logLineLevel(l); if (L && !want.includes(L)) return false; if (!L && want.length === 1) return false; }   // szint nelkuli (regi) sor = INFO
    if (q && !l.toLowerCase().includes(q)) return false;
    if (f.since || f.until) { const t = logLineTime(l); if (t) { if (f.since && t < f.since) return false; if (f.until && t > f.until) return false; } }
    return true;
  });
}
