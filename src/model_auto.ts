/**
 * Automatizalas-modell (MYIO_MCP_PLAN.md 4.4, 3. kor 2026-10-25): Flow szabalymotor (flows.jsn + flowtrace.json) es
 * myIO Script program-motor (prog/N.txt + prog.json). Forras: API_REFERENCE.md 10/D + 10/G, a fw-parser
 * (MyIO_M7/_Flow.ino FlowApplyValue / FlowCardFinalize, flow_defs.h) - a validalas a fw szabalyait koveti, hogy a
 * hibas kartya MAR a feltoltes elott kiderulion (a fw csendben letiltja a flow-t).
 */

// ---- Flow: flows.jsn --------------------------------------------------------------------------------------------------
export interface FlowCard { t: string; [k: string]: unknown; }
export interface FlowDef { id: number; name?: string; en?: number; when?: FlowCard; and?: FlowCard[]; then?: FlowCard[]; [k: string]: unknown; }
export interface FlowVar { id: number; name?: string; init?: number; }
export interface FlowHook { id: number; name?: string; met?: number; url?: string; body?: string; err?: number; gap?: number; }
export interface FlowsFile { formatVersion: number; vars?: FlowVar[]; flows: FlowDef[]; hooks?: FlowHook[]; [k: string]: unknown; }

export const FLOW_LIMITS = { flows: 64, and: 8, then: 16, vars: 32, hooks: 8, str: 223 };
export const FLOW_CARDS = {
  when: ['sens', 'scmp', 'out', 'time', 'sun', 'var', 'boot'],
  and: ['sens', 'scmp', 'out', 'twin', 'var'],
  then: ['rel', 'grp', 'pca', 'fet', 'delay', 'var', 'log', 'msg', 'http'],
} as const;
type Ctx = keyof typeof FLOW_CARDS;
const CARD_KEYS: Record<string, string[]> = {
  sens: ['src', 'ch', 'id', 'op', 'val', 'hyst'], scmp: ['src', 'ch', 'id', 'op', 'src2', 'ch2', 'id2', 'dv', 'hyst'],
  out: ['id', 'dir', 'on'], time: ['min', 'days'], sun: ['ev', 'off', 'days'], var: ['id', 'op', 'val'], boot: [], twin: ['from', 'to', 'days'],
  rel: ['id', 'act'], grp: ['id', 'act'], pca: ['id', 'val'], fet: ['id', 'val'], delay: ['s', 'm'], log: ['val'], msg: [], http: ['id', 'val'],
};

export interface FlowLimits { rq: number; pcaq: number; senq: number; fet?: boolean; outputs?: Set<number>; }
export interface Issue { level: 'error' | 'warning'; where: string; msg: string; }

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** egyseges kimenet-ID ervenyes-e a fw FlowOutIdOk szerint (a csoport-plafont nem ismerjuk: 501..600) */
export function flowOutIdOk(id: number, lim: FlowLimits): boolean {
  return (id >= 1 && id <= lim.rq) || (!!lim.fet && id >= 101 && id <= 116) || (id > 500 && id <= 600) || (id >= 2001 && id < 2001 + lim.pcaq);
}

