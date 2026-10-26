/**
 * Automatizalas (MYIO_MCP_PLAN.md 4.4, 3. kor 2026-10-25): Flow szabalymotor [4.4+] es myIO Script program-motor [4.10+].
 * A mentes-ut a webes szerkesztoke (js/flow.js, js/prog.js): PUT /flows.jsn + flow_reload=1, ill. PUT /prog/N.txt +
 * prog_reload=N - utana az eszkoz a visszaolvasott elo allapotot adja (a fw a hibas kartyat / programot csendben letiltja).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MyIOClient, MyIOError } from '../api.js';
import { FEAT, decodeDevices, decodeSensors, num } from '../model.js';
import {
  FlowsFile, FlowDef, FlowHook, FlowVar, FlowNamer, Issue, validateFlows, flowText, decodeFlowLive, flowTraceText,
  ProgJson, progText, progTraceText, setEnabledDirective,
} from '../model_auto.js';
import { ToolContext, RO, WR, WR_CFG, WR_CFG_SET, text, fail, serverArg, sleep, gate, usensOrEmpty, devices } from './common.js';
import { apiReference, scriptReference, flowReference, searchHeadings, headingList } from '../docs.js';

export interface FlowTrace { up?: number; n?: number; max?: number; err?: number; errflow?: number; fired?: number; evdrop?: number; tickmax?: number; overrun?: number; vars?: number[]; flows?: unknown[]; tseq?: number; trace?: unknown[][]; }

// ---- kozos segedek --------------------------------------------------------------------------------------------------------
export async function readFlows(c: MyIOClient): Promise<{ file: FlowsFile; exists: boolean }> {
  await c.require(FEAT.flow, 'the Flow rule engine');
  let t: string;
  try { t = await c.getText('flows.jsn'); }
  catch (e) { if (e instanceof MyIOError && e.status === 404) return { file: { formatVersion: 1, vars: [], flows: [], hooks: [] }, exists: false }; throw e; }
  try { return { file: JSON.parse(t) as FlowsFile, exists: true }; }
  catch (e) { throw new MyIOError(`${c.name}: flows.jsn on the controller is not valid JSON (${(e as Error).message}) - replace it with myio_flow_save file=...`); }
}
export const flowTrace = (c: MyIOClient, since?: number) => c.getJson<FlowTrace>(since ? `flowtrace.json?since=${since}` : 'flowtrace.json');

export async function flowNamer(c: MyIOClient, file: FlowsFile): Promise<{ namer: FlowNamer; outputs: Set<number> }> {
  const names = await c.names();
  const devs = decodeDevices(names, names);
  const sens = decodeSensors(names, names);
  const us = await usensOrEmpty(c);
  const q = (s?: string) => (s ? ` "${s}"` : '');
  const kind = (id: number) => (id <= 100 ? 'relay' : id <= 116 ? 'FET' : id <= 999 ? 'group' : 'PCA');
  const vars = new Map((file.vars ?? []).map(v => [v.id, v.name]));
  const hooks = new Map((file.hooks ?? []).map(h => [h.id, h.name]));
  return {
    outputs: new Set(devs.map(d => d.id)),
    namer: {
      out: id => `${kind(id)} ${id}${q(devs.find(d => d.id === id)?.name)}`,
      thermo: ch => `1-Wire #${ch}${q(sens.find(s => s.kind === 'temperature' && s.id === ch)?.name)}`,
      hum: ch => `humidity #${ch}${q(sens.find(s => s.kind === 'humidity' && s.id === 101 + ch)?.name)}`,
      usens: id => `usens #${id}${q(us.find(u => u.id === id)?.name)}`,
      variable: id => `var${id}${q(vars.get(id))}`,
      hook: id => `#${id}${q(hooks.get(id))}`,
    },
  };
}

export async function flowLimits(c: MyIOClient, outputs?: Set<number>) {
  const i = (await c.info()).info;
  return { rq: num(i.RQ, 64), pcaq: num(i.PCAQ, 0), senq: num(i.SENQ, 100), fet: [...(outputs ?? [])].some(id => id >= 101 && id <= 116), outputs };
}
const issuesText = (iss: Issue[]) => iss.map(i => `  ${i.level === 'error' ? 'ERROR' : 'warning'} ${i.where}: ${i.msg}`).join('\n');

export async function readProg(c: MyIOClient, since?: number): Promise<ProgJson> {
  await c.require(FEAT.script, 'myIO Script (program engine)');
  return c.getJson<ProgJson>(since ? `prog.json?since=${since}` : 'prog.json');
}
/** a forras egy sora + jelzo a hibas oszlopnal */
function srcExcerpt(src: string, line?: number, col?: number): string {
  if (!line) return '';
  const l = src.split(/\r?\n/)[line - 1];
  if (l === undefined) return '';
  return `\n  ${String(line).padStart(4)} | ${l}\n       | ${' '.repeat(Math.max(0, (col ?? 1) - 1))}^`;
}

