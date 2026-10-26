// live_mcp5.mjs - 5. kor elo teszt, CSAK OLVAS: resources + prompts valodi vezerlokon, plusz a Streamable HTTP-transzport.
//   LIVE_SERVERS='[{"name":"Opta","url":"http://192.168.1.60","username":"admin","password":"..."},{"name":"Dev1","url":"http://192.168.1.56",...}]' \
//   MYIO_MIN_GAP_MS=600 node test/live_mcp5.mjs            (LIVE_WHY=<elem> a why_not_switching celja, alap: az elso nevesitett kimenet)
//   LIVE_LAN_IP=192.168.1.63  -> a HTTP-t a LAN-cimre is kipobalja (0.0.0.0 + token), majd leallitja
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, '..', 'dist', 'index.js');
const SERVERS = process.env.LIVE_SERVERS;
if (!SERVERS) { console.error('set LIVE_SERVERS (JSON list like MYIO_SERVERS)'); process.exit(2); }
let pass = 0, failN = 0;
const ok = (c, m, extra = '') => { if (c) { pass++; console.log(`  ok   ${m}`); } else { failN++; console.log(`  FAIL ${m}\n${String(extra).slice(0, 1500)}`); } };
const env = { ...process.env, MYIO_SERVERS: SERVERS, MYIO_BASE_URL: '', MYIO_WRITE: 'state', MYIO_TOOLSETS: '', MYIO_HTTP_PORT: '' };
const client = new Client({ name: 'live-mcp5', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [ENTRY], env, stderr: 'inherit' }));
const timed = async (label, fn) => { const t = Date.now(); const r = await fn(); console.log(`     (${label}: ${Date.now() - t} ms)`); return r; };
const show = (t, n = 1800) => console.log(t.length > n ? t.slice(0, n) + `\n     ... (${t.length} chars)` : t);

