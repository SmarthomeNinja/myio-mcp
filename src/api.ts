/**
 * myIO REST-kliens (MYIO_MCP_PLAN.md 3. es 5. fej., 0. kor 2026-10-25; 1. kor: verzio-kapu, bemenetek, usensor.json).
 *
 * - node:http / node:https (a regi curl+execSync ut kivezetve: a fejlec-case hiba 2026-07-18 ota javitva a fw-ben,
 *   a node:http a fejlec-neveket ugy kuldi, ahogy adjuk - regi fw-nek is jo -, es insecureHTTPParser-rel a kezzel irt
 *   fw-valaszokat is elfogadja).
 * - EGY keres egyszerre vezerlonkent (a vezerlon 3 listen-socket van), Connection: close.
 * - Parancsok POST /info.json torzsben (a GET /command: ut NEM URL-dekodol, az ekezetes nev elromlana); torzs <= 1024 B.
 * - A parancs valasza nem tartalmazza az uj allapotot: a visszaolvasas a hivo (tools/) dolga.
 *
 * Igazsagforras: SD_Files/js/lang/HU/API_REFERENCE.md (a csomagban: API_REFERENCE.md).
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { FEAT, InfoJson, MinVersion, Snapshot, UsensJson, VarBlock, minText, parseVarBlock, supports } from './model.js';

export interface ServerConfig {
  name: string;              // a vezerlo cimkeje (tobb vezerlonel a tool `server` parametere)
  baseUrl: string;           // http://192.168.1.178[:80]
  username?: string;
  password?: string;
  timeoutMs?: number;        // alap 10 000
  minGapMs?: number;         // ket keres kozti minimalis szunet (alap 150; a Due W5500-as HTTP-je a sorozatos kereseket elutasitja)
  insecureParser?: boolean;  // alap true: a fw kezzel irt HTTP-valaszai (Renderer-Mode fejlec stb.) ne akadjanak fenn a szigoru parseren
}

export class MyIOError extends Error {
  constructor(message: string, public readonly status?: number) { super(message); this.name = 'MyIOError'; }
}

export interface HttpResult { status: number; headers: http.IncomingHttpHeaders; text: string; body: Buffer; }
export interface RequestOpts { timeoutMs?: number; }

export const POST_BODY_MAX = 1024;   // a fw POST-torzs plafonja (API-ref 13.)
const INFO_TTL_MS = 60_000;          // info.json gyorsitotar
const NAMES_TTL_MS = 10 * 60_000;    // d_sens_out.json (nevek) gyorsitotar - a doksi: "neveket egyszer, utana sens_out"

export class MyIOClient {
  readonly name: string;
  readonly url: URL;
  private readonly auth?: string;
  private readonly timeoutMs: number;
  private readonly insecure: boolean;
  private readonly minGapMs: number;
  private lastDone = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private infoCache?: { at: number; info: InfoJson };
  private namesCache?: { at: number; snap: Snapshot };
  private setupCache?: { at: number; vb: VarBlock };
  requests = 0;

  constructor(cfg: ServerConfig) {
    this.name = cfg.name;
    this.url = new URL(cfg.baseUrl.includes('://') ? cfg.baseUrl : 'http://' + cfg.baseUrl);
    if (!this.url.pathname.endsWith('/')) this.url.pathname += '/';
    if (cfg.username) this.auth = 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password ?? ''}`).toString('base64');
    this.timeoutMs = cfg.timeoutMs ?? 10_000;
    this.insecure = cfg.insecureParser ?? true;
    this.minGapMs = cfg.minGapMs ?? 150;
  }

  get origin(): string { return this.url.origin; }

  /** sorba allitott keres: egyszerre egy megy ki a vezerlore; olvaso (GET) keresnel egy ujraproba kapcsolat-elutasitasra/-megszakadasra
   *  (a Due HTTP-je sorozatos keresek utan atmenetileg elutasit) - POST-ot NEM ismetlunk (egy billeno parancs ketszer = visszabillen) */
  request(method: string, path: string, body?: string | Buffer, contentType?: string, opts: RequestOpts = {}): Promise<HttpResult> {
    return this.enqueue(async () => {
      try { return await this.rawRequest(method, path, body, contentType, opts); }
      catch (e) {
        const msg = (e as Error).message;
        if (method === 'GET' && /ECONNREFUSED|ECONNRESET|socket hang up/.test(msg)) { await new Promise(r => setTimeout(r, 1500)); return this.rawRequest(method, path, body, contentType, opts); }
        throw e;
      }
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      const wait = this.lastDone + this.minGapMs - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      try { return await fn(); } finally { this.lastDone = Date.now(); }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private rawRequest(method: string, path: string, body?: string | Buffer, contentType?: string, opts: RequestOpts = {}): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const u = new URL(path.replace(/^\//, ''), this.url);
      const mod = u.protocol === 'https:' ? https : http;
      const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
      const headers: Record<string, string> = { Connection: 'close', Accept: '*/*' };
      if (this.auth) headers.Authorization = this.auth;
      if (body !== undefined) {
        headers['Content-Type'] = contentType ?? 'application/x-www-form-urlencoded';
        headers['Content-Length'] = String(Buffer.byteLength(body));
      }
      this.requests++;
      const req = mod.request({
        protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        method, path: u.pathname + u.search, headers, timeout: timeoutMs, insecureHTTPParser: this.insecure,
      }, res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => { const b = Buffer.concat(chunks); resolve({ status: res.statusCode ?? 0, headers: res.headers, text: b.toString('utf8'), body: b }); });
        res.on('error', e => reject(new MyIOError(`${this.name}: response error: ${e.message}`)));
      });
      req.on('timeout', () => req.destroy(new MyIOError(`${this.name}: timeout after ${timeoutMs} ms (${method} ${u.pathname})`)));
      req.on('error', e => reject(e instanceof MyIOError ? e : new MyIOError(`${this.name}: cannot reach ${this.url.origin} (${e.message}) - is the controller on and the URL right?`)));
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  private check(r: HttpResult, what: string): void {
    if (r.status === 401) throw new MyIOError(`${this.name}: unauthorized (401) - check MYIO_USERNAME / MYIO_PASSWORD`, 401);
    if (r.status === 429) throw new MyIOError(`${this.name}: login brake (429) - too many wrong passwords from this IP; wait ${r.headers['retry-after'] ?? '?'} s`, 429);
    if (r.status === 403) throw new MyIOError(`${this.name}: forbidden (403) - this user level cannot access ${what}`, 403);
    if (r.status === 404) throw new MyIOError(`${this.name}: ${what} not found (404) - not supported by this firmware or user level`, 404);
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
  async command(cmd: string | Record<string, string | number>): Promise<HttpResult> {
    const body = typeof cmd === 'string' ? cmd : Object.entries(cmd).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
    if (!body) throw new MyIOError('empty command');
    if (Buffer.byteLength(body) > POST_BODY_MAX) throw new MyIOError(`command body is ${Buffer.byteLength(body)} B, the controller accepts at most ${POST_BODY_MAX} B per request - split it`);
    const r = await this.request('POST', 'info.json', body);
    this.check(r, 'command');
    return r;
  }

  /**
   * Nyers GET TCP-n: a fw egyes vegpontjai (req*.js var-blokkok) HTTP-fejlec NELKUL valaszolnak, amit az http-parser eldob.
   * Ha van fejlec, levagjuk (401/403 -> hiba); ha nincs, a torzs megy vissza ugy, ahogy jott.
   */
  rawGet(path: string): Promise<string> {
    return this.enqueue(() => new Promise<string>((resolve, reject) => {
      const u = new URL(path.replace(/^\//, ''), this.url);
      const sock = net.connect({ host: u.hostname, port: Number(u.port) || 80 }, () => {
        sock.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\n${this.auth ? `Authorization: ${this.auth}\r\n` : ''}Connection: close\r\n\r\n`);
      });
      const chunks: Buffer[] = [];
      sock.setTimeout(this.timeoutMs, () => sock.destroy(new MyIOError(`${this.name}: timeout after ${this.timeoutMs} ms (raw GET ${u.pathname})`)));
      sock.on('data', (c: Buffer) => chunks.push(c));
      sock.on('error', e => reject(e instanceof MyIOError ? e : new MyIOError(`${this.name}: cannot reach ${this.url.origin} (${e.message})`)));
      sock.on('close', () => {
        this.requests++;
        const all = Buffer.concat(chunks).toString('utf8');
        if (all.startsWith('HTTP/')) {
          const m = /^HTTP\/\d\.\d (\d{3})/.exec(all); const code = m ? parseInt(m[1], 10) : 0;
          const sep = all.indexOf('\r\n\r\n'); const sep2 = all.indexOf('\n\n');
          const body = sep >= 0 ? all.slice(sep + 4) : sep2 >= 0 ? all.slice(sep2 + 2) : '';
          try { this.check({ status: code, headers: {}, text: body, body: Buffer.alloc(0) }, u.pathname); } catch (e) { reject(e); return; }
          resolve(body);
        } else resolve(all);
      });
    }));
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
    const r = await this.request('PUT', path, body, contentType, { timeoutMs: opts.timeoutMs ?? Math.max(this.timeoutMs, 10_000 + body.length / 20) });
    if (r.status === 500) throw new MyIOError(`${this.name}: upload of ${path} failed on the controller (${r.text.trim()}) - storage full or path invalid?`, 500);
    this.check(r, `PUT ${path}`);
    const m = /OK\s+(\d+)/.exec(r.text);
    const n = m ? parseInt(m[1], 10) : -1;
    if (n >= 0 && n !== body.length) throw new MyIOError(`${this.name}: upload of ${path} incomplete (${n} of ${body.length} B stored)`);
    return n >= 0 ? n : body.length;
  }
}
