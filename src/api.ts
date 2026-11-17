/**
 * myIO REST-kliens (MYIO_MCP_PLAN.md 3. es 5. fej., 0. kor 2026-10-25; 1. kor: verzio-kapu, bemenetek, usensor.json).
 *
 * - A szallitas cserelheto (CLOUD_MCP_PLAN.md 11. fej., 2026-11-15): alapbol HttpTransport (a vezerlo HTTP-API-ja az otthoni
 *   halon, src/http_transport.ts); a felhos szerver ugyanezt az osztalyt a sajat transzportjaval hasznalja.
 * - Parancsok POST /info.json torzsben (a GET /command: ut NEM URL-dekodol, az ekezetes nev elromlana); torzs <= 1024 B.
 * - A parancs valasza nem tartalmazza az uj allapotot: a visszaolvasas a hivo (tools/) dolga.
 *
 * Igazsagforras: SD_Files/js/lang/HU/API_REFERENCE.md (a csomagban: API_REFERENCE.md).
 */
import { FEAT, InfoJson, MinVersion, Snapshot, UsensJson, VarBlock, minText, parseVarBlock, supports } from './model.js';
import { MyIOError } from './transport.js';
import type { HttpResult, RequestOpts, ServerConfig, Transport } from './transport.js';
import { HttpTransport } from './http_transport.js';

export { MyIOError } from './transport.js';
export type { HttpResult, RawResult, RequestOpts, ServerConfig, Transport } from './transport.js';

export const POST_BODY_MAX = 1024;   // a fw POST-torzs plafonja (API-ref 13.)
const INFO_TTL_MS = 60_000;          // info.json gyorsitotar
const NAMES_TTL_MS = 10 * 60_000;    // d_sens_out.json (nevek) gyorsitotar - a doksi: "neveket egyszer, utana sens_out"

export class MyIOClient {
  readonly name: string;
  readonly transport: Transport;
  private infoCache?: { at: number; info: InfoJson };
  private namesCache?: { at: number; snap: Snapshot };
  private setupCache?: { at: number; vb: VarBlock };

  /** ServerConfig = a vezerlo HTTP-n (HttpTransport); { name, transport } = barmely mas szallitas (felhos szerver) */
  constructor(cfg: ServerConfig | { name: string; transport: Transport }) {
    this.name = cfg.name;
    this.transport = 'transport' in cfg ? cfg.transport : new HttpTransport(cfg);
  }

  get origin(): string { return this.transport.origin; }
  get requests(): number { return this.transport.requests; }

  request(method: string, path: string, body?: string | Buffer, contentType?: string, opts: RequestOpts = {}): Promise<HttpResult> {
    return this.transport.request(method, path, body, contentType, opts);
  }

  private check(r: { status: number; headers?: HttpResult['headers'] }, what: string): void {
    const h = r.headers ?? {};
    if (r.status === 401) throw new MyIOError(`${this.name}: unauthorized (401) - ${this.transport.authHint}`, 401);
    if (r.status === 429) throw new MyIOError(`${this.name}: login brake (429) - too many wrong passwords from this IP; wait ${h['retry-after'] ?? '?'} s`, 429);
    if (r.status === 403) throw new MyIOError(`${this.name}: forbidden (403) - this user level cannot access ${what}`, 403);
    if (r.status === 404) throw new MyIOError(`${this.name}: ${what} not found (404) - not supported by this firmware or user level`, 404);
    if (r.status === 503) throw new MyIOError(`${this.name}: controller busy (503) for ${what} - from outside the home network it serves heavy requests at most every few seconds; try again later${h['retry-after'] ? ` (Retry-After ${h['retry-after']} s)` : ''}`, 503);
    if (r.status !== 200) throw new MyIOError(`${this.name}: HTTP ${r.status} for ${what}`, r.status);
  }

  /** GET /<nev>.json -> JSON (a fw jog-szurt JSON-t ad: kulcs hianyozhat) */
  async getJson<T = unknown>(path: string): Promise<T> {
    const r = await this.request('GET', path);
    this.check(r, path);
    try { return JSON.parse(r.text) as T; }
    catch { throw new MyIOError(`${this.name}: ${path} is not valid JSON (${r.text.slice(0, 80).replace(/\s+/g, ' ')}...)`); }
  }

