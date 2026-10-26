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
 *   MYIO_WRITE            write level allowed to the AI: state (switch outputs, thermostat targets, run flows/scripts...), config (names, timers,
 *                         scenes, structures, input/output configuration), admin (users, permissions). Default: config.
 *   MYIO_TOOLSETS         which tool groups to load: core (always), legacy, house, config, automation, diag, integrations, expanders;
 *                         "all" (default), a list, or "all,-legacy,-expanders"
 *   MYIO_HTTP_PORT        also serve MCP over Streamable HTTP on this port (0 = any free one); stdio stays the default
 *   MYIO_HTTP_HOST        HTTP bind address (default 127.0.0.1; a LAN address needs MYIO_HTTP_TOKEN)
 *   MYIO_HTTP_TOKEN       bearer token for HTTP (on loopback a random one is generated and printed when unset)
 *   MYIO_STDIO            with MYIO_HTTP_PORT: "1" = keep stdio even on a terminal, "0" = HTTP only (default: stdio unless stdin is a TTY)
 *   MYIO_TIMEOUT_MS       HTTP timeout (default 10000)
 *   MYIO_MIN_GAP_MS       minimum pause between two requests to the same controller (default 150; the Due's HTTP refuses bursts)
 *   MYIO_INSECURE_PARSER  "0" = strict Node HTTP parser (default "1": lenient, the controller writes its headers by hand)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseToolsets, toolsetView, Toolset, TOOLSETS, TOOLSET_INFO } from './toolsets.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';
import { startHttp } from './http.js';
import { parseServerConfigs, buildRegistry, Registry } from './servers.js';
import { registerBasicTools } from './tools/basic.js';
import { registerHouseTools } from './tools/house.js';
import { registerConfigTools } from './tools/config.js';
import { registerAutomationTools } from './tools/auto.js';
import { registerDiagTools } from './tools/diag.js';
import { registerIntegrationTools } from './tools/integr.js';
import { registerBusTools } from './tools/bus.js';
import type { WriteLevel } from './tools/common.js';

export const VERSION = '1.6.0';

const BASE_INSTRUCTIONS = `Tools for myIO smart home controllers (real hardware on the LAN; HTTP Basic auth).
- Call myio_servers / myio_info first: the firmware version decides the feature set (3.12.x Due = base features; 4.x GIGA/Opta = everything).
  With several controllers every tool takes a \`server\` name; without it the first one is used.
- Element ids are shared by every tool: relays 1..RQ, FET/PWM 101..116 (legacy), groups 501.., PCA dimmer channels 2001..2000+PCAQ,
  scene load 1000+slot (button/timer targets). myio_find maps names to ids; myio_list_devices shows roles (thermostat, shutter-up/down, rgb:<group> ...).
- Entities: myio_thermostats / myio_set_thermostat (zones), myio_shutters / myio_shutter (UP/DOWN pairs), myio_rgb / myio_set_rgb,
  myio_inputs / myio_press_button (wall buttons), myio_usensors / myio_set_usens (4.x universal sensors), myio_output (any output).
- Configuration (editor level, MYIO_WRITE=config): myio_globals, myio_rename, myio_output_config, myio_input_config (button actions),
  myio_structures (protection pairs = shutters, joiners, groups), myio_scenes / myio_scene (configuration slots), myio_timers / myio_set_timer,
  myio_config_vars (any raw setting). Users and permissions need MYIO_WRITE=admin.
- Automation (GIGA/Opta): myio_flows / myio_flow_save / myio_flow / myio_flow_trace (Flow rules, 4.4+), myio_scripts / myio_script_get /
  myio_script_save / myio_script (myIO Script programs, 4.10+). Read myio_reference topic=flow|script before writing rules or programs.
- Diagnostics: myio_sysdiag (health, resets, sockets, RAM), myio_metrics, myio_logs / myio_log (daily CSV logs; the event log explains
  most "why did X happen" questions), myio_files / myio_file_read / myio_file_write / myio_file_op (storage), myio_fm_sync (SD mirror).
- Integrations (each has a read tool and a _set tool): myio_shelly, myio_link (other myIO controllers), myio_mqtt, myio_cloud (admin),
  myio_sgready (heat pump), myio_alarm (SIA alarm panel receiver), myio_mia (self-learning heating), myio_ledstrip, myio_network (admin to change),
  myio_system (restart / web OTA, admin). Opta RS485 expanders: myio_expanders, myio_knx / myio_knx_set / myio_knx_device, myio_dali, myio_dmx, myio_modbus.
  Passwords, keys and tokens are never shown. Offline expander panels silently ignore commands - trust the read-back.
- Units: tools speak in real units (°C, %, W, V, A). Raw JSON (myio_get_status) is fixed point: temp x100, hum x10,
  thresholds x10 (215 = 21.5), PCA/FET level raw 0..255.
- Writes are real and take effect immediately. Every control tool reads the state back and reports it; a command the account
  has no permission for is silently dropped by the controller, so trust the read-back, not the request. Flags of toggle type are
  handled by the tools (read first, send only on change) - with myio_send_command you must do that yourself.
- The controller has very few sockets: tools already serialize requests; do not poll faster than once per second.
- Resources (attachable context, no tool call needed): myio://<controller>/info | /state | /flows.jsn, myio://<controller>/prog/<n>.txt,
  myio://<controller>/log/<today|yesterday|YYYY-MM-DD>, and the bundled Hungarian API reference myio://docs/index | /script | /flow | /chapter/<id>.
- Prompts: heating_overview, why_not_switching (element), daily_diagnostics, new_flow_rule - each reads the controller first (language hu | en).`;

