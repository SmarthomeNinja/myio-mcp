/**
 * A vezerlo HTTP-API-ja az otthoni halon (V3 es V4) - a MyIOClient alapertelmezett transzportja.
 * (A 0. kor 2026-10-25 kodja, 2026-11-15-en valtozatlanul atkoltoztetve a MyIOClient-bol: CLOUD_MCP_PLAN.md 11. fej.)
 *
 * - node:http / node:https (a regi curl+execSync ut kivezetve: a fejlec-case hiba 2026-07-18 ota javitva a fw-ben,
 *   a node:http a fejlec-neveket ugy kuldi, ahogy adjuk - regi fw-nek is jo -, es insecureHTTPParser-rel a kezzel irt
 *   fw-valaszokat is elfogadja).
 * - EGY keres egyszerre vezerlonkent (a vezerlon 3 listen-socket van), Connection: close.
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { HttpResult, MyIOError, RawResult, RequestOpts, ServerConfig, Transport } from './transport.js';

export class HttpTransport implements Transport {
  readonly url: URL;
  readonly authHint = 'check MYIO_USERNAME / MYIO_PASSWORD';
  private readonly name: string;
  private readonly auth?: string;
  readonly timeoutMs: number;
  private readonly insecure: boolean;
  private readonly minGapMs: number;
  private lastDone = 0;
  private chain: Promise<unknown> = Promise.resolve();
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
      const once = async () => {
        try { return await this.rawRequest(method, path, body, contentType, opts); }
        catch (e) {
          const msg = (e as Error).message;
          if (method === 'GET' && /ECONNREFUSED|ECONNRESET|socket hang up/.test(msg)) { await new Promise(r => setTimeout(r, 1500)); return this.rawRequest(method, path, body, contentType, opts); }
          throw e;
        }
      };
      let r = await once();
      // WAN-fek (fw 4.8.10+ / Due 3.12.27+): mas alhalozatbol (port-forward, DDNS) jovo kliens nehez GET-jere 503 + Retry-After;
      // kivarjuk es ujraprobaljuk, legfeljebb ketszer, legfeljebb 10 s-ot (a sorban: kozben mas keres sem megy ki erre a vezerlore)
      for (let i = 0; i < 2 && method === 'GET' && r.status === 503; i++) {
        const ra = Number(r.headers['retry-after']);
        const s = Number.isFinite(ra) && ra >= 0 ? ra : 3;
        if (s > 10) break;
        await new Promise(res => setTimeout(res, s * 1000 + 100));
        r = await once();
      }
      return r;
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

  /**
   * Nyers GET TCP-n: a fw egyes vegpontjai (req*.js var-blokkok) HTTP-fejlec NELKUL valaszolnak, amit az http-parser eldob.
   * Ha van fejlec, levagjuk es a statuszt visszaadjuk; ha nincs, headerless es a torzs ugy, ahogy jott.
   */
  rawGet(path: string): Promise<RawResult> {
    return this.enqueue(() => new Promise<RawResult>((resolve, reject) => {
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
          resolve({ status: code, text: body, headerless: false });
        } else resolve({ status: 0, text: all, headerless: true });
      });
    }));
  }
}
