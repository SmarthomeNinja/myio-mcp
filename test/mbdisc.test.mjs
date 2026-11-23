// mbdisc.test.mjs - Modbus busz-felderites + sablon-gyujtemeny (MODBUS_PLAN.md 9.8, D6): a ket uj eszkoz KAPCSOLO MOGOTT van
// (MYIO_MODBUS_DISCOVERY=1) - alapbol az eszkozlista es a myio_reference semaja VALTOZATLAN (Directory-biralat). Felderites: becsles,
// inditas (megjegyzes + probalista a gyujtemenybol + start), mely kereses csak megerositessel, varakozas az elso talalatig / a vegeig,
// eredmeny tanaccsal es sablon-tippel, leallitas. Sablonok: lista (CDN + csomagolt masolat + sajat), lekeres, alkalmazas (az irok
// KIKAPCSOLVA), mentes a vezerlore az eszkoz soraibol; iras-szint es verzio-kapuk.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startMock } from './mock_myio.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, '..', 'dist', 'index.js');
async function connect(env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY], stderr: 'pipe', env: { ...process.env, MYIO_BASE_URL: '', MYIO_SERVERS: '', MYIO_MIN_GAP_MS: '0', MYIO_WRITE: 'admin', MYIO_MODBUS_DISCOVERY: '', MYIO_MODBUS_CDN: 'off', ...env } });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  return client;
}
const callText = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), isError: !!r.isError };
};
const f32hex = v => { const b = Buffer.alloc(4); b.writeFloatBE(v); return b.toString('hex'); };
// a gyujtemeny (CDN) a mockon: v2-index; acme_hp = kozossegi, IRO-SLOTOS hoszivattyu alairassal - a csomagolt masolatban NINCS benne
const ACME = { id: 'acme_hp', name: 'Acme HP-9 hőszivattyú', vendor: 'Acme', model: 'HP-9', cat: 'heatpump', ver: 3, date: '2026-11-10', verified: 1, manual: 'https://example.com/hp9.pdf', addr: 17, baud: 9600, frame: 1,
  notes_hu: 'A cím a menü 7.2 pontjában állítható.', probe: [{ fc: 3, reg: 100, n: 1, dt: 2, sc: -1, min: -40, max: 90 }, { fc: 3, reg: 4096, n: 2, dt: 3, ord: 1, in: [9001] }],
  blk: [{ func: 3, start: 100, count: 10, period: 5 }, { func: 4, start: 8192, count: 2, period: 1, fast: 1 }],
  fld: [{ b: 0, ofs: 0, dt: 2, sc: -1, n: 'Előremenő', u: '°C' }, { b: 0, ofs: 4, dt: 3, ord: 1, n: 'Üzemóra', u: 'h' }, { b: 1, ofs: 0, dt: 5, n: 'P', u: 'W', s: 201 }],
  wr: [{ func: 6, reg: 200, dt: 1, mode: 1, off: 200, on: 550, per: 30, n: 'Alapjel' }, { func: 5, reg: 3, dt: 1, off: 0, on: 1, n: 'Be/ki' }] };
const CDN = { 'index.json': { v: 2, dev: [
  { id: 'acme_hp', name: ACME.name, file: 'acme_hp.json', verified: 1, vendor: 'Acme', model: 'HP-9', cat: 'heatpump', ver: 3, date: '2026-11-10', manual: ACME.manual, bus: { baud: 9600, frame: '8E1', addr: 17 }, wr: 2, probe: ACME.probe },
  { id: 'sdm630', name: 'Eastron SDM630-Modbus (3 fázis)', file: 'sdm630.json', verified: 0 }] },      // regi (v1) sor: az alairas a csomagolt masolatbol jon
  'acme_hp.json': ACME };

