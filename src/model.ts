/**
 * A vezerlo JSON-jai -> entitasok (MYIO_MCP_PLAN.md 3. fej.: a reteg, amely kesobb a fw-nativ /mcp-be is atviheto).
 *
 * Skalak (vason + a web-UI sensors.js-bol igazolva, 2026-10-25):
 *   temp x100 (2556 = 25,56 C) · hum x10 · usens x10 · SDM P nyers W · U x10 V · I x10 A · imp nyers (fogyasztas-egyseg)
 *   kuszobok (sensorON/OFF) x10 · PCA/FET szint 0..255 NYERS (a PCA*<id>= parancs is nyers, NEM szazalek).
 * ID-terkep (API-ref 3.): rele 1..RQ · FET 101..116 (csak FETPWM-es vason) · FET-fade 201+ · csoport 501.. ·
 *   PCA 2001..2000+PCAQ · PCA-fade 4001+ · slot-betoltes 1000..1899.
 * Entitas-modell (1. kor): termosztat / redony / RGB = a Homey-app es az MQTT-HA ag modellje (MyIO_M7/_Mqtt.ino, mqtt_ha.cpp).
 */

export interface RawOutput {
  id: number; description?: string; state?: number;
  inverse?: number; alarm?: number; justOn?: number;
  timer?: number; timerActive?: number; timerRemain?: number;
  delay?: number; delayActive?: number; delayRemain?: number;
  sensor?: number; sensorON?: number; sensorOFF?: number;
  turnOFF?: number; turnON?: number; fade?: number; speed?: number; mixer?: number; pwm?: number;
  off?: number;   // [4.6] a gazda-bovito offline
}
export interface RawGroup { id: number; description?: string; state?: number; pullUP?: number; [k: string]: unknown; }
export interface RawPair { element0: number; element1: number; element0d?: string; element1d?: string; }
export interface RawSensor { id: number; description?: string; temp?: number; hum?: number; imp?: number; P?: number; U?: number; I?: number; act?: number; off?: number; }
export interface RawInput { id: number; state: number; enabled?: number; nc?: number; description?: string; }

export interface Snapshot {
  relays?: Record<string, RawOutput>;
  PCA?: Record<string, RawOutput>;
  PWM?: Record<string, RawOutput>;
  group?: Record<string, RawGroup>;
  joiner?: Record<string, RawPair>;
  protection?: Record<string, RawPair>;
  sensors?: Record<string, RawSensor>;
  inputs?: Record<string, RawInput>;
  led?: Record<string, { state: number; prog: number; n: number }>;
}

export interface InfoJson {
  info: {
    serial?: string; version?: string; name?: string; CPU?: string; api?: number | string; right?: number | string;
    RQ?: number | string; SQ?: number | string; PCAQ?: number | string; SHQ?: number | string; SENQ?: number | string;
    uptime?: number | string; reset_cause?: number | string; bootloader?: string; rdp?: number | string; rollback?: number | string;
    pca_online?: number[]; pcf_online?: number[]; inp_online?: number[][]; exp_q?: number; exp_online?: number[];
    qhealth?: number; qheal?: number; eepbak?: number;
    [k: string]: unknown;
  };
}

/** usensor.json [4.x]: {"usensor":{"senq":N,"dpo":{...},"<id>":{en,type,val,age,state,refresh,err,description},...}} */
export interface RawUsens { en?: number; type?: number; val?: number; age?: number; state?: number; refresh?: number; err?: number; description?: string; }
export interface UsensJson { usensor?: Record<string, RawUsens | number | Record<string, unknown>>; }

export type DeviceType = 'relay' | 'pca' | 'fet' | 'group';
export interface Device {
  id: number; type: DeviceType; name: string; on: boolean;
  level?: number;        // PCA/FET 0..255
  pwm?: boolean;         // PCA dimmer-mod (1) / kapcsolo-mod (0)
  mixer?: boolean;
  min?: number; max?: number;   // turnOFF / turnON
  timer?: number; timerRemain?: number; delay?: number; delayRemain?: number;
  sensor?: number; sensorON?: number; sensorOFF?: number;   // termosztat-kotes (x10 kuszobok)
  members?: number[];    // csoport tagjai (elem-ID-k)
  pullUp?: boolean;
  offline?: boolean;     // [4.6] a bovito offline
  roles?: string[];      // szerepek: thermostat / sun / mixer / shutter-up / shutter-down / joiner / rgb:<gid> / group:<gid>
}

export type SensorKind = 'temperature' | 'humidity' | 'pulse' | 'sdm_power' | 'sdm_voltage' | 'sdm_current' | 'unknown';
export interface SensorReading { id: number; kind: SensorKind; name: string; value: number | null; unit: string; raw: number; active?: boolean; offline?: boolean; }

export interface Input { id: number; name: string; on: boolean; enabled?: boolean; nc?: boolean; }

export const USENS_TYPES: Record<number, { name: string; unit: string }> = {
  0: { name: 'generic', unit: '' }, 1: { name: 'temperature', unit: '°C' }, 2: { name: 'humidity', unit: '%' }, 3: { name: 'wind speed', unit: 'm/s' },
  4: { name: 'dew point', unit: '°C' }, 5: { name: 'power', unit: 'W' }, 6: { name: 'energy', unit: 'kWh' }, 7: { name: 'illuminance', unit: 'lx' },
  8: { name: 'pressure', unit: 'hPa' }, 9: { name: 'CO2', unit: 'ppm' }, 10: { name: 'voltage', unit: 'V' }, 11: { name: 'current', unit: 'A' }, 12: { name: 'battery', unit: '%' },
};
export interface Usens { id: number; name: string; type: number; typeName: string; unit: string; value: number; state: 'ok' | 'stale' | 'none'; enabled: boolean; age: number; refresh: number; err: number; }

export const num = (v: unknown, def = 0): number => { const n = typeof v === 'number' ? v : parseFloat(String(v)); return Number.isFinite(n) ? n : def; };
export const values = <T extends { id: number }>(sec?: Record<string, T>): T[] =>
  sec ? Object.values(sec).filter(x => x && typeof x === 'object').sort((a, b) => a.id - b.id) : [];

/** ekezet- es kisbetu-fuggetlen osszevetes (a fw FIND_NAME-je is igy) */
export const normalizeName = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// ---- ID-segedek -------------------------------------------------------------------------------------------------
export function deviceTypeOf(id: number): DeviceType | undefined {
  if (id >= 1 && id <= 100) return 'relay';
  if (id >= 101 && id <= 116) return 'fet';
  if (id >= 201 && id <= 216) return 'fet';           // fade-id -> alap
  if (id >= 501 && id <= 1999) return 'group';
  if (id >= 2001 && id <= 3024) return 'pca';
  if (id >= 4001 && id <= 5024) return 'pca';          // fade-id -> alap
  return undefined;
}
/** fade-azonosito (201+, 4001+) -> bazis-ID (a kozvetlen elemparancsok csak a bazist fogadjak, 4.17.1) */
export function baseId(id: number): number {
  if (id >= 4001 && id <= 5024) return id - 2000;
  if (id >= 201 && id <= 216) return id - 100;
  return id;
}
export const groupId = (id: number): number => (id >= 1 && id <= 500 ? 500 + id : id);
export const pcaId = (id: number): number => (id >= 1 && id <= 2000 ? 2000 + id : baseId(id));
export const fetId = (id: number): number => (id >= 1 && id <= 100 ? 100 + id : baseId(id));

