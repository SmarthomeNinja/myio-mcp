# myIO MCP Server

Model Context Protocol (MCP) server for the **myIO smart home controller** (Arduino GIGA / Finder Opta 4.x and Arduino Due 3.12).
It lets an AI assistant (Claude Desktop, Claude Code, any MCP client) read the state of the house and switch, dim and
configure it through the controller's HTTP API.

Plan and log (Hungarian): `../MYIO_MCP_PLAN.md`. The complete API the server is built on: [API_REFERENCE.md](./API_REFERENCE.md)
(a copy of the firmware's own reference, Hungarian).

## Status (1.6.0, 2026-10-26)

Rounds 0-5 of the plan: the February 2026 server fixed, put on tests, extended with the house entities, the configuration layer,
automation (Flow rules, myIO Script programs), diagnostics / logs / files, every integration and RS485 expander - and in round 5 the MCP
layer: **resources**, **prompts**, **toolsets**, consistent **annotations** and an optional **Streamable HTTP** transport.

- native `node:http` client (no more `curl`), one request at a time per controller, `Connection: close`
- correct value scales: temperature ×100, humidity ×10, SDM voltage/current ×10, SDM power in W, **PCA/FET level raw 0..255**
- every control tool **reads the state back** and reports what the controller actually did (a command the account has no
  permission for is silently dropped by the firmware)
- several controllers in one server (`MYIO_SERVERS`), every tool takes a `server` name
- version gate: V3 (Due 3.12) and V4 (GIGA/Opta 4.x) both supported, 4.x-only features answer with a clear error on a Due
- entities modelled like the myIO app / Homey / Home Assistant integration: thermostat zones, shutters (protection pairs),
  RGB groups, wall inputs, universal sensors
- configuration layer: globals, names, output/input configuration, protection pairs / joiners / groups, scenes, timers, users and permissions - toggle-type settings are read first and only sent when they must change
- automation: Flow rules described in plain words with element names, validated against the firmware's card rules BEFORE upload
  (the firmware silently disables a rule with a bad card), saved + reloaded + read back; scripts written, compiled on the controller,
  compile errors returned with the offending source line; the complete script language reference is a tool (`myio_reference`)
- diagnostics: health snapshot (resets, loop stalls, RAM, sockets, WiFi, NTP on a Due), Prometheus metrics, daily logs with level / text / time filters,
  file manager on internal flash and SD card (system files need `MYIO_WRITE=admin`)
- integrations: Shelly, myIO Link, MQTT, myIO Cloud, SG-Ready, alarm panel (SIA), MIA, LED strips, network, restart / web OTA; Opta expanders:
  failsafe / AUX / 1-Wire, KNX (table, names, ETS interface, device programming), DALI, DMX, Modbus RTU. Toggle-type settings are always
  given as desired values; passwords, keys and tokens are never returned; a value containing `&` is refused (the firmware cannot receive it)
- write level (`MYIO_WRITE` = state | config | admin) limits what the AI may change
- MCP layer: resources (`myio://<controller>/state` ...), four prompts in Hungarian and English that read the controller first, toolsets
  (`MYIO_TOOLSETS`) to save context, annotations that follow one rule set, Streamable HTTP for other LAN clients (bearer token)
- zod input schemas, mock controller + end-to-end tests (`npm test`, 72 tests), restoring live tests for a bench controller

## Tools (102)

| Tool | Toolset | What it does |
|---|---|---|
| `myio_servers` | core | the configured controllers with a live check (version, name, permission level) |
| `myio_info` | core | serial, firmware version, board, element counts (RQ/SQ/PCAQ/SENQ), permission level, feature flags, expanders, storage health |
| `myio_find` | core | name search (accent- and case-insensitive) across outputs, groups, sensors, inputs, universal sensors |
| `myio_list_devices` | core | outputs with id, name, live state/level, roles (thermostat, shutter-up/down, rgb:<group>, group:<group> ...), timers, members |
| `myio_read_sensors` | core | temperatures (°C), humidity (%), pulse meter, SDM630 power/voltage/current, 4.x universal sensors |
| `myio_get_status` | core | any raw JSON endpoint (`sens_out.json`, `sens_IO.json`, `info.json`, 4.x: `usensor.json`, `sysdiag.json`, ...) |
| `myio_output` | core | switch or dim ANY output by id: action on / off / toggle / level (`level` 0..255 or `percent`) |
| `myio_relay_on` / `_off` / `_toggle` | legacy | relay 1..RQ |
| `myio_pca_on` / `_off` / `_toggle` / `myio_pca_set` | legacy | PCA dimmer channel 2001..2000+PCAQ; `set` takes `level` (0..255) or `percent` (0..100) |
| `myio_pwm_on` / `_off` / `_toggle` / `myio_pwm_set` | legacy | FET/PWM output 101..116 (legacy hardware only) |
| `myio_group_on` / `_off` / `_toggle` | legacy | group 501.. (editor level needed on the controller) |
| `myio_inputs` | house | wall buttons / switches: state, name, enabled, NC (4.3.12+ / Due 3.12.7+) |
| `myio_press_button` | house | simulate a button: hit (short), press (long), release - runs the input's bound actions |
| `myio_thermostats` / `myio_set_thermostat` | house | sensor-controlled zones: target + band (hysteresis), heat/cool, current temperature; set target, band, raw thresholds, bind sensor |
| `myio_shutters` / `myio_shutter` | house | UP/DOWN pairs (protection pairs): opening / closing / stopped; open, close, stop |
| `myio_rgb` / `myio_set_rgb` | house | RGB groups ("RGB..." group with R/G/B channels): on/off, colour, brightness |
| `myio_usensors` / `myio_set_usens` | house | 4.x universal sensors (KNX, Modbus, MQTT, Shelly, Script, external): read; push a value from outside |
| `myio_send_command` | core | raw `key=value&key=value` command string (everything in the API reference); the reply lists the outputs that changed |
| `myio_globals` / `myio_set_globals` | config | name, clock, time zone, location, sunrise/sunset, button timing, cooldown, sensor polling, pulse meter unit; NTP sync |
| `myio_rename` | config | name of a relay / pca / fet / group / input / thermo / humidity / usens / shelly / scene |
| `myio_output_config` / `myio_set_output_config` | config | auto-off timer, delay, inverted, alarm, justOn, PCA min/max, fade speed, PWM / mixer mode |
| `myio_input_config` / `myio_set_input_config` | config | what a wall button does: enabled, NC, hit-block, hit / press / release targets |
| `myio_structures` / `myio_set_protection` / `myio_set_joiner` / `myio_set_group` | config | protection pairs (shutters), joiner pairs, group members and pullUp |
| `myio_scenes` / `myio_scene` | config | configuration slots: list, load, save, new, delete, set_boot, rename |
| `myio_timers` / `myio_set_timer` / `myio_delete_timer` | config | timer.csv: time or sunrise/sunset ± offset, date, weekdays, event and target |
| `myio_users` / `myio_user` | config | accounts: list, new, delete, rename, set_password, set_rights (admin level) |
| `myio_permissions` / `myio_set_permissions` | config | per-element read/write and hit/press permissions of a user (map readable on 4.x) |
| `myio_config_vars` | config | any raw setting variable of the Setup page (energy manager, SDM, dew point ...) |
| `myio_flows` | automation | Flow rules (4.4+): WHEN / AND / THEN in plain words with names, live state (enabled, running, last fired), variables, webhooks; `raw` = flows.jsn |
| `myio_flow_save` | automation | add / replace / delete a rule, a variable or a webhook target, or replace the whole flows.jsn - validated first, then uploaded + reloaded + read back (`dry_run`) |
| `myio_flow` | automation | runtime: enable / disable a rule, fire its actions now, set a global variable |
| `myio_flow_trace` / `myio_webhook_test` | automation | what the engine did (incremental with `since`); fire a webhook slot and report the HTTP result |
| `myio_scripts` / `myio_script_get` | automation | myIO Script programs (4.10+): state, errors with line:col, timing, locals, arrays, global variables, trace; source of a slot |
| `myio_script_save` / `myio_script` | automation | write + compile a program (compile error with the source line); reload, run once, enable / disable (RAM or persistent), delete |
| `myio_reference` | automation | the bundled firmware documentation: complete script language, Flow card format, any API section |
| `myio_sysdiag` / `myio_metrics` | diag | health: uptime, last reset cause, loop stalls, RAM, M4 core, LAN/WiFi, sockets, storage, login brake; Prometheus text (4.4.1+) |
| `myio_logs` / `myio_log` | diag | daily CSV logs (event, consumption, SDM, temperature, humidity, usens): list; read one day with level / text / time filters and tail |
| `myio_files` / `myio_file_read` / `myio_file_write` / `myio_file_op` | diag | storage (internal flash `q`, SD card `s`; a Due has only the SD): list, read (text / binary), write (text / base64, make_dirs), delete / mkdir / rename / copy |
| `myio_fm_sync` | diag | internal flash -> SD configuration mirror: status, run, adopt a foreign card (4.4.3+, admin) |
| `myio_shelly` / `myio_shelly_set` | integrations | Shelly devices (4.1+): online, state, which myIO output / button / usens each channel is bound to; add, scan, bind, rename, auth, push |
| `myio_link` / `myio_link_set` | integrations | myIO Link (4.2+): other controllers polled, output and sensor links; add, scan, link, unlink |
| `myio_mqtt` / `myio_mqtt_set` | integrations | MQTT client (4.3+, Due 3.12.31+): broker, state, topics, HA discovery, publish masks, subscribe, external sensor bindings; save + reconnect |
| `myio_cloud` / `myio_cloud_set` | integrations | myIO Cloud (4.4+): state, pairing window, paired phone keys; enable, pair, revoke, delete (admin) |
| `myio_sgready` / `myio_sgready_set` | integrations | SG-Ready heat pump (4.4.2+, Due 3.12.9+): mode 1..4, K1/K2 outputs, utility-lock limit |
| `myio_alarm` / `myio_alarm_set` | integrations | SIA DC-09 alarm panel receiver (4.5.8+): partitions, troubles, counters; listeners, account, partition -> usens, simulated events |
| `myio_mia` / `myio_mia_set` | integrations | MIA self-learning heating (4.11+): learned zone model, window detection, preheating; features, thresholds, exclusions, reset |
| `myio_ledstrip` / `myio_ledstrip_set` | integrations | WS2812 strips (4.3.4+): strips, programs, effects; run/stop by event id, edit programs live |
| `myio_network` / `myio_network_set` | integrations | host name, LAN, WiFi STA/AP, live addresses, services per interface; change + save or apply (admin, dangerous) |
| `myio_system` | integrations | restart, web OTA upload / install / roll back (4.x, admin) - waits for the controller and reports the running version |
| `myio_expanders` / `myio_expander_set` | expanders | Opta RS485 panels (4.5+): type, online, firmware, failsafe/standalone, AUX mode, Ext16 1-Wire |
| `myio_knx` / `myio_knx_set` / `myio_knx_device` | expanders | Ext-KNX: group-address table with names, ETS tunnelling interface, devices; edit rows + KnxSave, scan / program addresses (admin) |
| `myio_dali` / `myio_dali_set` | expanders | Ext-DALI (4.8.6+): endpoints, bindings, desired vs driver parameters, groups; bind, settings, groups, scan, commission (admin) |
| `myio_dmx` / `myio_dmx_set` | expanders | Ext-DMX (4.9+): fixtures and channel bindings; add, bind, test, blackout |
| `myio_modbus` / `myio_modbus_set` | expanders | Ext-RS485 Modbus RTU (4.16+): blocks, decoded fields with live values, writer slots, bus; edit tables, presets, raw request, address scan |

Element ids are shared by all tools and channels: relays 1..RQ, FET 101..116, groups 501.., PCA 2001..2000+PCAQ
(see [API_REFERENCE.md](./API_REFERENCE.md) chapter 3).

Annotations follow one rule set: read tools are `readOnlyHint`; a desired-value setter (on / off / level / target / name / a
setting) is `idempotentHint` - calling it twice changes nothing more (an identical protection pair, joiner or timer is reused, not
duplicated); toggles, `fire` / `run`, button presses and `add` / `new` actions are not; tools that can overwrite or delete stored
configuration are `destructiveHint` (switching an output is a reversible state change, not destructive); a tool with several
actions is annotated for its most dangerous one. `myio_webhook_test` is `openWorldHint` (it calls an outside URL).

## Toolsets

The 102 tool descriptions cost context. `MYIO_TOOLSETS` loads only some groups (the same field is in the Claude Desktop settings):

| Toolset | Tools |
|---|---|
| `core` (always) | myio_servers, myio_info, myio_find, myio_list_devices, myio_read_sensors, myio_get_status, myio_output, myio_send_command (8) |
| `legacy` | the per-type switches from 2026-02: myio_relay_* / myio_pca_* / myio_pwm_* / myio_group_* (14) - `myio_output` covers them |
| `house` | inputs, button simulation, thermostats, shutters, RGB, universal sensors (10) |
| `config` | settings, names, output / input configuration, structures, scenes, timers, users, permissions (21) |
| `automation` | Flow rules, scripts, the language / API reference (10) |
| `diag` | sysdiag, metrics, logs, files, SD mirror (9) |
| `integrations` | Shelly, Link, MQTT, Cloud, SG-Ready, alarm, MIA, LED strips, network, restart / OTA (19) |
| `expanders` | Opta RS485 expanders: Ext16, KNX, DALI, DMX, Modbus (11) |

Examples: `MYIO_TOOLSETS=house,automation` (core + 20), `MYIO_TOOLSETS=all,-legacy,-expanders` (77). Empty or `all` = everything (default).
Unknown names are reported on stderr; `core` cannot be switched off. The server instructions tell the model which groups are not
loaded, and the prompts only mention tools that are. Resources and prompts do not depend on the toolsets.

## Resources

Attachable context - the client reads them without a tool call. `<controller>` is the URI-safe form of the controller name
(`Földszint` -> `foldszint`, `Ground floor` -> `ground-floor`; printed on stderr at start).

| URI | Content |
|---|---|
| `myio://<controller>/info` | `info.json` + the feature map derived from the firmware version (JSON) |
| `myio://<controller>/state` | decoded live state in real units: outputs (level, roles, timers, thermostat thresholds), sensors, inputs, universal sensors (JSON) |
| `myio://<controller>/flows.jsn` | the Flow rule file (4.4+) |
| `myio://{controller}/prog/{n}.txt` | template: source of script slot n (4.10+) |
| `myio://{controller}/log/{date}` | template: one day of the event log, `today` / `yesterday` / `YYYY-MM-DD` / `YYMMDD` (last 256 KB) |
| `myio://docs/index` | contents of the bundled API reference with the chapter URIs |
| `myio://docs/script` / `myio://docs/flow` | the myIO Script language (10/G) / the Flow card format (10/D) |
| `myio://docs/chapter/<id>` | one chapter: `1` .. `13`, `10-a` .. `10-h` (Hungarian) |
| `myio://docs/search/{query}` | template: every section whose heading contains the query (accent-insensitive) |

The templates offer completion (controller names, slot numbers, the last seven days).

## Prompts

Each prompt reads the controller(s) when it is requested and embeds the data, so the conversation starts with full context (every
data block fails on its own: "not available: ..."). Argument `language`: `hu` (default) or `en`; `server` limits it to one controller.

| Prompt | Arguments | What it collects |
|---|---|---|
| `heating_overview` | server, language | thermostat zones (target, band, current, heating), temperatures and humidity, MIA learned model and today's MIA events, SG-Ready - for every controller |
| `why_not_switching` | **element** (name or id), server, language | the output's state and roles, account level, output configuration, thermostat control, protection / joiner / group, timers and scene loads, bound wall buttons, Flow rules and scripts that use it, myIO Link, MQTT control, SG-Ready contacts, today's switching commands for it in the event log. An ambiguous name returns the candidates. |
| `daily_diagnostics` | server, date, language | info, sysdiag (resets, RAM, sockets, link / WiFi, NTP), clock vs this computer + time zone / DST, the event log's error and notable lines grouped, RS485 expanders, Flow and script errors - for every controller |
| `new_flow_rule` | rule (plain words), server, language | the existing rules, the named outputs and sensors with ids, the 10/D card reference; the model is told to clarify, draft, dry-run (`myio_flow_save dry_run=true`), explain, and save only after approval |

## Streamable HTTP (optional)

stdio stays the default. With `MYIO_HTTP_PORT` the server also answers MCP over Streamable HTTP at `/mcp`, for other MCP clients on the LAN:

```bash
MYIO_HTTP_PORT=8765 MYIO_HTTP_HOST=0.0.0.0 MYIO_HTTP_TOKEN=$(openssl rand -base64 24) \
MYIO_BASE_URL=http://192.168.1.178 MYIO_USERNAME=admin MYIO_PASSWORD=... node dist/index.js
# client: URL http://<this-machine>:8765/mcp, header  Authorization: Bearer <token>
```

- binds to `127.0.0.1` by default; any other address needs `MYIO_HTTP_TOKEN` (min. 16 characters) or the server refuses to start.
  On loopback without a token a random one is generated and printed on stderr.
- every request needs `Authorization: Bearer <token>` (compared in constant time); sessions are kept in memory (max 16, idle 30 min).
- all sessions share the controller clients, so the per-controller request queue (and `MYIO_MIN_GAP_MS`) still protects the firmware.
- started from a terminal it serves only HTTP; under an MCP client (stdin is a pipe) stdio runs too. `MYIO_STDIO=0|1` forces it.
- plain HTTP: use it inside the home network or behind a TLS reverse proxy / VPN, not on the open internet. On macOS the application
  firewall may ask to allow incoming connections for `node`.


## Configuration

Environment variables (the Claude Desktop extension asks for them as *user config*):

| Variable | Meaning |
|---|---|
| `MYIO_BASE_URL` | controller URL, e.g. `http://192.168.1.178` (port 80 by default) |
| `MYIO_USERNAME` / `MYIO_PASSWORD` | HTTP Basic auth; the account's permission level limits what the tools can do |
| `MYIO_NAME` | label used in replies (default: the host) |
| `MYIO_SERVERS` | several controllers: JSON array `[{"name":"Ground floor","url":"http://192.168.1.178","username":"admin","password":"..."}, ...]` - overrides the three above; tools take `server: "<name>"` |
| `MYIO_WRITE` | write level: `state` (outputs, thermostat targets, usens, run flows / scripts, SG mode), `config` (default; also names, timers, scenes, structures, input/output configuration, thermostat sensor binding, Flow / script files, integration settings), `admin` (also users, permissions, system files, network, Cloud keys, restart / OTA) |
| `MYIO_TOOLSETS` | tool groups to load (see Toolsets), default all |
| `MYIO_HTTP_PORT` / `MYIO_HTTP_HOST` / `MYIO_HTTP_TOKEN` / `MYIO_STDIO` | optional Streamable HTTP transport (see above) |
| `MYIO_TIMEOUT_MS` | HTTP timeout, default 10000 |
| `MYIO_MIN_GAP_MS` | minimum pause between two requests to one controller, default 150 (a Due refuses request bursts) |
| `MYIO_INSECURE_PARSER` | `0` = strict Node HTTP parser (default lenient: the firmware writes its headers by hand) |

### Claude Desktop

Install `myio-mcp.mcpb` (Settings → Extensions) and fill in the URL, user and password. To rebuild the bundle:

```bash
npm install
npm run pack          # = sync-docs + tsc + mcpb pack . myio-mcp.mcpb
```

### Claude Code / other MCP clients (stdio)

```json
{
  "mcpServers": {
    "myio": {
      "command": "node",
      "args": ["/absolute/path/to/myio-mcp/dist/index.js"],
      "env": { "MYIO_BASE_URL": "http://192.168.1.178", "MYIO_USERNAME": "admin", "MYIO_PASSWORD": "..." }
    }
  }
}
```

## Development

```bash
npm install
npm run build         # TypeScript -> dist/
npm test              # build + mock controller + end-to-end tests over stdio (node --test)
MYIO_BASE_URL=http://192.168.1.56 MYIO_USERNAME=admin MYIO_PASSWORD=... npm run smoke   # read-only check on a real controller
node test/mock_myio.mjs --serve 8111    # standalone mock controller (MOCK_VERSION=3.12.30 for a Due-like one)
npm run sync-docs     # copy ../SD_Files/js/lang/HU/API_REFERENCE.md (the canonical reference) into the package; --check only compares
LIVE_SERVERS='[{"name":"Opta","url":"http://192.168.1.60","username":"admin","password":"..."}]' node test/live_mcp5.mjs   # resources + prompts + HTTP, read-only
```

Layout: `src/api.ts` (HTTP client + command dispatch), `src/model.ts` (JSON → devices/sensors, scales, version gate),
`src/model_auto.ts` (Flow validation / description, script state, traces), `src/model_diag.ts` (sysdiag, logs, files),
`src/servers.ts` (several controllers, URI slugs), `src/toolsets.ts` (MYIO_TOOLSETS), `src/resources.ts`, `src/prompts.ts`, `src/docs.ts` (the bundled reference), `src/http.ts` (Streamable HTTP), `src/tools/common.ts` (read-back, desired-toggle and command helpers), `src/tools/basic.ts` + `house.ts` + `config.ts` + `auto.ts` + `diag.ts` + `integr.ts` + `bus.ts` (tool families on `McpServer`), `src/index.ts` (config + transports),
`test/mock_myio.mjs` (controller mock built from the real `d_sens_out.json` sample, with an in-memory file system, Flow and Script engines), `test/mcp.test.mjs`, `test/house.test.mjs`, `test/config.test.mjs`, `test/auto.test.mjs`, `test/integr.test.mjs`, `test/mcp5.test.mjs` (resources, prompts, toolsets, annotations, HTTP); `test/live_write.mjs`, `test/live_config.mjs`, `test/live_auto.mjs` and `test/live_integr.mjs` are restoring live tests for a BENCH controller only; `test/live_mcp5.mjs` only reads. `node test/call.mjs <tool> '<json>' ...` calls tools by hand.

## Rules the server follows (from the API reference, chapter 12)

1. One request at a time, `Connection: close`, no polling faster than 1 s - the controller has 3 listen sockets.
2. Commands go as `POST /info.json` body (the `GET /command:` path does not URL-decode), max 1024 bytes.
3. The command reply is an HTML/JSON acknowledgement, not the new state: read `sens_out.json` back.
4. JSON keys may be missing (permission filtering): never rely on a fixed key set.
5. Toggle-type config commands (`relaysInvert=<id>` ...) invert a flag - read first, send only on change.
6. Fixed point: temperature ×100, humidity/usens/SDM U,I ×10, thresholds ×10, PCA/FET level raw 0..255.

## License

MIT
