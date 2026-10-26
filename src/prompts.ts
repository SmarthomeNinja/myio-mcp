/**
 * MCP prompts (MYIO_MCP_PLAN.md 4.7, 5. kor 2026-10-26), magyar es angol szoveggel (`language`, alap hu):
 *   heating_overview   fűtés-áttekintés: termosztat-zonak + homersekletek + MIA + SG-Ready
 *   why_not_switching  miért nem kapcsol X: allapot, jog, vedelem/csatolo, termosztat, idozitok, gombok, Flow, script, Link, MQTT, naplo
 *   daily_diagnostics  napi diagnosztika: sysdiag + ERROR-sorok + bovitok + NTP/ora (minden vezerlon, ha nincs `server`)
 *   new_flow_rule      vezetett Flow-szabaly: 10/D kartya-referencia + a meglevo szabalyok + az elemek ID-jai
 * A prompt az adatokat a hivaskor kiolvassa es beagyazza (eszkozhivas nelkul is teljes a kontextus); minden szakasz kulon
 * hibaturo ("not available: ..."). A szoveg csak az engedelyezett eszkozokre hivatkozik (MYIO_TOOLSETS).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import { MyIOClient } from './api.js';
import {
  Device, FEAT, baseId, decodeGlobals, decodeInputConfigs, decodeOutputConfigs, decodeSensors, decodeStructures, fmtDevice, fmtInputConfig, fmtOutputConfig,
  fmtSensor, fmtThermostat, fmtTimer, fmtUsens, nameMaps, normalizeName, num, parseTimerCsv, supports, targetText, vnum,
} from './model.js';
import { flowText, decodeFlowLive, flowTraceText, progText, FlowDef, FlowCard } from './model_auto.js';
import { fmtSysdiag, logLineLevel, yymmdd, RESET_CAUSE } from './model_diag.js';
import { flowReference } from './docs.js';
import { ToolContext, devices, usensOrEmpty, thermostatsOf } from './tools/common.js';
import { readFlows, flowTrace, flowNamer, flowLimits, readProg } from './tools/auto.js';
import { miaText, sgText } from './tools/integr.js';
import { expText } from './tools/bus.js';

type Lang = 'hu' | 'en';
type J = Record<string, unknown>;
const langOf = (l?: string): Lang => (l && /^en/i.test(l.trim()) ? 'en' : 'hu');
const now = () => new Date().toLocaleString('sv-SE');
const msg = (text: string, description?: string): GetPromptResult => ({ ...(description ? { description } : {}), messages: [{ role: 'user', content: { type: 'text', text } }] });

/** egy adatszakasz: a hiba nem bukik, hanem a szovegbe kerul; undefined = nem relevans (kimarad) */
async function section(title: string, fn: () => Promise<string | undefined>): Promise<string> {
  try { const t = await fn(); return t === undefined ? '' : `### ${title}\n${t.trim() || '(none)'}`; }
  catch (e) { return `### ${title}\n(not available: ${(e as Error).message})`; }
}
const joinSections = (parts: string[]) => parts.filter(Boolean).join('\n\n');

/** napi esemenynaplo sorai (a fw sajat keresesi sorrendjevel: belso flash, majd SD) */
async function logLines(c: MyIOClient, date?: string): Promise<{ day: string; lines: string[] }> {
  await c.require(FEAT.files, 'log files');
  const day = yymmdd(date, new Date());
  const body = await c.getText(`ev_log/e_${day}.csv`, { timeoutMs: 90_000 });
  return { day, lines: body.split(/\r?\n/).filter(l => l.trim()) };
}
/** a sor "forras,esemeny" kulcsa a szint es az idobelyeg utan (osszesiteshez) */
function logKey(line: string): { key: string; time: string } {
  const m = /^(?:[EID],)?(\d{4}\/\d{2}\/\d{2}) (\d{2}:\d{2}:\d{2}),(.*)$/.exec(line);
  if (!m) return { key: line.slice(0, 40), time: '' };
  const f = m[3].split(',');
  return { key: f.slice(0, 2).join(',').replace(/=.*$/, ''), time: m[2] };
}
const NOTABLE = /ERR|FAIL|STALL|REINIT|WATCHDOG|LOST|OFFLINE|DENY|UNAUTHORIZED|ABORT|REAP|MEMORY|BOOT|Not Authenticated|LINK-DOWN|SLOW/i;
const ERRWORD = /ERR|FAIL|WATCHDOG|STALL|DEAD/i;
/** hiba-sor: a szintes sor (4.x, ujabb Due) a szintje szerint, a szint nelkuli (regi Due) kulcsszo szerint - egy fajlban vegyes is lehet */
const isErrLine = (l: string) => { const lv = logLineLevel(l); return lv ? lv === 'E' : ERRWORD.test(l); };
function logDigest(lines: string[]): string {
  const errors = lines.filter(isErrLine);
  const errSet = new Set(errors);
  const notable = lines.filter(l => !errSet.has(l) && NOTABLE.test(l));
  const pick = new Set([...errors, ...notable]);
  const groups = new Map<string, { n: number; first: string; last: string }>();
  for (const l of lines) { if (!pick.has(l)) continue; const { key, time } = logKey(l); const g = groups.get(key); if (g) { g.n++; g.last = time; } else groups.set(key, { n: 1, first: time, last: time }); }
  const lv = { E: 0, I: 0, D: 0 } as Record<string, number>;
  for (const l of lines) { const x = logLineLevel(l); if (x) lv[x]++; }
  const leveled = lv.E + lv.I + lv.D;
  const L = [`${lines.length} lines${leveled ? ` (${lv.E} error, ${lv.I} info, ${lv.D} debug${leveled < lines.length ? `, ${lines.length - leveled} without level` : ''})` : ''}; ${errors.length} error line(s), ${notable.length} other notable line(s)`];
  if (groups.size) L.push('grouped in file order (count, first..last): ' + [...groups.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 20).map(([k, g]) => `\n  ${k}: ${g.n}x ${g.first}${g.n > 1 ? `..${g.last}` : ''}`).join(''));
  if (errors.length) L.push(`error lines (last ${Math.min(40, errors.length)}):\n` + errors.slice(-40).join('\n'));
  if (notable.length) L.push(`other notable lines (last ${Math.min(30, notable.length)}):\n` + notable.slice(-30).join('\n'));
  return L.join('\n');
}

