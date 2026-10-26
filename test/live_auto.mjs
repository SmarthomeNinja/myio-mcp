// live_auto.mjs - 3. kor elo teszt (Flow, Script, fajlok) egy 4.10+ vezerlon, VISSZAALLITO: a vegen torli, amit letrehozott.
//   MYIO_BASE_URL=http://192.168.1.60 MYIO_USERNAME=admin MYIO_PASSWORD=... LIVE_RELAY=4 LIVE_SLOT=8 node test/live_auto.mjs
//   LIVE_RELAY = egy LOGIKAI (nem bekotott) rele, LIVE_SLOT = egy URES script-slot, LIVE_HOOK_HOST = a gep LAN-IP-je (webhook-fogado :8199).
// Csak olyan vezerlon, ahol ezek szabadok (a user engedelyevel)! A flows.jsn-t, ha elotte nem volt, a vegen torli.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELAY = Number(process.env.LIVE_RELAY ?? 4), SLOT = Number(process.env.LIVE_SLOT ?? 8), FID = 90;
const HOOK_HOST = process.env.LIVE_HOOK_HOST ?? '192.168.1.63';
let pass = 0, failN = 0;
const ok = (c, m, extra = '') => { if (c) { pass++; console.log(`  ok   ${m}`); } else { failN++; console.log(`  FAIL ${m}\n${extra}`); } };

const hits = [];
const hookSrv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { hits.push({ url: req.url, body: b, method: req.method }); res.end('ok'); }); });
await new Promise(r => hookSrv.listen(8199, '0.0.0.0', r));

const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(HERE, '..', 'dist', 'index.js')], env: { ...process.env, MYIO_WRITE: 'config' }, stderr: 'inherit' });
const client = new Client({ name: 'live-auto', version: '0' });
await client.connect(transport);
const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); const t = r.content.map(c => c.text).join('\n'); return { t, err: !!r.isError }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

