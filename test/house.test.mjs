// house.test.mjs - 1. kor: tobb vezerlo, nevkereses, univerzalis kimenet, bemenetek, gombszimulacio, termosztat, redony, RGB, usens.
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
  const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY], stderr: 'pipe', env: { ...process.env, MYIO_BASE_URL: '', MYIO_SERVERS: '', MYIO_MIN_GAP_MS: '0', ...env } });
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
  m4 = await startMock({ version: '4.8.10', deny: '5' });
  m3 = await startMock({ version: '3.12.30' });
  client = await connect({ MYIO_SERVERS: JSON.stringify([{ name: 'Földszint', url: m4.url, username: 'admin', password: 'x' }, { name: 'Emelet', url: m3.url }]) });
});
after(async () => { await client.close(); await m4.close(); await m3.close(); });

test('tool roster: 19 round-0 + 13 house + 21 config tools', async () => {
  const { tools } = await client.listTools();
  const names = new Set(tools.map(t => t.name));
  for (const n of ['myio_servers', 'myio_find', 'myio_output', 'myio_inputs', 'myio_press_button', 'myio_thermostats', 'myio_set_thermostat', 'myio_shutters', 'myio_shutter', 'myio_rgb', 'myio_set_rgb', 'myio_usensors', 'myio_set_usens', 'myio_info', 'myio_relay_on', 'myio_send_command']) assert.ok(names.has(n), n);
  assert.equal(tools.length, 102);
  const srv = tools.find(t => t.name === 'myio_relay_on').inputSchema.properties.server;
  assert.match(srv.description, /Földszint \| Emelet/);
});

test('myio_servers + server routing + unknown server', async () => {
  const r = await callText(client, 'myio_servers');
  assert.match(r.text, /Földszint \(http:\/\/127\.0\.0\.1:\d+\): firmware 4\.8\.10/);
  assert.match(r.text, /Emelet \(http:\/\/127\.0\.0\.1:\d+\): firmware 3\.12\.30/);
  const e = await callText(client, 'myio_info', { server: 'emelet' });
  assert.match(e.text, /firmware 3\.12\.30/);
  const bad = await callText(client, 'myio_info', { server: 'pince' });
  assert.equal(bad.isError, true); assert.match(bad.text, /unknown server "pince"/);
});

test('myio_find: accent-insensitive across outputs, inputs, usens', async () => {
  const r = await callText(client, 'myio_find', { query: 'konyha' });
  assert.match(r.text, /relay: \[4\] konyha lámpa: OFF/);
  assert.match(r.text, /relay: \[12\] R\. Konyha Fix FEL: OFF .*shutter-up/);
  assert.match(r.text, /input: \[2\] Konyha gomb: PRESSED\/CLOSED/);
  const u = await callText(client, 'myio_find', { query: 'hofok' });
  assert.match(u.text, /usens: \[usens 1\] Gyerekszoba hőfok: 21\.5 °C/);
  const none = await callText(client, 'myio_find', { query: 'zzz' });
  assert.match(none.text, /No element named like/);
});

