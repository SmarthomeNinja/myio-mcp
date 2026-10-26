/**
 * Tobb vezerlo egy szerverben (MYIO_MCP_PLAN.md 5.8, 1. kor 2026-10-25).
 *   MYIO_SERVERS='[{"name":"Földszint","url":"http://192.168.1.178","username":"admin","password":"..."},{"name":"Emelet",...}]'
 * vagy a regi harmas: MYIO_BASE_URL + MYIO_USERNAME + MYIO_PASSWORD (+ MYIO_NAME). Minden eszkoz `server` parametere a nev;
 * nelkule az elso vezerlo.
 */
import { MyIOClient, MyIOError, ServerConfig } from './api.js';
import { normalizeName } from './model.js';

export interface Registry {
  clients: MyIOClient[];
  names: string[];
  /** URI-biztos rovid nev vezerlonkent (resource-URI: myio://<slug>/...), a clients sorrendjeben */
  slugs: string[];
  pick(name?: string): MyIOClient;
  bySlug(slug: string): MyIOClient;
}

/** "Földszint" -> "foldszint", "Ground floor" -> "ground-floor" (a `docs` foglalt: myio://docs/...) */
export function slugOf(name: string): string {
  const s = normalizeName(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'controller';
  return s === 'docs' ? 'docs-controller' : s;
}

export function parseServerConfigs(env: NodeJS.ProcessEnv = process.env): ServerConfig[] {
  const list: ServerConfig[] = [];
  const timeoutMs = env.MYIO_TIMEOUT_MS ? parseInt(env.MYIO_TIMEOUT_MS, 10) : undefined;
  const minGapMs = env.MYIO_MIN_GAP_MS !== undefined && env.MYIO_MIN_GAP_MS !== '' ? parseInt(env.MYIO_MIN_GAP_MS, 10) : undefined;
  const insecureParser = env.MYIO_INSECURE_PARSER !== '0';
  if (env.MYIO_SERVERS && env.MYIO_SERVERS.trim()) {
    let arr: unknown;
    try { arr = JSON.parse(env.MYIO_SERVERS); } catch (e) { throw new Error(`MYIO_SERVERS is not valid JSON: ${(e as Error).message}`); }
    if (!Array.isArray(arr)) throw new Error('MYIO_SERVERS must be a JSON array of {name, url, username, password}');
    for (const x of arr as Record<string, unknown>[]) {
      const url = String(x.url ?? x.baseUrl ?? '');
      if (!url) throw new Error('MYIO_SERVERS entry without url');
      list.push({ name: String(x.name ?? hostOf(url)), baseUrl: url, username: x.username !== undefined ? String(x.username) : undefined,
        password: x.password !== undefined ? String(x.password) : undefined, timeoutMs: typeof x.timeoutMs === 'number' ? x.timeoutMs : timeoutMs, minGapMs, insecureParser });
    }
  }
  if (!list.length) {
    const baseUrl = env.MYIO_BASE_URL || 'http://192.168.1.170';
    list.push({ name: env.MYIO_NAME || hostOf(baseUrl), baseUrl, username: env.MYIO_USERNAME || undefined, password: env.MYIO_PASSWORD || undefined, timeoutMs, minGapMs, insecureParser });
  }
  // egyedi nevek
  const seen = new Map<string, number>();
  for (const c of list) { const n = (seen.get(c.name) ?? 0) + 1; seen.set(c.name, n); if (n > 1) c.name = `${c.name}-${n}`; }
  return list;
}

function hostOf(url: string): string { try { return new URL(url.includes('://') ? url : 'http://' + url).host; } catch { return url; } }

export function buildRegistry(cfgs: ServerConfig[]): Registry {
  const clients = cfgs.map(c => new MyIOClient(c));
  const names = clients.map(c => c.name);
  const slugs: string[] = [];
  for (const c of clients) { let s = slugOf(c.name); for (let k = 2; slugs.includes(s); k++) s = `${slugOf(c.name)}-${k}`; slugs.push(s); }
  return {
    clients, names, slugs,
    bySlug(slug: string): MyIOClient {
      const i = slugs.indexOf(decodeURIComponent(slug).toLowerCase());
      if (i >= 0) return clients[i];
      return this.pick(decodeURIComponent(slug));
    },
    pick(name?: string): MyIOClient {
      if (!name || !name.trim()) return clients[0];
      const q = normalizeName(name);
      const exact = clients.find(c => normalizeName(c.name) === q);
      if (exact) return exact;
      const part = clients.filter(c => normalizeName(c.name).includes(q) || q.includes(normalizeName(c.name)));
      if (part.length === 1) return part[0];
      throw new MyIOError(`unknown server "${name}" - configured controllers: ${names.join(', ')}`);
    },
  };
}
