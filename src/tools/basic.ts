/**
 * Alap-eszkozok (MYIO_MCP_PLAN.md 4.1 + a 2026-02-es 20 eszkoz javitott szemantikaval; 0. kor 2026-10-25, 1. kor: `server`,
 * szerepek, usens a szenzor-listaban, myio_servers, myio_find, myio_output).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  DeviceType, decodeSensors, decodeInputs, fmtDevice, fmtSensor, fmtUsens, fmtInput, num, groupId, pcaId, fetId, deviceTypeOf, baseId,
  percentToLevel, isV4, switchCommand, levelCommand, normalizeName, supports, FEAT,
} from '../model.js';
import { ToolContext, RO, WR, WR_SET, WR_CFG, text, fail, idArg, serverArg, devices, apply, applyDiff, usensOrEmpty, expectOn, expectToggle, expectLevel } from './common.js';

export function registerBasicTools(server: McpServer, ctx: ToolContext): void {
  const { reg } = ctx;
  const S = serverArg(reg);

  // ---- felderites ----------------------------------------------------------------------------------------------
  server.registerTool('myio_servers', {
    title: 'Configured myIO controllers',
    description: 'List the configured controllers (name, URL) with a live check: firmware version, device name, permission level, reachability. Use the name as the `server` argument of the other tools; without it the first controller is used.',
    inputSchema: {},
    annotations: RO,
  }, async () => {
    const rows = await Promise.all(reg.clients.map(async c => {
      try { const { info } = await c.info(true); return `${c.name} (${c.origin}): firmware ${info.version ?? '?'}, name "${info.name ?? ''}", CPU ${info.CPU ?? '?'}, right ${info.right ?? '?'}, serial ${info.serial ?? '?'}`; }
      catch (e) { return `${c.name} (${c.origin}): UNREACHABLE - ${(e as Error).message}`; }
    }));
    return text(`Controllers (default: ${reg.names[0]}):\n` + rows.map(r => '  ' + r).join('\n'));
  });

  server.registerTool('myio_info', {
    title: 'myIO controller info',
    description: 'Identify the controller: serial, firmware version, CPU/board, device name, element counts (RQ relays, SQ inputs, PCAQ PCA channels, SHQ Shelly, SENQ universal sensors), the permission level of this account (0 admin, 1 editor, 2 user), uptime, found I2C expanders and storage health. Call this first: the version decides which features exist (3.12.x = Due, only base features; 4.x = GIGA/Opta, all features).',
    inputSchema: { server: S },
    annotations: RO,
  }, async ({ server: sv }) => {
    const client = reg.pick(sv);
    const { info } = await client.info(true);
    const v = String(info.version ?? '?');
    const lines = [
      `${client.name} (${client.origin})`,
      `serial ${info.serial ?? '?'} · firmware ${v} (${isV4(v) ? 'GIGA/Opta 4.x: full feature set' : 'Due 3.x: base features only, no [4.x] features'}) · CPU ${info.CPU ?? '?'} · name "${info.name ?? ''}" · api ${info.api ?? '?'}`,
      `counts: relays RQ=${info.RQ ?? '?'}, inputs SQ=${info.SQ ?? '?'}, PCA channels PCAQ=${info.PCAQ ?? '?'} (ids 2001..${2000 + num(info.PCAQ)}), Shelly SHQ=${info.SHQ ?? '-'}, universal sensors SENQ=${info.SENQ ?? '-'}`,
      `this account: right=${info.right ?? 'unknown (old firmware)'} (0 admin / 1 editor / 2 user) · uptime ${info.uptime ?? '?'} s · reset cause ${info.reset_cause ?? '?'}`,
      `features: inputs ${supports(v, FEAT.inputs) ? 'yes' : 'no'}, universal sensors ${supports(v, FEAT.usens) ? 'yes' : 'no'}, Flow ${supports(v, FEAT.flow) ? 'yes' : 'no'}, Script ${supports(v, FEAT.script) ? 'yes' : 'no'}`,
    ];
    if (info.pca_online || info.pcf_online || info.inp_online) lines.push(`I2C expanders found: pca_online=${JSON.stringify(info.pca_online ?? [])} pcf_online=${JSON.stringify(info.pcf_online ?? [])} inp_online=${JSON.stringify(info.inp_online ?? [])}`);
    if (info.exp_q !== undefined) lines.push(`RS485 expanders: ${info.exp_q}, online ${JSON.stringify(info.exp_online ?? [])}`);
    if (info.qhealth !== undefined) lines.push(`storage: qhealth=${info.qhealth} (1 = settings writable) qheal=${info.qheal} eepbak=${info.eepbak}`);
    if (info.bootloader !== undefined) lines.push(`bootloader ${info.bootloader} · rdp ${info.rdp} · rollback ${info.rollback}`);
    return text(lines.join('\n'));
  });

  server.registerTool('myio_find', {
    title: 'Find by name',
    description: 'Search outputs, groups, sensors, inputs and universal sensors by name (accent- and case-insensitive substring, e.g. "nappali"). Returns ids and live state so you can use the right control tool.',
    inputSchema: { query: z.string().min(1).describe('name fragment'), server: S },
    annotations: RO,
  }, async ({ query, server: sv }) => {
    const client = reg.pick(sv);
    const q = normalizeName(query);
    const { list, live, names } = await devices(client, true);
    const hits: string[] = [];
    for (const d of list) if (normalizeName(d.name).includes(q)) hits.push(`${d.type}: ${fmtDevice(d)}`);
    for (const s of decodeSensors(live, names)) if (normalizeName(s.name).includes(q)) hits.push(`sensor: ${fmtSensor(s)}`);
    for (const i of decodeInputs(live, names)) if (normalizeName(i.name).includes(q)) hits.push(`input: ${fmtInput(i)}`);
    for (const u of await usensOrEmpty(client)) if (normalizeName(u.name).includes(q)) hits.push(`usens: ${fmtUsens(u)}`);
    return text(hits.length ? `Matches for "${query}" on ${client.name}:\n` + hits.map(h => '  ' + h).join('\n') : `No element named like "${query}" on ${client.name}.`);
  });

  server.registerTool('myio_list_devices', {
    title: 'List myIO outputs',
    description: 'List outputs with id, name, live state and level: relays (1..RQ), FET/PWM channels (101..116, only on old hardware), PCA dimmer channels (2001..2000+PCAQ), groups (501..). Shows roles in braces: thermostat / sun-controlled / mixer / shutter-up / shutter-down / joiner / rgb:<group> / group:<group>, thermostat thresholds, running timers and group members. By default only NAMED elements are listed (unnamed ones are counted); set include_unnamed=true to see all. Use the ids with the control tools.',
    inputSchema: {
      type: z.enum(['relay', 'fet', 'pca', 'group']).optional().describe('only this type'),
      include_unnamed: z.boolean().optional().describe('also list elements without a name (default false)'),
      server: S,
    },
    annotations: RO,
  }, async ({ type, include_unnamed, server: sv }) => {
    const client = reg.pick(sv);
    const { list } = await devices(client);
    const sel = list.filter(d => !type || d.type === type);
    const groups: Record<DeviceType, string> = { relay: 'Relays', fet: 'FET/PWM outputs', pca: 'PCA dimmer channels', group: 'Groups' };
    const sections: string[] = [];
    for (const t of ['relay', 'fet', 'pca', 'group'] as DeviceType[]) {
      const all = sel.filter(d => d.type === t);
      if (!all.length) continue;
      const shown = include_unnamed ? all : all.filter(d => d.name || d.type === 'group');
      const hidden = all.length - shown.length;
      sections.push(`${groups[t]} (${all.length}${hidden ? `, ${hidden} unnamed hidden` : ''}):\n` + shown.map(d => '  ' + fmtDevice(d)).join('\n'));
    }
    return text(sections.length ? `${client.name}:\n` + sections.join('\n\n') : `No outputs visible to this account on ${client.name}.`);
  });

  server.registerTool('myio_read_sensors', {
    title: 'Read myIO sensors',
    description: 'All sensor readings in real units: 1-Wire temperature (ids 1..100, °C), humidity (101..110, %), pulse energy meter (200), SDM630 power/voltage/current per phase (201..209: W, V, A), and on 4.x firmware the universal sensors (usens 0..SENQ: temperature, humidity, dew point, power, energy, CO2 ... from KNX/Modbus/MQTT/Shelly/Script; activator id = 300+id). Invalid/missing sensors read "invalid"; STALE = no fresh value within the failsafe time.',
    inputSchema: { kind: z.enum(['temperature', 'humidity', 'pulse', 'sdm_power', 'sdm_voltage', 'sdm_current', 'usens']).optional().describe('only this kind'), server: S },
    annotations: RO,
  }, async ({ kind, server: sv }) => {
    const client = reg.pick(sv);
    const names = await client.names();
    const live = await client.snapshot();
    const all = decodeSensors(live, names).filter(s => !kind || s.kind === kind);
    const lines: string[] = [];
    if (all.length && kind !== 'usens') lines.push('Sensors:\n' + all.map(s => '  ' + fmtSensor(s)).join('\n'));
    if (!kind || kind === 'usens') {
      const u = await usensOrEmpty(client);
      const shown = u.filter(x => x.enabled || x.name || x.state !== 'none');
      if (shown.length) lines.push('Universal sensors (4.x):\n' + shown.map(x => '  ' + fmtUsens(x)).join('\n'));
      else if (kind === 'usens') lines.push(supports(await client.version(), FEAT.usens) ? 'No universal sensors configured (or no editor permission for usensor.json).' : 'Universal sensors need 4.x firmware.');
    }
    return text(lines.length ? `${client.name}:\n` + lines.join('\n\n') : 'No sensors visible.');
  });

  server.registerTool('myio_get_status', {
    title: 'Raw myIO JSON',
    description: 'Fetch a raw JSON endpoint of the controller. Default sens_out.json (live state of all outputs and sensors, minimal fields). Others: d_sens_out.json (with names), f_sens_out.json (all fields), sens_IO.json (+inputs, 4.3.12+/3.12.7+), output.json, relay.json, pca.json, groups.json, prot.json, joiner.json, sensor.json, info.json, usensor.json / shelly.json / link.json / sysdiag.json / flowtrace.json / prog.json / ai.json / alarm.json (4.x, editor level). Keys the account has no permission for are simply absent. Values: temp ×100, hum ×10, thresholds ×10, PCA level 0..255.',
    inputSchema: { endpoint: z.string().regex(/^[a-zA-Z0-9_]+\.(json|jsn)$/).optional().describe('file name, e.g. sens_out.json'), server: S },
    annotations: RO,
  }, async ({ endpoint, server: sv }) => {
    const data = await reg.pick(sv).getJson(endpoint ?? 'sens_out.json');
    return text(JSON.stringify(data, null, 1));
  });

  // ---- univerzalis kimenet-iro ------------------------------------------------------------------------------------
  server.registerTool('myio_output', {
    title: 'Switch or dim any output',
    description: 'One tool for every output type, by id: relay (1..RQ), FET (101..116), group (501..), PCA dimmer (2001..). action: on | off | toggle | level (level needs `level` 0..255 or `percent` 0..100; PCA/FET only). ON on a dimmer = its configured MAX, OFF = MIN. Reads the state back.',
    inputSchema: {
      id: idArg('element id'),
      action: z.enum(['on', 'off', 'toggle', 'level']),
      level: z.number().int().min(0).max(255).optional().describe('raw level 0..255 (action=level)'),
      percent: z.number().min(0).max(100).optional().describe('level in percent (action=level, when level is not given)'),
      server: S,
    },
    annotations: WR,
  }, async ({ id, action, level, percent, server: sv }) => {
    const client = reg.pick(sv);
    const b = baseId(id);
    if (!deviceTypeOf(b)) return fail(`id ${id} is outside the myIO id map (relay 1..100, FET 101..116, group 501.., PCA 2001..)`);
    if (action === 'level') {
      if (level === undefined && percent === undefined) return fail('action=level needs level (0..255) or percent (0..100)');
      const want = level ?? percentToLevel(percent!);
      const cmd = levelCommand(b, want);
      if (!cmd) return fail(`id ${id} is a ${deviceTypeOf(b)} - only PCA/FET outputs take a level; use on/off/toggle`);
      return apply(client, cmd, [b], expectLevel(want));
    }
    const cmd = switchCommand(b, action)!;
    return apply(client, cmd, [b], action === 'toggle' ? expectToggle : expectOn(action === 'on'));
  });

  // ---- rele ------------------------------------------------------------------------------------------------------
  const relayDesc = (what: string) => `${what} a relay output. id = relay id 1..RQ (see myio_info / myio_list_devices). The reply shows the state read back from the controller.`;
  server.registerTool('myio_relay_on', { title: 'Relay ON', description: relayDesc('Turn ON'), inputSchema: { id: idArg('relay id (1..RQ)'), server: S }, annotations: WR_SET },
    async ({ id, server: sv }) => apply(reg.pick(sv), `r_ON=${id}`, [id], expectOn(true)));
  server.registerTool('myio_relay_off', { title: 'Relay OFF', description: relayDesc('Turn OFF'), inputSchema: { id: idArg('relay id (1..RQ)'), server: S }, annotations: WR_SET },
    async ({ id, server: sv }) => apply(reg.pick(sv), `r_OFF=${id}`, [id], expectOn(false)));
  server.registerTool('myio_relay_toggle', { title: 'Relay toggle', description: relayDesc('Toggle (invert)'), inputSchema: { id: idArg('relay id (1..RQ)'), server: S }, annotations: WR },
    async ({ id, server: sv }) => apply(reg.pick(sv), `r_INV=${id}`, [id], expectToggle));

  // ---- PCA ---------------------------------------------------------------------------------------------------------
  const pcaDesc = (what: string) => `${what} a PCA channel (dimmer / universal output). id = 2001..2000+PCAQ (a 1-based channel number is also accepted). ON = the channel's configured MAX level, OFF = its MIN level.`;
  server.registerTool('myio_pca_on', { title: 'PCA ON', description: pcaDesc('Turn ON'), inputSchema: { id: idArg('PCA id (2001..)'), server: S }, annotations: WR_SET },
    async ({ id, server: sv }) => { const p = pcaId(id); return apply(reg.pick(sv), `PCA_ON=${p}`, [p], expectOn(true)); });
  server.registerTool('myio_pca_off', { title: 'PCA OFF', description: pcaDesc('Turn OFF'), inputSchema: { id: idArg('PCA id (2001..)'), server: S }, annotations: WR_SET },
    async ({ id, server: sv }) => { const p = pcaId(id); return apply(reg.pick(sv), `PCA_OFF=${p}`, [p], expectOn(false)); });
  server.registerTool('myio_pca_toggle', { title: 'PCA toggle', description: pcaDesc('Toggle'), inputSchema: { id: idArg('PCA id (2001..)'), server: S }, annotations: WR },
    async ({ id, server: sv }) => { const p = pcaId(id); return apply(reg.pick(sv), `PCA_INV=${p}`, [p], expectToggle); });
  server.registerTool('myio_pca_set', {
    title: 'PCA level',
    description: 'Set a PCA channel to an exact level. Give either level (raw 0..255, what the controller stores and shows) or percent (0..100, converted to 0..255). If the channel has an auto-off timer, setting it above MIN (re)starts the timer. id = 2001..2000+PCAQ.',
    inputSchema: {
      id: idArg('PCA id (2001..)'),
      level: z.number().int().min(0).max(255).optional().describe('raw level 0..255'),
      percent: z.number().min(0).max(100).optional().describe('level in percent (0..100), used when level is not given'),
      server: S,
    },
    annotations: WR_SET,
  }, async ({ id, level, percent, server: sv }) => {
    if (level === undefined && percent === undefined) return fail('give level (0..255) or percent (0..100)');
    const want = level ?? percentToLevel(percent!);
    const p = pcaId(id);
    return apply(reg.pick(sv), `PCA*${p}=${want}`, [p], expectLevel(want));
  });

  // ---- FET / PWM (csak FETPWM-es vason: regi Due) -----------------------------------------------------------------
  const fetDesc = (what: string) => `${what} a FET/PWM output (legacy hardware only; ids 101..116 - absent on most GIGA/Opta controllers, see myio_list_devices).`;
  server.registerTool('myio_pwm_on', { title: 'PWM ON', description: fetDesc('Turn ON'), inputSchema: { id: idArg('FET id (101..116)'), server: S }, annotations: WR_SET },
    async ({ id, server: sv }) => { const f = fetId(id); return apply(reg.pick(sv), `f_ON=${f}`, [f], expectOn(true)); });
  server.registerTool('myio_pwm_off', { title: 'PWM OFF', description: fetDesc('Turn OFF'), inputSchema: { id: idArg('FET id (101..116)'), server: S }, annotations: WR_SET },
    async ({ id, server: sv }) => { const f = fetId(id); return apply(reg.pick(sv), `f_OFF=${f}`, [f], expectOn(false)); });
  server.registerTool('myio_pwm_toggle', { title: 'PWM toggle', description: fetDesc('Toggle'), inputSchema: { id: idArg('FET id (101..116)'), server: S }, annotations: WR },
    async ({ id, server: sv }) => { const f = fetId(id); return apply(reg.pick(sv), `f_INV=${f}`, [f], expectToggle); });
  server.registerTool('myio_pwm_set', {
    title: 'PWM level',
    description: 'Set a FET/PWM output level: level (raw 0..255) or percent (0..100). Legacy hardware only (ids 101..116).',
    inputSchema: { id: idArg('FET id (101..116)'), level: z.number().int().min(0).max(255).optional(), percent: z.number().min(0).max(100).optional(), server: S },
    annotations: WR_SET,
  }, async ({ id, level, percent, server: sv }) => {
    if (level === undefined && percent === undefined) return fail('give level (0..255) or percent (0..100)');
    const want = level ?? percentToLevel(percent!);
    const f = fetId(id);
    return apply(reg.pick(sv), `fet*${f}=${want}`, [f], expectLevel(want));
  });

  // ---- csoport -------------------------------------------------------------------------------------------------------
  const grpDesc = (what: string) => `${what} a group of outputs. id = 501..520 (1..20 also accepted). Group commands need EDITOR level on most firmware (a plain user cannot switch groups even with member permissions).`;
  server.registerTool('myio_group_on', { title: 'Group ON', description: grpDesc('Turn ON all members of'), inputSchema: { id: idArg('group id (501..)'), server: S }, annotations: WR_SET },
    async ({ id, server: sv }) => { const g = groupId(id); return apply(reg.pick(sv), `g_ON=${g}`, [g], expectOn(true)); });
  server.registerTool('myio_group_off', { title: 'Group OFF', description: grpDesc('Turn OFF all members of'), inputSchema: { id: idArg('group id (501..)'), server: S }, annotations: WR_SET },
    async ({ id, server: sv }) => { const g = groupId(id); return apply(reg.pick(sv), `g_OFF=${g}`, [g], expectOn(false)); });
  server.registerTool('myio_group_toggle', { title: 'Group toggle', description: grpDesc('Smart-toggle') + ' Mixed state: pullUP=1 turns ALL ON, pullUP=0 turns ALL OFF.', inputSchema: { id: idArg('group id (501..)'), server: S }, annotations: WR },
    async ({ id, server: sv }) => { const g = groupId(id); return apply(reg.pick(sv), `g_INV=${g}`, [g], expectToggle); });

  // ---- nyers parancs ---------------------------------------------------------------------------------------------------
  server.registerTool('myio_send_command', {
    title: 'Raw myIO command',
    description: 'Send raw command(s) to the controller, chained with &, e.g. "r_ON=16&r_OFF=5&PCA*2001=128" (PCA level is RAW 0..255). Covers everything in the API reference: thresholds min_temp_ON*<id>=<x10>, names r_descr*<id>=<text>, timers r_timer*<id>=<s>, scene load lo_all=<slot>, button simulation s_hit=<id>, usens*<id>=<x10> etc. Toggle-type config commands (relaysInvert=<id>, PCA_PWM=<id>...) INVERT the flag - read the current value first. Body limit 1024 bytes. The reply lists which outputs changed state.',
    inputSchema: { commands: z.string().min(1).describe('command string, key=value pairs joined with &'), server: S },
    annotations: WR_CFG,   // nyers parancs: barmi lehet (konfig, admin is)
  }, async ({ commands, server: sv }) => applyDiff(reg.pick(sv), commands));
}
