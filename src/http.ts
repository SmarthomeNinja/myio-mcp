/**
 * Opcionalis Streamable HTTP-transzport mas LAN-kliensekhez (5. kor 2026-10-26). A stdio marad az alap.
 *   MYIO_HTTP_PORT   port (0 = barmely szabad; a tenyleges cim a stderr-re megy)
 *   MYIO_HTTP_HOST   alap 127.0.0.1; LAN-hoz 0.0.0.0 vagy egy sajat cim - ilyenkor a token KOTELEZO
 *   MYIO_HTTP_TOKEN  bearer token (Authorization: Bearer <token>); loopbacken megadas nelkul veletlen, a stderr-re irva
 * Vegpont: POST/GET/DELETE /mcp. Munkamenetenkent sajat McpServer (az SDK egy szervert egy transzporthoz kot), de a vezerlo-
 * kliensek - es igy a vezerlonkenti keres-sor (egy keres egyszerre, MYIO_MIN_GAP_MS) - kozosek: tobb kliens sem terheli tul a fw-t.
 */
import http from 'node:http';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

export interface HttpOptions { port: number; host?: string; token?: string; path?: string; maxSessions?: number; idleMs?: number; bodyMax?: number; }
export interface HttpHandle { url: string; token: string; generatedToken: boolean; sessions(): number; close(): Promise<void>; }

const isLoopback = (h: string) => h === '127.0.0.1' || h === '::1' || h === 'localhost' || h.startsWith('127.');

export async function startHttp(make: () => McpServer, o: HttpOptions): Promise<HttpHandle> {
  const host = o.host?.trim() || '127.0.0.1';
  const path = o.path ?? '/mcp';
  if (!o.token && !isLoopback(host)) throw new Error(`MYIO_HTTP_HOST=${host} is reachable from the network: set MYIO_HTTP_TOKEN (a long random secret) - refusing to start without it`);
  if (o.token && o.token.length < 16) throw new Error('MYIO_HTTP_TOKEN is too short (at least 16 characters)');
  const token = o.token || randomBytes(24).toString('base64url');
  const want = Buffer.from(`Bearer ${token}`);
  const maxSessions = o.maxSessions ?? 16, idleMs = o.idleMs ?? 30 * 60_000, bodyMax = o.bodyMax ?? 16 * 1024 * 1024;
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer; last: number }>();

  const authOk = (req: http.IncomingMessage) => {
    const got = Buffer.from(String(req.headers.authorization ?? ''));
    return got.length === want.length && timingSafeEqual(got, want);
  };
  const jsonErr = (res: http.ServerResponse, status: number, message: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...extra }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: status === 401 ? -32001 : -32000, message }, id: null }));
  };
  const readBody = (req: http.IncomingMessage) => new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = []; let n = 0;
    req.on('data', (c: Buffer) => { n += c.length; if (n > bodyMax) { reject(Object.assign(new Error('request body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!n) return resolve(undefined); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('body is not valid JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
  const drop = async (sid: string) => { const s = sessions.get(sid); if (!s) return; sessions.delete(sid); await s.transport.close().catch(() => {}); await s.server.close().catch(() => {}); };

  const srv = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== path) return jsonErr(res, 404, `not found - the MCP endpoint is ${path}`);
      if (!authOk(req)) return jsonErr(res, 401, 'missing or wrong bearer token', { 'WWW-Authenticate': 'Bearer realm="myio-mcp"' });
      const sid = req.headers['mcp-session-id'];
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      if (typeof sid === 'string' && sid) {
        const s = sessions.get(sid);
        if (!s) return jsonErr(res, 404, 'unknown or expired session - initialize again');
        s.last = Date.now();
        await s.transport.handleRequest(req, res, body);
        if (req.method === 'DELETE') await drop(sid);
        return;
      }
      if (req.method !== 'POST' || !isInitializeRequest(body)) return jsonErr(res, 400, 'no session: send an initialize request first (without Mcp-Session-Id)');
      if (sessions.size >= maxSessions) {   // a legregebben hasznalt munkamenet zarul
        const oldest = [...sessions.entries()].sort((a, b) => a[1].last - b[1].last)[0];
        if (oldest) await drop(oldest[0]);
      }
      const server = make();
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: id => { sessions.set(id, { transport, server, last: Date.now() }); },
      });
      transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      const st = (e as { status?: number }).status ?? 500;
      if (!res.headersSent) jsonErr(res, st, (e as Error).message); else res.end();
    }
  });
  const sweep = setInterval(() => { const t = Date.now(); for (const [id, s] of sessions) if (t - s.last > idleMs) void drop(id); }, 60_000);
  sweep.unref();
  await new Promise<void>((resolve, reject) => { srv.once('error', reject); srv.listen(o.port, host, () => { srv.off('error', reject); resolve(); }); });
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : o.port;
  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}${path}`, token, generatedToken: !o.token, sessions: () => sessions.size,
    async close() { clearInterval(sweep); for (const id of [...sessions.keys()]) await drop(id); await new Promise<void>(r => srv.close(() => r())); },
  };
}
