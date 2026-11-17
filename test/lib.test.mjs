// lib.test.mjs - a konyvtar-belepo (dist/lib.js): sajat transzporttal epitett szerver, eszkozszuro, 'read' iras-szint
// (CLOUD_MCP_PLAN.md 11. fej., 2026-11-15: a felhos szerver ugyanigy epiti fel a szervert, csak a transzportja mas).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, registryOf, MyIOClient, HttpTransport, parseWriteLevel } from '../dist/lib.js';
import { startMock } from './mock_myio.mjs';

// kemkedo transzport: a HttpTransport koze ul, es feljegyzi, mi ment ki - igy latszik, hogy minden a transzporton at megy
class SpyTransport {
  constructor(inner) { this.inner = inner; this.calls = []; }
  get origin() { return 'spy://mock'; }
  get requests() { return this.inner.requests; }
  get authHint() { return 'spy auth hint'; }
  get timeoutMs() { return this.inner.timeoutMs; }
  request(method, path, ...rest) { this.calls.push(`${method} ${path}`); return this.inner.request(method, path, ...rest); }
  rawGet(path) { this.calls.push(`RAW ${path}`); return this.inner.rawGet(path); }
}

async function connect(server) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const callText = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), isError: !!r.isError };
};

let mock, spy, reg;
before(async () => {
  mock = await startMock({ version: '4.8.10', user: 'admin', pass: 'pw' });
  spy = new SpyTransport(new HttpTransport({ name: 'mock', baseUrl: mock.url, username: 'admin', password: 'pw', minGapMs: 0 }));
  reg = registryOf([new MyIOClient({ name: 'Spy', transport: spy })]);
});
after(async () => { await mock.close(); });

test('lib: a custom transport carries every request (info, state, command)', async () => {
  const client = await connect(buildServer(reg, 'state'));
  spy.calls.length = 0;
  const info = await callText(client, 'myio_info');
  assert.equal(info.isError, false, info.text);
  assert.ok(spy.calls.includes('GET info.json'), spy.calls.join(', '));
  const on = await callText(client, 'myio_output', { id: 1, action: 'on' });
  assert.equal(on.isError, false, on.text);
  assert.ok(spy.calls.some(c => c === 'POST info.json'), spy.calls.join(', '));
  assert.equal(Object.values(mock.state.relays).find(r => r.id === 1).state, 1);
  await client.close();
});

test('lib: every tool carries its title in the annotations too (Connectors Directory)', async () => {
  const client = await connect(buildServer(reg, 'admin'));
  const { tools } = await client.listTools();
  assert.equal(tools.length, 102);
  for (const t of tools) { assert.ok(t.title, t.name); assert.equal(t.annotations?.title, t.title, t.name); }
  await client.close();
});

test('lib: allowTool removes tools from the list', async () => {
  const client = await connect(buildServer(reg, 'state', undefined, { allowTool: n => n !== 'myio_send_command' && !n.startsWith('myio_flow') }));
  const names = new Set((await client.listTools()).tools.map(t => t.name));
  assert.ok(names.has('myio_output'));
  assert.ok(!names.has('myio_send_command'));
  assert.ok(![...names].some(n => n.startsWith('myio_flow')));
  await client.close();
});

test('lib: write level "read" loads only read-only tools', async () => {
  assert.equal(parseWriteLevel('READ'), 'read');
  const client = await connect(buildServer(reg, 'read'));
  const { tools } = await client.listTools();
  assert.ok(tools.length > 30, `${tools.length} read-only tools`);
  for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, `${t.name} is read-only`);
  const names = new Set(tools.map(t => t.name));
  for (const n of ['myio_info', 'myio_get_status', 'myio_thermostats', 'myio_sysdiag']) assert.ok(names.has(n), n);
  for (const n of ['myio_output', 'myio_relay_on', 'myio_send_command', 'myio_set_thermostat']) assert.ok(!names.has(n), n);
  await client.close();
});

test('lib: instructions and identity can be replaced', async () => {
  const client = await connect(buildServer(reg, 'state', undefined, { instructions: 'cloud instructions', name: 'myio-cloud', title: 'myIO Cloud' }));
  assert.equal(client.getInstructions(), 'cloud instructions');
  assert.equal(client.getServerVersion()?.name, 'myio-cloud');
  await client.close();
});