export const levelToPercent = (level: number): number => Math.round((level / 255) * 100);
export const percentToLevel = (pct: number): number => Math.max(0, Math.min(255, Math.round((pct / 100) * 255)));

/** be/ki/valtas parancs egy elem-ID-re a fajtaja szerint (a fw parancs-diszpecsere) */
export function switchCommand(id: number, action: 'on' | 'off' | 'toggle'): string | undefined {
  const t = deviceTypeOf(id); const b = baseId(id);
  const suffix = action === 'on' ? 'ON' : action === 'off' ? 'OFF' : 'INV';
  if (t === 'relay') return `r_${suffix}=${b}`;
  if (t === 'pca') return `PCA_${suffix}=${b}`;
  if (t === 'fet') return `f_${suffix}=${b}`;
  if (t === 'group') return `g_${suffix}=${b}`;
  return undefined;
}
export function levelCommand(id: number, level: number): string | undefined {
  const t = deviceTypeOf(id); const b = baseId(id); const v = Math.max(0, Math.min(255, Math.round(level)));
  if (t === 'pca') return `PCA*${b}=${v}`;
  if (t === 'fet') return `fet*${b}=${v}`;
  return undefined;
}

// ---- verzio ---------------------------------------------------------------------------------------------------------
export const parseVersion = (v: string | undefined): number[] => (v ?? '').split('.').map(x => parseInt(x, 10)).map(x => (Number.isFinite(x) ? x : 0));
export function cmpVersion(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}
export interface MinVersion { v3?: string; v4?: string; }
/** API-ref verzio-jeloles: {v3: '3.12.7', v4: '4.3.12'} - a Due-agon (3.x) es a GIGA/Opta-agon (4.x) kulon minimum;
 *  hianyzo ag = azon a vason nincs; 5.x+ mindent tud, amit a 4.x. */
export function supports(version: string | undefined, min: MinVersion): boolean {
  const major = parseVersion(version)[0] ?? 0;
  if (major <= 3) return !!min.v3 && cmpVersion(version!, min.v3) >= 0;
  if (major === 4) return !!min.v4 && cmpVersion(version!, min.v4) >= 0;
  return !!min.v4 || !!min.v3;
}
export const isV4 = (version: string | undefined): boolean => (parseVersion(version)[0] ?? 0) >= 4;
export const minText = (min: MinVersion): string =>
  [min.v4 ? `GIGA/Opta ${min.v4}+` : '', min.v3 ? `Due ${min.v3}+` : ''].filter(Boolean).join(' or ') + (!min.v3 ? ' - not available on a Due 3.x' : !min.v4 ? ' - not available on 4.x' : '');
export const FEAT = {
  inputs: { v3: '3.12.7', v4: '4.3.12' } as MinVersion,
  usens: { v4: '4.0.0' } as MinVersion,
  flow: { v4: '4.4.0' } as MinVersion,
  script: { v4: '4.10.0' } as MinVersion,
  // 3. kor: fajlkezelo + sysdiag a Due-n 3.12(.0) ota (_FileMan.ino, csak SD-kotet), a 4.x-en mindig (QSPI + SD)
  files: { v3: '3.12.0', v4: '4.0.0' } as MinVersion,
  sysdiag: { v3: '3.12.0', v4: '4.0.0' } as MinVersion,
  metrics: { v4: '4.4.1' } as MinVersion,
  webhooks: { v4: '4.4.1' } as MinVersion,
  fmSync: { v4: '4.4.3' } as MinVersion,
  // 4. kor: integraciok es bovitok
  shelly: { v4: '4.1.0' } as MinVersion,
  link: { v4: '4.2.0' } as MinVersion,
  mqtt: { v3: '3.12.31', v4: '4.3.0' } as MinVersion,
  mqttSensors: { v4: '4.5.0' } as MinVersion,
  cloud: { v4: '4.4.0' } as MinVersion,
  sgready: { v3: '3.12.9', v4: '4.4.2' } as MinVersion,
  alarm: { v4: '4.5.8' } as MinVersion,
  mia: { v4: '4.11.0' } as MinVersion,
  ledstrip: { v4: '4.3.4' } as MinVersion,
  network: { v4: '4.0.0' } as MinVersion,
  webOta: { v4: '4.0.0' } as MinVersion,
  expanders: { v4: '4.5.0' } as MinVersion,
  knxNames: { v4: '4.15.0' } as MinVersion,
  knxIp: { v4: '4.14.0' } as MinVersion,
  // automatikus nyari idoszamitas (EU): dst_auto pipa + dst_now a /setup var-blokkjaban [3.12.35 / 4.18.9]
  dst: { v3: '3.12.35', v4: '4.18.9' } as MinVersion,
  dali: { v4: '4.8.6' } as MinVersion,
  dmx: { v4: '4.9.0' } as MinVersion,
  modbus: { v4: '4.16.0' } as MinVersion,
};

// ---- eszkozok ---------------------------------------------------------------------------------------------------------
function mergeNames<T extends { id: number; description?: string }>(live: T[], named?: Record<string, T>): T[] {
  if (!named) return live;
  const byId = new Map(values(named).map(x => [x.id, x.description ?? '']));
  return live.map(x => (x.description === undefined && byId.has(x.id) ? { ...x, description: byId.get(x.id) } : x));
}

function outputToDevice(o: RawOutput, type: DeviceType): Device {
  const d: Device = { id: o.id, type, name: o.description ?? '', on: num(o.state) > 0 };
  if (type !== 'relay') {
    d.level = num(o.state);
    if (o.turnOFF !== undefined) d.min = num(o.turnOFF);
    if (o.turnON !== undefined) d.max = num(o.turnON);
    if (o.pwm !== undefined) d.pwm = num(o.pwm) === 1;
    if (o.mixer !== undefined) d.mixer = num(o.mixer) === 1;
  }
  if (o.timer) { d.timer = num(o.timer); if (num(o.timerActive)) d.timerRemain = num(o.timerRemain); }
  if (o.delay) { d.delay = num(o.delay); if (num(o.delayActive)) d.delayRemain = num(o.delayRemain); }
  if (num(o.sensor)) { d.sensor = num(o.sensor); d.sensorON = num(o.sensorON); d.sensorOFF = num(o.sensorOFF); }
  if (num(o.off)) d.offline = true;
  return d;
}

/** csoport tagjai az elementN mezokbol (a 0 = ures hely) */
export function groupMembers(g: RawGroup): number[] {
  return Object.keys(g).filter(k => /^element\d+$/.test(k)).sort((a, b) => parseInt(a.slice(7)) - parseInt(b.slice(7)))
    .map(k => num(g[k])).filter(id => id > 0);
}

