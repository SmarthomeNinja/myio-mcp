/**
 * Kozos segedek az eszkoz-modulokhoz: valasz-epitok, annotaciok, `server` parameter, allapot-lekeres,
 * parancs + visszaolvasas (MYIO_MCP_PLAN.md 5.2: a fw a jog nelkuli / tiltott parancsot csendben eldobja).
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MyIOClient, MyIOError, POST_BODY_MAX } from '../api.js';
import { Device, Snapshot, Usens, Thermostat, decodeDevices, decodeUsens, decodeSensors, decodeThermostats, fmtDevice, supports, FEAT } from '../model.js';
import type { Registry } from '../servers.js';

export type WriteLevel = 'state' | 'config' | 'admin';
export interface ToolContext {
  reg: Registry; write: WriteLevel;
  /** a tenylegesen regisztralt eszkozok neve (MYIO_TOOLSETS utan) - a promptok csak ezekre hivatkoznak */
  tools?: Set<string>;
}
const LEVELS: WriteLevel[] = ['state', 'config', 'admin'];
/** iras-szint kapu (MYIO_WRITE): null = mehet, kulonben a hiba-valasz */
export function gate(ctx: ToolContext, need: WriteLevel): CallToolResult | null {
  if (LEVELS.indexOf(ctx.write) >= LEVELS.indexOf(need)) return null;
  return fail(`This tool changes ${need === 'admin' ? 'users / system settings' : 'configuration'} and the server runs with MYIO_WRITE=${ctx.write}. Set MYIO_WRITE=${need} (or admin) in the server configuration to allow it.`);
}

/*
 * Annotaciok (5. kor: kovetkezetesseg). Az eszkoz annotacioja a LEGROSSZABB esetet irja le (egy akcio-parameteres eszkoznel
 * a legveszelyesebb akciot). readOnly = semmit nem valtoztat; destructive = tarolt beallitast/adatot irhat felul vagy torolhet
 * (az allapot-kapcsolas visszafordithato, az nem az); idempotent = ugyanazokkal a parameterekkel ujrahivva nincs tovabbi hatas
 * (kivant-ertekes setterek: on/off/szint/cel, a billeno parancsokat a toggleTo csak elteresnel kuldi) - a toggle, a "fire/run",
 * az "add/new" (uj elemet hoz letre) es a gombnyomas NEM az.
 */
export const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const WR = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };     // allapot-iras, nem idempotens (toggle, fire, gomb)
export const WR_SET = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };  // allapot-iras kivant ertekkel (on/off/szint)
export const WR_CFG = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };  // beallitas-iras (van nem idempotens akcioja)
export const WR_CFG_SET = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }; // beallitas-iras kivant ertekkel
export const WR_ADM = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };  // admin-iras
export const SETTLE_MS = 250;   // a fw a parancsot a fociklusban hajtja vegre; a vedelem/csatolo is ott fut

export const text = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }] });
export const fail = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }], isError: true });
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export const idArg = (what: string) => z.number().int().describe(what);

/** a `server` parameter minden eszkozon (tobb vezerlo eseten a nev, kulonben elhagyhato) */
export const serverArg = (reg: Registry) =>
  z.string().optional().describe(reg.names.length > 1 ? `controller: ${reg.names.join(' | ')} (default ${reg.names[0]})` : `controller name (default ${reg.names[0]})`);

export interface DeviceSet { list: Device[]; live: Snapshot; names: Snapshot; }
/** eszkozlista elo allapottal (nevek a gyorsitotarbol) */
export async function devices(client: MyIOClient, withInputs = false): Promise<DeviceSet> {
  const names = await client.names();
  const live = await client.snapshot(withInputs);
  return { list: decodeDevices(live, names), live, names };
}
export const findDev = (list: Device[], id: number) => list.find(d => d.id === id);

/** univerzalis szenzorok, ha a fw tudja (3.x: ures lista, hiba nelkul) */
export async function usensOrEmpty(client: MyIOClient): Promise<Usens[]> {
  if (!supports(await client.version(), FEAT.usens)) return [];
  try { return decodeUsens(await client.usensors()).list; } catch { return []; }
}

/** szenzor-vezerelt kimenetek (termosztat-zonak) elo ertekekkel */
export async function thermostatsOf(client: MyIOClient): Promise<Thermostat[]> {
  const { list, live, names } = await devices(client);
  return decodeThermostats(list, decodeSensors(live, names), await usensOrEmpty(client));
}

export type Expect = (before: Device | undefined, after: Device | undefined) => string | undefined;
export const expectOn = (want: boolean): Expect => (_b, a) => (a && a.on !== want ? `expected ${want ? 'ON' : 'OFF'} but the controller reports ${a.on ? 'ON' : 'OFF'}` : undefined);
export const expectToggle: Expect = (b, a) => (b && a && b.on === a.on ? 'state did not change' : undefined);
export const expectLevel = (want: number): Expect => (_b, a) => {
  if (!a || a.level === undefined || a.level === want) return undefined;
  if (a.pwm === false) return `switch-mode channel (PWM off): any level above MIN turns it fully ON (${a.max ?? 255}), MIN turns it OFF - use on/off, or enable PWM mode for dimming`;
  return `expected level ${want} but the controller reports ${a.level} (MIN/MAX clamp, permission, or fade in progress)`;
};

