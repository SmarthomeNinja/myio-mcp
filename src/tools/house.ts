/**
 * Haz-entitasok (MYIO_MCP_PLAN.md 4.2, 1. kor 2026-10-25): bemenetek + gombszimulacio, termosztat, redony, RGB, univerzalis
 * szenzor. A modell = a Homey-app es az MQTT-HA ag (MyIO_M7/_Mqtt.ino + mqtt_ha.cpp): termosztat = rele / nem-mixer nem-PWM PCA
 * aktivatorral (1..100 1Wire, 301+ usens); redony = vedelem-par ([0] FEL, [1] LE); RGB = "RGB..." nevu csoport R/G/B tagokkal.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  decodeInputs, decodeShutters, decodeRgb, decodeUsens, decodeSensors, decodeInputConfigs, decodeGlobals, nameMaps, newThresholds, rgbLevels,
  fmtThermostat, fmtShutter, fmtRgb, fmtInput, fmtUsens, fmtInputConfig, switchCommand, levelCommand, deviceTypeOf, baseId, FEAT, INPUT_EVENT_KIND,
} from '../model.js';
import type { RawInputEvent, SensorReading } from '../model.js';
import { ToolContext, RO, WR, WR_SET, WR_CFG_SET, text, fail, idArg, serverArg, devices, applyDiff, sleep, SETTLE_MS, gate, thermostatsOf } from './common.js';
import { MyIOError } from '../api.js';
import type { MyIOClient } from '../api.js';

// tanulo eszkozok (AI_SETUP_PLAN.md A2): a varakozas egy eszkoz-hivason belul fut, ezert rovid marad (a felhos szerver
// valasza egy sima HTTP-valasz: 100 s felett a proxy bontana)
const WAIT_MAX_S = 60;
const EVENT_POLL_MS = 400;        // inev.json: kis valasz, a vezerlo sorszammal adja -> ket lekerdezes kozt semmi nem vesz el
const STATE_POLL_MS = 800;        // regi fw: sens_IO.json allapot (Due: 1000 - a W5500 a suru kereseket elutasitja)
const LOOKBACK_MS = 4000;         // a hivas ELOTT ennyivel tortent nyomas meg szamit (a user elobb nyom, mint ahogy a keres odaer)
const SENSOR_POLL_MS = 2000;
const SENSOR_KEEP_MS = 5 * 60_000;

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

  // ---- tanulas: "nyomd meg a gombot" ---------------------------------------------------------------------------------
  const inevSeen = new Map<string, number>();   // vezerlonkent: az utolso JELENTETT esemeny sorszama (ne jelentsuk ketszer)

  /** mit csinal a bemenet (hit / press / release celok) - csak editor/admin latja a /setup var-blokkot; kulonben ures */
  async function boundText(client: MyIOClient, ids: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    try {
      const vb = await client.setupVars(); const n = nameMaps(vb);
      for (const c of decodeInputConfigs(vb)) if (ids.includes(c.id)) out.set(c.id, fmtInputConfig(c, n));
    } catch { /* user-jogu fiok: a kotes nem latszik, a nev eleg */ }
    return out;
  }

  server.registerTool('myio_wait_input', {
    title: 'Wait for a button press',
    description: 'Wait until someone presses a physical wall button / input and report which one it was: input id, name, kind of press and what the input is bound to. '
      + 'Use it to identify inputs during setup: ask the user to press one button, then call this. Returns at the first press, or after timeout_s (default 30, max 60) saying nothing was pressed - call it again to keep waiting. '
      + 'A press made up to 4 s before the call still counts. count > 1 collects several presses in one call. '
      + 'Firmware 4.27+ reports every gesture (short press, long press, release), so a short tap is enough; older firmware only shows the momentary state, so the button must be HELD for 2-3 s. '
      + 'Disabled inputs and inputs the account has no permission for report nothing. Changes nothing on the controller.',
    inputSchema: {
      timeout_s: z.number().int().min(3).max(WAIT_MAX_S).optional().describe('how long to wait, seconds (default 30)'),
      count: z.number().int().min(1).max(8).optional().describe('how many presses to collect before returning (default 1)'),
      server: S,
    },
    annotations: RO,
  }, async ({ timeout_s, count, server: sv }) => {
    const client = reg.pick(sv);
    await client.require(FEAT.inputs, 'input state');
    const waitMs = (timeout_s ?? 30) * 1000, want = count ?? 1;
    const t0 = Date.now(), deadline = t0 + waitMs;
    const names = new Map(decodeInputs(await client.names()).map(i => [i.id, i.name]));
    const label = (id: number) => `[${id}] ${names.get(id) || '(unnamed)'}`;
    const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
    let fails = 0, oks = 0, lastErr = '';
    const noted = (e: unknown) => { fails++; lastErr = (e as Error).message; if (!(e instanceof MyIOError)) throw e; };
    const nothing = (mode: string) => {
      if (!oks && fails) return fail(`${client.name}: the controller could not be reached while waiting (${lastErr}). Nothing is known about button presses in this time - try again.`);
      return text(`No button press seen on ${client.name} in ${Math.round((Date.now() - t0) / 1000)} s${fails ? ` (${fails} of ${fails + oks} checks failed: ${lastErr})` : ''}.\n`
        + `${mode} Possible causes: the input is disabled (myio_input_config), not wired to this controller, or this account has no permission for it. Call again to keep waiting.`);
    };

    if (await client.supports(FEAT.inputEvents)) {
      // --- esemeny-mod (fw 4.27+): sorszamozott gesztusok ---
      const got: RawInputEvent[] = [];
      const presses = () => got.filter(e => e.e !== 'R').length;
      // az elengedes (R) onmagaban nem uj nyomas: csak akkor kerul a listaba, ha a hozza tartozo hosszu nyomast (P) is mi lattuk
      // (kulonben az elozo hivasban jelentett hosszu nyomas elengedese a kovetkezo gombnak latszana)
      const take = (evs: RawInputEvent[], maxAge: number) => { for (const e of evs) if (e.age <= maxAge && (e.e !== 'R' || got.some(x => x.id === e.id && x.e === 'P'))) got.push(e); };
      const first = await client.inputEvents(inevSeen.get(client.name) ?? 0);
      let seq = first.seq;
      if (inevSeen.has(client.name) && seq < inevSeen.get(client.name)!) {          // a vezerlo ujraindult: a sorszam elolrol megy
        const again = await client.inputEvents(0); seq = again.seq; first.events = again.events;
      }
      take(first.events, LOOKBACK_MS);
      while (presses() < want && Date.now() < deadline) {
        await sleep(Math.min(EVENT_POLL_MS, Math.max(0, deadline - Date.now())));
        try {
          let r = await client.inputEvents(seq);
          if (r.seq < seq) r = await client.inputEvents(0);                            // ujraindulas a varakozas kozben
          oks++;
          take(r.events, Date.now() - t0 + LOOKBACK_MS);
          seq = r.seq;
        } catch (e) { noted(e); }
      }
      inevSeen.set(client.name, seq);
      if (!got.length) return nothing('A short tap is enough on this firmware.');
      const bound = await boundText(client, [...new Set(got.map(e => e.id))]);
      const lines = got.map(e => `  ${label(e.id)}: ${INPUT_EVENT_KIND[e.e] ?? e.e} (${secs(e.age)} before it was read)`);
      const ids = [...new Set(got.map(e => e.id))];
      const L = [`${ids.length === 1 ? `Input ${ids[0]} was pressed` : `${ids.length} inputs were pressed`} on ${client.name}:`, ...lines];
      if (bound.size) L.push('Configuration:', ...ids.filter(id => bound.has(id)).map(id => '  ' + bound.get(id)));
      if (presses() < want) L.push(`(${presses()} of ${want} presses seen before the ${Math.round(waitMs / 1000)} s timeout)`);
      return text(L.join('\n'));
    }

    // --- allapot-mod (regi fw): a sens_IO.json 0 -> 1 ele; a rovid nyomast ket lekerdezes kozt elszalaszthatja ---
    const poll = (await client.supports({ v4: '4.0.0' })) ? STATE_POLL_MS : 1000;
    const hits: number[] = [];
    let prev = new Map(decodeInputs(await client.snapshot(true)).map(i => [i.id, i.on]));
    while (hits.length < want && Date.now() < deadline) {
      await sleep(Math.min(poll, Math.max(0, deadline - Date.now())));
      try {
        const cur = new Map(decodeInputs(await client.snapshot(true)).map(i => [i.id, i.on]));
        oks++;
        for (const [id, on] of cur) if (on && prev.get(id) === false) hits.push(id);
        prev = cur;
      } catch (e) { noted(e); }
    }
    const old = `This firmware (${await client.version()}) only shows the momentary input state: the button must be HELD for 2-3 s (firmware 4.27+ reports short taps too).`;
    if (!hits.length) {
      const held = [...prev].filter(([, on]) => on).map(([id]) => label(id));
      return nothing(old + (held.length ? ` Closed all the time (ignored): ${held.join(', ')}.` : ''));
    }
    const ids = [...new Set(hits)];
    const bound = await boundText(client, ids);
    const L = [`${ids.length === 1 ? `Input ${ids[0]} was pressed` : `${ids.length} inputs were pressed`} on ${client.name}:`, ...hits.map(id => `  ${label(id)}: pressed (the kind of press is not reported by this firmware)`)];
    if (bound.size) L.push('Configuration:', ...ids.filter(id => bound.has(id)).map(id => '  ' + bound.get(id)));
    L.push(old);
    return text(L.join('\n'));
  });

  // ---- tanulas: "fogd meg a homerot" -----------------------------------------------------------------------------------
  interface SensorWatch { at: number; t0: number; base: Map<number, number>; }
  const sensorWatch = new Map<string, SensorWatch>();   // vezerlonkent: a be nem fejezett figyeles kiindulo ertekei
  const temps = (list: SensorReading[]) => list.filter(s => s.kind === 'temperature' && s.value !== null && s.raw !== 8500);

  server.registerTool('myio_wait_sensor', {
    title: 'Find the sensor being warmed',
    description: 'Find out which 1-Wire temperature sensor someone is warming: watches all thermometers and returns the one whose reading rose (by 1.0 °C by default). '
      + 'Use it to identify thermometers during setup: ask the user to hold one sensor in the hand (or warm it otherwise), then call this. '
      + 'Returns at the first clear rise, or after timeout_s (default 45, max 60) with the changes seen so far - call it again to keep waiting: the starting temperatures of an unfinished wait are kept for 5 minutes (reset=true starts fresh). '
      + 'The controller measures the sensors one after the other (one per "temperature polling" interval), so with many sensors a rise shows up slowly; the answer says how long a full round takes. '
      + 'Universal sensors (usens) are not watched. Changes nothing on the controller.',
    inputSchema: {
      timeout_s: z.number().int().min(5).max(WAIT_MAX_S).optional().describe('how long to wait, seconds (default 45)'),
      rise: z.number().min(0.3).max(20).optional().describe('how many °C a sensor must rise to count (default 1.0)'),
      reset: z.boolean().optional().describe('forget the starting temperatures of an earlier unfinished wait'),
      server: S,
    },
    annotations: RO,
  }, async ({ timeout_s, rise, reset, server: sv }) => {
    const client = reg.pick(sv);
    const need = rise ?? 1.0, waitMs = (timeout_s ?? 45) * 1000;
    const tStart = Date.now(), deadline = tStart + waitMs;
    const names = await client.names();
    const read = async () => temps(decodeSensors(await client.snapshot(), names));
    let now = await read();
    if (!now.length) return fail(`${client.name}: no 1-Wire temperature sensor with a valid reading is visible (see myio_read_sensors; after wiring a new sensor run myio_sensor_rescan).`);
    let w = sensorWatch.get(client.name);
    const resumed = !!w && !reset && Date.now() - w.at < SENSOR_KEEP_MS;
    if (!resumed) w = { at: Date.now(), t0: Date.now(), base: new Map() };
    const watch = w!;
    const fmt = (v: number) => v.toFixed(1);
    const delta = (s: SensorReading) => (s.value as number) - (watch.base.get(s.id) ?? (s.value as number));
    // egy teljes meresi kor ideje: szenzoronkent egy "tempTimer" (csak editor/admin latja a beallitast)
    let round = '';
    try {
      const tt = decodeGlobals(await client.setupVars()).tempTimer;
      if (tt > 0) round = `The controller measures one sensor every ${tt} s, so each of the ${now.length} sensors is refreshed about every ${tt * now.length} s`
        + (tt * now.length > 20 ? ' - for a faster answer set temp_timer=1 with myio_set_globals for the time of the identification (and set it back afterwards).' : '.');
    } catch { /* user-jogu fiok: a meresi ido nem latszik */ }
    let fails = 0, oks = 1, lastErr = '';
    for (;;) {
      for (const s of now) if (!watch.base.has(s.id)) watch.base.set(s.id, s.value as number);   // kesobb megjeleno szenzor: innen indul
      watch.at = Date.now();
      const risen = now.filter(s => delta(s) >= need).sort((a, b) => delta(b) - delta(a));
      if (risen.length) {
        sensorWatch.delete(client.name);
        const best = risen[0], second = now.filter(s => s.id !== best.id).sort((a, b) => delta(b) - delta(a))[0];
        const L = [`Sensor ${best.id} is warming on ${client.name}:`,
          `  [${best.id}] ${best.name || '(unnamed)'}: ${fmt(watch.base.get(best.id)!)} -> ${fmt(best.value as number)} °C (+${fmt(delta(best))} °C in ${Math.round((Date.now() - watch.t0) / 1000)} s)`];
        if (second && delta(second) > delta(best) - 0.5) L.push(`  ! not unique: [${second.id}] ${second.name || '(unnamed)'} also rose by ${fmt(delta(second))} °C - the two sensors may be close to each other, or a heating circuit is warming; let them cool and repeat with reset=true`);
        else if (second) L.push(`  (the next largest change: [${second.id}] ${second.name || '(unnamed)'} ${delta(second) >= 0 ? '+' : ''}${fmt(delta(second))} °C)`);
        if (!best.name) L.push('  It has no name yet - name it with myio_rename kind=thermo.');
        return text(L.join('\n'));
      }
      if (Date.now() >= deadline) break;
      await sleep(Math.min(SENSOR_POLL_MS, Math.max(0, deadline - Date.now())));
      try { now = await read(); oks++; } catch (e) { if (!(e instanceof MyIOError)) throw e; fails++; lastErr = e.message; }
    }
    sensorWatch.set(client.name, watch);
    const top = [...now].sort((a, b) => delta(b) - delta(a)).slice(0, 5);
    const L = [`No sensor rose by ${fmt(need)} °C on ${client.name} in ${Math.round((Date.now() - watch.t0) / 1000)} s${resumed ? ' (continued from the earlier wait)' : ''}${fails ? `; ${fails} of ${fails + oks} readings failed (${lastErr})` : ''}.`,
      'Largest changes so far:', ...top.map(s => `  [${s.id}] ${s.name || '(unnamed)'}: ${fmt(watch.base.get(s.id) ?? (s.value as number))} -> ${fmt(s.value as number)} °C (${delta(s) >= 0 ? '+' : ''}${fmt(delta(s))} °C)`),
      'Call again to keep waiting (the starting temperatures are kept for 5 minutes).'];
    if (round) L.push(round);
    return text(L.join('\n'));
  });

  server.registerTool('myio_sensor_rescan', {
    title: 'Rescan the 1-Wire buses',
    description: 'Search the 1-Wire buses again for thermometers - after wiring a new sensor, or when one is missing from myio_read_sensors. Needs firmware 4.27+ (GIGA: the main buses; Opta: the AUX bus of the Ext16 expanders). '
      + 'The controller pauses for about 0.1 s per sensor while it searches. The reply lists the thermometers afterwards and marks the new and the missing ones. '
      + 'A new sensor gets the next free id and an empty name (name it with myio_rename kind=thermo); to learn which one it is, use myio_wait_sensor. Stored settings are not changed. Editor level.',
    inputSchema: { server: S },
    annotations: WR_SET,
  }, async ({ server: sv }) => {
    const g = gate(ctx, 'config'); if (g) return g;
    const client = reg.pick(sv);
    const v = await client.version();
    if (!(await client.supports(FEAT.owScan))) return fail(`${client.name}: the 1-Wire rescan needs firmware 4.27 or newer (this controller runs ${v}). On older firmware the main bus is only searched at restart; the Ext16 AUX bus can be rescanned with myio_expander_set onewire_rescan=true.`);
    // a figyeleshez a kis sens_out.json eleg (nevek nelkul); a neveket a vegen egyszer kerjuk (az uj szenzore meg ures)
    const list = async (names?: Awaited<ReturnType<MyIOClient['names']>>) => decodeSensors(await client.snapshot(), names).filter(s => s.kind === 'temperature');
    const before = await list(await client.names());
    await client.command('ow_scan=1');
    // a kereses a fociklusban fut (szenzoronkent ~100 ms), a bovito-panel a sajat utemeben valaszol: megvarjuk, amig a lista megall
    let after = before, stable = 0;
    for (let i = 0; i < 8 && stable < 2; i++) {
      await sleep(1500);
      const cur = await list();
      stable = cur.length === after.length && cur.every(s => after.some(a => a.id === s.id)) ? stable + 1 : 0;
      after = cur;
    }
    after = await list(await client.names(true));
    const was = new Set(before.map(s => s.id)), is = new Set(after.map(s => s.id));
    const line = (s: SensorReading, mark: string) => `  [${s.id}] ${s.name || '(unnamed)'}: ${s.value === null ? 'no valid reading yet' : s.raw === 8500 ? '85.0 °C (first measurement pending)' : `${s.value.toFixed(1)} °C`}${mark}`;
    const added = after.filter(s => !was.has(s.id)), gone = before.filter(s => !is.has(s.id));
    const L = [`${client.name}: 1-Wire rescan done - ${after.length} thermometer${after.length === 1 ? '' : 's'} (${added.length} new, ${gone.length} missing).`,
      ...after.map(s => line(s, was.has(s.id) ? '' : '   <- NEW'))];
    if (gone.length) L.push('No longer listed (a 1-Wire sensor: check its wiring - its id and name stay reserved; a thermometer fed over the network, e.g. BroadLink or myIO Link, comes back at its next update):', ...gone.map(s => line(s, '')));
    if (added.length) L.push('Name the new sensors with myio_rename kind=thermo; myio_wait_sensor tells which physical sensor is which.');
    return text(L.join('\n'));
  });

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
