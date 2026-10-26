// mcp5.test.mjs - 5. kor: resources (vezerlonkent + sablonok + dokumentacio), prompts (hu/en, beagyazott adatok), MYIO_TOOLSETS,
// annotacio-kovetkezetesseg, idempotens setterek (azonos par / idozito nem duplazodik), Streamable HTTP-transzport bearer-tokennel.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMock } from './mock_myio.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, '..', 'dist', 'index.js');
const BASE_ENV = { MYIO_BASE_URL: '', MYIO_SERVERS: '', MYIO_MIN_GAP_MS: '0', MYIO_WRITE: 'admin', MYIO_TOOLSETS: '', MYIO_HTTP_PORT: '', MYIO_HTTP_TOKEN: '', MYIO_HTTP_HOST: '' };
async function connect(env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY], stderr: 'pipe', env: { ...process.env, ...BASE_ENV, ...env } });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  return client;
}
const callText = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), isError: !!r.isError };
};
const read = async (client, uri) => (await client.readResource({ uri })).contents[0];
const prompt = async (client, name, args = {}) => (await client.getPrompt({ name, arguments: args })).messages[0].content.text;

const FLOWS = { formatVersion: 1, vars: [{ id: 1, name: 'mod' }], flows: [{ id: 1, name: 'esti fény', en: 1, when: { t: 'time', min: 1200, days: 127 }, then: [{ t: 'rel', id: 2, act: 1 }] }], hooks: [] };
let m4, m3, client;
before(async () => {
  m4 = await startMock({ version: '4.18.10', flows: FLOWS }); m3 = await startMock({ version: '3.12.35' });
  client = await connect({ MYIO_SERVERS: JSON.stringify([{ name: 'Földszint', url: m4.url }, { name: 'Emelet', url: m3.url }]) });
});
after(async () => { await client.close(); await m4.close(); await m3.close(); });

// ---- resources -------------------------------------------------------------------------------------------------------------
test('resources: per controller info/state/flows.jsn with URI-safe names, docs chapters, templates', async () => {
  const { resources } = await client.listResources();
  const uris = resources.map(r => r.uri);
  for (const u of ['myio://foldszint/info', 'myio://foldszint/state', 'myio://foldszint/flows.jsn', 'myio://emelet/info', 'myio://emelet/state', 'myio://docs/index', 'myio://docs/script', 'myio://docs/flow', 'myio://docs/chapter/10-g', 'myio://docs/chapter/4'])
    assert.ok(uris.includes(u), u);
  assert.ok(resources.every(r => r.mimeType && r.description), 'every resource has a mime type and a description');
  const { resourceTemplates } = await client.listResourceTemplates();
  assert.deepEqual(resourceTemplates.map(t => t.uriTemplate).sort(), ['myio://docs/search/{query}', 'myio://{server}/log/{date}', 'myio://{server}/prog/{n}.txt']);
});

test('resource state: decoded JSON in real units, unnamed OFF outputs omitted', async () => {
  const c = await read(client, 'myio://foldszint/state');
  assert.equal(c.mimeType, 'application/json');
  const j = JSON.parse(c.text);
  assert.equal(j.server, 'Földszint'); assert.equal(j.firmware, '4.18.10');
  const p = j.outputs.find(o => o.id === 2001);
  assert.equal(p.name, 'nappali fűtés'); assert.equal(p.type, 'pca'); assert.equal(p.on_threshold, 22); assert.ok(p.roles.includes('thermostat'));
  assert.ok(j.outputs.every(o => o.name || o.on || o.type === 'group'));
  assert.ok(j.unnamed_off_omitted > 0);
  assert.equal(j.sensors.find(s => s.id === 1).unit, '°C');
  assert.ok(Array.isArray(j.universal_sensors));
  const due = JSON.parse((await read(client, 'myio://emelet/state')).text);
  assert.equal(due.firmware, '3.12.35'); assert.equal(due.universal_sensors, undefined);
});

test('resource info: feature map from the version; flows.jsn raw; Due flows refused', async () => {
  const i = JSON.parse((await read(client, 'myio://foldszint/info')).text);
  assert.equal(i.features.flow, true); assert.equal(i.features.dst, true);
  const d = JSON.parse((await read(client, 'myio://emelet/info')).text);
  assert.equal(d.features.flow, false); assert.equal(d.features.sgready, true); assert.equal(d.features.dst, true);
  const f = JSON.parse((await read(client, 'myio://foldszint/flows.jsn')).text);
  assert.equal(f.flows[0].name, 'esti fény');
  await assert.rejects(read(client, 'myio://emelet/flows.jsn'), /4\.4\.0\+/);
});