/** live (sens_out.json) + nevek (d_sens_out.json) -> eszkozlista; a csoport allapota V4-ben a `state` mezo, V3-ban a tagokbol */
export function decodeDevices(live: Snapshot, names?: Snapshot): Device[] {
  const out: Device[] = [];
  const relays = mergeNames(values(live.relays), names?.relays);
  const pcas = mergeNames(values(live.PCA), names?.PCA);
  const fets = mergeNames(values(live.PWM), names?.PWM);
  for (const r of relays) out.push(outputToDevice(r, 'relay'));
  for (const f of fets) out.push(outputToDevice(f, 'fet'));
  for (const p of pcas) out.push(outputToDevice(p, 'pca'));
  const state = new Map(out.map(d => [d.id, d.on]));
  for (const g of mergeNames(values(live.group), names?.group)) {
    const members = groupMembers(g);
    let on: boolean;
    if (g.state !== undefined) on = num(g.state) > 0;
    else { const known = members.map(m => state.get(baseId(m))).filter(x => x !== undefined) as boolean[]; on = known.length > 0 && known.every(Boolean); }
    out.push({ id: g.id, type: 'group', name: g.description ?? '', on, members, pullUp: num(g.pullUP) === 1 });
  }
  annotateRoles(out, names ?? live);
  return out;
}

/** szerepek az eszkozokon: termosztat / nap / keverő / redony-par / csatolo / RGB-tag / csoport-tag */
export function annotateRoles(devices: Device[], snap: Snapshot): void {
  const byId = new Map(devices.map(d => [d.id, d]));
  const add = (id: number, role: string) => { const d = byId.get(baseId(id)); if (d) (d.roles ??= []).push(role); };
  for (const d of devices) {
    if (d.sensor) {
      if (d.sensor === 255) add(d.id, 'sun-controlled');
      else if (d.mixer) add(d.id, 'mixer');
      else if (d.sensor >= 101 && d.sensor <= 110) add(d.id, 'humidity-controlled');
      else if (d.type === 'pca' && d.pwm) add(d.id, 'sensor-controlled dimmer');
      else add(d.id, 'thermostat');
    }
  }
  for (const p of values0(snap.protection)) { if (p.element0 && p.element1) { add(p.element0, 'shutter-up'); add(p.element1, 'shutter-down'); } }
  for (const j of values0(snap.joiner)) { if (j.element0 && j.element1) { add(j.element0, `joiner-master of ${baseId(j.element1)}`); add(j.element1, `joiner-slave of ${baseId(j.element0)}`); } }
  for (const g of devices.filter(d => d.type === 'group')) {
    const rgb = /^rgb/i.test(g.name);
    for (const m of g.members ?? []) add(m, rgb ? `rgb:${g.id}` : `group:${g.id}`);
  }
}
const values0 = (sec?: Record<string, RawPair>): RawPair[] => (sec ? Object.values(sec).filter(x => x && typeof x === 'object') : []);

export function decodeSensors(live: Snapshot, names?: Snapshot): SensorReading[] {
  const out: SensorReading[] = [];
  for (const s of mergeNames(values(live.sensors), names?.sensors)) {
    const name = s.description ?? '';
    const base = { id: s.id, name, offline: num(s.off) ? true : undefined } as const;
    const act = s.act !== undefined ? num(s.act) !== 0 : undefined;
    if (s.temp !== undefined) {
      const raw = num(s.temp);
      // hibajel: -12600 (nincs szenzor) / szelsoertek -> ervenytelen
      const value = raw <= -5500 || raw > 12500 ? null : raw / 100;
      out.push({ ...base, kind: 'temperature', value, unit: '°C', raw });
    } else if (s.hum !== undefined) out.push({ ...base, kind: 'humidity', value: num(s.hum) / 10, unit: '%', raw: num(s.hum) });
    else if (s.imp !== undefined) out.push({ ...base, kind: 'pulse', value: num(s.imp), unit: 'unit/h (pulse meter; 0 = no pulse yet)', raw: num(s.imp) });
    else if (s.P !== undefined) out.push({ ...base, kind: 'sdm_power', value: num(s.P), unit: 'W', raw: num(s.P), active: act });
    else if (s.U !== undefined) out.push({ ...base, kind: 'sdm_voltage', value: num(s.U) / 10, unit: 'V', raw: num(s.U), active: act });
    else if (s.I !== undefined) out.push({ ...base, kind: 'sdm_current', value: num(s.I) / 10, unit: 'A', raw: num(s.I), active: act });
    else out.push({ ...base, kind: 'unknown', value: null, unit: '', raw: 0 });
  }
  return out;
}

export function decodeInputs(live: Snapshot, names?: Snapshot): Input[] {
  return mergeNames(values(live.inputs), names?.inputs).map(i => ({
    id: i.id, name: i.description ?? '', on: num(i.state) > 0,
    enabled: i.enabled !== undefined ? num(i.enabled) === 1 : undefined, nc: i.nc !== undefined ? num(i.nc) === 1 : undefined,
  }));
}

export function decodeUsens(json: UsensJson): { senq: number; list: Usens[] } {
  const u = json.usensor ?? {};
  const list: Usens[] = [];
  for (const [k, v] of Object.entries(u)) {
    if (!/^\d+$/.test(k) || !v || typeof v !== 'object') continue;
    const r = v as RawUsens; const type = num(r.type); const t = USENS_TYPES[type] ?? { name: `type ${type}`, unit: '' };
    const st = num(r.state);
    list.push({ id: parseInt(k, 10), name: r.description ?? '', type, typeName: t.name, unit: t.unit, value: num(r.val) / 10,
      state: st === 1 ? 'ok' : st === 2 ? 'stale' : 'none', enabled: num(r.en) === 1, age: num(r.age), refresh: num(r.refresh), err: num(r.err) });
  }
  return { senq: num((u as Record<string, unknown>).senq), list: list.sort((a, b) => a.id - b.id) };
}

