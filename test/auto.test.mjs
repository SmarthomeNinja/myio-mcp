// auto.test.mjs - 3. kor: Flow, Script, referencia, sysdiag, metrics, naplok, fajlok, SD-tukor, iras-szint kapu, verzio-kapu.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startMock } from './mock_myio.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, '..', 'dist', 'index.js');

async function connect(env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY], stderr: 'pipe', env: { ...process.env, MYIO_BASE_URL: '', MYIO_SERVERS: '', MYIO_MIN_GAP_MS: '0', MYIO_WRITE: 'admin', ...env } });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  return client;
}
const callText = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), isError: !!r.isError };
};

let m4, m3, client;
before(async () => {
  m4 = await startMock({ version: '4.18.6' }); m3 = await startMock({ version: '3.12.33' });
  client = await connect({ MYIO_SERVERS: JSON.stringify([{ name: 'Opta', url: m4.url }, { name: 'Emelet', url: m3.url }]) });
});
after(async () => { await client.close(); await m4.close(); await m3.close(); });

const FLOW = { id: 1, name: 'Reggel', en: 1, when: { t: 'time', min: 390, days: 31 }, and: [{ t: 'out', id: 16, on: 0 }], then: [{ t: 'rel', id: 5, act: 1 }, { t: 'delay', m: 2 }, { t: 'rel', id: 5, act: 0 }] };

test('roster: 102 tools, round-3 annotations', async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 102);
  for (const n of ['myio_flows', 'myio_flow_save', 'myio_flow', 'myio_flow_trace', 'myio_webhook_test', 'myio_scripts', 'myio_script_get', 'myio_script_save', 'myio_script', 'myio_reference',
    'myio_sysdiag', 'myio_metrics', 'myio_logs', 'myio_log', 'myio_files', 'myio_file_read', 'myio_file_write', 'myio_file_op', 'myio_fm_sync']) assert.ok(tools.find(t => t.name === n), n);
  assert.equal(tools.find(t => t.name === 'myio_flows').annotations.readOnlyHint, true);
  assert.equal(tools.find(t => t.name === 'myio_flow_save').annotations.destructiveHint, true);
  assert.equal(tools.find(t => t.name === 'myio_file_op').annotations.destructiveHint, true);
});

test('flows: empty controller, validation blocks bad cards, save + describe + live state', async () => {
  let r = await callText(client, 'myio_flows', {});
  assert.match(r.text, /0 flow\(s\)/);
  r = await callText(client, 'myio_flow_save', { flow: { ...FLOW, then: [{ t: 'rel', id: 5, act: 3 }] } });
  assert.equal(r.isError, true); assert.match(r.text, /Not written/); assert.match(r.text, /act must be 0/);
  r = await callText(client, 'myio_flow_save', { flow: { ...FLOW, en: true } });
  assert.equal(r.isError, true); assert.match(r.text, /en must be the number 0 or 1/);
  r = await callText(client, 'myio_flow_save', { flow: { ...FLOW, and: [{ t: 'twin', from: 60, to: 120 }] }, dry_run: true });
  assert.equal(r.isError, false); assert.match(r.text, /NEVER true/);
  assert.ok(!m4.log.some(l => l.startsWith('PUT /flows.jsn')), 'nothing written so far');
  r = await callText(client, 'myio_flow_save', { flow: FLOW });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /added flow 1; flows\.jsn written \(\d+ B\) and reloaded/);
  assert.match(r.text, /WHEN at 06:30 \(Mon,Tue,Wed,Thu,Fri\)/);
  assert.match(r.text, /AND  relay 16 .* is OFF/);
  assert.match(r.text, /2\. wait 2 min/);
  assert.ok(m4.log.includes('flow_reload=1'));
  r = await callText(client, 'myio_flows', {});
  assert.match(r.text, /#1 "Reggel" - enabled/);
  r = await callText(client, 'myio_flows', { raw: true });
  assert.equal(JSON.parse(r.text).flows[0].name, 'Reggel');
});

