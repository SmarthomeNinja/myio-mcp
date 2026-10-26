/**
 * Beallitas-irok (MYIO_MCP_PLAN.md 4.3, 2. kor 2026-10-25): globalisok, nevek, kimenet-/bemenet-konfig, szerkezetek
 * (vedelem-, csatolo-par, csoport), jelenetek (slotok), idozitok, felhasznalok + jogok. Forras: a /setup es /users oldal
 * var-blokkja (parseVarBlock) + timer.csv. Billeno (toggle) parancsok CSAK akkor mennek ki, ha a kivant ertek elter (API-ref 12/6).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { MyIOClient } from '../api.js';
import { MyIOError } from '../api.js';
import {
  decodeGlobals, fmtGlobals, decodeOutputConfigs, fmtOutputConfig, decodeInputConfigs, fmtInputConfig, decodeStructures, decodeScenes, decodeUsers,
  parseTimerCsv, fmtTimer, timerCommand, daysMask, nameMaps, targetText, baseId, deviceTypeOf, TIMER_ANY, TIMER_EVENTS, Timer, varr, vnum, vdesc, FEAT, supports,
} from '../model.js';
import { ToolContext, RO, WR_CFG, WR_CFG_SET, WR_ADM, text, fail, idArg, serverArg, sleep, SETTLE_MS, gate } from './common.js';

export function registerConfigTools(server: McpServer, ctx: ToolContext): void {
  const { reg } = ctx;
  const S = serverArg(reg);
  const enc = (v: string) => { if (v.includes('&')) throw new MyIOError('the value contains "&" - the controller cannot receive that character (it splits commands on it)'); return encodeURIComponent(v); };

  /** konfig-parancs + a /setup ujraolvasasa */
  async function applyCfg(client: MyIOClient, cmds: string[], after: () => Promise<string>): Promise<CallToolResult> {
    if (!cmds.length) return text('Nothing to change (every requested value already matches).\n' + (await after()));
    const cmd = cmds.join('&');
    await client.command(cmd);
    client.invalidateSetup(); client.invalidateNames();
    await sleep(SETTLE_MS);
    return text(`Sent: ${cmd}\n${await after()}`);
  }

  // ---- nyers var-blokk ----------------------------------------------------------------------------------------------
  server.registerTool('myio_config_vars', {
    title: 'Raw settings variables',
    description: 'The raw settings block of the controller (the JS variables behind the Setup page: energy manager, SDM, dew point, sensor tables, every array). Give `names` to read specific variables, or `prefix` to list those starting with it; without arguments the variable names are listed. Editor/admin level.',
    inputSchema: { names: z.array(z.string()).optional(), prefix: z.string().optional(), server: S },
    annotations: RO,
  }, async ({ names, prefix, server: sv }) => {
    const vb = await reg.pick(sv).setupVars(true);
    if (names?.length) return text(names.map(n => `${n} = ${vb.has(n) ? JSON.stringify(vb.get(n)) : '(not present)'}`).join('\n'));
    const keys = [...vb.keys()].filter(k => !prefix || k.toLowerCase().startsWith(prefix.toLowerCase()));
    if (prefix) return text(keys.map(k => `${k} = ${JSON.stringify(vb.get(k)).slice(0, 300)}`).join('\n') || `no variable starts with "${prefix}"`);
    return text(`${keys.length} variables: ${keys.join(', ')}`);
  });

  // ---- globalisok ------------------------------------------------------------------------------------------------------
  server.registerTool('myio_globals', {
    title: 'Controller settings',
    description: 'Global settings: device name, controller clock, time zone (+ automatic EU daylight saving time on/off and whether summer time is in force, 3.12.35 / 4.18.9+), location (for sunrise/sunset), today\'s sunrise/sunset, button timing (hit/press limits), protection cooldown (4.x), sensor polling periods, pulse meter unit, current/boot scene slot, loggers. Editor/admin level.',
    inputSchema: { server: S },
    annotations: RO,
  }, async ({ server: sv }) => { const c = reg.pick(sv); return text(`${c.name}:\n` + fmtGlobals(decodeGlobals(await c.setupVars(true)))); });

  server.registerTool('myio_set_globals', {
    title: 'Change controller settings',
    description: 'Change global settings: name, time_zone (hours from UTC; with automatic DST on it is the STANDARD/winter offset, e.g. 1 for Central Europe - changing it moves the clock at once on 3.12.35 / 4.18.9+), auto_dst (true/false: automatic EU daylight saving time, 3.12.35 / 4.18.9+, on by default; stored at once, no save needed), latitude/longitude, hit_time_limit / press_time_limit (ms), prot_cooldown (s, 4.x), temp_timer / hum_timer / mixer_timer (sensor polling s), impulse_per_unit, consumption_unit, sync_time=true (NTP sync now). Only the given fields change. Editor/admin level.',
    inputSchema: {
      name: z.string().max(31).optional(), time_zone: z.number().int().min(-12).max(14).optional(), latitude: z.number().optional(), longitude: z.number().optional(),
      hit_time_limit: z.number().int().min(1).optional(), press_time_limit: z.number().int().min(1).optional(), prot_cooldown: z.number().int().min(0).optional(),
      temp_timer: z.number().int().min(1).optional(), hum_timer: z.number().int().min(1).optional(), mixer_timer: z.number().int().min(1).optional(),
      impulse_per_unit: z.number().int().min(0).optional(), consumption_unit: z.string().max(15).optional(), sync_time: z.boolean().optional(), auto_dst: z.boolean().optional(), server: S,
    },
    annotations: WR_CFG_SET,
  }, async (a) => {
    const g = gate(ctx, 'config'); if (g) return g;
    const client = reg.pick(a.server);
    const cmds: string[] = [];
    if (a.name !== undefined) cmds.push(`MYIOname=${enc(a.name)}`);
    if (a.auto_dst !== undefined) { await client.require(FEAT.dst, 'automatic daylight saving time'); cmds.push(`dst_auto=${a.auto_dst ? 1 : 0}`); }   // ertek-szemantika (nem billeno)
    if (a.time_zone !== undefined) cmds.push(`tz=${a.time_zone}`);
    if (a.latitude !== undefined) cmds.push(`latitude=${a.latitude}`);
    if (a.longitude !== undefined) cmds.push(`longitude=${a.longitude}`);
    if (a.hit_time_limit !== undefined) cmds.push(`hitTimeLimit=${a.hit_time_limit}`);
    if (a.press_time_limit !== undefined) cmds.push(`pressTimeLimit=${a.press_time_limit}`);
    if (a.prot_cooldown !== undefined) { await client.require({ v4: '4.0.0' }, 'protection cooldown'); cmds.push(`protCooldown=${a.prot_cooldown}`); }
    if (a.temp_timer !== undefined) cmds.push(`tempTimer=${a.temp_timer}`);
    if (a.hum_timer !== undefined) cmds.push(`humTimer=${a.hum_timer}`);
    if (a.mixer_timer !== undefined) cmds.push(`mixerTimer=${a.mixer_timer}`);
    if (a.impulse_per_unit !== undefined) cmds.push(`impulsePerUnit=${a.impulse_per_unit}`);
    if (a.consumption_unit !== undefined) cmds.push(`consumptionUnit=${enc(a.consumption_unit)}`);
    if (a.sync_time) cmds.push('T_Sync=1');
    if (!cmds.length) return fail('give at least one setting to change');
    return applyCfg(client, cmds, async () => fmtGlobals(decodeGlobals(await client.setupVars(true))));
  });

  // ---- nevek -----------------------------------------------------------------------------------------------------------
  server.registerTool('myio_rename', {
    title: 'Rename an element',
    description: 'Set the name (description) of an element. kind: relay (id 1..RQ), pca (2001.. or channel 1..), fet (101..), group (501.. or 1..), input (1..SQ), thermo (1-Wire sensor id 1..100), humidity (channel index 0..), usens (4.x, id 0..SENQ), shelly (4.x), scene (slot 0..). Empty name clears it. Editor level; accents are fine.',
    inputSchema: { kind: z.enum(['relay', 'pca', 'fet', 'group', 'input', 'thermo', 'humidity', 'usens', 'shelly', 'scene']), id: z.number().int().min(0), name: z.string().max(40), server: S },
    annotations: WR_CFG_SET,
  }, async ({ kind, id, name, server: sv }) => {
    const g = gate(ctx, 'config'); if (g) return g;
    const client = reg.pick(sv);
    const key: Record<string, [string, number]> = {
      relay: ['r_descr', id], pca: ['p_descr', id > 2000 ? id - 2000 : id], fet: ['f_descr', id > 100 ? id - 100 : id], group: ['g_descr', id > 500 ? id - 500 : id],
      input: ['s_descr', id], thermo: ['t_descr', id], humidity: ['h_descr', id], usens: ['u_descr', id], shelly: ['sh_descr', id], scene: ['slo_descr', id],
    };
    if (kind === 'usens' || kind === 'shelly') await client.require({ v4: '4.0.0' }, `${kind} names`);
    const [k, i] = key[kind];
    return applyCfg(client, [`${k}*${i}=${enc(name)}`], async () => {
      const vb = await client.setupVars(true); const n = nameMaps(vb);
      const now = kind === 'relay' ? n.relay.get(i) : kind === 'pca' ? n.pca.get(i) : kind === 'fet' ? n.fet.get(i) : kind === 'group' ? n.group.get(i) : kind === 'input' ? n.input.get(i)
        : kind === 'thermo' ? n.thermo.get(i) : kind === 'humidity' ? n.hum.get(i) : kind === 'scene' ? n.slot.get(i) : undefined;
      return now === undefined && (kind === 'usens' || kind === 'shelly') ? `${kind} ${i} renamed to "${name}" (not shown on the setup page; see myio_usensors)` : `${kind} ${i}: name is now "${now ?? ''}"` + (now !== name && !(now === undefined && name === '') ? `  ! expected "${name}" (no permission?)` : '');
    });
  });

  // ---- kimenet-konfig ----------------------------------------------------------------------------------------------------
  server.registerTool('myio_output_config', {
    title: 'Output configuration',
    description: 'Configuration of outputs (relay, FET, PCA): auto-off timer, turn-on delay, inverted wiring, alarm flag, justOn (a button can only switch it on), PCA min/max level, fade speed, PWM (dimmer) vs switch mode, mixer mode, sensor binding and thresholds. Give id for one output, type for one kind, or nothing for all named ones. Editor/admin level.',
    inputSchema: { id: z.number().int().optional(), type: z.enum(['relay', 'fet', 'pca']).optional(), include_unnamed: z.boolean().optional(), server: S },
    annotations: RO,
  }, async ({ id, type, include_unnamed, server: sv }) => {
    const client = reg.pick(sv);
    let list = decodeOutputConfigs(await client.setupVars(true));
    if (id !== undefined) { const b = baseId(id); list = list.filter(c => c.id === b); if (!list.length) return fail(`no output ${id}`); }
    else { if (type) list = list.filter(c => c.type === type); if (!include_unnamed) list = list.filter(c => c.name); }
    return text(`${client.name}:\n` + list.map(c => '  ' + fmtOutputConfig(c)).join('\n'));
  });

  server.registerTool('myio_set_output_config', {
    title: 'Change output configuration',
    description: 'Change an output\'s configuration (relay 1..RQ, FET 101.., PCA 2001..): timer_s (auto-off, 0 = off), delay_s (turn-on delay), invert, alarm, just_on, and for PCA/FET: min / max level (0..255), fade_speed, pwm (dimmer mode), mixer. Flags are set to the given value (the controller\'s toggle commands are only sent when the value differs). Editor level.',
    inputSchema: {
      id: idArg('output id'), timer_s: z.number().int().min(0).optional(), delay_s: z.number().int().min(0).optional(), invert: z.boolean().optional(), alarm: z.boolean().optional(), just_on: z.boolean().optional(),
      min: z.number().int().min(0).max(255).optional(), max: z.number().int().min(0).max(255).optional(), fade_speed: z.number().int().min(0).max(255).optional(), pwm: z.boolean().optional(), mixer: z.boolean().optional(), server: S,
    },
    annotations: WR_CFG_SET,
  }, async (a) => {
    const g = gate(ctx, 'config'); if (g) return g;
    const client = reg.pick(a.server);
    const b = baseId(a.id); const t = deviceTypeOf(b);
    const cur = decodeOutputConfigs(await client.setupVars(true)).find(c => c.id === b);
    if (!cur || !t || t === 'group') return fail(`no configurable output ${a.id} on ${client.name}`);
    const cmds: string[] = [];
    if (t === 'relay') {
      if (a.timer_s !== undefined) cmds.push(`r_timer*${b}=${a.timer_s}`);
      if (a.delay_s !== undefined) cmds.push(`r_delay*${b}=${a.delay_s}`);
      if (a.invert !== undefined && a.invert !== cur.invert) cmds.push(`relaysInvert=${b}`);
      if (a.alarm !== undefined && a.alarm !== cur.alarm) cmds.push(`relaysAlarm=${b}`);
      if (a.just_on !== undefined && a.just_on !== cur.justOn) cmds.push(`relaysJustOn=${b}`);
      if (a.min !== undefined || a.max !== undefined || a.fade_speed !== undefined || a.pwm !== undefined || a.mixer !== undefined) return fail('min/max/fade_speed/pwm/mixer apply to PCA and FET outputs only');
    } else if (t === 'pca') {
      if (a.timer_s !== undefined) cmds.push(`PCA_timer*${b}=${a.timer_s}`);
      if (a.delay_s !== undefined) cmds.push(`PCA_delay*${b}=${a.delay_s}`);
      if (a.min !== undefined) cmds.push(`PCAMIN*${b}=${a.min}`);
      if (a.max !== undefined) cmds.push(`PCAMAX*${b}=${a.max}`);
      if (a.fade_speed !== undefined) cmds.push(`PCAFadeSpeed*${b}=${a.fade_speed}`);
      if (a.invert !== undefined && a.invert !== cur.invert) cmds.push(`PCAInvert=${b}`);
      if (a.alarm !== undefined && a.alarm !== cur.alarm) cmds.push(`PCAAlarm=${b}`);
      if (a.just_on !== undefined && a.just_on !== cur.justOn) cmds.push(`PCAJustOn=${b}`);
      if (a.pwm !== undefined && a.pwm !== cur.pwm) cmds.push(`PCA_PWM=${b}`);
      if (a.mixer !== undefined && a.mixer !== cur.mixer) cmds.push(`PCAMixer=${b}`);
    } else {
      if (a.min !== undefined) cmds.push(`fetMIN*${b}=${a.min}`);
      if (a.max !== undefined) cmds.push(`fetMAX*${b}=${a.max}`);
      if (a.fade_speed !== undefined) cmds.push(`fetFadeSpeed*${b}=${a.fade_speed}`);
      if (a.timer_s !== undefined || a.delay_s !== undefined || a.invert !== undefined || a.alarm !== undefined || a.just_on !== undefined || a.pwm !== undefined || a.mixer !== undefined) return fail('FET outputs only take min, max and fade_speed');
    }
    return applyCfg(client, cmds, async () => { const c = decodeOutputConfigs(await client.setupVars(true)).find(x => x.id === b)!; return '  ' + fmtOutputConfig(c); });
  });

  // ---- bemenet-konfig ----------------------------------------------------------------------------------------------------
  server.registerTool('myio_input_config', {
    title: 'Input configuration',
    description: 'What the physical inputs (wall buttons) do: enabled, NC contact, hit-block, and the targets of hit (short press), press (long press) and release in the unified id space (relay 1.., FET 101.., group 501.., scene 1000+slot, PCA 2001.., LED strip 3100+). Give id for one input; otherwise the named / bound ones. Editor/admin level.',
    inputSchema: { id: z.number().int().optional(), include_unused: z.boolean().optional(), server: S },
    annotations: RO,
  }, async ({ id, include_unused, server: sv }) => {
    const client = reg.pick(sv);
    const vb = await client.setupVars(true); const n = nameMaps(vb);
    let list = decodeInputConfigs(vb);
    if (id !== undefined) { list = list.filter(c => c.id === id); if (!list.length) return fail(`no input ${id}`); }
    else if (!include_unused) list = list.filter(c => c.name || c.hit || c.press || c.release);
    return text(`${client.name} inputs (${list.length}):\n` + list.map(c => '  ' + fmtInputConfig(c, n)).join('\n'));
  });

  server.registerTool('myio_set_input_config', {
    title: 'Change input configuration',
    description: 'Change a physical input (1..SQ): enabled, nc (normally closed), hit_block, and the action targets hit / press / release as element ids (0 = none; relay 1.., FET 101.., group 501.., load scene 1000+slot, PCA 2001.., LED strip 3100+). Flags are set to the given value. Editor level.',
    inputSchema: { id: idArg('input id (1..SQ)'), enabled: z.boolean().optional(), nc: z.boolean().optional(), hit_block: z.boolean().optional(), hit: z.number().int().min(0).optional(), press: z.number().int().min(0).optional(), release: z.number().int().min(0).optional(), server: S },
    annotations: WR_CFG_SET,
  }, async (a) => {
    const g = gate(ctx, 'config'); if (g) return g;
    const client = reg.pick(a.server);
    const cur = decodeInputConfigs(await client.setupVars(true)).find(c => c.id === a.id);
    if (!cur) return fail(`no input ${a.id} on ${client.name}`);
    const cmds: string[] = [];
    if (a.enabled !== undefined && a.enabled !== cur.enabled) cmds.push(`switchEnabled=${a.id}`);
    if (a.nc !== undefined && a.nc !== cur.nc) cmds.push(`switchNC=${a.id}`);
    if (a.hit_block !== undefined && a.hit_block !== cur.hitBlock) cmds.push(`hitBlockEnabled=${a.id}`);
    if (a.hit !== undefined) cmds.push(`hitEvent*${a.id}=${a.hit}`);
    if (a.press !== undefined) cmds.push(`pressEvent*${a.id}=${a.press}`);
    if (a.release !== undefined) cmds.push(`releaseEvent*${a.id}=${a.release}`);
    return applyCfg(client, cmds, async () => { const vb = await client.setupVars(true); return '  ' + fmtInputConfig(decodeInputConfigs(vb).find(c => c.id === a.id)!, nameMaps(vb)); });
  });

  // ---- szerkezetek -------------------------------------------------------------------------------------------------------
  server.registerTool('myio_structures', {
    title: 'Protection pairs, joiners, groups',
    description: 'The structural configuration: protection pairs (two outputs never on together = shutters; index, UP, DOWN, priority), joiner pairs (master switches the slave too; justOn), groups (id 501.., members in the unified id space, pullUp = mixed state toggles to ON). Editor/admin level.',
    inputSchema: { server: S },
    annotations: RO,
  }, async ({ server: sv }) => {
    const client = reg.pick(sv);
    const vb = await client.setupVars(true); const n = nameMaps(vb); const st = decodeStructures(vb);
    const lines = [`${client.name}:`, `Protection pairs (${st.protection.length} of ${st.pq}):`];
    for (const p of st.protection) lines.push(`  #${p.index}: UP ${targetText(p.up, n)} / DOWN ${targetText(p.down, n)}${p.priority ? ' [priority: first wins]' : ''}`);
    lines.push(`Joiner pairs (${st.joiner.length} of ${st.jq}):`);
    for (const j of st.joiner) lines.push(`  #${j.index}: ${targetText(j.master, n)} -> ${targetText(j.slave, n)}${j.justOn ? ' [justOn]' : ''}`);
    lines.push(`Groups (${st.groups.length} of ${st.gq}, max ${st.groupSize} members):`);
    for (const g of st.groups) lines.push(`  [${g.id}] ${g.name || '(unnamed)'}: ${g.members.map(m => targetText(m, n)).join(', ') || '(empty)'}${g.pullUp ? ' [pullUp]' : ''}`);
    return text(lines.join('\n'));
  });

  server.registerTool('myio_set_protection', {
    title: 'Set a protection pair',
    description: 'Define or clear a protection pair (index 0..PQ-1, or omit index: an identical existing pair is reused, otherwise the first free one): up and down = output ids that may never be on together (relay 1.., PCA 2001..); 0/0 clears the pair. priority = the first (UP) element wins when both are requested. A pair makes a shutter for myio_shutters. Editor level.',
    inputSchema: { index: z.number().int().min(0).optional(), up: z.number().int().min(0), down: z.number().int().min(0), priority: z.boolean().optional(), server: S },
    annotations: WR_CFG_SET,
  }, async ({ index, up, down, priority, server: sv }) => {
    const g = gate(ctx, 'config'); if (g) return g;
    const client = reg.pick(sv);
    const st = decodeStructures(await client.setupVars(true));
    let idx = index;
    if (idx === undefined) {
      if (!up && !down) return fail('give the index of the pair to clear (see myio_structures)');
      const same = st.protection.find(p => p.up === up && p.down === down);   // ugyanaz a par mar megvan: nem keszul masodik
      if (same) idx = same.index;
      else { const used = new Set(st.protection.map(p => p.index)); idx = 0; while (used.has(idx)) idx++; if (idx >= st.pq) return fail('no free protection pair'); }
    }
    if (idx >= st.pq) return fail(`index must be 0..${st.pq - 1}`);
    const cur = st.protection.find(p => p.index === idx);
    const cmds = cur && cur.up === up && cur.down === down ? [] : [`relayProtection*${idx}*0=${up}`, `relayProtection*${idx}*1=${down}`];
    if (priority !== undefined && priority !== (cur?.priority ?? false)) cmds.push(`protectionPriority=${idx}`);
    return applyCfg(client, cmds, async () => { const vb = await client.setupVars(true); const p = decodeStructures(vb).protection.find(x => x.index === idx); const n = nameMaps(vb);
      return p ? `  pair #${idx}: UP ${targetText(p.up, n)} / DOWN ${targetText(p.down, n)}${p.priority ? ' [priority]' : ''}` : `  pair #${idx}: cleared`; });
  });

  server.registerTool('myio_set_joiner', {
    title: 'Set a joiner pair',
    description: 'Define or clear a joiner pair (index 0..JQ-1, or omit: an identical existing pair is reused, otherwise the first free one): switching master also switches slave (ids in the unified space); 0/0 clears. just_on = the slave only follows switching ON. Editor level.',
    inputSchema: { index: z.number().int().min(0).optional(), master: z.number().int().min(0), slave: z.number().int().min(0), just_on: z.boolean().optional(), server: S },
    annotations: WR_CFG_SET,
  }, async ({ index, master, slave, just_on, server: sv }) => {
    const g = gate(ctx, 'config'); if (g) return g;
    const client = reg.pick(sv);
    const st = decodeStructures(await client.setupVars(true));
    let idx = index;
    if (idx === undefined) {
      if (!master && !slave) return fail('give the index of the joiner to clear (see myio_structures)');
      const same = st.joiner.find(p => p.master === master && p.slave === slave);
      if (same) idx = same.index;
      else { const used = new Set(st.joiner.map(p => p.index)); idx = 0; while (used.has(idx)) idx++; if (idx >= st.jq) return fail('no free joiner pair'); }
    }
    if (idx >= st.jq) return fail(`index must be 0..${st.jq - 1}`);
    const cur = st.joiner.find(p => p.index === idx);
    const cmds = cur && cur.master === master && cur.slave === slave ? [] : [`relayJoiner*${idx}*0=${master}`, `relayJoiner*${idx}*1=${slave}`];
    if (just_on !== undefined && just_on !== (cur?.justOn ?? false)) cmds.push(`joinerJustON=${idx}`);
    return applyCfg(client, cmds, async () => { const vb = await client.setupVars(true); const j = decodeStructures(vb).joiner.find(x => x.index === idx); const n = nameMaps(vb);
      return j ? `  joiner #${idx}: ${targetText(j.master, n)} -> ${targetText(j.slave, n)}${j.justOn ? ' [justOn]' : ''}` : `  joiner #${idx}: cleared`; });
  });

  server.registerTool('myio_set_group', {
    title: 'Set group members',
    description: 'Set the member list of a group (id 501..): members = output ids (relay 1.., FET 101.., PCA 2001.., fade variants 4001.. allowed), at most groupSize (usually 10); an empty list clears the group. pull_up = when members are mixed, toggle turns ALL ON (false: all OFF). The controller refuses a group that would contain itself. Editor level.',
    inputSchema: { id: idArg('group id (501..) or 1..'), members: z.array(z.number().int().min(1)).max(32), pull_up: z.boolean().optional(), name: z.string().max(40).optional(), server: S },
    annotations: WR_CFG_SET,
  }, async ({ id, members, pull_up, name, server: sv }) => {
    const g = gate(ctx, 'config'); if (g) return g;
    const client = reg.pick(sv);
    const st = decodeStructures(await client.setupVars(true));
    const gidx = (id > 500 ? id - 500 : id) - 1;
    if (gidx < 0 || gidx >= st.gq) return fail(`group id must be 501..${500 + st.gq}`);
    if (members.length > st.groupSize) return fail(`at most ${st.groupSize} members`);
    const cur = st.groups.find(x => x.index === gidx);
    const cmds: string[] = [];
    for (let place = 0; place < st.groupSize; place++) { const want = members[place] ?? 0; if ((cur?.members[place] ?? 0) !== want || !cur) cmds.push(`relay_group*${gidx}*${place}=${want}`); }
    if (pull_up !== undefined && pull_up !== (cur?.pullUp ?? false)) cmds.push(`pullUpGroup=${gidx}`);
    if (name !== undefined) cmds.push(`g_descr*${gidx + 1}=${enc(name)}`);
    return applyCfg(client, cmds, async () => { const vb = await client.setupVars(true); const x = decodeStructures(vb).groups.find(y => y.index === gidx); const n = nameMaps(vb);
      return x ? `  [${x.id}] ${x.name || '(unnamed)'}: ${x.members.map(m => targetText(m, n)).join(', ') || '(empty)'}${x.pullUp ? ' [pullUp]' : ''}` : `  [${501 + gidx}]: empty`; });
  });

  // ---- jelenetek ----------------------------------------------------------------------------------------------------------
  server.registerTool('myio_scenes', {
    title: 'Scenes (configuration slots)',
    description: 'Scene slots: a slot stores a complete configuration snapshot (outputs, groups, protection, inputs, globals ...) that can be loaded by a timer, a button (target 1000+slot) or myio_scene. Shows the slot list with names, the current and the boot slot. Editor/admin level.',
    inputSchema: { server: S },
    annotations: RO,
  }, async ({ server: sv }) => {
    const client = reg.pick(sv); const sc = decodeScenes(await client.setupVars(true));
    return text(`${client.name}: current slot ${sc.actual}, boot slot ${sc.boot}\n` + sc.slots.map(s => `  slot ${s.slot}: "${s.name}"${s.exists ? '' : ' (not saved yet)'}${s.slot === sc.actual ? ' <- current' : ''}${s.slot === sc.boot ? ' [boot]' : ''}`).join('\n'));
  });

  server.registerTool('myio_scene', {
    title: 'Scene action',
    description: 'Scene slots: load (apply slot - this changes outputs and settings), save (store the CURRENT configuration into slot, overwriting it), new (create the next free slot), delete (slot 0 and the boot slot cannot be deleted), set_boot (slot loaded at power-up), rename. Editor level; save/delete are destructive.',
    inputSchema: { action: z.enum(['load', 'save', 'new', 'delete', 'set_boot', 'rename']), slot: z.number().int().min(0).optional(), name: z.string().max(40).optional(), server: S },
    annotations: WR_CFG,
  }, async ({ action, slot, name, server: sv }) => {
    const g = gate(ctx, 'config'); if (g) return g;
    const client = reg.pick(sv);
    const before = decodeScenes(await client.setupVars(true));
    const cmds: string[] = [];
    if (action === 'new') cmds.push('new_slot=1');
    else {
      if (slot === undefined) return fail('slot is required');
      if (action !== 'rename' && !before.slots.find(s => s.slot === slot && s.exists) && action !== 'save') return fail(`slot ${slot} does not exist`);
      if (action === 'load') cmds.push(`lo_all=${slot}`);
      else if (action === 'save') cmds.push(`sav_all=${slot}`);
      else if (action === 'delete') cmds.push(`del_slot=${slot}`);
      else if (action === 'set_boot') cmds.push(`bootUpSlot=${slot}`);
      else if (action === 'rename') { if (name === undefined) return fail('name is required'); cmds.push(`slo_descr*${slot}=${enc(name)}`); }
    }
    if (action === 'new' && name !== undefined) {
      // az uj slot = az elso nem letezo index; a nevet utana adjuk
      const used = new Set(before.slots.filter(s => s.exists).map(s => s.slot)); let n = 0; while (used.has(n)) n++;
      cmds.push(`slo_descr*${n}=${enc(name)}`);
    }
    return applyCfg(client, cmds, async () => { const sc = decodeScenes(await client.setupVars(true));
      return `current slot ${sc.actual}, boot slot ${sc.boot}\n` + sc.slots.map(s => `  slot ${s.slot}: "${s.name}"${s.exists ? '' : ' (not saved yet)'}${s.slot === sc.boot ? ' [boot]' : ''}`).join('\n'); });
  });

  // ---- idozitok -------------------------------------------------------------------------------------------------------------
  const timerNames = async (client: MyIOClient) => nameMaps(await client.setupVars());
  server.registerTool('myio_timers', {
    title: 'Timers',
    description: 'Scheduled actions from timer.csv: time (or sunrise/sunset with ± offset), optional month/day, weekday filter (empty = every day), event (relay/FET/group/PCA ON/OFF, load scene, SG-Ready mode) and target. Editor/admin level.',
    inputSchema: { server: S },
    annotations: RO,
  }, async ({ server: sv }) => {
    const client = reg.pick(sv);
    const timers = parseTimerCsv(await client.timerCsv()); const n = await timerNames(client);
    if (!timers.length) return text(`No timers on ${client.name}.`);
    return text(`${client.name} timers (${timers.length}):\n` + timers.map(t => '  ' + fmtTimer(t, n)).join('\n'));
  });

  server.registerTool('myio_set_timer', {
    title: 'Create or change a timer',
    description: 'Create (omit id; an identical existing timer is not duplicated) or change (id) a timer. Time: hour 0..23 + minute 0..59, or sunrise / sunset = "after" | "before" with hour/minute as the offset (max 4 h). Optional month (1..12) and day (1..31) for a one-day timer. days: weekday names ["Mon","Fri"] (omit = every day). event: code or name - 1 load scene (all), 2 relay ON, 3 relay OFF, 4 FET ON, 5 FET OFF, 6 group ON, 7 group OFF, 15 PCA ON, 16 PCA OFF, 8..14/17 load scene parts, 18 SG-Ready mode. param: the target id (relay/FET/group/PCA id, scene slot, SG mode 1..4). Editor level.',
    inputSchema: {
      id: z.number().int().min(0).max(250).optional(), hour: z.number().int().min(0).max(23).optional(), minute: z.number().int().min(0).max(59).optional(),
      sunrise: z.enum(['after', 'before']).optional(), sunset: z.enum(['after', 'before']).optional(), month: z.number().int().min(1).max(12).optional(), day: z.number().int().min(1).max(31).optional(),
      days: z.array(z.string()).optional(), event: z.union([z.number().int(), z.string()]), param: z.number().int().min(0), server: S,
    },
    annotations: WR_CFG_SET,
  }, async (a) => {
    const g = gate(ctx, 'config'); if (g) return g;
    const client = reg.pick(a.server);
    const existing = parseTimerCsv(await client.timerCsv());
    let ev: number;
    if (typeof a.event === 'number') ev = a.event;
    else { const k = Object.entries(TIMER_EVENTS).find(([, v]) => v.toLowerCase() === String(a.event).toLowerCase()); if (!k) return fail(`unknown event "${a.event}"; use a code 1..18 or one of: ${Object.values(TIMER_EVENTS).join(', ')}`); ev = Number(k[0]); }
    if (!TIMER_EVENTS[ev] || ev === 0) return fail('event must be 1..18');
    if (a.sunrise && a.sunset) return fail('give sunrise or sunset, not both');
    if (!a.sunrise && !a.sunset && (a.hour === undefined || a.minute === undefined)) return fail('give hour and minute, or sunrise/sunset');
    let days: number; try { days = daysMask(a.days); } catch (e) { return fail((e as Error).message); }
    let id = a.id;
    if (id === undefined) { id = 0; const used = new Set(existing.map(t => t.id)); while (used.has(id)) id++; }
    const cur = existing.find(t => t.id === id);
    const t: Timer = {
      id, month: a.month ?? TIMER_ANY, day: a.day ?? TIMER_ANY,
      hour: a.hour ?? (a.sunrise || a.sunset ? 0 : TIMER_ANY), minute: a.minute ?? (a.sunrise || a.sunset ? 0 : TIMER_ANY),
      days, event: ev, param: a.param, sunrise: a.sunrise === 'after' ? 1 : a.sunrise === 'before' ? 2 : 0, sunset: a.sunset === 'after' ? 1 : a.sunset === 'before' ? 2 : 0,
    };
    if (a.id === undefined) {
      const same = existing.find(x => (['month', 'day', 'hour', 'minute', 'days', 'event', 'param', 'sunrise', 'sunset'] as const).every(k => x[k] === t[k]));
      if (same) return text(`Nothing sent: an identical timer already exists - ${fmtTimer(same, await timerNames(client))}`);
    }
    const cmd = timerCommand(t);
    await client.command(cmd);
    await sleep(SETTLE_MS);
    const after = parseTimerCsv(await client.timerCsv()).find(x => x.id === id); const n = await timerNames(client);
    if (!after) return text(`Sent: ${cmd}\n  ! timer #${id} is not in timer.csv afterwards (no SD card / no permission?)`);
    return text(`Sent: ${cmd}\n  ${cur ? 'changed' : 'created'}: ${fmtTimer(after, n)}` + (after.event !== ev || after.param !== a.param ? '\n  ! the stored timer differs from the request' : ''));
  });

  server.registerTool('myio_delete_timer', {
    title: 'Delete a timer',
    description: 'Delete the timer with the given id (from myio_timers). Editor level.',
    inputSchema: { id: z.number().int().min(0), server: S },
    annotations: WR_CFG_SET,
  }, async ({ id, server: sv }) => {
    const g = gate(ctx, 'config'); if (g) return g;
    const client = reg.pick(sv);
    if (!parseTimerCsv(await client.timerCsv()).find(t => t.id === id)) return fail(`no timer #${id} on ${client.name}`);
    await client.command(`del_timerSlot=${id}`);
    await sleep(SETTLE_MS);
    const left = parseTimerCsv(await client.timerCsv());
    return text(`Sent: del_timerSlot=${id}\n  ${left.find(t => t.id === id) ? '! timer still present' : `deleted; ${left.length} timer(s) remain`}`);
  });

  // ---- felhasznalok --------------------------------------------------------------------------------------------------------
  server.registerTool('myio_users', {
    title: 'User accounts',
    description: 'The user accounts of the controller: slot, login name, level (admin / editor / user). Slot 0 is the admin. Editor/admin level.',
    inputSchema: { server: S },
    annotations: RO,
  }, async ({ server: sv }) => {
    const client = reg.pick(sv); const users = decodeUsers(await client.usersVars());
    return text(`${client.name} users:\n` + users.map(u => `  slot ${u.slot}: ${u.name || '(no name)'} - ${u.rights}`).join('\n'));
  });

  server.registerTool('myio_user', {
    title: 'Manage a user',
    description: 'User accounts (ADMIN level): action new (next free slot), delete (slot, not 0), rename (slot + name), set_password (slot + password; the login name of the slot is used), set_rights (slot + rights admin|editor|user; not slot 0). Changing the account the server itself uses will break the connection.',
    inputSchema: { action: z.enum(['new', 'delete', 'rename', 'set_password', 'set_rights']), slot: z.number().int().min(0).optional(), name: z.string().max(31).optional(), password: z.string().max(31).optional(), rights: z.enum(['admin', 'editor', 'user']).optional(), server: S },
    annotations: WR_ADM,
  }, async ({ action, slot, name, password, rights, server: sv }) => {
    const g = gate(ctx, 'admin'); if (g) return g;
    const client = reg.pick(sv);
    const users = decodeUsers(await client.usersVars());
    const cmds: string[] = [];
    if (action === 'new') cmds.push('new_userSlot=1');
    else {
      if (slot === undefined) return fail('slot is required');
      const u = users.find(x => x.slot === slot);
      if (!u) return fail(`no user in slot ${slot}`);
      if (action === 'delete') { if (slot === 0) return fail('slot 0 (admin) cannot be deleted'); cmds.push(`del_userSlot=${slot}`); }
      else if (action === 'rename') { if (!name) return fail('name is required'); cmds.push(`userName*${slot}=${enc(name)}`); }
      else if (action === 'set_password') { if (!password) return fail('password is required'); const login = name ?? u.name; if (!login) return fail('the slot has no login name; give name'); cmds.push(`pwd*${slot}=${enc(Buffer.from(`${login}:${password}`).toString('base64'))}`); }
      else if (action === 'set_rights') { if (!rights) return fail('rights is required'); if (slot === 0) return fail('slot 0 stays admin'); cmds.push(`rights*${slot}=${rights}`); }
    }
    if (action === 'new' && name) { const used = new Set(users.map(u => u.slot)); let n = 0; while (used.has(n)) n++; cmds.push(`userName*${n}=${enc(name)}`); if (password) cmds.push(`pwd*${n}=${enc(Buffer.from(`${name}:${password}`).toString('base64'))}`); if (rights) cmds.push(`rights*${n}=${rights}`); }
    const cmd = cmds.join('&');
    await client.command(cmd);
    await sleep(SETTLE_MS);
    const after = decodeUsers(await client.usersVars());
    return text(`Sent: ${cmd.replace(/pwd\*\d+=[^&]*/g, m => m.replace(/=.*/, '=<base64 hidden>'))}\n` + after.map(u => `  slot ${u.slot}: ${u.name || '(no name)'} - ${u.rights}`).join('\n'));
  });

  server.registerTool('myio_permissions', {
    title: 'User element permissions',
    description: 'Element permissions of a user slot (4.x): read / write per relay (and FET), hit / press per input - the lists of element ids the user may see / switch. On Due 3.x the map cannot be read (only set with fill/clear and explicit toggles). Admin level reads it too.',
    inputSchema: { slot: z.number().int().min(0), server: S },
    annotations: RO,
  }, async ({ slot, server: sv }) => {
    const client = reg.pick(sv);
    if (!supports(await client.version(), FEAT.usens)) return fail(`permission maps are not readable on firmware ${await client.version()} (Due); use myio_set_permissions with fill / clear`);
    const vb = await client.permissionVars(slot);
    const ids = (name: string) => varr(vb, name).map((v, i) => (v === 1 ? i + 1 : 0)).filter(Boolean);
    const lines = [`${client.name} user slot ${slot} (${vdesc(vb, 'userName').get(slot) ?? ''}):`];
    for (const [label, key] of [['relay read', 'relayReadPermission'], ['relay write', 'relayWritePermission'], ['FET read', 'fetReadPermission'], ['FET write', 'fetWritePermission'], ['PCA read', 'pcaReadPermission'], ['PCA write', 'pcaWritePermission'], ['input hit', 'switchHitPermission'], ['input press', 'switchPressPermission']] as const)
      if (vb.has(key)) { const l = ids(key); lines.push(`  ${label}: ${l.length ? (l.length === varr(vb, key).length ? 'ALL' : l.join(', ')) : 'none'}`); }
    void vnum;
    return text(lines.join('\n'));
  });

  server.registerTool('myio_set_permissions', {
    title: 'Change user element permissions',
    description: 'Change the element permissions of a user slot (ADMIN). fill = grant everything, clear = revoke everything. Then per list the ids to GRANT or REVOKE: relay_read, relay_write, pca_read, pca_write, fet_read, fet_write (output ids), input_hit, input_press (input ids). On 4.x the current map is read first and only differences are sent; on Due 3.x the firmware toggles are sent as given (each id flips its bit).',
    inputSchema: {
      slot: z.number().int().min(0), fill: z.boolean().optional(), clear: z.boolean().optional(),
      grant: z.object({ relay_read: z.array(z.number().int()).optional(), relay_write: z.array(z.number().int()).optional(), pca_read: z.array(z.number().int()).optional(), pca_write: z.array(z.number().int()).optional(), fet_read: z.array(z.number().int()).optional(), fet_write: z.array(z.number().int()).optional(), input_hit: z.array(z.number().int()).optional(), input_press: z.array(z.number().int()).optional() }).optional(),
      revoke: z.object({ relay_read: z.array(z.number().int()).optional(), relay_write: z.array(z.number().int()).optional(), pca_read: z.array(z.number().int()).optional(), pca_write: z.array(z.number().int()).optional(), fet_read: z.array(z.number().int()).optional(), fet_write: z.array(z.number().int()).optional(), input_hit: z.array(z.number().int()).optional(), input_press: z.array(z.number().int()).optional() }).optional(),
      server: S,
    },
    annotations: WR_ADM,
  }, async ({ slot, fill, clear, grant, revoke, server: sv }) => {
    const g = gate(ctx, 'admin'); if (g) return g;
    const client = reg.pick(sv);
    const v4 = supports(await client.version(), FEAT.usens);
    const cmds: string[] = [];
    if (fill) cmds.push(`fillPermission=${slot}`);
    if (clear) cmds.push(`clearPermission=${slot}`);
    const keyOf: Record<string, [string, string]> = { relay_read: ['rReadPermission', 'relayReadPermission'], relay_write: ['rWritePermission', 'relayWritePermission'], pca_read: ['pReadPermission', 'pcaReadPermission'], pca_write: ['pWritePermission', 'pcaWritePermission'],
      fet_read: ['fReadPermission', 'fetReadPermission'], fet_write: ['fWritePermission', 'fetWritePermission'], input_hit: ['swHitPermission', 'switchHitPermission'], input_press: ['swPressPermission', 'switchPressPermission'] };
    let cur: Map<string, number[]> | undefined;
    if (v4 && (grant || revoke)) {
      if (cmds.length) { await client.command(cmds.join('&')); cmds.length = 0; }
      const vb = await client.permissionVars(slot);
      cur = new Map(Object.entries(keyOf).map(([k, [, vn]]) => [k, varr(vb, vn).map(x => (x === 1 ? 1 : 0))]));
    }
    const toggles: string[] = [`permissionsUser=${slot}`];
    const want = (list: Record<string, number[] | undefined> | undefined, on: boolean) => {
      for (const [k, ids] of Object.entries(list ?? {})) for (const id of ids ?? []) {
        const idx = k.startsWith('pca') ? (id > 2000 ? id - 2000 : id) : k.startsWith('fet') ? (id > 100 ? id - 100 : id) : id;
        const has = cur ? (cur.get(k)?.[idx - 1] ?? 0) === 1 : undefined;
        if (has === undefined || has !== on) toggles.push(`${keyOf[k][0]}=${idx}`);
      }
    };
    want(grant, true); want(revoke, false);
    if (toggles.length > 1) cmds.push(...toggles);
    if (!cmds.length) return text('Nothing to change.');
    await client.command(cmds.join('&'));
    await sleep(SETTLE_MS);
    if (!v4) return text(`Sent: ${cmds.join('&')}\n  (Due 3.x: toggles applied as given; the map cannot be read back)`);
    const vb = await client.permissionVars(slot);
    const ids = (name: string) => varr(vb, name).map((v, i) => (v === 1 ? i + 1 : 0)).filter(Boolean);
    return text(`Sent: ${cmds.join('&')}\n` + Object.entries(keyOf).filter(([, [, vn]]) => vb.has(vn)).map(([k, [, vn]]) => { const l = ids(vn); return `  ${k}: ${l.length ? (l.length === varr(vb, vn).length ? 'ALL' : l.join(', ')) : 'none'}`; }).join('\n'));
  });
}
