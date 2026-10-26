// live_integr.mjs - 4. kor elo teszt (integraciok) egy BENCH Optan, VISSZAALLITO: minden valtoztatast visszaallit.
//   MYIO_BASE_URL=http://192.168.1.60 MYIO_USERNAME=admin MYIO_PASSWORD=... LIVE_BROKER=192.168.1.63 node test/live_integr.mjs
// MQTT: a helyi brokerhez csatlakozik HA-discovery es retain NELKUL (ne szemetelje a brokert), utana visszaallitja.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BROKER = process.env.LIVE_BROKER ?? '192.168.1.63';
let pass = 0, failN = 0;
const ok = (c, m, extra = '') => { if (c) { pass++; console.log(`  ok   ${m}`); } else { failN++; console.log(`  FAIL ${m}\n${extra}`); } };
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(HERE, '..', 'dist', 'index.js')], env: { ...process.env, MYIO_WRITE: 'admin' }, stderr: 'inherit' });
const client = new Client({ name: 'live-integr', version: '0' });
await client.connect(transport);
const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return { t: r.content.map(c => c.text).join('\n'), err: !!r.isError }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

try {
  console.log('== MQTT');
  let r = await call('myio_mqtt');
  const was = { en: /MQTT client: ENABLED/.test(r.t), ret: /retain yes/.test(r.t), ha: /discovery yes/.test(r.t), host: (/broker (\S*?):/.exec(r.t) ?? [])[1] };
  ok(/password \(not set\)|password \(set, hidden\)/.test(r.t), 'password masked', r.t);
  r = await call('myio_mqtt_set', { enabled: true, host: BROKER, port: 1883, retain: false, ha_discovery: false });
  ok(!r.err && /MqttSave=1/.test(r.t) && /mq_en=1/.test(r.t) && /mq_ret=1/.test(r.t), 'enable + broker + toggles sent once each, saved', r.t);
  let connected = false;
  for (let i = 0; i < 10 && !connected; i++) { await sleep(1500); r = await call('myio_mqtt'); connected = /CONNECTED/.test(r.t); }
  ok(connected, `MQTT client connects to ${BROKER}:1883 over the Opta's WiFi`, r.t);
  r = await call('myio_mqtt_set', { retain: false });
  ok(/nothing to change/.test(r.t), 'desired value already set -> no toggle sent', r.t);
  r = await call('myio_mqtt_set', { enabled: was.en, host: was.host === '(none)' ? '' : was.host, retain: was.ret, ha_discovery: was.ha });
  ok(!r.err, 'MQTT restored', r.t);
  r = await call('myio_mqtt');
  ok(/MQTT client: disabled/.test(r.t) && /retain yes/.test(r.t) && /discovery yes/.test(r.t), 'MQTT state back to original', r.t);

  console.log('== SG-Ready / MIA / LED / Shelly / KNX / Modbus names');
  r = await call('myio_sgready'); const lim = Number((/limit (\d+) min/.exec(r.t) ?? [])[1]);
  r = await call('myio_sgready_set', { limit_min: 60 }); ok(/limit 60 min/.test(r.t), 'SG limit set', r.t);
  r = await call('myio_sgready_set', { limit_min: lim }); ok(new RegExp(`limit ${lim} min`).test(r.t), 'SG limit restored', r.t);
  r = await call('myio_mia'); const wm = Number((/within (\d+) min/.exec(r.t) ?? [])[1]);
  r = await call('myio_mia_set', { window_min: wm === 6 ? 7 : 6 }); ok(/within [67] min/.test(r.t), 'MIA window minutes set', r.t);
  r = await call('myio_mia_set', { window_min: wm }); ok(new RegExp(`within ${wm} min`).test(r.t), 'MIA restored', r.t);
  r = await call('myio_ledstrip_set', { prog: 32, name: 'MCP teszt', fields: { brightness: 77, color1: 0xff8800 } });
  ok(/program 32 "MCP teszt"/.test(r.t) && /brightness=77/.test(r.t) && /color1=#ff8800/.test(r.t), 'LED program edited live + saved', r.t);
  r = await call('myio_ledstrip_set', { prog: 32, name: '', fields: { brightness: 0, color1: 0 } }); ok(!r.err, 'LED program restored', r.t);
  r = await call('myio_shelly_set', { action: 'rename', device: 1, name: 'plug MCP' }); ok(/#1 "plug MCP"/.test(r.t), 'Shelly rename + sh_save', r.t);
  r = await call('myio_shelly_set', { action: 'rename', device: 1, name: 'plug' }); ok(/#1 "plug"/.test(r.t), 'Shelly name restored', r.t);
  r = await call('myio_shelly_set', { action: 'auth', device: 1, user: 'x', password: 'a&b' }); ok(r.err && /"&"/.test(r.t), 'value with & refused', r.t);
  r = await call('myio_knx_set', { rows: [{ row: 47, name: 'MCP sor' }] }); ok(!r.err && /knx_n47=MCP%20sor/.test(r.t), 'KNX row name saved (panel offline is fine for names)', r.t);
  r = await call('myio_knx_set', { rows: [{ row: 47, name: '' }] }); ok(!r.err, 'KNX row name cleared', r.t);
  r = await call('myio_knx_set', { rows: [{ row: 5, ga: '1/2/3', dir: 2 }] }); ok(r.err && /offline/.test(r.t), 'table edit refused while the KNX panel is offline', r.t);

  console.log('== Alarm (4.18.7 al_sim fix)');
  r = await call('myio_alarm_set', { simulate: 'Nri2/BA05' });
  ok(/partition 2: ALARM \(last code BA, zone 5/.test(r.t) && /simulated 1/.test(r.t), 'simulated burglary alarm reaches partition 2', r.t);
  r = await call('myio_alarm_set', { simulate: 'Nri2/OP01' });
  ok(/partition 2: disarmed/.test(r.t), 'simulated disarm', r.t);
  r = await call('myio_alarm_set', { reset_counters: true }); ok(/simulated 0/.test(r.t), 'counters reset', r.t);

  console.log('== System');
  r = await call('myio_system', { action: 'restart' });
  ok(/restart done - back online/.test(r.t) && /running 4\.18\.7/.test(r.t), 'restart waits and reports the version', r.t);
} finally {
  await client.close();
  console.log(`\n${pass} passed, ${failN} failed`);
  process.exit(failN ? 1 : 0);
}
