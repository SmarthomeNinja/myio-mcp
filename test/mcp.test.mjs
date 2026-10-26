// mcp.test.mjs - vegponttol vegpontig: a hivatalos MCP SDK kliense stdio-n inditja a szervert (dist/index.js), a vezerlo a mock.
// Futtatas: npm test  (= npm run build && node --test test/)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startMock } from './mock_myio.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, '..', 'dist', 'index.js');

async function connect(mock, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [ENTRY], stderr: 'pipe',
    env: { ...process.env, MYIO_MIN_GAP_MS: '0', MYIO_BASE_URL: mock.url, MYIO_USERNAME: 'admin', MYIO_PASSWORD: 'secret"$x', MYIO_NAME: 'mock', ...extraEnv },
  });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  return client;
}
const callText = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), isError: !!r.isError };
};

let mock, client;
before(async () => { mock = await startMock({ version: '4.8.10', deny: '5', user: 'admin', pass: 'secret"$x' }); client = await connect(mock); });
after(async () => { await client.close(); await mock.close(); });

test('tools: the 20 original names kept, all annotated', async () => {
  const { tools } = await client.listTools();
  const names = new Set(tools.map(t => t.name));
  const expected = ['myio_group_off', 'myio_group_on', 'myio_group_toggle', 'myio_info', 'myio_list_devices', 'myio_pca_off', 'myio_pca_on', 'myio_pca_set', 'myio_pca_toggle',
    'myio_pwm_off', 'myio_pwm_on', 'myio_pwm_set', 'myio_pwm_toggle', 'myio_read_sensors', 'myio_get_status', 'myio_relay_off', 'myio_relay_on', 'myio_relay_toggle', 'myio_send_command'];
  for (const n of expected) assert.ok(names.has(n), n);
  for (const t of tools) assert.ok(t.annotations && typeof t.annotations.readOnlyHint === 'boolean', `${t.name} has annotations`);
  assert.equal(tools.find(t => t.name === 'myio_info').annotations.readOnlyHint, true);
  assert.equal(tools.find(t => t.name === 'myio_relay_on').annotations.readOnlyHint, false);
});

