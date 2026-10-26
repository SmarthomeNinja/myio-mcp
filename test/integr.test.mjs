// integr.test.mjs - 4. kor: integraciok (Shelly, Link, MQTT, Cloud, SG, riaszto, MIA, LED, halozat, rendszer) es bovitok (KNX, DALI, DMX, Modbus):
// billeno parancsok csak elteresnel, titkok maszkolva, '&' tiltva, iras-szint kapuk, verzio-kapuk, offline-panel vedelem.
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
const sent = (m, from) => m.log.slice(from);

let m4, m3, mOff, client;
before(async () => {
  m4 = await startMock({ version: '4.18.7' }); m3 = await startMock({ version: '3.12.33' }); mOff = await startMock({ version: '4.18.7', knxOffline: true });
  client = await connect({ MYIO_SERVERS: JSON.stringify([{ name: 'Opta', url: m4.url }, { name: 'Emelet', url: m3.url }, { name: 'Off', url: mOff.url }]) });
});
after(async () => { await client.close(); await m4.close(); await m3.close(); await mOff.close(); });

test('roster: 102 tools; read tools are read-only, admin tools destructive', async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 102);
  for (const n of ['myio_shelly', 'myio_link', 'myio_mqtt', 'myio_cloud', 'myio_sgready', 'myio_alarm', 'myio_mia', 'myio_ledstrip', 'myio_network', 'myio_expanders', 'myio_knx', 'myio_dali', 'myio_dmx', 'myio_modbus'])
    assert.equal(tools.find(t => t.name === n).annotations.readOnlyHint, true, n);
  for (const n of ['myio_network_set', 'myio_system', 'myio_cloud_set']) assert.equal(tools.find(t => t.name === n).annotations.destructiveHint, true, n);
});

test('MQTT: secrets masked, toggles only when different, save, Due without 4.x fields', async () => {
  let r = await callText(client, 'myio_mqtt');
  assert.match(r.text, /password \(set, hidden\)/); assert.ok(!/secret|KEY/.test(r.text), 'no secret in output');
  const from = m4.log.length;
  r = await callText(client, 'myio_mqtt_set', { enabled: true, host: '10.0.0.5', retain: true, ha_discovery: false, publish_on_change: { buttons: true, activators: false }, periodic: { humidity: true }, password: 'új jelszó' });
  assert.equal(r.isError, false, r.text);
  const cmds = sent(m4, from);
  assert.deepEqual(cmds.filter(c => /^mq_(en|ret|ha|chg_btn|chg_act|per_hum)=/.test(c)), ['mq_en=1', 'mq_ha=1', 'mq_chg_act=1', 'mq_per_hum=1'], 'retain/buttons already on -> not sent');
  assert.ok(cmds.includes('mq_host=10.0.0.5') && cmds.includes('mq_pw=új jelszó') && cmds.at(-1) === 'MqttSave=1');
  assert.match(r.text, /mq_pw=\*\*\*/); assert.ok(!/új jelszó/.test(r.text));
  assert.match(r.text, /CONNECTED/); assert.match(r.text, /Home Assistant discovery no/); assert.match(r.text, /humidity yes/);
  r = await callText(client, 'myio_mqtt_set', { sensor_binding: { slot: 2, topic: 'zigbee2mqtt/temp', key: 'temperature', usens: 31 } });
  assert.match(r.text, /\[2\] "zigbee2mqtt\/temp" key "temperature" -> usens 31/);
  r = await callText(client, 'myio_mqtt_set', { tls: true, server: 'Emelet' });
  assert.equal(r.isError, true); assert.match(r.text, /4\.x/);
  r = await callText(client, 'myio_mqtt', { server: 'Emelet' });
  assert.match(r.text, /Emelet MQTT client/);
});

test('values with & are refused before anything is sent', async () => {
  const from = m4.log.length;
  const r = await callText(client, 'myio_mqtt_set', { password: 'a&b' });
  assert.equal(r.isError, true); assert.match(r.text, /"&"/);
  assert.equal(m4.log.length, from);
  const r2 = await callText(client, 'myio_rename', { kind: 'relay', id: 1, name: 'Tom & Jerry' });
  assert.equal(r2.isError, true);
});

test('SG-Ready: mode is state-level, K1/K2 swap, Due supported', async () => {
  let r = await callText(client, 'myio_sgready_set', { mode: 3 });
  assert.match(r.text, /mode 3 = recommended/);
  r = await callText(client, 'myio_sgready_set', { k1: 2, k2: 1 });
  assert.match(r.text, /K1 = output 2, K2 = output 1/);
  r = await callText(client, 'myio_sgready', { server: 'Emelet' });
  assert.match(r.text, /Emelet SG-Ready heat pump: ENABLED/);
  const c = await connect({ MYIO_BASE_URL: m4.url, MYIO_WRITE: 'state' });
  try {
    assert.equal((await callText(c, 'myio_sgready_set', { mode: 2 })).isError, false);
    const x = await callText(c, 'myio_sgready_set', { limit_min: 30 });
    assert.equal(x.isError, true); assert.match(x.text, /MYIO_WRITE=state/);
  } finally { await c.close(); }
});

