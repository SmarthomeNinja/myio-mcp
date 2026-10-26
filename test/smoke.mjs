// smoke.mjs - elo fust-teszt CSAK OLVASO eszkozokkel egy valodi vezerlon (nem ir semmit).
//   MYIO_BASE_URL=http://192.168.1.56 MYIO_USERNAME=admin MYIO_PASSWORD=... npm run smoke
//   (vagy MYIO_SERVERS JSON-nal tobb vezerlo; SMOKE_FIND=nappali a nevkereses probaja)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.MYIO_BASE_URL && !process.env.MYIO_SERVERS) { console.error('set MYIO_BASE_URL (+ MYIO_USERNAME / MYIO_PASSWORD) or MYIO_SERVERS'); process.exit(2); }
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(HERE, '..', 'dist', 'index.js')], env: { ...process.env }, stderr: 'inherit' });
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(transport);
const calls = [['myio_servers', {}], ['myio_info', {}], ['myio_list_devices', {}], ['myio_read_sensors', {}], ['myio_inputs', {}], ['myio_thermostats', {}], ['myio_shutters', {}], ['myio_rgb', {}], ['myio_usensors', {}]];
if (process.env.SMOKE_FIND) calls.push(['myio_find', { query: process.env.SMOKE_FIND }]);
for (const [name, args] of calls) {
  const t = Date.now();
  const r = await client.callTool({ name, arguments: args });
  console.log(`\n=== ${name} (${Date.now() - t} ms${r.isError ? ', ERROR' : ''})`);
  console.log(r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'));
}
await client.close();
