// setup.test.mjs - AI-beuzemeles (AI_SETUP_PLAN.md A2): "nyomd meg a gombot" (myio_wait_input), "fogd meg a homerot"
// (myio_wait_sensor), 1-Wire ujrakereses (myio_sensor_rescan). A mock HTTP-vezerlo a teszt folyamataban fut, igy a varakozo
// eszkoz-hivas KOZBEN nyomhato meg a gomb / melegitheto a szenzor.
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

let mNew, mOld, client;
before(async () => {
  mNew = await startMock({ version: '4.27.0' });
  mOld = await startMock({ version: '4.26.2' });
  mNew.state.sensors['2'] = { id: 2, description: 'Hálószoba', temp: 2050 };
  client = await connect({ MYIO_SERVERS: JSON.stringify([{ name: 'Uj', url: mNew.url }, { name: 'Regi', url: mOld.url }]) });
});
after(async () => { await client.close(); await mNew.close(); await mOld.close(); });

test('the three setup tools are listed; the waiting tools are read-only', async () => {
  const { tools } = await client.listTools();
  const by = Object.fromEntries(tools.map(t => [t.name, t]));
  for (const n of ['myio_wait_input', 'myio_wait_sensor', 'myio_sensor_rescan']) assert.ok(by[n], n);
  assert.equal(by.myio_wait_input.annotations.readOnlyHint, true);
  assert.equal(by.myio_wait_sensor.annotations.readOnlyHint, true);
  assert.equal(by.myio_sensor_rescan.annotations.readOnlyHint, false);
  assert.equal(by.myio_wait_input.annotations.title, 'Wait for a button press');
  const ro = await connect({ MYIO_BASE_URL: mNew.url, MYIO_WRITE: 'read' });
  try {
    const names = new Set((await ro.listTools()).tools.map(t => t.name));
    assert.ok(names.has('myio_wait_input')); assert.ok(names.has('myio_wait_sensor')); assert.ok(!names.has('myio_sensor_rescan'));
  } finally { await ro.close(); }
});

test('myio_wait_input (4.27): a short tap during the wait is reported with name, kind and binding', async () => {
  setTimeout(() => mNew.pressInput(2, 'H'), 500);
  const t0 = Date.now();
  const r = await callText(client, 'myio_wait_input', { timeout_s: 10 });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Input 2 was pressed on Uj:/);
  assert.match(r.text, /\[2\] Konyha gomb: short press \(\d+\.\d s before it was read\)/);
  assert.match(r.text, /Configuration:\n {2}\[2\] Konyha gomb: enabled/);
  assert.ok(Date.now() - t0 < 4000, 'returns at the press, not at the timeout');
});

test('myio_wait_input: a press just before the call counts; the same press is not reported twice', async () => {
  mNew.pressInput(1, 'H');
  await sleep(300);
  let r = await callText(client, 'myio_wait_input', { timeout_s: 5 });
  assert.match(r.text, /Input 1 was pressed/); assert.match(r.text, /Nappali gomb: short press/);
  const t0 = Date.now();
  r = await callText(client, 'myio_wait_input', { timeout_s: 3 });
  assert.equal(r.isError, false);
  assert.match(r.text, /No button press seen on Uj in 3 s/);
  assert.match(r.text, /A short tap is enough on this firmware/);
  assert.ok(Date.now() - t0 >= 2900);
});

test('myio_wait_input: long press returns at once; its later release is not taken for the next button', async () => {
  setTimeout(() => mNew.pressInput(3, 'P'), 300);
  let r = await callText(client, 'myio_wait_input', { timeout_s: 5 });
  assert.match(r.text, /Input 3 was pressed/); assert.match(r.text, /long press \(held\)/);
  mNew.pressInput(3, 'R');                                   // a user elengedi, majd a kovetkezo gombot nyomja
  setTimeout(() => mNew.pressInput(1, 'H'), 400);
  r = await callText(client, 'myio_wait_input', { timeout_s: 5 });
  assert.match(r.text, /Input 1 was pressed/);
  assert.doesNotMatch(r.text, /released after/);
});