/** a teljes flows.jsn ellenorzese; error = a fw elutasitja / letiltja, warning = gyanus, de betoltheto */
export function validateFlows(f: unknown, lim: FlowLimits): Issue[] {
  const out: Issue[] = [];
  const err = (where: string, msg: string) => out.push({ level: 'error', where, msg });
  const warn = (where: string, msg: string) => out.push({ level: 'warning', where, msg });
  if (!isObj(f)) { err('file', 'flows.jsn must be a JSON object'); return out; }
  if (f.formatVersion !== 1) err('file', 'formatVersion must be the number 1 (without it the controller rejects the whole file)');
  if (!Array.isArray(f.flows)) { err('file', '"flows" must be an array'); return out; }
  if (f.flows.length > FLOW_LIMITS.flows) err('file', `at most ${FLOW_LIMITS.flows} flows (got ${f.flows.length}) - the rest is dropped`);
  for (const k of Object.keys(f)) if (!['formatVersion', 'flows', 'vars', 'hooks'].includes(k)) warn('file', `unknown top-level key "${k}" (ignored by the controller)`);

  const hookIds = new Set<number>();
  if (f.hooks !== undefined) {
    if (!Array.isArray(f.hooks)) err('hooks', '"hooks" must be an array');
    else (f.hooks as unknown[]).forEach((h, i) => {
      const w = `hooks[${i}]`;
      if (!isObj(h)) { err(w, 'must be an object'); return; }
      if (!isInt(h.id) || h.id < 1 || h.id > FLOW_LIMITS.hooks) err(w, `id must be 1..${FLOW_LIMITS.hooks}`);
      else if (hookIds.has(h.id)) err(w, `duplicate hook id ${h.id}`); else hookIds.add(h.id);
      if (h.met !== undefined && h.met !== 0 && h.met !== 1) err(w, 'met must be 0 (GET) or 1 (POST)');
      if (typeof h.url !== 'string' || !/^http:\/\//i.test(h.url)) err(w, 'url must be a string starting with http:// (no TLS on this path)');
      for (const k of ['url', 'body', 'name'] as const) {
        const v = h[k];
        if (v === undefined) continue;
        if (typeof v !== 'string') { err(w, `${k} must be a string`); continue; }
        if (Buffer.byteLength(v) > FLOW_LIMITS.str) err(w, `${k} is ${Buffer.byteLength(v)} B, the controller keeps at most ${FLOW_LIMITS.str} B`);
        if (k !== 'name' && /["\\\u0000-\u001f]/.test(v)) warn(w, `${k} contains a quote, backslash or control character - the controller's parser drops escaped characters`);
      }
      if (h.err !== undefined && h.err !== 0 && h.err !== 1) err(w, 'err must be 0 or 1');
      if (h.gap !== undefined && (!isInt(h.gap) || h.gap < 0)) err(w, 'gap must be an integer >= 0 (seconds)');
    });
  }

  const varIds = new Set<number>();
  if (f.vars !== undefined) {
    if (!Array.isArray(f.vars)) err('vars', '"vars" must be an array');
    else (f.vars as unknown[]).forEach((v, i) => {
      const w = `vars[${i}]`;
      if (!isObj(v)) { err(w, 'must be an object'); return; }
      if (!isInt(v.id) || v.id < 1 || v.id > FLOW_LIMITS.vars) err(w, `id must be 1..${FLOW_LIMITS.vars}`);
      else if (varIds.has(v.id)) err(w, `duplicate variable id ${v.id}`); else varIds.add(v.id);
      if (v.init !== undefined && !isInt(v.init)) err(w, 'init must be an integer');
    });
  }

  const ids = new Set<number>();
  (f.flows as unknown[]).forEach((fl, i) => {
    const w0 = `flows[${i}]`;
    if (!isObj(fl)) { err(w0, 'must be an object'); return; }
    const w = isInt(fl.id) ? `flow ${fl.id}` : w0;
    if (!isInt(fl.id) || fl.id < 1 || fl.id > 65535) err(w, 'id must be an integer 1..65535');
    else if (ids.has(fl.id)) err(w, `duplicate flow id ${fl.id}`); else ids.add(fl.id);
    if (fl.name !== undefined && typeof fl.name !== 'string') err(w, 'name must be a string');
    if (fl.en !== undefined && fl.en !== 0 && fl.en !== 1) err(w, 'en must be the number 0 or 1 (true/false is read as 0 = disabled)');
    if (!isObj(fl.when)) err(w, 'needs a "when" card (trigger) - without it the flow stays disabled');
    else checkCard(fl.when, 'when', `${w} when`);
    if (fl.and !== undefined) {
      if (!Array.isArray(fl.and)) err(w, '"and" must be an array');
      else { if (fl.and.length > FLOW_LIMITS.and) err(w, `at most ${FLOW_LIMITS.and} AND conditions`); fl.and.forEach((c, j) => checkCard(c, 'and', `${w} and[${j}]`)); }
    }
    if (!Array.isArray(fl.then) || !fl.then.length) err(w, 'needs a non-empty "then" array (actions) - without it the flow stays disabled');
    else { if (fl.then.length > FLOW_LIMITS.then) err(w, `at most ${FLOW_LIMITS.then} THEN actions`); fl.then.forEach((c, j) => checkCard(c, 'then', `${w} then[${j}]`)); }
    for (const k of Object.keys(fl)) if (!['id', 'name', 'en', 'when', 'and', 'then'].includes(k)) warn(w, `unknown key "${k}" (ignored)`);
  });
  return out;

  function checkCard(c: unknown, ctx: Ctx, w: string): void {
    if (!isObj(c)) { err(w, 'card must be an object'); return; }
    const t = c.t;
    if (typeof t !== 'string' || !(FLOW_CARDS[ctx] as readonly string[]).includes(t)) { err(w, `"t" must be one of ${FLOW_CARDS[ctx].join(', ')} here (got ${JSON.stringify(t)})`); return; }
    const known = CARD_KEYS[t] ?? [];
    for (const k of Object.keys(c)) {
      if (k === 't') continue;
      if (!known.includes(k)) warn(w, `key "${k}" is not used by a ${t} card (ignored)`);
      else if (!['src', 'src2', 'op', 'ev'].includes(k) && typeof c[k] !== 'number') err(w, `${k} must be a number`);
    }
    const num = (k: string) => (typeof c[k] === 'number' ? (c[k] as number) : undefined);
    const op = c.op;
    const sensSide = (srcK: string, chK: string, idK: string) => {
      const src = c[srcK];
      if (!['thermo', 'hum', 'usens', 'dht'].includes(String(src))) { err(w, `${srcK} must be thermo | hum | usens`); return; }
      if (src === 'thermo') { const ch = num(chK); if (ch === undefined || !Number.isInteger(ch) || ch < 1 || ch > 100) err(w, `${chK} must be the 1-Wire sensor index 1..100`); }
      else if (src === 'hum' || src === 'dht') { const ch = num(chK); if (ch === undefined || !Number.isInteger(ch) || ch < 0 || ch > 7) err(w, `${chK} must be the humidity channel 0..7`); }
      else { const id = num(idK); if (id === undefined || !Number.isInteger(id) || id < 1 || id > (lim.senq || 100)) err(w, `${idK} must be the universal sensor id 1..${lim.senq || 100}`); }
    };
    const outId = (k = 'id') => {
      const id = num(k);
      if (id === undefined || !Number.isInteger(id)) { err(w, `${k} (output id) is required`); return; }
      if (!flowOutIdOk(id, lim)) err(w, `output id ${id} is out of range (relay 1..${lim.rq}, group 501.., PCA 2001..${2000 + lim.pcaq}${lim.fet ? ', FET 101..116' : ''})`);
      else if (lim.outputs && !lim.outputs.has(id)) warn(w, `output ${id} is not visible on this controller (missing, or no permission)`);
    };
    const days = (dflt: string) => { const d = num('days'); if (d !== undefined && (!Number.isInteger(d) || d < 0 || d > 127)) err(w, 'days must be a bitmask 0..127 (bit0 = Monday ... bit6 = Sunday)'); else if (!d && dflt) warn(w, dflt); };
    switch (t) {
      case 'sens':
        sensSide('src', 'ch', 'id');
        if (!['gt', 'lt', 'eq', 'ne'].includes(String(op))) err(w, 'op must be gt | lt (eq = band with hyst, AND only) | ne');
        if (num('val') === undefined) err(w, 'val (threshold x10: 21.5 °C = 215) is required');
        break;
      case 'scmp':
        sensSide('src', 'ch', 'id'); sensSide('src2', 'ch2', 'id2');
        if (!['gt', 'lt', 'eq', 'ne'].includes(String(op))) err(w, 'op must be gt | lt | eq | ne');
        if (num('dv') !== undefined && (num('dv')! < -32768 || num('dv')! > 32767)) err(w, 'dv must fit -32768..32767 (x10)');
        break;
      case 'out':
        outId();
        if (ctx === 'when' && c.dir !== undefined && ![0, 1, 2].includes(c.dir as number)) err(w, 'dir must be 0 (turns OFF), 1 (turns ON) or 2 (any change)');
        if (ctx === 'and' && c.on !== 0 && c.on !== 1) err(w, 'on must be 0 or 1 (expected state)');
        break;
      case 'time': { const m = num('min'); if (m === undefined || !Number.isInteger(m) || m < 0 || m > 1439) err(w, 'min must be minute of day 0..1439'); days(''); break; }
      case 'sun':
        if (c.ev !== 'rise' && c.ev !== 'set') err(w, 'ev must be rise | set');
        if (num('off') !== undefined && Math.abs(num('off')!) > 720) err(w, 'off is minutes (-720..720)');
        days('');
        break;
      case 'twin': {
        for (const k of ['from', 'to']) { const m = num(k); if (m === undefined || !Number.isInteger(m) || m < 0 || m > 1440) err(w, `${k} must be minute of day 0..1440`); }
        days('days is missing/0: a time-window condition without days is NEVER true (use 127 = every day)');
        break;
      }
      case 'var': {
        const id = num('id'); if (id === undefined || !Number.isInteger(id) || id < 1 || id > FLOW_LIMITS.vars) err(w, `id must be the variable 1..${FLOW_LIMITS.vars}`);
        const ops = ctx === 'then' ? ['set', 'inc', 'dec'] : ['eq', 'ne', 'gt', 'lt'];
        if (!ops.includes(String(op))) err(w, `op must be ${ops.join(' | ')} here`);
        if (num('val') === undefined && ctx !== 'then') err(w, 'val is required');
        break;
      }
      case 'rel': case 'grp': {
        outId();
        const id = num('id') ?? 0;
        if (t === 'rel' && (id < 1 || id > lim.rq)) err(w, `relay card needs a relay id 1..${lim.rq} (use grp/pca for others)`);
        if (t === 'grp' && (id <= 500 || id > 600)) err(w, 'group card needs a group id 501..');
        if (![0, 1, 2].includes(c.act as number)) err(w, 'act must be 0 (off), 1 (on) or 2 (toggle)');
        break;
      }
      case 'pca': case 'fet': {
        outId();
        const id = num('id') ?? 0;
        if (t === 'pca' && (id < 2001 || id >= 2001 + lim.pcaq)) err(w, `pca card needs a PCA id 2001..${2000 + lim.pcaq}`);
        if (t === 'fet' && !lim.fet) err(w, 'this controller has no FET outputs - the controller disables a flow with a fet card');
        const v = num('val'); if (v === undefined || !Number.isInteger(v) || v < 0 || v > 255) err(w, 'val must be the raw level 0..255');
        break;
      }
      case 'delay': { const s = num('s') ?? 0, m = num('m') ?? 0; if (s < 0 || m < 0 || (!s && !m)) err(w, 'delay needs s (seconds) and/or m (minutes) > 0'); break; }
      case 'http': { const id = num('id'); if (id === undefined || id < 1 || id > FLOW_LIMITS.hooks) err(w, `id must be the webhook slot 1..${FLOW_LIMITS.hooks}`); else if (!hookIds.has(id)) warn(w, `webhook slot ${id} is not defined in hooks[]`); break; }
    }
  }
}

// ---- Flow: emberi leiras --------------------------------------------------------------------------------------------------
export interface FlowNamer { out(id: number): string; thermo(ch: number): string; hum(ch: number): string; usens(id: number): string; variable(id: number): string; hook(id: number): string; }
const OPS: Record<string, string> = { gt: '>', lt: '<', eq: '=', ne: '≠' };
export const hhmm = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const FLOW_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const flowDays = (mask: number | undefined): string => (!mask || mask === 127 ? 'every day' : FLOW_DAYS.filter((_, i) => mask & (1 << i)).join(','));
const x10 = (v: unknown): string => String(Math.round(Number(v ?? 0)) / 10);

function sensName(c: FlowCard, n: FlowNamer, srcK = 'src', chK = 'ch', idK = 'id'): { name: string; unit: string } {
  const src = c[srcK];
  if (src === 'thermo') return { name: n.thermo(Number(c[chK])), unit: '°C' };
  if (src === 'hum' || src === 'dht') return { name: n.hum(Number(c[chK])), unit: src === 'dht' ? '°C' : '%' };
  return { name: n.usens(Number(c[idK])), unit: '' };
}

export function cardText(c: FlowCard, ctx: Ctx, n: FlowNamer): string {
  switch (c.t) {
    case 'sens': {
      const s = sensName(c, n);
      if (c.op === 'eq') return `${s.name} within ${x10(c.val)}${s.unit} ± ${x10(c.hyst)}`;
      return `${s.name} ${OPS[String(c.op)] ?? c.op} ${x10(c.val)}${s.unit}${c.hyst ? ` (hysteresis ${x10(c.hyst)})` : ''}`;
    }
    case 'scmp': {
      const a = sensName(c, n), b = sensName(c, n, 'src2', 'ch2', 'id2'); const dv = Number(c.dv ?? 0);
      return `${a.name} ${OPS[String(c.op)] ?? c.op} ${b.name}${dv ? ` ${dv > 0 ? '+' : '−'} ${Math.abs(dv) / 10}` : ''}${c.hyst ? ` (hysteresis ${x10(c.hyst)})` : ''}`;
    }
    case 'out':
      if (ctx === 'when') { const d = c.dir === undefined ? 2 : Number(c.dir); return `${n.out(Number(c.id))} turns ${d === 1 ? 'ON' : d === 0 ? 'OFF' : 'ON or OFF'}`; }
      return `${n.out(Number(c.id))} is ${c.on ? 'ON' : 'OFF'}`;
    case 'time': return `at ${hhmm(Number(c.min))} (${flowDays(c.days as number)})`;
    case 'sun': { const off = Number(c.off ?? 0); return `at ${c.ev === 'rise' ? 'sunrise' : 'sunset'}${off ? ` ${off > 0 ? '+' : '−'}${Math.abs(off)} min` : ''} (${flowDays(c.days as number)})`; }
    case 'boot': return 'when the controller starts';
    case 'twin': return `time is between ${hhmm(Number(c.from))} and ${hhmm(Number(c.to))} (${c.days ? flowDays(c.days as number) : 'NO DAYS - never true'})`;
    case 'var':
      if (ctx === 'then') return `${n.variable(Number(c.id))} ${c.op === 'inc' ? '+=' : c.op === 'dec' ? '−=' : '='} ${c.val ?? (c.op === 'set' ? 0 : 1)}`;
      return `${n.variable(Number(c.id))} ${OPS[String(c.op)] ?? c.op} ${c.val}`;
    case 'rel': case 'grp': return `${n.out(Number(c.id))} ${c.act === 1 ? 'ON' : c.act === 0 ? 'OFF' : 'TOGGLE'}`;
    case 'pca': case 'fet': return `${n.out(Number(c.id))} level ${c.val}/255 (${Math.round((Number(c.val) / 255) * 100)} %)`;
    case 'delay': { const s = Number(c.s ?? 0) + Number(c.m ?? 0) * 60; return `wait ${s >= 60 && s % 60 === 0 ? `${s / 60} min` : `${s} s`}`; }
    case 'log': return `event-log entry (value ${c.val ?? 0})`;
    case 'msg': return 'web-UI notification (M59)';
    case 'http': return `webhook ${n.hook(Number(c.id))}${c.val !== undefined ? ` ($val=${c.val})` : ''}`;
    default: return JSON.stringify(c);
  }
}

/** flowtrace.json flows[] eleme: [id, flags, pc, delayRemainMs, lastFireS] */
export interface FlowLive { id: number; enabled: boolean; armed: boolean; running: boolean; pc: number; delayMs: number; lastFire: number; }
export function decodeFlowLive(rows: unknown): Map<number, FlowLive> {
  const m = new Map<number, FlowLive>();
  if (!Array.isArray(rows)) return m;
  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    const [id, flags, pc, dly, last] = r.map(Number);
    m.set(id, { id, enabled: !!(flags & 1), armed: !!(flags & 2), running: !!(flags & 4), pc, delayMs: dly, lastFire: last });
  }
  return m;
}

export function flowText(f: FlowDef, n: FlowNamer, live?: FlowLive): string {
  const st: string[] = [];
  if (live) {
    st.push(live.enabled ? 'enabled' : 'DISABLED');
    if (f.en !== 0 && !live.enabled) st.push('(the controller disabled it: invalid card, or switched off at runtime)');
    if (live.running) st.push(`running step ${live.pc + 1}${live.delayMs ? `, ${Math.round(live.delayMs / 1000)} s left in delay` : ''}`);
    if (live.lastFire) st.push(`last fired ${live.lastFire} s ago`); else st.push('not fired since boot');
  } else st.push(f.en === 0 ? 'disabled in file' : 'enabled in file');
  const lines = [`#${f.id} ${f.name ? `"${f.name}"` : '(no name)'} - ${st.join(', ')}`];
  if (f.when) lines.push(`  WHEN ${cardText(f.when, 'when', n)}`);
  for (const c of f.and ?? []) lines.push(`  AND  ${cardText(c, 'and', n)}`);
  (f.then ?? []).forEach((c, i) => lines.push(`  ${i ? '     ' : 'THEN '}${i + 1}. ${cardText(c, 'then', n)}`));
  return lines.join('\n');
}

// flowtrace ev-kodok (API-ref 10/D)
export const FLOW_TRACE_EV: Record<number, string> = {
  1: 'fired', 2: 'AND failed', 3: 'action', 4: 'delay started', 5: 'done', 6: 'event lost', 7: 're-trigger dropped', 8: 'error', 9: 'manual fire',
  10: 'webhook sent', 11: 'webhook error',
};
const WH_ERR: Record<number, string> = { [-1]: 'gap brake / empty slot', [-2]: 'queue full', [-3]: 'DNS failed', [-4]: 'connect failed', [-5]: 'timeout' };
/** [koraMs, flowId, ev, kartyaIdx, ertek] -> szoveg */
export function flowTraceText(row: unknown[], uptimeS: number, names: Map<number, string>): string {
  const [ms, id, ev, card, val] = row.map(Number);
  const ago = Math.max(0, Math.round(uptimeS - ms / 1000));
  const who = `flow ${id}${names.get(id) ? ` "${names.get(id)}"` : ''}`;
  let what = FLOW_TRACE_EV[ev] ?? `ev ${ev}`;
  if (ev === 2 || ev === 3 || ev === 8) what += ` (card ${card + 1}, value ${val})`;
  if (ev === 10) what += ` (slot ${card}, HTTP ${val})`;
  if (ev === 11) what += ` (slot ${card}: ${val > 0 ? `HTTP ${val}` : WH_ERR[val] ?? val})`;
  return `-${ago}s ${who}: ${what}`;
}

// ---- myIO Script: prog.json ----------------------------------------------------------------------------------------------
export interface ProgSlot {
  id: number; st: number; en?: number; name?: string; every?: number; boot?: number; runs?: number; last?: number; us?: number; max?: number; ovr?: number;
  drops?: number; lag?: number; code?: number; el?: number; ec?: number; err?: string; ln?: string[]; lv?: (number | null)[]; an?: string[]; av?: [number, number, number | null][];
}
export interface ProgJson { up?: number; max?: number; srcmax?: number; everymin?: number; tickmax?: number; runmax?: number; err?: number; reload?: number; progs?: ProgSlot[]; n?: number; gvars?: number[]; tseq?: number; trace?: unknown[][]; }
export const PROG_STATE = ['empty', 'off', 'RUNNING', 'ERROR'];
export function progText(p: ProgSlot, withLocals = true): string {
  if (!p.st) return `#${p.id} (empty)`;
  const head = `#${p.id} "${p.name ?? ''}" ${PROG_STATE[p.st] ?? p.st}${p.every ? ` every ${p.every} ms` : ''}${p.boot ? ', onboot' : ''}`;
  const parts = [head];
  if (p.st === 3 && p.err) parts.push(`  error: ${p.err}${p.el && !p.err.startsWith(`${p.el}:`) ? ` (line ${p.el}, col ${p.ec})` : ''}`);
  if (p.st >= 1) parts.push(`  runs ${p.runs ?? 0}, last ${p.last !== undefined && p.last >= 0 ? `${p.last} s ago` : 'never'}, ${p.us ?? 0} µs (max ${p.max ?? 0}), overruns ${p.ovr ?? 0}, dropped commands ${p.drops ?? 0}, skipped periods ${p.lag ?? 0}, ${p.code ?? 0} instructions`);
  if (withLocals && p.ln?.length) parts.push('  locals: ' + p.ln.map((n, i) => `${n}=${p.lv?.[i] ?? 'null'}`).join(', '));
  if (withLocals && p.an?.length) parts.push('  arrays: ' + p.an.map((n, i) => { const a = p.av?.[i]; return a ? `${n}[${a[0]}/${a[1]}] last=${a[2] ?? 'null'}` : n; }).join(', '));
  return parts.join('\n');
}
// prog trace ev (ProgTraceEv, prog_defs.h; API-ref 10/G.11)
const PROG_FN: Record<number, string> = { 40: 'on', 41: 'off', 42: 'toggle', 43: 'set', 48: 'msg', 49: 'hook' };
const PROG_REJ: Record<number, string> = { 1: 'bad id', 2: 'thermostat-controlled output', 3: 'flood brake', 4: 'scene slot missing' };
export function progTraceText(row: unknown[], uptimeS: number, names: Map<number, string>): string {
  const [ms, id, ev, a, val] = row.map(x => (x === null ? NaN : Number(x)));
  const ago = Math.max(0, Math.round(uptimeS - ms / 1000));
  const who = `script ${id}${names.get(id) ? ` "${names.get(id)}"` : ''}`;
  const t: Record<number, string> = {
    1: `loaded (${val} instructions)`, 2: `compile error at line ${a}, col ${val}`, 3: `command ${PROG_FN[a] ?? a} -> ${val}`, 4: `log${a ? ` value ${val}` : ''}`,
    5: `runtime error R${String(a).padStart(2, '0')} at pc ${val}`, 6: `time cap exceeded (${val} µs)`, 7: `${val ? 'enabled' : a ? 'stopped by stop()' : 'disabled'}`,
    8: `manual run (${val} µs)`, 9: `scene slot ${val} loaded`, 10: `global var ${a} = ${val}`, 11: `command rejected (${PROG_REJ[a] ?? a}, id ${val})`,
  };
  return `-${ago}s ${who}: ${t[ev] ?? `ev ${ev} a=${a} val=${val}`}`;
}

/** a #enabled direktiva atirasa - bajtra a webes szerkeszto pgSetDirective-je (js/prog.js): az elso #enabled sor csereje,
 *  hianyaban a fejlec utolso '#' sora utan (vagy a fajl elejere) */
export function setEnabledDirective(src: string, enabled: boolean): string {
  const line = `#enabled ${enabled ? 1 : 0}`;
  const re = /^[ \t]*#enabled\b.*$/m;
  if (re.test(src)) return src.replace(re, line);
  const lines = src.split('\n');
  let ins = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/^\s+/, '');
    if (l.charAt(0) === '#') { ins = i + 1; continue; }
    if (l === '' || l.startsWith('//')) continue;
    break;
  }
  lines.splice(ins, 0, line);
  return lines.join('\n');
}
