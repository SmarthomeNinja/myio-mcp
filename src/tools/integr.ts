/**
 * Integraciok (MYIO_MCP_PLAN.md 4.6, 4. kor 2026-10-25): Shelly, myIO Link, MQTT, myIO Cloud, SG-Ready, riasztokozpont (SIA),
 * MIA, ledszalag, halozat, rendszer (ujrainditas, OTA). Forras: a fw parserei (_HTTP_req_event.ino sh_/ml_/led_, _MqttSettings,
 * _CloudSettings, _SgReady, _Alarm, _Ai, _NetSettings) - a BILLENO parametereket (mq_en, mq_ret, al_en, sg_en, led_en, n_eth_dhcp ...)
 * csak elteres eseten kuldjuk (kivant-ertek szemantika). Titkok (jelszo, TLS-kulcs, token) SOHA nem mennek ki a valaszban.
 */
import { z } from 'zod';
import fs from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MyIOClient } from '../api.js';
import { MyIOError } from '../api.js';
import { FEAT, VarBlock, isV4, num, varr, vnum, vstr } from '../model.js';
import { ToolContext, RO, WR_CFG, WR_CFG_SET, WR_ADM, text, fail, serverArg, sleep, gate, kv, sendCmds, toggleTo, setIf, maskSecret, SETTLE_MS } from './common.js';

type J = Record<string, unknown>;
const ip4 = (a: unknown): string => (Array.isArray(a) ? a.join('.') : String(a ?? ''));
const yes = (v: unknown): string => (num(v) ? 'yes' : 'no');
const SH_METRIC = ['-', 'temperature', 'humidity', 'power W', 'voltage V', 'current A', 'energy', 'device temperature'];
const SH_INMODE = ['button (hit/press)', 'toggle (press/release)', 'hit only'];
const MQ_STATE = ['off', 'waiting (backoff)', 'TCP connect', 'MQTT connect', 'CONNECTED', 'sleeping (economy)', 'TLS handshake', 'subscribing'];
const SG_MODE = ['', '1 = inhibit (utility lock: K1 on)', '2 = normal', '3 = recommended (K2 on)', '4 = forced (K1+K2 on)'];
const AL_STATE = ['disarmed / normal', 'partially armed', 'ARMED', 'ALARM'];
const AL_TROUBLE = ['AC power', 'battery', 'tamper', 'communication', 'zone fault', 'supervision lost'];
const CL_STATE = ['off', 'waiting', 'DNS', 'TCP connect', 'TLS handshake', 'MQTT connect', 'READY'];

export const sgText = (c: MyIOClient, vb: VarBlock) => `${c.name} SG-Ready heat pump: ${vnum(vb, 'sg_en') ? 'ENABLED' : 'disabled'}, mode ${SG_MODE[vnum(vb, 'sg_mode')] ?? vnum(vb, 'sg_mode')}`
  + `${vnum(vb, 'sg_rem') ? ` (utility lock ends in ${vnum(vb, 'sg_rem')} min)` : ''}; contacts K1 = output ${vnum(vb, 'sg_k1') || '(none)'}, K2 = output ${vnum(vb, 'sg_k2') || '(none)'}; utility-lock limit ${vnum(vb, 'sg_lim')} min`
  + `${vnum(vb, 'sg_prot') ? '\n  ! a contact output is in a joiner pair - the joiner can fight the SG contacts' : ''}`;
export const miaText = async (c: MyIOClient, zoneRelay?: number) => {
  const j = await c.getJson<J>('ai.json');
  const f = num(j.feat);
  const L = [`${c.name} MIA self-learning heating layer: ${num(j.en) ? 'ENABLED' : 'disabled'}; features: thermal model ${yes(f & 1)}, window detection ${yes(f & 2)}, preheating ${yes(f & 4)}, heating pause on open window ${yes(f & 32)}`,
    `  window detection: drop ${num(j.wd) / 100} °C within ${j.wm} min, hold ${j.wh} min; preheating: max ${j.pm} min, learn over ${j.pd} days; next planned slot ${num(j.nx) >= 0 ? `at ${Math.floor(num(j.nx) / 60)}:${String(num(j.nx) % 60).padStart(2, '0')}` : 'none'}`];
  for (const z of (j.zones as J[]) ?? []) {
    if (zoneRelay && num(z.r) !== zoneRelay) continue;
    const t = num(z.t) === -32768 ? 'n/a' : `${num(z.t) / 100} °C`;
    L.push(`  zone relay ${z.r} (sensor ${z.s}): ${t}, heating ${num(z.on) ? 'ON' : 'off'}${num(z.win) ? ', WINDOW OPEN' : ''}; learned: heat ${num(z.hr) / 100} °C/h, cool ${num(z.cr) / 100} °C/h, dead time ${z.lag} min, `
      + `overshoot ${num(z.ov) / 100} °C, undershoot ${num(z.us) / 100} °C, 24 h duty ${z.duty} %, ${z.cy} cycles, confidence ${z.conf} %, window events ${z.we}`
      + `${z.ps !== undefined ? `; preheat state ${['none', 'planned', 'MIA holding', 'handoff'][num(z.ps)] ?? z.ps}${num(z.pt) >= 0 ? ` for ${Math.floor(num(z.pt) / 60)}:${String(num(z.pt) % 60).padStart(2, '0')}` : ''}, last result ${z.pe} min (${z.pc} runs)` : ''}`
      + `${num(z.xa) ? ', EXCLUDED from MIA actions' : ''}${num(z.xt) ? ', excluded from F3' : ''}${num(z.mo) || num(z.mf) ? `, min on/off ${z.mo}/${z.mf} min` : ''}`);
  }
  if (!((j.zones as J[]) ?? []).length) L.push('  no zones (MIA learns thermostat outputs: a relay with a temperature activator)');
  return L.join('\n');
};