// ---- termosztat (a Homey/MQTT modell: rele vagy nem-mixer, nem-PWM PCA, aktivator 1..100 / 301+) -------------------------
export type ThermoKind = 'thermostat' | 'humidity' | 'sun' | 'mixer' | 'dimmer';
export interface Thermostat {
  id: number; type: 'relay' | 'pca' | 'fet'; name: string; kind: ThermoKind;
  sensor: number; sourceName: string; current: number | null; unit: string;
  on: number; off: number;           // x10 nyers kuszobok (sensorON / sensorOFF)
  target: number; band: number;      // C (kozep, sav)
  mode: 'heat' | 'cool'; active: boolean; settable: boolean;
}
export function thermoSource(sensor: number, sensors: SensorReading[], usens: Usens[]): { name: string; value: number | null; unit: string } {
  if (sensor >= 1 && sensor <= 100) { const s = sensors.find(x => x.kind === 'temperature' && x.id === sensor); return { name: s?.name || `1-Wire #${sensor}`, value: s ? s.value : null, unit: '°C' }; }
  if (sensor >= 101 && sensor <= 110) { const s = sensors.find(x => x.kind === 'humidity' && x.id === sensor); return { name: s?.name || `humidity #${sensor - 100}`, value: s ? s.value : null, unit: '%' }; }
  if (sensor === 255) return { name: 'sun (1 = sunrise, 2 = sunset)', value: null, unit: '' };
  if (sensor >= 301) { const u = usens.find(x => x.id === sensor - 300); return { name: u?.name || `usens #${sensor - 300}`, value: u && u.state === 'ok' ? u.value : null, unit: u?.unit ?? '' }; }
  return { name: `sensor ${sensor}`, value: null, unit: '' };
}
export function decodeThermostats(devices: Device[], sensors: SensorReading[], usens: Usens[]): Thermostat[] {
  const out: Thermostat[] = [];
  for (const d of devices) {
    if (!d.sensor || d.type === 'group') continue;
    const on = d.sensorON ?? 0, off = d.sensorOFF ?? 0;
    const kind: ThermoKind = d.sensor === 255 ? 'sun' : d.mixer ? 'mixer' : d.sensor >= 101 && d.sensor <= 110 ? 'humidity' : d.type === 'pca' && d.pwm ? 'dimmer' : 'thermostat';
    const src = thermoSource(d.sensor, sensors, usens);
    const cool = on > off;
    out.push({ id: d.id, type: d.type as 'relay' | 'pca' | 'fet', name: d.name, kind, sensor: d.sensor, sourceName: src.name, current: src.value, unit: src.unit,
      on, off, target: Math.round((on + off) / 2) / 10, band: Math.abs(off - on) / 10, mode: cool ? 'cool' : 'heat', active: d.on,
      settable: kind === 'thermostat' || kind === 'humidity' });
  }
  return out;
}
/** uj ON/OFF kuszobok (x10) a cel es/vagy sav valtoztatasara - bajtra a fw MqttThNewThresholds-ja */
export function newThresholds(on: number, off: number, change: { target?: number; band?: number }): { on: number; off: number } {
  const cool = on > off;
  let w = Math.abs(off - on);
  let c2 = on + off;
  if (change.band !== undefined) { const b = Math.round(change.band * 10); if (b < 1 || b > 100) throw new Error('band must be 0.1..10'); w = b; }
  if (change.target !== undefined) { const t = Math.round(change.target * 10); if (t < -300 || t > 1000) throw new Error('target must be -30..100'); c2 = t * 2; }
  if (w === 0) w = 10;
  const lo = Math.trunc((c2 - w) / 2), hi = lo + w;
  return { on: cool ? hi : lo, off: cool ? lo : hi };
}
export function fmtThermostat(t: Thermostat): string {
  const cur = t.current === null ? 'n/a' : `${t.current}${t.unit}`;
  if (t.kind === 'sun') return `[${t.id}] ${t.name || '(unnamed)'}: sun-controlled, on at ${sunWord(t.on)}, off at ${sunWord(t.off)}, now ${t.active ? 'ON' : 'OFF'}`;
  if (t.kind === 'mixer' || t.kind === 'dimmer') return `[${t.id}] ${t.name || '(unnamed)'}: ${t.kind} mapped to ${t.sourceName} (${cur}) between ${t.on / 10} and ${t.off / 10}${t.unit}, now ${t.active ? 'ON' : 'OFF'}`;
  return `[${t.id}] ${t.name || '(unnamed)'} (${t.type}): target ${t.target}${t.unit} band ${t.band} [on ${t.on / 10}, off ${t.off / 10}] mode ${t.mode}, current ${cur} from ${t.sourceName}, ${t.active ? (t.mode === 'cool' ? 'COOLING' : 'HEATING') : 'idle'}`;
}

// ---- redony (vedelem-par: [0] = FEL, [1] = LE) ---------------------------------------------------------------------------
export interface Shutter { index: number; name: string; up: number; down: number; upName: string; downName: string; state: 'opening' | 'closing' | 'stopped'; }
export function commonName(a: string, b: string): string {
  let i = 0; while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
  let s = a.slice(0, i).replace(/[\s\-_./:]+$/, '');
  if (s.length < 2) s = a || b;
  return s;
}
export function decodeShutters(snap: Snapshot, devices: Device[]): Shutter[] {
  const byId = new Map(devices.map(d => [d.id, d]));
  const out: Shutter[] = [];
  let idx = 0;
  for (const p of values0(snap.protection)) {
    idx++;
    if (!p.element0 || !p.element1) continue;
    const up = baseId(p.element0), down = baseId(p.element1);
    const u = byId.get(up), dn = byId.get(down);
    const upName = p.element0d || u?.name || '', downName = p.element1d || dn?.name || '';
    out.push({ index: idx, name: upName && downName ? commonName(upName, downName) : upName || downName || `pair ${idx}`, up, down, upName, downName,
      state: u?.on ? 'opening' : dn?.on ? 'closing' : 'stopped' });
  }
  return out;
}
export const fmtShutter = (s: Shutter): string => `#${s.index} ${s.name}: ${s.state} (up [${s.up}] ${s.upName || ''}${s.state === 'opening' ? ' ON' : ''}, down [${s.down}] ${s.downName || ''}${s.state === 'closing' ? ' ON' : ''})`;

