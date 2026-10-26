/**
 * MCP resources (MYIO_MCP_PLAN.md 4.7, 5. kor 2026-10-26). A kliens (pl. Claude Desktop) ezeket kontextuskent csatolhatja,
 * eszkozhivas nelkul:
 *   myio://<vezerlo>/info        info.json + a verziobol szamolt kepesseg-terkep (JSON)
 *   myio://<vezerlo>/state       dekodolt allapot: kimenetek, szenzorok, bemenetek, univerzalis szenzorok (JSON, valos egysegekben)
 *   myio://<vezerlo>/flows.jsn   a Flow-szabalyok fajlja [4.4+]
 *   myio://{vezerlo}/prog/{n}.txt   egy script forrasa [4.10+]                 (sablon)
 *   myio://{vezerlo}/log/{datum}    egy nap esemenynaploja (today | yesterday | YYYY-MM-DD | YYMMDD)  (sablon)
 *   myio://docs/index | /script | /flow | /chapter/<id> | /search/{cimszo}   a csomagolt API_REFERENCE.md (magyar)
 * A <vezerlo> a nev URI-biztos alakja (servers.ts slugOf: "Földszint" -> "foldszint").
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { MyIOClient, MyIOError } from './api.js';
import { FEAT, MinVersion, supports, decodeSensors, decodeInputs, levelToPercent } from './model.js';
import { yymmdd } from './model_diag.js';
import { apiReference, docChapters, scriptReference, flowReference, searchHeadings, headingList } from './docs.js';
import { ToolContext, devices, usensOrEmpty } from './tools/common.js';
import { readFlows } from './tools/auto.js';

const LOG_MAX = 256 * 1024;   // a resource egy napi naplobol legfeljebb ennyit ad (a vege a fontos)

/** info.json + kepesseg-terkep */
export async function infoDoc(c: MyIOClient): Promise<Record<string, unknown>> {
  const { info } = await c.info(true);
  const v = String(info.version ?? '');
  const features = Object.fromEntries(Object.entries(FEAT).map(([k, m]) => [k, supports(v, m as MinVersion)]));
  return { server: c.name, url: c.origin, read_at: new Date().toISOString(), ...info, features };
}

/** a ház pillanatnyi allapota valos egysegekben (a nevtelen, kikapcsolt kimenetek csak darabszamkent) */
export async function stateDoc(c: MyIOClient): Promise<Record<string, unknown>> {
  const v = await c.version();
  const withInputs = supports(v, FEAT.inputs);
  const { list, live, names } = await devices(c, withInputs);
  const outputs = list.filter(d => d.name || d.on || d.type === 'group').map(d => ({
    id: d.id, type: d.type, name: d.name, on: d.on,
    ...(d.level !== undefined && d.type !== 'relay' ? { level: d.level, percent: levelToPercent(d.level) } : {}),
    ...(d.type === 'pca' && d.pwm === false ? { switch_mode: true } : {}),
    ...(d.members ? { members: d.members } : {}),
    ...(d.timerRemain !== undefined ? { auto_off_in_s: d.timerRemain } : {}),
    ...(d.delayRemain !== undefined ? { turns_on_in_s: d.delayRemain } : {}),
    ...(d.sensor ? { sensor: d.sensor, on_threshold: d.sensorON! / 10, off_threshold: d.sensorOFF! / 10 } : {}),
    ...(d.roles?.length ? { roles: d.roles } : {}),
    ...(d.offline ? { expander_offline: true } : {}),
  }));
  const sensors = decodeSensors(live, names).map(s => ({ id: s.id, kind: s.kind, name: s.name, value: s.value, unit: s.unit, ...(s.offline ? { expander_offline: true } : {}), ...(s.active === false ? { inactive: true } : {}) }));
  const inputs = withInputs ? decodeInputs(live, names).filter(i => i.name || i.on).map(i => ({ id: i.id, name: i.name, closed: i.on, ...(i.enabled === false ? { disabled: true } : {}) })) : undefined;
  const usens = (await usensOrEmpty(c)).filter(u => u.enabled || u.name).map(u => ({ id: u.id, name: u.name, type: u.typeName, value: u.state === 'none' ? null : u.value, unit: u.unit, state: u.state, ...(u.state === 'stale' ? { age_s: u.age } : {}) }));
  return {
    server: c.name, firmware: v, read_at: new Date().toISOString(),
    note: 'ids: relay 1.., FET 101.., group 501.., PCA 2001..; level 0..255; unnamed outputs that are OFF are omitted',
    outputs, unnamed_off_omitted: list.length - outputs.length, sensors,
    ...(inputs ? { inputs_named_or_closed: inputs } : {}),
    ...(usens.length ? { universal_sensors: usens } : {}),
  };
}

