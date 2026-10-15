// Console gate tests (build plan task 7): P5 to P9, CSP and cookie flags,
// no batch approvals, and every action attributed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { makeHub } from '../helpers.ts';
import { ConsoleServer } from '../../src/console/server.ts';

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function http(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function setup(t: { after: (fn: () => unknown) => void }) {
  const f = makeHub();
  const consoleServer = new ConsoleServer(f.hub, { port: 0 });
  await consoleServer.listen();
  t.after(async () => {
    await consoleServer.close();
    f.cleanup();
  });
  const port = consoleServer.port;
  const link = new URL(consoleServer.loginLink());
  const login = await http(port, 'GET', link.pathname + link.search);
  const setCookie = String(login.headers['set-cookie']);
  const cookie = setCookie.split(';')[0]!;
  const session = JSON.parse((await http(port, 'GET', '/api/session', { Cookie: cookie })).body) as { csrf: string };
  const origin = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
    http(port, 'POST', path, { Cookie: cookie, Origin: origin, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json', ...extra }, JSON.stringify(body));
  return { f, consoleServer, port, cookie, csrf: session.csrf, origin, setCookie, post };
}

const ALL_ENDPOINTS: [string, string][] = [
  ['GET', '/'],
  ['GET', '/app.js'],
  ['GET', '/api/session'],
  ['GET', '/api/threads'],
  ['GET', '/api/threads/thr_01JA8Z2X0N3Y5H7P8Q9R4S6T2V'],
  ['GET', '/api/audit'],
  ['POST', '/api/messages'],
  ['POST', '/api/approvals/apr_01JA8Z2X0N3Y5H7P8Q9R4S6T2V/decision'],
  ['POST', '/api/routes'],
  ['POST', '/api/config/reload'],
  ['POST', '/api/threads/thr_01JA8Z2X0N3Y5H7P8Q9R4S6T2V/unpark'],
  ['POST', '/api/threads/thr_01JA8Z2X0N3Y5H7P8Q9R4S6T2V/pause'],
  ['POST', '/api/threads/thr_01JA8Z2X0N3Y5H7P8Q9R4S6T2V/stop'],
  ['POST', '/api/sides/codex/stop'],
  ['POST', '/api/stop-all'],
  ['POST', '/api/questions/qst_01JA8Z2X0N3Y5H7P8Q9R4S6T2V/answer'],
];

test('P5: adapter and codex-user tokens on the approve endpoint get 401', async (t) => {
  const s = await setup(t);
  for (const token of [s.f.tokens.claude, s.f.tokens.codex, s.f.tokens.user]) {
    const variants: Record<string, string>[] = [
      { Authorization: `Bearer ${token}` },
      { Cookie: `llmb_console=${token}` },
      { 'X-Bridge-Token': token },
    ];
    for (const headers of variants) {
      const r = await http(s.port, 'POST', '/api/approvals/apr_01JA8Z2X0N3Y5H7P8Q9R4S6T2V/decision', {
        ...headers,
        Origin: s.origin,
        'X-CSRF-Token': s.csrf,
        'Content-Type': 'application/json',
      }, '{"decision":"approve"}');
      assert.equal(r.status, 401);
    }
  }
});

test('P6: no credential, or a non-human one, gets 401 on every console endpoint, reads included', async (t) => {
  const s = await setup(t);
  for (const [method, path] of ALL_ENDPOINTS) {
    const variants: Record<string, string>[] = [{}, { Authorization: `Bearer ${s.f.tokens.claude}` }, { Cookie: 'llmb_console=forged' }];
    for (const headers of variants) {
      const r = await http(s.port, method, path, { ...headers, Origin: s.origin, 'Content-Type': 'application/json' }, method === 'POST' ? '{}' : undefined);
      assert.equal(r.status, 401, `${method} ${path}`);
    }
  }
  assert.ok(s.f.store.auditEntries().some((e) => e.action === 'console.auth' && e.code === 'unauthenticated'));
});

test('P7: a request with Host: evil.example gets 403', async (t) => {
  const s = await setup(t);
  for (const host of ['evil.example', `evil.example:${s.port}`, `localhost:${s.port}`, `127.0.0.1:${s.port + 1}`, `127.0.0.1:${s.port}.evil.example`]) {
    const r = await http(s.port, 'GET', '/api/threads', { Host: host, Cookie: s.cookie });
    assert.equal(r.status, 403, host);
  }
});

test('P8: a POST with a foreign Origin or a missing CSRF token gets 403', async (t) => {
  const s = await setup(t);
  const body = { to: 'claude', body: 'hello' };
  assert.equal((await s.post('/api/messages', body, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await s.post('/api/messages', body, { Origin: 'null' })).status, 403);
  const noOrigin = await http(s.port, 'POST', '/api/messages', { Cookie: s.cookie, 'X-CSRF-Token': s.csrf, 'Content-Type': 'application/json' }, JSON.stringify(body));
  assert.equal(noOrigin.status, 403);
  assert.equal((await s.post('/api/messages', body, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await s.post('/api/messages', body, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal(s.f.store.listThreads().length, 0, 'nothing happened');
  assert.equal((await s.post('/api/messages', body)).status, 200, 'the real thing works');
});

test('P9: <script> and <img onerror> come back as literal text, and the client never builds HTML', async (t) => {
  const s = await setup(t);
  const attack = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  const sent = (await s.f.hub.call(s.f.tokens.codex, 'send_message', { to: 'claude', kind: 'ask', body: attack })) as { thread_id: string };
  const r = await http(s.port, 'GET', `/api/threads/${sent.thread_id}`, { Cookie: s.cookie });
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  const detail = JSON.parse(r.body) as { messages: { body: string }[] };
  assert.equal(detail.messages[0]!.body, attack, 'raw text, no entity codes');
  const js = readFileSync(new URL('../../src/console/static/app.js', import.meta.url), 'utf8');
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'srcdoc', 'DOMParser']) {
    assert.ok(!js.includes(sink), `app.js uses no ${sink}`);
  }
  const html = readFileSync(new URL('../../src/console/static/index.html', import.meta.url), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)/.test(html), 'no inline script');
  assert.ok(!/\son[a-z]+=/.test(html), 'no inline handlers');
  assert.ok(!/<style|style=/.test(html), 'no inline style');
});

test('CSP has no unsafe-inline and no remote origins; cookie is HttpOnly and SameSite=Strict', async (t) => {
  const s = await setup(t);
  const r = await http(s.port, 'GET', '/', { Cookie: s.cookie });
  const csp = String(r.headers['content-security-policy']);
  assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'));
  assert.ok(!/https?:|\*/.test(csp), 'no remote origins');
  assert.match(csp, /default-src 'none'/);
  assert.match(s.setCookie, /HttpOnly/);
  assert.match(s.setCookie, /SameSite=Strict/);
});

test('login links are one-time and expire', async (t) => {
  const s = await setup(t);
  const link = new URL(s.consoleServer.loginLink());
  assert.equal((await http(s.port, 'GET', link.pathname + link.search)).status, 303);
  assert.equal((await http(s.port, 'GET', link.pathname + link.search)).status, 401);
  assert.equal((await http(s.port, 'GET', '/login?code=guess')).status, 401);
});

test('no approve-all, remember-this or thread-wide approval in the UI or API', async (t) => {
  const s = await setup(t);
  for (const path of ['/api/approvals/approve-all', '/api/approvals/decision', '/api/approvals/batch', '/api/threads/thr_01JA8Z2X0N3Y5H7P8Q9R4S6T2V/approve']) {
    assert.equal((await s.post(path, { decision: 'approve' })).status, 404, path);
  }
  const ui = readFileSync(new URL('../../src/console/static/index.html', import.meta.url), 'utf8') + readFileSync(new URL('../../src/console/static/app.js', import.meta.url), 'utf8');
  assert.ok(!/approve[- ]?all|remember this|always allow/i.test(ui));
});

test('every console action records who took it', async (t) => {
  const s = await setup(t);
  const sent = JSON.parse((await s.post('/api/messages', { to: 'claude', body: 'hello' })).body) as { thread_id: string };
  await s.post(`/api/threads/${sent.thread_id}/pause`, {});
  await s.post(`/api/threads/${sent.thread_id}/unpark`, {});
  await s.post(`/api/threads/${sent.thread_id}/stop`, {});
  const actions = s.f.store.auditEntries({ thread_id: sent.thread_id }).filter((e) => e.principal === 'human').map((e) => e.action);
  for (const a of ['human.message', 'thread.pause', 'thread.unpark', 'thread.stop']) assert.ok(actions.includes(a), a);
});

test('routing stays off from the console', async (t) => {
  const s = await setup(t);
  const r = await s.post('/api/routes', { claude: 'app-web', codex: 'infra-ops' });
  assert.equal(r.status, 409);
  assert.equal(JSON.parse(r.body).error.code, 'routing_disabled');
});

test('the console binds to loopback only', async (t) => {
  const s = await setup(t);
  const addr = (s.consoleServer as unknown as { server: { address(): { address: string } } }).server.address();
  assert.equal(addr.address, '127.0.0.1');
});

test('the human has no reactions: no react endpoint, and the console shows agent reactions as agents', async (t) => {
  const s = await setup(t);
  for (const path of ['/api/react', '/api/reactions', '/api/messages/msg_01JA8Z3Q8M4V6F2K9T0R1B7C5D/react', '/api/threads/thr_01JA8Z2X0N3Y5H7P8Q9R4S6T2V/react']) {
    assert.equal((await s.post(path, { message_id: 'msg_01JA8Z3Q8M4V6F2K9T0R1B7C5D', reaction: '👍' })).status, 404, path);
  }
  const ui = readFileSync(new URL('../../src/console/static/app.js', import.meta.url), 'utf8');
  assert.match(ui, /agent\) · /, 'reactions are labelled as an agent\'s');
});