test('resource templates: event log by date, script source, unknown controller, completion', async () => {
  const log = await read(client, 'myio://foldszint/log/today');
  assert.equal(log.mimeType, 'text/csv'); assert.match(log.text, /MEMORY FALLING/);
  assert.match((await read(client, 'myio://emelet/log/today')).text, /LOOP-STALL/);
  await assert.rejects(read(client, 'myio://foldszint/log/2001-01-01'), /no event log for 010101/);
  await assert.rejects(read(client, 'myio://foldszint/prog/2.txt'), /slot 2 is empty/);
  const r = await callText(client, 'myio_script_save', { id: 2, source: '#name proba\n#every 1s\nvar n = 0\nn = n + 1\n' });
  assert.equal(r.isError, false, r.text);
  assert.match((await read(client, 'myio://foldszint/prog/2.txt')).text, /#name proba/);
  await assert.rejects(read(client, 'myio://pince/info'), /./);
  await assert.rejects(read(client, 'myio://pince/log/today'), /unknown server "pince"/);
  const cs = await client.complete({ ref: { type: 'ref/resource', uri: 'myio://{server}/log/{date}' }, argument: { name: 'server', value: 'f' } });
  assert.deepEqual(cs.completion.values, ['foldszint']);
  const cd = await client.complete({ ref: { type: 'ref/resource', uri: 'myio://{server}/log/{date}' }, argument: { name: 'date', value: 'yes' } });
  assert.deepEqual(cd.completion.values, ['yesterday']);
});

test('resource docs: script / flow sections, chapter, accent-insensitive search', async () => {
  const s = await read(client, 'myio://docs/script');
  assert.equal(s.mimeType, 'text/markdown'); assert.match(s.text, /^## 10\/G\./); assert.doesNotMatch(s.text, /### 10\/E\.6/);
  assert.match((await read(client, 'myio://docs/flow')).text, /^## 10\/D\. Flow/);
  assert.match((await read(client, 'myio://docs/chapter/10-a')).text, /MQTT/);
  assert.match((await read(client, 'myio://docs/index')).text, /myio:\/\/docs\/chapter\/10-g/);
  const q = await read(client, 'myio://docs/search/' + encodeURIComponent('riasztokozpont'));
  assert.match(q.text, /SIA DC-09/);
});

// ---- prompts ---------------------------------------------------------------------------------------------------------------
test('prompts: four, bilingual titles, required element, completions', async () => {
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map(p => p.name).sort(), ['daily_diagnostics', 'heating_overview', 'new_flow_rule', 'why_not_switching']);
  assert.ok(prompts.every(p => /·/.test(p.title)), 'HU · EN title');
  assert.equal(prompts.find(p => p.name === 'why_not_switching').arguments.find(a => a.name === 'element').required, true);
  const ce = await client.complete({ ref: { type: 'ref/prompt', name: 'why_not_switching' }, argument: { name: 'element', value: 'nappali f' } });
  assert.ok(ce.completion.values.includes('nappali fűtés'));
  const cl = await client.complete({ ref: { type: 'ref/prompt', name: 'heating_overview' }, argument: { name: 'language', value: 'e' } });
  assert.deepEqual(cl.completion.values, ['en']);
  const cs = await client.complete({ ref: { type: 'ref/prompt', name: 'daily_diagnostics' }, argument: { name: 'server', value: 'eme' } });
  assert.deepEqual(cs.completion.values, ['Emelet']);
});

test('prompt heating_overview: zones + temperatures embedded, Hungarian by default, English on request', async () => {
  const hu = await prompt(client, 'heating_overview', { server: 'Földszint' });
  assert.match(hu, /^Készíts fűtés-áttekintést/); assert.match(hu, /Válaszolj magyarul/);
  assert.match(hu, /\[2001\] nappali fűtés \(pca\): target 22\.5°C band 1/);
  assert.match(hu, /### Temperatures and humidity\n\[1\] hőszenzor: 27\.12 °C/);
  assert.match(hu, /myio_set_thermostat/);
  const en = await prompt(client, 'heating_overview', { language: 'en' });
  assert.match(en, /^Write a heating overview/); assert.match(en, /## Földszint/); assert.match(en, /## Emelet/);
});

test('prompt why_not_switching: by id, by unique name, ambiguous name, unknown', async () => {
  const t = await prompt(client, 'why_not_switching', { element: '2001', language: 'en' });
  assert.match(t, /pca \[2001\] "nappali fűtés" on Földszint/);
  for (const sec of ['The element now', 'This account', 'Output configuration', 'Thermostat / sensor control', 'Protection pairs, joiners, groups', 'Timers that switch it', 'Wall buttons bound to it', 'Flow rules that read or write it', 'Scripts that use it', 'myIO Link', 'MQTT control', 'SG-Ready contacts', 'event log'])
    assert.match(t, new RegExp(sec), sec);
  assert.match(t, /The controller switches this output itself from the sensor/);
  assert.match(t, /group \[502\] mennyezet csoport/);
  const byName = await prompt(client, 'why_not_switching', { element: 'nappali lámpa' });   // a Földszinten egyertelmu (az Emelet-mock ugyanaz a minta: ket talalat)
  assert.match(byName, /több kimenetre illik|relay \[2\] „nappali lámpa”/);
  const one = await prompt(client, 'why_not_switching', { element: 'nappali lámpa', server: 'Földszint' });
  assert.match(one, /relay \[2\] „nappali lámpa” a\(z\) Földszint vezérlőn/);
  assert.match(one, /#1 "esti fény"/, 'the Flow rule that switches relay 2 is found');
  const amb = await prompt(client, 'why_not_switching', { element: 'nappali', server: 'Földszint' });
  assert.match(amb, /több kimenetre illik/); assert.match(amb, /\[2001\] nappali fűtés/);
  const none = await prompt(client, 'why_not_switching', { element: 'nincs ilyen', language: 'en' });
  assert.match(none, /No output named or numbered "nincs ilyen"/);
});

test('prompt daily_diagnostics: every controller, sysdiag, grouped log, clock; Due without Flow sections', async () => {
  const t = await prompt(client, 'daily_diagnostics', {});
  assert.match(t, /^Napi diagnosztika/);
  assert.match(t, /## Földszint .*\n### Controller/); assert.match(t, /## Emelet \(.*firmware 3\.12\.35\)/);
  assert.match(t, /### System diagnostics \(sysdiag\)/); assert.match(t, /### Clock, NTP, daylight saving\ncontroller clock 2026-10-25 20:15; difference to this computer/);
  assert.match(t, /System,MEMORY FALLING: 1x/); assert.match(t, /error lines \(last 1\):\nE,.*MEMORY FALLING/);
  assert.match(t, /### Flow engine\n1\/64 rules loaded/);
  const emelet = t.slice(t.indexOf('## Emelet'));
  assert.doesNotMatch(emelet, /### Flow engine/); assert.match(emelet, /LOOP-STALL/);
});

test('prompt new_flow_rule: card reference + rules + ids; Due has no Flow engine', async () => {
  const t = await prompt(client, 'new_flow_rule', { rule: 'napnyugtakor kapcsold be a nappali lámpát', server: 'Földszint' });
  assert.match(t, /„napnyugtakor kapcsold be a nappali lámpát”/); assert.match(t, /dry_run=true/);
  assert.match(t, /used ids: 1/); assert.match(t, /relay \[2\] nappali lámpa/); assert.match(t, /### Flow card reference \(API_REFERENCE 10\/D\)\n## 10\/D\./);
  const due = await prompt(client, 'new_flow_rule', { server: 'Emelet', language: 'en' });
  assert.match(due, /has no Flow engine/);
});

// ---- idempotens setterek ----------------------------------------------------------------------------------------------------------
test('idempotent setters: an identical protection pair / joiner / timer is not created twice', async () => {
  let r = await callText(client, 'myio_set_protection', { up: 40, down: 41, server: 'Földszint' });
  const idx = /pair #(\d+)/.exec(r.text)[1];
  r = await callText(client, 'myio_set_protection', { up: 40, down: 41, server: 'Földszint' });
  assert.match(r.text, /Nothing to change/); assert.match(r.text, new RegExp(`pair #${idx}`));
  r = await callText(client, 'myio_set_protection', { up: 0, down: 0, server: 'Földszint' }); assert.equal(r.isError, true);
  r = await callText(client, 'myio_set_protection', { index: Number(idx), up: 0, down: 0, server: 'Földszint' }); assert.match(r.text, /cleared/);
  r = await callText(client, 'myio_set_joiner', { master: 42, slave: 43, server: 'Földszint' }); const j = /joiner #(\d+)/.exec(r.text)[1];
  r = await callText(client, 'myio_set_joiner', { master: 42, slave: 43, server: 'Földszint' }); assert.match(r.text, /Nothing to change/);
  await callText(client, 'myio_set_joiner', { index: Number(j), master: 0, slave: 0, server: 'Földszint' });
  r = await callText(client, 'myio_set_timer', { hour: 7, minute: 5, event: 'relay ON', param: 4, server: 'Földszint' }); assert.match(r.text, /created/);
  r = await callText(client, 'myio_set_timer', { hour: 7, minute: 5, event: 'relay ON', param: 4, server: 'Földszint' }); assert.match(r.text, /identical timer already exists/);
});

// ---- annotaciok -----------------------------------------------------------------------------------------------------------------
test('annotations: read tools read-only; desired-value setters idempotent; toggles, fire/run and add/new not; config writes destructive', async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 102);
  const a = n => { const t = tools.find(x => x.name === n); assert.ok(t, n); return t.annotations; };
  for (const t of tools) {
    const x = t.annotations;
    for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) assert.equal(typeof x[k], 'boolean', `${t.name}.${k}`);
    if (x.readOnlyHint) assert.ok(!x.destructiveHint && x.idempotentHint, `${t.name}: read-only => not destructive, idempotent`);
    if (/_(set|save|write|op)$|^myio_(rename|user|scene|system|send_command|delete_timer)$|^myio_set_/.test(t.name)) assert.equal(x.readOnlyHint, false, t.name);
  }
  for (const n of ['myio_relay_on', 'myio_relay_off', 'myio_pca_set', 'myio_group_off', 'myio_shutter', 'myio_set_rgb', 'myio_set_usens', 'myio_set_thermostat', 'myio_set_globals', 'myio_rename',
    'myio_set_output_config', 'myio_set_protection', 'myio_set_timer', 'myio_delete_timer', 'myio_flow_save', 'myio_script_save', 'myio_file_write', 'myio_mqtt_set', 'myio_sgready_set', 'myio_knx_set'])
    assert.equal(a(n).idempotentHint, true, `${n} idempotent`);
  for (const n of ['myio_relay_toggle', 'myio_group_toggle', 'myio_output', 'myio_press_button', 'myio_flow', 'myio_script', 'myio_webhook_test', 'myio_scene', 'myio_shelly_set', 'myio_dmx_set', 'myio_ledstrip_set', 'myio_system', 'myio_send_command'])
    assert.equal(a(n).idempotentHint, false, `${n} not idempotent`);
  for (const n of ['myio_relay_on', 'myio_output', 'myio_shutter', 'myio_press_button', 'myio_flow']) assert.equal(a(n).destructiveHint, false, `${n}: reversible state change`);
  for (const n of ['myio_set_thermostat', 'myio_sgready_set', 'myio_ledstrip_set', 'myio_script', 'myio_knx_device', 'myio_send_command', 'myio_file_op']) assert.equal(a(n).destructiveHint, true, `${n}: can overwrite configuration`);
  assert.equal(a('myio_webhook_test').openWorldHint, true);
});

test('write gate: binding a thermostat sensor needs config, the target only state', async () => {
  const c = await connect({ MYIO_BASE_URL: m4.url, MYIO_WRITE: 'state' });
  try {
    let r = await callText(c, 'myio_set_thermostat', { id: 2001, sensor: 2 }); assert.equal(r.isError, true); assert.match(r.text, /MYIO_WRITE=config/);
    r = await callText(c, 'myio_set_thermostat', { id: 2001, target: 22.5 }); assert.equal(r.isError, false, r.text);
  } finally { await c.close(); }
});

// ---- toolsets --------------------------------------------------------------------------------------------------------------------
test('MYIO_TOOLSETS: core always, legacy separable, prompts and instructions follow the choice', async () => {
  const c1 = await connect({ MYIO_BASE_URL: m4.url, MYIO_TOOLSETS: 'house' });
  try {
    const names = (await c1.listTools()).tools.map(t => t.name).sort();
    assert.equal(names.length, 8 + 10);
    for (const n of ['myio_info', 'myio_servers', 'myio_find', 'myio_output', 'myio_send_command', 'myio_thermostats']) assert.ok(names.includes(n), n);
    assert.ok(!names.includes('myio_relay_on') && !names.includes('myio_flows'));
    assert.match(c1.getInstructions(), /Not loaded: legacy .*config/);
    const p = await prompt(c1, 'new_flow_rule', { rule: 'x' });
    assert.doesNotMatch(p, /myio_flow_save/); assert.match(p, /MYIO_TOOLSETS automation/);
    assert.ok((await c1.listResources()).resources.length > 20, 'resources do not depend on toolsets');
  } finally { await c1.close(); }
  const c2 = await connect({ MYIO_BASE_URL: m4.url, MYIO_TOOLSETS: 'all,-legacy,-core' });
  try {
    const names = (await c2.listTools()).tools.map(t => t.name);
    assert.equal(names.length, 102 - 14);
    assert.ok(names.includes('myio_info'), 'core cannot be disabled'); assert.ok(!names.includes('myio_pca_set'));
  } finally { await c2.close(); }
});

// ---- Streamable HTTP --------------------------------------------------------------------------------------------------------------
function startHttpServer(env) {
  const p = spawn(process.execPath, [ENTRY], { env: { ...process.env, ...BASE_ENV, MYIO_BASE_URL: m4.url, MYIO_HTTP_PORT: '0', MYIO_STDIO: '0', ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((resolve, reject) => {
    let err = '';
    const to = setTimeout(() => { p.kill(); reject(new Error(`no listen line: ${err}`)); }, 8000);
    p.stderr.on('data', d => { err += d; const m = /listening on (http:\/\/\S+)/.exec(err); if (m) { clearTimeout(to); resolve({ p, url: m[1], err: () => err }); } });
    p.on('exit', code => { clearTimeout(to); reject(Object.assign(new Error(`exited ${code}: ${err}`), { code, err })); });
  });
}

test('HTTP transport: bearer token required, sessions work, tools and resources over HTTP', async () => {
  const TOKEN = 'test-token-0123456789abcdef';
  const s = await startHttpServer({ MYIO_HTTP_TOKEN: TOKEN });
  try {
    assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const raw = await fetch(s.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } } }) });
    assert.equal(raw.status, 401);
    const bad = await fetch(s.url, { method: 'POST', headers: { Authorization: 'Bearer wrong-token-0123456789abc', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(bad.status, 401);
    const c = new Client({ name: 'http-test', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
    assert.equal((await c.listTools()).tools.length, 102);
    const r = await c.callTool({ name: 'myio_info', arguments: {} });
    assert.match(r.content[0].text, /firmware 4\.18\.10/);
    assert.match((await c.readResource({ uri: `myio://${new URL(m4.url).host.replace(/[^a-z0-9]+/g, '-')}/state` })).contents[0].text, /"outputs"/);
    const c2 = new Client({ name: 'http-test-2', version: '0' });   // masodik munkamenet parhuzamosan
    await c2.connect(new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
    assert.equal((await c2.listPrompts()).prompts.length, 4);
    await c2.close(); await c.close();
  } finally { s.p.kill(); }
});

test('HTTP transport: generated token on loopback; a LAN address without token is refused', async () => {
  const s = await startHttpServer({});
  try { assert.match(s.err(), /Bearer \S{20,}\s+<- generated/); } finally { s.p.kill(); }
  await assert.rejects(startHttpServer({ MYIO_HTTP_HOST: '0.0.0.0' }), e => /set MYIO_HTTP_TOKEN/.test(e.err ?? e.message));
});

test('why_not_switching event log: switching commands of the element, not every "=5" in the log', async () => {
  const day = new Date(); const ymd = `${String(day.getFullYear()).slice(2)}${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}`;
  const cur = (await read(client, 'myio://foldszint/log/today')).text;
  const ts = /I,(\d{4}\/\d{2}\/\d{2}) /.exec(cur)[1];
  const noisy = cur + `I,${ts} 09:40:00,System,Expander,LOST,addr=5\nI,${ts} 09:41:00,System,DST,0,tz=5\nI,${ts} 09:42:00,0,web,/command:r_OFF=5,192.168.1.63\n`;
  const w = await callText(client, 'myio_file_write', { path: `/ev_log/e_${ymd}.csv`, content: noisy, server: 'Földszint' });
  assert.equal(w.isError, false, w.text);
  const t = await prompt(client, 'why_not_switching', { element: '5', server: 'Földszint', language: 'en' });
  const sec = t.slice(t.indexOf("### Today's event log"));
  assert.match(sec, /0,r_ON,5/); assert.match(sec, /r_OFF=5,192/);
  assert.doesNotMatch(sec, /addr=5/); assert.doesNotMatch(sec, /tz=5/);
});
