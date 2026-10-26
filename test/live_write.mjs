// live_write.mjs - ELO IRO-TESZT egy padi vezerlon (Dev1 .56: semmi nincs rakotve). Minden iras utan visszaallit.
//   LIVE_OK=1 MYIO_BASE_URL=http://192.168.1.56 MYIO_USERNAME=admin MYIO_PASSWORD=... node test/live_write.mjs
// Nem tesztre valo eles hazon! (relek kapcsolnak, kuszobok EEPROM-ba irodnak - a vegen vissza).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

if (process.env.LIVE_OK !== '1' || !process.env.MYIO_BASE_URL) { console.error('refusing: set LIVE_OK=1 and MYIO_BASE_URL (bench controller only!)'); process.exit(2); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(HERE, '..', 'dist', 'index.js')], env: { ...process.env, MYIO_SERVERS: '' }, stderr: 'inherit' });
const client = new Client({ name: 'live-write', version: '0' });
await client.connect(transport);

let pass = 0, fail = 0;
const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return { text: r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), isError: !!r.isError }; };
const check = (label, cond, detail) => { if (cond) { pass++; console.log(`PASS ${label}`); } else { fail++; console.log(`FAIL ${label}\n   ${String(detail).split('\n').slice(0, 6).join('\n   ')}`); } };
const raw = async ep => JSON.parse((await call('myio_get_status', { endpoint: ep })).text);
const find = (snap, sec, id) => Object.values(snap[sec] ?? {}).find(x => x.id === id);

// 0. azonositas
const info = await call('myio_info');
console.log(info.text.split('\n').slice(0, 3).join('\n'));
const full0 = await raw('f_sens_out.json');

// 1. rele on/off/toggle + myio_output (2 = "nappali lampa" a padi configban; nincs rakotve semmi)
const R = 2;
const r0 = find(full0, 'relays', R)?.state ?? 0;
let r = await call('myio_relay_on', { id: R });        check('relay_on', /: ON/.test(r.text) && !/!/.test(r.text), r.text);
r = await call('myio_relay_off', { id: R });           check('relay_off', /: OFF/.test(r.text) && !/!/.test(r.text), r.text);
r = await call('myio_relay_toggle', { id: R });        check('relay_toggle -> ON', /: ON/.test(r.text), r.text);
r = await call('myio_output', { id: R, action: 'off' }); check('myio_output off', /Sent: r_OFF=2/.test(r.text) && /: OFF/.test(r.text), r.text);
if (r0) await call('myio_relay_on', { id: R });

// 2. PCA szint / on / off: az elso SZABAD (nem szenzor-vezerelt, nem csoport-tag) PCA - a termosztat/napvezerles azonnal visszairna
const pcasAll = Object.values(full0.PCA ?? {});
const grpMembers = new Set(Object.values(full0.group ?? {}).flatMap(g => Object.keys(g).filter(k => /^element\d+$/.test(k)).map(k => (g[k] >= 4001 ? g[k] - 2000 : g[k]))));
const freePca = pcasAll.find(p => !p.sensor && !grpMembers.has(p.id) && p.turnON > 0 && p.pwm) ?? pcasAll.find(p => !p.sensor && !grpMembers.has(p.id) && p.turnON > 0) ?? pcasAll.find(p => !p.sensor);
const P = freePca?.id ?? 2005;
const p0 = freePca;
console.log(`PCA under test: ${P} "${p0?.description ?? ''}" (min ${p0?.turnOFF} max ${p0?.turnON})`);
const dim = !!p0?.pwm;
r = await call('myio_pca_set', { id: P, percent: 50 }); check('pca_set 50% -> 128' + (dim ? '' : ' (switch-mode: expect explanation)'), new RegExp(`Sent: PCA\\*${P}=128`).test(r.text) && (dim ? /level 128\/255/.test(r.text) : /switch-mode channel/.test(r.text)), r.text);
r = await call('myio_pca_set', { id: P, level: 200 });  check('pca_set level 200', dim ? /level 200\/255/.test(r.text) : /switch-mode channel/.test(r.text), r.text);
r = await call('myio_pca_on', { id: P });               check('pca_on -> MAX ' + (p0?.turnON ?? '?'), new RegExp(`level ${p0?.turnON ?? 255}/255`).test(r.text), r.text);
r = await call('myio_pca_off', { id: P });              check('pca_off -> MIN ' + (p0?.turnOFF ?? '?'), new RegExp(`level ${p0?.turnOFF ?? 0}/255`).test(r.text), r.text);
r = await call('myio_output', { id: P, action: 'level', level: p0?.state ?? 0 }); check('restore pca level', !r.isError, r.text);

