/**
 * Haz-entitasok (MYIO_MCP_PLAN.md 4.2, 1. kor 2026-10-25): bemenetek + gombszimulacio, termosztat, redony, RGB, univerzalis
 * szenzor. A modell = a Homey-app es az MQTT-HA ag (MyIO_M7/_Mqtt.ino + mqtt_ha.cpp): termosztat = rele / nem-mixer nem-PWM PCA
 * aktivatorral (1..100 1Wire, 301+ usens); redony = vedelem-par ([0] FEL, [1] LE); RGB = "RGB..." nevu csoport R/G/B tagokkal.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  decodeInputs, decodeShutters, decodeRgb, decodeUsens, newThresholds, rgbLevels,
  fmtThermostat, fmtShutter, fmtRgb, fmtInput, fmtUsens, switchCommand, levelCommand, deviceTypeOf, baseId, FEAT,
} from '../model.js';
import { ToolContext, RO, WR, WR_SET, WR_CFG_SET, text, fail, idArg, serverArg, devices, applyDiff, sleep, SETTLE_MS, gate, thermostatsOf } from './common.js';
import type { MyIOClient } from '../api.js';

export function registerHouseTools(server: McpServer, ctx: ToolContext): void {
  const { reg } = ctx;
  const S = serverArg(reg);
  const rgbLast = new Map<string, Map<number, [number, number, number]>>();   // vezerlonkent: az utolso bekapcsolt RGB-szintek
  const lastOf = (c: MyIOClient) => { let m = rgbLast.get(c.name); if (!m) { m = new Map(); rgbLast.set(c.name, m); } return m; };


  // ---- bemenetek -----------------------------------------------------------------------------------------------------
  server.registerTool('myio_inputs', {
    title: 'Physical inputs',
    description: 'State of the physical inputs (wall buttons / switches): id (1..SQ), name, pressed/closed now, enabled, NC. Polled state, not events - a short press can be missed. Needs 4.3.12+ or Due 3.12.7+; inputs the account has no permission for are absent.',
    inputSchema: { only_active: z.boolean().optional().describe('only inputs that are pressed/closed now'), server: S },
    annotations: RO,
  }, async ({ only_active, server: sv }) => {
    const client = reg.pick(sv);
    await client.require(FEAT.inputs, 'input state (sens_IO.json)');
    const names = await client.names();
    const live = await client.snapshot(true);
    let list = decodeInputs(live, names);
    if (only_active) list = list.filter(i => i.on);
    if (!list.length) return text(only_active ? 'No input is pressed/closed now.' : 'No inputs visible (no permission, or the firmware did not return an inputs section).');
    const named = list.filter(i => i.name), unnamed = list.length - named.length;
    return text(`Inputs on ${client.name} (${list.length}${unnamed ? `, ${unnamed} unnamed` : ''}):\n` + (named.length ? named : list).map(i => '  ' + fmtInput(i)).join('\n'));
  });

  server.registerTool('myio_press_button', {
    title: 'Simulate a button',
    description: 'Simulate a wall button on input id (1..SQ): kind hit = short press (default), press = long press, release = release after a long press. The controller runs the actions bound to that input (switch/dim/group/scene), exactly like the physical button. The reply lists the outputs that changed.',
    inputSchema: { id: idArg('input id (1..SQ)'), kind: z.enum(['hit', 'press', 'release']).optional(), server: S },
    annotations: WR,
  }, async ({ id, kind, server: sv }) => applyDiff(reg.pick(sv), `s_${kind ?? 'hit'}=${id}`));

  // ---- termosztat ----------------------------------------------------------------------------------------------------
  server.registerTool('myio_thermostats', {
    title: 'Thermostats',
    description: 'Outputs controlled by a sensor: thermostat zones (relay or PCA switched by a temperature sensor: target = middle of the ON/OFF thresholds, band = their distance, mode heat if ON<OFF else cool, current temperature, heating/idle), humidity-controlled outputs, sun-controlled outputs (sunrise/sunset) and analog mixers. Use the ids with myio_set_thermostat.',
    inputSchema: { server: S },
    annotations: RO,
  }, async ({ server: sv }) => {
    const client = reg.pick(sv);
    const th = await thermostatsOf(client);
    if (!th.length) return text(`No sensor-controlled outputs on ${client.name}.`);
    return text(`${client.name}:\n` + th.map(t => '  ' + fmtThermostat(t)).join('\n'));
  });

  server.registerTool('myio_set_thermostat', {
    title: 'Set thermostat',
    description: 'Change a thermostat zone: target temperature (°C, keeps the band), band / hysteresis (°C 0.1..10, keeps the middle), or the raw ON/OFF thresholds (°C). Optionally bind the sensor: sensor = 1..100 (1-Wire id), 301.. (universal sensor 300+id), 0 = unbind (editor level). Heating = ON below OFF, cooling = ON above OFF. The controller switches the output itself; the reply reads the zone back.',
    inputSchema: {
      id: idArg('relay id (1..RQ) or PCA id (2001..) of the zone'),
      target: z.number().optional().describe('target °C (-30..100)'),
      band: z.number().optional().describe('band / hysteresis °C (0.1..10)'),
      on: z.number().optional().describe('ON threshold °C (raw; use with off)'),
      off: z.number().optional().describe('OFF threshold °C (raw; use with on)'),
      sensor: z.number().int().optional().describe('bind this sensor id (1..100 1-Wire, 301+ usens, 0 = unbind)'),
      server: S,
    },
    annotations: WR_CFG_SET,
  }, async ({ id, target, band, on, off, sensor, server: sv }) => {
    const g = gate(ctx, sensor !== undefined ? 'config' : 'state'); if (g) return g;   // a szenzor-kotes beallitas, a cel allapot
    const client = reg.pick(sv);
    const b = baseId(id); const type = deviceTypeOf(b);
    if (type !== 'relay' && type !== 'pca') return fail('only relays (1..RQ) and PCA channels (2001..) can be thermostat zones');
    if (target === undefined && band === undefined && on === undefined && off === undefined && sensor === undefined) return fail('give target and/or band, or on+off, or sensor');
    const before = (await thermostatsOf(client)).find(t => t.id === b);
    const cmds: string[] = [];
    if (sensor !== undefined) cmds.push(type === 'relay' ? `thermoActivator*${b}=${sensor}` : `PCA_thermoActivator*${b}=${sensor}`);
    if (on !== undefined || off !== undefined) {
      if (on === undefined || off === undefined) return fail('on and off must be given together');
      cmds.push(type === 'relay' ? `min_temp_ON*${b}=${Math.round(on * 10)}&max_temp_OFF*${b}=${Math.round(off * 10)}` : `PCA_temp_MIN*${b}=${Math.round(on * 10)}&PCA_temp_MAX*${b}=${Math.round(off * 10)}`);
    } else if (target !== undefined || band !== undefined) {
      if (!before && sensor === undefined) return fail(`[${b}] is not a sensor-controlled output on ${client.name} - bind a sensor first (sensor=...) or give on+off`);
      let nt: { on: number; off: number };
      try { nt = newThresholds(before?.on ?? 0, before?.off ?? 0, { target, band }); } catch (e) { return fail((e as Error).message); }
      cmds.push(type === 'relay' ? `min_temp_ON*${b}=${nt.on}&max_temp_OFF*${b}=${nt.off}` : `PCA_temp_MIN*${b}=${nt.on}&PCA_temp_MAX*${b}=${nt.off}`);
    }
    const cmd = cmds.join('&');
    await client.command(cmd);
    await sleep(SETTLE_MS);
    const after = (await thermostatsOf(client)).find(t => t.id === b);
    if (!after) return text(`Sent: ${cmd}\n[${b}] is no longer sensor-controlled (sensor unbound or no permission).`);
    return text(`Sent: ${cmd}\n  ${fmtThermostat(after)}` + (before ? `\n  (was: target ${before.target} band ${before.band} [on ${before.on / 10}, off ${before.off / 10}], sensor ${before.sensor})` : ''));
  });

  // ---- redony ----------------------------------------------------------------------------------------------------------
  server.registerTool('myio_shutters', {
    title: 'Shutters / covers',
    description: 'Shutters, blinds, gates and other UP/DOWN pairs defined as protection pairs on the controller (the two outputs can never be on together): index, name, up and down relay ids, state opening / closing / stopped. Use myio_shutter to move them.',
    inputSchema: { server: S },
    annotations: RO,
  }, async ({ server: sv }) => {
    const client = reg.pick(sv);
    const { list, names } = await devices(client);
    const sh = decodeShutters(names, list);
    return text(sh.length ? `${client.name}:\n` + sh.map(s => '  ' + fmtShutter(s)).join('\n') : `No protection pairs (shutters) on ${client.name}.`);
  });

  server.registerTool('myio_shutter', {
    title: 'Move a shutter',
    description: 'Move a shutter / cover: action open (down off, up on), close (up off, down on) or stop (both off). Identify it by index (from myio_shutters) or by the id of its up relay. The controller enforces the mutual exclusion; the motor runs until its end switch or until you stop it.',
    inputSchema: { index: z.number().int().optional().describe('pair index from myio_shutters'), up_id: z.number().int().optional().describe('id of the UP output instead of index'), action: z.enum(['open', 'close', 'stop']), server: S },
    annotations: WR_SET,
  }, async ({ index, up_id, action, server: sv }) => {
    const client = reg.pick(sv);
    const { list, names } = await devices(client);
    const sh = decodeShutters(names, list);
    const s = index !== undefined ? sh.find(x => x.index === index) : up_id !== undefined ? sh.find(x => x.up === baseId(up_id)) : undefined;
    if (!s) return fail(`no such shutter on ${client.name} - see myio_shutters (${sh.length} pairs)`);
    const up = switchCommand(s.up, 'on'), upOff = switchCommand(s.up, 'off'), dn = switchCommand(s.down, 'on'), dnOff = switchCommand(s.down, 'off');
    if (!up || !upOff || !dn || !dnOff) return fail('unsupported output type in the pair');
    const cmd = action === 'open' ? `${dnOff}&${up}` : action === 'close' ? `${upOff}&${dn}` : `${upOff}&${dnOff}`;
    await client.command(cmd);
    await sleep(SETTLE_MS);
    const after = decodeShutters((await client.names()), (await devices(client)).list).find(x => x.index === s.index)!;
    const want = action === 'open' ? 'opening' : action === 'close' ? 'closing' : 'stopped';
    return text(`Sent: ${cmd}\n  ${fmtShutter(after)}` + (after.state !== want ? `\n  ! expected ${want} but the controller reports ${after.state} (permission, cooldown after a direction change, or the pair is driven by a timer/scene)` : ''));
  });

  // ---- RGB -------------------------------------------------------------------------------------------------------------
  server.registerTool('myio_rgb', {
    title: 'RGB lights',
    description: 'RGB lights = groups whose name starts with "RGB", with R/G/B channels (PCA or FET outputs whose names start with R, G, B). Shows on/off, colour (max-normalised 0..255) and brightness (0..255, the highest channel level).',
    inputSchema: { server: S },
    annotations: RO,
  }, async ({ server: sv }) => {
    const client = reg.pick(sv);
    const { list } = await devices(client);
    const g = decodeRgb(list, lastOf(client));
    return text(g.length ? `${client.name}:\n` + g.map(x => '  ' + fmtRgb(x)).join('\n') : `No RGB groups on ${client.name} (a group named "RGB..." with R/G/B named dimmer members is needed).`);
  });

  server.registerTool('myio_set_rgb', {
    title: 'Set RGB light',
    description: 'Control an RGB light (group id from myio_rgb): on/off, colour r,g,b (0..255 each; the brightness is kept unless given), brightness 0..255 (keeps the colour). ON without colour restores the last colour (white at first). The channel levels are written directly (PCA*<id>=<level>) and read back.',
    inputSchema: {
      id: idArg('RGB group id (501..)'),
      on: z.boolean().optional(),
      r: z.number().int().min(0).max(255).optional(), g: z.number().int().min(0).max(255).optional(), b: z.number().int().min(0).max(255).optional(),
      brightness: z.number().int().min(0).max(255).optional(),
      server: S,
    },
    annotations: WR_SET,
  }, async ({ id, on, r, g, b, brightness, server: sv }) => {
    const client = reg.pick(sv);
    const { list } = await devices(client);
    const grp = decodeRgb(list, lastOf(client)).find(x => x.id === id || x.id === 500 + id);
    if (!grp) return fail(`no RGB group ${id} on ${client.name} - see myio_rgb`);
    const color = r !== undefined || g !== undefined || b !== undefined ? [r ?? 0, g ?? 0, b ?? 0] as [number, number, number] : undefined;
    if (on === undefined && !color && brightness === undefined) return fail('give on, colour (r,g,b) or brightness');
    const lv = rgbLevels(grp, { on, color, brightness });
    if (lv === 'noop') return text(`Already ON:\n  ${fmtRgb(grp)}`);
    const parts: string[] = [];
    for (let c = 0; c < 3; c++) {
      const ch = grp.channels[c]; if (!ch) continue;
      parts.push(lv === 'off' ? switchCommand(ch, 'off')! : levelCommand(ch, lv[c])!);
    }
    const cmd = parts.join('&');
    await client.command(cmd);
    await sleep(SETTLE_MS);
    const after = decodeRgb((await devices(client)).list, lastOf(client)).find(x => x.id === grp.id)!;
    return text(`Sent: ${cmd}\n  ${fmtRgb(after)}\n  (was: ${grp.on ? 'ON' : 'OFF'} rgb(${grp.color.join(', ')}) brightness ${grp.brightness})`);
  });

  // ---- univerzalis szenzorok ---------------------------------------------------------------------------------------------
  server.registerTool('myio_usensors', {
    title: 'Universal sensors',
    description: '4.x: the universal sensor slots (0..SENQ): name, type (temperature, humidity, dew point, power, energy, CO2 ...), value, ok / STALE / no value, failsafe time, enabled. Sources: KNX, Modbus, MQTT, Shelly, Script, external HTTP (usens*<id>=). Activator id for thermostats = 300+id. Needs editor level.',
    inputSchema: { include_disabled: z.boolean().optional(), server: S },
    annotations: RO,
  }, async ({ include_disabled, server: sv }) => {
    const client = reg.pick(sv);
    const { senq, list } = decodeUsens(await client.usensors());
    const shown = list.filter(u => include_disabled || u.enabled || u.name || u.state !== 'none');
    return text(`${client.name}: universal sensors (SENQ=${senq}, ${shown.length} shown):\n` + (shown.length ? shown.map(u => '  ' + fmtUsens(u)).join('\n') : '  (none configured)'));
  });

  server.registerTool('myio_set_usens', {
    title: 'Write a universal sensor',
    description: '4.x: push a value into a universal sensor slot (id 0..SENQ) from outside, e.g. a temperature from another system: value in real units (21.5 °C -> stored as 215). Thermostats, Flow, MQTT and logs see it like any sensor. The slot must be enabled; the reply reads it back.',
    inputSchema: { id: z.number().int().min(0).describe('usens id (0..SENQ)'), value: z.number().describe('value in real units (one decimal is kept)'), server: S },
    annotations: WR_SET,
  }, async ({ id, value, server: sv }) => {
    const client = reg.pick(sv);
    await client.require(FEAT.usens, 'universal sensors');
    const x10 = Math.round(value * 10);
    await client.command(`usens*${id}=${x10}`);
    await sleep(SETTLE_MS);
    const u = decodeUsens(await client.usensors()).list.find(s => s.id === id);
    if (!u) return text(`Sent: usens*${id}=${x10}\n  slot ${id} is not configured on ${client.name} (enable it on the Sensors page: u_en) - the value was dropped.`);
    return text(`Sent: usens*${id}=${x10}\n  ${fmtUsens(u)}` + (Math.round(u.value * 10) !== x10 ? '\n  ! the controller did not take the value (slot disabled?)' : ''));
  });
}
