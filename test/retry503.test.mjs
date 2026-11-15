// retry503.test.mjs - 1.6.2: a fw WAN-feke (tavoli kliens nehez GET-jere 503 + Retry-After) -> a kliens kivar es ujraprobal;
// POST-ot nem ismetel, a 10 s-nal hosszabb Retry-After-t nem varja ki.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MyIOClient } from '../dist/api.js';

let srv, base;
const hits = {};
// path -> hany 503 menjen elore, mielott 200 jon
const plan = { '/a.json': 1, '/b.json': 2, '/c.json': 3, '/long.json': 1 };

before(async () => {
  srv = http.createServer((req, res) => {
    const p = req.url;
    hits[p] = (hits[p] ?? 0) + 1;
    if (hits[p] <= (plan[p] ?? 0)) {
      res.writeHead(503, { 'Retry-After': p === '/long.json' ? '60' : '0', 'Content-Type': 'text/plain' });
      return res.end('busy');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: p }));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv.close());

const client = () => new MyIOClient({ name: 't', baseUrl: base, minGapMs: 0 });

test('GET: one or two 503s are waited out', async () => {
  assert.deepEqual(await client().getJson('a.json'), { ok: '/a.json' });
  assert.equal(hits['/a.json'], 2);
  assert.deepEqual(await client().getJson('b.json'), { ok: '/b.json' });
  assert.equal(hits['/b.json'], 3);
});

test('GET: a third 503 is reported with a clear message', async () => {
  await assert.rejects(client().getJson('c.json'), /busy \(503\)/);
  assert.equal(hits['/c.json'], 3);
});

test('GET: Retry-After over 10 s is not waited out', async () => {
  await assert.rejects(client().getJson('long.json'), /Retry-After 60/);
  assert.equal(hits['/long.json'], 1);
});

test('POST: never repeated', async () => {
  plan['/p.json'] = 1;
  const r = await client().request('POST', 'p.json', 'x=1');
  assert.equal(r.status, 503);
  assert.equal(hits['/p.json'], 1);
});