test('myio_list_devices shows roles; myio_read_sensors includes usens on 4.x only', async () => {
  const r = await callText(client, 'myio_list_devices', { type: 'relay' });
  assert.match(r.text, /\[3\] wellnes fűtés: OFF sensor 1 \[on 24, off 24\.6\] \{thermostat/);
  assert.match(r.text, /\[1\] hangulat fény: ON sun \[on at sunset, off at sunrise\] \{sun-controlled\}/);
  assert.match(r.text, /\[13\] R\. Konyha Fix LE: OFF \{shutter-down\}/);
  const p = await callText(client, 'myio_list_devices', { type: 'pca' });
  assert.match(p.text, /\[2018\] R ledszalag: .*\{rgb:501\}/);
  const s4 = await callText(client, 'myio_read_sensors');
  assert.match(s4.text, /Universal sensors \(4\.x\):/); assert.match(s4.text, /\[usens 5\] Napelem: STALE \(last 123\.4 W, 900s ago\) \(power, failsafe 600s; activator id 305\)/);
  const s3 = await callText(client, 'myio_read_sensors', { server: 'Emelet' });
  assert.doesNotMatch(s3.text, /Universal sensors/);
  const u3 = await callText(client, 'myio_read_sensors', { server: 'Emelet', kind: 'usens' });
  assert.match(u3.text, /need 4\.x firmware/);
});

test('myio_output: universal writer by id type', async () => {
  let r = await callText(client, 'myio_output', { id: 2, action: 'on' });
  assert.match(r.text, /Sent: r_ON=2/); assert.match(r.text, /\[2\] nappali lámpa: ON/);
  r = await callText(client, 'myio_output', { id: 2003, action: 'level', percent: 50 });
  assert.match(r.text, /Sent: PCA\*2003=128/);
  r = await callText(client, 'myio_output', { id: 4003, action: 'off' });
  assert.match(r.text, /Sent: PCA_OFF=2003/);
  r = await callText(client, 'myio_output', { id: 502, action: 'toggle' });
  assert.match(r.text, /Sent: g_INV=502/);
  r = await callText(client, 'myio_output', { id: 2, action: 'level', level: 10 });
  assert.equal(r.isError, true); assert.match(r.text, /only PCA\/FET outputs take a level/);
  r = await callText(client, 'myio_output', { id: 9999, action: 'on' });
  assert.equal(r.isError, true);
});

test('myio_inputs + version gate + press_button', async () => {
  let r = await callText(client, 'myio_inputs');
  assert.match(r.text, /Inputs on Földszint \(3, 1 unnamed\)/);
  assert.match(r.text, /\[1\] Nappali gomb: open/); assert.match(r.text, /\[2\] Konyha gomb: PRESSED\/CLOSED/);
  r = await callText(client, 'myio_inputs', { only_active: true });
  assert.doesNotMatch(r.text, /Nappali gomb/);
  r = await callText(client, 'myio_inputs', { server: 'Emelet' });   // 3.12.30 >= 3.12.7: megy
  assert.match(r.text, /Konyha gomb/);
  const old = await startMock({ version: '3.12.5' });
  const c = await connect({ MYIO_BASE_URL: old.url });
  try {
    const g = await callText(c, 'myio_inputs');
    assert.equal(g.isError, true); assert.match(g.text, /not available on firmware 3\.12\.5 \(needs GIGA\/Opta 4\.3\.12\+ or Due 3\.12\.7\+\)/);
  } finally { await c.close(); await old.close(); }
  r = await callText(client, 'myio_press_button', { id: 4 });
  assert.match(r.text, /Sent: s_hit=4/); assert.match(r.text, /Outputs that changed:\n  \[4\] konyha lámpa: ON/);
  r = await callText(client, 'myio_press_button', { id: 4, kind: 'release' });
  assert.match(r.text, /No output state changed/);
});

test('thermostats: list, set target/band, PCA zone, bind sensor', async () => {
  let r = await callText(client, 'myio_thermostats');
  assert.match(r.text, /\[3\] wellnes fűtés \(relay\): target 24\.3°C band 0\.6 \[on 24, off 24\.6\] mode heat, current 27\.12°C from hőszenzor, (idle|HEATING)/);
  assert.match(r.text, /\[6\] gyerek szoba fűtés \(relay\): target 22°C band 1 \[on 21\.5, off 22\.5\] mode heat, current 21\.5°C from Gyerekszoba hőfok/);
  assert.match(r.text, /\[2001\] nappali fűtés \(pca\): target 22\.5°C band 1 \[on 22, off 23\]/);
  assert.match(r.text, /\[1\] hangulat fény: sun-controlled, on at sunset, off at sunrise, now ON/);
  r = await callText(client, 'myio_set_thermostat', { id: 3, target: 22 });
  assert.match(r.text, /Sent: min_temp_ON\*3=217&max_temp_OFF\*3=223/); assert.match(r.text, /target 22°C band 0\.6/);
  r = await callText(client, 'myio_set_thermostat', { id: 3, band: 1 });
  assert.match(r.text, /Sent: min_temp_ON\*3=215&max_temp_OFF\*3=225/); assert.match(r.text, /target 22°C band 1/);
  r = await callText(client, 'myio_set_thermostat', { id: 2001, target: 21 });
  assert.match(r.text, /Sent: PCA_temp_MIN\*2001=205&PCA_temp_MAX\*2001=215/);
  r = await callText(client, 'myio_set_thermostat', { id: 4, on: 20, off: 21 });
  assert.match(r.text, /Sent: min_temp_ON\*4=200&max_temp_OFF\*4=210/); assert.match(r.text, /is no longer sensor-controlled|not a sensor/);
  r = await callText(client, 'myio_set_thermostat', { id: 4, sensor: 1 });
  assert.match(r.text, /Sent: thermoActivator\*4=1/); assert.match(r.text, /\[4\] konyha lámpa \(relay\): target 20\.5°C band 1/);
  r = await callText(client, 'myio_set_thermostat', { id: 9, target: 5 });   // sensor=1: 19/20 -> 4.5/5.5
  assert.match(r.text, /min_temp_ON\*9=45&max_temp_OFF\*9=55/);
  r = await callText(client, 'myio_set_thermostat', { id: 9, band: 50 });
  assert.equal(r.isError, true);
  r = await callText(client, 'myio_set_thermostat', { id: 502, target: 20 });
  assert.equal(r.isError, true);
});

test('shutters: list + open/close/stop + by up_id', async () => {
  let r = await callText(client, 'myio_shutters');
  assert.match(r.text, /#1 R\. Konyha Fix: stopped \(up \[12\] R\. Konyha Fix FEL, down \[13\] R\. Konyha Fix LE\)/);
  assert.match(r.text, /#2 R\. Nappali Hátsó: stopped/);
  r = await callText(client, 'myio_shutter', { index: 1, action: 'open' });
  assert.match(r.text, /Sent: r_OFF=13&r_ON=12/); assert.match(r.text, /#1 R\. Konyha Fix: opening/);
  r = await callText(client, 'myio_shutter', { index: 1, action: 'close' });
  assert.match(r.text, /Sent: r_OFF=12&r_ON=13/); assert.match(r.text, /closing/);
  r = await callText(client, 'myio_shutter', { up_id: 12, action: 'stop' });
  assert.match(r.text, /Sent: r_OFF=12&r_OFF=13/); assert.match(r.text, /stopped/);
  r = await callText(client, 'myio_shutter', { index: 9, action: 'stop' });
  assert.equal(r.isError, true);
  const e = await callText(client, 'myio_shutters', { server: 'Emelet' });
  assert.match(e.text, /#1 R\. Konyha Fix: stopped/);
});

test('rgb: list + colour / brightness / off / on', async () => {
  let r = await callText(client, 'myio_rgb');
  assert.match(r.text, /\[501\] RGB PCA 501 regulation: OFF color rgb\(255, 255, 255\) brightness 255\/255 \(channels R=\[2018\] G=\[2019\] B=\[2020\], levels 0\/0\/0\)/);
  r = await callText(client, 'myio_set_rgb', { id: 501, r: 255, g: 0, b: 0 });
  assert.match(r.text, /Sent: PCA\*2018=255&PCA\*2019=0&PCA\*2020=0/); assert.match(r.text, /: ON color rgb\(255, 0, 0\) brightness 255\/255/);
  r = await callText(client, 'myio_set_rgb', { id: 501, brightness: 128 });
  assert.match(r.text, /Sent: PCA\*2018=128&PCA\*2019=0&PCA\*2020=0/); assert.match(r.text, /brightness 128\/255/);
  r = await callText(client, 'myio_set_rgb', { id: 501, on: false });
  assert.match(r.text, /Sent: PCA_OFF=2018&PCA_OFF=2019&PCA_OFF=2020/); assert.match(r.text, /: OFF color rgb\(255, 0, 0\) brightness 128/);
  r = await callText(client, 'myio_set_rgb', { id: 1, on: true });
  assert.match(r.text, /Sent: PCA\*2018=128&PCA\*2019=0&PCA\*2020=0/);
  r = await callText(client, 'myio_set_rgb', { id: 501, on: true });
  assert.match(r.text, /Already ON/);
  r = await callText(client, 'myio_set_rgb', { id: 502, on: true });
  assert.equal(r.isError, true);
});

test('usens: list, write, disabled slot, V3 gate', async () => {
  let r = await callText(client, 'myio_usensors');
  assert.match(r.text, /SENQ=100, 3 shown/); assert.match(r.text, /\[usens 2\] Nappali pára: 45\.5 % \(humidity; activator id 302\)/);
  r = await callText(client, 'myio_usensors', { include_disabled: true });
  assert.match(r.text, /\[usens 7\]/);
  r = await callText(client, 'myio_set_usens', { id: 1, value: 22.55 });
  assert.match(r.text, /Sent: usens\*1=226/); assert.match(r.text, /\[usens 1\] Gyerekszoba hőfok: 22\.6 °C/);
  r = await callText(client, 'myio_set_usens', { id: 7, value: 1 });
  assert.match(r.text, /did not take the value/);
  r = await callText(client, 'myio_set_usens', { id: 1, value: 20, server: 'Emelet' });
  assert.equal(r.isError, true); assert.match(r.text, /not available on firmware 3\.12\.30/);
  r = await callText(client, 'myio_usensors', { server: 'Emelet' });
  assert.equal(r.isError, true);
});
