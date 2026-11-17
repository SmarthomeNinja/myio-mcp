/**
 * Az MCP-szerver osszeallitasa (eszkozok, resource-ok, promptok) - a helyi szerver (index.ts) es a felhos szerver
 * (myio-cloud-mcp) kozos belepoje (CLOUD_MCP_PLAN.md 11. fej., 2026-11-15: a buildServer az index.ts-bol ide koltozott).
 *   BuildOptions.allowTool  eszkozonkenti szuro (a felhos szallitas kepesseg-kapuja: csak a mukodo eszkozok kerulnek fel)
 *   write = 'read'          csak a readOnly-annotacios eszkozok toltodnek be (az iro eszkozt a Claude nem is latja)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolsetView, Toolset, TOOLSETS, TOOLSET_INFO, ToolFilter } from './toolsets.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';
import type { Registry } from './servers.js';
import { registerBasicTools } from './tools/basic.js';
import { registerHouseTools } from './tools/house.js';
import { registerConfigTools } from './tools/config.js';
import { registerAutomationTools } from './tools/auto.js';
import { registerDiagTools } from './tools/diag.js';
import { registerIntegrationTools } from './tools/integr.js';
import { registerBusTools } from './tools/bus.js';
import { WRITE_LEVELS, type WriteLevel } from './tools/common.js';

export const VERSION = '1.6.2';

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

/** MYIO_WRITE ertelmezese (alap: config) */
export function parseWriteLevel(raw: string | undefined): WriteLevel {
  const v = (raw || 'config').toLowerCase();
  if ((WRITE_LEVELS as readonly string[]).includes(v)) return v as WriteLevel;
  console.error(`MYIO_WRITE=${v} is not ${WRITE_LEVELS.join('|')} - using config`);
  return 'config';
}

export interface BuildOptions {
  /** eszkozonkenti szuro: false = az eszkoz nem kerul fel (a toolset-szuro es a 'read' szint utan fut) */
  allowTool?: ToolFilter;
  /** az instructions szoveg helyett (a felhos szerver sajat leirasa) */
  instructions?: string;
  /** resource-ok es promptok (alap: true) - olyan szallitason kapcsolhato ki, ahol a forrasaik (naplo, var-blokk) nem erhetok el */
  resources?: boolean;
  prompts?: boolean;
  /** az iras-szint kapu hibaszovege a MYIO_WRITE-os alapszoveg helyett */
  gateMessage?: (need: WriteLevel, have: WriteLevel) => string;
  /** a szerver neve/cime az MCP-kezfogasban */
  name?: string;
  title?: string;
  version?: string;
}

export function buildServer(reg: Registry, write: WriteLevel = parseWriteLevel(process.env.MYIO_WRITE), enabled: Set<Toolset> = new Set(TOOLSETS),
                            opts: BuildOptions = {}): McpServer {
  const server = new McpServer({ name: opts.name ?? 'myio-mcp', version: opts.version ?? VERSION, title: opts.title ?? 'myIO smart home controller' },
    { instructions: opts.instructions ?? instructions(enabled) });
  const tools = new Set<string>();
  const ctx = { reg, write, tools, gateMessage: opts.gateMessage };
  // 'read' szint: csak a readOnly-annotacios eszkozok (az annotacio-szabaly a tools/common.ts-ben: RO = semmit nem valtoztat)
  const filter: ToolFilter = (name, cfg) =>
    (write !== 'read' || cfg?.annotations?.readOnlyHint === true) && (!opts.allowTool || opts.allowTool(name, cfg));
  const v = (set: Toolset) => toolsetView(server, set, enabled, tools, filter);
  registerBasicTools(v('core'), ctx);       // + a legacy keszlet (a regi fajtankenti kapcsolok) ugyanebben a modulban
  registerHouseTools(v('house'), ctx);
  registerConfigTools(v('config'), ctx);
  registerAutomationTools(v('automation'), ctx);
  registerDiagTools(v('diag'), ctx);
  registerIntegrationTools(v('integrations'), ctx);
  registerBusTools(v('expanders'), ctx);
  if (opts.resources !== false) registerResources(server, ctx);
  if (opts.prompts !== false) registerPrompts(server, ctx);
  return server;
}