// ---- RGB (csoport "RGB..." nevvel, R/G/B kezdobetus PCA/FET tagok) -------------------------------------------------------
export interface RgbGroup { id: number; name: string; channels: [number, number, number]; levels: [number, number, number]; on: boolean; color: [number, number, number]; brightness: number; }
export function decodeRgb(devices: Device[], last: Map<number, [number, number, number]>): RgbGroup[] {
  const byId = new Map(devices.map(d => [d.id, d]));
  const out: RgbGroup[] = [];
  for (const g of devices.filter(d => d.type === 'group' && /^rgb/i.test(d.name))) {
    const ch: [number, number, number] = [0, 0, 0];
    for (const m of g.members ?? []) {
      const d = byId.get(baseId(m)); if (!d || d.level === undefined) continue;
      const c: 0 | 1 | 2 | -1 = d.name[0] === 'R' ? 0 : d.name[0] === 'G' ? 1 : d.name[0] === 'B' ? 2 : -1;
      if (c !== -1 && !ch[c]) ch[c] = d.id;
    }
    if (!ch[0] && !ch[1] && !ch[2]) continue;
    const lv: [number, number, number] = [0, 0, 0];
    let mx = 0;
    for (let c = 0; c < 3; c++) { lv[c] = ch[c] ? (byId.get(ch[c])!.level ?? 0) : 0; if (lv[c] > mx) mx = lv[c]; }
    const on = ch.some((id, c) => id && byId.get(id)!.on && lv[c] > 0) || (mx > 0);
    let base = lv; let bri = mx;
    if (on && mx > 0) last.set(g.id, [...lv] as [number, number, number]);
    else { base = last.get(g.id) ?? [255, 255, 255]; bri = Math.max(...base); }
    const color: [number, number, number] = [0, 1, 2].map(c => (bri ? Math.round((base[c] * 255) / bri) : 255)) as [number, number, number];
    out.push({ id: g.id, name: g.name, channels: ch, levels: lv, on: on && mx > 0, color, brightness: bri || 255 });
  }
  return out;
}
/** az uj csatorna-szintek (a fw MqttRgbCmdCalc-ja): on/off, szin (max-normalt), fenyero */
export function rgbLevels(g: RgbGroup, change: { on?: boolean; color?: [number, number, number]; brightness?: number }): [number, number, number] | 'off' | 'noop' {
  const base = g.color; let bri = g.brightness;
  if (change.brightness !== undefined) { bri = Math.max(0, Math.min(255, Math.round(change.brightness))); if (bri === 0) return 'off'; }
  if (change.color) {
    const m = Math.max(...change.color);
    if (m === 0) return 'off';
    return [0, 1, 2].map(c => Math.round((change.color![c] * bri) / m)) as [number, number, number];
  }
  if (change.on === false) return 'off';
  if (change.on === true && g.on && change.brightness === undefined) return 'noop';
  return [0, 1, 2].map(c => Math.round((base[c] * bri) / 255)) as [number, number, number];
}
export const fmtRgb = (g: RgbGroup): string => `[${g.id}] ${g.name}: ${g.on ? 'ON' : 'OFF'} color rgb(${g.color.join(', ')}) brightness ${g.brightness}/255 (channels R=[${g.channels[0] || '-'}] G=[${g.channels[1] || '-'}] B=[${g.channels[2] || '-'}], levels ${g.levels.join('/')})`;

// ---- szoveges megjelenites (a modellnek) -------------------------------------------------------------------------
export const sunWord = (v: number): string => (v === 1 ? 'sunrise' : v === 2 ? 'sunset' : String(v));
export function fmtDevice(d: Device): string {
  let s = `[${d.id}] ${d.name || '(unnamed)'}: ${d.on ? 'ON' : 'OFF'}`;
  if (d.level !== undefined && d.type !== 'relay') s += ` level ${d.level}/255 (${levelToPercent(d.level)}%)${d.pwm === false ? ' switch-mode' : ''}`;
  if (d.type === 'group') s += ` members [${(d.members ?? []).join(', ')}]${d.pullUp ? ' pullUp' : ''}`;
  if (d.sensor === 255) s += ` sun [on at ${sunWord(d.sensorON!)}, off at ${sunWord(d.sensorOFF!)}]`;
  else if (d.sensor) s += ` sensor ${d.sensor} [on ${d.sensorON! / 10}, off ${d.sensorOFF! / 10}]`;
  if (d.timerRemain !== undefined) s += ` auto-off in ${d.timerRemain}s`;
  else if (d.timer) s += ` timer ${d.timer}s`;
  if (d.delayRemain !== undefined) s += ` turns on in ${d.delayRemain}s`;
  if (d.roles?.length) s += ` {${d.roles.join(', ')}}`;
  if (d.offline) s += ' [expander OFFLINE]';
  return s;
}
export function fmtSensor(s: SensorReading): string {
  const v = s.value === null ? 'invalid' : `${Number.isInteger(s.value) ? s.value : s.value.toFixed(s.kind === 'temperature' ? 2 : 1)} ${s.unit}`;
  return `[${s.id}] ${s.name || '(unnamed)'}: ${v} (${s.kind})${s.active === false ? ' [inactive]' : ''}${s.offline ? ' [expander OFFLINE]' : ''}`;
}
export const fmtUsens = (u: Usens): string => `[usens ${u.id}] ${u.name || '(unnamed)'}: ${u.state === 'ok' ? `${u.value} ${u.unit}` : u.state === 'stale' ? `STALE (last ${u.value} ${u.unit}, ${u.age}s ago)` : 'no value yet'} (${u.typeName}${u.enabled ? '' : ', disabled'}${u.refresh ? `, failsafe ${u.refresh}s` : ''}; activator id ${300 + u.id})`;
export const fmtInput = (i: Input): string => `[${i.id}] ${i.name || '(unnamed)'}: ${i.on ? 'PRESSED/CLOSED' : 'open'}${i.enabled === false ? ' (disabled)' : ''}${i.nc ? ' (NC)' : ''}`;

// =====================================================================================================================
// 2. KOR (2026-10-25): beallitasok - a /setup es /users HTML var-blokkja (var NAME=...; NAME [i]='...';), timer.csv
// =====================================================================================================================
export type VarValue = number | string | VarValue[] | null;
export type VarBlock = Map<string, VarValue>;

/** a vezerlo oldalaiba agyazott JS-valtozok: csak literalok (szam, string, tomb, new Array(n)) es indexelt string-ertekadasok */
export function parseVarBlock(text: string): VarBlock {
  const vb: VarBlock = new Map();
  const re = /(?:^|[;\n\r])\s*(?:var\s+)?([A-Za-z_]\w*)\s*(?:\[(\d+)\])?\s*=\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|\[[^;]*\]|new Array\(\d*\))\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const [, name, idx, lit] = m;
    let val: VarValue;
    if (lit.startsWith("'") || lit.startsWith('"')) val = lit.slice(1, -1).replace(/\\(.)/g, '$1');
    else if (lit.startsWith('[')) {
      try { val = JSON.parse(lit) as VarValue; }
      catch {
        // JS-tomb egyszeres idezojeles stringekkel (['','192.168.1.60']): a stringeket JSON-ra alakitjuk
        try { val = JSON.parse(lit.replace(/'((?:[^'\\]|\\.)*)'/g, (_m, s: string) => JSON.stringify(s.replace(/\\(.)/g, '$1')))) as VarValue; } catch { continue; }
      }
    }
    else if (lit.startsWith('new Array')) val = [];
    else val = Number(lit);
    if (idx !== undefined) {
      let arr = vb.get(name);
      if (!Array.isArray(arr)) { arr = []; vb.set(name, arr); }
      (arr as VarValue[])[parseInt(idx, 10)] = val;
    } else vb.set(name, val);
  }
  return vb;
}
export const vnum = (vb: VarBlock, name: string, def = 0): number => { const v = vb.get(name); return typeof v === 'number' ? v : def; };
export const vstr = (vb: VarBlock, name: string, def = ''): string => { const v = vb.get(name); return typeof v === 'string' ? v : def; };
export const varr = (vb: VarBlock, name: string): VarValue[] => { const v = vb.get(name); return Array.isArray(v) ? v : []; };
export const vdesc = (vb: VarBlock, name: string): Map<number, string> => { const m = new Map<number, string>(); varr(vb, name).forEach((x, i) => { if (typeof x === 'string' && x) m.set(i, x); }); return m; };
const vn = (x: VarValue | undefined, def = 0): number => (typeof x === 'number' ? x : def);

