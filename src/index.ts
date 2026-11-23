#!/usr/bin/env node
/**
 * myIO MCP Server - Model Context Protocol server for the myIO smart home controller (GIGA / Opta 4.x, Due 3.12).
 * Terv + naplo: MYIO_MCP_PLAN.md (repo gyoker). API: API_REFERENCE.md (= SD_Files/js/lang/HU/API_REFERENCE.md).
 *
 * Configuration (environment variables; the Claude Desktop .mcpb asks for them as user_config):
 *   MYIO_BASE_URL         controller URL, e.g. http://192.168.1.178 (required unless MYIO_SERVERS)
 *   MYIO_USERNAME         Basic Auth user
 *   MYIO_PASSWORD         Basic Auth password
 *   MYIO_NAME             label of the controller in replies (default: host of the URL)
 *   MYIO_SERVERS          several controllers: JSON array [{"name","url","username","password"}] (overrides the three above)
 *   MYIO_WRITE            write level allowed to the AI: read (read-only tools only), state (switch outputs, thermostat targets, run
 *                         flows/scripts...), config (names, timers, scenes, structures, input/output configuration), admin (users,
 *                         permissions). Default: config.
 *   (the server itself is built in server.ts; lib.ts is the library entry for other transports, e.g. the myIO Cloud server)
 *   MYIO_TOOLSETS         which tool groups to load: core (always), legacy, house, config, automation, diag, integrations, expanders;
 *                         "all" (default), a list, or "all,-legacy,-expanders"
 *   MYIO_HTTP_PORT        also serve MCP over Streamable HTTP on this port (0 = any free one); stdio stays the default
 *   MYIO_HTTP_HOST        HTTP bind address (default 127.0.0.1; a LAN address needs MYIO_HTTP_TOKEN)
 *   MYIO_HTTP_TOKEN       bearer token for HTTP (on loopback a random one is generated and printed when unset)
 *   MYIO_STDIO            with MYIO_HTTP_PORT: "1" = keep stdio even on a terminal, "0" = HTTP only (default: stdio unless stdin is a TTY)
 *   MYIO_TIMEOUT_MS       HTTP timeout (default 10000)
 *   MYIO_MIN_GAP_MS       minimum pause between two requests to the same controller (default 150; the Due's HTTP refuses bursts)
 *   MYIO_INSECURE_PARSER  "0" = strict Node HTTP parser (default "1": lenient, the controller writes its headers by hand)
 *   MYIO_MODBUS_DISCOVERY "1" = also offer the Modbus bus discovery and the template collection (myio_modbus_discover,
 *                         myio_modbus_templates, myio_reference topic=modbus; controller 4.29+). Off by default.
 *   MYIO_MODBUS_CDN       the template collection (default https://okoslak.hu/ext2/modbus/; "off" = the bundled snapshot only)
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseToolsets } from './toolsets.js';
import { startHttp } from './http.js';
import { parseServerConfigs, buildRegistry } from './servers.js';
import { buildServer, parseWriteLevel, VERSION } from './server.js';

async function main() {
  const reg = buildRegistry(parseServerConfigs());
  const write = parseWriteLevel(process.env.MYIO_WRITE);
  const ts = parseToolsets(process.env.MYIO_TOOLSETS);
  for (const w of ts.warnings) console.error(`MYIO_TOOLSETS: ${w}`);
  const modbusDiscovery = process.env.MYIO_MODBUS_DISCOVERY === '1';
  const make = () => buildServer(reg, write, ts.enabled, { modbusDiscovery });
  console.error(`myIO MCP Server ${VERSION} starting: ${reg.clients.map((c, i) => `${c.name} -> ${c.origin} (myio://${reg.slugs[i]}/)`).join(', ')} (write level: ${write}; toolsets: ${[...ts.enabled].join(',')})`);
  const httpPort = process.env.MYIO_HTTP_PORT;
  if (httpPort !== undefined && httpPort.trim() !== '') {
    const port = parseInt(httpPort, 10);
    if (!(port >= 0 && port <= 65535)) throw new Error(`MYIO_HTTP_PORT=${httpPort} is not a port number`);
    const h = await startHttp(make, { port, host: process.env.MYIO_HTTP_HOST, token: process.env.MYIO_HTTP_TOKEN || undefined });
    console.error(`myIO MCP Server listening on ${h.url} (Streamable HTTP, Authorization: Bearer ${h.generatedToken ? h.token + '  <- generated, set MYIO_HTTP_TOKEN to keep it' : '<MYIO_HTTP_TOKEN>'})`);
    const st = process.env.MYIO_STDIO;
    if (st === '0' || (st !== '1' && process.stdin.isTTY)) return;
  }
  await make().connect(new StdioServerTransport());
  console.error('myIO MCP Server running on stdio');
}

main().catch(error => { console.error('Fatal error:', error); process.exit(1); });