const json = (uri: URL, o: unknown): ReadResourceResult => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(o, null, 1) }] });
const plain = (uri: URL, t: string, mimeType = 'text/plain'): ReadResourceResult => ({ contents: [{ uri: uri.href, mimeType, text: t }] });
const one = (v: string | string[]): string => decodeURIComponent(Array.isArray(v) ? v[0] : v);
const dayList = (): string[] => { const out = ['today', 'yesterday']; const d = new Date(); for (let k = 0; k < 7; k++) { out.push(d.toISOString().slice(0, 10)); d.setDate(d.getDate() - 1); } return out; };

export function registerResources(server: McpServer, ctx: ToolContext): void {
  const { reg } = ctx;
  const completeServer = (v: string) => reg.slugs.filter(s => s.startsWith((v ?? '').toLowerCase()));

  // ---- vezerlonkent: info, state, flows.jsn --------------------------------------------------------------------------------
  reg.clients.forEach((c, i) => {
    const slug = reg.slugs[i];
    server.registerResource(`${slug}/info`, `myio://${slug}/info`, {
      title: `${c.name} - controller info`, mimeType: 'application/json',
      description: `info.json of ${c.name} (${c.origin}): serial, firmware, CPU, element counts, the permission level of this account, uptime, storage health, plus the feature map derived from the firmware version.`,
    }, async uri => json(uri, await infoDoc(c)));
    server.registerResource(`${slug}/state`, `myio://${slug}/state`, {
      title: `${c.name} - live state`, mimeType: 'application/json',
      description: `Decoded live state of ${c.name} in real units: outputs (relay / PCA / FET / group with level, roles, timers, thermostat thresholds), sensors (°C, %, W, V, A), inputs and universal sensors. Read at request time.`,
    }, async uri => json(uri, await stateDoc(c)));
    server.registerResource(`${slug}/flows.jsn`, `myio://${slug}/flows.jsn`, {
      title: `${c.name} - Flow rules (flows.jsn)`, mimeType: 'application/json',
      description: `The Flow rule file of ${c.name} (GIGA/Opta 4.4+): vars, flows (when / and / then cards), webhook hooks - the format myio_flow_save takes. Card reference: myio://docs/flow.`,
    }, async uri => { const { file } = await readFlows(c); return json(uri, file); });
  });

  // ---- sablonok: script-forras, napi esemenynaplo ---------------------------------------------------------------------------
  server.registerResource('script source', new ResourceTemplate('myio://{server}/prog/{n}.txt', {
    list: undefined, complete: { server: completeServer, n: v => Array.from({ length: 16 }, (_, k) => String(k + 1)).filter(x => x.startsWith(v ?? '')) },
  }), {
    title: 'Script source (prog/N.txt)', mimeType: 'text/plain',
    description: `Source of myIO Script slot N (1..16 GIGA, 1..8 Opta; GIGA/Opta 4.10+). server = ${reg.slugs.join(' | ')}. Language reference: myio://docs/script.`,
  }, async (uri, vars) => {
    const c = reg.bySlug(one(vars.server)); const n = parseInt(one(vars.n), 10);
    if (!(n >= 1 && n <= 16)) throw new MyIOError('script slot must be 1..16');
    await c.require(FEAT.script, 'myIO Script');
    try { return plain(uri, await c.getText(`~q/prog/${n}.txt`)); }
    catch (e) { if (e instanceof MyIOError && e.status === 404) throw new MyIOError(`${c.name}: script slot ${n} is empty (no prog/${n}.txt)`, 404); throw e; }
  });

  server.registerResource('event log', new ResourceTemplate('myio://{server}/log/{date}', {
    list: undefined, complete: { server: completeServer, date: v => dayList().filter(x => x.startsWith(v ?? '')) },
  }), {
    title: 'Event log of a day', mimeType: 'text/csv',
    description: `One day of the controller's event log (ev_log/e_YYMMDD.csv): boots, errors, logins, saves, network/expander/NTP events. date = today | yesterday | YYYY-MM-DD | YYMMDD. `
      + `4.x lines start with the level (E/I/D). At most the last ${LOG_MAX / 1024} KB. server = ${reg.slugs.join(' | ')}.`,
  }, async (uri, vars) => {
    const c = reg.bySlug(one(vars.server));
    await c.require(FEAT.files, 'log files');
    let day: string; try { day = yymmdd(one(vars.date), new Date()); } catch (e) { throw new MyIOError((e as Error).message); }
    let body: string;
    try { body = await c.getText(`ev_log/e_${day}.csv`, { timeoutMs: 90_000 }); }
    catch (e) { if (e instanceof MyIOError && e.status === 404) throw new MyIOError(`${c.name}: no event log for ${day} (ev_log/e_${day}.csv)`, 404); throw e; }
    if (Buffer.byteLength(body) > LOG_MAX) {
      const tail = Buffer.from(body).subarray(-LOG_MAX).toString('utf8');
      body = `# truncated: last ${LOG_MAX / 1024} KB of ${Math.round(Buffer.byteLength(body) / 1024)} KB\n` + tail.slice(tail.indexOf('\n') + 1);
    }
    return plain(uri, body, 'text/csv');
  });

  // ---- dokumentacio (a csomagolt API_REFERENCE.md) ------------------------------------------------------------------------------
  const md = apiReference();
  if (!md) return;
  const chapters = docChapters(md);
  server.registerResource('docs/index', 'myio://docs/index', {
    title: 'myIO API reference - contents', mimeType: 'text/markdown',
    description: 'Table of contents of the bundled myIO API reference (Hungarian): every chapter with its resource URI and the sub-headings.',
  }, async uri => plain(uri, ['# myIO API_REFERENCE.md - contents', '', ...chapters.map(ch => `- ${ch.title} -> myio://docs/chapter/${ch.id}`), '', 'Sub-headings:', ...headingList(md).filter(l => l.startsWith('### '))].join('\n'), 'text/markdown'));
  server.registerResource('docs/script', 'myio://docs/script', {
    title: 'myIO Script language reference', mimeType: 'text/markdown',
    description: 'The complete myIO Script language (chapter 10/G, Hungarian): directives, syntax, built-in functions, error codes, examples. Read before writing a script (myio_script_save).',
  }, async uri => plain(uri, scriptReference(md), 'text/markdown'));
  server.registerResource('docs/flow', 'myio://docs/flow', {
    title: 'Flow rule engine reference', mimeType: 'text/markdown',
    description: 'The Flow rule engine and the flows.jsn card format (chapter 10/D, Hungarian). Read before writing a rule (myio_flow_save).',
  }, async uri => plain(uri, flowReference(md), 'text/markdown'));
  for (const ch of chapters) {
    server.registerResource(`docs/chapter/${ch.id}`, `myio://docs/chapter/${ch.id}`, {
      title: `API ${ch.title}`, mimeType: 'text/markdown',
      description: `Chapter "${ch.title}" of the myIO API reference (Hungarian).`,
    }, async uri => plain(uri, ch.text, 'text/markdown'));
  }
  server.registerResource('docs search', new ResourceTemplate('myio://docs/search/{query}', { list: undefined }), {
    title: 'Search the API reference by heading', mimeType: 'text/markdown',
    description: 'Every chapter / section of the API reference whose heading contains the query (accent- and case-insensitive), e.g. myio://docs/search/mqtt.',
  }, async (uri, vars) => { const q = one(vars.query); return plain(uri, searchHeadings(q, md) || `no heading contains "${q}"`, 'text/markdown'); });
}