/** a vezerlo ora vs ennek a gepnek az oraja (a /setup var-blokk percre pontos) */
async function clockText(c: MyIOClient): Promise<string> {
  const g = decodeGlobals(await c.setupVars(true));
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(g.clock);
  const host = new Date();
  let drift = '';
  if (m) {
    const ctrl = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    const min = Math.round((ctrl.getTime() - new Date(host.getFullYear(), host.getMonth(), host.getDate(), host.getHours(), host.getMinutes()).getTime()) / 60_000);
    drift = `; difference to this computer (${host.toLocaleString('sv-SE').slice(0, 16)}): ${min === 0 ? 'none (within a minute)' : `${min > 0 ? '+' : ''}${min} min${Math.abs(min) >= 2 ? ' - CHECK (NTP / time zone / DST)' : ''}`}`;
  }
  const dst = g.dstAuto === undefined ? 'no automatic DST in this firmware (time zone = full offset)' : g.dstAuto ? `automatic EU DST on, now ${g.dstNow ? 'summer' : 'standard'} time` : 'automatic DST off';
  return `controller clock ${g.clock}${drift}\ntime zone UTC${g.timeZone >= 0 ? '+' : ''}${g.timeZone} (${dst}); sunrise ${g.sunrise}, sunset ${g.sunset}`;
}