  /** GET szoveges valasz (metrics, csv, naplo) */
  async getText(path: string, opts: RequestOpts = {}): Promise<string> {
    const r = await this.request('GET', path, undefined, undefined, opts);
    this.check(r, path);
    return r.text;
  }

  /** GET nyers bajtok (fajl-letoltes; binaris is) */
  async getBuffer(path: string, opts: RequestOpts = {}): Promise<Buffer> {
    const r = await this.request('GET', path, undefined, undefined, opts);
    this.check(r, path);
    return r.body;
  }

  /** fajlkezelo-vegpont (fm.json, fm_del, fm_mkdir, fm_ren, fm_cp, fm_sync): a parametereket URL-kodolva kuldjuk, a fw FmParam-ja dekodol */
  async fm<T = Record<string, unknown>>(endpoint: string, params: Record<string, string> = {}, opts: RequestOpts = {}): Promise<T> {
    const q = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const path = q ? `${endpoint}?${q}` : endpoint;
    const r = await this.request('GET', path, undefined, undefined, opts);
    this.check(r, endpoint);
    try { return JSON.parse(r.text) as T; }
    catch { throw new MyIOError(`${this.name}: ${endpoint} answered non-JSON (${r.text.slice(0, 80).replace(/\s+/g, ' ')})`); }
  }

  async info(force = false): Promise<InfoJson> {
    if (!force && this.infoCache && Date.now() - this.infoCache.at < INFO_TTL_MS) return this.infoCache.info;
    const info = await this.getJson<InfoJson>('info.json');
    if (!info || typeof info !== 'object' || !('info' in info)) throw new MyIOError(`${this.name}: info.json has no "info" object - not a myIO controller?`);
    this.infoCache = { at: Date.now(), info };
    return info;
  }

  async version(): Promise<string> { return String((await this.info()).info.version ?? ''); }
  async supports(min: MinVersion): Promise<boolean> { return supports(await this.version(), min); }
  /** verzio-kapu: ertheto hiba, ha a funkcio ezen a fw-n nincs */
  async require(min: MinVersion, feature: string): Promise<void> {
    const v = await this.version();
    if (!supports(v, min)) throw new MyIOError(`${this.name}: ${feature} is not available on firmware ${v} (needs ${minText(min)})`);
  }

  /** elo allapot (minimal mezok) - nincs gyorsitotar; withInputs: sens_IO.json, ha a fw tudja */
  async snapshot(withInputs = false): Promise<Snapshot> {
    const ep = withInputs && (await this.supports(FEAT.inputs)) ? 'sens_IO.json' : 'sens_out.json';
    return this.getJson<Snapshot>(ep);
  }

  /** nevek (d_sens_IO.json, ha van bemenet-tamogatas, kulonben d_sens_out.json) - gyorsitotarazva; `force` atnevezes utan */
  async names(force = false): Promise<Snapshot> {
    if (!force && this.namesCache && Date.now() - this.namesCache.at < NAMES_TTL_MS) return this.namesCache.snap;
    const ep = (await this.supports(FEAT.inputs)) ? 'd_sens_IO.json' : 'd_sens_out.json';
    const snap = await this.getJson<Snapshot>(ep);
    this.namesCache = { at: Date.now(), snap };
    return snap;
  }

  invalidateNames(): void { this.namesCache = undefined; }

  /** univerzalis szenzorok [4.x] (editor-jog) */
  async usensors(): Promise<UsensJson> {
    await this.require(FEAT.usens, 'universal sensors (usensor.json)');
    return this.getJson<UsensJson>('usensor.json');
  }

  /**
   * Parancs(ok) kuldese: string ("r_ON=16&PCA*2001=128") vagy {k: v} terkep -> POST /info.json.
   * A valasz az info.json (4.x es 3.12 is ezt adja a POST-ra); az allapotot a hivo olvassa vissza.
   */
  async command(cmd: string | Record<string, string | number>, opts: RequestOpts = {}): Promise<HttpResult> {
    const body = typeof cmd === 'string' ? cmd : Object.entries(cmd).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
    if (!body) throw new MyIOError('empty command');
    if (Buffer.byteLength(body) > POST_BODY_MAX) throw new MyIOError(`command body is ${Buffer.byteLength(body)} B, the controller accepts at most ${POST_BODY_MAX} B per request - split it`);
    const r = await this.request('POST', 'info.json', body, undefined, opts);
    this.check(r, 'command');
    return r;
  }

