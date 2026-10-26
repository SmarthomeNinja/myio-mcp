/**
 * RS485-bovitok es atjarok (MYIO_MCP_PLAN.md 4.6, 4. kor 2026-10-25) - Opta 4.5+: bovito-panelek (failsafe/standalone, AUX,
 * 1-Wire), Ext-KNX (GA-tabla, nevek, KNXnet/IP ETS-illeszto, eszkoz-kereses/cimzes), Ext-DALI, Ext-DMX, Ext-RS485 Modbus RTU.
 * Forras: _ExpSettings.ino / _ExpProgram.ino / _KnxIp.ino / _KnxDev.ino / _Dali.ino / _Dmx.ino / _Modbus.ino, expbus_proto.h.
 * A panel-tabla (KNX GA, Modbus) a panel cfgstore-jaban el: a M7 arnyekot ir, a mentes kulon parancs (KnxSave / a Modbus 8 s-os
 * auto-SAVE / mb_save). Offline panelre a fw a parancsot csendben eldobja - a valasz a visszaolvasott allapot.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MyIOClient } from '../api.js';
import { MyIOError } from '../api.js';
import { FEAT, VarBlock, num, varr, vnum } from '../model.js';
import { ToolContext, RO, WR_CFG, WR_CFG_SET, text, fail, serverArg, sleep, gate, kv, sendCmds, toggleTo, SETTLE_MS } from './common.js';

type J = Record<string, unknown>;
const PTYPE: Record<number, string> = { 16: 'Ext16 I/O', 17: 'Ext-KNX', 18: 'Ext-DALI', 20: 'Ext-DMX', 22: 'Ext-RS485 Modbus' };
const CFGTYPE = ['Ext16 I/O', 'Ext-KNX', 'Ext-DALI', 'Ext-DMX', 'Ext-RS485 Modbus'];
const FS_MODE = ['hold outputs', 'all off', 'preset', 'standalone (local rules)'];
const ago = (s: number) => (s < 0 ? 'never' : s < 120 ? `${s} s ago` : s < 7200 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`);
const gaText = (ga: number) => (ga ? `${(ga >> 11) & 31}/${(ga >> 8) & 7}/${ga & 255}` : '');
const KNX_DIR = ['-', 'IN (group write -> button event)', 'OUT (output -> group write)', 'SENSOR (group write -> usens)'];
const KNX_DPT = ['-', 'DPT1 on/off', 'DPT5 0..100 %', 'DPT9 float'];
const DT = ['-', 'u16', 'i16', 'u32', 'i32', 'f32', 'u64', 'i64', 'f64', 'bit', 'bool'];
const ORD = ['ABCD', 'CDAB', 'BADC', 'DCBA'];
const BAUD = ['9600', '19200', '38400', '57600', '115200', '4800', '2400', '1200'];
const FRAME = ['8N1', '8E1', '8O1', '8N2'];
const VALST = ['no value', 'OK', 'STALE', 'exception', 'timeout'];
const s8 = (b: number) => (b > 127 ? b - 256 : b);
const u16 = (lo: number, hi: number) => lo | (hi << 8);

export const expText = async (c: MyIOClient, addr?: number) => {
  const vb = await c.pageVars('expander', 'exp_q');
  const q = vnum(vb, 'exp_q'), on = vnum(vb, 'exp_on');
  const cfgT = varr(vb, 'exp_t'), seenT = varr(vb, 'exs_t'), fj = varr(vb, 'exs_fj'), fn = varr(vb, 'exs_fn'), pv = varr(vb, 'exs_pv'), ls = varr(vb, 'exs_ls'), nn = varr(vb, 'exs_n');
  const now = vnum(vb, 'exs_now');
  const ex = (k: string) => varr(vb, k);
  const L = [`${c.name} RS485 expanders: ${q} addresses; online bitmap ${on ? on.toString(2) : 'none'}`];
  for (let a = 1; a <= q; a++) {
    if (addr && a !== addr) continue;
    const st = Number(seenT[a - 1]) || 0, ct = Number(cfgT[a - 1]) || 0;
    const online = !!((on >> a) & 1);
    if (!st && !online && !addr && a > 1 && !ct) continue;
    const fs = (k: string) => Number(ex(k)[a - 1]);
    const lastSeen = Number(ls[a - 1]) ? ago(now - Number(ls[a - 1])) : 'never';
    const want = [16, 17, 18, 20, 22][ct];
    L.push(`  #${a}: configured as ${CFGTYPE[ct] ?? ct}; ${online ? 'ONLINE' : 'offline'}; seen as ${st ? PTYPE[st] ?? `type ${st}` : '-'}${st ? ` fw ${fj[a - 1]}.${fn[a - 1]} proto ${pv[a - 1]}, last seen ${lastSeen}, ${nn[a - 1]} logins` : ''}`
      + `${st && want && st !== want ? ' - ! the panel last seen at this address is a different type than configured' : ''}`);
    if (ct === 0) {
      L.push(`     failsafe on master loss: ${FS_MODE[fs('exf_fs')] ?? fs('exf_fs')} after ${fs('exf_to')} s; master ${fs('exf_ma') ? 'yes' : 'no'}, rules linked ${fs('exf_rl') ? 'yes' : 'no'}, relink truth ${fs('exf_rt') ? 'panel' : 'master'}, autosync ${fs('exf_as') ? 'yes' : 'no'}, thermostat stale-guard ${fs('exf_ts') ? `yes (${fs('exf_tp')} s)` : 'no'}`);
      const am = varr(vb, 'exa_m');
      L.push(`     AUX2/AUX3 mode: ${[0, 1].map(p => (Number(am[(a - 1) * 2 + p]) ? 'LED strip' : '0-10 V (mirrors PCA ' + (2000 + (a - 1) * 16 + 15 + p) + ')')).join(' / ')}`);
    }
  }
  const rom = varr(vb, 'ow_rom'), val = varr(vb, 'ow_val'), age = varr(vb, 'ow_age'), seen = varr(vb, 'ow_seen');
  if (rom.length) L.push(`  Ext16 1-Wire sensors (${rom.length}): ` + rom.map((r, i) => `\n    ${r}: ${Number(age[i]) >= 65000 ? 'no reading' : `${Number(val[i]) / 100} °C (${age[i]} s old)`}, thermometer slot ${Number(seen[i]) >= 0 ? seen[i] : '-'}`).join(''));
  return L.join('\n');
};

export function registerBusTools(server: McpServer, ctx: ToolContext): void {
  const { reg } = ctx;
  const S = serverArg(reg);
  const done = async (c: MyIOClient, cmds: string[], what: string, after: () => Promise<string>, wait = SETTLE_MS) => {
    if (!cmds.length) return text(`${c.name}: nothing to change.\n${await after()}`);
    const posts = await sendCmds(c, cmds);
    await sleep(wait);
    return text(`${c.name}: ${what} - sent ${cmds.join('&')}${posts > 1 ? ` (${posts} requests)` : ''}\n${await after()}`);
  };
  const need = <T>(v: T | undefined, n: string, act: string): T => { if (v === undefined) throw new MyIOError(`${n} is required for ${act}`); return v; };

  // ============================================================ EXPANDERS ===================================================
  server.registerTool('myio_expanders', {
    title: 'RS485 expanders',
    description: 'RS485 expander panels on an Opta (4.5+): per address the configured type (Ext16 I/O, Ext-KNX, Ext-DALI, Ext-DMX, Ext-RS485 Modbus), online state, firmware/protocol, last seen, '
      + 'failsafe/standalone rules for losing the master, AUX output modes, Ext16 1-Wire thermometers. addr = one panel (1..). Editor/admin level.',
    inputSchema: { addr: z.number().int().min(1).optional(), server: S },
    annotations: RO,
  }, async ({ addr, server: sv }) => { const c = reg.pick(sv); await c.require(FEAT.expanders, 'RS485 expanders'); return text(await expText(c, addr)); });

  server.registerTool('myio_expander_set', {
    title: 'Configure expanders',
    description: 'Expander settings (Opta 4.5+): failsafe {addr, mode 0 hold / 1 all off / 2 preset / 3 standalone, timeout_s 1..250, master, rules_linked, relink_truth, autosync, thermo_stale, stale_period_s} '
      + '(saved; sync=true pushes the rules to the panel now), capture_preset (addr: the current outputs become the failsafe preset), aux {addr, pin 0=AUX2 1=AUX3, mode 0 0-10V / 1 LED strip}, '
      + 'onewire_rescan=true, onewire_forget (eeprom id of an OFFLINE sensor), forget_panel (addr of an OFFLINE panel). Editor/admin level.',
    inputSchema: {
      failsafe: z.object({ addr: z.number().int().min(1), mode: z.number().int().min(0).max(3).optional(), timeout_s: z.number().int().min(1).max(250).optional(), master: z.boolean().optional(),
        rules_linked: z.boolean().optional(), relink_truth: z.boolean().optional(), autosync: z.boolean().optional(), thermo_stale: z.boolean().optional(), stale_period_s: z.number().int().optional(), sync: z.boolean().optional() }).optional(),
      capture_preset: z.number().int().min(1).optional(), aux: z.object({ addr: z.number().int().min(1), pin: z.number().int().min(0).max(1), mode: z.number().int().min(0).max(1) }).optional(),
      onewire_rescan: z.boolean().optional(), onewire_forget: z.number().int().min(1).optional(), forget_panel: z.number().int().min(1).optional(), server: S,
    },
    annotations: WR_CFG,
  }, async (a) => {
    const g = gate(ctx, 'config'); if (g) return g;
    const c = reg.pick(a.server);
    await c.require(FEAT.expanders, 'RS485 expanders');
    const cmds: string[] = [];
    const b = (v: boolean | undefined) => (v === undefined ? undefined : v ? 1 : 0);
    if (a.failsafe) {
      const f = a.failsafe; const A = f.addr;
      const map: [string, number | undefined][] = [['fs', f.mode], ['to', f.timeout_s], ['ma', b(f.master)], ['rl', b(f.rules_linked)], ['rt', b(f.relink_truth)], ['as', b(f.autosync)], ['ts', b(f.thermo_stale)], ['tp', f.stale_period_s]];
      for (const [k, v] of map) if (v !== undefined) cmds.push(`exf_${k}${A}=${v}`);
      if (f.sync) cmds.push(`exf_sync*${A}=1`);
    }
    if (a.capture_preset) cmds.push(`exf_cap*${a.capture_preset}=1`);
    if (a.aux) cmds.push(`exa_m*${a.aux.addr}*${a.aux.pin}=${a.aux.mode}`);
    if (a.onewire_rescan) cmds.push('ow_rescan*1=1');
    if (a.onewire_forget) cmds.push(`ow_del*${a.onewire_forget}=1`);
    if (a.forget_panel) cmds.push(`exs_del*${a.forget_panel}=1`);
    return done(c, cmds, 'expander settings', () => expText(c, a.failsafe?.addr ?? a.aux?.addr ?? a.capture_preset ?? a.forget_panel));
  });

  // ============================================================ KNX =========================================================
  const knxText = async (c: MyIOClient) => {
    const vb = await c.pageVars('knx', 'knx_addr');
    const L = [`${c.name} KNX: selected Ext-KNX panel #${vnum(vb, 'knx_addr') || '(none)'}${vnum(vb, 'knx_off') ? ' - OFFLINE (table not readable)' : ''}${vnum(vb, 'knx_dirty') ? ' - UNSAVED table changes (myio_knx_set save=true)' : ''}`];
    const ga = varr(vb, 'knx_ga'), dir = varr(vb, 'knx_dir'), dpt = varr(vb, 'knx_dpt'), loc = varr(vb, 'knx_loc'), fl = varr(vb, 'knx_fl'), tgt = varr(vb, 'knx_tgt'), nm = varr(vb, 'knx_nm');
    const rows = ga.map((g, i) => ({ i, g: Number(g) })).filter(r => r.g);
    if (ga.length) L.push(rows.length ? `  group addresses (${rows.length} of ${ga.length}):` + rows.map(({ i, g }) => `\n    row ${i} "${nm[i] ?? ''}": ${gaText(g)} ${KNX_DIR[Number(dir[i])] ?? dir[i]}, ${KNX_DPT[Number(dpt[i])] ?? dpt[i]}, local channel ${loc[i]}${Number(fl[i]) & 1 ? ', inverted' : ''}${Number(fl[i]) & 2 ? ', read at boot' : ''}${Number(tgt[i]) ? `, -> usens ${tgt[i]}` : ''}`).join('') : '  group-address table empty');
    else if (nm.some(Boolean)) L.push('  row names: ' + nm.map((n, i) => (n ? `${i}="${n}"` : '')).filter(Boolean).join(', '));
    if (vb.has('knxip_en')) {
      const st = vnum(vb, 'knxip_st');
      L.push(`  KNXnet/IP tunnelling interface for ETS: ${vnum(vb, 'knxip_en') ? 'enabled' : 'disabled'} - ${['not running', 'listening (UDP 3671)', 'TUNNEL CONNECTED'][st] ?? st}${vnum(vb, 'knxip_err') ? `, last error ${vnum(vb, 'knxip_err')}` : ''}; counters ${JSON.stringify(varr(vb, 'knxip_cnt'))}`);
      const ia = varr(vb, 'knxdev_ia'), dm = varr(vb, 'knxdev_m'), dn = varr(vb, 'knxdev_nm'), da = varr(vb, 'knxdev_age');
      L.push(`  KNX devices known (${ia.length}/${vnum(vb, 'knxdev_q')}): ${ia.length ? ia.map((x, i) => `\n    [${i}] ${(Number(x) >> 12) & 15}.${(Number(x) >> 8) & 15}.${Number(x) & 255} "${dn[i] ?? ''}" manufacturer ${dm[i]}, last answer ${ago(Number(da[i]))}`).join('') : 'none'}`
        + `${vnum(vb, 'knxdev_busy') ? '\n  device operation RUNNING' : vnum(vb, 'knxdev_rc') ? `\n  last device operation result code ${vnum(vb, 'knxdev_rc')}` : ''}`);
    }
    return L.join('\n');
  };
  server.registerTool('myio_knx', {
    title: 'KNX gateway',
    description: 'Ext-KNX gateway on an Opta (4.5+): the group-address table of the selected panel (row, name, group address, direction IN/OUT/SENSOR, DPT, local channel, flags, target universal sensor), '
      + 'the KNXnet/IP tunnelling interface for ETS (4.14+) and the KNX devices found/programmed without ETS. Editor/admin level.',
    inputSchema: { server: S },
    annotations: RO,
  }, async ({ server: sv }) => { const c = reg.pick(sv); await c.require(FEAT.expanders, 'the KNX gateway'); return text(await knxText(c)); });

  server.registerTool('myio_knx_set', {
    title: 'Edit the KNX table',
    description: 'Edit the Ext-KNX group-address table (the panel stores it; save=true (default) commits with KnxSave). panel = select another Ext-KNX panel first. rows: [{row 0..47, ga "main/middle/sub" '
      + '("" deletes the row), dir 0 none / 1 IN / 2 OUT / 3 SENSOR, dpt 1 bool / 2 percent / 3 float, local 0..15 (panel channel), target usens (SENSOR rows), invert, init_read (desired values), name (max 20, saved at once, 4.15+)}]. '
      + 'tunnel = enable/disable the ETS interface (4.14+), drop_tunnel=true closes the active ETS connection. Editor/admin level.',
    inputSchema: {
      panel: z.number().int().min(1).optional(),
      rows: z.array(z.object({ row: z.number().int().min(0).max(47), ga: z.string().optional(), dir: z.number().int().min(0).max(3).optional(), dpt: z.number().int().min(0).max(3).optional(),
        local: z.number().int().min(0).max(15).optional(), target: z.number().int().min(0).optional(), invert: z.boolean().optional(), init_read: z.boolean().optional(), name: z.string().max(20).optional() })).optional(),
      save: z.boolean().optional(), tunnel: z.boolean().optional(), drop_tunnel: z.boolean().optional(), server: S,
    },
    annotations: WR_CFG_SET,
  }, async (a) => {
    const g = gate(ctx, 'config'); if (g) return g;
    const c = reg.pick(a.server);
    await c.require(FEAT.expanders, 'the KNX gateway');
    if (a.panel) { await sendCmds(c, [`knx_sel=${a.panel}`]); await sleep(300); }
    const vb = await c.pageVars('knx', 'knx_addr');
    const cmds: string[] = [];
    let table = false;
    for (const r of a.rows ?? []) {
      if (r.name !== undefined) { await c.require(FEAT.knxNames, 'KNX row names'); cmds.push(kv(`knx_n${r.row}`, r.name)); }
      const fl = Number(varr(vb, 'knx_fl')[r.row] ?? 0);
      if (r.ga !== undefined) { if (r.ga && !/^\d{1,2}\/\d\/\d{1,3}$/.test(r.ga)) return fail(`row ${r.row}: ga must look like 1/2/3`); cmds.push(kv(`knx_ga${r.row}`, r.ga)); table = true; }
      for (const [k, v] of [['dir', r.dir], ['dpt', r.dpt], ['loc', r.local], ['tgt', r.target]] as [string, number | undefined][]) if (v !== undefined) { cmds.push(`knx_${k}${r.row}=${v}`); table = true; }
      if (r.invert !== undefined || r.init_read !== undefined) {
        if (vnum(vb, 'knx_off')) return fail('the KNX panel is offline - flags cannot be read, so the invert/init_read toggles cannot be set safely');
        const before = cmds.length; toggleTo(cmds, fl & 1, r.invert, `knx_inv${r.row}=1`); toggleTo(cmds, fl & 2, r.init_read, `knx_ir${r.row}=1`); if (cmds.length > before) table = true;
      }
    }
    if (table && vnum(vb, 'knx_off')) return fail(`${c.name}: the selected KNX panel #${vnum(vb, 'knx_addr')} is offline - the table cannot be edited now`);
    if (table && a.save !== false) cmds.push('KnxSave=1');
    if (a.tunnel !== undefined) { await c.require(FEAT.knxIp, 'the KNXnet/IP interface'); toggleTo(cmds, vnum(vb, 'knxip_en'), a.tunnel, 'knxip_en=1'); }
    if (a.drop_tunnel) cmds.push('knxip_drop=1');
    return done(c, cmds, 'KNX', () => knxText(c), table ? 1200 : SETTLE_MS);
  });

  server.registerTool('myio_knx_device', {
    title: 'KNX devices (without ETS)',
    description: 'KNX device operations over the Ext-KNX panel (Opta 4.14+): scan (who is on the line, ~2 s), add (address a.l.d to the list), ping / info / delete / rename (index from myio_knx), '
      + 'program (address: writes the individual address into the ONE device whose programming button is pressed - needs MYIO_WRITE=admin). The answer waits for the result.',
    inputSchema: { action: z.enum(['scan', 'add', 'ping', 'info', 'delete', 'rename', 'program']), address: z.string().optional(), index: z.number().int().min(0).optional(), name: z.string().max(23).optional(), server: S },
    annotations: WR_CFG,
  }, async (a) => {
    const g = gate(ctx, a.action === 'program' ? 'admin' : a.action === 'scan' || a.action === 'ping' || a.action === 'info' ? 'state' : 'config'); if (g) return g;
    const c = reg.pick(a.server);
    await c.require(FEAT.knxIp, 'KNX device operations');
    const addrOk = (s?: string) => { if (!s || !/^\d{1,2}\.\d{1,2}\.\d{1,3}$/.test(s)) throw new MyIOError('address must look like 1.1.20'); return s; };
    let cmd: string;
    switch (a.action) {
      case 'scan': cmd = 'knxdev_scan=1'; break;
      case 'add': cmd = kv('knxdev_add', addrOk(a.address)); break;
      case 'program': cmd = kv('knxdev_prog', addrOk(a.address)); break;
      case 'rename': cmd = kv(`knxdev_n*${need(a.index, 'index', a.action)}`, need(a.name, 'name', a.action)); break;
      default: cmd = `knxdev_${a.action === 'delete' ? 'del' : a.action}*${need(a.index, 'index', a.action)}=1`;
    }
    await sendCmds(c, [cmd]);
    const RC: Record<number, string> = { 1: 'done', 2: 'address written and verified', 6: 'no reply', 10: 'address already in use on the line', 11: 'no device in programming mode', 12: 'several devices in programming mode', 13: 'verification failed', 14: 'bus error', 17: 'bad address', 18: 'already in the list' };
    let vb: VarBlock = new Map();
    for (let i = 0; i < 12; i++) { await sleep(700); vb = await c.pageVars('knx', 'knx_addr'); if (!vnum(vb, 'knxdev_busy')) break; }
    const rc = vnum(vb, 'knxdev_rc');
    return text(`${c.name}: sent ${cmd}${vnum(vb, 'knxdev_busy') ? ' - still running' : rc ? ` - result: ${RC[rc] ?? `code ${rc}`}` : ''}\n${await knxText(c)}`);
  });

  // ============================================================ DALI ========================================================
  const daliText = async (c: MyIOClient, ep?: number) => {
    const d = (await c.getJson<{ dali: J }>('dali.json')).dali ?? {};
    const panels = (d.panels as J[]) ?? [];
    const L = [`${c.name} DALI: ${panels.length ? panels.map(p => `panel #${p.a} ${num(p.on) ? 'ONLINE' : 'offline'}`).join(', ') : 'no DALI panel'}; ${num(d.n)} endpoints registered (max ${num(d.epq)}); `
      + `binding pool PCA ${2000 + num((d.pool as number[])?.[0])}..${2000 + num((d.pool as number[])?.[1])}${num(d.busy) ? '; BUS OPERATION RUNNING' : ''}${d.msg ? `; ${d.msg}` : ''}`];
    const P = ['fade time', 'fade rate', 'power-on', 'system failure', 'min', 'max', 'curve'];
    for (const e of (d.ep as J[]) ?? []) {
      if (ep !== undefined && num(e.i) !== ep) continue;
      const a = num(e.e);
      const addr = a < 64 ? `short address ${a}` : a < 80 ? `group ${a - 64}` : 'broadcast';
      const want = [e.fd, e.fr, e.po, e.sf, e.mn, e.mx, e.cv].map(num);
      const got = ((e.r as number[]) ?? []).map(num);
      const diff = got.some((v, k) => v !== 255 && v !== want[k]);
      const groups = (m: number) => Array.from({ length: 16 }, (_, k) => (m >> k) & 1 ? k : -1).filter(k => k >= 0).join(',') || 'none';
      L.push(`  ep ${e.i}: panel ${e.p} ${addr} -> ${num(e.pca) ? `PCA ${2000 + num(e.pca)}` : 'not bound'}; level sent ${num(e.ls) === 255 ? '-' : e.ls}, driver reports ${num(e.act) === 255 ? '-' : e.act}; device type DT${e.dt}`
        + `\n     settings ${P.map((n, k) => `${n} ${want[k]}${got[k] !== undefined && got[k] !== 255 && got[k] !== want[k] ? ` (driver: ${got[k]})` : ''}`).join(', ')}${diff ? ' - DIFFERS from the driver (write=true)' : ''}; groups wanted ${groups(num(e.g))}, driver ${groups(num(e.gr))}`);
    }
    return L.join('\n');
  };
  server.registerTool('myio_dali', {
    title: 'DALI gateway',
    description: 'Ext-DALI gateway on an Opta (4.8.6+): panels, the registered endpoints (short address / group / broadcast), the myIO PCA channel each is bound to (dim it with myio_output), '
      + 'last sent and driver-reported level, desired vs driver-read parameters (fade, power-on, failure level, min/max, curve) and group membership. ep = one endpoint. Editor/admin level.',
    inputSchema: { ep: z.number().int().min(0).optional(), server: S },
    annotations: RO,
  }, async ({ ep, server: sv }) => { const c = reg.pick(sv); await c.require(FEAT.dali, 'the DALI gateway'); return text(await daliText(c, ep)); });

  server.registerTool('myio_dali_set', {
    title: 'Configure DALI',
    description: 'DALI registry and driver settings (Opta 4.8.6+; saved automatically). action: bind (ep, pca_id 2001.. or 0), settings (ep, any of fade_time 0..15, fade_rate 0..15, power_on, system_failure, '
      + 'min, max 0..254, curve 0 log / 1 linear; write=true (default) sends them to the driver), groups (ep, group 0..15, member true|false), read (ep: read the driver), identify (ep), add (panel, address 0..63 short / 64..79 group / 80 broadcast), '
      + 'add_all (panel: everything the last scan found), delete (ep), pool (lo, hi PCA ids), auto_bind, scan (panel: find drivers on the bus), abort (panel), '
      + 'commission (panel, mode 0 = re-address ALL / 1 = only unaddressed, start 0..63 - admin), short_address (ep, new 0..63 - admin), reset (ep - admin), panel_config (panel, field 0..6, value). Editor/admin level.',
    inputSchema: {
      action: z.enum(['bind', 'settings', 'groups', 'read', 'identify', 'add', 'add_all', 'delete', 'pool', 'auto_bind', 'scan', 'abort', 'commission', 'short_address', 'reset', 'panel_config']),
      ep: z.number().int().min(0).optional(), panel: z.number().int().min(1).optional(), pca_id: z.number().int().min(0).optional(), address: z.number().int().min(0).max(80).optional(),
      fade_time: z.number().int().min(0).max(15).optional(), fade_rate: z.number().int().min(0).max(15).optional(), power_on: z.number().int().min(0).max(255).optional(), system_failure: z.number().int().min(0).max(255).optional(),
      min: z.number().int().min(0).max(254).optional(), max: z.number().int().min(0).max(254).optional(), curve: z.number().int().min(0).max(1).optional(), write: z.boolean().optional(),
      group: z.number().int().min(0).max(15).optional(), member: z.boolean().optional(), lo: z.number().int().optional(), hi: z.number().int().optional(),
      mode: z.number().int().min(0).max(1).optional(), start: z.number().int().min(0).max(63).optional(), new_address: z.number().int().min(0).max(63).optional(),
      field: z.number().int().min(0).max(6).optional(), value: z.number().int().optional(), server: S,
    },
    annotations: WR_CFG,
  }, async (a) => {
    const g = gate(ctx, ['commission', 'short_address', 'reset'].includes(a.action) ? 'admin' : 'config'); if (g) return g;
    const c = reg.pick(a.server);
    await c.require(FEAT.dali, 'the DALI gateway');
    const act = a.action;
    const ep = () => need(a.ep, 'ep', act), pnl = () => need(a.panel, 'panel', act);
    const cmds: string[] = [];
    switch (act) {
      case 'bind': cmds.push(`dali_pca${ep()}=${need(a.pca_id, 'pca_id', act)}`); break;
      case 'settings': {
        const e = ep();
        for (const [k, v] of [['fd', a.fade_time], ['fr', a.fade_rate], ['po', a.power_on], ['sf', a.system_failure], ['mn', a.min], ['mx', a.max], ['cv', a.curve]] as [string, number | undefined][]) if (v !== undefined) cmds.push(`dali_${k}${e}=${v}`);
        if (cmds.length && a.write !== false) cmds.push(`dali_wr*${e}=1`);
        break;
      }
      case 'groups': {
        const e = ep(); const grp = need(a.group, 'group', act); const mem = need(a.member, 'member', act);
        const d = (await c.getJson<{ dali: J }>('dali.json')).dali ?? {};
        const rec = ((d.ep as J[]) ?? []).find(x => num(x.i) === e); if (!rec) return fail(`no DALI endpoint ${e}`);
        toggleTo(cmds, (num(rec.g) >> grp) & 1, mem, `dali_gt*${e}*${grp}=1`);
        if (cmds.length && a.write !== false) cmds.push(`dali_wr*${e}=1`);
        break;
      }
      case 'read': cmds.push(`dali_rd*${ep()}=1`); break;
      case 'identify': cmds.push(`dali_ident*${ep()}=1`); break;
      case 'reset': cmds.push(`dali_reset*${ep()}=1`); break;
      case 'add': cmds.push(`dali_add*${pnl()}*${need(a.address, 'address', act)}=1`); break;
      case 'add_all': cmds.push(`dali_addall*${pnl()}=1`); break;
      case 'delete': cmds.push(`dali_del*${ep()}=1`); break;
      case 'pool': if (a.lo !== undefined) cmds.push(`dali_plo=${a.lo}`); if (a.hi !== undefined) cmds.push(`dali_phi=${a.hi}`); break;
      case 'auto_bind': cmds.push('dali_auto*1=1'); break;
      case 'scan': cmds.push(`dali_scan*${pnl()}=1`); break;
      case 'abort': cmds.push(`dali_abort*${pnl()}=1`); break;
      case 'commission': cmds.push(`dali_comm*${pnl()}*${need(a.mode, 'mode', act)}*${a.start ?? 0}=1`); break;
      case 'short_address': cmds.push(`dali_sa*${ep()}*${need(a.new_address, 'new_address', act)}=1`); break;
      case 'panel_config': cmds.push(`dali_cfg*${pnl()}*${need(a.field, 'field', act)}=${need(a.value, 'value', act)}`); break;
    }
    const slow = ['scan', 'commission', 'read', 'settings', 'groups'].includes(act);
    return done(c, cmds, `DALI ${act}`, () => daliText(c, a.ep), slow ? 2000 : SETTLE_MS);
  });

  // ============================================================ DMX =========================================================
  const dmxText = async (c: MyIOClient) => {
    const d = (await c.getJson<{ dmx: J }>('dmx.json')).dmx ?? {};
    const panels = (d.panels as J[]) ?? [];
    const T = ['dimmer (1 ch)', 'RGB (3 ch)', 'RGBW (4 ch)', 'generic'];
    const L = [`${c.name} DMX: ${panels.length ? panels.map(p => `panel #${p.a} ${num(p.on) ? 'ONLINE' : 'offline'}, ${p.nfx ?? 0} fixtures`).join('; ') : 'no DMX panel'}; ${num(d.n)} fixtures (max ${num(d.fxq)}); `
      + `binding pool PCA ${2000 + num((d.pool as number[])?.[0])}..${2000 + num((d.pool as number[])?.[1])}${num(d.test) >= 0 ? `; testing fixture ${d.test}` : ''}${d.msg ? `; ${d.msg}` : ''}`];
    for (const f of (d.fx as J[]) ?? []) {
      const ch = ((f.c as number[]) ?? []).map((p, k) => `ch${k + 1}=${p ? `PCA ${2000 + p}` : '-'}${(f.ls as number[])?.[k] !== undefined && (f.ls as number[])[k] !== 255 ? ` (${(f.ls as number[])[k]})` : ''}`);
      L.push(`  fixture ${f.i}: panel ${f.p}, DMX ${f.a}..${num(f.a) + num(f.n) - 1}, ${T[num(f.t)] ?? f.t}${num(f.t) === 3 ? ` ${f.n} ch` : ''}; ${ch.join(', ')}`);
    }
    return L.join('\n');
  };
  server.registerTool('myio_dmx', {
    title: 'DMX gateway',
    description: 'Ext-DMX gateway on an Opta (4.9+): panels, fixtures (start address, type dimmer/RGB/RGBW/generic, channels) and the myIO PCA channel each DMX channel follows (dim it with myio_output / myio_set_rgb). Editor/admin level.',
    inputSchema: { server: S },
    annotations: RO,
  }, async ({ server: sv }) => { const c = reg.pick(sv); await c.require(FEAT.dmx, 'the DMX gateway'); return text(await dmxText(c)); });

  server.registerTool('myio_dmx_set', {
    title: 'Configure DMX',
    description: 'DMX fixtures (Opta 4.9+; saved automatically). action: add (panel, address 1..512, type 0 dimmer / 1 RGB / 2 RGBW / 3 generic), delete (fixture), address (fixture, address), type (fixture, type), '
      + 'channels (fixture, count 1..16 - generic only), bind (fixture, channel 1.., pca_id 2001.. or 0), auto_bind, pool (lo, hi), test (fixture: full on for 1.5 s - state), blackout (panel: all 512 slots to 0 - state), '
      + 'panel_config (panel, field 0..5, value). Editor/admin level.',
    inputSchema: { action: z.enum(['add', 'delete', 'address', 'type', 'channels', 'bind', 'auto_bind', 'pool', 'test', 'blackout', 'panel_config']), fixture: z.number().int().min(0).optional(),
      panel: z.number().int().min(1).optional(), address: z.number().int().min(1).max(512).optional(), type: z.number().int().min(0).max(3).optional(), count: z.number().int().min(1).max(16).optional(),
      channel: z.number().int().min(1).max(16).optional(), pca_id: z.number().int().min(0).optional(), lo: z.number().int().optional(), hi: z.number().int().optional(),
      field: z.number().int().min(0).max(5).optional(), value: z.number().int().optional(), server: S },
    annotations: WR_CFG,
  }, async (a) => {
    const g = gate(ctx, a.action === 'test' || a.action === 'blackout' ? 'state' : 'config'); if (g) return g;
    const c = reg.pick(a.server);
    await c.require(FEAT.dmx, 'the DMX gateway');
    const act = a.action; const fx = () => need(a.fixture, 'fixture', act); const pnl = () => need(a.panel, 'panel', act);
    const cmds: string[] = [];
    switch (act) {
      case 'add': cmds.push(`dmx_add*${pnl()}*${need(a.address, 'address', act)}*${need(a.type, 'type', act)}=1`); break;
      case 'delete': cmds.push(`dmx_del*${fx()}=1`); break;
      case 'address': cmds.push(`dmx_a${fx()}=${need(a.address, 'address', act)}`); break;
      case 'type': cmds.push(`dmx_t${fx()}=${need(a.type, 'type', act)}`); break;
      case 'channels': cmds.push(`dmx_n${fx()}=${need(a.count, 'count', act)}`); break;
      case 'bind': cmds.push(`dmx_c${fx()}_${need(a.channel, 'channel', act) - 1}=${need(a.pca_id, 'pca_id', act)}`); break;
      case 'auto_bind': cmds.push('dmx_auto*1=1'); break;
      case 'pool': if (a.lo !== undefined) cmds.push(`dmx_plo=${a.lo}`); if (a.hi !== undefined) cmds.push(`dmx_phi=${a.hi}`); break;
      case 'test': cmds.push(`dmx_test*${fx()}=1`); break;
      case 'blackout': cmds.push(`dmx_bo*${pnl()}=1`); break;
      case 'panel_config': cmds.push(`dmx_cfg*${pnl()}*${need(a.field, 'field', act)}=${need(a.value, 'value', act)}`); break;
    }
    return done(c, cmds, `DMX ${act}`, () => dmxText(c));
  });

  // ============================================================ MODBUS ======================================================
  const mbText = async (c: MyIOClient, panel?: number, values = true) => {
    const m = (await c.getJson<{ modbus: J }>('modbus.json')).modbus ?? {};
    const L = [`${c.name} Modbus RTU: universal sensors from usens ${num(m.usmin)}..${num(m.senq)}${m.msg ? `; ${m.msg}` : ''}`];
    for (const p of (m.panels as J[]) ?? []) {
      if (panel && num(p.a) !== panel) continue;
      const cfg = (p.cfg as number[]) ?? [];
      L.push(`  panel #${p.a} "${p.name ?? ''}" ${num(p.on) ? 'ONLINE' : 'offline'}${num(p.ld) ? '' : ' (tables not loaded)'}${p.preset ? `, preset ${p.preset}` : ''}${num(p.pend) ? `, ${p.pend} writes pending` : ''}; bus ${BAUD[cfg[0]] ?? cfg[0]} ${FRAME[cfg[1]] ?? cfg[1]}, timeout ${num(cfg[2]) * 10} ms, retries ${cfg[3]}, gap ${cfg[4]} ms`);
      ((p.blk as number[][]) ?? []).forEach((b, i) => { if (b[0]) L.push(`    block ${i}: slave ${b[0]} func ${b[1]} start ${u16(b[2], b[3])} count ${b[4]} every ${b[5]} s${b[6] & 1 ? '' : ' (DISABLED)'}`); });
      const fn = (p.fn as string[]) ?? [], val = (p.val as unknown[][]) ?? [];
      ((p.fld as number[][]) ?? []).forEach((f, i) => {
        if (f[0] === 255 || (!f[2] && !f[6])) return;
        const v = val[i] ?? [];
        L.push(`    field ${i} "${fn[i] ?? ''}": block ${f[0]} offset ${f[1]} ${DT[f[2]] ?? f[2]} ${ORD[f[3] & 3]}${f[2] === 9 ? ` bit ${f[3] >> 4}` : ''} x10^${s8(f[4])}${f[5] !== 255 ? ` SF@${f[5]}` : ''}${f[6] ? ` -> usens ${f[6]}` : ''}${f[7] & 1 ? '' : ' (DISABLED)'}`
          + (values && v.length ? ` = ${num(v[1]) === 1 ? v[0] : VALST[num(v[1])] ?? v[1]}${num(v[1]) && num(v[2]) !== 255 ? ` (${v[2]} s old)` : ''}` : ''));
      });
      const wn = (p.wn as string[]) ?? [];
      ((p.wr as number[][]) ?? []).forEach((w, i) => { if (w[0]) L.push(`    writer ${i} "${wn[i] ?? ''}": slave ${w[0]} func ${w[1]} reg ${u16(w[2], w[3])} ${DT[w[4]] ?? w[4]}, source ${w[5] & 0x10 ? `PCA ${2000 + (num(p.a) - 1) * 16 + i + 1} -> ${u16(w[6], w[7])}..${u16(w[8], w[9])}` : `relay bit ${i} -> off ${u16(w[6], w[7])} / on ${u16(w[8], w[9])}`}${w[10] ? `, rewrite every ${w[10]} s` : ''}${w[11] & 1 ? '' : ' (DISABLED)'}`); });
      if (p.raw) L.push(`    raw request result: ${JSON.stringify(p.raw)}`);
      if (p.scan) L.push(`    address scan: ${JSON.stringify(p.scan)}`);
    }
    return L.join('\n');
  };
  server.registerTool('myio_modbus', {
    title: 'Modbus RTU master',
    description: 'Ext-RS485 Modbus RTU master on an Opta (4.16+): per panel the bus settings, the poll blocks (slave, function, start register, count, period), the fields decoded from them '
      + '(type, byte order, scale, target universal sensor) with live values, the writer slots (myIO relay/PCA -> Modbus register), and raw-request / address-scan results. Editor/admin level.',
    inputSchema: { panel: z.number().int().min(1).optional(), server: S },
    annotations: RO,
  }, async ({ panel, server: sv }) => { const c = reg.pick(sv); await c.require(FEAT.modbus, 'the Modbus master'); return text(await mbText(c, panel)); });

  server.registerTool('myio_modbus_set', {
    title: 'Configure / query Modbus',
    description: 'Modbus panel table (Opta 4.16+; the panel saves 8 s after the last change, or save=true now). action: block (panel, index 0..7, slave 1..247, func 1..4, start, count 1..125, period_s, enabled), '
      + 'field (panel, index 0..31, block, offset, dtype 1 u16 / 2 i16 / 3 u32 / 4 i32 / 5 f32 / 6 u64 / 7 i64 / 8 f64 / 9 bit / 10 bool, order 0 ABCD / 1 CDAB / 2 BADC / 3 DCBA, bit, scale -9..9, sf_offset (255 none), target usens, enabled, invert), '
      + 'writer (panel, index 0..15, slave, func 5/6/16, reg, dtype, order, source_pca, off, on, period_s, enabled, invert), delete (panel, table 0 block / 1 field / 2 writer, index), bus (panel, baud code 0 9600 / 1 19200 / 2 38400 / 3 57600 / 4 115200, frame 0 8N1 / 1 8E1 / 2 8O1 / 3 8N2, timeout_ms, retries, gap_ms), '
      + 'name (panel, field_index or writer_index or none for the panel, name), preset (panel, preset id e.g. SDM630), reload (panel), clear (panel - admin), '
      + 'raw (panel, slave, func, reg, count: one request, result shown) and scan (panel, from, to, func, reg: which slave addresses answer). Editor/admin level.',
    inputSchema: {
      action: z.enum(['block', 'field', 'writer', 'delete', 'bus', 'name', 'preset', 'save', 'reload', 'clear', 'raw', 'scan']), panel: z.number().int().min(1),
      index: z.number().int().min(0).optional(), slave: z.number().int().min(0).max(247).optional(), func: z.number().int().min(1).max(16).optional(), start: z.number().int().min(0).max(65535).optional(),
      count: z.number().int().min(1).max(125).optional(), period_s: z.number().int().min(0).max(255).optional(), enabled: z.boolean().optional(), block: z.number().int().min(0).max(7).optional(),
      offset: z.number().int().min(0).max(124).optional(), dtype: z.number().int().min(0).max(10).optional(), order: z.number().int().min(0).max(3).optional(), bit: z.number().int().min(0).max(15).optional(),
      scale: z.number().int().min(-9).max(9).optional(), sf_offset: z.number().int().min(0).max(255).optional(), target: z.number().int().min(0).optional(), invert: z.boolean().optional(),
      reg: z.number().int().min(0).max(65535).optional(), source_pca: z.boolean().optional(), off: z.number().int().min(0).max(65535).optional(), on: z.number().int().min(0).max(65535).optional(),
      table: z.number().int().min(0).max(2).optional(), baud: z.number().int().min(0).max(7).optional(), frame: z.number().int().min(0).max(3).optional(), timeout_ms: z.number().int().optional(),
      retries: z.number().int().min(0).max(5).optional(), gap_ms: z.number().int().min(0).max(255).optional(), field_index: z.number().int().min(0).optional(), writer_index: z.number().int().min(0).optional(),
      name: z.string().max(23).optional(), preset: z.string().max(23).optional(), from: z.number().int().min(1).max(247).optional(), to: z.number().int().min(1).max(247).optional(), save: z.boolean().optional(), server: S,
    },
    annotations: WR_CFG,
  }, async (a) => {
    const g = gate(ctx, a.action === 'clear' ? 'admin' : a.action === 'raw' || a.action === 'scan' ? 'state' : 'config'); if (g) return g;
    const c = reg.pick(a.server);
    await c.require(FEAT.modbus, 'the Modbus master');
    const act = a.action, P = a.panel;
    const n = <T>(v: T | undefined, k: string) => need(v, k, act);
    const cmds: string[] = [];
    switch (act) {
      case 'block': cmds.push(`mb_blk*${P}*${n(a.index, 'index')}*${n(a.slave, 'slave')}*${n(a.func, 'func')}*${n(a.start, 'start')}*${n(a.count, 'count')}*${a.period_s ?? 5}=${a.enabled === false ? 0 : 1}`); break;
      case 'field': {
        const mod = (a.order ?? 0) | ((a.bit ?? 0) << 4);
        const flags = (a.enabled === false ? 0 : 1) | (a.invert ? 2 : 0);
        cmds.push(`mb_fld*${P}*${n(a.index, 'index')}*${n(a.block, 'block')}*${n(a.offset, 'offset')}*${n(a.dtype, 'dtype')}*${mod}*${(a.scale ?? 0) & 0xff}*${a.sf_offset ?? 255}*${a.target ?? 0}=${flags}`);
        break;
      }
      case 'writer': {
        const mod = (a.order ?? 0) | (a.source_pca ? 0x10 : 0);
        const flags = (a.enabled === false ? 0 : 1) | (a.invert ? 2 : 0);
        cmds.push(`mb_wr*${P}*${n(a.index, 'index')}*${n(a.slave, 'slave')}*${n(a.func, 'func')}*${n(a.reg, 'reg')}*${a.dtype ?? 1}*${mod}*${a.off ?? 0}*${a.on ?? 1}*${a.period_s ?? 0}=${flags}`);
        break;
      }
      case 'delete': cmds.push(`mb_del*${P}*${n(a.table, 'table')}*${n(a.index, 'index')}=1`); break;
      case 'bus': {
        // a meg nem adott mezok (es a DE-polaritas flag) a jelenlegi bus_cfg-bol
        const m = (await c.getJson<{ modbus: J }>('modbus.json')).modbus ?? {};
        const pn = ((m.panels as J[]) ?? []).find(x => num(x.a) === P); if (!pn) return fail(`no Modbus panel #${P}`);
        const cf = ((pn.cfg as number[]) ?? []).map(num);
        cmds.push(`mb_cfg*${P}*${a.baud ?? cf[0]}*${a.frame ?? cf[1]}*${a.timeout_ms !== undefined ? Math.round(a.timeout_ms / 10) : cf[2] || 25}*${a.retries ?? cf[3]}*${a.gap_ms ?? (cf[4] || 10)}=${cf[5] ?? 0}`);
        break;
      }
      case 'name': cmds.push(a.field_index !== undefined ? kv(`mb_n${P}_${a.field_index}`, n(a.name, 'name')) : a.writer_index !== undefined ? kv(`mb_w${P}_${a.writer_index}`, n(a.name, 'name')) : kv(`mb_pn${P}`, n(a.name, 'name'))); break;
      case 'preset': cmds.push(kv(`mb_pr${P}`, n(a.preset, 'preset'))); break;
      case 'save': cmds.push(`mb_save*${P}=1`); break;
      case 'reload': cmds.push(`mb_reload*${P}=1`); break;
      case 'clear': cmds.push(`mb_clr*${P}=1`); break;
      case 'raw': cmds.push(`mb_raw*${P}*${n(a.slave, 'slave')}*${n(a.func, 'func')}*${n(a.reg, 'reg')}*${a.count ?? 1}=1`); break;
      case 'scan': cmds.push(`mb_scan*${P}*${a.from ?? 1}*${a.to ?? 247}*${a.func ?? 3}*${a.reg ?? 0}=1`); break;
    }
    if (a.save && !['save', 'raw', 'scan', 'clear', 'reload'].includes(act)) cmds.push(`mb_save*${P}=1`);
    const wait = act === 'raw' ? 1500 : act === 'scan' ? 3000 : act === 'preset' || act === 'reload' ? 2000 : 600;
    return done(c, cmds, `Modbus ${act}`, () => mbText(c, P, true), wait);
  });
}