export function registerIntegrationTools(server: McpServer, ctx: ToolContext): void {
  const { reg } = ctx;
  const S = serverArg(reg);
  const done = async (c: MyIOClient, cmds: string[], what: string, after?: () => Promise<string>) => {
    if (!cmds.length) return text(`${c.name}: nothing to change (every requested value already matches).${after ? '\n' + (await after()) : ''}`);
    const posts = await sendCmds(c, cmds);
    await sleep(SETTLE_MS);
    const shown = cmds.map(x => x.replace(/((?:pw|pass|pwd|tkey|token|apass)[^=]*=)[^&]*/gi, '$1***'));
    return text(`${c.name}: ${what} - sent ${shown.join('&')}${posts > 1 ? ` (${posts} requests)` : ''}${after ? '\n' + (await after()) : ''}`);
  };

  // ============================================================ SHELLY ======================================================
  const shellyText = async (c: MyIOClient, scan: boolean) => {
    const j = (await c.getJson<{ shelly: J }>('shelly.json')).shelly ?? {};
    const L = [`${c.name} Shelly integration: ${num(j.en) ? 'ENABLED' : 'disabled'}, ${num(j.shq)} device slots, webhook token ${j.token ? '(set, hidden)' : '(none)'}`];
    for (const [k, v] of Object.entries(j)) {
      if (!/^\d+$/.test(k) || !v || typeof v !== 'object') continue;
      const d = v as J;
      const binds: string[] = [];
      (d.drv as number[] ?? []).forEach((id, ch) => { if (id) binds.push(`ch${ch} follows output ${id}`); });
      (d.insw as number[] ?? []).forEach((sw, ch) => { if (sw) binds.push(`ch${ch} input -> button ${sw} (${SH_INMODE[(d.inmode as number[])[ch]] ?? '?'})`); });
      (d.seni as number[] ?? []).forEach((us, s) => { if (us) binds.push(`sensor slot ${s}: ${SH_METRIC[(d.senm as number[])[s]] ?? '?'} ch${(d.senc as number[])[s]} -> usens ${us}`); });
      L.push(`  #${k} "${d.description ?? ''}" ${d.ip} gen${d.gen} ${d.model ?? ''} (${d.id ?? ''}) - ${num(d.online) ? 'online' : 'OFFLINE'}${num(d.dis) ? ', DISABLED' : ''}${num(d.slp) ? ', battery/sleepy' : ''}, poll ${d.poll} ms, auth ${num(d.authen) ? 'on' : 'off'}${num(d.valid) ? `, state ${num(d.state) ? 'ON' : 'OFF'}` : ''}${num(d.push) ? ', webhook push pending' : ''}`);
      if (binds.length) L.push(`     ${binds.join('; ')}`);
    }
    if (scan) {
      const s = await c.getJson<J>('shellyscan.json').catch(() => ({} as J));
      const sc = (s.scan ?? s) as J;
      const found = (sc.found as J[] | undefined) ?? [];
      L.push(`scan: ${num(sc.active) ? `RUNNING (next ${sc.next})` : 'idle'}, found ${found.length}` + found.map((f, i) => `\n  [${i}] ${f.ip} gen${f.gen} ${f.model ?? ''} ${f.id ?? ''}${num(f.auth) ? ' (password protected)' : ''}`).join(''));
    }
    return L.join('\n');
  };
  server.registerTool('myio_shelly', {
    title: 'Shelly devices',
    description: 'Shelly integration (GIGA/Opta 4.1+): every registered Shelly with IP, model, online state, relay state, and its bindings (which myIO output a channel follows, '
      + 'which myIO button an input drives, which universal sensor a metric feeds). scan=true also shows the results of a network scan (start one with myio_shelly_set action=scan). Editor/admin level.',
    inputSchema: { scan: z.boolean().optional(), server: S },
    annotations: RO,
  }, async ({ scan, server: sv }) => { const c = reg.pick(sv); await c.require(FEAT.shelly, 'the Shelly integration'); return text(await shellyText(c, !!scan)); });

  server.registerTool('myio_shelly_set', {
    title: 'Configure Shelly',
    description: 'Change the Shelly integration; every change is saved (sh_save). action: enable (enabled=true|false), add (ip), add_found (index from the scan), scan (start=true|false), '
      + 'delete / probe / push (device), disable (device, disabled), rename (device, name), poll (device, ms 500..60000), auth (device, user, password), '
      + 'bind_output (device, channel, output_id: the Shelly channel follows that myIO output; 0 = unbind), bind_input (device, channel, button 1..SQ, mode 0 button / 1 toggle / 2 hit-only), '
      + 'bind_sensor (device, slot 0..3, metric 1 temp / 2 hum / 3 power / 4 volt / 5 curr / 6 energy / 7 device temp, channel, usens id; usens 0 = unbind). '
      + 'After input / sensor bindings send action=push so the Shelly calls back. Device = slot number from myio_shelly. Editor/admin level.',
    inputSchema: {
      action: z.enum(['enable', 'add', 'add_found', 'scan', 'delete', 'probe', 'push', 'disable', 'rename', 'poll', 'auth', 'bind_output', 'bind_input', 'bind_sensor']),
      device: z.number().int().min(0).optional(), enabled: z.boolean().optional(), disabled: z.boolean().optional(), start: z.boolean().optional(), ip: z.string().optional(), index: z.number().int().min(0).optional(),
      name: z.string().max(31).optional(), ms: z.number().int().optional(), user: z.string().max(31).optional(), password: z.string().max(31).optional(),
      channel: z.number().int().min(0).max(3).optional(), output_id: z.number().int().min(0).optional(), button: z.number().int().min(0).optional(), mode: z.number().int().min(0).max(2).optional(),
      slot: z.number().int().min(0).max(3).optional(), metric: z.number().int().min(0).max(7).optional(), usens: z.number().int().min(0).optional(), server: S,
    },
    annotations: WR_CFG,
  }, async (a) => {
    const g = gate(ctx, 'config'); if (g) return g;
    const c = reg.pick(a.server);
    await c.require(FEAT.shelly, 'the Shelly integration');
    const j = (await c.getJson<{ shelly: J }>('shelly.json')).shelly ?? {};
    const dev = () => { if (a.device === undefined) throw new MyIOError('device (slot number) is required'); if (!j[String(a.device)]) throw new MyIOError(`no Shelly in slot ${a.device}`); return a.device; };
    const cmds: string[] = [];
    switch (a.action) {
      case 'enable': if (a.enabled === undefined) return fail('enabled=true|false is required'); toggleTo(cmds, j.en, a.enabled, 'sh_en=1'); break;
      case 'add': { const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a.ip ?? ''); if (!m) return fail('ip (a.b.c.d) is required'); cmds.push(`sh_add*0=${m[1]},${m[2]},${m[3]},${m[4]}`); break; }
      case 'add_found': if (a.index === undefined) return fail('index is required'); cmds.push(`sh_addfound*${a.index}=1`); break;
      case 'scan': cmds.push(`sh_scan*1=${a.start === false ? 0 : 1}`); break;
      case 'delete': cmds.push(`sh_del*${dev()}=1`); break;
      case 'probe': cmds.push(`sh_probe*${dev()}=1`); break;
      case 'push': cmds.push(`sh_push*${dev()}=1`); break;
      case 'disable': if (a.disabled === undefined) return fail('disabled=true|false is required'); cmds.push(`sh_disabled*${dev()}=${a.disabled ? 1 : 0}`); break;
      case 'rename': if (a.name === undefined) return fail('name is required'); cmds.push(kv(`sh_descr*${dev() + 1}`, a.name)); break;
      case 'poll': if (!a.ms) return fail('ms is required'); cmds.push(`sh_poll*${dev()}=${a.ms}`); break;
      case 'auth': { const d = dev(); setIf(cmds, `sh_user*${d}`, a.user); setIf(cmds, `sh_pass*${d}`, a.password); break; }
      case 'bind_output': if (a.channel === undefined || a.output_id === undefined) return fail('channel and output_id are required'); cmds.push(`sh_drv*${dev()}=${a.channel},${a.output_id}`); break;
      case 'bind_input': { const d = dev(); if (a.channel === undefined || a.button === undefined) return fail('channel and button are required'); cmds.push(`sh_insw*${d}=${a.channel},${a.button}`); if (a.mode !== undefined) cmds.push(`sh_inmode*${d}=${a.channel},${a.mode}`); break; }
      case 'bind_sensor': { const d = dev(); if (a.slot === undefined || a.usens === undefined) return fail('slot and usens are required'); if (a.metric !== undefined) cmds.push(`sh_senm*${d}=${a.slot},${a.metric}`); if (a.channel !== undefined) cmds.push(`sh_senc*${d}=${a.slot},${a.channel}`); cmds.push(`sh_seni*${d}=${a.slot},${a.usens}`); break; }
    }
    if (cmds.length && !['scan', 'probe', 'push', 'delete'].includes(a.action)) cmds.push('sh_save=1');
    return done(c, cmds, `Shelly ${a.action}`, async () => { await sleep(a.action === 'add' || a.action === 'probe' ? 1500 : 0); return shellyText(c, a.action === 'scan'); });
  });

  // ============================================================ LINK ========================================================
  const linkText = async (c: MyIOClient, scan: boolean) => {
    const j = (await c.getJson<{ link: J }>('link.json')).link ?? {};
    const L = [`${c.name} myIO Link: ${num(j.en) ? 'active' : 'idle (no server)'}; ${num(j.mlq)} server slots, ${num(j.rq)} output links, ${num(j.senq)} sensor links${num(j.nosock) ? `; ${j.nosock} polls skipped for lack of a socket` : ''}`];
    for (const [k, s] of Object.entries((j.srv ?? {}) as Record<string, J>)) L.push(`  server ${k}: "${s.name ?? ''}" ${s.ip}:${s.port} (${s.serial ?? '?'}, gen ${s.gen ?? '?'}) - ${num(s.online) ? 'online' : 'OFFLINE'}${num(s.dis) ? ', DISABLED' : ''}${num(s.authbad) ? ', WRONG PASSWORD' : ''}, user "${s.user ?? ''}" password ${num(s.pwset) ? 'set' : 'none'}, poll ${s.poll} ms`);
    for (const [k, l] of Object.entries((j.links ?? {}) as Record<string, J>)) L.push(`  link ${k}: local ${l.loc} <- server ${l.srv} remote ${l.rem}${num(l.mir) ? ' (mirror)' : ''}${num(l.dis) ? ', DISABLED' : ''}${num(l.valid) ? '' : ', not valid yet'}${num(l.warn) ? ', WARNING' : ''}`);
    for (const [k, l] of Object.entries((j.slinks ?? {}) as Record<string, J>)) L.push(`  sensor link ${k}: local usens ${l.loc} <- server ${l.srv} remote sensor ${l.rem}${num(l.dis) ? ', DISABLED' : ''}`);
    if (scan) {
      const s = await c.getJson<J>('linkscan.json').catch(() => ({} as J));
      const sc = (s.scan ?? s) as J; const found = (sc.found as J[] | undefined) ?? [];
      L.push(`scan: ${num(sc.active) ? 'RUNNING' : 'idle'}, found ${found.length}` + found.map((f, i) => `\n  [${i}] ${f.ip} "${f.name ?? ''}" ${f.serial ?? ''} gen ${f.gen ?? '?'}${num(f.auth) ? ' (password protected)' : ''}`).join(''));
    }
    return L.join('\n');
  };
  server.registerTool('myio_link', {
    title: 'myIO Link (controller to controller)',
    description: 'myIO Link (GIGA/Opta 4.2+): the other myIO controllers this one polls, their online state, the output links (a local output mirrors / drives a remote one) and sensor links '
      + '(a remote sensor feeds a local universal sensor). scan=true shows network scan results. Editor/admin level.',
    inputSchema: { scan: z.boolean().optional(), server: S },
    annotations: RO,
  }, async ({ scan, server: sv }) => { const c = reg.pick(sv); await c.require(FEAT.link, 'myIO Link'); return text(await linkText(c, !!scan)); });

  server.registerTool('myio_link_set', {
    title: 'Configure myIO Link',
    description: 'Change myIO Link; saved with ml_save. action: add (ip), add_found (index), scan (start), delete / probe / refresh_names (server slot 0..), disable (server, disabled), '
      + 'port / poll / rename / auth (server, port | ms | name | user+password), link (index, local_id, server 1.., remote_id: local output follows the remote one), unlink (index), '
      + 'link_disable (index, disabled), sensor_link (index, remote_id, server 1.., local_usens), sensor_link_disable (index, disabled). Editor/admin level.',
    inputSchema: {
      action: z.enum(['add', 'add_found', 'scan', 'delete', 'probe', 'refresh_names', 'disable', 'port', 'poll', 'rename', 'auth', 'link', 'unlink', 'link_disable', 'sensor_link', 'sensor_link_disable']),
      srv: z.number().int().min(0).optional().describe('server slot (0-based, as in myio_link)'), index: z.number().int().min(0).optional(), ip: z.string().optional(), start: z.boolean().optional(),
      disabled: z.boolean().optional(), port: z.number().int().min(1).max(65535).optional(), ms: z.number().int().optional(), name: z.string().max(31).optional(), user: z.string().max(31).optional(), password: z.string().max(31).optional(),
      local_id: z.number().int().optional(), remote_id: z.number().int().optional(), server_no: z.number().int().min(1).optional().describe('server number 1.. for link / sensor_link'), local_usens: z.number().int().optional(), server: S,
    },
    annotations: WR_CFG,
  }, async (a) => {
    const g = gate(ctx, 'config'); if (g) return g;
    const c = reg.pick(a.server);
    await c.require(FEAT.link, 'myIO Link');
    const need = (v: unknown, n: string) => { if (v === undefined) throw new MyIOError(`${n} is required for ${a.action}`); return v as number; };
    const cmds: string[] = [];
    switch (a.action) {
      case 'add': { const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a.ip ?? ''); if (!m) return fail('ip (a.b.c.d) is required'); cmds.push(`ml_add*0=${m[1]},${m[2]},${m[3]},${m[4]}`); break; }
      case 'add_found': cmds.push(`ml_addfound*${need(a.index, 'index')}=1`); break;
      case 'scan': cmds.push(`ml_scan*1=${a.start === false ? 0 : 1}`); break;
      case 'delete': cmds.push(`ml_del*${need(a.srv, 'srv')}=1`); break;
      case 'probe': cmds.push(`ml_probe*${need(a.srv, 'srv')}=1`); break;
      case 'refresh_names': cmds.push(`ml_names*${need(a.srv, 'srv')}=1`); break;
      case 'disable': cmds.push(`ml_dis*${need(a.srv, 'srv')}=${a.disabled ? 1 : 0}`); break;
      case 'port': cmds.push(`ml_port*${need(a.srv, 'srv')}=${need(a.port, 'port')}`); break;
      case 'poll': cmds.push(`ml_poll*${need(a.srv, 'srv')}=${need(a.ms, 'ms')}`); break;
      case 'rename': cmds.push(kv(`ml_name*${need(a.srv, 'srv')}`, need(a.name, 'name'))); break;
      case 'auth': { const s = need(a.srv, 'srv'); setIf(cmds, `ml_user*${s}`, a.user); setIf(cmds, `ml_pass*${s}`, a.password); break; }
      case 'link': cmds.push(`ml_link*${need(a.index, 'index')}=${need(a.local_id, 'local_id')},${need(a.server_no, 'server_no')},${need(a.remote_id, 'remote_id')}`); break;
      case 'unlink': cmds.push(`ml_dellink*${need(a.index, 'index')}=1`); break;
      case 'link_disable': cmds.push(`ml_ldis*${need(a.index, 'index')}=${a.disabled ? 1 : 0}`); break;
      case 'sensor_link': cmds.push(`ml_slink*${need(a.index, 'index')}=${need(a.remote_id, 'remote_id')},${need(a.server_no, 'server_no')},${need(a.local_usens, 'local_usens')}`); break;
      case 'sensor_link_disable': cmds.push(`ml_sdis*${need(a.index, 'index')}=${a.disabled ? 1 : 0}`); break;
    }
    if (!['scan', 'probe', 'refresh_names'].includes(a.action)) cmds.push('ml_save=1');
    return done(c, cmds, `Link ${a.action}`, async () => { await sleep(['add', 'probe'].includes(a.action) ? 1500 : 0); return linkText(c, a.action === 'scan'); });
  });

  // ============================================================ MQTT ========================================================
  const mqttText = (c: MyIOClient, vb: VarBlock) => {
    const chg = vnum(vb, 'mq_chg'), per = vnum(vb, 'mq_per');
    const L = [`${c.name} MQTT client: ${vnum(vb, 'mq_en') ? 'ENABLED' : 'disabled'} - ${MQ_STATE[vnum(vb, 'mq_state')] ?? vnum(vb, 'mq_state')}${vnum(vb, 'mq_dirty') ? ' (UNSAVED changes - myio_mqtt_set save=true)' : ''}`,
      `  broker ${vstr(vb, 'mq_host') || '(none)'}:${vnum(vb, 'mq_port')} (resolved ${vstr(vb, 'mq_bip')}), user "${vstr(vb, 'mq_user')}", password ${maskSecret('mq_pw', vstr(vb, 'mq_pw'))}${vb.has('mq_tls') ? `, TLS ${yes(vnum(vb, 'mq_tls'))} (key ${maskSecret('mq_tkey', vstr(vb, 'mq_tkey'))})` : ''}`,
      `  client id "${vstr(vb, 'mq_cid')}" (empty = myio-<host>), base topic "${vstr(vb, 'mq_base') || vstr(vb, 'mq_host_eff')}", retain ${yes(vnum(vb, 'mq_ret'))}, QoS ${vnum(vb, 'mq_qos')}, Home Assistant discovery ${yes(vnum(vb, 'mq_ha'))}${vb.has('mq_eco') ? `, economy ${yes(vnum(vb, 'mq_eco'))}` : ''}`,
      `  publish on change: buttons ${yes(chg & 1)}, outputs ${yes(chg & 2)}, sensor activators ${yes(chg & 4)}; periodic every ${vnum(vb, 'mq_pers')} s: outputs ${yes(per & 1)}, temperatures ${yes(per & 2)}, humidity ${yes(per & 4)}, usens ${yes(per & 8)}, SDM ${yes(per & 16)}`,
      `  subscribe (control from MQTT) ${yes(vnum(vb, 'mq_sub'))}, command channel ${yes(vnum(vb, 'mq_cmd'))} (slot ${vnum(vb, 'mq_cslot')}); dropped events ${vnum(vb, 'mq_drop')}, commands received ${vnum(vb, 'mq_cmdrx')}, denied ${vnum(vb, 'mq_subden')}, sensor values received ${vnum(vb, 'mq_senrx')}`];
    const t = varr(vb, 'mqs_t'), k = varr(vb, 'mqs_k'), id = varr(vb, 'mqs_i');
    const binds = t.map((tp, i) => ({ i, tp, k: k[i], id: id[i] })).filter(x => x.tp);
    if (vb.has('mqs_t')) L.push(`  external sensor bindings (${t.length} slots): ${binds.length ? binds.map(b => `\n    [${b.i}] "${b.tp}"${b.k ? ` key "${b.k}"` : ''} -> usens ${b.id}`).join('') : 'none'}`);
    return L.join('\n');
  };
  server.registerTool('myio_mqtt', {
    title: 'MQTT client',
    description: 'MQTT client settings and live state (GIGA/Opta 4.3+, Due 3.12.31+): broker, connection state, topics, retain/QoS, Home Assistant discovery, publish masks, subscribe/command channel, '
      + 'external sensor bindings (topic + JSON key -> universal sensor, 4.5+). Passwords and TLS keys are never shown. Editor/admin level.',
    inputSchema: { server: S },
    annotations: RO,
  }, async ({ server: sv }) => { const c = reg.pick(sv); await c.require(FEAT.mqtt, 'the MQTT client'); return text(mqttText(c, await c.pageVars('mqtt', 'mq_en'))); });

  server.registerTool('myio_mqtt_set', {
    title: 'Configure MQTT',
    description: 'Change the MQTT client. Only the given fields change; on/off fields are desired values (sent only when different). save=true (default) persists and reconnects (MqttSave). '
      + 'Fields: enabled, host, port, user, password, client_id, base_topic, retain, qos 0|1, ha_discovery, economy (4.x), tls (4.x), publish_on_change {buttons, outputs, activators}, '
      + 'periodic {outputs, temperatures, humidity, usens (4.x), sdm} + period_s 5..65000, subscribe, command_channel, command_slot; sensor_binding {slot, topic, key, usens} (4.5+; usens 0 = unbind); '
      + 'rediscover=true refreshes the Home Assistant entities without reconnecting. Editor/admin level.',
    inputSchema: {
      enabled: z.boolean().optional(), host: z.string().max(64).optional(), port: z.number().int().min(1).max(65535).optional(), user: z.string().max(32).optional(), password: z.string().max(32).optional(),
      client_id: z.string().max(32).optional(), base_topic: z.string().max(40).optional(), retain: z.boolean().optional(), qos: z.number().int().min(0).max(1).optional(), ha_discovery: z.boolean().optional(),
      economy: z.boolean().optional(), tls: z.boolean().optional(),
      publish_on_change: z.object({ buttons: z.boolean().optional(), outputs: z.boolean().optional(), activators: z.boolean().optional() }).optional(),
      periodic: z.object({ outputs: z.boolean().optional(), temperatures: z.boolean().optional(), humidity: z.boolean().optional(), usens: z.boolean().optional(), sdm: z.boolean().optional() }).optional(),
      period_s: z.number().int().min(5).max(65000).optional(), subscribe: z.boolean().optional(), command_channel: z.boolean().optional(), command_slot: z.number().int().min(0).optional(),
      sensor_binding: z.object({ slot: z.number().int().min(0), topic: z.string().max(64).optional(), key: z.string().max(24).optional(), usens: z.number().int().min(0).optional() }).optional(),
      rediscover: z.boolean().optional(), save: z.boolean().optional(), server: S,
    },
    annotations: WR_CFG_SET,
  }, async (a) => {
    const g = gate(ctx, 'config'); if (g) return g;
    const c = reg.pick(a.server);
    await c.require(FEAT.mqtt, 'the MQTT client');
    const v4 = isV4(await c.version());
    if (!v4 && (a.economy !== undefined || a.tls !== undefined || a.periodic?.usens !== undefined)) return fail('economy, tls and periodic.usens need GIGA/Opta 4.x');
    if (a.sensor_binding) await c.require(FEAT.mqttSensors, 'MQTT external sensor bindings');
    const vb = await c.pageVars('mqtt', 'mq_en');
    const cmds: string[] = [];
    toggleTo(cmds, vnum(vb, 'mq_en'), a.enabled, 'mq_en=1');
    setIf(cmds, 'mq_host', a.host); setIf(cmds, 'mq_port', a.port); setIf(cmds, 'mq_user', a.user); setIf(cmds, 'mq_pw', a.password);
    setIf(cmds, 'mq_cid', a.client_id); setIf(cmds, 'mq_base', a.base_topic);
    toggleTo(cmds, vnum(vb, 'mq_ret'), a.retain, 'mq_ret=1'); setIf(cmds, 'mq_qos', a.qos); toggleTo(cmds, vnum(vb, 'mq_ha'), a.ha_discovery, 'mq_ha=1');
    toggleTo(cmds, vnum(vb, 'mq_eco'), a.economy, 'mq_eco=1'); toggleTo(cmds, vnum(vb, 'mq_tls'), a.tls, 'mq_tls=1');
    const chg = vnum(vb, 'mq_chg'), per = vnum(vb, 'mq_per');
    const po = a.publish_on_change ?? {}; toggleTo(cmds, chg & 1, po.buttons, 'mq_chg_btn=1'); toggleTo(cmds, chg & 2, po.outputs, 'mq_chg_out=1'); toggleTo(cmds, chg & 4, po.activators, 'mq_chg_act=1');
    const pe = a.periodic ?? {}; toggleTo(cmds, per & 1, pe.outputs, 'mq_per_out=1'); toggleTo(cmds, per & 2, pe.temperatures, 'mq_per_tmp=1'); toggleTo(cmds, per & 4, pe.humidity, 'mq_per_hum=1');
    toggleTo(cmds, per & 8, pe.usens, 'mq_per_us=1'); toggleTo(cmds, per & 16, pe.sdm, 'mq_per_sdm=1');
    setIf(cmds, 'mq_pers', a.period_s); toggleTo(cmds, vnum(vb, 'mq_sub'), a.subscribe, 'mq_sub=1'); toggleTo(cmds, vnum(vb, 'mq_cmd'), a.command_channel, 'mq_cmd=1'); setIf(cmds, 'mq_cslot', a.command_slot);
    if (a.sensor_binding) {
      const b = a.sensor_binding; const q = vnum(vb, 'mq_senq', 8);
      if (b.slot >= q) return fail(`sensor binding slot must be 0..${q - 1}`);
      setIf(cmds, `mqs_t${b.slot}`, b.topic); setIf(cmds, `mqs_k${b.slot}`, b.key); setIf(cmds, `mqs_i${b.slot}`, b.usens);
    }
    if (cmds.length && a.save !== false) cmds.push('MqttSave=1');
    if (a.rediscover) cmds.push('MqttRediscover=1');
    return done(c, cmds, 'MQTT settings', async () => { await sleep(cmds.some(x => x.startsWith('MqttSave')) ? 2500 : 0); return mqttText(c, await c.pageVars('mqtt', 'mq_en')); });
  });

  // ============================================================ CLOUD =======================================================
  const cloudText = (c: MyIOClient, vb: VarBlock) => {
    const used = varr(vb, 'cl_kused'), lab = varr(vb, 'cl_klab'), slot = varr(vb, 'cl_kslot'), rev = varr(vb, 'cl_krev'), pend = varr(vb, 'cl_kpend');
    const keys = used.map((u, i) => ({ i, u, l: lab[i], s: slot[i], r: rev[i], p: pend[i] })).filter(k => Number(k.u));
    return [`${c.name} myIO Cloud: ${vnum(vb, 'cl_en') ? 'ENABLED' : 'disabled'} - ${CL_STATE[vnum(vb, 'cl_state')] ?? `state ${vnum(vb, 'cl_state')}`}; broker ${vstr(vb, 'cl_host')}:${vnum(vb, 'cl_port')} (resolved ${vstr(vb, 'cl_bip')}), device ${vstr(vb, 'cl_devid')}`,
      `  pairing window: ${vnum(vb, 'cl_pairwin') ? `OPEN (${vnum(vb, 'cl_pairwin')} s left)` : 'closed'}; licence pairing limit ${vnum(vb, 'cl_lpq')}, used ${vnum(vb, 'cl_lpu')}`,
      `  paired phones/keys: ${keys.length ? keys.map(k => `\n    key ${k.i}: "${k.l}" for user slot ${k.s}${Number(k.r) ? ' (REVOKED)' : ''}${Number(k.p) ? ' (pairing pending)' : ''}`).join('') : 'none'}`].join('\n');
  };
  server.registerTool('myio_cloud', {
    title: 'myIO Cloud',
    description: 'myIO Cloud remote access (GIGA/Opta 4.4+): enabled, connection state, broker, pairing window, paired phone keys (label, user slot, revoked). Credentials and keys are never shown. Admin level on the controller.',
    inputSchema: { server: S },
    annotations: RO,
  }, async ({ server: sv }) => { const c = reg.pick(sv); await c.require(FEAT.cloud, 'myIO Cloud'); return text(cloudText(c, await c.pageVars('cloud', 'cl_en'))); });

  server.registerTool('myio_cloud_set', {
    title: 'Manage myIO Cloud',
    description: 'myIO Cloud actions (admin): enable (enabled=true|false), pair (user_slot 1.., label: opens a 5-minute pairing window for one phone - show the QR from the web page), pair_stop, '
      + 'revoke (key, revoked=true|false), delete_key (key). Needs MYIO_WRITE=admin.',
    inputSchema: { action: z.enum(['enable', 'pair', 'pair_stop', 'revoke', 'delete_key']), enabled: z.boolean().optional(), user_slot: z.number().int().min(1).optional(), label: z.string().max(23).optional(),
      key: z.number().int().min(0).max(7).optional(), revoked: z.boolean().optional(), server: S },
    annotations: WR_ADM,
  }, async (a) => {
    const g = gate(ctx, 'admin'); if (g) return g;
    const c = reg.pick(a.server);
    await c.require(FEAT.cloud, 'myIO Cloud');
    const vb = await c.pageVars('cloud', 'cl_en');
    const cmds: string[] = [];
    if (a.action === 'enable') { if (a.enabled === undefined) return fail('enabled is required'); toggleTo(cmds, vnum(vb, 'cl_en'), a.enabled, 'cl_en=1'); }
    else if (a.action === 'pair') { if (!a.user_slot) return fail('user_slot is required'); if (a.label) cmds.push(kv('cl_plab', a.label)); cmds.push(`cl_pair=${a.user_slot}`); }
    else if (a.action === 'pair_stop') cmds.push('cl_pairstop=1');
    else {
      if (a.key === undefined) return fail('key is required');
      if (!Number(varr(vb, 'cl_kused')[a.key])) return fail(`key slot ${a.key} is empty`);
      if (a.action === 'revoke') { if (a.revoked === undefined) return fail('revoked=true|false is required'); toggleTo(cmds, varr(vb, 'cl_krev')[a.key], a.revoked, `cl_krev=${a.key}`); }
      else cmds.push(`cl_kdel=${a.key}`);
    }
    return done(c, cmds, `Cloud ${a.action}`, async () => cloudText(c, await c.pageVars('cloud', 'cl_en')));
  });

  // ============================================================ SG-READY ====================================================
  server.registerTool('myio_sgready', {
    title: 'SG-Ready heat pump',
    description: 'SG-Ready heat pump control (GIGA/Opta 4.4.2+, Due 3.12.9+): enabled, current mode (1 inhibit / 2 normal / 3 recommended / 4 forced), K1/K2 contact outputs, utility-lock limit. Editor/admin level.',
    inputSchema: { server: S },
    annotations: RO,
  }, async ({ server: sv }) => { const c = reg.pick(sv); await c.require(FEAT.sgready, 'SG-Ready'); return text(sgText(c, await c.pageVars('sg', 'sg_en'))); });

  server.registerTool('myio_sgready_set', {
    title: 'Set SG-Ready',
    description: 'Change SG-Ready: mode 1..4 (immediate; mode 1 ends automatically after limit_min), enabled, k1 / k2 (output ids: relay 1.. or PCA 2001..; 0 = none; K1 and K2 must differ), limit_min 1..120. '
      + 'Mode is a state change (MYIO_WRITE=state); the others are configuration. Saved immediately (EEPROM).',
    inputSchema: { mode: z.number().int().min(1).max(4).optional(), enabled: z.boolean().optional(), k1: z.number().int().min(0).optional(), k2: z.number().int().min(0).optional(), limit_min: z.number().int().min(1).max(120).optional(), server: S },
    annotations: WR_CFG_SET,
  }, async (a) => {
    const g = gate(ctx, a.enabled !== undefined || a.k1 !== undefined || a.k2 !== undefined || a.limit_min !== undefined ? 'config' : 'state'); if (g) return g;
    const c = reg.pick(a.server);
    await c.require(FEAT.sgready, 'SG-Ready');
    const vb = await c.pageVars('sg', 'sg_en');
    const cmds: string[] = [];
    toggleTo(cmds, vnum(vb, 'sg_en'), a.enabled, 'sg_en=1');
    // K1/K2 csere: elobb a 0-ra allitas, hogy a K1 != K2 ellenorzes ne bukjon
    if (a.k1 !== undefined && a.k2 !== undefined && a.k1 === vnum(vb, 'sg_k2')) { cmds.push('sg_k2=0'); }
    setIf(cmds, 'sg_k1', a.k1); setIf(cmds, 'sg_k2', a.k2); setIf(cmds, 'sg_lim', a.limit_min); setIf(cmds, 'sg_mode', a.mode);
    return done(c, cmds, 'SG-Ready', async () => sgText(c, await c.pageVars('sg', 'sg_en')));
  });

  // ============================================================ ALARM =======================================================
  const alarmText = async (c: MyIOClient) => {
    const a = (await c.getJson<{ alarm: J }>('alarm.json')).alarm ?? {};
    const vb = await c.pageVars('alarm').catch(() => new Map() as VarBlock);
    const tr = num(a.tr);
    const parts = ((a.p as J[]) ?? []).map((p, i) => `  partition ${i + 1}: ${AL_STATE[num(p.st)] ?? p.st}${p.c ? ` (last code ${p.c}, zone ${p.z}, user ${p.u}, ${num(p.age) >= 0 ? `${p.age} s ago` : 'never'})` : ''}${num(p.sen) ? ` -> usens ${p.sen}` : ''}`);
    return [`${c.name} alarm panel receiver (SIA DC-09): ${num(a.en) ? 'ENABLED' : 'disabled'}, TCP ${num(a.tcp) ? 'listening' : 'off'}, UDP ${num(a.udp) ? 'listening' : 'off'}${vb.has('al_port') ? ` on port ${vnum(vb, 'al_port')}` : ''}`
      + `${vb.has('al_acct') ? `, account "${vstr(vb, 'al_acct')}"` : ''}${vb.has('al_sup') ? `, supervision ${vnum(vb, 'al_sup')} min` : ''}`,
      `  last valid frame ${num(a.age) >= 0 ? `${a.age} s ago from ${a.ip}` : 'never'}; received ${a.rx}, ACK ${a.ack}, NAK ${a.nak}, duplicate ${a.duh}, CRC error ${a.crc}, rejected ${a.rej}, parse error ${a.perr}, events ${a.ev}, simulated ${a.sim}`,
      `  troubles: ${tr ? AL_TROUBLE.filter((_, i) => tr & (1 << i)).join(', ') : 'none'}`, ...parts, a.raw ? `  last raw frame: ${a.raw}` : ''].filter(Boolean).join('\n');
  };

  server.registerTool('myio_alarm', {
    title: 'Alarm panel (SIA receiver)',
    description: 'The alarm panel receiver (GIGA/Opta 4.5.8+, SIA DC-09 over TCP/UDP): enabled, listeners, frame counters, troubles (AC, battery, tamper, communication, zone, supervision), '
      + 'per-partition state (disarmed / partial / armed / ALARM) with the last event code, zone and user, and the universal sensor each partition feeds. Monitoring only (no arming). Editor/admin level.',
    inputSchema: { server: S },
    annotations: RO,
  }, async ({ server: sv }) => { const c = reg.pick(sv); await c.require(FEAT.alarm, 'the alarm receiver'); return text(await alarmText(c)); });

  server.registerTool('myio_alarm_set', {
    title: 'Configure the alarm receiver',
    description: 'Change the SIA receiver (saved with AlarmSave): enabled, tcp, udp, ack_timestamp (desired values), port 1024..49151 (not 80/843), account (max 32), supervision_min 0..1440, '
      + 'partition_sensor {partition 1.., usens (0 = none)}. simulate = a DC-03 test event like "Nri1/BA01" (burglary alarm partition 1 zone 1) - drives the partition state and its usens; reset_counters=true. '
      + 'TCP on/off takes effect after a restart. Editor/admin level.',
    inputSchema: { enabled: z.boolean().optional(), tcp: z.boolean().optional(), udp: z.boolean().optional(), ack_timestamp: z.boolean().optional(), port: z.number().int().min(1024).max(49151).optional(),
      account: z.string().max(32).optional(), supervision_min: z.number().int().min(0).max(1440).optional(), partition_sensor: z.object({ partition: z.number().int().min(1), usens: z.number().int().min(0) }).optional(),
      simulate: z.string().max(64).optional(), reset_counters: z.boolean().optional(), server: S },
    annotations: WR_CFG,
  }, async (a) => {
    const g = gate(ctx, a.simulate && Object.keys(a).filter(k => !['simulate', 'server'].includes(k) && (a as J)[k] !== undefined).length === 0 ? 'state' : 'config'); if (g) return g;
    const c = reg.pick(a.server);
    await c.require(FEAT.alarm, 'the alarm receiver');
    const st = (await c.getJson<{ alarm: J }>('alarm.json')).alarm ?? {};
    const vb = await c.pageVars('alarm').catch(() => new Map() as VarBlock);
    const cmds: string[] = [];
    toggleTo(cmds, st.en, a.enabled, 'al_en=1');
    toggleTo(cmds, vb.has('al_tcp') ? vnum(vb, 'al_tcp') : st.tcp, a.tcp, 'al_tcp=1');
    toggleTo(cmds, vb.has('al_udp') ? vnum(vb, 'al_udp') : st.udp, a.udp, 'al_udp=1');
    if (a.ack_timestamp !== undefined) { if (!vb.has('al_ats')) return fail('cannot read the current ACK-timestamp setting'); toggleTo(cmds, vnum(vb, 'al_ats'), a.ack_timestamp, 'al_ats=1'); }
    if (a.port === 80 || a.port === 843) return fail('port 80 and 843 are taken by the web server and the app');
    setIf(cmds, 'al_port', a.port); setIf(cmds, 'al_acct', a.account); setIf(cmds, 'al_sup', a.supervision_min);
    if (a.partition_sensor) cmds.push(`al_s${a.partition_sensor.partition}=${a.partition_sensor.usens}`);
    const cfgChanged = cmds.length > 0;
    if (a.reset_counters) cmds.push('al_reset=1');
    if (a.simulate) cmds.push(kv('al_sim', a.simulate));
    if (cfgChanged) cmds.push('AlarmSave=1');
    return done(c, cmds, 'alarm receiver', async () => { await sleep(a.simulate ? 400 : 0); return alarmText(c); });
  });

  // ============================================================ MIA =========================================================
  server.registerTool('myio_mia', {
    title: 'MIA (self-learning heating)',
    description: 'MIA, the self-learning heating layer (GIGA/Opta 4.11+): features (thermal model, window detection, preheating, pause), and per thermostat zone the learned heat/cool rates, dead time, '
      + 'over/undershoot, duty, confidence, window events, preheating plan and result. zone = one relay id. Editor/admin level.',
    inputSchema: { zone: z.number().int().optional(), server: S },
    annotations: RO,
  }, async ({ zone, server: sv }) => { const c = reg.pick(sv); await c.require(FEAT.mia, 'MIA'); return text(await miaText(c, zone)); });

  server.registerTool('myio_mia_set', {
    title: 'Configure MIA',
    description: 'Change MIA (saved immediately): enabled, features {model, window, preheat, pause} (desired values), window_drop_c 0.1..5, window_min 2..15, window_hold_min 5..240, preheat_max_min 15..240 (4.12+), '
      + 'learn_days 1..6, exclude {relay, excluded} (MIA does not act on that zone), exclude_f3 {relay, excluded} (4.13+), min_on_off {relay, on_min, off_min} (0 = auto, 4.13+), reset_learned (relay id, 0 = all zones). Editor/admin level.',
    inputSchema: { enabled: z.boolean().optional(), features: z.object({ model: z.boolean().optional(), window: z.boolean().optional(), preheat: z.boolean().optional(), pause: z.boolean().optional() }).optional(),
      window_drop_c: z.number().min(0.1).max(5).optional(), window_min: z.number().int().min(2).max(15).optional(), window_hold_min: z.number().int().min(5).max(240).optional(),
      preheat_max_min: z.number().int().min(15).max(240).optional(), learn_days: z.number().int().min(1).max(6).optional(),
      exclude: z.object({ relay: z.number().int(), excluded: z.boolean() }).optional(), exclude_f3: z.object({ relay: z.number().int(), excluded: z.boolean() }).optional(),
      min_on_off: z.object({ relay: z.number().int(), on_min: z.number().int().min(0).max(120).optional(), off_min: z.number().int().min(0).max(120).optional() }).optional(),
      reset_learned: z.number().int().min(0).optional(), server: S },
    annotations: WR_CFG,
  }, async (a) => {
    const g = gate(ctx, 'config'); if (g) return g;
    const c = reg.pick(a.server);
    await c.require(FEAT.mia, 'MIA');
    const j = await c.getJson<J>('ai.json');
    const zones = (j.zones as J[]) ?? [];
    const zone = (r: number) => { const z = zones.find(x => num(x.r) === r); if (!z) throw new MyIOError(`relay ${r} is not a MIA zone (zones: ${zones.map(x => x.r).join(', ') || 'none'})`); return z; };
    const cmds: string[] = [];
    toggleTo(cmds, j.en, a.enabled, 'ai_en=1');
    if (a.features) {
      let f = num(j.feat); const F = a.features;
      const bit = (b: number, w?: boolean) => { if (w !== undefined) f = w ? f | b : f & ~b; };
      bit(1, F.model); bit(2, F.window); bit(4, F.preheat); bit(32, F.pause);
      if (f !== num(j.feat)) cmds.push(`ai_feat=${f}`);
    }
    if (a.window_drop_c !== undefined) cmds.push(`ai_wd=${Math.round(a.window_drop_c * 100)}`);
    setIf(cmds, 'ai_wm', a.window_min); setIf(cmds, 'ai_wh', a.window_hold_min); setIf(cmds, 'ai_pm', a.preheat_max_min); setIf(cmds, 'ai_pd', a.learn_days);
    if (a.exclude) toggleTo(cmds, zone(a.exclude.relay).xa, a.exclude.excluded, `ai_xa=${a.exclude.relay}`);
    if (a.exclude_f3) toggleTo(cmds, zone(a.exclude_f3.relay).xt, a.exclude_f3.excluded, `ai_xt=${a.exclude_f3.relay}`);
    if (a.min_on_off) { zone(a.min_on_off.relay); if (a.min_on_off.on_min !== undefined) cmds.push(`ai_mo*${a.min_on_off.relay}=${a.min_on_off.on_min}`); if (a.min_on_off.off_min !== undefined) cmds.push(`ai_mf*${a.min_on_off.relay}=${a.min_on_off.off_min}`); }
    if (a.reset_learned !== undefined) { if (a.reset_learned) zone(a.reset_learned); cmds.push(`ai_reset=${a.reset_learned}`); }
    return done(c, cmds, 'MIA', async () => miaText(c));
  });

  // ============================================================ LEDSTRIP ====================================================
  const ledText = async (c: MyIOClient, prog?: number) => {
    const vb = await c.pageVars('ledstrip', 'led_en');
    const fx = await c.getJson<{ ledfx: J }>('ledfx.json').then(x => x.ledfx).catch(() => ({} as J));
    const fxList = ((fx.fx as J[]) ?? []).map(f => String(f.k));
    const pins = varr(vb, 'led_pins'), len = varr(vb, 'led_len'), act = varr(vb, 'led_act'), slot = varr(vb, 'led_slot');
    const pn = varr(vb, 'led_pn'), pv = varr(vb, 'led_pv') as unknown as number[][];
    const L = [`${c.name} LED strips (WS2812): ${vnum(vb, 'led_en') ? 'ENABLED' : 'disabled'}, pin mask ${vnum(vb, 'led_mask')} (restart-bound), ${vnum(vb, 'led_progq')} programs`];
    pins.forEach((p, i) => { if (Number(len[i])) L.push(`  IO${i + 1} (D${p}): ${len[i]} LEDs, ${Number(act[i]) ? `running program ${slot[i]}` : 'off'} - event ids ${3100 + i * 100 + 1}..${3100 + i * 100 + vnum(vb, 'led_progq')}`); });
    if (!pins.some((_, i) => Number(len[i]))) L.push('  no strip configured (LED count 0 on every IO)');
    const F = ['fx', 'speed', 'brightness', 'intensity', 'density', 'length', 'palette', 'direction', 'color1', 'color2', 'a', 'b', 'blend', 'blend_fx', 'blend_dir', 'kill', 'kill_fx', 'kill_dir', 'off_pause'];
    (pn as string[]).forEach((n, i) => {
      if (prog && prog !== i + 1) return;
      const v = pv[i] ?? [];
      if (!n && !v.some(Boolean) && !prog) return;
      L.push(`  program ${i + 1} "${n}": ${v.map((x, k) => `${F[k] ?? k}=${k === 0 || k === 13 || k === 16 ? fxList[x] ?? x : k === 8 || k === 9 ? '#' + Number(x).toString(16).padStart(6, '0') : x}`).join(', ')}`);
    });
    if (fxList.length && prog) L.push(`  effects: ${fxList.map((k, i) => `${i}=${k}`).join(', ')}`);
    return L.join('\n');
  };
  server.registerTool('myio_ledstrip', {
    title: 'LED strips',
    description: 'Addressable LED strips (GIGA/Opta 4.3.4+): enabled, strips per IO pin (LED count, running program), programs (effect, speed, brightness, colours, blend/kill transitions...). '
      + 'prog = one program with the effect list. Event id 3100+100*(IO-1)+program starts/stops a program (buttons, timers, Flow). Editor/admin level.',
    inputSchema: { prog: z.number().int().min(1).max(32).optional(), server: S },
    annotations: RO,
  }, async ({ prog, server: sv }) => { const c = reg.pick(sv); await c.require(FEAT.ledstrip, 'LED strips'); return text(await ledText(c, prog)); });

  server.registerTool('myio_ledstrip_set', {
    title: 'Control / configure LED strips',
    description: 'LED strips: event (id 3100+100*(IO-1)+program: run that program on that IO, the same id again stops it - MYIO_WRITE=state), enabled (desired), '
      + 'program edits (prog 1..32 with fields {fx, speed, brightness, intensity, density, length, palette, direction, color1, color2 (0xRRGGBB number), a, b, blend, blend_fx, blend_dir, kill, kill_fx, kill_dir, off_pause}, name) '
      + 'applied live and saved (ls_save); led_count {io 1..8, count} needs a restart. Editor/admin level.',
    inputSchema: { event: z.number().int().optional(), enabled: z.boolean().optional(), prog: z.number().int().min(1).max(32).optional(), name: z.string().max(15).optional(),
      fields: z.record(z.number()).optional(), led_count: z.object({ io: z.number().int().min(1).max(8), count: z.number().int().min(0) }).optional(), server: S },
    annotations: WR_CFG,
  }, async (a) => {
    const cfg = a.prog !== undefined || a.enabled !== undefined || a.led_count !== undefined;
    const g = gate(ctx, cfg ? 'config' : 'state'); if (g) return g;
    const c = reg.pick(a.server);
    await c.require(FEAT.ledstrip, 'LED strips');
    const vb = await c.pageVars('ledstrip', 'led_en');
    const F = ['fx', 'speed', 'brightness', 'intensity', 'density', 'length', 'palette', 'direction', 'color1', 'color2', 'a', 'b', 'blend', 'blend_fx', 'blend_dir', 'kill', 'kill_fx', 'kill_dir', 'off_pause'];
    const cmds: string[] = [];
    toggleTo(cmds, vnum(vb, 'led_en'), a.enabled, 'led_en=1');
    if (a.prog !== undefined) {
      if (a.name !== undefined) cmds.push(kv(`led_pnm*${a.prog}`, a.name));
      for (const [k, v] of Object.entries(a.fields ?? {})) { const f = F.indexOf(k); if (f < 0) return fail(`unknown program field "${k}" (fields: ${F.join(', ')})`); cmds.push(`led_p*${a.prog}=${f},${Math.round(v)}`); }
    }
    if (a.led_count) cmds.push(`led_n*${a.led_count.io - 1}=${a.led_count.count}`);
    if (cmds.length && cfg) cmds.push('ls_save=1');
    if (a.event !== undefined) cmds.push(`led_ev=${a.event}`);
    const r = await done(c, cmds, 'LED strips', async () => ledText(c, a.prog));
    if (a.led_count) r.content.push({ type: 'text', text: 'LED count changes take effect after a restart (myio_system action=restart).' });
    return r;
  });

  // ============================================================ NETWORK =====================================================
  const netText = (c: MyIOClient, vb: VarBlock) => {
    const wm = ['off', 'STA (client)', 'AP (access point)'];
    const up = varr(vb, 'net_up'), addr = varr(vb, 'net_addr');
    const sm = varr(vb, 'net_sm'); const smName = ['app 843', 'mDNS', 'broadcast+NTP', 'BroadLink', 'MQTT', 'outgoing (Shelly/Link)', 'Cloud'];
    const ifs = (m: number) => ['LAN', 'WiFi-STA', 'WiFi-AP'].filter((_, i) => m & (1 << i)).join('+') || 'none';
    return [`${c.name} network: host name "${vstr(vb, 'net_host')}" (mDNS ${vstr(vb, 'net_mdns')}.local)${vnum(vb, 'net_dirty') ? ' - UNSAVED changes' : ''}`,
      `  LAN: ${vnum(vb, 'neth_en') ? 'enabled' : 'DISABLED'}, ${vnum(vb, 'neth_dhcp') ? 'DHCP' : 'static'}${vnum(vb, 'neth_pri') ? ' (static IP primary, DHCP fallback)' : ''}, static ${ip4(varr(vb, 'neth_ip'))}/${ip4(varr(vb, 'neth_mask'))} gw ${ip4(varr(vb, 'neth_gw'))} dns ${ip4(varr(vb, 'neth_dns'))}; `
      + `link ${vnum(vb, 'net_link') === 1 ? 'UP' : 'DOWN'}, live ${Number(up[0]) ? addr[0] : 'not up'}`,
      `  WiFi mode ${wm[vnum(vb, 'nwifi_mode')] ?? vnum(vb, 'nwifi_mode')} (running ${wm[vnum(vb, 'net_run_mode')] ?? vnum(vb, 'net_run_mode')}); STA SSID "${vstr(vb, 'nsta_ssid')}" password ${maskSecret('pw', vstr(vb, 'nsta_pw'))}, ${vnum(vb, 'nsta_dhcp') ? 'DHCP' : `static ${ip4(varr(vb, 'nsta_ip'))}`}, live ${Number(up[1]) ? addr[1] : 'not up'}, RSSI ${vnum(vb, 'net_rssi')} dBm`,
      `  AP SSID "${vstr(vb, 'nap_ssid')}" password ${maskSecret('pw', vstr(vb, 'nap_pw'))} channel ${vnum(vb, 'nap_ch')}, live ${Number(up[2]) ? addr[2] : 'not up'}`,
      `  services per interface: ${sm.map((m, i) => `${smName[i]}: ${ifs(Number(m))}`).join('; ')}`].join('\n');
  };
  server.registerTool('myio_network', {
    title: 'Network settings',
    description: 'Network configuration and live state (GIGA/Opta 4.x): host name, LAN (DHCP/static, link), WiFi mode (off / STA / AP), STA and AP settings, live addresses, RSSI, which services run on which interface. Passwords are never shown. Editor/admin level.',
    inputSchema: { server: S },
    annotations: RO,
  }, async ({ server: sv }) => { const c = reg.pick(sv); await c.require(FEAT.network, 'the network page'); return text(netText(c, await c.pageVars('network', 'nwifi_mode'))); });

  server.registerTool('myio_network_set', {
    title: 'Change network settings',
    description: 'DANGEROUS: a wrong value can make the controller unreachable (then only USB serial or the service access point helps). Changes: host, wifi_mode 0 off / 1 STA / 2 AP, sta {ssid, password, dhcp}, '
      + 'ap {ssid, password, channel 1..13}, lan {enabled, dhcp, static_primary}. apply=true saves AND applies now (no restart; the connection may drop), apply=false only saves for the next boot. Needs MYIO_WRITE=admin.',
    inputSchema: { host: z.string().max(32).optional(), wifi_mode: z.number().int().min(0).max(2).optional(),
      sta: z.object({ ssid: z.string().max(32).optional(), password: z.string().max(63).optional(), dhcp: z.boolean().optional() }).optional(),
      ap: z.object({ ssid: z.string().max(32).optional(), password: z.string().min(8).max(63).optional(), channel: z.number().int().min(1).max(13).optional() }).optional(),
      lan: z.object({ enabled: z.boolean().optional(), dhcp: z.boolean().optional(), static_primary: z.boolean().optional() }).optional(),
      apply: z.boolean(), server: S },
    annotations: WR_ADM,
  }, async (a) => {
    const g = gate(ctx, 'admin'); if (g) return g;
    const c = reg.pick(a.server);
    await c.require(FEAT.network, 'the network page');
    const vb = await c.pageVars('network', 'nwifi_mode');
    const cmds: string[] = [];
    if (a.host !== undefined) { if (!/^[A-Za-z0-9-]+$/.test(a.host)) return fail('host may contain only A-Z a-z 0-9 and -'); cmds.push(kv('n_host', a.host)); }
    setIf(cmds, 'n_wifi_mode', a.wifi_mode);
    if (a.sta) { setIf(cmds, 'n_sta_ssid', a.sta.ssid); setIf(cmds, 'n_sta_pw', a.sta.password); toggleTo(cmds, vnum(vb, 'nsta_dhcp'), a.sta.dhcp, 'n_sta_dhcp=1'); }
    if (a.ap) { setIf(cmds, 'n_ap_ssid', a.ap.ssid); setIf(cmds, 'n_ap_pw', a.ap.password); setIf(cmds, 'n_ap_ch', a.ap.channel); }
    if (a.lan) { toggleTo(cmds, vnum(vb, 'neth_en'), a.lan.enabled, 'n_eth_en=1'); toggleTo(cmds, vnum(vb, 'neth_dhcp'), a.lan.dhcp, 'n_eth_dhcp=1'); if (a.lan.static_primary !== undefined) cmds.push(`n_eth_pri=${a.lan.static_primary ? 1 : 0}`); }
    if (!cmds.length) return text(`${c.name}: nothing to change.\n${netText(c, vb)}`);
    cmds.push(a.apply ? 'NetApply=1' : 'NetSave=1');
    await sendCmds(c, cmds);
    if (!a.apply) return text(`${c.name}: network settings saved (active after the next restart).\n${netText(c, await c.pageVars('network', 'nwifi_mode'))}`);
    await sleep(6000);
    try { return text(`${c.name}: network settings saved and applied; the controller still answers.\n${netText(c, await c.pageVars('network', 'nwifi_mode'))}`); }
    catch (e) { return fail(`${c.name}: settings applied, but the controller does not answer at ${c.origin} any more (${(e as Error).message}). If its address changed, update the server configuration; otherwise reach it over USB serial or its service access point.`); }
  });

  // ============================================================ SYSTEM ======================================================
  server.registerTool('myio_system', {
    title: 'Restart / firmware update',
    description: 'Admin actions on a GIGA/Opta (4.x): restart (soft reboot, ~1 min offline), ota_upload (file = local path of a MYIO_UPD.BIN package made by the fleet tool: uploaded to the SD card, '
      + 'or internal flash without a card), ota_apply (the controller installs the uploaded package and restarts; rolls back by itself if the new image fails), ota_restore (go back to the previous image). '
      + 'The answer waits for the controller to come back and reports the running version. Needs MYIO_WRITE=admin. A Due is updated over USB/SD only.',
    inputSchema: { action: z.enum(['restart', 'ota_upload', 'ota_apply', 'ota_restore']), file: z.string().optional(), server: S },
    annotations: WR_ADM,
  }, async ({ action, file, server: sv }) => {
    const g = gate(ctx, 'admin'); if (g) return g;
    const c = reg.pick(sv);
    await c.require(FEAT.webOta, 'web restart / OTA');
    const before = (await c.info(true)).info;
    if (action === 'ota_upload') {
      if (!file) return fail('file (local path of MYIO_UPD.BIN) is required');
      let buf: Buffer; try { buf = fs.readFileSync(file); } catch (e) { return fail(`cannot read ${file}: ${(e as Error).message}`); }
      if (buf.length < 64 * 1024) return fail(`${file} is only ${buf.length} B - not a firmware package`);
      let where = 'SD card';
      try { await c.put('~sd/MYIO_UPD.BIN', buf, 'application/octet-stream', { timeoutMs: 900_000 }); }
      catch { where = 'internal flash'; await c.put('MYIO_UPD.BIN', buf, 'application/octet-stream', { timeoutMs: 900_000 }); }
      return text(`${c.name}: MYIO_UPD.BIN uploaded to the ${where} (${buf.length} B). Install it with action=ota_apply. Running now: ${before.version}.`);
    }
    const cmd = action === 'restart' ? 'Restart=1' : action === 'ota_apply' ? 'OtaCheck=1' : 'RestorePrevious=1';
    await c.command(cmd);
    const up0 = num(before.uptime);
    await sleep(8000);
    for (let i = 0; i < 40; i++) {
      try {
        const now = (await c.info(true)).info;
        if (num(now.uptime) < up0 || now.version !== before.version) return text(`${c.name}: ${action} done - back online after ~${8 + i * 3} s, running ${now.version} (was ${before.version}), uptime ${now.uptime} s, reset cause ${now.reset_cause}${now.rollback !== undefined ? `, previous image ${num(now.rollback) ? 'available' : 'none'}` : ''}.`);
      } catch { /* meg nincs fent */ }
      await sleep(3000);
    }
    return fail(`${c.name}: sent ${cmd}, but the controller did not come back within ~2 minutes - check it on site / over USB.`);
  });
}