/** esemeny-cel (bemenet-esemeny, idozito-param): az egyseges ID-ter szoveggel */
export function targetText(id: number, names: { relay?: Map<number, string>; pca?: Map<number, string>; fet?: Map<number, string>; group?: Map<number, string>; slot?: Map<number, string> }): string {
  if (!id) return 'none';
  const nm = (m: Map<number, string> | undefined, k: number) => (m?.get(k) ? ` "${m.get(k)}"` : '');
  if (id >= 1 && id <= 100) return `relay ${id}${nm(names.relay, id)}`;
  if (id >= 101 && id <= 116) return `FET ${id}${nm(names.fet, id - 100)}`;
  if (id >= 201 && id <= 216) return `FET ${id - 100} fade${nm(names.fet, id - 200)}`;
  if (id >= 501 && id <= 999) return `group ${id}${nm(names.group, id - 500)}`;
  if (id >= 1000 && id <= 1899) { const slot = id % 100; const cat = Math.floor((id - 1000) / 100); return `load scene ${slot}${nm(names.slot, slot)}${cat ? ` (category ${cat})` : ' (all)'}`; }
  if (id >= 2001 && id <= 3024) return `PCA ${id}${nm(names.pca, id - 2000)}`;
  if (id >= 4001 && id <= 5024) return `PCA ${id - 2000} fade${nm(names.pca, id - 4000)}`;
  if (id >= 3100 && id <= 3999) return `LED strip IO${Math.floor((id - 3100) / 100) + 1} program ${(id - 3100) % 100}`;
  return `id ${id}`;
}
export interface NameMaps { relay: Map<number, string>; pca: Map<number, string>; fet: Map<number, string>; group: Map<number, string>; slot: Map<number, string>; input: Map<number, string>; thermo: Map<number, string>; hum: Map<number, string>; }
export function nameMaps(vb: VarBlock): NameMaps {
  return { relay: vdesc(vb, 'relay_description'), pca: vdesc(vb, 'PCA_description'), fet: vdesc(vb, 'fet_description'), group: vdesc(vb, 'group_description'),
    slot: vdesc(vb, 'slot_description'), input: vdesc(vb, 'switch_description'), thermo: vdesc(vb, 'thermo_description'), hum: vdesc(vb, 'hum_description') };
}

// ---- globalisok ------------------------------------------------------------------------------------------------------
export interface Globals { name: string; version: string; timeZone: number; latitude: number; longitude: number; hitTimeLimit: number; pressTimeLimit: number; protCooldown?: number;
  tempTimer: number; humTimer: number; mixerTimer?: number; impulsePerUnit: number; consumptionUnit: string; clock: string; sunrise: string; sunset: string;
  eventLogger: boolean; sensorLogger?: boolean; actualSlot: number; bootUpSlot: number; ip: string; mdns?: string;
  dstAuto?: boolean; dstNow?: boolean; }   // [3.12.35 / 4.18.9+] automatikus EU nyari ido: pipa + most nyari ido van-e
export function decodeGlobals(vb: VarBlock): Globals {
  const two = (n: number) => String(n).padStart(2, '0');
  return {
    name: vstr(vb, 'MYIOname'), version: vstr(vb, 'version'), timeZone: vnum(vb, 'timeZone'), latitude: vnum(vb, 'latitude'), longitude: vnum(vb, 'longitude'),
    hitTimeLimit: vnum(vb, 'hitTimeLimit'), pressTimeLimit: vnum(vb, 'pressTimeLimit'), protCooldown: vb.has('protCooldown') ? vnum(vb, 'protCooldown') : undefined,
    tempTimer: vnum(vb, 'tempTimer'), humTimer: vnum(vb, 'humTimer'), mixerTimer: vb.has('mixerTimer') ? vnum(vb, 'mixerTimer') : undefined,
    impulsePerUnit: vnum(vb, 'impulsePerUnit'), consumptionUnit: vstr(vb, 'consumptionUnit'),
    clock: `${vnum(vb, 'year')}-${two(vnum(vb, 'month'))}-${two(vnum(vb, 'day'))} ${two(vnum(vb, 'hour'))}:${two(vnum(vb, 'minute'))}`,
    sunrise: `${two(vnum(vb, 'sunRiseHour'))}:${two(vnum(vb, 'sunRiseMinute'))}`, sunset: `${two(vnum(vb, 'sunSetHour'))}:${two(vnum(vb, 'sunSetMinute'))}`,
    eventLogger: vnum(vb, 'eventLogger') === 1, sensorLogger: vb.has('sensorLogger') ? vnum(vb, 'sensorLogger') === 1 : undefined,
    actualSlot: vnum(vb, 'actualSlot'), bootUpSlot: vnum(vb, 'bootUpSlot'), ip: varr(vb, 'ip').join('.'), mdns: vb.has('mdns') ? vstr(vb, 'mdns') : undefined,
    dstAuto: vb.has('dst_auto') ? vnum(vb, 'dst_auto') === 1 : undefined, dstNow: vb.has('dst_now') ? vnum(vb, 'dst_now') === 1 : undefined,
  };
}
export function fmtGlobals(g: Globals): string {
  const utc = (h: number) => `UTC${h >= 0 ? '+' : ''}${h}`;
  // [3.12.35 / 4.18.9+] bekapcsolt pipanal a timeZone a TELI (normal) eltolas, a hatalyos = timeZone + dst_now
  const dst = g.dstAuto === undefined ? '' : g.dstAuto
    ? ` (standard/winter offset) · automatic DST (EU) on, now ${g.dstNow ? 'summer' : 'standard'} time → in force ${utc(g.timeZone + (g.dstNow ? 1 : 0))}`
    : ' · automatic DST (EU) off (the time zone is the full offset)';
  const l = [
    `name "${g.name}" · firmware ${g.version} · ip ${g.ip}${g.mdns ? ` · mdns ${g.mdns}` : ''}`,
    `clock ${g.clock} (controller time) · time zone ${utc(g.timeZone)}${dst} · sunrise ${g.sunrise} · sunset ${g.sunset} · location ${g.latitude}, ${g.longitude}`,
    `buttons: hit (short press) limit ${g.hitTimeLimit} ms, press (long) ${g.pressTimeLimit} ms${g.protCooldown !== undefined ? ` · protection cooldown ${g.protCooldown} s` : ''}`,
    `sensor polling: temperature ${g.tempTimer} s, humidity ${g.humTimer} s${g.mixerTimer !== undefined ? `, mixer ${g.mixerTimer} s` : ''} · pulse meter: ${g.impulsePerUnit} pulses / ${g.consumptionUnit || 'unit'}`,
    `scenes: current slot ${g.actualSlot}, boot slot ${g.bootUpSlot} · event logger ${g.eventLogger ? 'on' : 'off'}${g.sensorLogger !== undefined ? ` · sensor logger ${g.sensorLogger ? 'on' : 'off'}` : ''}`,
  ];
  return l.join('\n');
}