export function registerAutomationTools(server: McpServer, ctx: ToolContext): void {
  const { reg } = ctx;
  const S = serverArg(reg);

  // ======================================================== FLOW ============================================================
  server.registerTool('myio_flows', {
    title: 'Flow rules',
    description: 'The Flow rule engine (GIGA/Opta 4.4+): every rule as WHEN trigger / AND conditions / THEN actions in plain words with element names, '
      + 'its live state (enabled, running, last fired), the 32 global variables with live values and the webhook targets. id = one rule (with its raw JSON for editing); '
      + 'raw=true returns the whole flows.jsn (the format myio_flow_save takes). Editor/admin level.',
    inputSchema: { id: z.number().int().optional().describe('only this flow id'), raw: z.boolean().optional(), server: S },
    annotations: RO,
  }, async ({ id, raw, server: sv }) => {
    const c = reg.pick(sv);
    const { file, exists } = await readFlows(c);
    if (raw) return text(exists ? JSON.stringify(file, null, 1) : `${c.name}: no flows.jsn yet (no rules). An empty file: {"formatVersion":1,"vars":[],"flows":[],"hooks":[]}`);
    let tr: FlowTrace | undefined;
    try { tr = await flowTrace(c); } catch { tr = undefined; }
    const live = decodeFlowLive(tr?.flows);
    const { namer } = await flowNamer(c, file);
    const flows = (file.flows ?? []).filter(f => id === undefined || f.id === id);
    if (id !== undefined && !flows.length) return fail(`${c.name}: no flow with id ${id} (existing: ${(file.flows ?? []).map(f => f.id).join(', ') || 'none'})`);
    const L: string[] = [];
    L.push(`${c.name}: ${file.flows?.length ?? 0} flow(s) in flows.jsn${tr ? `, ${tr.n}/${tr.max} loaded, fired ${tr.fired ?? 0}x since boot` : ' (live state unavailable)'}`
      + (tr?.err ? `\n! ${tr.err} parse error(s) at the last load (last bad flow: ${tr.errflow}) - such flows are disabled` : ''));
    for (const f of flows) L.push(flowText(f, namer, live.get(f.id)));
    if (id !== undefined) { L.push('raw JSON:'); L.push(JSON.stringify(flows[0])); }
    else {
      const vals = tr?.vars ?? [];
      const named = new Map((file.vars ?? []).map(v => [v.id, v]));
      const vl = vals.map((v, i) => ({ id: i + 1, v })).filter(x => x.v || named.has(x.id));
      if (vl.length) L.push('variables: ' + vl.map(x => `var${x.id}${named.get(x.id)?.name ? ` "${named.get(x.id)!.name}"` : ''}=${x.v}`).join(', '));
      if (file.hooks?.length) L.push('webhooks:\n' + file.hooks.map(h => `  #${h.id} "${h.name ?? ''}" ${h.met ? 'POST' : 'GET'} ${h.url}${h.err ? ' (also on ERROR log lines)' : ''}${h.body ? ` body "${h.body}"` : ''}`).join('\n'));
    }
    return text(L.join('\n'));
  });

  server.registerTool('myio_flow_save', {
    title: 'Create / change / delete Flow rules',
    description: 'Edit flows.jsn and reload the engine (no restart). Give ONE of: flow (a whole rule object; replaces the rule with the same id or adds it), '
      + 'delete (flow id), variable {id,name,init} / delete_variable, hook {id,name,met,url,body,err,gap} / delete_hook, or file (the complete flows.jsn). '
      + 'The rule is validated against the controller\'s card rules first; nothing is written on error. dry_run=true only validates. '
      + 'Card format (keys are short): WHEN t=sens{src:thermo|hum|usens, ch|id, op:gt|lt, val x10, hyst x10} | scmp | out{id, dir 0 off/1 on/2 any} | time{min, days} | sun{ev:rise|set, off} | var{id, op, val} | boot; '
      + 'AND t=sens | scmp | out{id, on 0|1} | twin{from, to, days} | var; THEN t=rel|grp{id, act 0 off/1 on/2 toggle} | pca|fet{id, val 0..255} | delay{s|m} | var{id, op:set|inc|dec, val} | log{val} | msg | http{id: webhook slot, val}. '
      + 'days = bitmask bit0=Mon..bit6=Sun (127 = every day); minutes of day for time/twin; temperatures x10 (21.5 °C = 215). Full reference: myio_reference topic=flow. Editor/admin level.',
    inputSchema: {
      flow: z.record(z.any()).optional().describe('{"id":1,"name":"...","en":1,"when":{...},"and":[...],"then":[...]}'),
      delete: z.number().int().optional().describe('flow id to delete'),
      variable: z.object({ id: z.number().int(), name: z.string().optional(), init: z.number().int().optional() }).optional(),
      delete_variable: z.number().int().optional(),
      hook: z.object({ id: z.number().int(), name: z.string().optional(), met: z.number().int().optional(), url: z.string(), body: z.string().optional(), err: z.number().int().optional(), gap: z.number().int().optional() }).optional(),
      delete_hook: z.number().int().optional(),
      file: z.union([z.string(), z.record(z.any())]).optional().describe('the complete flows.jsn (replaces everything)'),
      dry_run: z.boolean().optional(),
      server: S,
    },
    annotations: WR_CFG_SET,
  }, async (a) => {
    const g = gate(ctx, 'config'); if (g) return g;
    const c = reg.pick(a.server);
    const ops = ['flow', 'delete', 'variable', 'delete_variable', 'hook', 'delete_hook', 'file'].filter(k => (a as Record<string, unknown>)[k] !== undefined);
    if (ops.length !== 1) return fail(`give exactly one of flow / delete / variable / delete_variable / hook / delete_hook / file (got ${ops.join(', ') || 'none'})`);
    const cur = await readFlows(c);
    let file: FlowsFile;
    let what = '';
    let previous: unknown;
    let focus: number | undefined;
    if (a.file !== undefined) {
      try { file = (typeof a.file === 'string' ? JSON.parse(a.file) : a.file) as FlowsFile; } catch (e) { return fail(`file is not valid JSON: ${(e as Error).message}`); }
      what = `replaced the whole flows.jsn (${cur.file.flows?.length ?? 0} -> ${file.flows?.length ?? 0} flows)`;
    } else {
      file = JSON.parse(JSON.stringify(cur.file)) as FlowsFile;
      file.formatVersion = file.formatVersion ?? 1;
      file.flows = file.flows ?? [];
      if (a.flow) {
        const f = a.flow as FlowDef;
        if (typeof f.id !== 'number') return fail('flow.id (a number) is required - pick an unused id to add a rule');
        const i = file.flows.findIndex(x => x.id === f.id);
        previous = i >= 0 ? file.flows[i] : undefined;
        if (i >= 0) file.flows[i] = f; else file.flows.push(f);
        what = `${i >= 0 ? 'replaced' : 'added'} flow ${f.id}`; focus = f.id;
      } else if (a.delete !== undefined) {
        const i = file.flows.findIndex(x => x.id === a.delete);
        if (i < 0) return fail(`no flow with id ${a.delete}`);
        previous = file.flows[i]; file.flows.splice(i, 1); what = `deleted flow ${a.delete}`;
      } else if (a.variable) {
        file.vars = file.vars ?? [];
        const v = a.variable as FlowVar; const i = file.vars.findIndex(x => x.id === v.id);
        previous = i >= 0 ? file.vars[i] : undefined;
        if (i >= 0) file.vars[i] = { ...file.vars[i], ...v }; else file.vars.push(v);
        what = `${i >= 0 ? 'changed' : 'added'} variable ${v.id}`;
      } else if (a.delete_variable !== undefined) {
        const i = (file.vars ?? []).findIndex(x => x.id === a.delete_variable);
        if (i < 0) return fail(`no variable ${a.delete_variable} in flows.jsn`);
        previous = file.vars!.splice(i, 1)[0]; what = `deleted variable ${a.delete_variable}`;
      } else if (a.hook) {
        await c.require(FEAT.webhooks, 'webhooks');
        file.hooks = file.hooks ?? [];
        const h = a.hook as FlowHook; const i = file.hooks.findIndex(x => x.id === h.id);
        previous = i >= 0 ? file.hooks[i] : undefined;
        if (i >= 0) file.hooks[i] = h; else file.hooks.push(h);
        what = `${i >= 0 ? 'replaced' : 'added'} webhook ${h.id}`;
      } else {
        const i = (file.hooks ?? []).findIndex(x => x.id === a.delete_hook);
        if (i < 0) return fail(`no webhook ${a.delete_hook} in flows.jsn`);
        previous = file.hooks!.splice(i, 1)[0]; what = `deleted webhook ${a.delete_hook}`;
      }
    }
    const { namer, outputs } = await flowNamer(c, file);
    const iss = validateFlows(file, await flowLimits(c, outputs));
    const errors = iss.filter(i => i.level === 'error');
    const preview = focus !== undefined ? '\n' + flowText(file.flows.find(f => f.id === focus)!, namer) : '';
    if (errors.length) return fail(`Not written - ${errors.length} error(s):\n${issuesText(iss)}${preview}`);
    if (a.dry_run) return text(`Dry run OK (${what}); nothing written.${iss.length ? '\n' + issuesText(iss) : ''}${preview}`);
    const body = JSON.stringify(file, null, 1);
    const n = await c.put('flows.jsn', body, 'application/json');
    await c.command('flow_reload=1');
    await sleep(900);
    let tr: FlowTrace | undefined;
    try { tr = await flowTrace(c); } catch { tr = undefined; }
    const L = [`${c.name}: ${what}; flows.jsn written (${n} B) and reloaded.`];
    if (iss.length) L.push(issuesText(iss));
    if (tr) {
      L.push(`engine: ${tr.n}/${tr.max} flows loaded${tr.err ? `, ! ${tr.err} parse error(s) (last bad flow ${tr.errflow}) - that flow is disabled` : ', no parse errors'}`);
      if (focus !== undefined) L.push(flowText(file.flows.find(f => f.id === focus)!, namer, decodeFlowLive(tr.flows).get(focus)));
    } else L.push('(live state could not be read back - check with myio_flows)');
    if (previous !== undefined) L.push(`previous version (to undo): ${JSON.stringify(previous)}`);
    return text(L.join('\n'));
  });

  server.registerTool('myio_flow', {
    title: 'Run / switch a Flow rule',
    description: 'Runtime control of the Flow engine (does NOT change flows.jsn): enable / disable a rule until the next reload or restart (use myio_flow_save en=0|1 to make it permanent), '
      + 'fire = run its THEN chain now (WHEN/AND skipped), set_var = set global variable id (1..32) to value (variable triggers are evaluated). '
      + 'The answer shows the outputs that changed and the trace. Editor/admin level.',
    inputSchema: { action: z.enum(['enable', 'disable', 'fire', 'set_var']), id: z.number().int().describe('flow id, or the variable id for set_var'), value: z.number().int().optional(), server: S },
    annotations: WR,
  }, async ({ action, id, value, server: sv }) => {
    const g = gate(ctx, 'state'); if (g) return g;
    const c = reg.pick(sv);
    await c.require(FEAT.flow, 'the Flow rule engine');
    if (action === 'set_var') {
      await c.require({ v4: '4.10.0' }, 'setting a flow variable over HTTP (flow_var* was ineffective before 4.10.0)');
      if (value === undefined) return fail('value is required for set_var');
      if (id < 1 || id > 32) return fail('variable id must be 1..32');
    }
    const { file } = await readFlows(c);
    if (action !== 'set_var' && !(file.flows ?? []).some(f => f.id === id)) return fail(`no flow with id ${id}`);
    const t0 = await flowTrace(c);
    const before = await devices(c);
    const cmd = action === 'enable' ? `flowen_on=${id}` : action === 'disable' ? `flowen_off=${id}` : action === 'fire' ? `flow_fire=${id}` : `flow_var*${id}=${value}`;
    await c.command(cmd);
    await sleep(action === 'fire' ? 600 : 300);
    const after = await devices(c);
    const t1 = await flowTrace(c, t0.tseq);
    const { namer } = await flowNamer(c, file);
    const names = new Map((file.flows ?? []).map(f => [f.id, f.name ?? '']));
    const L = [`${c.name}: sent ${cmd}`];
    if (action === 'set_var') L.push(`var${id} is now ${t1.vars?.[id - 1] ?? '?'}`);
    else { const f = file.flows.find(x => x.id === id)!; L.push(flowText(f, namer, decodeFlowLive(t1.flows).get(id))); }
    const bmap = new Map(before.list.map(d => [d.id, d]));
    const changed = after.list.filter(x => { const b = bmap.get(x.id); return b && (b.on !== x.on || b.level !== x.level); });
    if (changed.length) L.push('outputs that changed: ' + changed.map(x => `${x.type} ${x.id}${x.name ? ` "${x.name}"` : ''} ${x.on ? 'ON' : 'OFF'}${x.type !== 'relay' && x.level !== undefined ? ` ${x.level}/255` : ''}`).join(', '));
    if (t1.trace?.length) L.push('trace:\n' + t1.trace.slice(0, 20).map(r => '  ' + flowTraceText(r, num(t1.up), names)).join('\n'));
    if (action === 'fire' && !changed.length) L.push('(no output changed yet - a delay card may be running; see myio_flow_trace)');
    return text(L.join('\n'));
  });

  server.registerTool('myio_flow_trace', {
    title: 'Flow trace',
    description: 'What the Flow engine did recently (newest first): fired, AND failed, actions, delays, errors, webhook results, with seconds ago. '
      + 'since = the tseq of a previous call to get only newer entries (incremental). Also the engine budget statistics. Editor/admin level.',
    inputSchema: { since: z.number().int().optional(), limit: z.number().int().min(1).max(256).optional().describe('default 40'), server: S },
    annotations: RO,
  }, async ({ since, limit, server: sv }) => {
    const c = reg.pick(sv);
    const { file } = await readFlows(c);
    const tr = await flowTrace(c, since);
    const names = new Map((file.flows ?? []).map(f => [f.id, f.name ?? '']));
    const rows = (tr.trace ?? []).slice(0, limit ?? 40);
    return text([`${c.name}: tseq ${tr.tseq} (pass since=${tr.tseq} next time), ${rows.length} of ${tr.trace?.length ?? 0} entries; fired ${tr.fired ?? 0}, lost events ${tr.evdrop ?? 0}, `
      + `max tick ${tr.tickmax ?? 0} µs, budget overruns ${tr.overrun ?? 0}`, ...rows.map(r => '  ' + flowTraceText(r, num(tr.up), names))].join('\n'));
  });

  server.registerTool('myio_webhook_test', {
    title: 'Test a webhook',
    description: 'Fire webhook slot 1..8 (as loaded from flows.jsn hooks[]) once, without the gap brake, and report the HTTP result from the trace. GIGA/Opta 4.4.1+. Editor/admin level.',
    inputSchema: { slot: z.number().int().min(1).max(8), server: S },
    annotations: { ...WR, openWorldHint: true },
  }, async ({ slot, server: sv }) => {
    const g = gate(ctx, 'state'); if (g) return g;
    const c = reg.pick(sv);
    await c.require(FEAT.webhooks, 'webhooks');
    const t0 = await flowTrace(c);
    await c.command(`flow_whtest=${slot}`);
    for (let i = 0; i < 8; i++) {
      await sleep(800);
      const t = await flowTrace(c, t0.tseq);
      const hit = (t.trace ?? []).find(r => (Number(r[2]) === 10 || Number(r[2]) === 11) && Number(r[3]) === slot);
      if (hit) return text(`${c.name}: ${flowTraceText(hit, num(t.up), new Map())}`);
    }
    return text(`${c.name}: webhook ${slot} fired, no result in the trace within ~6 s (empty slot, or the outgoing HTTP slot is busy) - check myio_flow_trace later.`);
  });

  // ======================================================== SCRIPT ==========================================================
  server.registerTool('myio_scripts', {
    title: 'Scripts (myIO Script programs)',
    description: 'The program engine (GIGA/Opta 4.10+): every slot (prog/N.txt, 16 on GIGA, 8 on Opta) with name, state (off / RUNNING / ERROR with line:col and message), '
      + 'cycle time, runs, timing, local variables and arrays, plus the 32 global variables and (trace=true) the recent trace. Editor/admin level.',
    inputSchema: { id: z.number().int().optional(), trace: z.boolean().optional(), server: S },
    annotations: RO,
  }, async ({ id, trace, server: sv }) => {
    const c = reg.pick(sv);
    const p = await readProg(c);
    const progs = (p.progs ?? []).filter(x => id === undefined || x.id === id);
    const L = [`${c.name}: ${p.n ?? 0} of ${p.max} slots used (source max ${p.srcmax} B, min cycle ${p.everymin} ms); max tick ${p.tickmax} µs, max run ${p.runmax} µs`
      + `${p.err ? `, ${p.err} error notification(s)` : ''}${p.reload ? ', reload pending' : ''}`];
    for (const x of progs) if (x.st || id !== undefined) L.push(progText(x));
    const gv = (p.gvars ?? []).map((v, i) => ({ i: i + 1, v })).filter(x => x.v);
    if (gv.length && id === undefined) L.push('global variables (shared with Flow): ' + gv.map(x => `var${x.i}=${x.v}`).join(', '));
    if (trace && p.trace?.length) {
      const names = new Map((p.progs ?? []).map(x => [x.id, x.name ?? '']));
      L.push(`trace (tseq ${p.tseq}):\n` + p.trace.slice(0, 30).map(r => '  ' + progTraceText(r, num(p.up), names)).join('\n'));
    }
    return text(L.join('\n'));
  });

  server.registerTool('myio_script_get', {
    title: 'Read a script',
    description: 'The source code of script slot N (prog/N.txt) and its state. Language reference: myio_reference topic=script. Editor/admin level.',
    inputSchema: { id: z.number().int().min(1).max(16), server: S },
    annotations: RO,
  }, async ({ id, server: sv }) => {
    const c = reg.pick(sv);
    const p = await readProg(c);
    if (id > num(p.max, 16)) return fail(`${c.name} has ${p.max} script slots`);
    const slot = (p.progs ?? []).find(x => x.id === id);
    let src: string;
    try { src = await c.getText(`~q/prog/${id}.txt`); }
    catch (e) { if (e instanceof MyIOError && e.status === 404) return text(`${c.name}: slot ${id} is empty (no prog/${id}.txt) - create it with myio_script_save.`); throw e; }
    return text(`${c.name}: ${slot ? progText(slot, false) : `slot ${id}`}${slot?.st === 3 ? srcExcerpt(src, slot.el, slot.ec) : ''}\n----- prog/${id}.txt (${Buffer.byteLength(src)} B) -----\n${src}`);
  });

  server.registerTool('myio_script_save', {
    title: 'Write a script',
    description: 'Write the source of script slot N (prog/N.txt) and recompile it on the controller; the answer is the compile result (error with line:col and the source line) and the new state. '
      + 'enabled=true|false rewrites the #enabled directive. The file is the truth (#name, #every 1s, #enabled, #onboot header). Max size: 8 KB on GIGA, 4 KB on Opta. '
      + 'Language reference: myio_reference topic=script. Editor/admin level.',
    inputSchema: { id: z.number().int().min(1).max(16), source: z.string(), enabled: z.boolean().optional(), server: S },
    annotations: WR_CFG_SET,
  }, async ({ id, source, enabled, server: sv }) => {
    const g = gate(ctx, 'config'); if (g) return g;
    const c = reg.pick(sv);
    const p0 = await readProg(c);
    if (id > num(p0.max, 16)) return fail(`${c.name} has ${p0.max} script slots`);
    const src = enabled === undefined ? source : setEnabledDirective(source, enabled);
    const size = Buffer.byteLength(src);
    if (p0.srcmax && size > p0.srcmax) return fail(`source is ${size} B, ${c.name} accepts at most ${p0.srcmax} B per script (E39)`);
    return saveAndReload(c, id, src, 'written');
  });

  async function saveAndReload(c: MyIOClient, id: number, src: string, what: string): Promise<CallToolResult> {
    const n = await c.put(`prog/${id}.txt`, src, 'text/plain');
    await c.command(`prog_reload=${id}`);
    let p: ProgJson = {};
    for (let i = 0; i < 10; i++) { await sleep(400); p = await readProg(c); if (!p.reload) break; }
    const slot = (p.progs ?? []).find(x => x.id === id);
    const L = [`${c.name}: prog/${id}.txt ${what} (${n} B) and reloaded.`];
    if (!slot) L.push('(state not reported)');
    else {
      L.push(progText(slot));
      if (slot.st === 3) L.push(`compile error:${srcExcerpt(src, slot.el, slot.ec)}`);
      else if (slot.st === 1) L.push('compiled OK, the program is OFF (#enabled 0) - enable with myio_script action=enable');
      else if (slot.st === 2) L.push('compiled OK and running');
    }
    if (p.reload) L.push('(reload still pending - check again with myio_scripts)');
    return text(L.join('\n'));
  }

  server.registerTool('myio_script', {
    title: 'Run / switch / delete a script',
    description: 'Script slot actions: reload (recompile prog/N.txt; id 0 = all), run (run once now, even if disabled), enable / disable (RAM only until reload/restart; '
      + 'persist=true also rewrites #enabled in the file), delete (removes prog/N.txt, needs MYIO_WRITE=config). Editor/admin level.',
    inputSchema: { action: z.enum(['reload', 'run', 'enable', 'disable', 'delete']), id: z.number().int().min(0).max(16), persist: z.boolean().optional(), server: S },
    annotations: WR_CFG,
  }, async ({ action, id, persist, server: sv }) => {
    const g = gate(ctx, action === 'delete' || persist ? 'config' : 'state'); if (g) return g;
    const c = reg.pick(sv);
    const p0 = await readProg(c);
    if (id === 0 && action !== 'reload') return fail('id 0 (all) only works with reload');
    if (id > num(p0.max, 16)) return fail(`${c.name} has ${p0.max} script slots`);
    const slot0 = (p0.progs ?? []).find(x => x.id === id);
    if (action !== 'reload' && (!slot0 || !slot0.st)) return fail(`script slot ${id} is empty`);
    if ((action === 'enable' || action === 'disable') && persist) {
      const src = await c.getText(`~q/prog/${id}.txt`);
      return saveAndReload(c, id, setEnabledDirective(src, action === 'enable'), `#enabled ${action === 'enable' ? 1 : 0} written`);
    }
    if (action === 'delete') {
      const r = await c.fm<{ ok?: number }>('fm_del', { vol: 'q', f: `/prog/${id}.txt` });
      if (!r.ok) return fail(`${c.name}: could not delete prog/${id}.txt`);
      await c.command(`prog_reload=${id}`);
      await sleep(600);
      return text(`${c.name}: prog/${id}.txt deleted, slot ${id} is empty now. Previous name: "${slot0?.name ?? ''}"`);
    }
    if (action === 'enable' && slot0?.st === 3) return fail(`script ${id} has a compile error (${slot0.err}) - fix it with myio_script_save first`);
    const cmd = action === 'reload' ? `prog_reload=${id}` : action === 'run' ? `prog_run=${id}` : `progen*${id}*${action === 'enable' ? 1 : 0}`;
    await c.command(cmd);
    await sleep(action === 'reload' ? 900 : 400);
    const p = await readProg(c, p0.tseq);
    const names = new Map((p.progs ?? []).map(x => [x.id, x.name ?? '']));
    const L = [`${c.name}: sent ${cmd}`];
    for (const x of (p.progs ?? []).filter(x => (id === 0 ? x.st : x.id === id))) L.push(progText(x));
    if (p.trace?.length) L.push('trace:\n' + p.trace.slice(0, 12).map(r => '  ' + progTraceText(r, num(p.up), names)).join('\n'));
    if (action === 'enable' || action === 'disable') L.push('(RAM only - the file still says what it says; use persist=true to keep it after a reload/restart)');
    return text(L.join('\n'));
  });

  // ======================================================== REFERENCE =======================================================
  server.registerTool('myio_reference', {
    title: 'myIO language / API reference',
    description: 'The controller documentation bundled with this server (Hungarian, the canonical API_REFERENCE.md): topic=script = the complete myIO Script language '
      + '(directives, syntax, built-in functions, error codes, examples); topic=flow = the Flow engine and the flows.jsn card format; topic=api with query = the API sections whose '
      + 'heading contains the query (without query: the table of contents).',
    inputSchema: { topic: z.enum(['script', 'flow', 'api']), query: z.string().optional() },
    annotations: RO,
  }, async ({ topic, query }) => {
    const md = apiReference();
    if (!md) return fail('API_REFERENCE.md is not bundled with this server installation');
    if (topic === 'script') return text(scriptReference(md) || 'section 10/G not found');
    if (topic === 'flow') return text(flowReference(md) || 'section 10/D not found');
    if (!query) return text('Sections (ask topic=api query=<words from a heading>; also readable as resources myio://docs/chapter/<id>):\n' + headingList(md).join('\n'));
    const res = searchHeadings(query, md);
    return text(res || `no heading contains "${query}"`);
  });
}
