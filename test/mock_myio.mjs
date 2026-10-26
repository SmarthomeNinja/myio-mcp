// mock_myio.mjs - myIO-vezerlo HTTP-mockja a tesztekhez (MYIO_MCP_PLAN.md 5.9): a d_sens_out.json mintabol indul,
// a parancsokat (POST /info.json torzs vagy GET /command:...) a fw szabalyai szerint hajtja vegre:
//   r_ON/r_OFF/r_INV, PCA_ON/OFF/INV, PCA*<id>=<0..255 NYERS>, f_ON/OFF/INV, fet*<id>=<nyers>, g_ON/OFF/INV (tagok, pullUP),
//   min_temp_ON*/max_temp_OFF*/PCA_temp_MIN*/PCA_temp_MAX* (kuszobok), thermoActivator*/PCA_thermoActivator* (kotes),
//   s_hit/s_press/s_release (gombszimulacio: a bemenet sorszama = rele sorszama), usens*<id>=<x10> (4.x), nevek (*_descr),
//   2. kor: globalisok, kimenet-/bemenet-konfig (billenok!), vedelem/csatolo/csoport, slotok, idozitok (t_*), userek + jogok.
// Vegpontok: info.json, sens_out.json, d_sens_out.json, sens_IO.json / d_sens_IO.json, usensor.json (csak 4.x), setup (HTML var-blokk),
//   users (HTML), timer.csv, reqUserpermissions.js (FEJLEC NELKUL, mint a vas; Due: ures).
// MOCK_DENY="5,2003": ezekre az ID-kre a parancs csendben eldobva. MOCK_VERSION: "4.8.10" (alap) vagy "3.12.30" (Due).
// MOCK_USER/MOCK_PASS: Basic auth. Hasznalat: startMock({...}) -> {port, url, close, log, state}
// Onallo futtatas: node test/mock_myio.mjs --serve [port]   (explicit kapcsolo: a `node --test test/` minden .mjs-t tesztkent inditana)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RQ = 64, PCAQ = 128, SQ = 128, PQ = 64, JQ = 64, GQ = 64, GS = 10;

export function loadSample() {
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'd_sens_out.json'), 'utf8'));
  raw.sensors['101'].hum = 453; raw.sensors['201'].P = 138; raw.sensors['204'].U = 2301;
  raw.sensors['207'] = { id: 207, description: 'I1-A', I: 52 };
  const pca = id => Object.values(raw.PCA).find(p => p.id === id);
  Object.assign(pca(2018), { description: 'R ledszalag', pwm: 1, turnON: 255 });
  Object.assign(pca(2019), { description: 'G ledszalag', pwm: 1, turnON: 255 });
  Object.assign(pca(2020), { description: 'B ledszalag', pwm: 1, turnON: 255 });
  pca(2003).pwm = 1;   // dimmer-modu csatorna a szint-tesztekhez (a vason a kapcsolo-modu PCA a MAX-ra kerekit)
  const rel = id => Object.values(raw.relays).find(r => r.id === id);
  Object.assign(rel(6), { sensor: 301, sensorON: 215, sensorOFF: 225 });
  raw.protection = { 0: { element0: 12, element1: 13, element0d: 'R. Konyha Fix FEL', element1d: 'R. Konyha Fix LE' }, 1: { element0: 15, element1: 16, element0d: 'R. Nappali Hátsó FEL', element1d: 'R. Nappali Hátsó LE' } };
  raw.inputs = { 0: { id: 1, state: 0, enabled: 1, nc: 0, description: 'Nappali gomb' }, 1: { id: 2, state: 1, enabled: 1, nc: 0, description: 'Konyha gomb' }, 2: { id: 3, state: 0, enabled: 0, nc: 1, description: '' } };
  raw.usens = {
    0: { en: 0, type: 4, val: 0, age: 0, state: 0, refresh: 0, err: 0, description: '' },
    1: { en: 1, type: 1, val: 215, age: 12, state: 1, refresh: 0, err: 0, description: 'Gyerekszoba hőfok' },
    2: { en: 1, type: 2, val: 455, age: 30, state: 1, refresh: 0, err: 0, description: 'Nappali pára' },
    5: { en: 1, type: 5, val: 1234, age: 900, state: 2, refresh: 600, err: 0, description: 'Napelem' },
    7: { en: 0, type: 0, val: 0, age: 0, state: 0, refresh: 0, err: 0, description: '' },
  };
  // 2. kor: konfig-allapot
  raw.cfg = {
    MYIOname: 'Mock', timeZone: 2, latitude: 47.444126, longitude: 19.029472, hitTimeLimit: 30, pressTimeLimit: 400, protCooldown: 10, tempTimer: 10, humTimer: 101, mixerTimer: 100,
    impulsePerUnit: 0, consumptionUnit: 'kW', eventLogger: 1, sensorLogger: 1, actualSlot: 0, bootUpSlot: 0, dstAuto: 1,
    relay: Array.from({ length: RQ }, () => ({ invert: 1, alarm: 0, justOn: 0, timer: 0, delay: 0 })),
    pca: Array.from({ length: PCAQ }, () => ({ invert: 1, alarm: 0, justOn: 0, timer: 0, delay: 0, min: 0, max: 255, speed: 1, mixer: 0, pwm: 0 })),
    input: Array.from({ length: SQ }, () => ({ enabled: 1, nc: 0, hitBlock: 0, hit: 0, press: 0, release: 0 })),
    inputName: {}, protection: Array.from({ length: PQ }, () => [0, 0]), priority: Array(PQ).fill(0), joiner: Array.from({ length: JQ }, () => [0, 0]), joinerJustOn: Array(JQ).fill(0),
    group: Array.from({ length: GQ }, () => Array(GS).fill(0)), pullUp: Array(GQ).fill(0),
    slotExist: Array(100).fill(0), slotName: {}, timers: [],   // {id, month, day, hour, minute, days, event, param, sunrise, sunset}
    userExist: Array(16).fill(0), userName: {}, userRights: Array(16).fill(0), userPw: {}, perm: {},   // perm[slot] = {rR:[],rW:[],sH:[],sP:[]} (1/0 tombok)
  };
  raw.cfg.relay[0].timer = 120; raw.cfg.input[0] = { enabled: 1, nc: 0, hitBlock: 0, hit: 1, press: 2, release: 2 }; raw.cfg.input[1].hit = 4;
  raw.cfg.inputName = { 1: 'Nappali gomb', 2: 'Konyha gomb' };
  raw.cfg.protection[0] = [12, 13]; raw.cfg.protection[1] = [15, 16];
  raw.cfg.joiner[0] = [502, 2009];
  for (const g of Object.values(raw.group)) { const i = g.id - 501; const m = Object.keys(g).filter(k => /^element\d+$/.test(k)).map(k => g[k]); for (let j = 0; j < GS; j++) raw.cfg.group[i][j] = m[j] ?? 0; raw.cfg.pullUp[i] = g.pullUP ?? 0; }
  raw.cfg.slotExist[0] = 1; raw.cfg.slotExist[1] = 1; raw.cfg.slotName = { 0: 'alap', 1: 'Backup' };
  raw.cfg.timers = [{ id: 0, month: 80, day: 80, hour: 19, minute: 0, days: 0, event: 2, param: 46, sunrise: 0, sunset: 0 }, { id: 1, month: 80, day: 80, hour: 0, minute: 30, days: 0, event: 3, param: 46, sunrise: 0, sunset: 1 }];
  raw.cfg.userExist[0] = 1; raw.cfg.userExist[1] = 1; raw.cfg.userName = { 0: 'admin', 1: 'editor' }; raw.cfg.userRights[1] = 1;
  raw.cfg.perm = { 0: { rR: Array(RQ).fill(1), rW: Array(RQ).fill(1), sH: Array(SQ).fill(1), sP: Array(SQ).fill(1) }, 1: { rR: Array(RQ).fill(1), rW: Array(RQ).fill(0), sH: Array(SQ).fill(0), sP: Array(SQ).fill(0) } };
  return raw;
}