// ---- kimenet-konfig ----------------------------------------------------------------------------------------------------
export interface OutputConfig { id: number; type: DeviceType; name: string; invert: boolean; alarm: boolean; justOn: boolean; timer: number; delay: number; sensor: number; on: number; off: number;
  min?: number; max?: number; fadeSpeed?: number; mixer?: boolean; pwm?: boolean; }
export function decodeOutputConfigs(vb: VarBlock): OutputConfig[] {
  const out: OutputConfig[] = []; const n = nameMaps(vb);
  const rInv = varr(vb, 'relaysInvert'), rAl = varr(vb, 'relaysAlarm'), rJo = varr(vb, 'relaysJustOn'), rT = varr(vb, 'relay_timerDefault'), rD = varr(vb, 'relay_delayDefault'),
    rA = varr(vb, 'thermoActivator'), rOn = varr(vb, 'min_temp_ON'), rOff = varr(vb, 'max_temp_OFF');
  for (let i = 0; i < rInv.length; i++) out.push({ id: i + 1, type: 'relay', name: n.relay.get(i + 1) ?? '', invert: vn(rInv[i]) === 1, alarm: vn(rAl[i]) === 1, justOn: vn(rJo[i]) === 1,
    timer: vn(rT[i]), delay: vn(rD[i]), sensor: vn(rA[i]), on: vn(rOn[i]), off: vn(rOff[i]) });
  const fMin = varr(vb, 'fetMIN'), fMax = varr(vb, 'fetMAX'), fSp = varr(vb, 'fetFadeSpeed'), fA = varr(vb, 'fet_thermoActivator'), fOn = varr(vb, 'mix_temp_MIN'), fOff = varr(vb, 'mix_temp_MAX');
  for (let i = 0; i < fMin.length; i++) out.push({ id: 101 + i, type: 'fet', name: n.fet.get(i + 1) ?? '', invert: false, alarm: false, justOn: false, timer: 0, delay: 0,
    sensor: vn(fA[i]), on: vn(fOn[i]), off: vn(fOff[i]), min: vn(fMin[i]), max: vn(fMax[i]), fadeSpeed: vn(fSp[i]) });
  const pInv = varr(vb, 'PCA_invert'), pAl = varr(vb, 'PCA_Alarm'), pJo = varr(vb, 'PCA_JustOn'), pT = varr(vb, 'PCA_timerDefault'), pD = varr(vb, 'PCA_delayDefault'),
    pA = varr(vb, 'PCA_thermoActivator'), pOn = varr(vb, 'PCA_min_temp_ON'), pOff = varr(vb, 'PCA_max_temp_OFF'), pMin = varr(vb, 'PCAMIN'), pMax = varr(vb, 'PCAMAX'),
    pSp = varr(vb, 'PCAFadeSpeed'), pMx = varr(vb, 'PCA_Mixer'), pPwm = varr(vb, 'PCA_PWM');
  for (let i = 0; i < pInv.length; i++) out.push({ id: 2001 + i, type: 'pca', name: n.pca.get(i + 1) ?? '', invert: vn(pInv[i]) === 1, alarm: vn(pAl[i]) === 1, justOn: vn(pJo[i]) === 1,
    timer: vn(pT[i]), delay: vn(pD[i]), sensor: vn(pA[i]), on: vn(pOn[i]), off: vn(pOff[i]), min: vn(pMin[i]), max: vn(pMax[i]), fadeSpeed: vn(pSp[i]), mixer: vn(pMx[i]) === 1, pwm: vn(pPwm[i]) === 1 });
  return out;
}
export function fmtOutputConfig(c: OutputConfig): string {
  const flags = [c.invert ? 'inverted' : '', c.alarm ? 'alarm' : '', c.justOn ? 'justOn' : '', c.pwm ? 'PWM' : c.pwm === false ? 'switch-mode' : '', c.mixer ? 'mixer' : ''].filter(Boolean).join(', ');
  let s = `[${c.id}] ${c.name || '(unnamed)'} (${c.type}): timer ${c.timer}s, delay ${c.delay}s`;
  if (c.min !== undefined) s += `, min ${c.min}, max ${c.max}, fade speed ${c.fadeSpeed}`;
  if (c.sensor === 255) s += `, sensor sun [on at ${sunWord(c.on)}, off at ${sunWord(c.off)}]`;
  else if (c.sensor) s += `, sensor ${c.sensor} [on ${c.on / 10}, off ${c.off / 10}]`;
  return s + (flags ? ` {${flags}}` : '');
}

// ---- bemenet-konfig ----------------------------------------------------------------------------------------------------
export interface InputConfig { id: number; name: string; enabled: boolean; nc: boolean; hitBlock: boolean; hit: number; press: number; release: number; }
export function decodeInputConfigs(vb: VarBlock): InputConfig[] {
  const n = nameMaps(vb); const en = varr(vb, 'switchEnabled'), nc = varr(vb, 'switchNC'), hb = varr(vb, 'hitBlockEnabled'), h = varr(vb, 'hitEvent'), p = varr(vb, 'pressEvent'), r = varr(vb, 'releaseEvent');
  const out: InputConfig[] = [];
  for (let i = 0; i < en.length; i++) out.push({ id: i + 1, name: n.input.get(i + 1) ?? '', enabled: vn(en[i]) === 1, nc: vn(nc[i]) === 1, hitBlock: vn(hb[i]) === 1, hit: vn(h[i]), press: vn(p[i]), release: vn(r[i]) });
  return out;
}
export const fmtInputConfig = (c: InputConfig, n: NameMaps): string =>
  `[${c.id}] ${c.name || '(unnamed)'}: ${c.enabled ? 'enabled' : 'DISABLED'}${c.nc ? ', NC' : ''}${c.hitBlock ? ', hit-block' : ''} · hit -> ${targetText(c.hit, n)} · press -> ${targetText(c.press, n)} · release -> ${targetText(c.release, n)}`;

// ---- szerkezetek: vedelem-par, csatolo-par, csoport -----------------------------------------------------------------
export interface ProtectionDef { index: number; up: number; down: number; priority: boolean; }
export interface JoinerDef { index: number; master: number; slave: number; justOn: boolean; }
export interface GroupDef { index: number; id: number; name: string; members: number[]; pullUp: boolean; }
export function decodeStructures(vb: VarBlock): { protection: ProtectionDef[]; joiner: JoinerDef[]; groups: GroupDef[]; groupSize: number; pq: number; jq: number; gq: number } {
  const n = nameMaps(vb);
  const rp = varr(vb, 'relayProtection') as VarValue[][], pr = varr(vb, 'protectionPriority'), rj = varr(vb, 'relayJoiner') as VarValue[][], jj = varr(vb, 'joinerJustON'),
    rg = varr(vb, 'relay_group') as VarValue[][], pu = varr(vb, 'pullUpGroup');
  const protection = rp.map((p, i) => ({ index: i, up: vn(p?.[0]), down: vn(p?.[1]), priority: vn(pr[i]) === 1 })).filter(p => p.up || p.down);
  const joiner = rj.map((p, i) => ({ index: i, master: vn(p?.[0]), slave: vn(p?.[1]), justOn: vn(jj[i]) === 1 })).filter(p => p.master || p.slave);
  const groups = rg.map((g, i) => ({ index: i, id: 501 + i, name: n.group.get(i + 1) ?? '', members: (g ?? []).map(x => vn(x)).filter(Boolean), pullUp: vn(pu[i]) === 1 })).filter(g => g.members.length || g.name);
  return { protection, joiner, groups, groupSize: rg[0]?.length ?? 10, pq: rp.length, jq: rj.length, gq: rg.length };
}