test('flow runtime: fire changes outputs, trace decoded, set_var, webhook test', async () => {
  await callText(client, 'myio_relay_off', { id: 5 });
  let r = await callText(client, 'myio_flow', { action: 'fire', id: 1 });
  assert.match(r.text, /sent flow_fire=1/);
  assert.match(r.text, /trace:/); assert.match(r.text, /manual fire/);
  r = await callText(client, 'myio_flow', { action: 'set_var', id: 3, value: 7 });
  assert.match(r.text, /var3 is now 7/);
  r = await callText(client, 'myio_flow', { action: 'disable', id: 1 });
  assert.match(r.text, /DISABLED/);
  await callText(client, 'myio_flow', { action: 'enable', id: 1 });
  r = await callText(client, 'myio_flow_save', { hook: { id: 2, name: 'ntfy', met: 1, url: 'http://ntfy.lan/x', body: '$dev $msg' } });
  assert.equal(r.isError, false, r.text);
  r = await callText(client, 'myio_flow_save', { hook: { id: 4, url: 'https://secure.example/x' }, dry_run: true });
  assert.equal(r.isError, true); assert.match(r.text, /http:\/\//);
  r = await callText(client, 'myio_webhook_test', { slot: 2 });
  assert.match(r.text, /webhook sent \(slot 2, HTTP 200\)/);
  r = await callText(client, 'myio_flow_trace', {});
  assert.match(r.text, /tseq \d+ \(pass since=/);
  r = await callText(client, 'myio_flow_save', { delete: 1 });
  assert.match(r.text, /deleted flow 1/); assert.match(r.text, /previous version \(to undo\)/);
});

test('flows on Due 3.x: version gate', async () => {
  const r = await callText(client, 'myio_flows', { server: 'Emelet' });
  assert.equal(r.isError, true); assert.match(r.text, /not available on firmware 3\.12\.33/);
});

test('scripts: compile error with source line, OK, run, persistent enable, delete', async () => {
  let r = await callText(client, 'myio_scripts', {});
  assert.match(r.text, /0 of 8 slots used/);
  const src = '#name Teszt\n#every 1s\n#enabled 0\nvar n\nn = n + 1\n';
  r = await callText(client, 'myio_script_save', { id: 3, source: src.replace('n + 1', 'n +* 1') });
  assert.match(r.text, /ERROR/); assert.match(r.text, /compile error:\n\s+5 \| n = n \+\* 1\n\s+\|\s+\^/);
  r = await callText(client, 'myio_script_save', { id: 3, source: src });
  assert.match(r.text, /compiled OK, the program is OFF/);
  r = await callText(client, 'myio_script', { action: 'run', id: 3 });
  assert.match(r.text, /manual run/);
  r = await callText(client, 'myio_script', { action: 'enable', id: 3, persist: true });
  assert.match(r.text, /#enabled 1 written/); assert.match(r.text, /RUNNING/);
  r = await callText(client, 'myio_script_get', { id: 3 });
  assert.match(r.text, /#enabled 1/); assert.ok(!/#enabled 0/.test(r.text));
  r = await callText(client, 'myio_script_save', { id: 3, source: 'x'.repeat(5000) });
  assert.equal(r.isError, true); assert.match(r.text, /at most 4096 B/);
  r = await callText(client, 'myio_script', { action: 'delete', id: 3 });
  assert.match(r.text, /deleted/);
  r = await callText(client, 'myio_script_get', { id: 3 });
  assert.match(r.text, /slot 3 is empty/);
});

test('reference: script language, flow cards, api search', async () => {
  let r = await callText(client, 'myio_reference', { topic: 'script' });
  assert.match(r.text, /10\/G\.1 Fájlformátum/); assert.match(r.text, /10\/G\.8 Hibakódok/); assert.ok(!/10\/E\.6 Ext-RS485 Modbus/.test(r.text), 'misplaced Modbus subsection left out');
  r = await callText(client, 'myio_reference', { topic: 'flow' });
  assert.match(r.text, /flows\.jsn/);
  r = await callText(client, 'myio_reference', { topic: 'api', query: 'sysdiag' });
  assert.match(r.text, /### 5\.3 `sysdiag\.json`/);
});

test('sysdiag + metrics on 4.x and Due', async () => {
  let r = await callText(client, 'myio_sysdiag', {});
  assert.match(r.text, /last reset: WATCHDOG/); assert.match(r.text, /WiFi: STA connected 192\.168\.1\.60, RSSI -64 dBm/); assert.match(r.text, /Link: state 1 for 340 ms/);
  r = await callText(client, 'myio_sysdiag', { server: 'Emelet' });
  assert.match(r.text, /ESTABLISHED :80 <-> 192\.168\.1\.63:58763/); assert.match(r.text, /longest round 111 ms/);
  r = await callText(client, 'myio_metrics', { filter: 'ram' });
  assert.match(r.text, /myio_ram_free_bytes 128360/); assert.ok(!/usens/.test(r.text));
  r = await callText(client, 'myio_metrics', { server: 'Emelet' });
  assert.equal(r.isError, true); assert.match(r.text, /not available on firmware 3\.12\.33/);
});

test('logs: listing, level filter, tail, Due format, missing day', async () => {
  let r = await callText(client, 'myio_logs', {});
  assert.match(r.text, /internal flash \(q\): ev_log \(event\), t_log_1 \(temperature ch 1\)/); assert.match(r.text, /SD card: no SD card/);
  r = await callText(client, 'myio_log', { level: 'error' });
  assert.match(r.text, /1 error, 2 info, 1 debug/); assert.match(r.text, /- 1 match/); assert.match(r.text, /MEMORY FALLING/); assert.ok(!/PCA_ON/.test(r.text), 'level-less legacy line is INFO');
  r = await callText(client, 'myio_log', { level: 'info', tail: 2 });
  assert.match(r.text, /4 match, last 2 shown/);
  r = await callText(client, 'myio_log', { contains: 'r_on', since: '08:05' });
  assert.match(r.text, /- 1 match/);
  r = await callText(client, 'myio_log', { kind: 'temperature', channel: 1 });
  assert.match(r.text, /08:00,2150/);
  r = await callText(client, 'myio_log', { date: '2020-01-01' });
  assert.equal(r.isError, true); assert.match(r.text, /does not exist/);
  r = await callText(client, 'myio_log', { server: 'Emelet' });
  assert.match(r.text, /LOOP-STALL/);
  r = await callText(client, 'myio_logs', { kind: 'event', server: 'Emelet' });
  assert.match(r.text, /s:\/ev_log - 2 file\(s\)/);
});

test('files: write/read/op, binary, safe paths, system-path gate, Due volume', async () => {
  let r = await callText(client, 'myio_file_write', { path: '/x/y/z.txt', content: 'árvíztűrő', make_dirs: true });
  assert.equal(r.isError, false, r.text); assert.match(r.text, /created folder\(s\) \/x, \/x\/y/);
  r = await callText(client, 'myio_file_read', { path: 'x/y/z.txt' });
  assert.match(r.text, /árvíztűrő/);
  r = await callText(client, 'myio_file_write', { path: '/x/b.bin', base64: Buffer.from([0, 255, 1, 2]).toString('base64') });
  assert.match(r.text, /\(4 B\)/);
  r = await callText(client, 'myio_file_read', { path: '/x/b.bin' });
  assert.match(r.text, /binary/); assert.match(r.text, /00ff0102/);
  r = await callText(client, 'myio_file_op', { op: 'copy', path: '/x', to: '/w' });
  assert.match(r.text, /OK \(2 file\(s\)/);
  r = await callText(client, 'myio_file_op', { op: 'delete', path: '/x' });
  assert.equal(r.isError, true); assert.match(r.text, /non-empty folder/);
  r = await callText(client, 'myio_files', { dir: '/w/y' });
  assert.match(r.text, /z\.txt/);
  r = await callText(client, 'myio_file_read', { path: '/bad name.txt' });
  assert.equal(r.isError, true); assert.match(r.text, /does not URL-decode/);
  r = await callText(client, 'myio_files', { vol: 'q', server: 'Emelet' });
  assert.equal(r.isError, true); assert.match(r.text, /only the SD card/);
  r = await callText(client, 'myio_files', { server: 'Emelet', dir: '/ev_log' });
  assert.match(r.text, /s:\/ev_log/);
  const c = await connect({ MYIO_BASE_URL: m4.url, MYIO_WRITE: 'config' });
  try {
    r = await callText(c, 'myio_file_write', { path: '/net.jsn', content: '{}' });
    assert.equal(r.isError, true); assert.match(r.text, /MYIO_WRITE=admin/);
    r = await callText(c, 'myio_file_op', { op: 'delete', path: '/htm/index.htm' });
    assert.equal(r.isError, true); assert.match(r.text, /MYIO_WRITE=admin/);
    r = await callText(c, 'myio_fm_sync', { op: 'config' });
    assert.equal(r.isError, true);
    r = await callText(c, 'myio_fm_sync', {});
    assert.match(r.text, /SD card NOT present/);
  } finally { await c.close(); }
});

test('write level state: config writes refused, runtime flow actions allowed', async () => {
  const c = await connect({ MYIO_BASE_URL: m4.url, MYIO_WRITE: 'state' });
  try {
    let r = await callText(c, 'myio_flow_save', { flow: FLOW });
    assert.equal(r.isError, true); assert.match(r.text, /MYIO_WRITE=state/);
    r = await callText(c, 'myio_script', { action: 'delete', id: 1 });
    assert.equal(r.isError, true); assert.match(r.text, /MYIO_WRITE=state/);
    r = await callText(c, 'myio_flow', { action: 'set_var', id: 1, value: 1 });
    assert.equal(r.isError, false, r.text);
  } finally { await c.close(); }
});
