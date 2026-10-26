/**
 * Diagnosztika, naplok, fajlok (MYIO_MCP_PLAN.md 4.5, 3. kor 2026-10-25). sysdiag.json (Due 3.12+ szukebb kulcskeszlet),
 * /metrics [4.4.1], napi CSV-naplok (ev_log/, c_log/, sdm_log/, t_log_N/, h_log_N/, u_log_N/), fajlkezelo (fm.json, fm_del,
 * fm_mkdir, fm_ren, fm_cp, PUT, ~q/ ~sd/ GET; a Due-n 3.12 ota, csak az SD-kotet), QSPI->SD tukor (fm_sync) [4.4.3].
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MyIOClient, MyIOError } from '../api.js';
import { FEAT, isV4 } from '../model.js';
import {
  fmtSysdiag, FmList, fmtFmList, fmtSize, SAFE_PATH, normPath, isSystemPath, looksText, LOG_KINDS, logKindOfDir, yymmdd, filterLog, logLineLevel,
} from '../model_diag.js';
import { ToolContext, RO, WR_CFG_SET, WR_ADM, text, fail, serverArg, gate } from './common.js';

const BIG_TIMEOUT = 90_000;   // napi naplok: a Due-n 200+ KB is lehet (W5500, ~20 KB/s)

/** kotet: 4.x q (belso flash, alap) | s (SD); Due: csak s */
async function volOf(c: MyIOClient, vol?: string): Promise<'q' | 's'> {
  await c.require(FEAT.files, 'the file manager');
  const v4 = isV4(await c.version());
  if (!v4) { if (vol === 'q') throw new MyIOError(`${c.name}: a Due has only the SD card (vol s)`); return 's'; }
  return vol === 's' ? 's' : 'q';
}
/** statikus letoltes explicit kotettel (4.x: ~q/ | ~sd/, Due: ~sd/) */
const rawPath = (vol: 'q' | 's', p: string) => `${vol === 'q' ? '~q' : '~sd'}${normPath(p)}`;
async function list(c: MyIOClient, vol: 'q' | 's', dir: string): Promise<FmList> {
  const v4 = isV4(await c.version());
  const l = await c.fm<FmList>('fm.json', v4 ? { vol, dir } : { dir });
  if (l.err === 'nocard') throw new MyIOError(`${c.name}: no SD card in the controller`);
  if (l.err === 'denied') throw new MyIOError(`${c.name}: this user level cannot list ${dir}`, 403);
  return l;
}
function checkPath(p: string): string | undefined {
  const s = normPath(p);
  if (!SAFE_PATH.test(s)) return `path "${p}" has characters the controller cannot handle in file paths (it does not URL-decode them) - use A-Z a-z 0-9 . _ - /`;
  if (s.includes('..')) return 'path must not contain ".."';
  return undefined;
}