// ---- jelenetek (slotok) ------------------------------------------------------------------------------------------------
export interface SceneSlot { slot: number; name: string; exists: boolean; }
export function decodeScenes(vb: VarBlock): { actual: number; boot: number; slots: SceneSlot[] } {
  const ex = varr(vb, 'slotExist'), nm = vdesc(vb, 'slot_description');
  const slots: SceneSlot[] = [];
  ex.forEach((e, i) => { if (vn(e) === 1 || nm.has(i)) slots.push({ slot: i, name: nm.get(i) ?? '', exists: vn(e) === 1 }); });
  return { actual: vnum(vb, 'actualSlot'), boot: vnum(vb, 'bootUpSlot'), slots };
}

// ---- felhasznalok ------------------------------------------------------------------------------------------------------
export interface UserSlot { slot: number; name: string; rights: 'admin' | 'editor' | 'user' | '?'; }
export function decodeUsers(vb: VarBlock): UserSlot[] {
  const ex = varr(vb, 'slotExist'), nm = vdesc(vb, 'userName'), ad = varr(vb, 'admin'), ed = varr(vb, 'editor'), us = varr(vb, 'user');
  const out: UserSlot[] = [];
  ex.forEach((e, i) => { if (vn(e) === 1) out.push({ slot: i, name: nm.get(i) ?? '', rights: vn(ad[i]) ? 'admin' : vn(ed[i]) ? 'editor' : vn(us[i]) ? 'user' : '?' }); });
  return out;
}

// ---- idozitok (timer.csv, OSZLOP-sorrendu: 1. sor id-k, 2. honap, 3. nap, 4. ora, 5. perc, 6. napok-maszk, 7. esemeny, 8. param, 9. napkelte, 10. napnyugta)
export const TIMER_EVENTS: Record<number, string> = {
  0: 'none', 1: 'load scene (all)', 2: 'relay ON', 3: 'relay OFF', 4: 'FET ON', 5: 'FET OFF', 6: 'group ON', 7: 'group OFF', 8: 'load scene: general',
  9: 'load scene: PWM', 10: 'load scene: inputs', 11: 'load scene: groups', 12: 'load scene: outputs', 13: 'load scene: protection', 14: 'load scene: PCA',
  15: 'PCA ON', 16: 'PCA OFF', 17: 'load scene: energy manager', 18: 'SG-Ready mode',
};
export const TIMER_ANY = 80;    // honap/nap/ora/perc: barmely ("-")
export const TIMER_ALL = 90;    // ora/perc: minden ("all")
export interface Timer { id: number; month: number; day: number; hour: number; minute: number; days: number; event: number; param: number; sunrise: number; sunset: number; }
export function parseTimerCsv(text: string): Timer[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (lines.length < 10) return [];
  const col = (i: number) => lines[i].split(',').map(x => parseInt(x, 10));
  const ids = col(0), mo = col(1), da = col(2), ho = col(3), mi = col(4), dy = col(5), ev = col(6), pa = col(7), sr = col(8), ss = col(9);
  return ids.map((id, i) => ({ id, month: mo[i], day: da[i], hour: ho[i], minute: mi[i], days: dy[i], event: ev[i], param: pa[i], sunrise: sr[i], sunset: ss[i] })).filter(t => Number.isFinite(t.id));
}
export const DAY_BITS: [string, number][] = [['Mon', 64], ['Tue', 32], ['Wed', 16], ['Thu', 8], ['Fri', 4], ['Sat', 2], ['Sun', 1]];
export const daysText = (mask: number): string => (mask ? DAY_BITS.filter(([, b]) => mask & b).map(([n]) => n).join(',') : 'every day');
export function daysMask(days: string[] | number | undefined): number {
  if (days === undefined) return 0;
  if (typeof days === 'number') return days;
  let m = 0;
  for (const d of days) { const hit = DAY_BITS.find(([n]) => n.toLowerCase() === d.slice(0, 3).toLowerCase()); if (!hit) throw new Error(`unknown day "${d}" (Mon..Sun)`); m |= hit[1]; }
  return m;
}
export function fmtTimer(t: Timer, n: NameMaps): string {
  const f = (v: number, kind: 'month' | 'day' | 'hour' | 'minute') => (v === TIMER_ANY ? 'any' : v === TIMER_ALL ? 'every' : kind === 'hour' || kind === 'minute' ? String(v).padStart(2, '0') : String(v));
  let when: string;
  if (t.sunrise || t.sunset) {
    const ofs = (t.hour < 80 ? t.hour * 60 : 0) + (t.minute < 80 ? t.minute : 0);
    const ref = t.sunrise ? 'sunrise' : 'sunset'; const mode = (t.sunrise || t.sunset) === 2 ? 'before' : 'after';
    when = ofs ? `${ofs} min ${mode} ${ref}` : `at ${ref}`;
  } else when = `${f(t.hour, 'hour')}:${f(t.minute, 'minute')}`;
  const date = t.month === TIMER_ANY && t.day === TIMER_ANY ? '' : ` on ${f(t.month, 'month')}/${f(t.day, 'day')}`;
  const ev = TIMER_EVENTS[t.event] ?? `event ${t.event}`;
  const tgt = t.event === 18 ? `mode ${t.param}` : t.event === 1 || (t.event >= 8 && t.event <= 14) || t.event === 17 ? `slot ${t.param}${n.slot.get(t.param) ? ` "${n.slot.get(t.param)}"` : ''}`
    : t.event === 2 || t.event === 3 ? targetText(t.param, n) : t.event === 4 || t.event === 5 ? targetText(t.param <= 16 ? 100 + t.param : t.param, n)
    : t.event === 6 || t.event === 7 ? targetText(t.param <= 100 ? 500 + t.param : t.param, n) : t.event === 15 || t.event === 16 ? targetText(t.param <= 2000 ? 2000 + t.param : t.param, n) : String(t.param);
  return `#${t.id}: ${when}${date}, ${daysText(t.days)} -> ${ev}: ${tgt}`;
}
/** a t_* parancssor egy POST-ban (sorrend: t_id ... t_eventParam = commit) */
export function timerCommand(t: Timer): string {
  return `t_id=${t.id}&t_month=${t.month}&t_day=${t.day}&t_hour=${t.hour}&t_minute=${t.minute}&t_days=${t.days}&t_sunrise=${t.sunrise}&t_sunset=${t.sunset}&t_event=${t.event}&t_eventParam=${t.param}`;
}