export function startMock(opts = {}) {
  const version = opts.version ?? process.env.MOCK_VERSION ?? '4.8.10';
  const v3 = version.startsWith('3.');
  // [3.12.35 / 4.18.9] automatikus EU nyari ido: dst_auto (ertek-szemantika) + dst_now a /setup var-blokkban
  const verGe = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return true; };
  const dstOk = v3 ? verGe(version, '3.12.35') : verGe(version, '4.18.9');
  const lastSun0100 = (yr, mo) => { const d = new Date(Date.UTC(yr, mo, 31, 1)); d.setUTCDate(31 - d.getUTCDay()); return d.getTime(); };
  const dstNowOf = (on) => { const t = Date.now(), y = new Date(t).getUTCFullYear(); return on && t >= lastSun0100(y, 2) && t < lastSun0100(y, 9) ? 1 : 0; };
  const deny = new Set((opts.deny ?? process.env.MOCK_DENY ?? '').split(',').filter(Boolean).map(Number));
  const user = opts.user ?? process.env.MOCK_USER, pass = opts.pass ?? process.env.MOCK_PASS;
  const state = opts.state ?? loadSample();
  const cfg = state.cfg;
  const log = [];
  let requests = 0, permissionsUser = 0;

  const byId = (sec, id) => Object.values(state[sec] ?? {}).find(x => x.id === id);
  const members = g => Object.keys(g).filter(k => /^element\d+$/.test(k)).map(k => g[k]).filter(Boolean);
  const base = id => (id >= 4001 ? id - 2000 : id >= 201 && id <= 216 ? id - 100 : id);
  const setOut = (id, on) => {
    const b = base(id);
    const r = byId('relays', b); if (r) { if (!deny.has(b)) r.state = on ? 1 : 0; return; }
    const p = byId('PCA', b); if (p) { if (!deny.has(b)) p.state = on ? p.turnON : p.turnOFF; return; }
    const f = byId('PWM', b); if (f) { if (!deny.has(b)) f.state = on ? f.turnON : f.turnOFF; }
  };
  const isOn = id => { const b = base(id); const x = byId('relays', b) ?? byId('PCA', b) ?? byId('PWM', b); return x ? x.state > 0 : false; };
  const pcaOf = v => byId('PCA', v > 2000 ? v : 2000 + v);
  const pidx = v => { let i = v - 1; if (i >= 2000) i -= 2000; return i >= 0 && i < PCAQ ? i : -1; };
  const syncGroup = i => {   // cfg.group -> a JSON csoport-szekcio
    const g = Object.values(state.group).find(x => x.id === 501 + i);
    const row = cfg.group[i];
    if (!g) { if (row.some(Boolean)) state.group[String(i)] = { id: 501 + i, description: '', pullUP: cfg.pullUp[i] }; else return; }
    const gg = Object.values(state.group).find(x => x.id === 501 + i);
    for (const k of Object.keys(gg)) if (/^element\d+d?$/.test(k)) delete gg[k];
    row.forEach((m, j) => { if (m) gg[`element${j}`] = m; });
    gg.pullUP = cfg.pullUp[i];
  };
  const toggle = (arr, i) => { if (i >= 0 && i < arr.length) arr[i] = arr[i] ? 0 : 1; };

  function exec(key, value) {
    log.push(`${key}=${value}`);
    const v = Number(value);
    const parts = key.split('*'); const name = parts[0]; const i = parts[1] !== undefined ? Number(parts[1]) : undefined; const i2 = parts[2] !== undefined ? Number(parts[2]) : undefined;
    if (r3exec(name, i, i2, v)) return;
    if (r4exec(key, name, i, i2, value, v)) return;
    switch (name) {
      case 'r_ON': case 'r_OFF': case 'r_INV': { if (!(v >= 1 && v <= 64)) return; const r = byId('relays', v); if (!r || deny.has(v)) return; r.state = name === 'r_ON' ? 1 : name === 'r_OFF' ? 0 : r.state ? 0 : 1; return; }
      case 'PCA_ON': case 'PCA_OFF': case 'PCA_INV': { const p = pcaOf(v); if (!p || deny.has(p.id)) return; const on = name === 'PCA_ON' ? true : name === 'PCA_OFF' ? false : !(p.state > 0); p.state = on ? p.turnON : p.turnOFF; return; }
      case 'PCA': { const p = pcaOf(i); if (!p || deny.has(p.id)) return; const lv = Math.max(0, Math.min(255, Math.round(v))); p.state = p.pwm ? lv : lv > p.turnOFF ? p.turnON : p.turnOFF; return; }
      case 'f_ON': case 'f_OFF': case 'f_INV': { const id = v > 100 ? v : 100 + v; const f = byId('PWM', id); if (!f || deny.has(id)) return; const on = name === 'f_ON' ? true : name === 'f_OFF' ? false : !(f.state > 0); f.state = on ? f.turnON : f.turnOFF; return; }
      case 'fet': { const id = i > 100 ? i : 100 + i; const f = byId('PWM', id); if (!f || deny.has(id)) return; f.state = Math.max(0, Math.min(255, Math.round(v))); return; }
      case 'g_ON': case 'g_OFF': case 'g_INV': {
        const id = v > 500 ? v : 500 + v; const g = byId('group', id); if (!g) return; const m = members(g);
        let on = name === 'g_ON' ? true : name === 'g_OFF' ? false : undefined;
        if (on === undefined) { const st = m.map(isOn); on = st.every(Boolean) ? false : st.every(x => !x) ? true : !!g.pullUP; }
        for (const id2 of m) setOut(id2, on); return;
      }
      case 'min_temp_ON': { const r = byId('relays', i); if (r && !deny.has(i)) r.sensorON = v; return; }
      case 'max_temp_OFF': { const r = byId('relays', i); if (r && !deny.has(i)) r.sensorOFF = v; return; }
      case 'thermoActivator': { const r = byId('relays', i); if (r && !deny.has(i)) r.sensor = v; return; }
      case 'PCA_temp_MIN': { const p = pcaOf(i); if (p) p.sensorON = v; return; }
      case 'PCA_temp_MAX': { const p = pcaOf(i); if (p) p.sensorOFF = v; return; }
      case 'PCA_thermoActivator': { const p = pcaOf(i); if (p) p.sensor = v; return; }
      case 's_hit': { const r = byId('relays', v); if (r) r.state = r.state ? 0 : 1; return; }
      case 's_press': { const r = byId('relays', v); if (r) r.state = 1; return; }
      case 's_release': return;
      case 'usens': { if (v3) return; const u = state.usens[i]; if (u && u.en) { u.val = v; u.state = 1; u.age = 0; } return; }
      // nevek
      case 'r_descr': { const r = byId('relays', i); if (r) r.description = String(value); return; }
      case 'p_descr': { const p = pcaOf(i); if (p) p.description = String(value); return; }
      case 'g_descr': { const g = byId('group', 500 + i); if (g) g.description = String(value); return; }
      case 's_descr': { cfg.inputName[i] = String(value); const inp = byId('inputs', i); if (inp) inp.description = String(value); return; }
      case 'slo_descr': { cfg.slotName[i] = String(value); return; }
      case 'userName': { cfg.userName[i] = String(value); return; }
      // globalisok
      case 'MYIOname': cfg.MYIOname = String(value); return;
      case 'tz': cfg.timeZone = v; return;
      case 'dst_auto': if (dstOk) cfg.dstAuto = v ? 1 : 0; return;
      case 'latitude': cfg.latitude = Number(value); return;
      case 'longitude': cfg.longitude = Number(value); return;
      case 'hitTimeLimit': cfg.hitTimeLimit = v; return;
      case 'pressTimeLimit': cfg.pressTimeLimit = v; return;
      case 'protCooldown': if (!v3) cfg.protCooldown = v; return;
      case 'tempTimer': cfg.tempTimer = v; return;
      case 'humTimer': cfg.humTimer = v; return;
      case 'mixerTimer': cfg.mixerTimer = v; return;
      case 'impulsePerUnit': cfg.impulsePerUnit = v; return;
      case 'consumptionUnit': cfg.consumptionUnit = String(value); return;
      case 'T_Sync': return;
      // kimenet-konfig
      case 'r_timer': { if (i >= 1 && i <= RQ) { cfg.relay[i - 1].timer = v; const r = byId('relays', i); if (r) r.timer = v; } return; }
      case 'r_delay': { if (i >= 1 && i <= RQ) { cfg.relay[i - 1].delay = v; const r = byId('relays', i); if (r) r.delay = v; } return; }
      case 'relaysInvert': { const r = cfg.relay[v - 1]; if (r) r.invert = r.invert ? 0 : 1; return; }
      case 'relaysAlarm': { const r = cfg.relay[v - 1]; if (r) r.alarm = r.alarm ? 0 : 1; return; }
      case 'relaysJustOn': { const r = cfg.relay[v - 1]; if (r) r.justOn = r.justOn ? 0 : 1; return; }
      case 'PCA_timer': { const k = pidx(i); if (k >= 0) { cfg.pca[k].timer = v; pcaOf(i).timer = v; } return; }
      case 'PCA_delay': { const k = pidx(i); if (k >= 0) cfg.pca[k].delay = v; return; }
      case 'PCAMIN': { const k = pidx(i); if (k >= 0) { cfg.pca[k].min = v; pcaOf(i).turnOFF = v; } return; }
      case 'PCAMAX': { const k = pidx(i); if (k >= 0) { cfg.pca[k].max = v; pcaOf(i).turnON = v; } return; }
      case 'PCAFadeSpeed': { const k = pidx(i); if (k >= 0) { cfg.pca[k].speed = v; pcaOf(i).speed = v; } return; }
      case 'PCAInvert': { const k = pidx(v); if (k >= 0) cfg.pca[k].invert = cfg.pca[k].invert ? 0 : 1; return; }
      case 'PCAAlarm': { const k = pidx(v); if (k >= 0) cfg.pca[k].alarm = cfg.pca[k].alarm ? 0 : 1; return; }
      case 'PCAJustOn': { const k = pidx(v); if (k >= 0) cfg.pca[k].justOn = cfg.pca[k].justOn ? 0 : 1; return; }
      case 'PCA_PWM': { const k = pidx(v); if (k >= 0) { cfg.pca[k].pwm = cfg.pca[k].pwm ? 0 : 1; pcaOf(v).pwm = cfg.pca[k].pwm; } return; }
      case 'PCAMixer': { const k = pidx(v); if (k >= 0) { cfg.pca[k].mixer = cfg.pca[k].mixer ? 0 : 1; pcaOf(v).mixer = cfg.pca[k].mixer; } return; }
      // bemenet-konfig
      case 'switchEnabled': { const c = cfg.input[v - 1]; if (c) { c.enabled = c.enabled ? 0 : 1; const inp = byId('inputs', v); if (inp) inp.enabled = c.enabled; } return; }
      case 'switchNC': { const c = cfg.input[v - 1]; if (c) { c.nc = c.nc ? 0 : 1; const inp = byId('inputs', v); if (inp) inp.nc = c.nc; } return; }
      case 'hitBlockEnabled': { const c = cfg.input[v - 1]; if (c) c.hitBlock = c.hitBlock ? 0 : 1; return; }
      case 'hitEvent': { const c = cfg.input[i - 1]; if (c) c.hit = v; return; }
      case 'pressEvent': { const c = cfg.input[i - 1]; if (c) c.press = v; return; }
      case 'releaseEvent': { const c = cfg.input[i - 1]; if (c) c.release = v; return; }
      // szerkezetek
      case 'relayProtection': { if (i >= 0 && i < PQ && (i2 === 0 || i2 === 1)) { cfg.protection[i][i2] = v; const p = cfg.protection[i]; if (p[0] || p[1]) state.protection[String(i)] = { element0: p[0], element1: p[1] }; else delete state.protection[String(i)]; } return; }
      case 'relayJoiner': { if (i >= 0 && i < JQ && (i2 === 0 || i2 === 1)) { cfg.joiner[i][i2] = v; const p = cfg.joiner[i]; if (p[0] || p[1]) state.joiner[String(i)] = { element0: p[0], element1: p[1] }; else delete state.joiner[String(i)]; } return; }
      case 'relay_group': { if (i >= 0 && i < GQ && i2 >= 0 && i2 < GS) { cfg.group[i][i2] = v; syncGroup(i); } return; }
      case 'pullUpGroup': { toggle(cfg.pullUp, v); syncGroup(v); return; }
      case 'protectionPriority': toggle(cfg.priority, v); return;
      case 'joinerJustON': toggle(cfg.joinerJustOn, v); return;
      // slotok
      case 'new_slot': { const k = cfg.slotExist.indexOf(0); if (k >= 0) cfg.slotExist[k] = 1; return; }
      case 'del_slot': { if (v > 0 && v !== cfg.bootUpSlot) { cfg.slotExist[v] = 0; delete cfg.slotName[v]; } return; }
      case 'sav_all': { if (v >= 0 && v < 100) cfg.slotExist[v] = 1; return; }
      case 'lo_all': { if (cfg.slotExist[v]) cfg.actualSlot = v; return; }
      case 'bootUpSlot': { if (cfg.slotExist[v]) cfg.bootUpSlot = v; return; }
      // idozitok: t_id ... t_eventParam (commit)
      case 't_id': cfg.tset = { id: v }; return;
      case 't_month': cfg.tset.month = v; return;
      case 't_day': cfg.tset.day = v; return;
      case 't_hour': cfg.tset.hour = v; return;
      case 't_minute': cfg.tset.minute = v; return;
      case 't_days': cfg.tset.days = v; return;
      case 't_sunrise': cfg.tset.sunrise = v; return;
      case 't_sunset': cfg.tset.sunset = v; return;
      case 't_event': cfg.tset.event = v; return;
      case 't_eventParam': {
        const t = { month: 80, day: 80, hour: 80, minute: 80, days: 0, event: 0, sunrise: 0, sunset: 0, ...cfg.tset, param: v };
        if (t.sunrise || t.sunset) { let ofs = (t.hour < 80 ? t.hour * 60 : 0) + (t.minute < 80 ? t.minute : 0); if (ofs > 240) ofs = 240; t.hour = Math.floor(ofs / 60); t.minute = ofs % 60; }
        const k = cfg.timers.findIndex(x => x.id === t.id); if (k >= 0) cfg.timers[k] = t; else cfg.timers.push(t); return;
      }
      case 'del_timerSlot': cfg.timers = cfg.timers.filter(t => t.id !== v); return;
      // userek + jogok
      case 'new_userSlot': { const k = cfg.userExist.indexOf(0); if (k >= 0) { cfg.userExist[k] = 1; cfg.userRights[k] = 0; cfg.perm[k] = { rR: Array(RQ).fill(0), rW: Array(RQ).fill(0), sH: Array(SQ).fill(0), sP: Array(SQ).fill(0) }; } return; }
      case 'del_userSlot': { if (v > 0 && v < 16) { cfg.userExist[v] = 0; delete cfg.userName[v]; } return; }
      case 'pwd': cfg.userPw[i] = String(value); return;
      case 'rights': { if (i > 0) cfg.userRights[i] = value === 'admin' ? 0 : value === 'editor' ? 1 : 2; return; }
      case 'permissionsUser': permissionsUser = v; return;
      case 'clearPermission': { permissionsUser = v; const p = cfg.perm[v]; if (p) for (const k of Object.keys(p)) p[k].fill(0); return; }
      case 'fillPermission': { permissionsUser = v; const p = cfg.perm[v]; if (p) for (const k of Object.keys(p)) p[k].fill(1); return; }
      case 'rReadPermission': { const p = cfg.perm[permissionsUser]; if (p) toggle(p.rR, v - 1); return; }
      case 'rWritePermission': { const p = cfg.perm[permissionsUser]; if (p) toggle(p.rW, v - 1); return; }
      case 'swHitPermission': { const p = cfg.perm[permissionsUser]; if (p) toggle(p.sH, v - 1); return; }
      case 'swPressPermission': { const p = cfg.perm[permissionsUser]; if (p) toggle(p.sP, v - 1); return; }
      default: return;
    }
  }
  function execAll(qs) {
    for (const part of qs.split('&')) { if (!part) continue; const eq = part.indexOf('='); if (eq < 0) continue; exec(decodeURIComponent(part.slice(0, eq).replace(/\+/g, ' ')), decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '))); }
  }

  const infoJson = () => {
    const n = v3 ? (x => String(x)) : (x => x);
    return JSON.stringify({ info: { serial: v3 ? 'D312-MOCK-0001' : 'G404-MOCK-0001', version, name: cfg.MYIOname, RQ: n(RQ), SQ: n(SQ), PCAQ: n(PCAQ), ...(v3 ? {} : { SENQ: 100, SHQ: 32 }), CPU: v3 ? 'SAM3X8E' : 'STM32H747', api: 3, right: 0, uptime: n(r4.up), reset_cause: n(r4.up < 100 ? 3 : 0), ...(v3 ? {} : { qhealth: 1, qheal: 0, eepbak: 1 }) } });
  };
  const minimal = o => { const m = { id: o.id, state: o.state }; for (const k of ['timerActive', 'timerRemain', 'delayActive', 'delayRemain', 'sensor', 'sensorON', 'sensorOFF', 'turnOFF', 'turnON', 'pwm', 'mixer', 'timer', 'delay']) if (o[k] !== undefined) m[k] = o[k]; return m; };
  const section = (sec, withNames) => Object.fromEntries(Object.entries(state[sec] ?? {}).map(([k, o]) => [k, withNames ? o : minimal(o)]));
  const groupSection = withNames => Object.fromEntries(Object.entries(state.group ?? {}).map(([k, g]) => {
    const o = { id: g.id, ...(withNames ? { description: g.description } : {}), ...(v3 ? {} : { state: members(g).every(isOn) ? 1 : 0 }), pullUP: g.pullUP };
    for (const key of Object.keys(g)) if (/^element\d+d?$/.test(key) && (withNames || !key.endsWith('d'))) o[key] = g[key];
    return [k, o];
  }));
  const pairSection = (sec, withNames) => Object.fromEntries(Object.entries(state[sec] ?? {}).map(([k, p]) => [k, withNames ? p : { element0: p.element0, element1: p.element1 }]));
  const sensorsSection = withNames => Object.fromEntries(Object.entries(state.sensors ?? {}).map(([k, s]) => { const o = { ...s }; if (!withNames) delete o.description; return [k, o]; }));
  const inputsSection = withNames => Object.fromEntries(Object.entries(state.inputs ?? {}).map(([k, i]) => [k, withNames ? i : { id: i.id, state: i.state }]));
  const snapshot = (withNames, withInputs) => {
    const j = { relays: section('relays', withNames), PCA: section('PCA', withNames), group: groupSection(withNames), joiner: pairSection('joiner', withNames), protection: pairSection('protection', withNames), sensors: sensorsSection(withNames) };
    if (state.PWM && Object.keys(state.PWM).length) j.PWM = section('PWM', withNames);
    if (withInputs) j.inputs = inputsSection(withNames);
    return JSON.stringify(j);
  };
  const usensJson = () => JSON.stringify({ usensor: { senq: 100, dpo: { pca: 0, per: 60, last: 0, opts: {} }, ...state.usens } });

  // /setup var-blokk (a vas formatuma: var NAME=...; NAME [i]='...';) + JS-zaj, amit a parsernek at kell ugrania
  const descLines = (name, size, map) => [`var ${name}=new Array(${size});`, ...Object.entries(map).filter(([, v]) => v).map(([i, v]) => `${name} [${i}]='${v}';`)].join('\n');
  const relayNames = () => Object.fromEntries(Object.values(state.relays).map(r => [r.id, r.description])), pcaNames = () => Object.fromEntries(Object.values(state.PCA).map(p => [p.id - 2000, p.description])),
    groupNames = () => Object.fromEntries(Object.values(state.group).map(g => [g.id - 500, g.description]));
  const setupPage = () => `<!DOCTYPE html><html><head><title>myIO-${cfg.MYIOname} - Setup</title><script>
var x=0;
var y=0;
var message='';
var version="${version}";
var MYIOname='${cfg.MYIOname}';
var mdns='mock';
var eventLogger=${cfg.eventLogger};
var sensorLogger=${cfg.sensorLogger};
var ip=[127,0,0,1];
var year=2026;
var month=10;
var day=25;
var hour=20;
var minute=15;
var sunSetHour=17;
var sunSetMinute=39;
var sunRiseHour=7;
var sunRiseMinute=16;
var latitude=${cfg.latitude};
var longitude=${cfg.longitude};
${v3 ? '' : `var protCooldown=${cfg.protCooldown};\n`}var hitTimeLimit=${cfg.hitTimeLimit};
var pressTimeLimit=${cfg.pressTimeLimit};
var actualSlot=${cfg.actualSlot};
var bootUpSlot=${cfg.bootUpSlot};
var slotQuantity=${cfg.slotExist.filter(Boolean).length};
var tempTimer =${cfg.tempTimer};
var humTimer =${cfg.humTimer};
var mixerTimer =${cfg.mixerTimer};
var impulsePerUnit =${cfg.impulsePerUnit};
var consumptionUnit ="${cfg.consumptionUnit}";
var timeZone =${cfg.timeZone};
${dstOk ? `var dst_auto=${cfg.dstAuto};\nvar dst_now=${dstNowOf(cfg.dstAuto)};\n` : ''}var relaysInvert=[${cfg.relay.map(r => r.invert)}];
var relaysAlarm=[${cfg.relay.map(r => r.alarm)}];
var relaysJustOn=[${cfg.relay.map(r => r.justOn)}];
var relay_timerDefault=[${cfg.relay.map(r => r.timer)}];
var relay_delayDefault=[${cfg.relay.map(r => r.delay)}];
var thermoActivator=[${Object.values(state.relays).map(r => r.sensor ?? 0)}];
var min_temp_ON=[${Object.values(state.relays).map(r => r.sensorON ?? 0)}];
var max_temp_OFF=[${Object.values(state.relays).map(r => r.sensorOFF ?? 0)}];
var PCA_invert=[${cfg.pca.map(p => p.invert)}];
var PCA_Alarm=[${cfg.pca.map(p => p.alarm)}];
var PCA_JustOn=[${cfg.pca.map(p => p.justOn)}];
var PCA_timerDefault=[${cfg.pca.map(p => p.timer)}];
var PCA_delayDefault=[${cfg.pca.map(p => p.delay)}];
var PCA_thermoActivator=[${Object.values(state.PCA).map(p => p.sensor ?? 0)}];
var PCA_min_temp_ON=[${Object.values(state.PCA).map(p => p.sensorON ?? 0)}];
var PCA_max_temp_OFF=[${Object.values(state.PCA).map(p => p.sensorOFF ?? 0)}];
var PCAMIN=[${Object.values(state.PCA).map(p => p.turnOFF ?? 0)}];
var PCAMAX=[${Object.values(state.PCA).map(p => p.turnON ?? 255)}];
var PCAFadeSpeed=[${cfg.pca.map(p => p.speed)}];
var PCA_Mixer=[${Object.values(state.PCA).map(p => p.mixer ?? 0)}];
var PCA_PWM=[${Object.values(state.PCA).map(p => p.pwm ?? 0)}];
var relayProtection=[${cfg.protection.map(p => `[${p[0]},${p[1]}]`)}];
var protectionPriority=[${cfg.priority}];
var relayJoiner=[${cfg.joiner.map(p => `[${p[0]},${p[1]}]`)}];
var joinerJustON=[${cfg.joinerJustOn}];
${descLines('group_description', GQ + 1, groupNames())}
var relay_group=[${cfg.group.map(g => `[${g}]`)}];
var pullUpGroup=[${cfg.pullUp}];
${descLines('relay_description', RQ + 1, relayNames())}
${descLines('PCA_description', PCAQ + 1, pcaNames())}
var lastSwitch=1;
var switchEnabled=[${cfg.input.map(c => c.enabled)}];
var switchNC=[${cfg.input.map(c => c.nc)}];
var hitEvent=[${cfg.input.map(c => c.hit)}];
var pressEvent=[${cfg.input.map(c => c.press)}];
var releaseEvent=[${cfg.input.map(c => c.release)}];
var hitBlockEnabled=[${cfg.input.map(c => c.hitBlock)}];
${descLines('switch_description', SQ + 1, cfg.inputName)}
${descLines('slot_description', 100, cfg.slotName)}
var slotExist=[${cfg.slotExist}];
var h=document.head||document.getElementsByTagName('head')[0];
var host="js/";
langJSON={"languages":{"0":{"code":"EN"}}};
source = "setup_up";
</script></head><body>setup</body></html>`;
  const usersPage = () => `<!DOCTYPE html><html><head><script>
var version="${version}";
var slotQuantity=${cfg.userExist.filter(Boolean).length};
${descLines('userName', 10, cfg.userName)}
var slotExist=[${cfg.userExist}];
var admin=[${cfg.userExist.map((e, i) => (e && cfg.userRights[i] === 0 ? 1 : 0))}];
var editor=[${cfg.userExist.map((e, i) => (e && cfg.userRights[i] === 1 ? 1 : 0))}];
var user=[${cfg.userExist.map((e, i) => (e && cfg.userRights[i] === 2 ? 1 : 0))}];
</script></head><body>users</body></html>`;
  const timerCsv = () => { const t = cfg.timers; if (!t.length) return null; return ['id', 'month', 'day', 'hour', 'minute', 'days', 'event', 'param', 'sunrise', 'sunset'].map(k => t.map(x => x[k]).join(',')).join('\n') + '\n'; };
  const permJs = () => { const p = cfg.perm[permissionsUser]; if (!p) return ''; return `// userpermissions\nvar permissionsUser= ${permissionsUser};\nvar relayReadPermission=[${p.rR}];\nvar relayWritePermission=[${p.rW}];\nvar switchHitPermission=[${p.sH}];\nvar switchPressPermission=[${p.sP}];\n${descLines('userName', 10, cfg.userName)}\n`; };

  // ---- 3. kor: fajlrendszer (q = belso flash, s = SD), Flow, Script, sysdiag, metrics, fm_* (a fw viselkedese szerint) ----
  const today = new Date();
  const ymd = `${String(today.getFullYear()).slice(2)}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  const ts = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`;
  const fs3 = { q: { files: new Map(), dirs: new Set(['/']) }, s: { files: new Map(), dirs: new Set(['/']) } };
  const sdCard = opts.sdCard ?? v3;   // Due: csak SD; 4.x: alapbol nincs kartya
  const vol = v => fs3[v3 ? 's' : v];
  const mkdirp = (V, p) => { const parts = p.split('/').filter(Boolean); let cur = ''; for (const x of parts) { cur += '/' + x; V.dirs.add(cur); } };
  const putFile = (V, p, buf) => { const d = p.slice(0, p.lastIndexOf('/')) || '/'; if (!V.dirs.has(d)) return false; V.files.set(p, Buffer.from(buf)); return true; };
  {
    const V = v3 ? fs3.s : fs3.q;
    mkdirp(V, '/ev_log'); mkdirp(V, '/t_log_1');
    const lines = v3
      ? [`${ts} 08:00:01,System,BOOT`, `${ts} 08:10:00,0,r_ON,5`, `${ts} 09:00:00,System,LOOP-STALL,ph=43`]
      : [`I,${ts} 08:00:01,System,BOOT,cause=0`, `I,${ts} 08:10:00,0,r_ON,5`, `E,${ts} 09:00:00,System,MEMORY FALLING,44552B`, `D,${ts} 09:30:00,System,dbg`, 'System,PCA_ON,2033'];
    V.files.set(`/ev_log/e_${ymd}.csv`, Buffer.from(lines.join('\n') + '\n'));
    V.files.set('/ev_log/e_260101.csv', Buffer.from('old\n'));
    V.files.set(`/t_log_1/t_${ymd}.csv`, Buffer.from('08:00,2150\n'));
    V.files.set('/net.jsn', Buffer.from('{"net":{}}'));
    if (!v3) mkdirp(V, '/prog');
  }
  const r3list = (V, dir, present) => {
    if (!present) return { path: dir, entries: [], ok: 0, err: 'nocard' };
    if (!V.dirs.has(dir)) return { path: dir, entries: [], ok: 0 };
    const pre = dir === '/' ? '/' : dir + '/';
    const kids = new Map();
    for (const d of V.dirs) if (d !== dir && d.startsWith(pre) && !d.slice(pre.length).includes('/')) kids.set(d.slice(pre.length), { n: d.slice(pre.length), s: 0, d: 1 });
    for (const [f, b] of V.files) if (f.startsWith(pre) && !f.slice(pre.length).includes('/')) kids.set(f.slice(pre.length), { n: f.slice(pre.length), s: b.length, d: 0, t: '2026-10-25 12:00' });
    return { path: dir, ...(v3 ? {} : { total: 7168, free: 2632 }), entries: [...kids.values()], ok: 1 };
  };
  // Flow
  let flowsText = opts.flows ? JSON.stringify(opts.flows) : null;
  const flow = { loaded: [], en: new Map(), vars: Array(32).fill(0), trace: [], tseq: 0, err: 0, errflow: -1, fired: 0, hooks: new Map() };
  const ftr = (id, ev, card, val) => { flow.tseq++; flow.trace.unshift([Date.now() % 1e9, id, ev, card, val]); flow.trace = flow.trace.slice(0, 256); };
  const flowReload = () => {
    flow.loaded = []; flow.en.clear(); flow.err = 0; flow.errflow = -1; flow.hooks.clear();
    if (!flowsText) return;
    let j; try { j = JSON.parse(flowsText); } catch { flow.err = 1; return; }
    if (j.formatVersion !== 1) { flow.err = 1; return; }
    for (const f of j.flows ?? []) { const bad = !f.when || !(f.then ?? []).length || (f.then ?? []).some(c => (c.t === 'rel' && ![0, 1, 2].includes(c.act))); if (bad) { flow.err++; flow.errflow = f.id; } flow.loaded.push(f); flow.en.set(f.id, !bad && f.en !== 0); }
    for (const h of j.hooks ?? []) flow.hooks.set(h.id, h);
  };
  flowReload();
  const flowFire = id => {
    const f = flow.loaded.find(x => x.id === id); if (!f) return;
    flow.fired++; ftr(id, 9, 0, 0);
    (f.then ?? []).forEach((c, k) => { if (c.t === 'rel') exec(c.act === 1 ? 'r_ON' : c.act === 0 ? 'r_OFF' : 'r_INV', String(c.id)); if (c.t === 'pca') exec(`PCA*${c.id}`, String(c.val)); ftr(id, 3, k, c.act ?? c.val ?? 0); });
    ftr(id, 5, 0, 0);
  };
  // Script
  const prog = Array.from({ length: 8 }, (_, k) => ({ id: k + 1, st: 0 }));
  let ptseq = 0; const ptrace = [];
  const ptr = (id, ev, a, val) => { ptseq++; ptrace.unshift([Date.now() % 1e9, id, ev, a, val]); };
  const progCompile = n => {
    const b = fs3.q.files.get(`/prog/${n}.txt`); const slot = prog[n - 1];
    if (!b) { prog[n - 1] = { id: n, st: 0 }; return; }
    const src = b.toString('utf8'); const lines = src.split('\n');
    const name = (/^#name\s+(.*)$/m.exec(src)?.[1] ?? '').trim(); const ev = /^#every\s+(\d+)(ms|s)?/m.exec(src); const every = ev ? Number(ev[1]) * (ev[2] === 's' ? 1000 : 1) : 1000;
    const en = !/^#enabled\s+0/m.test(src);
    const bad = lines.findIndex(l => l.includes('+*'));
    const locals = [...src.matchAll(/^var\s+(\w+)/gm)].map(x => x[1]);
    if (bad >= 0) { prog[n - 1] = { id: n, st: 3, en: 0, name, every: 0, runs: 0, last: -1, us: 0, max: 0, ovr: 0, drops: 0, lag: 0, code: 1, el: bad + 1, ec: lines[bad].indexOf('+*') + 2, err: `${bad + 1}:${lines[bad].indexOf('+*') + 2} E04 varatlan token: *`, ln: locals, lv: locals.map(() => 0), an: [], av: [] }; ptr(n, 2, bad + 1, 0); return; }
    prog[n - 1] = { id: n, st: en ? 2 : 1, en: en ? 1 : 0, name, every, boot: 0, runs: slot.runs ?? 0, last: -1, us: 0, max: 0, ovr: 0, drops: 0, lag: 0, code: 20, el: 0, ec: 0, err: '', ln: locals, lv: locals.map(() => 0), an: [], av: [] };
    ptr(n, 1, 0, 20);
  };
  function r3exec(name, i, i2, v) {
    if (v3 && /^(flow|prog)/.test(name)) return true;   // a Due-n nincs ilyen
    switch (name) {
      case 'flow_reload': flowReload(); return true;
      case 'flowen_on': case 'flowen_off': if (flow.en.has(v)) { flow.en.set(v, name === 'flowen_on'); ftr(v, 7, 0, name === 'flowen_on' ? 1 : 0); } return true;
      case 'flow_fire': flowFire(v); return true;
      case 'flow_var': if (i >= 1 && i <= 32) flow.vars[i - 1] = v; return true;
      case 'flow_whtest': { const h = flow.hooks.get(v); ftr(0, h ? 10 : 11, v, h ? 200 : -1); return true; }
      case 'prog_reload': if (v === 0) for (let n = 1; n <= 8; n++) progCompile(n); else if (v >= 1 && v <= 8) progCompile(v); return true;
      case 'prog_run': { const p = prog[v - 1]; if (p && (p.st === 1 || p.st === 2)) { p.runs = (p.runs ?? 0) + 1; p.last = 0; ptr(v, 8, 0, 120); } return true; }
      case 'progen': { const p = prog[i - 1]; if (p && p.st && p.st !== 3) { p.st = v ? 2 : 1; p.en = v ? 1 : 0; ptr(i, 7, 0, v); } return true; }
      default: return false;
    }
  }
  const sysdiag = () => JSON.stringify(v3
    ? { up: 7308, reset: 3, tracelive: 44, loops: 235, loopmax: 111, loopmaxe: 3556, loopmaxph: 43, stepmax: 3472, stepmaxph: 43, ramfree: 61208, rammin: 8196, link: 1, reinits: 0, reinitc: 255, reaped: 0, wanthr: 0, authfail: 0, authlock: 0, authrej: 0, i2c: [0, 0, 0, 0, 0], sock: [[23, 80, '192.168.1.63', 58763, 0], [20, 843, '0.0.0.0', 0, 7303]] }
    : { up: 5583, reset: 2, crashphase: 12, tracelive: 44, grptrace: '00000000', loops: 2469, stepmax: 36455, stepmaxph: 51, ramfree: 128352, rammin: 8196, m4alive: 1, m4btn: 0, m4to: 0, m4crc: 0, m4gap: 0, m4snap: 0, m4snapbad: 0, m4dup: 0, m4bad: 0, link: 2, rssi: -64, wmode: 1, wup: 1, apup: 0, wip: '192.168.1.60', wsock: 1, wsockmax: 4, wsvc: [80], sock: [], outq: [[0, 0, 0], [1, 2, 340], [0, 0, 0]], qspit: 7168, qspif: 2632, sdok: 0, sdt: 0, sdf: 0, viewers: 1, pollhz: 1, wanthr: 0, authfail: 1, authlock: 0, authrej: 0 });
  const metrics = () => 'myio_build_info{version="' + version + '"} 1\nmyio_uptime_seconds 5583\nmyio_ram_free_bytes 128360\nmyio_ram_min_bytes 8196\nmyio_usens{ch="5"} 123.4\n';
  function r3route(req, url, body, send, res) {
    const q = url.indexOf('?'); const p = decodeURIComponent(q >= 0 ? url.slice(0, q) : url); const qs = new URLSearchParams(q >= 0 ? url.slice(q + 1) : '');
    const json = o => send(200, 'application/json', JSON.stringify(o));
    if (req.method === 'PUT') {
      let V, fp;
      if (p.startsWith('/~sd/')) { if (!sdCard) { send(500, 'text/plain', 'ERR rx=0'); return true; } V = fs3.s; fp = p.slice(4); }
      else if (p.startsWith('/~q/')) { if (v3) { send(404, 'text/plain', '404'); return true; } V = fs3.q; fp = p.slice(3); }
      else { V = v3 ? fs3.s : fs3.q; fp = p; }
      const buf = Buffer.from(body, 'latin1');
      if (fp === '/flows.jsn' && !v3) flowsText = buf.toString('utf8');
      if (!putFile(V, fp, buf)) { send(500, 'text/plain', `ERR rx=${buf.length}`); return true; }
      log.push(`PUT ${p} ${buf.length}`);
      send(200, 'text/plain', `OK ${buf.length}\r\n`); return true;
    }
    if (p === '/flows.jsn' && !v3) { if (flowsText === null) send(404, 'text/plain', '404'); else send(200, 'application/json', flowsText); return true; }
    if (p === '/flowtrace.json') { if (v3) return false; const since = Number(qs.get('since') ?? 0); json({ up: 1234, n: flow.loaded.length, max: 64, err: flow.err, errflow: flow.errflow, tickmax: 12, overrun: 0, fired: flow.fired, evdrop: 0, vars: flow.vars, flows: flow.loaded.map(f => [f.id, (flow.en.get(f.id) ? 1 : 0) | 2, 0, 0, 0]), tseq: flow.tseq, trace: since ? flow.trace.slice(0, Math.max(0, flow.tseq - since)) : flow.trace }); return true; }
    if (p === '/prog.json') { if (v3 || version < '4.10') return false; const since = Number(qs.get('since') ?? 0); json({ up: 1234, max: 8, srcmax: 4096, everymin: 100, tickmax: 300, runmax: 120, err: 0, reload: 0, progs: prog, n: prog.filter(x => x.st).length, gvars: flow.vars, tseq: ptseq, trace: since ? ptrace.slice(0, Math.max(0, ptseq - since)) : ptrace }); return true; }
    if (p === '/sysdiag.json') { json(JSON.parse(sysdiag())); return true; }
    if (p === '/metrics') { if (v3) return false; send(200, 'text/plain', metrics()); return true; }
    if (p === '/fm.json') { const V = qs.get('vol') === 's' || v3 ? fs3.s : fs3.q; json(r3list(V, qs.get('dir') || '/', V === fs3.s ? sdCard : true)); return true; }
    if (p === '/fm_mkdir') { const V = qs.get('vol') === 's' || v3 ? fs3.s : fs3.q; const d = qs.get('d'); const par = d.slice(0, d.lastIndexOf('/')) || '/'; const okk = V.dirs.has(par) && !V.dirs.has(d); if (okk) V.dirs.add(d); json({ ok: okk ? 1 : 0 }); return true; }
    if (p === '/fm_del') {
      const V = qs.get('vol') === 's' || v3 ? fs3.s : fs3.q; const f = qs.get('f');
      if (/^\/slot_0$/.test(f)) { json({ ok: 0, err: 'slotprotected' }); return true; }
      if (V.files.delete(f)) { if (f === '/flows.jsn') flowsText = null; log.push(`DEL ${f}`); json({ ok: 1 }); return true; }
      if (V.dirs.has(f) && ![...V.files.keys(), ...V.dirs].some(x => x !== f && x.startsWith(f + '/'))) { V.dirs.delete(f); json({ ok: 1 }); return true; }
      json({ ok: 0 }); return true;
    }
    if (p === '/fm_ren') { const V = qs.get('vol') === 's' || v3 ? fs3.s : fs3.q; const a = qs.get('from'), b = qs.get('to'); if (V.files.has(a) && !V.files.has(b)) { V.files.set(b, V.files.get(a)); V.files.delete(a); json({ ok: 1 }); } else json({ ok: 0 }); return true; }
    if (p === '/fm_cp') {
      const [sv, sp] = [qs.get('src')[0], qs.get('src').slice(2)], [dv, dp] = [qs.get('dst')[0], qs.get('dst').slice(2)];
      const S = fs3[sv], D = fs3[dv]; let files = 0, bytes = 0;
      if (S.files.has(sp)) { D.files.set(dp, S.files.get(sp)); files = 1; bytes = S.files.get(sp).length; }
      else if (S.dirs.has(sp)) { D.dirs.add(dp); for (const d of S.dirs) if (d.startsWith(sp + '/')) D.dirs.add(dp + d.slice(sp.length)); for (const [f, b] of S.files) if (f.startsWith(sp + '/')) { D.files.set(dp + f.slice(sp.length), b); files++; bytes += b.length; } }
      json({ ok: files ? 1 : 0, files, bytes }); return true;
    }
    if (p === '/fm_sync') { if (v3) return false; json({ run: qs.get('op') ? 1 : 0, phase: qs.get('op') ? 1 : 0, web: qs.get('op') === 'sdweb' ? 1 : 0, copied: 0, deleted: 0, bytes: 0, card: sdCard ? 1 : 0, tagged: 0, cur: '' }); return true; }
    // statikus GET: ~q/ ~sd/ kotet-prefix, kulonben QSPI, aztan SD (a fw sorrendje)
    if (req.method === 'GET') {
      let b;
      if (p.startsWith('/~q/')) b = v3 ? undefined : fs3.q.files.get(p.slice(3));
      else if (p.startsWith('/~sd/')) b = sdCard ? fs3.s.files.get(p.slice(4)) : undefined;
      else b = (v3 ? undefined : fs3.q.files.get(p)) ?? (sdCard ? fs3.s.files.get(p) : undefined);
      if (b) { res.writeHead(200, { 'Content-Type': 'application/octet-stream', Connection: 'close' }); res.end(b); return true; }
    }
    return false;
  }

  // ---- 4. kor: integraciok + bovitok (a fw parsereinek szemantikaja: billeno vs ertek) ----
  const r4 = {
    mqtt: { en: 0, host: '', port: 1883, user: '', pw: 'secret', cid: '', base: '', ret: 1, qos: 0, ha: 1, eco: 0, chg: 7, per: 3, pers: 60, tls: 0, tkey: 'KEY', sub: 0, cmd: 0, cslot: 0, state: 0, dirty: 0, mqs_t: Array(8).fill(''), mqs_k: Array(8).fill(''), mqs_i: Array(8).fill(0) },
    sg: { en: 1, k1: 1, k2: 2, lim: 120, mode: 2 },
    al: { en: 0, tcp: 1, udp: 0, ats: 1, port: 7080, acct: '', sup: 0, sim: 0, parts: [0, 1, 2, 3].map(() => ({ st: 0, c: '', z: 0, u: 0, age: -1, sen: 0 })) },
    ai: { en: 1, feat: 47, wd: 50, wm: 5, wh: 30, pm: 120, pd: 3, zones: [{ r: 5, s: 350, t: 2150, on: 0, hr: 164, cr: -84, lag: 7, ov: 16, us: 39, duty: 10, cy: 38, conf: 100, we: 2, win: 0, xa: 0, xt: 0, mo: 0, mf: 0 }] },
    led: { en: 1, pn: Array(32).fill(''), pv: Array.from({ length: 32 }, () => Array(19).fill(0)), len: [30, 0, 0, 0, 0, 0, 0, 0] },
    net: { host: 'server', wm: 1, ssid: 'Home', pw: 'wifipw', dhcp: 1, eth_en: 1, eth_dhcp: 1, apSsid: 'myIO-x', apPw: 'appw12345', ch: 6, applied: 0 },
    shelly: { en: 0, token: 'TOKEN123', dev: { 0: { ip: '192.168.1.133', gen: 2, id: 'shelly1', model: 'S1', dis: 0, slp: 0, poll: 1000, authen: 0, online: 1, push: 0, state: 1, valid: 1, description: 'Lamp', drv: [0, 0, 0, 0], insw: [0, 0, 0, 0], inmode: [0, 0, 0, 0], senm: [0, 0, 0, 0], senc: [0, 0, 0, 0], seni: [0, 0, 0, 0] } } },
    knx: { off: opts.knxOffline ? 1 : 0, ga: Array(48).fill(0), dir: Array(48).fill(0), dpt: Array(48).fill(0), loc: Array(48).fill(0), fl: Array(48).fill(0), tgt: Array(48).fill(0), nm: Array(48).fill(''), sh: null, ipEn: 1, saved: 0 },
    dali: { ep: [{ i: 0, p: 1, e: 0, pca: 2, pv: 0, pwm: 1, fd: 2, fr: 7, po: 0, sf: 255, mn: 5, mx: 254, cv: 0, g: 1, gr: 1, dt: 6, pm: 5, f: 3, r: [2, 7, 0, 255, 5, 254, 0], ls: 255, act: 255 }] },
    mb: { cfg: [1, 0, 25, 1, 10, 1, 0, 0] },
    up: 1234,
  };
  r4.knx.ga[0] = (1 << 11) | (2 << 8) | 3; r4.knx.dir[0] = 2; r4.knx.dpt[0] = 1; r4.knx.loc[0] = 4; r4.knx.nm[0] = 'Nappali lámpa';
  function r4exec(key, name, i, i2, value, v) {
    const M = r4.mqtt;
    if (name.startsWith('mq') || name === 'MqttSave' || name === 'MqttRediscover') {
      if (v3 && /^mq_(eco|tls|tkey|per_us)$|^mqs_/.test(name)) return true;
      const tg = { mq_en: 'en', mq_ret: 'ret', mq_ha: 'ha', mq_eco: 'eco', mq_tls: 'tls', mq_sub: 'sub', mq_cmd: 'cmd' };
      const bits = { mq_chg_btn: ['chg', 1], mq_chg_out: ['chg', 2], mq_chg_act: ['chg', 4], mq_per_out: ['per', 1], mq_per_tmp: ['per', 2], mq_per_hum: ['per', 4], mq_per_us: ['per', 8], mq_per_sdm: ['per', 16] };
      if (tg[name]) M[tg[name]] = M[tg[name]] ? 0 : 1;
      else if (bits[name]) M[bits[name][0]] ^= bits[name][1];
      else if (name === 'mq_host') M.host = value; else if (name === 'mq_port') M.port = v; else if (name === 'mq_user') M.user = value; else if (name === 'mq_pw') M.pw = value;
      else if (name === 'mq_cid') M.cid = value; else if (name === 'mq_base') M.base = value; else if (name === 'mq_qos') M.qos = v === 1 ? 1 : 0; else if (name === 'mq_pers') M.pers = v; else if (name === 'mq_cslot') M.cslot = v;
      else if (/^mqs_[tki]\d+$/.test(name)) { const sl = Number(name.slice(5)); M['mqs_' + name[4]][sl] = name[4] === 'i' ? v : value; }
      else if (name === 'MqttSave') { M.dirty = 0; M.state = M.en && M.host ? 4 : 0; return true; }
      else if (name === 'MqttRediscover') return true;
      M.dirty = 1; return true;
    }
    if (name.startsWith('sg_')) {
      const G = r4.sg;
      if (name === 'sg_en') G.en = G.en ? 0 : 1;
      else if (name === 'sg_k1') { if (v !== G.k2) G.k1 = v; } else if (name === 'sg_k2') { if (v !== G.k1) G.k2 = v; }
      else if (name === 'sg_lim') G.lim = Math.max(1, Math.min(120, v)); else if (name === 'sg_mode') { if (v >= 1 && v <= 4) G.mode = v; }
      return true;
    }
    if (name.startsWith('al_') || name === 'AlarmSave') {
      if (v3) return true;
      const A = r4.al;
      if (name === 'al_en') A.en ^= 1; else if (name === 'al_tcp') A.tcp ^= 1; else if (name === 'al_udp') A.udp ^= 1; else if (name === 'al_ats') A.ats ^= 1;
      else if (name === 'al_port') A.port = v; else if (name === 'al_acct') A.acct = value; else if (name === 'al_sup') A.sup = v;
      else if (/^al_s\d+$/.test(name)) A.parts[Number(name.slice(4)) - 1].sen = v;
      else if (name === 'al_sim') { const m = /ri(\d+)\/([A-Z]{2})(\d+)/.exec(value); if (m) { const p = A.parts[Number(m[1]) - 1]; p.c = m[2]; p.z = Number(m[3]); p.age = 0; p.st = /^B/.test(m[2]) ? 3 : /^C/.test(m[2]) ? 2 : 0; } A.sim++; }
      else if (name === 'al_reset') { A.sim = 0; A.parts.forEach(p => Object.assign(p, { st: 0, c: '', z: 0, age: -1 })); }
      return true;
    }
    if (name.startsWith('ai_')) {
      if (v3) return true;
      const I = r4.ai; const z = r => I.zones.find(x => x.r === r);
      if (name === 'ai_en') I.en ^= 1; else if (name === 'ai_feat') I.feat = v; else if (name === 'ai_wd') I.wd = v; else if (name === 'ai_wm') I.wm = v; else if (name === 'ai_wh') I.wh = v;
      else if (name === 'ai_pm') I.pm = v; else if (name === 'ai_pd') I.pd = v; else if (name === 'ai_xa') { const q = z(v); if (q) q.xa ^= 1; } else if (name === 'ai_xt') { const q = z(v); if (q) q.xt ^= 1; }
      else if (name === 'ai_mo' || name === 'ai_mf') { const [r, m] = value.split(/[^0-9]+/).map(Number); const q = z(i ?? r); if (q) q[name.slice(3)] = i !== undefined ? v : m; }
      return true;
    }
    if (name.startsWith('led_') || name === 'ls_save') {
      if (v3) return true;
      const L = r4.led;
      if (name === 'led_en') L.en ^= 1; else if (name === 'led_pnm') L.pn[i - 1] = value; else if (name === 'led_p') { const [f, val] = value.split(',').map(Number); L.pv[i - 1][f] = val; }
      return true;
    }
    if (name.startsWith('n_') || name === 'NetApply' || name === 'NetSave') {
      if (v3) return true;
      const N = r4.net;
      if (name === 'n_host') N.host = value; else if (name === 'n_wifi_mode') N.wm = v; else if (name === 'n_sta_ssid') N.ssid = value; else if (name === 'n_sta_pw') N.pw = value;
      else if (name === 'n_sta_dhcp') N.dhcp ^= 1; else if (name === 'n_eth_en') N.eth_en ^= 1; else if (name === 'n_eth_dhcp') N.eth_dhcp ^= 1; else if (name === 'NetApply') N.applied++;
      return true;
    }
    if (name.startsWith('sh_')) {
      if (v3) return true;
      const D = r4.shelly.dev;
      if (name === 'sh_en') r4.shelly.en ^= 1; else if (name === 'sh_descr') { const d = D[i - 1]; if (d) d.description = value; } else if (name === 'sh_disabled') { if (D[i]) D[i].dis = v; }
      else if (name === 'sh_drv') { const [ch, id] = value.split(',').map(Number); if (D[i]) D[i].drv[ch] = id; }
      return true;
    }
    if (name.startsWith('knx') || name === 'KnxSave') {
      if (v3) return true;
      const K = r4.knx; const row = n => Number(name.slice(n));
      if (!K.sh && /^knx_(ga|dir|dpt|loc|tgt|inv|ir)\d+$/.test(name)) K.sh = { ga: [...K.ga], dir: [...K.dir], dpt: [...K.dpt], loc: [...K.loc], fl: [...K.fl], tgt: [...K.tgt] };
      if (/^knx_n\d+$/.test(name)) K.nm[row(5)] = value;
      else if (/^knx_ga\d+$/.test(name)) { const m = /^(\d+)\/(\d+)\/(\d+)$/.exec(value); K.sh.ga[row(6)] = m ? (Number(m[1]) << 11) | (Number(m[2]) << 8) | Number(m[3]) : 0; }
      else if (/^knx_(dir|dpt|loc|tgt)\d+$/.test(name)) K.sh[name.slice(4, 7)][row(7)] = v;
      else if (/^knx_inv\d+$/.test(name)) K.sh.fl[row(7)] ^= 1; else if (/^knx_ir\d+$/.test(name)) K.sh.fl[row(6)] ^= 2;
      else if (name === 'KnxSave') { if (!K.off && K.sh) { Object.assign(K, K.sh); K.saved++; } K.sh = null; }
      else if (name === 'knxip_en') K.ipEn ^= 1;
      return true;
    }
    if (name.startsWith('dali_')) {
      if (v3) return true;
      const E = r4.dali.ep;
      if (name === 'dali_gt') { const e = E.find(x => x.i === i); if (e) e.g ^= (1 << i2); }
      else if (/^dali_(fd|fr|po|sf|mn|mx|cv)\d+$/.test(name)) { const e = E.find(x => x.i === Number(name.slice(7))); if (e) e[name.slice(5, 7)] = v; }
      else if (name === 'dali_wr') { const e = E.find(x => x.i === i); if (e) { e.r = [e.fd, e.fr, e.po, e.sf, e.mn, e.mx, e.cv]; e.gr = e.g; } }
      return true;
    }
    if (name.startsWith('mb_')) {
      if (v3) return true;
      if (name === 'mb_cfg') { const parts = key.split('*').slice(2).map(Number); r4.mb.cfg = [...parts, v, 0, 0]; }
      return true;
    }
    if (name === 'Restart') { r4.up = 3; return true; }
    return false;
  }
  const vline = (k, val) => `var ${k}=${typeof val === 'string' ? `'${val.replace(/'/g, "\\'")}'` : JSON.stringify(val).replace(/"/g, "'")};`;
  const page = (vars) => `<!DOCTYPE HTML><html><head><script>\n${Object.entries(vars).map(([k, val]) => vline(k, val)).join('\n')}\n</script></head><body></body></html>`;
  function r4route(url, send) {
    const p = url.split('?')[0];
    const json = o => send(200, 'application/json', JSON.stringify(o));
    const M = r4.mqtt;
    if (p === '/mqtt') { if (v3 && version < '3.12.31') return false; send(200, 'text/html', page({ mq_en: M.en, mq_host: M.host, mq_port: M.port, mq_user: M.user, mq_pw: M.pw, mq_cid: M.cid, mq_base: M.base, mq_ret: M.ret, mq_qos: M.qos, mq_ha: M.ha, ...(v3 ? {} : { mq_eco: M.eco, mq_tls: M.tls, mq_tkey: M.tkey }), mq_chg: M.chg, mq_per: M.per, mq_pers: M.pers, mq_sub: M.sub, mq_cmd: M.cmd, mq_cslot: M.cslot, mq_dirty: M.dirty, mq_host_eff: 'mock', mq_state: M.state, mq_drop: 0, mq_cmdrx: 0, mq_subden: 0, mq_senrx: 0, ...(v3 ? {} : { mq_senq: 8, mqs_t: M.mqs_t, mqs_k: M.mqs_k, mqs_i: M.mqs_i }), mq_bip: '0.0.0.0' })); return true; }
    if (p === '/sg') { const G = r4.sg; send(200, 'text/html', page({ sg_en: G.en, sg_k1: G.k1, sg_k2: G.k2, sg_lim: G.lim, sg_mode: G.mode, sg_rem: 0, sg_prot: 0 })); return true; }
    if (v3) return false;
    const A = r4.al, I = r4.ai, L = r4.led, N = r4.net, K = r4.knx;
    if (p === '/alarm.json') { json({ alarm: { en: A.en, tcp: A.tcp && A.en ? 1 : 0, udp: A.udp && A.en ? 1 : 0, rx: 0, ack: 0, nak: 0, duh: 0, crc: 0, rej: 0, perr: 0, ev: A.sim, sim: A.sim, tr: 0, age: -1, ip: '0.0.0.0', raw: '', p: A.parts } }); return true; }
    if (p === '/alarm') { send(200, 'text/html', page({ al_en: A.en, al_port: A.port, al_tcp: A.tcp, al_udp: A.udp, al_acct: A.acct, al_sup: A.sup, al_ats: A.ats, al_partq: 4 })); return true; }
    if (p === '/ai.json') { json({ en: I.en, feat: I.feat, wd: I.wd, wm: I.wm, wh: I.wh, pm: I.pm, pd: I.pd, nx: -1, zmax: 16, zones: I.zones }); return true; }
    if (p === '/ledstrip') { send(200, 'text/html', page({ led_en: L.en, led_mask: 0, led_progq: 32, led_pins: [32, 33, 30, 31, 28, 29, 26, 27], led_len: L.len, led_type: Array(8).fill(0), led_slot: Array(8).fill(255), led_act: Array(8).fill(0), led_pn: L.pn, led_pv: L.pv })); return true; }
    if (p === '/ledfx.json') { json({ ledfx: { q: 3, fx: [{ k: 'static' }, { k: 'wipe' }, { k: 'rainbow' }] } }); return true; }
    if (p === '/network') { send(200, 'text/html', page({ net_sm: [7, 0, 1, 1, 3, 3, 3], net_host: N.host, net_dirty: 0, nwifi_mode: N.wm, neth_en: N.eth_en, neth_dhcp: N.eth_dhcp, neth_pri: 1, neth_ip: [192, 168, 1, 171], neth_mask: [255, 255, 255, 0], neth_gw: [192, 168, 1, 1], neth_dns: [192, 168, 1, 1], nsta_ssid: N.ssid, nsta_pw: N.pw, nsta_dhcp: N.dhcp, nsta_ip: [0, 0, 0, 0], nap_ssid: N.apSsid, nap_pw: N.apPw, nap_ch: N.ch, net_run_mode: N.wm, net_up: [0, 1, 0], net_addr: ['', '192.168.1.60', ''], net_link: 2, net_rssi: -63, net_mdns: N.host })); return true; }
    if (p === '/shelly.json') { json({ shelly: { en: r4.shelly.en, token: r4.shelly.token, shq: 20, chq: 4, ...r4.shelly.dev } }); return true; }
    if (p === '/shellyscan.json') { json({ scan: { active: 0, next: 0, found: [{ ip: '192.168.1.140', gen: 2, model: 'SPSW', id: 'shellypro' }] } }); return true; }
    if (p === '/link.json') { json({ link: { en: 0, mlq: 8, rq: 10, senq: 20, usenq: 100, nosock: 0, srv: {}, links: {}, slinks: {} } }); return true; }
    if (p === '/cloud') { send(200, 'text/html', page({ cl_en: 0, cl_host: 'mqtt.myio.hu', cl_port: 8883, cl_pw: 'cloudpw', cl_tkey: 'TK', cl_state: 0, cl_devid: 'MOCK', cl_bip: '0.0.0.0', cl_pairwin: 0, cl_lpq: 8, cl_lpu: 1, cl_kused: [1, 0, 0, 0, 0, 0, 0, 0], cl_kslot: [2, 0, 0, 0, 0, 0, 0, 0], cl_krev: [0, 0, 0, 0, 0, 0, 0, 0], cl_kpend: [0, 0, 0, 0, 0, 0, 0, 0], cl_klab: ['Péter telefon', '', '', '', '', '', '', ''], cl_kptok: ['SECRETTOK', '', '', '', '', '', '', ''] })); return true; }
    if (p === '/knx') { send(200, 'text/html', page({ exp_q: 10, knx_addr: 3, knx_dirty: K.sh ? 1 : 0, knxip_en: K.ipEn, knxip_st: K.ipEn ? 1 : 0, knxip_err: 0, knxip_cnt: Array(10).fill(0), knxdev_q: 16, knxdev_busy: 0, knxdev_rc: 0, knxdev_ia: [4353], knxdev_m: [1968], knxdev_age: [-1], knxdev_nm: ['Finder relé'], knx_nm: K.nm, ...(K.off ? { knx_off: 1 } : { knx_ga: K.ga, knx_dir: K.dir, knx_dpt: K.dpt, knx_loc: K.loc, knx_fl: K.fl, knx_tgt: K.tgt }) })); return true; }
    if (p === '/expander') { send(200, 'text/html', page({ exp_q: 10, exp_on: 2, exp_t: [0, 1, 0, 0, 0, 0, 0, 0, 0, 0], exs_t: [16, 17, 0, 0, 0, 0, 0, 0, 0, 0], exs_fj: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], exs_fn: [12, 2, 0, 0, 0, 0, 0, 0, 0, 0], exs_pv: [5, 1, 0, 0, 0, 0, 0, 0, 0, 0], exs_n: [3, 4, 0, 0, 0, 0, 0, 0, 0, 0], exs_ls: [1000, 1500, 0, 0, 0, 0, 0, 0, 0, 0], exs_now: 2000, exf_fs: Array(10).fill(3), exf_to: Array(10).fill(5), exf_ma: Array(10).fill(0), exf_rl: Array(10).fill(0), exf_rt: Array(10).fill(0), exf_as: Array(10).fill(1), exf_ts: Array(10).fill(1), exf_tp: Array(10).fill(1200), exa_m: Array(20).fill(0), ow_rom: ['28AA'], ow_seen: [3], ow_val: [2150], ow_age: [4] })); return true; }
    if (p === '/dali.json') { json({ dali: { epq: 81, n: r4.dali.ep.length, pool: [1, 16], busy: 0, msg: '', panels: [{ a: 1, on: 1 }], ep: r4.dali.ep } }); return true; }
    if (p === '/dmx.json') { json({ dmx: { fxq: 64, n: 0, pool: [1, 160], test: -1, msg: '', panels: [], fx: [] } }); return true; }
    if (p === '/modbus.json') { json({ modbus: { usmin: 9, senq: 100, msg: '', panels: [{ a: 2, on: 1, ld: 1, pend: 0, name: 'SDM', preset: '', cfg: r4.mb.cfg, blk: [[1, 4, 0, 0, 2, 5, 1, 0], ...Array(7).fill([0, 0, 0, 0, 0, 0, 0, 0])], fld: [[0, 0, 5, 0, 0, 255, 12, 1], ...Array(31).fill([255, 0, 0, 0, 0, 0, 0, 0])], wr: Array(16).fill(Array(12).fill(0)), val: [[230.4, 1, 3], ...Array(31).fill([0, 0, 255])], fn: ['L1 feszültség', ...Array(31).fill('')], wn: Array(16).fill(''), raw: null, scan: null }] } }); return true; }
    return false;
  }

  const server = http.createServer((req, res) => {
    requests++;
    const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Renderer-Mode': 'Standards compliance mode', 'Access-Control-Allow-Origin': '*', Connection: 'close' }); res.end(body); };
    if (user) {
      const want = 'Basic ' + Buffer.from(`${user}:${pass ?? ''}`).toString('base64');
      if (req.headers.authorization !== want) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Secure Area"', Connection: 'close' }); res.end(); return; }
    }
    let body = '';
    req.setEncoding('latin1');
    req.on('data', c => body += c);
    req.on('end', () => {
      const url = req.url ?? '/';
      if (req.method === 'POST' && (url === '/info.json' || url === '/')) { execAll(Buffer.from(body, 'latin1').toString('utf8')); send(200, 'application/json', infoJson()); return; }
      if (url.startsWith('/command:')) { execAll(url.slice(9)); send(200, 'text/html', '<!DOCTYPE HTML><html><body>command</body></html>'); return; }
      if (url === '/info.json') { send(200, 'application/json', infoJson()); return; }
      if (url === '/sens_out.json') { send(200, 'application/json', snapshot(false, false)); return; }
      if (url === '/d_sens_out.json') { send(200, 'application/json', snapshot(true, false)); return; }
      if (url === '/sens_IO.json') { send(200, 'application/json', snapshot(false, true)); return; }
      if (url === '/d_sens_IO.json') { send(200, 'application/json', snapshot(true, true)); return; }
      if (url === '/usensor.json') { if (v3) send(404, 'text/plain', '404'); else send(200, 'application/json', usensJson()); return; }
      if (url === '/setup') { send(200, 'text/html', setupPage()); return; }
      if (url === '/users') { send(200, 'text/html', usersPage()); return; }
      if (url === '/timer.csv') { const c = timerCsv(); if (c === null) send(404, 'text/plain', '404'); else send(200, 'text/csv', c); return; }
      if (url === '/reqUserpermissions.js') { res.socket.write(v3 ? '' : permJs()); res.socket.end(); return; }   // FEJLEC NELKUL, mint a vas
      if (url === '/__cmds') { send(200, 'application/json', JSON.stringify(log)); return; }
      if (req.method === 'GET' && r4route(url, send)) return;
      if (r3route(req, url, body, send, res)) return;
      send(404, 'text/plain', '404');
    });
  });
  return new Promise(resolve => {
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ port, url: `http://127.0.0.1:${port}`, state, cfg, log, get requests() { return requests; }, close: () => new Promise(r => server.close(r)) });
    });
  });
}

if (process.argv.includes('--serve')) {
  const m = await startMock({ port: Number(process.argv[process.argv.indexOf('--serve') + 1] ?? 8111) });
  console.log(`mock myIO at ${m.url} (MOCK_VERSION=${process.env.MOCK_VERSION ?? '4.8.10'})`);
}