test('myio_wait_input: count collects several presses; a restart of the controller is survived', async () => {
  setTimeout(() => mNew.pressInput(1, 'H'), 300);
  setTimeout(() => mNew.pressInput(2, 'H'), 900);
  let r = await callText(client, 'myio_wait_input', { timeout_s: 6, count: 2 });
  assert.match(r.text, /2 inputs were pressed on Uj/);
  assert.match(r.text, /\[1\] Nappali gomb: short press/); assert.match(r.text, /\[2\] Konyha gomb: short press/);
  mNew.rebootInev();                                         // a sorszam elolrol indul
  setTimeout(() => mNew.pressInput(2, 'H'), 400);
  r = await callText(client, 'myio_wait_input', { timeout_s: 5 });
  assert.match(r.text, /Input 2 was pressed/);
});

test('myio_wait_input on older firmware: state polling - the button must be held', async () => {
  const inp = Object.values(mOld.state.inputs).find(i => i.id === 1);
  setTimeout(() => { inp.state = 1; }, 600);
  setTimeout(() => { inp.state = 0; }, 3200);
  const r = await callText(client, 'myio_wait_input', { timeout_s: 8, server: 'Regi' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Input 1 was pressed on Regi/);
  assert.match(r.text, /the kind of press is not reported by this firmware/);
  assert.match(r.text, /must be HELD for 2-3 s \(firmware 4\.27\+ reports short taps too\)/);
  // a tartosan zart 2-es bemenet (minta-adat) nem "nyomas"
  assert.doesNotMatch(r.text, /Konyha gomb: pressed/);
});

test('myio_wait_sensor: the warmed sensor is found; an unfinished wait is continued', async () => {
  const s2 = mNew.state.sensors['2'];
  s2.temp = 2050;
  let r = await callText(client, 'myio_wait_sensor', { timeout_s: 5, reset: true });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /No sensor rose by 1\.0 °C on Uj in \d+ s\./);
  assert.match(r.text, /\[2\] Hálószoba: 20\.5 -> 20\.5 °C \(\+0\.0 °C\)/);
  assert.match(r.text, /one sensor every 10 s, so each of the 2 sensors is refreshed about every 20 s\./);
  s2.temp = 2110;                                            // +0,6: meg keves
  setTimeout(() => { s2.temp = 2190; }, 1500);               // +1,4 a KIINDULO ertekhez kepest (a masodik hivas folytatja)
  r = await callText(client, 'myio_wait_sensor', { timeout_s: 10 });
  assert.match(r.text, /Sensor 2 is warming on Uj:/);
  assert.match(r.text, /\[2\] Hálószoba: 20\.5 -> 21\.9 °C \(\+1\.4 °C in \d+ s\)/);
  assert.match(r.text, /the next largest change: \[1\] hőszenzor \+0\.0 °C/);
});

test('myio_wait_sensor: two sensors rising together are flagged as not unique; custom rise', async () => {
  const s1 = mNew.state.sensors['1'], s2 = mNew.state.sensors['2'];
  const t1 = s1.temp, t2 = s2.temp;
  setTimeout(() => { s1.temp = t1 + 60; s2.temp = t2 + 50; }, 800);
  const r = await callText(client, 'myio_wait_sensor', { timeout_s: 8, rise: 0.5, reset: true });
  assert.match(r.text, /Sensor 1 is warming/);
  assert.match(r.text, /! not unique: \[2\] Hálószoba also rose by 0\.5 °C/);
  s1.temp = t1; s2.temp = t2;
});

test('myio_sensor_rescan: firmware gate, then a new thermometer appears and is marked', async () => {
  let r = await callText(client, 'myio_sensor_rescan', { server: 'Regi' });
  assert.equal(r.isError, true);
  assert.match(r.text, /needs firmware 4\.27 or newer \(this controller runs 4\.26\.2\)/);
  mNew.addOnRescan({ id: 7, description: '', temp: 8500 });
  r = await callText(client, 'myio_sensor_rescan');
  assert.equal(r.isError, false, r.text);
  assert.ok(mNew.log.includes('ow_scan=1'));
  assert.match(r.text, /Uj: 1-Wire rescan done - 3 thermometers \(1 new, 0 missing\)\./);
  assert.match(r.text, /\[7\] \(unnamed\): 85\.0 °C \(first measurement pending\) {3}<- NEW/);
  assert.match(r.text, /myio_rename kind=thermo/);
  mNew.dropOnRescan(7);
  r = await callText(client, 'myio_sensor_rescan');
  assert.match(r.text, /2 thermometers \(0 new, 1 missing\)/);
  assert.match(r.text, /No longer listed \(a 1-Wire sensor: check its wiring/);
});