test('alarm: config toggles from the page, simulation, save; 4.5.8 gate', async () => {
  let r = await callText(client, 'myio_alarm_set', { enabled: true, tcp: true, account: '1234', partition_sensor: { partition: 1, usens: 40 } });
  const cmds = sent(m4, 0);
  assert.ok(cmds.includes('al_en=1') && !cmds.includes('al_tcp=1'), 'tcp already configured on -> not toggled');
  assert.ok(cmds.includes('AlarmSave=1'));
  assert.match(r.text, /ENABLED/); assert.match(r.text, /partition 1: .*-> usens 40/);
  r = await callText(client, 'myio_alarm_set', { simulate: 'Nri2/BA05' });
  assert.match(r.text, /partition 2: ALARM \(last code BA, zone 5/);
  r = await callText(client, 'myio_alarm', { server: 'Emelet' });
  assert.equal(r.isError, true); assert.match(r.text, /not available on firmware 3\.12\.33/);
});

test('MIA, LED strip, Shelly, Link, Cloud', async () => {
  let r = await callText(client, 'myio_mia_set', { features: { preheat: false }, exclude: { relay: 5, excluded: true }, window_drop_c: 0.8 });
  assert.match(r.text, /preheating no/); assert.match(r.text, /EXCLUDED from MIA actions/); assert.match(r.text, /drop 0\.8 °C/);
  r = await callText(client, 'myio_mia_set', { exclude: { relay: 9, excluded: true } });
  assert.equal(r.isError, true); assert.match(r.text, /not a MIA zone/);
  r = await callText(client, 'myio_ledstrip_set', { prog: 2, name: 'Esti', fields: { fx: 2, brightness: 120, color1: 0x00ff00 } });
  assert.match(r.text, /program 2 "Esti": fx=rainbow, speed=0, brightness=120/); assert.match(r.text, /color1=#00ff00/);
  r = await callText(client, 'myio_ledstrip_set', { prog: 2, fields: { sparkle: 1 } });
  assert.equal(r.isError, true);
  r = await callText(client, 'myio_shelly', { scan: true });
  assert.match(r.text, /#0 "Lamp" 192\.168\.1\.133/); assert.match(r.text, /webhook token \(set, hidden\)/); assert.ok(!/TOKEN123/.test(r.text)); assert.match(r.text, /\[0\] 192\.168\.1\.140/);
  r = await callText(client, 'myio_shelly_set', { action: 'bind_output', device: 0, channel: 1, output_id: 7 });
  assert.match(r.text, /ch1 follows output 7/); assert.ok(m4.log.includes('sh_save=1'));
  r = await callText(client, 'myio_shelly_set', { action: 'rename', device: 5, name: 'x' });
  assert.equal(r.isError, true); assert.match(r.text, /no Shelly in slot 5/);
  r = await callText(client, 'myio_link');
  assert.match(r.text, /myIO Link: idle/);
  r = await callText(client, 'myio_cloud');
  assert.match(r.text, /key 0: "Péter telefon" for user slot 2/); assert.ok(!/SECRETTOK|cloudpw|TK'/.test(r.text));
  const c = await connect({ MYIO_BASE_URL: m4.url, MYIO_WRITE: 'config' });
  try { const x = await callText(c, 'myio_cloud_set', { action: 'pair', user_slot: 2 }); assert.equal(x.isError, true); assert.match(x.text, /MYIO_WRITE=admin/); } finally { await c.close(); }
});

test('network: masked read, admin-only change, apply verifies reachability', async () => {
  let r = await callText(client, 'myio_network');
  assert.match(r.text, /STA SSID "Home" password \(set, hidden\)/); assert.match(r.text, /live 192\.168\.1\.60/); assert.ok(!/wifipw|appw12345/.test(r.text));
  r = await callText(client, 'myio_network_set', { host: 'bad host', apply: false });
  assert.equal(r.isError, true);
  r = await callText(client, 'myio_network_set', { host: 'konyha', sta: { dhcp: true }, apply: false });
  assert.match(r.text, /saved \(active after the next restart\)/); assert.match(r.text, /host name "konyha"/);
  assert.ok(!m4.log.includes('n_sta_dhcp=1'), 'dhcp already on'); assert.ok(m4.log.includes('NetSave=1'));
  const c = await connect({ MYIO_BASE_URL: m4.url, MYIO_WRITE: 'config' });
  try { const x = await callText(c, 'myio_network_set', { host: 'x', apply: false }); assert.equal(x.isError, true); assert.match(x.text, /MYIO_WRITE=admin/); } finally { await c.close(); }
});

test('KNX: table read, row edit + KnxSave, flags as desired values, offline panel refused, names always', async () => {
  let r = await callText(client, 'myio_knx');
  assert.match(r.text, /row 0 "Nappali lámpa": 1\/2\/3 OUT/); assert.match(r.text, /\[0\] 1\.1\.1 "Finder relé"/);
  r = await callText(client, 'myio_knx_set', { rows: [{ row: 1, ga: '2/0/7', dir: 3, dpt: 3, target: 21, invert: true, init_read: false, name: 'Hőfok' }] });
  assert.match(r.text, /row 1 "Hőfok": 2\/0\/7 SENSOR .*DPT9 float.*inverted.*-> usens 21/);
  assert.ok(m4.log.includes('KnxSave=1')); assert.ok(m4.log.includes('knx_inv1=1')); assert.ok(!m4.log.includes('knx_ir1=1'));
  r = await callText(client, 'myio_knx_set', { rows: [{ row: 1, invert: true }] });
  assert.match(r.text, /nothing to change/);
  r = await callText(client, 'myio_knx_set', { rows: [{ row: 2, ga: '1/1/1' }], server: 'Off' });
  assert.equal(r.isError, true); assert.match(r.text, /offline/);
  r = await callText(client, 'myio_knx_set', { rows: [{ row: 2, name: 'csak név' }], server: 'Off' });
  assert.equal(r.isError, false); assert.match(r.text, /row names: .*2="csak név"/); assert.ok(!/UNSAVED/.test(r.text));
  r = await callText(client, 'myio_knx_device', { action: 'program', address: '1.1.30' });
  assert.equal(r.isError, false);
  const c = await connect({ MYIO_BASE_URL: m4.url, MYIO_WRITE: 'config' });
  try { const x = await callText(c, 'myio_knx_device', { action: 'program', address: '1.1.30' }); assert.equal(x.isError, true); assert.match(x.text, /MYIO_WRITE=admin/); } finally { await c.close(); }
});

test('expanders, DALI groups as desired values, DMX, Modbus decode + bus merge', async () => {
  let r = await callText(client, 'myio_expanders');
  assert.match(r.text, /#1: configured as Ext16 I\/O; ONLINE; seen as Ext16 I\/O fw 0\.12/); assert.match(r.text, /#2: configured as Ext-KNX; offline/);
  assert.match(r.text, /failsafe on master loss: standalone/); assert.match(r.text, /28AA: 21\.5 °C/);
  r = await callText(client, 'myio_dali', { ep: 0 });
  assert.match(r.text, /ep 0: panel 1 short address 0 -> PCA 2002/); assert.match(r.text, /groups wanted 0, driver 0/);
  r = await callText(client, 'myio_dali_set', { action: 'groups', ep: 0, group: 0, member: true });
  assert.match(r.text, /nothing to change/);
  r = await callText(client, 'myio_dali_set', { action: 'groups', ep: 0, group: 3, member: true });
  assert.match(r.text, /groups wanted 0,3, driver 0,3/); assert.ok(m4.log.includes('dali_gt*0*3=1') && m4.log.includes('dali_wr*0=1'));
  r = await callText(client, 'myio_dali_set', { action: 'settings', ep: 0, max: 200 });
  assert.match(r.text, /max 200/);
  const c = await connect({ MYIO_BASE_URL: m4.url, MYIO_WRITE: 'config' });
  try { const x = await callText(c, 'myio_dali_set', { action: 'commission', panel: 1, mode: 0 }); assert.equal(x.isError, true); assert.match(x.text, /MYIO_WRITE=admin/); } finally { await c.close(); }
  r = await callText(client, 'myio_dmx');
  assert.match(r.text, /no DMX panel/);
  r = await callText(client, 'myio_modbus');
  assert.match(r.text, /block 0: slave 1 func 4 start 0 count 2 every 5 s/); assert.match(r.text, /field 0 "L1 feszültség": block 0 offset 0 f32 ABCD x10\^0 -> usens 12 = 230\.4 \(3 s old\)/);
  assert.match(r.text, /bus 19200 8N1, timeout 250 ms, retries 1, gap 10 ms/);
  r = await callText(client, 'myio_modbus_set', { action: 'bus', panel: 2, baud: 0 });
  assert.ok(m4.log.includes('mb_cfg*2*0*0*25*1*10=1'), 'unchanged fields and the DE flag kept: ' + m4.log.filter(x => x.startsWith('mb_cfg')).join(','));
  r = await callText(client, 'myio_expanders', { server: 'Emelet' });
  assert.equal(r.isError, true);
});

test('system: restart waits for the reboot; Due refused', async () => {
  let r = await callText(client, 'myio_system', { action: 'restart' });
  assert.match(r.text, /restart done - back online/); assert.match(r.text, /running 4\.18\.7/);
  r = await callText(client, 'myio_system', { action: 'restart', server: 'Emelet' });
  assert.equal(r.isError, true);
  r = await callText(client, 'myio_system', { action: 'ota_upload', file: '/nonexistent/MYIO_UPD.BIN' });
  assert.equal(r.isError, true); assert.match(r.text, /cannot read/);
});