/**
 * Parancs + visszaolvasas. `targets` = a figyelt elem-ID-k; `expect` = a kivant allapot, ha ismert.
 * A valasz: minden celra "utana (volt ...)", es figyelmeztetes, ha nem valtozott.
 */
export async function apply(client: MyIOClient, cmd: string, targets: number[], expect?: Expect): Promise<CallToolResult> {
  const before = await devices(client);
  for (const id of targets) if (!findDev(before.list, id)) return fail(`No element with id ${id} is visible to this user (${client.name}). It may not exist, or the account has no permission for it - see myio_list_devices.`);
  await client.command(cmd);
  await sleep(SETTLE_MS);
  const after = await devices(client);
  const lines: string[] = [`Sent: ${cmd}`];
  let warned = false;
  for (const id of targets) {
    const b = findDev(before.list, id), a = findDev(after.list, id);
    lines.push(`  ${fmtDevice(a!)}` + (b && a && (b.on !== a.on || b.level !== a.level) ? `   (was ${b.on ? 'ON' : 'OFF'}${b.level !== undefined && a.type !== 'relay' ? ` ${b.level}/255` : ''})` : '   (unchanged)'));
    const w = expect?.(b, a);
    if (w) { lines.push(`  ! ${w}`); warned = true; }
  }
  if (warned) lines.push('  Possible causes: no write permission for this element on this account, a protection pair / joiner, cooldown, a thermostat-controlled output, or the expander is offline.');
  return text(lines.join('\n'));
}

/** parancs + a MEGVALTOZOTT kimenetek diffje (nyers parancs, gombszimulacio) */
export async function applyDiff(client: MyIOClient, cmd: string, head?: string): Promise<CallToolResult> {
  const before = await devices(client);
  const r = await client.command(cmd);
  await sleep(SETTLE_MS);
  const after = await devices(client);
  const bmap = new Map(before.list.map(d => [d.id, d]));
  const changed = after.list.filter(a => { const b = bmap.get(a.id); return b && (b.on !== a.on || b.level !== a.level); });
  const lines = [head ?? `Sent: ${cmd} (HTTP ${r.status})`];
  lines.push(changed.length ? 'Outputs that changed:\n' + changed.map(a => `  ${fmtDevice(a)}   (was ${bmap.get(a.id)!.on ? 'ON' : 'OFF'}${a.type !== 'relay' && a.level !== undefined ? ` ${bmap.get(a.id)!.level}/255` : ''})`).join('\n')
    : 'No output state changed (config command, no-op, no permission, or the input has no action bound - verify with myio_get_status).');
  return text(lines.join('\n'));
}

/** titok-maszk: jelszo/kulcs/token mezo erteke SOSEM megy ki az AI-nak, csak hogy be van-e allitva */
export const SECRET_KEYS = /(^|_)(pw|pass|password|pwd|tkey|token|key|secret|psk|devkey)$/i;
export const maskSecret = (name: string, v: unknown): unknown => (SECRET_KEYS.test(name) ? (v === '' || v === undefined || v === null ? '(not set)' : '(set, hidden)') : v);

/** egy parancs-par: az ertek URL-kodolva. A fw a POST-torzset EGESZBEN dekodolja a szetvagas elott, ezert az ertekben
 *  '&' nem lehet (szetesne) - erre itt ertheto hiba (jelszo, nev, SSID). */
export function kv(key: string, value: string | number): string {
  const s = String(value);
  if (s.includes('&')) throw new MyIOError(`the value for ${key} contains "&" - the controller cannot receive that character (it splits commands on it); choose a value without "&"`);
  return `${key}=${encodeURIComponent(s)}`;
}
/** parancsok sorrendtartoan, POST-onkent max 1024 B-os darabokban (a POST-ot sosem ismeteljuk) */
export async function sendCmds(client: MyIOClient, cmds: string[]): Promise<number> {
  let chunk: string[] = [], n = 0;
  const flush = async () => { if (chunk.length) { await client.command(chunk.join('&')); n++; chunk = []; } };
  for (const c of cmds) {
    if (Buffer.byteLength(c) > POST_BODY_MAX) throw new MyIOError(`command ${c.slice(0, 40)}... is longer than ${POST_BODY_MAX} B`);
    if (Buffer.byteLength([...chunk, c].join('&')) > POST_BODY_MAX) await flush();
    chunk.push(c);
  }
  await flush();
  return n;
}
/** billeno (toggle) parancs csak akkor, ha a kivant ertek elter a jelenlegitol */
export const toggleTo = (cmds: string[], cur: unknown, want: boolean | undefined, cmd: string): void => {
  if (want !== undefined && (Number(cur) ? true : false) !== want) cmds.push(cmd);
};
/** ertek-mezo: csak ha meg van adva */
export const setIf = (cmds: string[], key: string, v: string | number | undefined): void => { if (v !== undefined) cmds.push(kv(key, v)); };