// 3. csoport: olyan, amelynek nincs szenzor-vezerelt tagja (kulonben a szabalyzo visszair)
const hasSensor = id => { const b = id >= 4001 ? id - 2000 : id; const x = find(full0, 'relays', b) ?? find(full0, 'PCA', b); return !!(x && x.sensor); };
const g0 = Object.values(full0.group ?? {}).find(g => { const m = Object.keys(g).filter(k => /^element\d+$/.test(k)).map(k => g[k]).filter(Boolean); return m.length && !m.some(hasSensor); });
const G = g0?.id;
if (g0) {
  console.log(`group under test: ${G}`);
  const members = Object.keys(g0).filter(k => /^element\d+$/.test(k)).map(k => g0[k]).filter(Boolean);
  const before = members.map(id => { const b = id >= 4001 ? id - 2000 : id; const x = find(full0, 'relays', b) ?? find(full0, 'PCA', b); return [b, x?.state ?? 0]; });
  r = await call('myio_group_on', { id: G });  check('group_on', new RegExp(`\\[${G}\\] .*: ON`).test(r.text), r.text);
  r = await call('myio_group_off', { id: G }); check('group_off', new RegExp(`\\[${G}\\] .*: OFF`).test(r.text), r.text);
  for (const [b, st] of before) if (st) await call('myio_output', b > 2000 ? { id: b, action: 'level', level: st } : { id: b, action: 'on' });
} else console.log('skip group: every group has a sensor-controlled member');

// 4. nyers parancs + diff
r = await call('myio_send_command', { commands: 'r_ON=4&r_OFF=4' }); check('send_command diff', /Sent: r_ON=4&r_OFF=4/.test(r.text), r.text);

// 5. termosztat: rele 3 (sensor 1, on 240 off 246 a mintaban) - cel 22 -> 217/223, majd vissza
const th = await call('myio_thermostats'); console.log(th.text.split('\n').slice(0, 6).join('\n'));
const t3 = find(full0, 'relays', 3);
if (t3 && t3.sensor && t3.sensor !== 255) {
  r = await call('myio_set_thermostat', { id: 3, target: 22 }); check('set_thermostat target 22', /target 22°C/.test(r.text), r.text);
  r = await call('myio_set_thermostat', { id: 3, on: t3.sensorON / 10, off: t3.sensorOFF / 10 }); check(`restore thresholds ${t3.sensorON}/${t3.sensorOFF}`, new RegExp(`\\[on ${t3.sensorON / 10}, off ${t3.sensorOFF / 10}\\]`).test(r.text), r.text);
  const chk = find(await raw('f_sens_out.json'), 'relays', 3); check('thresholds restored (raw)', chk.sensorON === t3.sensorON && chk.sensorOFF === t3.sensorOFF, JSON.stringify(chk));
} else console.log('skip thermostat: relay 3 has no temperature sensor');
const tp = find(full0, 'PCA', 2001);
if (tp && tp.sensor && tp.sensor !== 255 && !tp.pwm && !tp.mixer) {
  r = await call('myio_set_thermostat', { id: 2001, target: 21 }); check('PCA thermostat target 21', /PCA_temp_MIN\*2001=205&PCA_temp_MAX\*2001=215/.test(r.text) && /target 21°C/.test(r.text), r.text);
  r = await call('myio_set_thermostat', { id: 2001, on: tp.sensorON / 10, off: tp.sensorOFF / 10 }); check('PCA thresholds restored', new RegExp(`\\[on ${tp.sensorON / 10}, off ${tp.sensorOFF / 10}\\]`).test(r.text), r.text);
} else console.log('skip PCA thermostat: 2001 is not a thermostat here');
// aktivator-kotes: rele 4 (nincs szenzor) -> sensor 1 -> vissza 0
const t4 = find(full0, 'relays', 4);
if (t4 && !t4.sensor) {
  r = await call('myio_set_thermostat', { id: 4, sensor: 1 }); check('bind sensor 1 to relay 4', /thermoActivator\*4=1/.test(r.text) && /\[4\]/.test(r.text) && /from/.test(r.text), r.text);
  r = await call('myio_set_thermostat', { id: 4, sensor: 0 }); check('unbind relay 4', /no longer sensor-controlled/.test(r.text), r.text);
}