  /** nyers GET: a fw egyes vegpontjai (req*.js var-blokkok) HTTP-fejlec NELKUL valaszolnak; ha van fejlec, 401/403/404 -> hiba */
  async rawGet(path: string): Promise<string> {
    const r = await this.transport.rawGet(path);
    if (!r.headerless) this.check(r, '/' + path.replace(/^\//, ''));
    return r.text;
  }

  /** a /setup oldal JS var-blokkja: globalisok, jelenetek, szerkezetek, kimenet-/bemenet-konfig, nevek (editor/admin); 20 s gyorsitotar */
  async setupVars(force = false): Promise<VarBlock> {
    if (!force && this.setupCache && Date.now() - this.setupCache.at < 20_000) return this.setupCache.vb;
    const vb = parseVarBlock(await this.getText('setup'));
    if (!vb.has('MYIOname')) throw new MyIOError(`${this.name}: the setup page has no settings block - editor/admin level needed`);
    this.setupCache = { at: Date.now(), vb };
    return vb;
  }
  invalidateSetup(): void { this.setupCache = undefined; }

  /** barmely web-oldal JS var-blokkja (/mqtt, /network, /knx, /expander, /sg, /ledstrip, /cloud ...): a 4. kor integracios
   *  oldalai igy adjak a beallitasokat. `mustHave` = egy kulcs, aminek a fw-ben meg kell lennie (kulonben ertheto hiba). */
  async pageVars(page: string, mustHave?: string): Promise<VarBlock> {
    const vb = parseVarBlock(await this.getText(page));
    if (mustHave && !vb.has(mustHave)) throw new MyIOError(`${this.name}: the /${page} page has no "${mustHave}" setting - not supported by this firmware, or the account is not editor/admin`);
    return vb;
  }

  /** a /users oldal var-blokkja: userName[], slotExist[], admin[]/editor[]/user[] (editor/admin) */
  async usersVars(): Promise<VarBlock> {
    const vb = parseVarBlock(await this.getText('users'));
    if (!vb.has('userName')) throw new MyIOError(`${this.name}: the users page has no user block - editor/admin level needed`);
    return vb;
  }

  /** timer.csv (statikus fajl; hianyzik = nincs idozito) */
  async timerCsv(): Promise<string> {
    try { return await this.getText('timer.csv'); }
    catch (e) { if (e instanceof MyIOError && e.status === 404) return ''; throw e; }
  }

  /** a kivalasztott user jog-terkepe (4.x: reqUserpermissions.js fejlec nelkul) */
  async permissionVars(slot: number): Promise<VarBlock> {
    await this.command(`permissionsUser=${slot}`);
    const vb = parseVarBlock(await this.rawGet('reqUserpermissions.js'));
    if (!vb.has('permissionsUser')) throw new MyIOError(`${this.name}: permission map not available on this firmware (reqUserpermissions.js is empty on Due 3.x)`);
    return vb;
  }

  /** fajl feltoltese (PUT /<ut>, `~q/` QSPI, `~sd/` SD) - editor/admin jog; a fw NEM URL-dekodolja az utat (ASCII-biztos nev).
   *  Valasz: "OK <bajtszam>" (200) vagy "ERR rx=<n>" (500). A fw nem atomikusan ir (elobb torol). */
  async put(path: string, content: string | Buffer, contentType = 'application/octet-stream', opts: RequestOpts = {}): Promise<number> {
    const body = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const r = await this.request('PUT', path, body, contentType, { timeoutMs: opts.timeoutMs ?? Math.max(this.transport.timeoutMs, 10_000 + body.length / 20) });
    if (r.status === 500) throw new MyIOError(`${this.name}: upload of ${path} failed on the controller (${r.text.trim()}) - storage full or path invalid?`, 500);
    this.check(r, `PUT ${path}`);
    const m = /OK\s+(\d+)/.exec(r.text);
    const n = m ? parseInt(m[1], 10) : -1;
    if (n >= 0 && n !== body.length) throw new MyIOError(`${this.name}: upload of ${path} incomplete (${n} of ${body.length} B stored)`);
    return n >= 0 ? n : body.length;
  }
}