try {
  console.log('== Flow');
  const raw0 = await call('myio_flows', { raw: true });
  const hadFile = !raw0.t.includes('no flows.jsn yet');
  let r = await call('myio_flow_save', { flow: { id: FID, name: 'MCP teszt', en: 1, when: { t: 'boot' }, then: [{ t: 'rel', id: RELAY, act: 3 }] }, dry_run: true });
  ok(r.err && /act must be 0/.test(r.t), 'invalid card refused before writing', r.t);
  r = await call('myio_flow_save', { flow: { id: FID, name: 'MCP teszt', en: 1, when: { t: 'twin', from: 0, to: 10 }, then: [{ t: 'rel', id: RELAY, act: 1 }] }, dry_run: true });
  ok(r.err && /here/.test(r.t), 'twin is refused as a WHEN card', r.t);
  r = await call('myio_flow_save', { flow: { id: FID, name: 'MCP teszt', en: 1, when: { t: 'out', id: 16, dir: 1 }, then: [{ t: 'rel', id: RELAY, act: 1 }, { t: 'delay', s: 2 }, { t: 'rel', id: RELAY, act: 0 }] } });
  ok(!r.err && /flows.jsn written/.test(r.t) && /no parse errors/.test(r.t), 'flow written + reloaded without parse errors', r.t);
  ok(/WHEN relay 16 .*turns ON/.test(r.t) && /THEN 1\. relay 4/.test(r.t), 'flow described with names', r.t);
  r = await call('myio_flows', { id: FID });
  ok(/#90 "MCP teszt" - enabled/.test(r.t), 'live state: enabled', r.t);
  r = await call('myio_flow', { action: 'fire', id: FID });
  ok(/outputs that changed: relay 4/.test(r.t) && /manual fire|fired/.test(r.t), 'fire runs the THEN chain (relay ON + trace)', r.t);
  await sleep(2600);
  r = await call('myio_flow_trace', { limit: 10 });
  ok(/flow 90 "MCP teszt": (done|action)/.test(r.t), 'trace shows the chain finishing', r.t);
  r = await call('myio_flow', { action: 'disable', id: FID });
  ok(/DISABLED/.test(r.t), 'runtime disable', r.t);
  r = await call('myio_flow', { action: 'enable', id: FID });
  ok(/enabled/.test(r.t) && !/DISABLED/.test(r.t), 'runtime enable', r.t);
  r = await call('myio_flow', { action: 'set_var', id: 5, value: 42 });
  ok(/var5 is now 42/.test(r.t), 'set_var', r.t);
  await call('myio_flow', { action: 'set_var', id: 5, value: 0 });
  r = await call('myio_flow_save', { variable: { id: 5, name: 'mcp', init: 0 } });
  ok(!r.err && /added variable 5/.test(r.t), 'variable added', r.t);
  r = await call('myio_flow_save', { hook: { id: 3, name: 'mcp hook', met: 1, url: `http://${HOOK_HOST}:8199/myio`, body: '$dev $msg $val', gap: 1 } });
  ok(!r.err && /added webhook 3/.test(r.t), 'webhook added', r.t);
  r = await call('myio_webhook_test', { slot: 3 });
  await sleep(500);
  ok(/webhook sent \(slot 3, HTTP 200\)/.test(r.t) && hits.length >= 1, `webhook delivered to this machine (${hits.length} hit: ${JSON.stringify(hits[0] ?? null)})`, r.t);
  // takaritas
  for (const a of [{ delete: FID }, { delete_hook: 3 }, { delete_variable: 5 }]) { r = await call('myio_flow_save', a); ok(!r.err, `cleanup ${JSON.stringify(a)}`, r.t); }
  if (!hadFile) { r = await call('myio_file_op', { op: 'delete', path: '/flows.jsn' }); ok(!r.err, 'flows.jsn removed again (was absent before)', r.t); await client.callTool({ name: 'myio_send_command', arguments: { commands: 'flow_reload=1' } }); }

  console.log('== Script');
  r = await call('myio_scripts', { id: SLOT });
  ok(/\(empty\)|#\d+ "/.test(r.t), `slot ${SLOT} state read`, r.t);
  if (!/\(empty\)/.test(r.t)) throw new Error(`script slot ${SLOT} is not empty - pick another LIVE_SLOT`);
  const good = `#name MCP teszt\n#every 1s\n#enabled 0\nvar n\nn = n + 1\nif n > 3 then n = 0 end\n`;
  r = await call('myio_script_save', { id: SLOT, source: good.replace('n + 1', 'n +* 1') });
  ok(r.err === false && /compile error/.test(r.t) && /\^/.test(r.t), 'compile error reported with the source line', r.t);
  r = await call('myio_script_save', { id: SLOT, source: good });
  ok(/compiled OK, the program is OFF/.test(r.t), 'compiles OK (off)', r.t);
  r = await call('myio_script_get', { id: SLOT });
  ok(/#name MCP teszt/.test(r.t), 'source read back', r.t);
  r = await call('myio_script', { action: 'run', id: SLOT });
  ok(/manual run|runs 1/.test(r.t), 'manual run', r.t);
  r = await call('myio_script', { action: 'enable', id: SLOT, persist: true });
  ok(/#enabled 1 written/.test(r.t) && /RUNNING/.test(r.t), 'persistent enable rewrites #enabled', r.t);
  await sleep(2500);
  r = await call('myio_scripts', { id: SLOT });
  ok(/runs [2-9]/.test(r.t) && /locals: n=/.test(r.t), 'runs cyclically, locals visible', r.t);
  r = await call('myio_script', { action: 'disable', id: SLOT });
  ok(/off/.test(r.t) && /RAM only/.test(r.t), 'RAM-only disable', r.t);
  r = await call('myio_script', { action: 'delete', id: SLOT });
  ok(!r.err && /deleted/.test(r.t), 'script deleted', r.t);

  console.log('== Files');
  r = await call('myio_file_write', { path: '/mcp_test/a/hello.txt', content: 'Szia ház! 🏠', make_dirs: true });
  ok(!r.err && /created folder/.test(r.t), 'write with make_dirs', r.t);
  r = await call('myio_file_read', { path: '/mcp_test/a/hello.txt' });
  ok(/Szia ház! 🏠/.test(r.t), 'read back UTF-8', r.t);
  r = await call('myio_file_write', { path: '/mcp_test/bin.dat', base64: Buffer.from([0, 1, 2, 255, 254, 0, 7]).toString('base64') });
  ok(!r.err && /\(7 B\)/.test(r.t), 'binary write', r.t);
  r = await call('myio_file_read', { path: '/mcp_test/bin.dat', base64: true });
  ok(r.t.includes(Buffer.from([0, 1, 2, 255, 254, 0, 7]).toString('base64')), 'binary read back byte-exact', r.t);
  r = await call('myio_file_op', { op: 'rename', path: '/mcp_test/bin.dat', to: '/mcp_test/bin2.dat' });
  ok(!r.err, 'rename', r.t);
  r = await call('myio_file_op', { op: 'copy', path: '/mcp_test/a', to: '/mcp_test/b' });
  ok(!r.err, 'copy folder', r.t);
  r = await call('myio_files', { dir: '/mcp_test' });
  ok(/\[dir\]  a\//.test(r.t) && /\[dir\]  b\//.test(r.t) && /bin2\.dat/.test(r.t), 'listing', r.t);
  r = await call('myio_file_op', { op: 'delete', path: '/mcp_test/a' });
  ok(r.err, 'non-empty folder not deleted', r.t);
  r = await call('myio_file_write', { path: '/net.jsn', content: '{}' });
  ok(r.err && /MYIO_WRITE=admin/.test(r.t), 'system file needs admin', r.t);
  for (const p of ['/mcp_test/a/hello.txt', '/mcp_test/b/hello.txt', '/mcp_test/a', '/mcp_test/b', '/mcp_test/bin2.dat', '/mcp_test']) { r = await call('myio_file_op', { op: 'delete', path: p }); ok(!r.err, `cleanup ${p}`, r.t); }
} finally {
  await client.close();
  hookSrv.close();
  console.log(`\n${pass} passed, ${failN} failed`);
  process.exit(failN ? 1 : 0);
}