export function registerDiagTools(server: McpServer, ctx: ToolContext): void {
  const { reg } = ctx;
  const S = serverArg(reg);
  const VOL = z.enum(['q', 's']).optional().describe('q = internal flash (GIGA/Opta default), s = SD card (the only volume on a Due)');

  // ---- diagnosztika --------------------------------------------------------------------------------------------------------
  server.registerTool('myio_sysdiag', {
    title: 'System diagnostics',
    description: 'Health snapshot of the controller: uptime and last reset cause (watchdog?), main-loop speed and the longest stall, free RAM and its minimum, M4 button core, '
      + 'LAN link / WiFi, every network socket with its peer, outgoing HTTP slots, storage space, login brake counters. Due 3.12 gives a shorter set. raw=true = the JSON. Editor/admin level.',
    inputSchema: { raw: z.boolean().optional(), server: S },
    annotations: RO,
  }, async ({ raw, server: sv }) => {
    const c = reg.pick(sv);
    await c.require(FEAT.sysdiag, 'sysdiag.json');
    const j = await c.getJson<Record<string, unknown>>('sysdiag.json');
    if (raw) return text(JSON.stringify(j));
    return text(`${c.name} (${await c.version()}):\n${fmtSysdiag(j, isV4(await c.version()))}`);
  });

  server.registerTool('myio_metrics', {
    title: 'Prometheus metrics',
    description: 'The /metrics text (Prometheus format: uptime, loop rate, RAM, M4, link, WiFi RSSI, sockets, webhook counters, storage, usens values, 1-Wire temperatures). '
      + 'filter = only lines containing this text. GIGA/Opta 4.4.1+.',
    inputSchema: { filter: z.string().optional(), server: S },
    annotations: RO,
  }, async ({ filter, server: sv }) => {
    const c = reg.pick(sv);
    await c.require(FEAT.metrics, '/metrics');
    const t = await c.getText('metrics');
    const lines = t.split('\n').filter(l => l.trim() && (!filter || l.toLowerCase().includes(filter.toLowerCase())));
    return text(`${c.name}:\n${lines.join('\n') || '(no matching line)'}`);
  });

  // ---- naplok --------------------------------------------------------------------------------------------------------------
  server.registerTool('myio_logs', {
    title: 'Log files',
    description: 'Which daily CSV logs exist: event log (ev_log/), consumption (c_log/), SDM meter (sdm_log/), per-sensor temperature (t_log_N/), humidity (h_log_N/), universal sensor (u_log_N/). '
      + 'Without kind: the log folders on each volume and the newest event-log days. kind (+channel for temperature/humidity/usens) = every file of that log with size and date. '
      + 'Read one with myio_log. Editor/admin level.',
    inputSchema: { kind: z.enum(['event', 'consumption', 'sdm', 'temperature', 'humidity', 'usens']).optional(), channel: z.number().int().optional(), server: S },
    annotations: RO,
  }, async ({ kind, channel, server: sv }) => {
    const c = reg.pick(sv);
    await c.require(FEAT.files, 'log listing (file manager)');
    const v4 = isV4(await c.version());
    const vols: ('q' | 's')[] = v4 ? ['q', 's'] : ['s'];
    const L: string[] = [`${c.name}:`];
    if (kind) {
      const lk = LOG_KINDS[kind];
      if (['temperature', 'humidity', 'usens'].includes(kind) && channel === undefined) return fail(`channel is required for ${kind} logs (see myio_logs without kind)`);
      const dir = '/' + lk.dir(channel);
      for (const vol of vols) {
        let l: FmList;
        try { l = await list(c, vol, dir); } catch (e) { L.push(`  ${vol}: ${(e as Error).message}`); continue; }
        if (!l.ok) { L.push(`  ${vol}:${dir} - none`); continue; }
        const files = (l.entries ?? []).filter(e => !e.d).sort((a, b) => a.n.localeCompare(b.n));
        const tot = files.reduce((s, e) => s + e.s, 0);
        L.push(`  ${vol}:${dir} - ${files.length} file(s), ${fmtSize(tot)}`);
        for (const e of files) L.push(`    ${e.n}  ${fmtSize(e.s)}${e.t ? `  ${e.t}` : ''}`);
      }
      return text(L.join('\n'));
    }
    for (const vol of vols) {
      let root: FmList;
      try { root = await list(c, vol, '/'); } catch (e) { L.push(`  ${vol === 'q' ? 'internal flash' : 'SD card'}: ${(e as Error).message.replace(`${c.name}: `, '')}`); continue; }
      const logs = (root.entries ?? []).filter(e => e.d).map(e => ({ e, k: logKindOfDir(e.n) })).filter(x => x.k);
      L.push(`  ${vol === 'q' ? 'internal flash (q)' : 'SD card (s)'}: ${logs.length ? logs.map(x => `${x.e.n} (${x.k!.kind}${x.k!.ch !== undefined ? ` ch ${x.k!.ch}` : ''})`).join(', ') : 'no log folders'}`);
      if (logs.some(x => x.k!.kind === 'event')) {
        try {
          const ev = await list(c, vol, '/ev_log');
          const files = (ev.entries ?? []).filter(e => !e.d).sort((a, b) => a.n.localeCompare(b.n));
          L.push(`    event log: ${files.length} day(s); newest: ${files.slice(-5).map(e => `${e.n} ${fmtSize(e.s)}`).join(', ')}`);
        } catch { /* nincs */ }
      }
    }
    L.push('Files are named <prefix>_YYMMDD.csv; myio_log reads one day.');
    return text(L.join('\n'));
  });

  server.registerTool('myio_log', {
    title: 'Read a log',
    description: 'Read one day of a log (default: today\'s event log) with filters: level (error | info | debug - 4.x event log lines start with E/I/D), contains (text), '
      + 'since / until (HH:MM), tail (last N matching lines, default 150; 0 = all). date = YYYY-MM-DD, YYMMDD, today or yesterday; or give path (e.g. /ev_log/e_261025.csv). '
      + 'vol: q | s (default: the controller\'s own lookup, internal flash first). Editor/admin level.',
    inputSchema: {
      kind: z.enum(['event', 'consumption', 'sdm', 'temperature', 'humidity', 'usens']).optional(), channel: z.number().int().optional(), date: z.string().optional(),
      path: z.string().optional(), vol: VOL, level: z.enum(['error', 'info', 'debug']).optional(), contains: z.string().optional(),
      since: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(), until: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(), tail: z.number().int().min(0).optional(), server: S,
    },
    annotations: RO,
  }, async (a) => {
    const c = reg.pick(a.server);
    let p: string;
    if (a.path) { const bad = checkPath(a.path); if (bad) return fail(bad); p = normPath(a.path); }
    else {
      const k = a.kind ?? 'event';
      if (['temperature', 'humidity', 'usens'].includes(k) && a.channel === undefined) return fail(`channel is required for ${k} logs`);
      const lk = LOG_KINDS[k];
      let day: string;
      try { day = yymmdd(a.date, new Date()); } catch (e) { return fail((e as Error).message); }
      p = `/${lk.dir(a.channel)}/${lk.prefix}${day}.csv`;
    }
    const v4 = isV4(await c.version());
    const url = a.vol ? rawPath(v4 ? a.vol : 's', p) : p.slice(1);
    let body: string;
    try { body = await c.getText(url, { timeoutMs: BIG_TIMEOUT }); }
    catch (e) { if (e instanceof MyIOError && e.status === 404) return fail(`${c.name}: ${p} does not exist (no entries that day, or another volume) - see myio_logs`); throw e; }
    const all = body.split(/\r?\n/).filter(l => l.trim());
    const hit = filterLog(all, { level: a.level, contains: a.contains, since: a.since, until: a.until });
    const tail = a.tail ?? 150;
    const shown = tail ? hit.slice(-tail) : hit;
    const lv = { E: 0, I: 0, D: 0 } as Record<string, number>;
    for (const l of all) { const x = logLineLevel(l); if (x) lv[x]++; }
    const head = `${c.name} ${p} (${fmtSize(Buffer.byteLength(body))}, ${all.length} lines${lv.E + lv.I + lv.D ? `: ${lv.E} error, ${lv.I} info, ${lv.D} debug` : ''}) - ${hit.length} match${hit.length !== shown.length ? `, last ${shown.length} shown` : ''}`;
    return text([head, ...shown].join('\n'));
  });

  // ---- fajlok --------------------------------------------------------------------------------------------------------------
  server.registerTool('myio_files', {
    title: 'List files',
    description: 'List a folder on the controller\'s storage: name, size, date; folders first; free/total space. vol q = internal flash (GIGA/Opta), s = SD card (Due: only s). Editor/admin level.',
    inputSchema: { dir: z.string().optional().describe('default /'), vol: VOL, server: S },
    annotations: RO,
  }, async ({ dir, vol, server: sv }) => {
    const c = reg.pick(sv);
    const v = await volOf(c, vol);
    const d = normPath(dir ?? '/');
    const l = await list(c, v, d);
    if (!l.ok) return fail(`${c.name}: ${v}:${d} is not a folder (or does not exist)`);
    return text(`${c.name} ${fmtFmList(l, v)}`);
  });

  server.registerTool('myio_file_read', {
    title: 'Read a file',
    description: 'Download a file from the controller. Text files come back as text (truncated at max_bytes, default 64 KB); binary files as size + hex preview, or base64=true for the content (max 512 KB). Editor/admin level.',
    inputSchema: { path: z.string(), vol: VOL, max_bytes: z.number().int().min(1).max(1_048_576).optional(), base64: z.boolean().optional(), server: S },
    annotations: RO,
  }, async ({ path, vol, max_bytes, base64, server: sv }) => {
    const bad = checkPath(path); if (bad) return fail(bad);
    const c = reg.pick(sv);
    const v = await volOf(c, vol);
    let b: Buffer;
    try { b = await c.getBuffer(rawPath(v, path), { timeoutMs: BIG_TIMEOUT }); }
    catch (e) { if (e instanceof MyIOError && e.status === 404) return fail(`${c.name}: ${v}:${normPath(path)} not found`); throw e; }
    const head = `${c.name} ${v}:${normPath(path)} (${fmtSize(b.length)})`;
    if (base64) { if (b.length > 524_288) return fail(`${head} is too big for base64 output (max 512 KB)`); return text(`${head} base64:\n${b.toString('base64')}`); }
    if (!looksText(b)) return text(`${head} - binary; first 256 bytes:\n${b.subarray(0, 256).toString('hex').replace(/(.{64})/g, '$1\n')}\n(use base64=true for the content)`);
    const max = max_bytes ?? 65_536;
    const t = b.subarray(0, max).toString('utf8');
    return text(`${head}${b.length > max ? ` - first ${max} B shown` : ''}\n-----\n${t}`);
  });

  server.registerTool('myio_file_write', {
    title: 'Write a file',
    description: 'Upload a file to the controller (creates or overwrites; the write is not atomic). content = text (UTF-8) or base64 = binary. make_dirs=true creates missing parent folders. '
      + 'System files (network, passwords, licence, cloud keys, web UI folders htm/ js/, slot folders) need MYIO_WRITE=admin. For flows.jsn / prog/N.txt prefer myio_flow_save / myio_script_save (validated + reloaded). Editor/admin level.',
    inputSchema: { path: z.string(), vol: VOL, content: z.string().optional(), base64: z.string().optional(), make_dirs: z.boolean().optional(), server: S },
    annotations: WR_CFG_SET,
  }, async ({ path, vol, content, base64, make_dirs, server: sv }) => {
    const bad = checkPath(path); if (bad) return fail(bad);
    const g = gate(ctx, isSystemPath(path) ? 'admin' : 'config'); if (g) return g;
    if ((content === undefined) === (base64 === undefined)) return fail('give exactly one of content (text) or base64');
    const c = reg.pick(sv);
    const v = await volOf(c, vol);
    const p = normPath(path);
    if (p === '/' || p.endsWith('/')) return fail('path must name a file');
    const data = base64 !== undefined ? Buffer.from(base64, 'base64') : Buffer.from(content!, 'utf8');
    const made: string[] = [];
    if (make_dirs) {
      const parts = p.split('/').slice(1, -1);
      let cur = '';
      for (const part of parts) {
        cur += '/' + part;
        const l = await list(c, v, cur).catch(() => ({ ok: 0 } as FmList));
        if (l.ok) continue;
        const r = await c.fm<{ ok?: number }>('fm_mkdir', isV4(await c.version()) ? { vol: v, d: cur } : { d: cur });
        if (!r.ok) return fail(`${c.name}: could not create folder ${v}:${cur}`);
        made.push(cur);
      }
    }
    const n = await c.put(rawPath(v, p), data, 'application/octet-stream');
    return text(`${c.name}: wrote ${v}:${p} (${fmtSize(n)})${made.length ? `; created folder(s) ${made.join(', ')}` : ''}`);
  });

  server.registerTool('myio_file_op', {
    title: 'Delete / rename / copy files',
    description: 'File operations: delete (a file or an EMPTY folder), mkdir, rename (move within the volume: path -> to), copy (path -> to, folders recursively; on GIGA/Opta also between volumes with to_vol). '
      + 'The controller refuses to delete slot_0, the boot scene slot or a slot a button/timer refers to. System files need MYIO_WRITE=admin. Editor/admin level.',
    inputSchema: { op: z.enum(['delete', 'mkdir', 'rename', 'copy']), path: z.string(), to: z.string().optional(), vol: VOL, to_vol: VOL, server: S },
    annotations: WR_ADM,
  }, async ({ op, path, to, vol, to_vol, server: sv }) => {
    const bad = checkPath(path) ?? (to ? checkPath(to) : undefined); if (bad) return fail(bad);
    const sys = isSystemPath(path) || (op === 'rename' && to !== undefined && isSystemPath(to)) || (op === 'copy' && to !== undefined && isSystemPath(to));
    const g = gate(ctx, sys ? 'admin' : 'config'); if (g) return g;
    const c = reg.pick(sv);
    const v = await volOf(c, vol);
    const v4 = isV4(await c.version());
    const p = normPath(path);
    if (p === '/') return fail('refusing to operate on the volume root');
    if ((op === 'rename' || op === 'copy') && !to) return fail(`${op} needs "to"`);
    let r: { ok?: number; err?: string; src?: string; files?: number; bytes?: number };
    if (op === 'delete') r = await c.fm('fm_del', v4 ? { vol: v, f: p } : { f: p });
    else if (op === 'mkdir') r = await c.fm('fm_mkdir', v4 ? { vol: v, d: p } : { d: p });
    else if (op === 'rename') r = await c.fm('fm_ren', v4 ? { vol: v, from: p, to: normPath(to!) } : { from: p, to: normPath(to!) });
    else {
      const tv = to_vol ? await volOf(c, to_vol) : v;
      r = await c.fm('fm_cp', { src: `${v}:${p}`, dst: `${tv}:${normPath(to!)}` }, { timeoutMs: BIG_TIMEOUT });
    }
    if (!r.ok) {
      const why = r.err === 'slotprotected' ? 'slot_0 and the boot scene slot cannot be deleted'
        : r.err === 'slotref' ? `the slot is referenced by ${r.src} - remove that reference first`
          : op === 'delete' ? 'not found, or a non-empty folder' : 'failed (missing source, existing target or invalid path)';
      return fail(`${c.name}: ${op} ${v}:${p} - ${why}`);
    }
    return text(`${c.name}: ${op} ${v}:${p}${to ? ` -> ${to_vol ?? v}:${normPath(to)}` : ''} OK${r.files !== undefined ? ` (${r.files} file(s), ${fmtSize(r.bytes ?? 0)})` : ''}`);
  });

  server.registerTool('myio_fm_sync', {
    title: 'Internal flash -> SD mirror',
    description: 'The QSPI -> SD card configuration mirror (GIGA/Opta 4.4.3+): op status (default), config (mirror the configuration now), web (configuration + web UI folders), '
      + 'adopt (adopt a foreign card: write mirror.tag, then mirror). Needs an SD card and MYIO_WRITE=admin for the actions.',
    inputSchema: { op: z.enum(['status', 'config', 'web', 'adopt']).optional(), server: S },
    annotations: WR_ADM,
  }, async ({ op, server: sv }) => {
    const act = op && op !== 'status';
    if (act) { const g = gate(ctx, 'admin'); if (g) return g; }
    const c = reg.pick(sv);
    await c.require(FEAT.fmSync, 'the SD mirror (fm_sync)');
    const r = await c.fm<Record<string, unknown>>('fm_sync', act ? { op: op === 'config' ? 'sd' : op === 'web' ? 'sdweb' : 'adopt' } : {});
    const st = `${r.run ? 'RUNNING' : 'idle'}${r.run ? ` phase ${r.phase}${r.cur ? ` (${r.cur})` : ''}` : ''}; last run: ${r.copied ?? 0} copied, ${r.deleted ?? 0} deleted, ${fmtSize(Number(r.bytes ?? 0))}`
      + `${r.web ? ', incl. web folders' : ''}; SD card ${r.card ? `present${r.tagged ? ' (tagged as this controller\'s mirror)' : ' (NOT tagged - use op=adopt for a foreign card)'}` : 'NOT present'}`;
    return text(`${c.name}: ${act ? `started ${op} mirror. ` : ''}${st}`);
  });
}