let m, mOld, client, plain;
before(async () => {
  m = await startMock({ version: '4.29.0', cdn: CDN, mbFound: { addr: 5, baud: 2400, frame: '8E1', pol: 0, id: ['', '', ''], pr: [{ i: 0, st: 1, hex: '015e' }, { i: 1, st: 1, hex: '23290000' }] } });
  mOld = await startMock({ version: '4.28.0' });
  const servers = JSON.stringify([{ name: 'Dev', url: m.url }, { name: 'Regi', url: mOld.url }]);
  client = await connect({ MYIO_SERVERS: servers, MYIO_MODBUS_DISCOVERY: '1', MYIO_MODBUS_CDN: `${m.url}/__cdn/modbus/` });
  plain = await connect({ MYIO_SERVERS: servers });
});
after(async () => { await client.close(); await plain.close(); await m.close(); await mOld.close(); });

test('switch: off by default (105 tools, myio_reference schema unchanged); on = 2 more tools + topic=modbus', async () => {
  const off = (await plain.listTools()).tools, on = (await client.listTools()).tools;
  assert.equal(off.length, 105);
  assert.ok(!off.some(t => /^myio_modbus_(discover|templates)$/.test(t.name)), 'no discovery tools without the switch');
  assert.deepEqual(off.find(t => t.name === 'myio_reference').inputSchema.properties.topic.enum, ['script', 'flow', 'api']);
  assert.equal(on.length, 107);
  assert.deepEqual(on.find(t => t.name === 'myio_reference').inputSchema.properties.topic.enum, ['script', 'flow', 'api', 'modbus']);
  // a kapcsolo a TOBBI eszkoz leirasat es semajat nem erinti
  const strip = l => l.filter(t => !/^myio_modbus_(discover|templates)$|^myio_reference$/.test(t.name)).map(t => JSON.stringify([t.name, t.description, t.inputSchema, t.annotations]));
  assert.deepEqual(strip(on), strip(off));
  assert.equal(on.find(t => t.name === 'myio_modbus_discover').annotations.readOnlyHint, false);
  const ro = await connect({ MYIO_BASE_URL: m.url, MYIO_WRITE: 'read', MYIO_MODBUS_DISCOVERY: '1' });
  try { assert.ok(!(await ro.listTools()).tools.some(t => /^myio_modbus_(discover|templates)$/.test(t.name)), 'read level: the writing tools are not offered'); } finally { await ro.close(); }
});

test('guide + reference: the work order for the assistant', async () => {
  let r = await callText(client, 'myio_modbus_discover', { action: 'guide' });
  assert.match(r.text, /ASK before a Deep search/); assert.match(r.text, /Never write to a device register/); assert.match(r.text, /sablon@myio\.hu/);
  r = await callText(client, 'myio_reference', { topic: 'modbus' });
  assert.match(r.text, /work order for the assistant/);
  r = await plain.callTool({ name: 'myio_reference', arguments: { topic: 'modbus' } });
  assert.equal(!!r.isError, true, 'without the switch topic=modbus is rejected');
});

