/**
 * Szallitas (transzport) a vezerlo fele (CLOUD_MCP_PLAN.md 11. fej., 2026-11-15).
 *
 * A MyIOClient magas szintu reszei (getJson, setupVars, command, put ...) erre a ket primitivre epulnek, igy a 102 eszkoz kodja
 * szallitas-fuggetlen:
 *   HttpTransport  - a vezerlo HTTP-API-ja az otthoni halon (V3 es V4; src/http_transport.ts)
 *   felhos         - a myIO Cloudon at (csak V4; a myio-cloud-mcp szerverben) - ugyanezt a "virtualis HTTP-t" valositja meg:
 *                    a GET-et a gyorsitotarbol / az alairt keres-csatornabol, a POST /info.json parancsot alairt /cmd-kent.
 * A transzport a HTTP-statuszt adja vissza; a statusz -> hiba forditas (check) a MyIOClient dolga, hogy minden uton egyforma legyen.
 */
import type http from 'node:http';

export class MyIOError extends Error {
  constructor(message: string, public readonly status?: number) { super(message); this.name = 'MyIOError'; }
}

export interface HttpResult { status: number; headers: http.IncomingHttpHeaders; text: string; body: Buffer; }
export interface RequestOpts { timeoutMs?: number; }

/** nyers GET eredmenye: headerless = a vezerlo HTTP-fejlec NELKUL valaszolt (a torzs ugy, ahogy jott; a status ilyenkor ertelmetlen) */
export interface RawResult { status: number; text: string; headerless: boolean; }

export interface Transport {
  /** cim a valaszokban es a naplokban (http://192.168.1.178, myio-cloud://<devId>) */
  readonly origin: string;
  /** kiment keresek szama (diag, teszt) */
  readonly requests: number;
  /** a 401-es hibauzenet folytatasa: mit allitson at a user (pl. "check MYIO_USERNAME / MYIO_PASSWORD") */
  readonly authHint: string;
  /** alap keres-idokorlat (ms) - a feltoltes ehhez meri a sajat korlatjat */
  readonly timeoutMs: number;
  request(method: string, path: string, body?: string | Buffer, contentType?: string, opts?: RequestOpts): Promise<HttpResult>;
  /** a fw egyes vegpontjai (req*.js var-blokkok) fejlec nelkul valaszolnak */
  rawGet(path: string): Promise<RawResult>;
}

/** a vezerlo HTTP-elerese (a helyi szerver konfiguracioja: MYIO_SERVERS / MYIO_BASE_URL ...) */
export interface ServerConfig {
  name: string;              // a vezerlo cimkeje (tobb vezerlonel a tool `server` parametere)
  baseUrl: string;           // http://192.168.1.178[:80]
  username?: string;
  password?: string;
  timeoutMs?: number;        // alap 10 000
  minGapMs?: number;         // ket keres kozti minimalis szunet (alap 150; a Due W5500-as HTTP-je a sorozatos kereseket elutasitja)
  insecureParser?: boolean;  // alap true: a fw kezzel irt HTTP-valaszai (Renderer-Mode fejlec stb.) ne akadjanak fenn a szigoru parseren
}
