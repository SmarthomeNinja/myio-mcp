// live_config.mjs - ELO KONFIG-IRO TESZT egy padi vezerlon (Dev1 .56). Minden iras utan visszaallit; csak uresen hagyott elemeket hasznal.
//   LIVE_OK=1 MYIO_WRITE=admin MYIO_BASE_URL=http://192.168.1.56 MYIO_USERNAME=admin MYIO_PASSWORD=... node test/live_config.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

if (process.env.LIVE_OK !== '1' || !process.env.MYIO_BASE_URL) { console.error('refusing: set LIVE_OK=1 and MYIO_BASE_URL (bench controller only!)'); process.exit(2); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(HERE, '..', 'dist', 'index.js')], env: { ...process.env, MYIO_SERVERS: '', MYIO_WRITE: 'admin' }, stderr: 'inherit' });
const client = new Client({ name: 'live-config', version: '0' });
await client.connect(transport);
let pass = 0, fail = 0;
const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return { text: r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), isError: !!r.isError }; };
const check = (label, cond, detail) => { if (cond) { pass++; console.log(`PASS ${label}`); } else { fail++; console.log(`FAIL ${label}\n   ${String(detail).split('\n').slice(0, 8).join('\n   ')}`); } };

// 0. olvasok
let r = await call('myio_globals'); check('globals', /name ".*" · firmware 3\./.test(r.text) && /location 47\./.test(r.text), r.text); console.log(r.text.split('\n').slice(0, 2).join('\n'));
r = await call('myio_config_vars', { names: ['timeZone', 'hitTimeLimit'] }); check('config_vars', /timeZone = \d/.test(r.text), r.text);
const g0 = r.text.match(/hitTimeLimit = (\d+)/)?.[1];
r = await call('myio_output_config', { id: 7 }); check('output_config relay 7', /\[7\] /.test(r.text), r.text); const oc7 = r.text;
r = await call('myio_input_config'); check('input_config', /\[1\] .*hit -> /.test(r.text), r.text); console.log(r.text.split('\n').slice(0, 3).join('\n'));
r = await call('myio_structures'); check('structures', /Protection pairs \(3/.test(r.text) && /Joiner pairs/.test(r.text), r.text); console.log(r.text.split('\n').slice(0, 5).join('\n'));
r = await call('myio_scenes'); check('scenes', /slot 0: "alap"/.test(r.text), r.text); console.log(r.text.split('\n').slice(0, 3).join('\n'));
r = await call('myio_timers'); check('timers', /#\d+: /.test(r.text), r.text); console.log(r.text.split('\n').slice(0, 4).join('\n'));
r = await call('myio_users'); check('users', /slot 0: admin - admin/.test(r.text), r.text);

// 1. globalis: hitTimeLimit +1 -> vissza
r = await call('myio_set_globals', { hit_time_limit: Number(g0) + 1 }); check('set_globals hit_time_limit', new RegExp(`limit ${Number(g0) + 1} ms`).test(r.text), r.text);
r = await call('myio_set_globals', { hit_time_limit: Number(g0) }); check('restore hit_time_limit', new RegExp(`limit ${g0} ms`).test(r.text), r.text);

// 2. atnevezes: rele 7 (nevtelen a padon) -> vissza uresre
r = await call('myio_rename', { kind: 'relay', id: 7, name: 'MCP teszt' }); check('rename relay 7', /relay 7: name is now "MCP teszt"/.test(r.text), r.text);
r = await call('myio_rename', { kind: 'relay', id: 7, name: '' }); check('rename back', /relay 7: name is now ""/.test(r.text), r.text);

// 3. kimenet-konfig: rele 7 timer 5 s + alarm -> vissza
const inv7 = /inverted/.test(oc7), al7 = /alarm/.test(oc7);
r = await call('myio_set_output_config', { id: 7, timer_s: 5, alarm: !al7 }); check('set_output_config relay 7', /timer 5s/.test(r.text) && (al7 ? !/alarm/.test(r.text) : /alarm/.test(r.text)), r.text);
r = await call('myio_set_output_config', { id: 7, timer_s: 0, alarm: al7, invert: inv7 }); check('restore relay 7 config', /timer 0s/.test(r.text), r.text);

// 4. bemenet-konfig: 3-as bemenet hit -> 7, majd vissza
r = await call('myio_input_config', { id: 3 }); const hit3 = Number(r.text.match(/hit -> (?:relay |id )?(\d+)|hit -> (none)/)?.[1] ?? 0) || 0;
r = await call('myio_set_input_config', { id: 3, hit: 7 }); check('set_input_config hit', /hit -> relay 7/.test(r.text), r.text);
r = await call('myio_set_input_config', { id: 3, hit: hit3 }); check('restore input 3', r.isError === false, r.text);

// 5. szerkezet: uj vedelem-par (7/8) -> torles; csoport 17 "teszt": tagok [7,8] -> vissza
r = await call('myio_set_protection', { up: 7, down: 8 }); const pidx = r.text.match(/pair #(\d+): UP relay 7/)?.[1]; check('set_protection new', pidx !== undefined, r.text);
if (pidx !== undefined) { r = await call('myio_shutters'); check('new pair visible as shutter', /up \[7\]/.test(r.text), r.text); r = await call('myio_set_protection', { index: Number(pidx), up: 0, down: 0 }); check('clear protection', /cleared/.test(r.text), r.text); }
r = await call('myio_structures'); const g17 = r.text.match(/\[517\] teszt: (.*)/)?.[1] ?? '(empty)';
r = await call('myio_set_group', { id: 517, members: [7, 8] }); check('set_group 517', /\[517\] teszt: relay 7, relay 8/.test(r.text), r.text);
r = await call('myio_set_group', { id: 517, members: g17.startsWith('(empty)') ? [] : [...g17.matchAll(/(?:relay|PCA|FET|group) (\d+)/g)].map(m => Number(m[1])) }); check('restore group 517', !r.isError, r.text);

// 6. idozito: uj (03:00 rele 7 ON) -> torles
r = await call('myio_set_timer', { hour: 3, minute: 0, event: 2, param: 7 }); const tid = r.text.match(/created: #(\d+)/)?.[1]; check('set_timer new', tid !== undefined && /03:00, every day -> relay ON: relay 7/.test(r.text), r.text);
if (tid !== undefined) { r = await call('myio_delete_timer', { id: Number(tid) }); check('delete_timer', /deleted/.test(r.text), r.text); }

// 7. jelenet: uj slot -> torles
r = await call('myio_scene', { action: 'new', name: 'MCP teszt' }); const sidm = r.text.match(/slot (\d+): "MCP teszt"/); check('scene new', !!sidm, r.text);
if (sidm) { r = await call('myio_scene', { action: 'delete', slot: Number(sidm[1]) }); check('scene delete', !new RegExp(`slot ${sidm[1]}: "MCP teszt"`).test(r.text), r.text); }

// 8. user: uj -> torles (a jogterkep Due-n nem olvashato)
r = await call('myio_user', { action: 'new', name: 'mcpteszt', password: 'x', rights: 'user' }); const us = r.text.match(/slot (\d+): mcpteszt - user/); check('user new', !!us, r.text);
if (us) { r = await call('myio_user', { action: 'delete', slot: Number(us[1]) }); check('user delete', !/mcpteszt/.test(r.text), r.text); }
r = await call('myio_permissions', { slot: 0 }); check('permissions gate on Due', r.isError && /not readable/.test(r.text), r.text);

await client.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