test('discover: version gate, estimate, deep needs confirm, start sends note + probes + start', async () => {
  let r = await callText(client, 'myio_modbus_discover', { action: 'status', server: 'Regi' });
  assert.equal(r.isError, true); assert.match(r.text, /4\.29/);
  r = await callText(client, 'myio_modbus_discover', { action: 'status' });
  assert.match(r.text, /panel #2: no discovery has run yet/);
  r = await callText(client, 'myio_modbus_discover', { action: 'status', panel: 7 });
  assert.equal(r.isError, true); assert.match(r.text, /no Modbus panel #7 \(panels: #2\)/);
  let from = m.log.length;
  r = await callText(client, 'myio_modbus_discover', { action: 'estimate' });
  assert.match(r.text, /a search would take 70 s/); assert.match(r.text, /Nothing was started/);
  assert.deepEqual(m.log.slice(from), ['mb_disc*2*128*0*0*0=0']);
  r = await callText(client, 'myio_modbus_discover', { action: 'estimate', mode: 'deep', both_ab: true });
  assert.match(r.text, /a deep search would take about 36 min/); assert.ok(m.log.includes('mb_disc*2*129*0*0*1=0'));
  // mely kereses megerosites nelkul: NEM indul, a becsult idot mondja
  from = m.log.length;
  r = await callText(client, 'myio_modbus_discover', { action: 'start', mode: 'deep' });
  assert.match(r.text, /NOT started/); assert.match(r.text, /about 36 min/); assert.match(r.text, /confirm=true/);
  assert.ok(!m.log.slice(from).some(c => /^mb_disc\*2\*1\*/.test(c)), 'no real start without confirm');
  assert.equal(m.mb.disc.run, null);
  // kereses: megjegyzes -> probalista (a megjegyzesre illo Acme elol, aztan a csomagolt sablonok alairasai) -> start
  from = m.log.length;
  r = await callText(client, 'myio_modbus_discover', { action: 'start', note: 'Acme HP-9', slow: true });
  const sent = m.log.slice(from);
  assert.equal(sent[0], 'mb_dcn2=Acme HP-9');     // (a mock naploja a dekodolt parancsot rogziti, mint a fw)
  assert.equal(sent[1], 'mb_dprobe*2*0*3*100=1'); assert.equal(sent[2], 'mb_dprobe*2*1*3*4096=2');
  assert.ok(sent.includes('mb_dprobe*2*2*4*0=2') && sent.includes('mb_dprobe*2*3*4*70=2') && sent.includes('mb_dprobe*2*4*3*64514=1'), 'the bundled Eastron signature follows: ' + sent.join(' | '));
  assert.equal(sent.filter(c => c.startsWith('mb_dprobe')).length, 8, 'all 8 slots are written when the controller knows none');
  assert.equal(sent[sent.length - 1], 'mb_disc*2*0*0*0*16=0');
  assert.match(r.text, /discovery started/); assert.match(r.text, /RUNNING \(search\)/); assert.match(r.text, /action=wait/);
  assert.equal(m.mb.disc.note, 'Acme HP-9');
  // masodik inditas futas kozben: hiba
  r = await callText(client, 'myio_modbus_discover', { action: 'start' });
  assert.equal(r.isError, true); assert.match(r.text, /already running/);
});

test('discover: wait reports the new device at once, then the end; result = advice + matching template + next step', async () => {
  let r = await callText(client, 'myio_modbus_discover', { action: 'wait', timeout_s: 20 });
  assert.match(r.text, /NEW DEVICE FOUND while the run continues/); assert.match(r.text, /address 5 @ 2400 8E1 - NEW/); assert.match(r.text, /known_new=1/);
  r = await callText(client, 'myio_modbus_discover', { action: 'wait', known_new: 1, timeout_s: 20 });
  assert.match(r.text, /run finished/); assert.match(r.text, /discovery DONE \(search, 70 s\) - new devices: 1, known: 1/);
  r = await callText(client, 'myio_modbus_discover', { action: 'result' });
  assert.match(r.text, /installer's note: "Acme HP-9"/); assert.match(r.text, /flags: OTHER_COMBO/);
  assert.match(r.text, /H7: The new device is on another setting \(2400 8E1\) than the bus \(19200 8N1\)/);
  assert.match(r.text, /address 1 @ 19200 8N1 - known/);
  assert.match(r.text, /probe reads: FC3 @100 x1 = 015e \(u16 350\); FC3 @4096 x2 = 23290000/);
  assert.match(r.text, /looks like: template "acme_hp" - Acme HP-9 hőszivattyú \[community - tested on hardware\] - it also WRITES to the device/);
  assert.match(r.text, /myio_modbus_set action=bus panel=2 baud=6 frame=1/); assert.match(r.text, /myio_modbus_templates action=apply id=acme_hp panel=2 slave=5/);
  // ujrainditas: a vezerlo mar tudja a probalistat -> probe-parancs nem megy ki
  const from = m.log.length;
  r = await callText(client, 'myio_modbus_discover', { action: 'start', note: 'Acme HP-9' });
  assert.ok(!m.log.slice(from).some(c => c.startsWith('mb_dprobe')), 'unchanged probe list is not re-sent: ' + m.log.slice(from).join(' | '));
  r = await callText(client, 'myio_modbus_discover', { action: 'stop' });
  assert.match(r.text, /stop sent/); assert.match(r.text, /discovery STOPPED/); assert.ok(m.log.includes('mb_dstop*2=1'));
  r = await callText(client, 'myio_modbus_discover', { action: 'stop' });
  assert.match(r.text, /nothing to stop/);
});

test('discover: unknown device -> no template, web search hint; nothing new -> H1; busy panel; state level needed', async () => {
  const m2 = await startMock({ version: '4.29.0', mbFound: { addr: 9, baud: 19200, frame: '8N1', pol: 0, id: ['ACME', 'X-100', '1.2'], pr: [{ i: 0, st: 1, hex: f32hex(12.5) }, { i: 2, st: 2, hex: '' }] } });
  const m3 = await startMock({ version: '4.29.0', mbFound: false }), m4 = await startMock({ version: '4.29.0', mbBusy: true }), m5 = await startMock({ version: '4.29.0', mbOldPanel: true });
  const c = await connect({ MYIO_SERVERS: JSON.stringify([{ name: 'A', url: m2.url }, { name: 'B', url: m3.url }, { name: 'C', url: m4.url }, { name: 'D', url: m5.url }]), MYIO_MODBUS_DISCOVERY: '1' });
  try {
    await callText(c, 'myio_modbus_discover', { action: 'start', mode: 'deep', confirm: true, keep_going: true });
    assert.ok(m2.log.includes('mb_disc*2*1*0*0*8=0'), 'deep start with confirm: ' + m2.log.filter(x => x.startsWith('mb_disc')).join(','));
    let r; for (let i = 0; i < 6; i++) { r = await callText(c, 'myio_modbus_discover', { action: 'wait', known_new: 1, timeout_s: 10 }); if (/run finished/.test(r.text)) break; }
    assert.match(r.text, /address 9 @ 19200 8N1 - NEW, answers/); assert.match(r.text, /Device ID: ACME \/ X-100 \/ 1\.2/);
    assert.match(r.text, /FC4 @0 x2 = 41480000 \(f32 12\.5/); assert.match(r.text, /FC3 @64514 x1 = exception/);
    assert.match(r.text, /no template signature matches/); assert.match(r.text, /"ACME X-100 modbus register map"/); assert.match(r.text, /action=raw/);
    await callText(c, 'myio_modbus_discover', { action: 'start', server: 'B' });
    for (let i = 0; i < 6; i++) { r = await callText(c, 'myio_modbus_discover', { action: 'wait', server: 'B', timeout_s: 10 }); if (/run finished/.test(r.text)) break; }
    assert.match(r.text, /new devices: 0, known: 1/); assert.match(r.text, /H1: Only the already connected device\(s\) answer \(address 1\)/);
    r = await callText(c, 'myio_modbus_discover', { action: 'start', server: 'C' });
    assert.equal(r.isError, true); assert.match(r.text, /did not start/);
    r = await callText(c, 'myio_modbus_discover', { action: 'start', server: 'D' });
    assert.equal(r.isError, true); assert.match(r.text, /panel firmware 0\.8\+/);
  } finally { await c.close(); await m2.close(); await m3.close(); await m4.close(); await m5.close(); }
});

test('templates: list (collection + bundled snapshot), search, get', async () => {
  let r = await callText(client, 'myio_modbus_templates', { action: 'list' });
  assert.match(r.text, /collection online/);
  assert.match(r.text, /acme_hp - Acme HP-9 hőszivattyú \(Acme \/ HP-9\); heatpump; community - tested on hardware; 9600 8E1, factory address 17; WRITES to the device \(2 write slots\); has a signature/);
  assert.match(r.text, /sdm630 - Eastron SDM630-Modbus \(3 fázis\)/); assert.match(r.text, /xymd02 - /);
  assert.equal(r.text.split('\n').filter(l => /^\s+sdm630 - /.test(l)).length, 1, 'an id that is on the CDN and in the snapshot is listed once');
  r = await callText(client, 'myio_modbus_templates', { action: 'list', query: 'hoszivattyu acme' });
  assert.match(r.text, /1 of \d+ match/); assert.match(r.text, /acme_hp/);
  r = await callText(client, 'myio_modbus_templates', { action: 'list', query: 'nincsilyen' });
  assert.match(r.text, /not in the collection/);
  r = await callText(client, 'myio_modbus_templates', { action: 'get', id: 'acme_hp' });
  assert.match(r.text, /Template "acme_hp" - Acme HP-9 hőszivattyú \[cdn; community/); assert.match(r.text, /notes \(hu\): A cím a menü 7\.2 pontjában állítható\./);
  assert.match(r.text, /Előremenő \[°C\]: FC3 @100 i16 x10\^-1/); assert.match(r.text, /Üzemóra \[h\]: FC3 @104 u32 CDAB/); assert.match(r.text, /WRITE SLOTS \(2\)/); assert.match(r.text, /----- JSON -----/);
  r = await callText(client, 'myio_modbus_templates', { action: 'get', id: 'xymd02' });       // csak a csomagolt masolatban
  assert.match(r.text, /\[bundled \(snapshot of the collection\); tested by myIO\]/); assert.match(r.text, /identification signature: FC4 @1 \(i16\) -400\.\.850/);
  r = await callText(client, 'myio_modbus_templates', { action: 'get', id: 'nincs' });
  assert.equal(r.isError, true);
  // CDN nelkul ("off"): a csomagolt masolat a lista
  r = await callText(plain, 'myio_modbus').catch(() => null);
  const offline = await connect({ MYIO_BASE_URL: m.url, MYIO_MODBUS_DISCOVERY: '1', MYIO_MODBUS_CDN: 'off' });
  try { r = await callText(offline, 'myio_modbus_templates', { action: 'list' }); assert.match(r.text, /NOT reachable - bundled snapshot/); assert.match(r.text, /sdm630 - /); assert.ok(!/acme_hp/.test(r.text)); } finally { await offline.close(); }
});

test('templates: apply fills free rows, write slots come DISABLED, read-back; errors', async () => {
  const from = m.log.length;
  let r = await callText(client, 'myio_modbus_templates', { action: 'apply', id: 'acme_hp', panel: 2, slave: 17, bus: true });
  const sent = m.log.slice(from);
  assert.ok(sent.includes('mb_cfg*2*0*1*25*1*10=1'), 'bus settings with the flags kept: ' + sent.filter(c => c.startsWith('mb_cfg')).join(','));
  assert.ok(sent.includes('mb_blk*2*1*17*3*100*10*5=1') && sent.includes('mb_blk*2*2*17*4*8192*2*1=3'), 'blocks on free rows (fast block): ' + sent.filter(c => c.startsWith('mb_blk')).join(','));
  assert.ok(sent.includes('mb_fld*2*1*1*0*2*0*-1*255*0=1') && sent.includes('mb_fld*2*3*2*0*5*0*0*255*0=1'), 'fields (no SDM target without to_sdm): ' + sent.filter(c => c.startsWith('mb_fld')).join(','));
  assert.ok(sent.includes('mb_n2_1=Előremenő °C'), 'field names with unit: ' + sent.filter(c => c.startsWith('mb_n')).join(','));
  assert.ok(sent.includes('mb_wr*2*0*17*6*200*1*48*200*550*30=0') && sent.includes('mb_wr*2*1*17*5*3*1*32*0*1*0=0'), 'write slots DISABLED (=0): ' + sent.filter(c => c.startsWith('mb_wr')).join(','));
  assert.ok(sent.includes('mb_dt2_17=acme_hp') && sent.some(c => c.startsWith('mb_dn2_17=Acme')), 'device template id + name');
  assert.match(r.text, /template "acme_hp" .* applied to panel #2, slave 17: blocks 1, 2; fields 1, 2, 3; write slots 0, 1/);
  assert.match(r.text, /read back: 2 block\(s\) for slave 17 are on the panel/); assert.match(r.text, /2 write slot\(s\) were created DISABLED/);
  assert.equal(m.mb.wr[0][11], 0, 'the writer is disabled on the panel');
  r = await callText(client, 'myio_modbus_templates', { action: 'apply', id: 'sdm630', panel: 2, slave: 3, to_sdm: true });
  assert.ok(m.log.some(c => /^mb_fld\*2\*\d+\*\d+\*0\*5\*0\*0\*255\*204=1$/.test(c)), 'to_sdm maps the SDM-marked fields');
  r = await callText(client, 'myio_modbus_templates', { action: 'apply', id: 'sdm630', panel: 2, slave: 4 });      // meg epp belefer (8 blokk / 32 mezo)
  assert.match(r.text, /applied to panel #2, slave 4/);
  r = await callText(client, 'myio_modbus_templates', { action: 'apply', id: 'sdm630', panel: 2, slave: 6 });
  assert.equal(r.isError, true); assert.match(r.text, /not enough free rows on panel #2 for "sdm630": needs 2 blocks \/ 14 fields \/ 0 write slots, free 1 \/ 0 \/ 14/);
  r = await callText(client, 'myio_modbus_templates', { action: 'apply', template: { id: 'Rossz ID', name: '', baud: 1234, frame: 0, blk: [], fld: [] }, panel: 2, slave: 9 });
  assert.equal(r.isError, true); assert.match(r.text, /id must be/); assert.match(r.text, /baud must be/);
  r = await callText(client, 'myio_modbus_templates', { action: 'apply', id: 'acme_hp', panel: 2 });
  assert.equal(r.isError, true); assert.match(r.text, /panel and slave are required/);
  const cfg = await connect({ MYIO_BASE_URL: m.url, MYIO_WRITE: 'state', MYIO_MODBUS_DISCOVERY: '1' });
  try { const x = await callText(cfg, 'myio_modbus_templates', { action: 'apply', id: 'xymd02', panel: 2, slave: 9 }); assert.equal(x.isError, true); assert.match(x.text, /MYIO_WRITE=config/); } finally { await cfg.close(); }
});

test('templates: save from the device rows (units split, signature from live values), own copy wins, apply from own', async () => {
  let r = await callText(client, 'myio_modbus_templates', { action: 'save', id: 'fomero', panel: 2, from_slave: 1, name: 'Főmérő', vendor: 'Eastron', model: 'SDM630', category: 'meter',
    manual: 'https://example.com/sdm630.pdf', notes_hu: 'A cím a mérő menüjében állítható.', tested: true, author: 'AI', factory_address: 1 });
  assert.match(r.text, /own template "fomero" saved \(\/modbus\/fomero\.json, \d+ B\): 1 blocks, 1 fields, 0 write slots/);
  const t = JSON.parse(m.files.q.files.get('/modbus/fomero.json').toString('utf8'));
  assert.equal(t.id, 'fomero'); assert.equal(t.name, 'Főmérő'); assert.equal(t.vendor, 'Eastron'); assert.equal(t.cat, 'meter'); assert.equal(t.verified, 1); assert.equal(t.ver, 1); assert.equal(t.addr, 1);
  assert.equal(t.notes_hu, 'A cím a mérő menüjében állítható.'); assert.equal(t.manual, 'https://example.com/sdm630.pdf'); assert.match(t.date, /^\d{4}-\d\d-\d\d$/);
  assert.deepEqual(t.blk, [{ func: 4, start: 0, count: 2, period: 5 }]);
  assert.equal(t.fld.length, 1); assert.equal(t.fld[0].n, 'L1 feszültség'); assert.equal(t.fld[0].dt, 5);
  assert.ok(m.log.includes('mb_dt2_1=fomero'), 'the device is tagged with the template id');
  r = await callText(client, 'myio_modbus_templates', { action: 'list', query: 'fomero' });
  assert.match(r.text, /fomero - Főmérő \(Eastron \/ SDM630\); meter; own \(on the controller\)/);
  r = await callText(client, 'myio_modbus_templates', { action: 'save', id: 'fomero', panel: 2, from_slave: 1 });      // ujramentes: ver + 1, a meta megmarad
  const t2 = JSON.parse(m.files.q.files.get('/modbus/fomero.json').toString('utf8'));
  assert.equal(t2.ver, 2); assert.equal(t2.name, 'Főmérő'); assert.equal(t2.notes_hu, t.notes_hu); assert.equal(t2.verified, 1);
  r = await callText(client, 'myio_modbus_templates', { action: 'get', id: 'fomero' });
  assert.match(r.text, /Template "fomero" - Főmérő \[own\]/);
  r = await callText(client, 'myio_modbus_templates', { action: 'save', template: { id: 'kezi', name: 'Kézi', baud: 9600, frame: 0, manual: 'javascript:alert(1)', blk: [{ func: 3, start: 0, count: 2 }], fld: [{ b: 0, ofs: 1, dt: 5 }] } });
  assert.equal(r.isError, true); assert.match(r.text, /manual must be an http\(s\) link/); assert.match(r.text, /fld\[0\]: offset \+ length is outside its block/);
  r = await callText(client, 'myio_modbus_templates', { action: 'save', id: 'nincs', panel: 2, from_slave: 99 });
  assert.equal(r.isError, true); assert.match(r.text, /no blocks or write slots for slave address 99/);
});

test('result text: A/B from the panel flag, identification pending while running, a known address on another setting = same device', async () => {
  const { discResultText } = await import('../dist/model_modbus.js');
  const dv = (o) => ({ addr: 1, baud: 9600, frame: '8N1', pol: 0, fl: 0, new: 0, known: 0, ans: 1, garbled: 0, slow: 0, stuck: 0, fp: [0, 0, 1, 1], delay: 8, ok: 3, bad: 0, exc: 0, idm: 0, id: ['', '', ''], sid: '', pr: [], ...o });
  const panel = (st, devs) => ({ a: 1, on: 1, cap: 1, note: '', run: { st, ph: st === 1 ? 3 : 5, pct: 50, el: 40, tot: 70, mode: 0, opts: 0, id: 1, addr: 9, baud: 9600, frame: '8N1', pol: 0 },
    bus: { baud: 19200, frame: '8E1', pol: 1 }, ndev: devs.length, nnew: devs.filter(d => d.new).length, flags: [], hints: [], sniff: null, detail: st === 1 ? 0 : 1, dev: devs, probes: [] });
  const devs = [dv({ baud: 19200, frame: '8E1', pol: 1, known: 1, fl: 2, ans: 0 }), dv({ new: 1, fl: 0x45 }), dv({ addr: 9, baud: 19200, frame: '8E1', new: 1, fl: 0x25 })];
  let t = discResultText(panel(2, devs), []);
  assert.match(t, /address 1 @ 19200 8E1 - known, NO ANSWER/, 'no "(A/B swapped)" for the known device in auto A/B mode');
  assert.match(t, /address 1 @ 9600 8N1 - NEW, answers \(~8 ms\), other bus setting\n/, 'no "A/B reversed" without the panel flag');
  assert.match(t, /address 9 @ 19200 8E1 \(A\/B swapped\) - NEW, answers \(~8 ms\), A\/B reversed/);
  assert.match(t, /this address is already in the table: probably the same device on another bus setting/);
  assert.match(t, /address 1 is already in the table and now answers on 9600 8N1: .*myio_modbus_set action=bus panel=1 baud=0 frame=0.* no template needed/);
  assert.ok(!/action=apply id=\w+ panel=1 slave=1\b/.test(t), 'no template apply for the moved device');
  t = discResultText(panel(1, devs), []);
  assert.match(t, /identification \(Device ID, probe reads, template match\) follows at the end of the run/);
  assert.ok(!/no template signature matches/.test(t) && !/  next:/.test(t), 'while running: no "no match" and no next steps');
});
