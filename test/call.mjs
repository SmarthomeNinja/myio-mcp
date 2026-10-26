// call.mjs - egy vagy tobb eszkoz kezi hivasa a hivatalos SDK-klienssel (elo probakhoz).
//   MYIO_BASE_URL=http://192.168.1.60 MYIO_USERNAME=admin MYIO_PASSWORD=... node test/call.mjs myio_flows '{}' myio_sysdiag '{"raw":true}'
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
if (!argv.length) { console.error('usage: node test/call.mjs <tool> [json-args] [<tool> [json-args]] ...'); process.exit(2); }
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(HERE, '..', 'dist', 'index.js')], env: { ...process.env }, stderr: 'inherit' });
const client = new Client({ name: 'call', version: '0' });
await client.connect(transport);
for (let i = 0; i < argv.length; i++) {
  const name = argv[i];
  const args = argv[i + 1] && argv[i + 1].trim().startsWith('{') ? JSON.parse(argv[++i]) : {};
  const t = Date.now();
  const r = await client.callTool({ name, arguments: args });
  console.log(`\n=== ${name} ${JSON.stringify(args)} (${Date.now() - t} ms${r.isError ? ', ERROR' : ''})`);
  console.log(r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'));
}
await client.close();