// 6. redonyok
const sh = await call('myio_shutters'); console.log(sh.text.split('\n').slice(0, 4).join('\n'));
if (/#1 /.test(sh.text)) {
  r = await call('myio_shutter', { index: 1, action: 'open' });  check('shutter open', /opening/.test(r.text) && !/!/.test(r.text), r.text);
  r = await call('myio_shutter', { index: 1, action: 'close' }); check('shutter close', /closing/.test(r.text) && !/!/.test(r.text), r.text);
  r = await call('myio_shutter', { index: 1, action: 'stop' });  check('shutter stop', /stopped/.test(r.text), r.text);
} else console.log('skip shutter: no protection pairs');

// 7. RGB
const rgb = await call('myio_rgb'); console.log(rgb.text.split('\n').slice(0, 3).join('\n'));
const m = rgb.text.match(/\[(\d+)\] .*: (ON|OFF) color rgb\((\d+), (\d+), (\d+)\) brightness (\d+)/);
if (m) {
  const gid = Number(m[1]);
  r = await call('myio_set_rgb', { id: gid, r: 255, g: 64, b: 0 }); check('rgb colour', /: ON color rgb\(255, 64, 0\)/.test(r.text), r.text);
  r = await call('myio_set_rgb', { id: gid, brightness: 100 });    check('rgb brightness 100', /brightness 100\/255/.test(r.text), r.text);
  r = await call('myio_set_rgb', { id: gid, on: false });          check('rgb off', /: OFF/.test(r.text), r.text);
  if (m[2] === 'ON') await call('myio_set_rgb', { id: gid, r: Number(m[3]), g: Number(m[4]), b: Number(m[5]), brightness: Number(m[6]) });
} else console.log('skip rgb: no RGB group with R/G/B members');

// 8. bemenetek + gombszimulacio (az 1. bemenet: ket hit = vissza)
const inp = await call('myio_inputs'); console.log(inp.text.split('\n').slice(0, 3).join('\n'));
r = await call('myio_press_button', { id: 1 }); const first = r.text; check('press_button hit', /Sent: s_hit=1/.test(r.text), r.text);
if (/Outputs that changed/.test(first)) { r = await call('myio_press_button', { id: 1 }); check('press_button hit again (restore)', /Outputs that changed/.test(r.text), r.text); }
else console.log('   (input 1 has no bound action here)');

// 9. V3 kapu
r = await call('myio_usensors'); check('usens gate on V3', r.isError && /not available on firmware 3\./.test(r.text), r.text);
r = await call('myio_set_usens', { id: 1, value: 20 }); check('set_usens gate on V3', r.isError, r.text);

// 10. nevkereses
r = await call('myio_find', { query: 'konyha' }); check('find konyha', /konyha/i.test(r.text), r.text);

await client.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
