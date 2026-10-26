/**
 * Eszkoz-keszletek (5. kor 2026-10-26): a 102 eszkoz leirasa sok kontextust eszik - MYIO_TOOLSETS-szel csak a kellok toltodnek be.
 *   MYIO_TOOLSETS=house,automation        csak ezek (+ a core mindig)
 *   MYIO_TOOLSETS=all,-legacy,-expanders  minden, kiveve ...
 *   ures / "all"                          minden (alap)
 * A `core` (myio_servers/info/find/list_devices/read_sensors/get_status/output/send_command) mindig betoltodik: ez a belepesi pont.
 * A `legacy` = a 2026-02-es fajtankenti kapcsolok (relay/pca/pwm/group on|off|toggle|set) - a myio_output mindet kivaltja.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export const TOOLSETS = ['core', 'legacy', 'house', 'config', 'automation', 'diag', 'integrations', 'expanders'] as const;
export type Toolset = (typeof TOOLSETS)[number];

export const TOOLSET_INFO: Record<Toolset, string> = {
  core: 'controllers, info, find by name, outputs list/switch, sensors, raw JSON, raw command (always on)',
  legacy: 'the per-type switches from 2026-02 (relay/pca/pwm/group on|off|toggle|set) - myio_output covers them',
  house: 'inputs + button simulation, thermostats, shutters, RGB, universal sensors',
  config: 'settings, names, output/input configuration, structures, scenes, timers, users, permissions',
  automation: 'Flow rules, scripts, the language/API reference',
  diag: 'sysdiag, metrics, logs, files, SD mirror',
  integrations: 'Shelly, myIO Link, MQTT, Cloud, SG-Ready, alarm receiver, MIA, LED strips, network, restart/OTA',
  expanders: 'Opta RS485 expanders: Ext16, KNX, DALI, DMX, Modbus',
};

const LEGACY = /^myio_(relay|pca|pwm|group)_(on|off|toggle|set)$/;

export interface ToolsetChoice { enabled: Set<Toolset>; warnings: string[]; }

export function parseToolsets(raw: string | undefined): ToolsetChoice {
  const warnings: string[] = [];
  const tokens = (raw ?? '').split(/[\s,;]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
  const enabled = new Set<Toolset>();
  const plus = tokens.filter(t => !t.startsWith('-'));
  if (!plus.length || plus.includes('all') || plus.includes('*')) for (const t of TOOLSETS) enabled.add(t);
  for (const t of tokens) {
    const neg = t.startsWith('-'); const name = (neg ? t.slice(1) : t) as Toolset;
    if (name === 'all' as string || name === '*' as string) continue;
    if (!TOOLSETS.includes(name)) { warnings.push(`unknown toolset "${name}" (known: ${TOOLSETS.join(', ')})`); continue; }
    if (neg) enabled.delete(name); else enabled.add(name);
  }
  if (!enabled.has('core')) { enabled.add('core'); if (tokens.includes('-core')) warnings.push('the core toolset cannot be disabled'); }
  return { enabled, warnings };
}

/** a modul-regisztralo ezen at regisztral: a ki nem valasztott keszlet eszkozei nem kerulnek a szerverre */
export function toolsetView(server: McpServer, set: Toolset, enabled: Set<Toolset>, registered?: Set<string>): McpServer {
  return new Proxy(server, {
    get(target, prop, recv) {
      if (prop === 'registerTool') {
        return (name: string, ...rest: unknown[]) => {
          const s: Toolset = set === 'core' && LEGACY.test(name) ? 'legacy' : set;
          if (!enabled.has(s)) return undefined;
          registered?.add(name);
          return (target.registerTool as (...a: unknown[]) => unknown).call(target, name, ...rest);
        };
      }
      const v = Reflect.get(target, prop, recv);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