test('myio_info: version, counts, right', async () => {
  const { text, isError } = await callText(client, 'myio_info');
  assert.equal(isError, false);
  assert.match(text, /firmware 4\.8\.10 \(GIGA\/Opta 4\.x/);
  assert.match(text, /relays RQ=64/);
  assert.match(text, /PCAQ=128 \(ids 2001\.\.2128\)/);
  assert.match(text, /right=0/);
});

test('myio_list_devices: names from d_sens_out, V4 group state, unnamed hidden by default', async () => {
  const { text } = await callText(client, 'myio_list_devices');
  assert.match(text, /\[1\] hangulat fény: ON/);
  assert.match(text, /\[2001\] nappali fűtés: OFF level 0\/255 \(0%\) switch-mode sensor 1 \[on 22, off 23\] \{thermostat/);
  assert.match(text, /Groups \(2\)/);
  assert.match(text, /\[502\] mennyezet csoport: OFF members \[9, 2002, 2003/);
  assert.match(text, /unnamed hidden/);
  const all = await callText(client, 'myio_list_devices', { type: 'relay', include_unnamed: true });
  assert.match(all.text, /\[7\] \(unnamed\): OFF/);
  assert.doesNotMatch(all.text, /PCA dimmer/);
});

test('myio_read_sensors: correct scales (temp x100, hum x10, P W, U x10, I x10)', async () => {
  const { text } = await callText(client, 'myio_read_sensors');
  assert.match(text, /\[1\] hőszenzor: 27\.12 °C \(temperature\)/);
  assert.match(text, /\[101\] Talaj szonda: 45\.3 % \(humidity\)/);
  assert.match(text, /\[201\] P1-kW: 138 W \(sdm_power\)/);
  assert.match(text, /\[204\] U1-V: 230\.1 V \(sdm_voltage\)/);
  assert.match(text, /\[207\] I1-A: 5\.2 A \(sdm_current\)/);
  const only = await callText(client, 'myio_read_sensors', { kind: 'humidity' });
  assert.doesNotMatch(only.text, /temperature/);
});

test('relay on/off/toggle with read-back', async () => {
  let r = await callText(client, 'myio_relay_on', { id: 2 });
  assert.match(r.text, /Sent: r_ON=2/); assert.match(r.text, /\[2\] nappali lámpa: ON/); assert.match(r.text, /\(was OFF\)/);
  r = await callText(client, 'myio_relay_toggle', { id: 2 });
  assert.match(r.text, /\[2\] nappali lámpa: OFF/);
  r = await callText(client, 'myio_relay_off', { id: 2 });
  assert.match(r.text, /\(unchanged\)/); assert.doesNotMatch(r.text, /!/);
  assert.deepEqual(mock.log.slice(-3), ['r_ON=2', 'r_INV=2', 'r_OFF=2']);
});

test('denied element: the controller drops the command silently, the tool reports it', async () => {
  const r = await callText(client, 'myio_relay_on', { id: 5 });
  assert.equal(r.isError, false);
  assert.match(r.text, /\[5\] lépcsőház lámpa: OFF/);
  assert.match(r.text, /expected ON but the controller reports OFF/);
  assert.match(r.text, /no write permission/);
});

test('unknown element id -> error', async () => {
  const r = await callText(client, 'myio_relay_on', { id: 99 });
  assert.equal(r.isError, true);
  assert.match(r.text, /No element with id 99/);
});

test('PCA set: percent -> raw 0..255, level raw; 1-based id accepted', async () => {
  let r = await callText(client, 'myio_pca_set', { id: 2003, percent: 50 });
  assert.match(r.text, /Sent: PCA\*2003=128/); assert.match(r.text, /\[2003\] .*: ON level 128\/255 \(50%\)/);
  r = await callText(client, 'myio_pca_set', { id: 3, level: 200 });
  assert.match(r.text, /Sent: PCA\*2003=200/); assert.match(r.text, /level 200\/255 \(78%\)/);
  r = await callText(client, 'myio_pca_off', { id: 2003 });
  assert.match(r.text, /Sent: PCA_OFF=2003/); assert.match(r.text, /: OFF level 0\/255/);
  r = await callText(client, 'myio_pca_on', { id: 2003 });
  assert.match(r.text, /level 255\/255 \(100%\)/);
  r = await callText(client, 'myio_pca_set', { id: 2003 });
  assert.equal(r.isError, true);
});

test('PWM/FET set: raw level, 1-based id accepted', async () => {
  const r = await callText(client, 'myio_pwm_set', { id: 1, percent: 100 });
  assert.match(r.text, /Sent: fet\*101=255/); assert.match(r.text, /\[101\] .*: ON level 255\/255/);
  await callText(client, 'myio_pwm_off', { id: 101 });
  assert.equal(mock.log.at(-1), 'f_OFF=101');
});

test('group on/off/toggle: members follow, V4 state read back', async () => {
  let r = await callText(client, 'myio_group_on', { id: 502 });
  assert.match(r.text, /Sent: g_ON=502/); assert.match(r.text, /\[502\] mennyezet csoport: ON/);
  r = await callText(client, 'myio_group_toggle', { id: 2 });
  assert.match(r.text, /Sent: g_INV=502/); assert.match(r.text, /\[502\] mennyezet csoport: OFF/);
  r = await callText(client, 'myio_group_off', { id: 502 });
  assert.match(r.text, /\(unchanged\)/);
});

test('myio_send_command: raw chain + diff of changed outputs', async () => {
  const r = await callText(client, 'myio_send_command', { commands: 'r_ON=16&r_OFF=1&PCA*2003=77&min_temp_ON*3=240' });
  assert.match(r.text, /Outputs that changed:/);
  assert.match(r.text, /\[1\] hangulat fény: OFF/);
  assert.match(r.text, /\[16\] .*: ON/);
  assert.match(r.text, /\[2003\] konyha fűtés: ON level 77\/255 \(30%\)/);
  assert.equal(mock.state.relays['2'].sensorON, 240);
  const none = await callText(client, 'myio_send_command', { commands: 'nonsense=1' });
  assert.match(none.text, /No output state changed/);
  const big = await callText(client, 'myio_send_command', { commands: 'x=' + 'y'.repeat(1100) });
  assert.equal(big.isError, true); assert.match(big.text, /1024 B/);
});

test('myio_get_status: raw endpoint, allow-list', async () => {
  const r = await callText(client, 'myio_get_status', { endpoint: 'sens_IO.json' });
  assert.match(r.text, /"inputs"/);
  const bad = await callText(client, 'myio_get_status', { endpoint: '../etc' });
  assert.equal(bad.isError, true);
});

test('V3 (Due) mock: group state derived from members, string counts', async () => {
  const m3 = await startMock({ version: '3.12.30' });
  const c3 = await connect(m3);
  try {
    const info = await callText(c3, 'myio_info');
    assert.match(info.text, /firmware 3\.12\.30 \(Due 3\.x: base features only/); assert.match(info.text, /PCAQ=128 \(ids 2001\.\.2128\)/);
    let r = await callText(c3, 'myio_group_on', { id: 502 });
    assert.match(r.text, /\[502\] mennyezet csoport: ON/);
    r = await callText(c3, 'myio_relay_off', { id: 9 });
    r = await callText(c3, 'myio_list_devices', { type: 'group' });
    assert.match(r.text, /\[502\] mennyezet csoport: OFF/);
  } finally { await c3.close(); await m3.close(); }
});

test('wrong password -> clear 401 error', async () => {
  const c = await connect(mock, { MYIO_PASSWORD: 'wrong' });
  try {
    const r = await callText(c, 'myio_info');
    assert.equal(r.isError, true); assert.match(r.text, /unauthorized \(401\)/);
  } finally { await c.close(); }
});