try {
  console.log('== resources');
  const { resources } = await client.listResources();
  const slugs = [...new Set(resources.map(r => /^myio:\/\/([^/]+)\//.exec(r.uri)?.[1]).filter(s => s && s !== 'docs'))];
  ok(slugs.length === JSON.parse(SERVERS).length, `one slug per controller: ${slugs.join(', ')}`);
  for (const s of slugs) {
    const info = JSON.parse((await timed(`${s}/info`, () => client.readResource({ uri: `myio://${s}/info` }))).contents[0].text);
    ok(info.version && info.features, `${s}/info: firmware ${info.version}, flow ${info.features.flow}, dst ${info.features.dst}`);
    const st = JSON.parse((await timed(`${s}/state`, () => client.readResource({ uri: `myio://${s}/state` }))).contents[0].text);
    ok(Array.isArray(st.outputs) && Array.isArray(st.sensors), `${s}/state: ${st.outputs.length} outputs (${st.unnamed_off_omitted} unnamed OFF omitted), ${st.sensors.length} sensors${st.universal_sensors ? `, ${st.universal_sensors.length} usens` : ''}${st.inputs_named_or_closed ? `, ${st.inputs_named_or_closed.length} inputs` : ''}`);
    try {
      const log = (await timed(`${s}/log/today`, () => client.readResource({ uri: `myio://${s}/log/today` }))).contents[0].text;
      ok(log.length > 0, `${s}/log/today: ${log.split('\n').length} lines`);
    } catch (e) { ok(/no event log/.test(e.message), `${s}/log/today: ${e.message}`); }
    if (info.features.flow) {
      const f = JSON.parse((await client.readResource({ uri: `myio://${s}/flows.jsn` })).contents[0].text);
      ok(Array.isArray(f.flows), `${s}/flows.jsn: ${f.flows.length} rule(s)`);
    }
    if (info.features.script) {
      try { const p = (await client.readResource({ uri: `myio://${s}/prog/1.txt` })).contents[0].text; ok(true, `${s}/prog/1.txt: ${p.length} B`); }
      catch (e) { ok(/empty/.test(e.message), `${s}/prog/1.txt: ${e.message}`); }
    }
  }
  const idx = (await client.readResource({ uri: 'myio://docs/index' })).contents[0].text;
  ok(/myio:\/\/docs\/chapter\/10-g/.test(idx), 'docs index');

  console.log('\n== prompts');
  const diag = await timed('daily_diagnostics (all)', () => client.getPrompt({ name: 'daily_diagnostics', arguments: {} }));
  const dt = diag.messages[0].content.text;
  ok(slugs.length && /### System diagnostics/.test(dt) && /### Clock, NTP, daylight saving/.test(dt), 'daily_diagnostics: sysdiag + clock for every controller', dt);
  show(dt, 6000);
  const heat = await timed('heating_overview (all, en)', () => client.getPrompt({ name: 'heating_overview', arguments: { language: 'en' } }));
  const ht = heat.messages[0].content.text;
  ok(/### Thermostat zones/.test(ht), 'heating_overview', ht);
  show(ht, 3000);
  const first = JSON.parse(SERVERS)[0].name;
  let target = process.env.LIVE_WHY;
  if (!target) { const st = JSON.parse((await client.readResource({ uri: `myio://${slugs[0]}/state` })).contents[0].text); target = String(st.outputs.find(o => o.name && o.type !== 'group')?.id ?? 1); }
  const why = await timed(`why_not_switching ${target}`, () => client.getPrompt({ name: 'why_not_switching', arguments: { element: target, server: first } }));
  const wt = why.messages[0].content.text;
  ok(/### The element now/.test(wt) || /több kimenetre/.test(wt), `why_not_switching ${target} on ${first}`, wt);
  show(wt, 4000);
  const nf = await timed('new_flow_rule', () => client.getPrompt({ name: 'new_flow_rule', arguments: { rule: 'hétköznap 7:00-kor kapcsold be az 1-es relét', server: first } }));
  const nt = nf.messages[0].content.text;
  ok(/10\/D/.test(nt) || /nem tud Flow/.test(nt), `new_flow_rule (${nt.length} chars)`, nt.slice(0, 800));

  console.log('\n== HTTP transport');
  const TOKEN = randomBytes(18).toString('base64url');
  const host = process.env.LIVE_LAN_IP ? '0.0.0.0' : '127.0.0.1';
  const p = spawn(process.execPath, [ENTRY], { env: { ...env, MYIO_HTTP_PORT: '0', MYIO_HTTP_HOST: host, MYIO_HTTP_TOKEN: TOKEN, MYIO_STDIO: '0' }, stdio: ['ignore', 'ignore', 'pipe'] });
  const url = await new Promise((res, rej) => { let e = ''; const to = setTimeout(() => rej(new Error(e)), 8000); p.stderr.on('data', d => { e += d; const m = /listening on (http:\/\/\S+)/.exec(e); if (m) { clearTimeout(to); res(m[1]); } }); });
  try {
    const port = new URL(url).port;
    for (const h of ['127.0.0.1', ...(process.env.LIVE_LAN_IP ? [process.env.LIVE_LAN_IP] : [])]) {
      const u = `http://${h}:${port}/mcp`;
      const no = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      ok(no.status === 401, `${u}: without token -> ${no.status}`);
      const hc = new Client({ name: 'live-http', version: '0' });
      await hc.connect(new StreamableHTTPClientTransport(new URL(u), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
      const r = await timed(`HTTP myio_info via ${h}`, () => hc.callTool({ name: 'myio_info', arguments: { server: first } }));
      ok(/firmware \d/.test(r.content[0].text), `${u}: myio_info over HTTP`, r.content[0].text);
      ok((await hc.listPrompts()).prompts.length === 4, `${u}: prompts over HTTP`);
      await hc.close();
    }
  } finally { p.kill(); }
} finally {
  await client.close();
  console.log(`\n${pass} ok, ${failN} FAIL`);
  process.exitCode = failN ? 1 : 0;
}
