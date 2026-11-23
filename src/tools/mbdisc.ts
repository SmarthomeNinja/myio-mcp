/**
 * Modbus busz-felderites + sablon-gyujtemeny eszkozei (MODBUS_PLAN.md 9.8, D6 2026-11-18) - vezerlo 4.29+, panel-fw 0.8+.
 *   myio_modbus_discover   estimate | start | stop | status | wait | result | guide   (a felderitest a PANEL viszi: mb_disc / mb_dstop /
 *                          mb_dprobe / mb_dcn parancsok, allapot + eredmeny: mbscan.json; a Mely keresest csak confirm=true inditja)
 *   myio_modbus_templates  list | get | apply | save   (gyujtemeny: CDN-index + csomagolt masolat + a vezerlo sajat /modbus/*.json fajljai;
 *                          apply: sablon egy slave-cimre - az IRO-SLOTOK KIKAPCSOLVA jonnek letre; save: sajat sablon a vezerlore)
 * KAPCSOLO MOGOTT (BuildOptions.modbusDiscovery; a helyi szerveren MYIO_MODBUS_DISCOVERY=1, alapbol KI): a Claude Directory-biralat
 * alatt sem a felhos szerver, sem az npm-csomag eszkozlistaja nem valtozhat. A meglevo myio_modbus / myio_modbus_set semaja ezert
 * VALTOZATLAN - a sablon-alkalmazas kulon eszkoz, nem a myio_modbus_set uj akcioja.
 * A gyujtemeny cime: MYIO_MODBUS_CDN (alap https://okoslak.hu/ext2/modbus/; "off" = csak a csomagolt masolat).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MyIOClient } from '../api.js';
import { FEAT, num } from '../model.js';
import { ToolContext, WR, WR_CFG, text, fail, serverArg, sleep, gate, kv, sendCmds } from './common.js';
import {
  MbMeta, MbTemplate, MbProbe, ProbeSlot, MB_BAUDS, MB_FRAMES, MB_CATS, MB_VERIFIED, GUIDE, bundledTemplates, metaOfIndex, metaOfTemplate, probeList, probeCmds,
  discStatusLine, discResultText, isRunning, applyPlan, templateFromDevice, probeFromDevice, checkTemplate, templateText, cleanName,
} from '../model_modbus.js';

type J = Record<string, unknown>;
const CDN_DEFAULT = 'https://okoslak.hu/ext2/modbus/';
const cdnBase = (): string => { const v = (process.env.MYIO_MODBUS_CDN ?? CDN_DEFAULT).trim(); return /^https?:\/\//i.test(v) ? (v.endsWith('/') ? v : v + '/') : ''; };
let cdnCache: { at: number; base: string; dev: J[] } | undefined;
async function cdnJson<T>(url: string): Promise<T | undefined> {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(6000) }); return r.ok ? ((await r.json()) as T) : undefined; } catch { return undefined; }
}
/** a CDN-index (10 percig gyorsitotarban); nem elerheto -> ures (a csomagolt masolat a tartalek) */
async function cdnIndex(): Promise<J[]> {
  const base = cdnBase(); if (!base) return [];
  if (cdnCache && cdnCache.base === base && Date.now() - cdnCache.at < 600_000) return cdnCache.dev;
  const j = await cdnJson<{ dev?: J[] }>(base + 'index.json');
  const dev = Array.isArray(j?.dev) ? j!.dev! : [];
  if (dev.length) cdnCache = { at: Date.now(), base, dev };
  return dev;
}
const ownFiles = async (c: MyIOClient): Promise<string[]> => {
  try { const j = await c.fm<{ entries?: { n: string; d?: number }[] }>('fm.json', { vol: 'q', dir: '/modbus' }); return (j.entries ?? []).filter(e => !e.d && /\.json$/i.test(e.n)).map(e => e.n.replace(/\.json$/i, '')); }
  catch { return []; }
};
const ownTemplate = async (c: MyIOClient, id: string): Promise<MbTemplate | undefined> => {
  try { const t = await c.getJson<MbTemplate>(`~q/modbus/${id}.json`); return t && Array.isArray(t.blk) ? { ...t, id: t.id || id, name: t.name || id, fld: t.fld ?? [] } : undefined; } catch { return undefined; }
};
/** a teljes lista: CDN (v2 meta) + ami a csomagolt masolatbol a CDN-en nincs meg + a vezerlo sajat sablonjai (torzzsel: legfeljebb 8) */
async function collection(c?: MyIOClient): Promise<{ metas: MbMeta[]; cdn: boolean }> {
  const idx = (await cdnIndex()).map(metaOfIndex).filter((m): m is MbMeta => !!m);
  const bundle = bundledTemplates();
  for (const m of idx) if (!m.probe && bundle[m.id]?.probe) m.probe = bundle[m.id].probe;       // regi (v1) index: a csomagolt masolat alairasa
  const metas = [...idx, ...Object.values(bundle).filter(t => !idx.some(m => m.id === t.id)).map(t => metaOfTemplate(t, 'bundled'))];
  if (c) {
    const own = await ownFiles(c);
    for (const id of own.slice(0, 8)) { const t = await ownTemplate(c, id); metas.push(t ? metaOfTemplate({ ...t, id }, 'own') : { id, src: 'own', name: id, vendor: '', model: '', cat: '', verified: 0, wr: 0, manual: '', baud: 0, frame: -1, addr: 0, ver: 0, date: '' }); }
    for (const id of own.slice(8)) metas.push({ id, src: 'own', name: id, vendor: '', model: '', cat: '', verified: 0, wr: 0, manual: '', baud: 0, frame: -1, addr: 0, ver: 0, date: '' });
  }
  return { metas, cdn: idx.length > 0 };
}
/** sablon-torzs azonosito szerint: sajat (ha kerik / csak ott van) -> CDN -> csomagolt masolat */
async function templateBody(id: string, c: MyIOClient | undefined, source?: string): Promise<{ t: MbTemplate; src: string } | undefined> {
  if (c && source !== 'cdn') { const own = (await ownFiles(c)).includes(id) ? await ownTemplate(c, id) : undefined; if (own) return { t: own, src: 'own' }; if (source === 'own') return undefined; }
  const base = cdnBase();
  if (base && (await cdnIndex()).some(e => e.id === id)) { const t = await cdnJson<MbTemplate>(`${base}${id}.json`); if (t && Array.isArray(t.blk)) return { t: { ...t, id, fld: t.fld ?? [] }, src: 'cdn' }; }
  const b = bundledTemplates()[id];
  return b ? { t: b, src: 'bundled (snapshot of the collection)' } : undefined;
}
const fold = (t: string): string => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function registerModbusDiscTools(server: McpServer, ctx: ToolContext): void {
  const { reg } = ctx;
  const S = serverArg(reg);
  const scan = async (c: MyIOClient, panel?: number): Promise<{ p?: J; all: J[] }> => {
    const all = ((await c.getJson<{ mbscan?: { panels?: J[] } }>('mbscan.json')).mbscan?.panels ?? []);
    return { p: panel ? all.find(x => num(x.a) === panel) : all[0], all };
  };
  const panelOf = async (c: MyIOClient, panel: number): Promise<J | undefined> =>
    (((await c.getJson<{ modbus?: { panels?: J[] } }>('modbus.json')).modbus?.panels ?? []) as J[]).find(x => num(x.a) === panel);
  const knownNames = async (c: MyIOClient, panel: number): Promise<Map<number, string>> => {
    const m = new Map<number, string>();
    try { for (const d of ((await panelOf(c, panel))?.dev as J[]) ?? []) if (d.n) m.set(num(d.a), String(d.n)); } catch { /* a nevek nelkul is megy */ }
    return m;
  };

  server.registerTool('myio_modbus_discover', {
    title: 'Modbus bus discovery',
    description: 'Find an unknown Modbus RTU device on an Ext-RS485 panel (controller 4.29+, panel firmware 0.8+): the panel tries the bus speeds, parities, both A/B directions and the addresses, '
      + 'identifies what answers (functions, Device ID, signature reads) and gives advice codes (H1..H13). While it runs, Modbus polling and writes PAUSE on that panel - tell the user first. '
      + 'action: guide (the step-by-step work order - read it first), estimate (seconds, nothing starts), start (mode search ~1.5-2 min | deep 20-40 min; note = what the installer connected; '
      + 'a deep search starts only with confirm=true, after the user agreed to the estimated time), stop (the partial result is kept), status, '
      + 'wait (returns when a new device appears, the run ends or timeout_s passes - then call it again with known_new), result (devices, raw probe data, advice, matching template). '
      + 'The result is also on the controller as /modbus/scan/last.json.',
    inputSchema: {
      action: z.enum(['guide', 'estimate', 'start', 'stop', 'status', 'wait', 'result']),
      panel: z.number().int().min(1).optional().describe('expander address of the Modbus panel (default: the first one)'),
      mode: z.enum(['search', 'deep']).optional(), note: z.string().max(64).optional().describe('what the installer connected: make and model'),
      from: z.number().int().min(1).max(247).optional(), to: z.number().int().min(1).max(247).optional(),
      both_ab: z.boolean().optional().describe('deep: try both A/B directions even if one is already proven'), slow: z.boolean().optional().describe('slow devices: scan with the bus timeout'),
      fc4: z.boolean().optional().describe('try FC4 everywhere'), keep_going: z.boolean().optional().describe('deep: do not stop at the first new device'),
      force: z.boolean().optional().describe('scan although another master talks on the bus (the two will collide)'),
      confirm: z.boolean().optional().describe('required to start a deep search: the user agreed to the estimated time'),
      known_new: z.number().int().min(0).optional().describe('wait: how many new devices you already know about (default 0)'), timeout_s: z.number().int().min(5).max(55).optional(), server: S,
    },
    annotations: WR,
  }, async (a) => {
    if (a.action === 'guide') return text(GUIDE);
    const c = reg.pick(a.server);
    await c.require(FEAT.modbusDisc, 'the Modbus bus discovery');
    const first = await scan(c, a.panel);
    const p0 = first.p;
    if (!p0) return fail(a.panel ? `${c.name}: no Modbus panel #${a.panel} (panels: ${first.all.map(x => `#${num(x.a)}`).join(', ') || 'none'})` : `${c.name}: no Ext-RS485 Modbus panel is configured`);
    const P = num(p0.a);
    const mode = a.mode === 'deep' ? 1 : 0;
    const opts = (a.both_ab ? 1 : 0) | (a.force ? 4 : 0) | (a.keep_going ? 8 : 0) | (a.slow ? 16 : 0) | (a.fc4 ? 32 : 0);
    const range = `${a.from ?? 0}*${a.to ?? 0}`;
    const needPanel = (): string | undefined => (!num(p0.cap) ? `${c.name}: panel #${P} has no bus discovery (panel firmware 0.8+ is needed)` : !num(p0.on) ? `${c.name}: panel #${P} is OFFLINE` : undefined);
    const estimate = async (): Promise<number> => {
      await c.command(`mb_disc*${P}*${mode | 128}*${range}*${opts}=0`);
      await sleep(300);
      const e = (await scan(c, P)).p;
      return e && num(e.estm) === mode ? num(e.est) : 0;
    };
    const mins = (s: number) => (s < 90 ? `${s} s` : `about ${Math.round(s / 60)} min`);
    switch (a.action) {
      case 'status': return text(`${c.name} ${discStatusLine(p0)}`);
      case 'result': return text(`${c.name} ${discResultText(p0, (await collection(c)).metas, await knownNames(c, P))}`);
      case 'estimate': {
        const g = gate(ctx, 'state'); if (g) return g;
        const np = needPanel(); if (np) return fail(np);
        if (isRunning(p0)) return fail(`${c.name}: a discovery is already running on panel #${P} - ${discStatusLine(p0)}`);
        const est = await estimate();
        return text(`${c.name} panel #${P}: a ${mode ? 'deep search' : 'search'} would take ${est ? mins(est) : 'an unknown time (no estimate from the panel)'}`
          + (mode ? ' (the shorter figure applies if the A/B direction is already proven by an answering device; it stops after the first new device).' : '.')
          + ' Modbus polling and writes pause on this panel while it runs. Nothing was started.');
      }
      case 'stop': {
        const g = gate(ctx, 'state'); if (g) return g;
        if (!isRunning(p0)) return text(`${c.name}: nothing to stop. ${discStatusLine(p0)}`);
        await c.command(`mb_dstop*${P}=1`);
        await sleep(800);
        const p = (await scan(c, P)).p ?? p0;
        return text(`${c.name}: stop sent. ${discStatusLine(p)}${isRunning(p) ? '\n! the panel still reports a running discovery' : ''}`);
      }
      case 'start': {
        const g = gate(ctx, 'state'); if (g) return g;
        const np = needPanel(); if (np) return fail(np);
        if (isRunning(p0)) return fail(`${c.name}: a discovery is already running on panel #${P} - ${discStatusLine(p0)} (action=stop ends it)`);
        if (mode && !a.confirm) {
          const est = await estimate();
          return text(`${c.name} panel #${P}: NOT started. A deep search tries every speed, parity, A/B direction and address and takes ${est ? mins(est) : '20-40 minutes'}; `
            + 'Modbus polling and writes pause on this panel meanwhile (it stops by itself after the first new device, and can be stopped any time). '
            + 'Tell the user the time and ask; start it with confirm=true only after a yes.');
        }
        if (a.note !== undefined) await c.command(kv(`mb_dcn${P}`, a.note));
        const { metas } = await collection(c);
        const pc = probeCmds(P, probeList(metas, a.note ?? String(p0.note ?? '')), (p0.probes as ProbeSlot[]) ?? []);
        if (pc.length) await sendCmds(c, pc);
        await c.command(`mb_disc*${P}*${mode}*${range}*${opts}=0`);
        await sleep(900);
        const p = (await scan(c, P)).p ?? p0;
        if (!isRunning(p) && num((p.run as J)?.id) === num((p0.run as J)?.id))
          return fail(`${c.name}: the discovery did not start on panel #${P} (the panel is busy with a raw request / address scan, or went offline). ${discStatusLine(p)}`);
        // SDM-celu mezo a panelen: a fogyasztas-szabalyzo a futas alatt az utolso mert ertekkel szamol (nincs elavulas-jelzese)
        let sdm = false;
        try { sdm = (((await panelOf(c, P))?.fld as number[][]) ?? []).some(f => f[0] !== 255 && f[6] >= 201 && f[6] <= 221); } catch { /* a figyelmeztetes nelkul is megy */ }
        return text(`${c.name}: discovery started. ${discStatusLine(p)}\nEstimated time ${mins(num((p.run as J)?.tot) || num(p.est))}. Use action=wait to be told when a new device appears or the run ends, then action=result.`
          + (sdm ? '\n! This panel feeds the SDM meter values: until the run ends the consumption control (energy manager, consumption-controlled outputs) keeps working with the LAST measured value - tell the user.' : ''));
      }
      case 'wait': {
        const until = Date.now() + (a.timeout_s ?? 45) * 1000, knownNew = a.known_new ?? 0;
        let p = p0;
        for (;;) {
          if (!isRunning(p)) {
            if (num((p.run as J)?.st) >= 2 && !num(p.detail) && Date.now() < until) { await sleep(1500); p = (await scan(c, P)).p ?? p; continue; }   // a reszletek meg jonnek a panelrol
            return text(`${c.name} (run finished) ${discResultText(p, (await collection(c)).metas, await knownNames(c, P))}`);
          }
          if (num(p.nnew) > knownNew) return text(`${c.name}: NEW DEVICE FOUND while the run continues (new devices: ${num(p.nnew)}).\n${discResultText(p, (await collection(c)).metas, await knownNames(c, P))}\n`
            + `Call action=wait known_new=${num(p.nnew)} to keep waiting, or action=stop if this is the device.`);
          if (Date.now() >= until) return text(`${c.name}: still running. ${discStatusLine(p)}\nCall action=wait again${knownNew ? ` (known_new=${knownNew})` : ''}.`);
          await sleep(2500);
          p = (await scan(c, P)).p ?? p;
        }
      }
    }
    return fail('unknown action');
  });

  server.registerTool('myio_modbus_templates', {
    title: 'Modbus device templates',
    description: 'The Modbus template collection: one template = one device\'s register map (poll blocks, fields with names and units, write slots) plus bus settings, notes and an identification signature. '
      + 'Sources: the myIO collection (CDN), its snapshot bundled with this server, and the controller\'s own templates (/modbus/*.json). '
      + 'action: list (query = words from make / model / category), get (id: the whole template with notes and the manual link), '
      + 'apply (id or template, panel, slave: fills the next free rows for that slave address; bus=true also sets the bus speed/frame; to_sdm=true maps the SDM-marked fields into the controller\'s '
      + 'SDM meter variables - main meter only. WRITE SLOTS ARE CREATED DISABLED: enable one only after the user confirmed its register), '
      + 'save (store an own template on the controller: from_slave = build it from that device\'s rows on the panel, or template = a complete JSON; with notes_hu / notes_en, manual link, tested). '
      + 'list / get only read; apply / save need the editor level.',
    inputSchema: {
      action: z.enum(['list', 'get', 'apply', 'save']), query: z.string().optional(), id: z.string().max(16).optional().describe('template id (a-z, 0-9, _ -)'),
      source: z.enum(['own', 'cdn']).optional().describe('get / apply: force the controller\'s own copy or the collection\'s when both have the id'),
      panel: z.number().int().min(1).optional(), slave: z.number().int().min(1).max(247).optional(), bus: z.boolean().optional(), to_sdm: z.boolean().optional(),
      template: z.union([z.string(), z.record(z.string(), z.any())]).optional().describe('a complete template JSON (apply / save)'),
      from_slave: z.number().int().min(1).max(247).optional().describe('save: build the template from this device\'s rows'),
      name: z.string().max(64).optional(), vendor: z.string().max(24).optional(), model: z.string().max(32).optional(), category: z.enum(MB_CATS as [string, ...string[]]).optional(),
      manual: z.string().max(200).optional().describe('link to the device manual (http/https)'), notes_hu: z.string().max(600).optional(), notes_en: z.string().max(600).optional(),
      factory_address: z.number().int().min(1).max(247).optional(), tested: z.boolean().optional().describe('the values were checked on the real device'), author: z.string().max(40).optional(), server: S,
    },
    annotations: WR_CFG,
  }, async (a) => {
    const c = reg.pick(a.server);
    const inline = (): MbTemplate | string => {
      try { return (typeof a.template === 'string' ? JSON.parse(a.template) : a.template) as MbTemplate; } catch (e) { return `template is not valid JSON: ${(e as Error).message}`; }
    };
    switch (a.action) {
      case 'list': {
        const { metas, cdn } = await collection(c);
        const words = fold(a.query ?? '').split(/\s+/).filter(Boolean);
        const hit = metas.filter(m => { const hay = fold(`${m.name} ${m.vendor} ${m.model} ${m.id} ${m.cat}`); return words.every(w => hay.includes(w)); });
        const L = [`Modbus templates (${hit.length}${words.length ? ` of ${metas.length} match "${a.query}"` : ''}; collection ${cdn ? 'online' : 'NOT reachable - bundled snapshot'}):`];
        for (const m of hit) L.push(`  ${m.id} - ${m.name}${m.vendor || m.model ? ` (${[m.vendor, m.model].filter(Boolean).join(' / ')})` : ''}; ${m.cat || '-'}; ${m.src === 'own' ? 'own (on the controller)' : MB_VERIFIED[Math.min(m.verified, 2)]}`
          + `${m.baud ? `; ${m.baud} ${MB_FRAMES[m.frame] ?? ''}${m.addr ? `, factory address ${m.addr}` : ''}` : ''}${m.wr ? `; WRITES to the device (${m.wr} write slots)` : ''}${m.probe?.length ? '; has a signature' : ''}`);
        if (!hit.length) L.push('  (nothing - the device is not in the collection: find its register map and build the table by hand, then save it as a template)');
        return text(L.join('\n'));
      }
      case 'get': {
        if (!a.id) return fail('id is required for get');
        const r = await templateBody(a.id, c, a.source);
        if (!r) return fail(`no template "${a.id}"${a.source ? ` in ${a.source}` : ''} - see action=list`);
        return text(`${templateText(r.t, r.src)}\n----- JSON -----\n${JSON.stringify(r.t)}`);
      }
      case 'apply': {
        const g = gate(ctx, 'config'); if (g) return g;
        await c.require(FEAT.modbus, 'the Modbus master');
        if (!a.panel || !a.slave) return fail('panel and slave are required for apply');
        let tpl: MbTemplate, src = 'inline';
        if (a.template !== undefined) { const t = inline(); if (typeof t === 'string') return fail(t); tpl = t; }
        else { if (!a.id) return fail('id or template is required for apply'); const r = await templateBody(a.id, c, a.source); if (!r) return fail(`no template "${a.id}" - see action=list`); tpl = r.t; src = r.src; }
        const errs = checkTemplate(tpl); if (errs.length) return fail(`the template is not valid:\n  ${errs.join('\n  ')}`);
        const pn = await panelOf(c, a.panel);
        if (!pn) return fail(`${c.name}: no Modbus panel #${a.panel}`);
        if (!num(pn.on)) return fail(`${c.name}: panel #${a.panel} is OFFLINE - it would silently drop the rows`);
        if (!num(pn.ld)) return fail(`${c.name}: the table of panel #${a.panel} is not loaded yet - try again in a few seconds`);
        const plan = applyPlan(pn, tpl, a.slave, { bus: a.bus, toSdm: a.to_sdm });
        if (typeof plan === 'string') return fail(`${c.name}: ${plan}`);
        const posts = await sendCmds(c, plan.cmds);
        await sleep(900);
        const after = await panelOf(c, a.panel);
        const got = ((after?.blk as number[][]) ?? []).filter(b => b[0] === a.slave).length;
        const L = [`${c.name}: template "${tpl.id}" (${cleanName(tpl.name)}, ${src}) applied to panel #${a.panel}, slave ${a.slave}: blocks ${plan.blocks.join(', ') || '-'}; fields ${plan.fields.join(', ') || '-'}; write slots ${plan.writers.join(', ') || '-'} (${plan.cmds.length} commands in ${posts} request(s))`];
        if (a.bus) L.push(`  bus set to ${tpl.baud} ${MB_FRAMES[tpl.frame] ?? tpl.frame}`);
        L.push(got >= tpl.blk.length ? `  read back: ${got} block(s) for slave ${a.slave} are on the panel - values appear after the first poll (myio_modbus panel=${a.panel})` : `  ! read back: only ${got} of ${tpl.blk.length} block(s) are on the panel - the panel may have dropped commands (offline / busy); check with myio_modbus`);
        for (const w of plan.warnings) L.push(`  ! ${w}`);
        if (!a.to_sdm && tpl.fld.some(f => f.s)) L.push('  the fields are display-only for now: bind them to universal sensors (myio_modbus_set action=field ... target), or apply with to_sdm=true if this is the main meter');
        return text(L.join('\n'));
      }
      case 'save': {
        const g = gate(ctx, 'config'); if (g) return g;
        await c.require(FEAT.modbus, 'the Modbus master');
        let tpl: MbTemplate;
        if (a.template !== undefined) { const t = inline(); if (typeof t === 'string') return fail(t); tpl = { ...t }; if (a.id) tpl.id = a.id; }
        else {
          if (!a.panel || !a.from_slave || !a.id) return fail('save needs either template, or id + panel + from_slave');
          const pn = await panelOf(c, a.panel); if (!pn) return fail(`${c.name}: no Modbus panel #${a.panel}`);
          const old = (await ownFiles(c)).includes(a.id) ? await ownTemplate(c, a.id) : undefined;
          const probe: MbProbe[] = probeFromDevice(pn, a.from_slave);
          const t = templateFromDevice(pn, a.from_slave, { id: a.id, name: a.name ?? old?.name ?? ([a.vendor, a.model].filter(Boolean).join(' ') || a.id), vendor: a.vendor ?? old?.vendor, model: a.model ?? old?.model,
            cat: a.category ?? old?.cat, manual: a.manual ?? old?.manual, addr: a.factory_address ?? old?.addr, notes_hu: a.notes_hu ?? old?.notes_hu, notes_en: a.notes_en ?? old?.notes_en,
            verified: a.tested ?? !!old?.verified ? 1 : 0, author: a.author ?? old?.author, ver: old?.ver ? old.ver + 1 : 1, probe: probe.length ? probe : old?.probe });
          if (typeof t === 'string') return fail(`${c.name}: ${t}`);
          tpl = t;
        }
        const errs = checkTemplate(tpl); if (errs.length) return fail(`the template is not valid:\n  ${errs.join('\n  ')}`);
        const body = JSON.stringify(tpl);
        try { await c.fm('fm_mkdir', { vol: 'q', d: '/modbus' }); } catch { /* mar letezik */ }
        const n = await c.put(`~q/modbus/${tpl.id}.json`, body, 'application/json');
        if (a.panel && a.from_slave) await c.command(kv(`mb_dt${a.panel}_${a.from_slave}`, tpl.id));
        return text(`${c.name}: own template "${tpl.id}" saved (/modbus/${tpl.id}.json, ${n} B): ${tpl.blk.length} blocks, ${tpl.fld.length} fields, ${(tpl.wr ?? []).length} write slots`
          + `${tpl.probe?.length ? `, signature: ${tpl.probe.length} read(s)` : ', no signature (no characteristic live value)'}.\n`
          + 'To offer it to the myIO collection: the controller\'s /modbus page -> the device card -> "Save as template" -> "Send to myIO" (an e-mail to sablon@myio.hu, the file is attached by hand).');
      }
    }
    return fail('unknown action');
  });
}