export function instructions(enabled: Set<Toolset> = new Set(TOOLSETS)): string {
  const off = TOOLSETS.filter(t => !enabled.has(t));
  if (!off.length) return BASE_INSTRUCTIONS;
  return `${BASE_INSTRUCTIONS}\n- Toolsets loaded (MYIO_TOOLSETS): ${TOOLSETS.filter(t => enabled.has(t)).join(', ')}. Not loaded: ${off.map(t => `${t} (${TOOLSET_INFO[t]})`).join('; ')} - `
    + 'tools of those groups mentioned above are not available here; say so if the user needs them.';
}
export const INSTRUCTIONS = BASE_INSTRUCTIONS;

function writeLevel(): WriteLevel {
  const v = (process.env.MYIO_WRITE || 'config').toLowerCase();
  if (v === 'state' || v === 'config' || v === 'admin') return v;
  console.error(`MYIO_WRITE=${v} is not state|config|admin - using config`);
  return 'config';
}

export function buildServer(reg: Registry, write: WriteLevel = writeLevel(), enabled: Set<Toolset> = new Set(TOOLSETS)): McpServer {
  const server = new McpServer({ name: 'myio-mcp', version: VERSION, title: 'myIO smart home controller' }, { instructions: instructions(enabled) });
  const tools = new Set<string>();
  const ctx = { reg, write, tools };
  const v = (set: Toolset) => toolsetView(server, set, enabled, tools);
  registerBasicTools(v('core'), ctx);       // + a legacy keszlet (a regi fajtankenti kapcsolok) ugyanebben a modulban
  registerHouseTools(v('house'), ctx);
  registerConfigTools(v('config'), ctx);
  registerAutomationTools(v('automation'), ctx);
  registerDiagTools(v('diag'), ctx);
  registerIntegrationTools(v('integrations'), ctx);
  registerBusTools(v('expanders'), ctx);
  registerResources(server, ctx);
  registerPrompts(server, ctx);
  return server;
}

async function main() {
  const reg = buildRegistry(parseServerConfigs());
  const write = writeLevel();
  const ts = parseToolsets(process.env.MYIO_TOOLSETS);
  for (const w of ts.warnings) console.error(`MYIO_TOOLSETS: ${w}`);
  const make = () => buildServer(reg, write, ts.enabled);
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
