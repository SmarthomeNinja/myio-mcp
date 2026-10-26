// config.test.mjs - 2. kor: globalisok, nevek, kimenet-/bemenet-konfig, szerkezetek, jelenetek, idozitok, userek, jogok, iras-szint kapu.
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
  m4 = await startMock({ version: '4.8.10' }); m3 = await startMock({ version: '3.12.30' });
  client = await connect({ MYIO_SERVERS: JSON.stringify([{ name: 'Földszint', url: m4.url }, { name: 'Emelet', url: m3.url }]) });
});
after(async () => { await client.close(); await m4.close(); await m3.close(); });

test('roster: 102 tools incl. 21 config tools', async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 102);
  for (const n of ['myio_globals', 'myio_set_globals', 'myio_rename', 'myio_output_config', 'myio_set_output_config', 'myio_input_config', 'myio_set_input_config', 'myio_structures', 'myio_set_protection', 'myio_set_joiner', 'myio_set_group', 'myio_scenes', 'myio_scene', 'myio_timers', 'myio_set_timer', 'myio_delete_timer', 'myio_users', 'myio_user', 'myio_permissions', 'myio_set_permissions', 'myio_config_vars']) assert.ok(tools.find(t => t.name === n), n);
  assert.equal(tools.find(t => t.name === 'myio_user').annotations.destructiveHint, true);
});

test('write-level gate: state blocks config and admin tools', async () => {
  const c = await connect({ MYIO_BASE_URL: m4.url, MYIO_WRITE: 'state' });
  try {
    let r = await callText(c, 'myio_rename', { kind: 'relay', id: 7, name: 'x' });
    assert.equal(r.isError, true); assert.match(r.text, /MYIO_WRITE=state/);
    r = await callText(c, 'myio_relay_on', { id: 7 }); assert.equal(r.isError, false);
    r = await callText(c, 'myio_globals'); assert.equal(r.isError, false);
  } finally { await c.close(); }
  const c2 = await connect({ MYIO_BASE_URL: m4.url, MYIO_WRITE: 'config' });
  try { const r = await callText(c2, 'myio_user', { action: 'new' }); assert.equal(r.isError, true); assert.match(r.text, /MYIO_WRITE=config/); } finally { await c2.close(); }
});