export function registerPrompts(server: McpServer, ctx: ToolContext): void {
  const { reg } = ctx;
  const has = (t: string) => !ctx.tools || ctx.tools.has(t);
  const tl = (t: string, s: string) => (has(t) ? s : '');
  const serverArg = completable(z.string().optional().describe(`controller (${reg.names.join(' | ')}); default: ${reg.names.length > 1 ? 'all / the first' : reg.names[0]}`),
    v => reg.names.filter(n => normalizeName(n).startsWith(normalizeName(v ?? ''))));
  const langArg = completable(z.string().optional().describe('hu (default) | en'), v => ['hu', 'en'].filter(x => x.startsWith((v ?? '').toLowerCase())));
  const targets = (sv?: string): MyIOClient[] => (sv && sv.trim() ? [reg.pick(sv)] : reg.clients);

  // ===================================================== FŰTÉS-ÁTTEKINTÉS ==================================================
  server.registerPrompt('heating_overview', {
    title: 'Fűtés-áttekintés · Heating overview',
    description: 'Thermostat zones, temperatures, MIA (self-learning heating) and SG-Ready of the controller(s), read now - with a request to summarise them and flag problems. / Termosztát-zónák, hőfokok, MIA és SG-Ready áttekintése.',
    argsSchema: { server: serverArg, language: langArg },
  }, async ({ server: sv, language }) => {
    const L = langOf(language);
    const blocks: string[] = [];
    for (const c of targets(sv)) {
      const v = await c.version().catch(() => '');
      blocks.push(`## ${c.name} (${c.origin}, firmware ${v || '?'})\n` + joinSections([
        await section('Thermostat zones and sensor-controlled outputs', async () => { const th = await thermostatsOf(c); return th.length ? th.map(fmtThermostat).join('\n') : 'no sensor-controlled output'; }),
        await section('Temperatures and humidity', async () => {
          const { live, names } = await devices(c);
          const s = decodeSensors(live, names).filter(x => x.kind === 'temperature' || (x.kind === 'humidity' && (x.name || x.value)));   // a nevtelen 0 %-os para-csatorna zaj
          const u = (await usensOrEmpty(c)).filter(x => [1, 2, 4].includes(x.type) && (x.enabled || x.name));
          return [...s.map(fmtSensor), ...u.map(fmtUsens)].join('\n') || 'no temperature sensor';
        }),
        supports(v, FEAT.mia) ? await section('MIA (self-learning heating layer)', () => miaText(c)) : '',
        supports(v, FEAT.mia) ? await section('MIA events in today\'s event log', async () => { const { lines } = await logLines(c); const a = lines.filter(l => /,AI,/.test(l)); return a.length ? a.slice(-20).join('\n') : 'none today'; }) : '',
        supports(v, FEAT.sgready) ? await section('SG-Ready heat pump', async () => sgText(c, await c.pageVars('sg', 'sg_en'))) : '',
      ]));
    }
    const ask = L === 'hu'
      ? `Készíts fűtés-áttekintést az alábbi, most (${now()}) kiolvasott myIO-adatokból. Zónánként: név, aktuális hőfok, cél és sáv, fűt-e most. `
        + 'Jelöld, ha a hőfok a sávon kívül van, ha a szenzor érvénytelen vagy STALE, ha nyitott ablakot jeleztek (MIA), vagy ha egy zóna feltűnően sokat fűt (24 órás kitöltés). '
        + 'Ha van MIA: foglald össze, mit tanult (fűtési és hűlési ütem, holtidő, túllövés, megbízhatóság) és mi a következő előfűtés. Ha van SG-Ready, írd le a hőszivattyú módját. '
        + 'A végén legfeljebb 3 konkrét javaslat. Semmit ne módosíts magadtól' + tl('myio_set_thermostat', ': ha cél- vagy sávváltás kellene, kérdezz rá, és csak jóváhagyás után használd a myio_set_thermostat eszközt') + '. Válaszolj magyarul, tömören.'
      : `Write a heating overview from the myIO data below, read just now (${now()}). Per zone: name, current temperature, target and band, heating now or not. `
        + 'Flag zones outside their band, invalid or STALE sensors, open-window detections (MIA) and zones heating conspicuously much (24 h duty). '
        + 'If MIA is present, summarise what it learned (heat / cool rate, dead time, overshoot, confidence) and the next preheating. If SG-Ready is present, state the heat pump mode. '
        + 'End with at most 3 concrete suggestions. Do not change anything on your own' + tl('myio_set_thermostat', ': if a target or band should change, ask first and use myio_set_thermostat only after approval') + '. Answer in English, concisely.';
    return msg(`${ask}\n\n${blocks.join('\n\n')}`, L === 'hu' ? 'Fűtés-áttekintés' : 'Heating overview');
  });

  // ===================================================== MIÉRT NEM KAPCSOL X ===============================================
  server.registerPrompt('why_not_switching', {
    title: 'Miért nem kapcsol X? · Why does X not switch?',
    description: 'Collects everything that decides whether an output switches - state, account level, configuration, protection / joiner pairs, thermostat control, timers, buttons, Flow rules, scripts, myIO Link, MQTT, SG-Ready, event log - and asks for the most likely cause. / Mindent összegyűjt, ami egy kimenet kapcsolását befolyásolja.',
    argsSchema: {
      element: completable(z.string().describe('output name (or a part of it) or id, e.g. "nappali lámpa" or 2033'), async (v, c) => {
        try { const cl = targets(c?.arguments?.server)[0]; const { list } = await devices(cl); const q = normalizeName(v ?? ''); return list.filter(d => d.name && normalizeName(d.name).includes(q)).slice(0, 20).map(d => d.name); } catch { return []; }
      }),
      server: serverArg, language: langArg,
    },
  }, async ({ element, server: sv, language }) => {
    const L = langOf(language);
    const q = element.trim();
    const isId = /^\d+$/.test(q);
    // a vezerlo: a megadott, vagy amelyiken a nev egyertelmuen megvan
    let client: MyIOClient | undefined; let dev: Device | undefined; const candidates: { c: MyIOClient; d: Device }[] = [];
    // ID-nel az alap-vezerlo (mint az eszkozoknel), nevnel minden vezerlon keresunk
    for (const c of isId ? [sv && sv.trim() ? reg.pick(sv) : reg.clients[0]] : targets(sv)) {
      try {
        const { list } = await devices(c);
        if (isId) { const d = list.find(x => x.id === baseId(+q)); if (d) candidates.push({ c, d }); continue; }
        const nq = normalizeName(q);
        const exact = list.filter(d => d.name && normalizeName(d.name) === nq);
        const part = exact.length ? exact : list.filter(d => d.name && normalizeName(d.name).includes(nq));
        candidates.push(...part.map(d => ({ c, d })));
      } catch { /* elerhetetlen vezerlo: kihagyjuk */ }
    }
    if (candidates.length === 1) { client = candidates[0].c; dev = candidates[0].d; }
    if (!client || !dev) {
      const list = candidates.slice(0, 25).map(x => `  ${x.c.name}: ${fmtDevice(x.d)}`).join('\n');
      const t = L === 'hu'
        ? (candidates.length ? `A(z) „${q}” több kimenetre illik — kérdezd meg a usert, melyikre gondolt, majd indítsd újra ezt az elemzést az ID-val:\n${list}` : `Nem találtam „${q}” nevű vagy ID-jű kimenetet${sv ? ` a(z) ${sv} vezérlőn` : ''}. Kérdezd meg a usert a pontos névről${tl('myio_find', ' (keresés: myio_find)')}. Lehet az is, hogy ennek a fióknak nincs olvasási joga rá (a jog nélküli elem kimarad a JSON-ból).`)
        : (candidates.length ? `"${q}" matches several outputs - ask the user which one, then run this analysis again with the id:\n${list}` : `No output named or numbered "${q}"${sv ? ` on ${sv}` : ''}. Ask the user for the exact name${tl('myio_find', ' (search: myio_find)')}. The account may also lack read permission for it (elements without permission are absent from the JSON).`);
      return msg(t);
    }
    const c = client, d = dev, id = d.id;
    const v = await c.version();
    const set = await devices(c);
    const groupsOf = set.list.filter(g => g.type === 'group' && (g.members ?? []).some(m => baseId(m) === id)).map(g => g.id);
    const ids = new Set([id, ...groupsOf]);
    const vb = await c.setupVars(true).catch(() => undefined);
    const n = vb ? nameMaps(vb) : undefined;
    const tgt = (x: number) => (n ? targetText(x, n) : `[${x}]`);
    // naplo-illesztes: kapcsolo-parancs erre az elemre (vagy a csoportjara), a ra kotott gomb, a ra hato Flow / script sorai, a neve
    const idAlt = [...ids].join('|');
    const cmdRe = new RegExp(`(?:^|[,&?:/])(?:r_ON|r_OFF|r_INV|PCA_ON|PCA_OFF|PCA_INV|f_ON|f_OFF|f_INV|g_ON|g_OFF|g_INV)[=,](?:${idAlt})(?![0-9])|(?:PCA|fet)\\*(?:${idAlt})=`, 'i');
    const rel = { inputs: [] as number[], flows: [] as number[], progs: [] as number[] };
    const data = joinSections([
      await section('The element now', async () => `${fmtDevice(d)}${d.type === 'group' ? '' : groupsOf.length ? `\nmember of group(s): ${groupsOf.map(g => fmtDevice(set.list.find(x => x.id === g)!)).join('; ')}` : ''}`),
      await section('This account', async () => { const { info } = await c.info(); const r = num(info.right, -1); return `permission level right=${info.right ?? 'unknown'} (${['admin', 'editor', 'user'][r] ?? 'old firmware'}). A command without write permission is silently dropped by the controller.${r === 2 ? ' A plain user cannot switch groups and needs a write permission for each element.' : ''}`; }),
      await section('Output configuration', async () => { if (!vb) throw new Error('the settings page is not readable (editor level needed)'); const oc = decodeOutputConfigs(vb).find(x => x.id === id); return oc ? fmtOutputConfig(oc) : undefined; }),
      await section('Thermostat / sensor control', async () => {
        if (!d.sensor) return 'not sensor-controlled';
        const t = (await thermostatsOf(c)).find(x => x.id === id);
        return `${t ? fmtThermostat(t) : `sensor ${d.sensor}`}\nThe controller switches this output itself from the sensor: manual commands are overwritten at the next sensor check, and scripts are refused for it (trace "thermostat-controlled output").`;
      }),
      await section('Protection pairs, joiners, groups', async () => {
        if (!vb) throw new Error('the settings page is not readable (editor level needed)');
        const st = decodeStructures(vb); const g = decodeGlobals(vb); const out: string[] = [];
        for (const p of st.protection.filter(p => baseId(p.up) === id || baseId(p.down) === id)) {
          const other = baseId(p.up) === id ? p.down : p.up; const od = set.list.find(x => x.id === baseId(other));
          out.push(`protection pair #${p.index}: UP ${tgt(p.up)} / DOWN ${tgt(p.down)}${p.priority ? ' [priority: first wins]' : ''} - the other member is now ${od ? (od.on ? 'ON (blocks this one)' : 'OFF') : '?'}${g.protCooldown ? `; direction-change cooldown ${g.protCooldown} s` : ''}`);
        }
        for (const j of st.joiner.filter(j => baseId(j.master) === id || baseId(j.slave) === id)) out.push(`joiner #${j.index}: ${tgt(j.master)} -> ${tgt(j.slave)}${j.justOn ? ' [justOn]' : ''} (${baseId(j.master) === id ? 'this is the master: it also switches the slave' : 'this is the slave: the master switches it'})`);
        for (const gr of st.groups.filter(gr => ids.has(gr.id))) out.push(`group [${gr.id}] ${gr.name || ''}: ${gr.members.map(tgt).join(', ')}${gr.pullUp ? ' [pullUp]' : ''}`);
        return out.join('\n') || 'none';
      }),
      await section('Timers that switch it (or load a scene)', async () => {
        const timers = parseTimerCsv(await c.timerCsv());
        const evTarget = (e: number) => ([2, 3, 4, 5, 6, 7, 15, 16].includes(e) ? 'out' : [1, 8, 9, 10, 11, 12, 13, 14, 17].includes(e) ? 'scene' : '');
        const hit = timers.filter(t => (evTarget(t.event) === 'out' && ids.has(baseId(t.param))) || evTarget(t.event) === 'scene');
        return hit.length ? hit.map(t => `${evTarget(t.event) === 'out' ? 'switches it' : 'loads a scene (may change it)'}: ${n ? fmtTimer(t, n) : JSON.stringify(t)}`).join('\n') : 'none';
      }),
      await section('Wall buttons bound to it', async () => {
        if (!vb) throw new Error('the settings page is not readable');
        const ic = decodeInputConfigs(vb).filter(x => ids.has(baseId(x.hit)) || ids.has(baseId(x.press)) || ids.has(baseId(x.release)));
        rel.inputs = ic.map(x => x.id);
        return ic.length ? ic.map(x => fmtInputConfig(x, n!)).join('\n') : 'none';
      }),
      supports(v, FEAT.flow) ? await section('Flow rules that read or write it', async () => {
        const { file } = await readFlows(c);
        const refs = (f: FlowDef) => [f.when, ...(f.and ?? []), ...(f.then ?? [])].some((k?: FlowCard) => !!k && ['out', 'rel', 'grp', 'pca', 'fet'].includes(k.t) && ids.has(baseId(num(k.id))));
        const fl = (file.flows ?? []).filter(refs);
        rel.flows = fl.map(f => f.id);
        if (!fl.length) return 'none';
        const tr = await flowTrace(c).catch(() => undefined); const live = decodeFlowLive(tr?.flows); const { namer } = await flowNamer(c, file);
        const names = new Map(fl.map(f => [f.id, f.name ?? '']));
        const rows = (tr?.trace ?? []).filter(r => names.has(Number(r[1]))).slice(0, 12);
        return fl.map(f => flowText(f, namer, live.get(f.id))).join('\n') + (rows.length ? '\nrecent trace:\n' + rows.map(r => '  ' + flowTraceText(r, num(tr?.up), names)).join('\n') : '');
      }) : '',
      supports(v, FEAT.script) ? await section('Scripts that use it', async () => {
        const p = await readProg(c);
        const re = new RegExp(`\\b(on|off|toggle|set|pca|out|remain)\\s*\\(\\s*(${id}\\b${d.name ? `|"${d.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"` : ''})`, 'i');
        const out: string[] = [];
        for (const s of (p.progs ?? []).filter(x => x.st)) {
          const src = await c.getText(`~q/prog/${s.id}.txt`).catch(() => '');
          const lines = src.split(/\r?\n/).map((l, i) => ({ l, i: i + 1 })).filter(x => re.test(x.l));
          if (lines.length) rel.progs.push(s.id);
          if (lines.length) out.push(`${progText(s, false)}\n` + lines.slice(0, 8).map(x => `  ${String(x.i).padStart(4)} | ${x.l.trim()}`).join('\n'));
        }
        return out.join('\n') || 'none';
      }) : '',
      supports(v, FEAT.link) ? await section('myIO Link (a remote controller drives it)', async () => {
        const j = (await c.getJson<{ link: J }>('link.json')).link ?? {};
        const l = Object.entries((j.links ?? {}) as Record<string, J>).filter(([, x]) => num(x.loc) === id);
        return l.length ? l.map(([k, x]) => `link ${k}: local ${x.loc} <- server ${x.srv} remote ${x.rem}${num(x.mir) ? ' (mirror)' : ''}${num(x.dis) ? ', DISABLED' : ''}`).join('\n') : 'none';
      }) : '',
      supports(v, FEAT.mqtt) ? await section('MQTT control', async () => {
        const m = await c.pageVars('mqtt', 'mq_en');
        return `client ${vnum(m, 'mq_en') ? 'enabled' : 'disabled'}; control from MQTT (subscribe) ${vnum(m, 'mq_sub') ? 'ON - Home Assistant or another MQTT client may switch outputs' : 'off'}; command channel ${vnum(m, 'mq_cmd') ? 'ON' : 'off'}`;
      }) : '',
      supports(v, FEAT.sgready) ? await section('SG-Ready contacts', async () => { const s = await c.pageVars('sg', 'sg_en'); const k = [vnum(s, 'sg_k1'), vnum(s, 'sg_k2')]; return k.includes(id) ? sgText(c, s) + '\nThis output is an SG-Ready contact: the SG mode drives it.' : 'not an SG-Ready contact'; }) : '',
      await section('Today\'s event log lines that may concern it', async () => {
        const { lines } = await logLines(c);
        const nm = d.name ? normalizeName(d.name) : '';
        const inRe = rel.inputs.length ? new RegExp(`INPUTevent,(?:${rel.inputs.join('|')}),`) : undefined;
        const flRe = rel.flows.length ? new RegExp(`,Flow,(?:${rel.flows.join('|')}),`) : undefined;
        const pgRe = rel.progs.length ? new RegExp(`,Prog,(?:${rel.progs.join('|')}),`) : undefined;
        const hit = lines.filter(l => cmdRe.test(l) || inRe?.test(l) || flRe?.test(l) || pgRe?.test(l) || (nm && normalizeName(l).includes(nm)));
        return hit.length ? hit.slice(-30).join('\n') : `none of ${lines.length} lines today: no switching command for [${[...ids].join(', ')}], no line of its buttons / Flow rules / scripts${d.name ? `, no "${d.name}"` : ''}`;
      }),
    ]);
    const ask = L === 'hu'
      ? `Derítsd ki, miért nem kapcsol (vagy miért kapcsol magától) ez a kimenet: ${d.type} [${id}] „${d.name}” a(z) ${c.name} vezérlőn. Az adatok most (${now()}) lettek kiolvasva. `
        + 'Gondold végig sorban: jogosultság (a jog nélküli parancsot a vezérlő csendben eldobja), védelem-pár (a másik tag be van-e kapcsolva, irányváltási cooldown), csatoló, '
        + 'termosztát-aktivátor (a szabályzó visszaírja), időzítők és jelenet-betöltések, gombok, Flow-szabályok és scriptek, myIO Link, MQTT, SG-Ready, offline bővítő, '
        + 'kimenet-időzítő / késleltetés, invert / justOn, PWM vagy kapcsoló mód és MIN/MAX. Mondd meg a legvalószínűbb okot a bizonyítékkal (melyik adatsor), és egy ellenőrző lépést. '
        + 'Ha próbakapcsolás kellene' + tl('myio_output', ' (myio_output)') + ', előbb kérdezd meg a usert. Válaszolj magyarul.'
      : `Find out why this output does not switch (or switches by itself): ${d.type} [${id}] "${d.name}" on ${c.name}. The data was read just now (${now()}). `
        + 'Go through: permission (the controller silently drops a command without permission), protection pair (is the other member on, direction-change cooldown), joiner, '
        + 'thermostat activator (the controller overwrites manual commands), timers and scene loads, wall buttons, Flow rules and scripts, myIO Link, MQTT, SG-Ready, offline expander, '
        + 'output timer / delay, invert / justOn, PWM vs switch mode and MIN/MAX. Name the most likely cause with its evidence (which data line) and one verification step. '
        + 'If a test switch is needed' + tl('myio_output', ' (myio_output)') + ', ask the user first. Answer in English.';
    return msg(`${ask}\n\n## ${c.name} (${c.origin}, firmware ${v})\n${data}`, L === 'hu' ? `Miért nem kapcsol: ${d.name || id}` : `Why not switching: ${d.name || id}`);
  });

  // ===================================================== NAPI DIAGNOSZTIKA =================================================
  server.registerPrompt('daily_diagnostics', {
    title: 'Napi diagnosztika · Daily diagnostics',
    description: 'Health check of every controller (or one): sysdiag (resets, RAM, sockets, link/WiFi), the day\'s ERROR and notable event-log lines grouped, RS485 expanders, clock / NTP / DST, Flow and script errors. / Rendszer-egészség, hibasorok, bővítők, óra.',
    argsSchema: { server: serverArg, date: z.string().optional().describe('today (default) | yesterday | YYYY-MM-DD'), language: langArg },
  }, async ({ server: sv, date, language }) => {
    const L = langOf(language);
    const blocks = await Promise.all(targets(sv).map(async c => {
      let v = '';
      try { v = await c.version(); } catch (e) { return `## ${c.name} (${c.origin})\nUNREACHABLE: ${(e as Error).message}`; }
      const v4 = /^4\./.test(v);
      return `## ${c.name} (${c.origin}, firmware ${v})\n` + joinSections([
        await section('Controller', async () => { const { info } = await c.info(true); return `${info.uptime !== undefined ? `uptime ${info.uptime} s, ` : ''}last reset: ${RESET_CAUSE[num(info.reset_cause, -1)] ?? info.reset_cause ?? '?'}${info.qhealth !== undefined ? `, settings storage ${num(info.qhealth) ? 'writable' : 'NOT WRITABLE'}` : ''}${info.exp_q !== undefined ? `, RS485 expanders configured ${info.exp_q}, online ${JSON.stringify(info.exp_online ?? [])}` : ''}${info.pca_online !== undefined ? `, I2C PCA online ${JSON.stringify(info.pca_online)}` : ''}`; }),
        await section('System diagnostics (sysdiag)', async () => { await c.require(FEAT.sysdiag, 'sysdiag.json'); return fmtSysdiag(await c.getJson<J>('sysdiag.json'), v4); }),
        await section('Clock, NTP, daylight saving', () => clockText(c)),
        await section(`Event log ${date ?? 'today'}`, async () => { const { day, lines } = await logLines(c, date); return `ev_log/e_${day}.csv\n${logDigest(lines)}`; }),
        supports(v, FEAT.expanders) ? await section('RS485 expanders', async () => { const { info } = await c.info(); return num(info.exp_q) ? expText(c) : undefined; }) : '',
        supports(v, FEAT.flow) ? await section('Flow engine', async () => { const t = await flowTrace(c); return `${t.n ?? 0}/${t.max ?? '?'} rules loaded, fired ${t.fired ?? 0}x${t.err ? `, ${t.err} PARSE ERROR(S) (last bad rule ${t.errflow}) - that rule is disabled` : ', no parse errors'}, lost events ${t.evdrop ?? 0}, budget overruns ${t.overrun ?? 0}`; }) : '',
        supports(v, FEAT.script) ? await section('Scripts', async () => { const p = await readProg(c); const bad = (p.progs ?? []).filter(x => x.st === 3 || (x.ovr ?? 0) > 0 || (x.drops ?? 0) > 0); return `${p.n ?? 0} of ${p.max} slots used` + (bad.length ? '\n' + bad.map(x => progText(x, false)).join('\n') : ', no errors, overruns or dropped commands'); }) : '',
      ]);
    }));
    const ask = L === 'hu'
      ? `Napi diagnosztika a myIO-vezérlő(k)ről (${now()}, ${date ?? 'mai nap'}). Vezérlőnként adj zöld / sárga / piros minősítést indoklással. `
        + 'Nézd: újraindulások és okuk (WATCHDOG = piros), a legkisebb szabad RAM, beragadt socketek, LAN-link/WiFi, a hibasorok csoportosítva (mi, hányszor, első–utolsó időpont), '
        + 'offline bővítők, az óra eltérése és az NTP (≥ 2 perc eltérés vagy válasz nélküli NTP = sárga), Flow-/script-hibák. A végén a teendők fontossági sorrendben. '
        + 'Semmit ne módosíts; ha egy hibasor részletei kellenek' + tl('myio_log', ', a myio_log eszközzel olvass bele') + '. Válaszolj magyarul.'
      : `Daily diagnostics of the myIO controller(s) (${now()}, ${date ?? 'today'}). Rate each controller green / yellow / red with reasons. `
        + 'Check: restarts and their cause (WATCHDOG = red), minimum free RAM, stuck sockets, LAN link / WiFi, the error lines grouped (what, how often, first-last time), '
        + 'offline expanders, clock drift and NTP (>= 2 min drift or NTP without answer = yellow), Flow / script errors. End with the to-dos in order of importance. '
        + 'Do not change anything; if an error line needs details' + tl('myio_log', ', read around it with myio_log') + '. Answer in English.';
    return msg(`${ask}\n\n${blocks.join('\n\n')}`, L === 'hu' ? 'Napi diagnosztika' : 'Daily diagnostics');
  });

  // ===================================================== ÚJ FLOW-SZABÁLY ===================================================
  server.registerPrompt('new_flow_rule', {
    title: 'Új Flow-szabály · New Flow rule',
    description: 'Guided creation of a Flow rule (GIGA/Opta 4.4+): embeds the card reference (10/D), the existing rules and the ids of outputs and sensors, then walks through clarify -> draft -> dry run -> approval -> save. / Vezetett Flow-szabály-készítés.',
    argsSchema: { rule: z.string().optional().describe('what the rule should do, in plain words (e.g. "turn the hall light on at sunset on weekdays")'), server: serverArg, language: langArg },
  }, async ({ rule, server: sv, language }) => {
    const L = langOf(language);
    const c = sv && sv.trim() ? reg.pick(sv) : (await (async () => { for (const x of reg.clients) if (supports(await x.version().catch(() => ''), FEAT.flow)) return x; return reg.clients[0]; })());
    const v = await c.version();
    if (!supports(v, FEAT.flow)) return msg(L === 'hu' ? `A(z) ${c.name} (firmware ${v}) nem tud Flow-szabályt (GIGA/Opta 4.4+ kell). Mondd ezt el a usernek; időzítővel vagy gomb-hozzárendeléssel esetleg megoldható.` : `${c.name} (firmware ${v}) has no Flow engine (GIGA/Opta 4.4+ needed). Tell the user; a timer or a button binding may do instead.`);
    const data = joinSections([
      await section('Existing rules, variables, webhooks', async () => {
        const { file } = await readFlows(c);
        const tr = await flowTrace(c).catch(() => undefined); const live = decodeFlowLive(tr?.flows); const { namer } = await flowNamer(c, file);
        const used = (file.flows ?? []).map(f => f.id);
        const lim = await flowLimits(c);
        return [`${used.length} rule(s); used ids: ${used.join(', ') || 'none'}; limits: RQ=${lim.rq}, PCAQ=${lim.pcaq}, SENQ=${lim.senq}`,
          ...(file.flows ?? []).map(f => flowText(f, namer, live.get(f.id))),
          (file.vars ?? []).length ? 'variables: ' + file.vars!.map(x => `var${x.id} "${x.name ?? ''}" init ${x.init ?? 0}`).join(', ') : 'no named variables',
          (file.hooks ?? []).length ? 'webhooks: ' + file.hooks!.map(h => `#${h.id} "${h.name ?? ''}"`).join(', ') : 'no webhooks'].join('\n');
      }),
      await section('Outputs (id, name, state)', async () => { const { list } = await devices(c); return list.filter(d => d.name).map(d => `${d.type} ${fmtDevice(d)}`).join('\n') || 'no named outputs'; }),
      await section('Sensors (thermo ch = 1-Wire id, hum ch = humidity id - 101, usens id)', async () => {
        const { live, names } = await devices(c);
        return [...decodeSensors(live, names).map(fmtSensor), ...(await usensOrEmpty(c)).filter(u => u.enabled || u.name).map(fmtUsens)].join('\n') || 'none';
      }),
      await section('Flow card reference (API_REFERENCE 10/D)', async () => flowReference() || undefined),
    ]);
    const want = rule?.trim();
    const steps = L === 'hu'
      ? `${want ? `A user ezt a Flow-szabályt kéri a(z) ${c.name} vezérlőn: „${want}”.` : `A user új Flow-szabályt szeretne a(z) ${c.name} vezérlőn — először kérdezd meg, mit csináljon.`}\n`
        + 'Vezesd végig így: 1) ha nem egyértelmű (melyik kimenet vagy szenzor, időpont, napok, küszöb, hiszterézis, késleltetés), kérdezz vissza röviden; '
        + '2) állítsd össze a szabály JSON-ját a lenti 10/D kártya-formátum szerint, szabad id-vel (hőfok ×10, napmaszk bit0 = hétfő); '
        + (has('myio_flow_save') ? '3) ellenőrizd: myio_flow_save flow=<JSON> dry_run=true, és javítsd a hibákat; 4) mutasd meg a usernek köznyelven, mit fog csinálni; 5) csak jóváhagyás után mentsd (dry_run nélkül)'
          + (has('myio_flow_trace') ? ', majd nézd meg a myio_flows / myio_flow_trace eszközzel, hogy betöltődött-e' : '') + '.' : '3) mutasd meg a usernek köznyelven és JSON-ként (a mentő eszköz ebben a szerver-beállításban nincs bekapcsolva: MYIO_TOOLSETS automation).')
        + ' Válaszolj magyarul.'
      : `${want ? `The user asks for this Flow rule on ${c.name}: "${want}".` : `The user wants a new Flow rule on ${c.name} - first ask what it should do.`}\n`
        + 'Guide it like this: 1) if anything is ambiguous (which output or sensor, time, days, threshold, hysteresis, delay), ask briefly; '
        + '2) build the rule JSON in the 10/D card format below with a free id (temperatures x10, day mask bit0 = Monday); '
        + (has('myio_flow_save') ? '3) validate: myio_flow_save flow=<JSON> dry_run=true, fix any error; 4) explain to the user in plain words what it will do; 5) save only after approval (without dry_run)'
          + (has('myio_flow_trace') ? ', then check with myio_flows / myio_flow_trace that it loaded' : '') + '.' : '3) show it to the user in plain words and as JSON (the saving tool is not enabled in this server configuration: MYIO_TOOLSETS automation).')
        + ' Answer in English.';
    return msg(`${steps}\n\n## ${c.name} (${c.origin}, firmware ${v}) - read ${now()}\n${data}`, L === 'hu' ? 'Új Flow-szabály' : 'New Flow rule');
  });
}