test('globals read + set (V4 protCooldown; V3 refuses it)', async () => {
  let r = await callText(client, 'myio_globals');
  assert.match(r.text, /name "Mock" · firmware 4\.8\.10/); assert.match(r.text, /time zone UTC\+2 · sunrise 07:16 · sunset 17:39 · location 47\.444126, 19\.029472/);
  assert.match(r.text, /hit \(short press\) limit 30 ms, press \(long\) 400 ms · protection cooldown 10 s/);
  r = await callText(client, 'myio_set_globals', { name: 'Földszint teszt', time_zone: 1, hit_time_limit: 40, prot_cooldown: 15, consumption_unit: 'kWh' });
  assert.match(r.text, /Sent: MYIOname=F%C3%B6ldsz%C3%B6?ldszint%20teszt|Sent: MYIOname=F%C3%B6ldszint%20teszt/); assert.match(r.text, /name "Földszint teszt"/); assert.match(r.text, /UTC\+1/); assert.match(r.text, /limit 40 ms/); assert.match(r.text, /cooldown 15 s/); assert.match(r.text, /pulses \/ kWh/);
  r = await callText(client, 'myio_set_globals', { prot_cooldown: 5, server: 'Emelet' });
  assert.equal(r.isError, true); assert.match(r.text, /protection cooldown is not available on firmware 3\.12\.30/);
  r = await callText(client, 'myio_set_globals', { server: 'Emelet' }); assert.equal(r.isError, true);
  r = await callText(client, 'myio_config_vars', { names: ['timeZone', 'nope'] }); assert.match(r.text, /timeZone = 1/); assert.match(r.text, /nope = \(not present\)/);
  r = await callText(client, 'myio_config_vars', { prefix: 'PCA_P' }); assert.match(r.text, /PCA_PWM = \[/);
});

test('automatic DST (3.12.35 / 4.18.9+): read, auto_dst value-set, old firmware refuses', async () => {
  const m = await startMock({ version: '4.18.9' }), m35 = await startMock({ version: '3.12.35' });
  const c = await connect({ MYIO_SERVERS: JSON.stringify([{ name: 'Uj', url: m.url }, { name: 'Due', url: m35.url }, { name: 'Regi', url: m3.url }]) });
  try {
    let r = await callText(c, 'myio_globals');
    assert.match(r.text, /time zone UTC\+2 \(standard\/winter offset\) · automatic DST \(EU\) on, now (summer|standard) time → in force UTC\+[23]/);
    r = await callText(c, 'myio_set_globals', { auto_dst: false });
    assert.match(r.text, /Sent: dst_auto=0/); assert.match(r.text, /automatic DST \(EU\) off \(the time zone is the full offset\)/);
    r = await callText(c, 'myio_set_globals', { auto_dst: true, time_zone: 1 });
    assert.match(r.text, /Sent: dst_auto=1&tz=1/); assert.match(r.text, /time zone UTC\+1 \(standard\/winter offset\) · automatic DST \(EU\) on/);
    r = await callText(c, 'myio_set_globals', { auto_dst: false, server: 'Due' }); assert.match(r.text, /Sent: dst_auto=0/); assert.match(r.text, /automatic DST \(EU\) off/);
    r = await callText(c, 'myio_set_globals', { auto_dst: true, server: 'Regi' });
    assert.equal(r.isError, true); assert.match(r.text, /automatic daylight saving time is not available on firmware 3\.12\.30 \(needs/);
    r = await callText(c, 'myio_globals', { server: 'Regi' }); assert.doesNotMatch(r.text, /automatic DST/);
  } finally { await c.close(); await m.close(); await m35.close(); }
});

test('rename: relay, pca (1-based), group, input, scene; read back from setup', async () => {
  let r = await callText(client, 'myio_rename', { kind: 'relay', id: 7, name: 'Pince lámpa' });
  assert.match(r.text, /Sent: r_descr\*7=Pince%20l%C3%A1mpa/); assert.match(r.text, /relay 7: name is now "Pince lámpa"/);
  r = await callText(client, 'myio_rename', { kind: 'pca', id: 2007, name: 'Teszt PCA' }); assert.match(r.text, /p_descr\*7=/); assert.match(r.text, /pca 7: name is now "Teszt PCA"/);
  r = await callText(client, 'myio_rename', { kind: 'group', id: 502, name: 'Mennyezet' }); assert.match(r.text, /g_descr\*2=/); assert.match(r.text, /group 2: name is now "Mennyezet"/);
  r = await callText(client, 'myio_rename', { kind: 'input', id: 3, name: 'Fürdő gomb' }); assert.match(r.text, /s_descr\*3=/); assert.match(r.text, /input 3: name is now "Fürdő gomb"/);
  r = await callText(client, 'myio_rename', { kind: 'scene', id: 1, name: 'Mentés' }); assert.match(r.text, /slo_descr\*1=/); assert.match(r.text, /scene 1: name is now "Mentés"/);
  r = await callText(client, 'myio_rename', { kind: 'usens', id: 1, name: 'x', server: 'Emelet' }); assert.equal(r.isError, true);
  const lst = await callText(client, 'myio_list_devices', { type: 'relay' }); assert.match(lst.text, /\[7\] Pince lámpa/);
});

test('output config: read, desired-value toggles, timers, PCA min/max/pwm', async () => {
  let r = await callText(client, 'myio_output_config', { id: 1 });
  assert.match(r.text, /\[1\] hangulat fény \(relay\): timer 120s, delay 0s, sensor sun \[on at sunset, off at sunrise\] \{inverted\}/);
  r = await callText(client, 'myio_set_output_config', { id: 1, timer_s: 60, invert: true, alarm: true });
  assert.match(r.text, /Sent: r_timer\*1=60&relaysAlarm=1$/m); assert.match(r.text, /timer 60s/); assert.match(r.text, /\{inverted, alarm\}/);
  r = await callText(client, 'myio_set_output_config', { id: 1, invert: true, alarm: true });
  assert.match(r.text, /Nothing to change/);
  r = await callText(client, 'myio_set_output_config', { id: 2007, min: 10, max: 200, fade_speed: 5, pwm: true, delay_s: 3 });
  assert.match(r.text, /Sent: PCA_timer|Sent: PCA_delay\*2007=3&PCAMIN\*2007=10&PCAMAX\*2007=200&PCAFadeSpeed\*2007=5&PCA_PWM=2007/);
  assert.match(r.text, /\[2007\] Teszt PCA \(pca\): timer 0s, delay 3s, min 10, max 200, fade speed 5 \{inverted, PWM\}/);
  r = await callText(client, 'myio_set_output_config', { id: 1, min: 5 }); assert.equal(r.isError, true);
  r = await callText(client, 'myio_output_config', { type: 'pca' }); assert.match(r.text, /\[2001\] nappali fűtés \(pca\)/); assert.doesNotMatch(r.text, /\(relay\)/);
});

test('input config: read with targets, set flags + events', async () => {
  let r = await callText(client, 'myio_input_config');
  assert.match(r.text, /\[1\] Nappali gomb: enabled · hit -> relay 1 "hangulat fény" · press -> relay 2 "nappali lámpa" · release -> relay 2/);
  assert.match(r.text, /\[2\] Konyha gomb: enabled · hit -> relay 4 "konyha lámpa"/);
  r = await callText(client, 'myio_set_input_config', { id: 3, enabled: true, nc: false, hit: 2003, press: 1001, release: 0 });
  assert.match(r.text, /Sent: hitEvent\*3=2003&pressEvent\*3=1001&releaseEvent\*3=0/);
  assert.match(r.text, /\[3\] Fürdő gomb: enabled · hit -> PCA 2003 "konyha fűtés" · press -> load scene 1 "Mentés" \(all\)/);
  r = await callText(client, 'myio_set_input_config', { id: 3, enabled: false, hit_block: true });
  assert.match(r.text, /Sent: switchEnabled=3&hitBlockEnabled=3/); assert.match(r.text, /DISABLED, hit-block/);
});

test('structures: list, protection pair (free index), joiner, group members + pullUp', async () => {
  let r = await callText(client, 'myio_structures');
  assert.match(r.text, /#0: UP relay 12 "R\. Konyha Fix FEL" \/ DOWN relay 13 "R\. Konyha Fix LE"/);
  assert.match(r.text, /#0: group 502 "Mennyezet" -> PCA 2009/);
  assert.match(r.text, /\[501\] RGB PCA 501 regulation: PCA 2018 fade "R ledszalag", PCA 2019 fade "G ledszalag"/);
  r = await callText(client, 'myio_set_protection', { up: 10, down: 14, priority: true });
  assert.match(r.text, /Sent: relayProtection\*2\*0=10&relayProtection\*2\*1=14&protectionPriority=2/); assert.match(r.text, /pair #2: UP relay 10 "R\. WC FEL" \/ DOWN relay 14 "R\. Sarok K\. LE" \[priority\]/);
  const sh = await callText(client, 'myio_shutters'); assert.match(sh.text, /#3 R\. : stopped \(up \[10\]|#3 .*: stopped \(up \[10\]/);
  r = await callText(client, 'myio_set_protection', { index: 2, up: 0, down: 0 }); assert.match(r.text, /pair #2: cleared/);
  r = await callText(client, 'myio_set_joiner', { master: 4, slave: 5, just_on: true });
  assert.match(r.text, /Sent: relayJoiner\*1\*0=4&relayJoiner\*1\*1=5&joinerJustON=1/); assert.match(r.text, /joiner #1: relay 4 "konyha lámpa" -> relay 5 "lépcsőház lámpa" \[justOn\]/);
  r = await callText(client, 'myio_set_group', { id: 503, members: [7, 8, 2007], pull_up: true, name: 'Teszt csoport' });
  assert.match(r.text, /relay_group\*2\*0=7&relay_group\*2\*1=8&relay_group\*2\*2=2007/); assert.match(r.text, /pullUpGroup=2/); assert.match(r.text, /g_descr\*3=/);
  assert.match(r.text, /\[503\] Teszt csoport: relay 7 "Pince lámpa", relay 8, PCA 2007 "Teszt PCA" \[pullUp\]/);
  r = await callText(client, 'myio_group_on', { id: 503 }); assert.match(r.text, /\[503\] Teszt csoport: ON/);
  r = await callText(client, 'myio_set_group', { id: 503, members: [7, 8, 2007], pull_up: true }); assert.match(r.text, /Nothing to change/);
  r = await callText(client, 'myio_set_group', { id: 503, members: [] }); assert.match(r.text, /relay_group\*2\*0=0&relay_group\*2\*1=0&relay_group\*2\*2=0/);
  r = await callText(client, 'myio_set_group', { id: 503, members: Array(11).fill(7) }); assert.equal(r.isError, true);
});

test('scenes: list, new (named), save, set_boot, load, delete rules', async () => {
  let r = await callText(client, 'myio_scenes');
  assert.match(r.text, /current slot 0, boot slot 0/); assert.match(r.text, /slot 0: "alap" <- current \[boot\]/); assert.match(r.text, /slot 1: "Mentés"/);
  r = await callText(client, 'myio_scene', { action: 'new', name: 'Nyár' });
  assert.match(r.text, /Sent: new_slot=1&slo_descr\*2=Ny%C3%A1r/); assert.match(r.text, /slot 2: "Nyár"/);
  r = await callText(client, 'myio_scene', { action: 'set_boot', slot: 2 }); assert.match(r.text, /boot slot 2/);
  r = await callText(client, 'myio_scene', { action: 'delete', slot: 2 }); assert.match(r.text, /slot 2: "Nyár"/);   // boot slot: a fw nem torli
  r = await callText(client, 'myio_scene', { action: 'set_boot', slot: 0 });
  r = await callText(client, 'myio_scene', { action: 'load', slot: 1 }); assert.match(r.text, /Sent: lo_all=1/); assert.match(r.text, /current slot 1/);
  r = await callText(client, 'myio_scene', { action: 'save', slot: 1 }); assert.match(r.text, /Sent: sav_all=1/);
  r = await callText(client, 'myio_scene', { action: 'delete', slot: 2 }); assert.doesNotMatch(r.text, /slot 2:/);
  r = await callText(client, 'myio_scene', { action: 'load', slot: 9 }); assert.equal(r.isError, true);
});

test('timers: list, create (new id), sunset offset, change, delete', async () => {
  let r = await callText(client, 'myio_timers');
  assert.match(r.text, /#0: 19:00, every day -> relay ON: relay 46 "ESP-5- Akvárium"/);
  assert.match(r.text, /#1: 30 min after sunset, every day -> relay OFF: relay 46/);
  r = await callText(client, 'myio_set_timer', { hour: 6, minute: 30, days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], event: 'relay ON', param: 4 });
  assert.match(r.text, /Sent: t_id=2&t_month=80&t_day=80&t_hour=6&t_minute=30&t_days=124&t_sunrise=0&t_sunset=0&t_event=2&t_eventParam=4/);
  assert.match(r.text, /created: #2: 06:30, Mon,Tue,Wed,Thu,Fri -> relay ON: relay 4 "konyha lámpa"/);
  r = await callText(client, 'myio_set_timer', { id: 2, sunrise: 'before', hour: 0, minute: 45, event: 1, param: 1 });
  assert.match(r.text, /changed: #2: 45 min before sunrise, every day -> load scene \(all\): slot 1 "Mentés"/);
  r = await callText(client, 'myio_set_timer', { id: 3, hour: 12, minute: 0, month: 12, day: 24, event: 18, param: 3 });
  assert.match(r.text, /#3: 12:00 on 12\/24, every day -> SG-Ready mode: mode 3/);
  r = await callText(client, 'myio_set_timer', { hour: 1, minute: 2, event: 'nope', param: 1 }); assert.equal(r.isError, true);
  r = await callText(client, 'myio_set_timer', { event: 2, param: 1 }); assert.equal(r.isError, true);
  r = await callText(client, 'myio_delete_timer', { id: 3 }); assert.match(r.text, /deleted; 3 timer\(s\) remain/);
  r = await callText(client, 'myio_delete_timer', { id: 3 }); assert.equal(r.isError, true);
  const t3 = await callText(client, 'myio_timers', { server: 'Emelet' }); assert.match(t3.text, /#0: 19:00/);
});

test('users + permissions (4.x map, V3 gate)', async () => {
  let r = await callText(client, 'myio_users');
  assert.match(r.text, /slot 0: admin - admin/); assert.match(r.text, /slot 1: editor - editor/);
  r = await callText(client, 'myio_user', { action: 'new', name: 'vendeg', password: 'titok', rights: 'user' });
  assert.match(r.text, /Sent: new_userSlot=1&userName\*2=vendeg&pwd\*2=<base64 hidden>&rights\*2=user/); assert.match(r.text, /slot 2: vendeg - user/);
  assert.equal(Buffer.from(decodeURIComponent(m4.cfg.userPw[2]), 'base64').toString(), 'vendeg:titok');
  r = await callText(client, 'myio_user', { action: 'set_rights', slot: 2, rights: 'editor' }); assert.match(r.text, /slot 2: vendeg - editor/);
  r = await callText(client, 'myio_user', { action: 'delete', slot: 0 }); assert.equal(r.isError, true);
  r = await callText(client, 'myio_permissions', { slot: 1 });
  assert.match(r.text, /relay read: ALL/); assert.match(r.text, /relay write: none/); assert.match(r.text, /input hit: none/);
  r = await callText(client, 'myio_set_permissions', { slot: 1, grant: { relay_write: [1, 2, 3], input_hit: [1] }, revoke: { relay_read: [64] } });
  assert.match(r.text, /permissionsUser=1&rWritePermission=1&rWritePermission=2&rWritePermission=3&swHitPermission=1&rReadPermission=64/);
  assert.match(r.text, /relay_write: 1, 2, 3/); assert.match(r.text, /input_hit: 1/);
  r = await callText(client, 'myio_set_permissions', { slot: 1, grant: { relay_write: [1, 2] } }); assert.match(r.text, /Nothing to change/);
  r = await callText(client, 'myio_set_permissions', { slot: 1, clear: true }); assert.match(r.text, /relay_read: none/);
  r = await callText(client, 'myio_user', { action: 'delete', slot: 2 }); assert.doesNotMatch(r.text, /slot 2:/);
  r = await callText(client, 'myio_permissions', { slot: 1, server: 'Emelet' }); assert.equal(r.isError, true); assert.match(r.text, /not readable on firmware 3\.12\.30/);
  r = await callText(client, 'myio_set_permissions', { slot: 1, fill: true, grant: { relay_write: [5] }, server: 'Emelet' });
  assert.match(r.text, /Sent: fillPermission=1&permissionsUser=1&rWritePermission=5/); assert.match(r.text, /toggles applied as given/);
});
