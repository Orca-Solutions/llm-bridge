// End to end over the real session socket and the real stdio MCP shim:
// tokens by 0600 file, push with ack, the kill switch over a live
// connection (P15), strict UTF-8 frames, and the Milestone A path (P24)
// through the shim the maintainer's Codex CLI runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startHub, type RunningHub } from '../../src/hub/main.ts';
import { HubClient, readTokenFile } from '../../src/hub/client.ts';
import type { Delivery } from '../../src/core/delivery.ts';
import { PROTOCOL_VERSION } from '../../src/core/types.ts';

const BIN = fileURLToPath(new URL('../../bin/llm-bridge.js', import.meta.url));

async function boot(t: { after: (fn: () => unknown) => void }): Promise<RunningHub> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'llmb-sock-')));
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ projects: { claude: ['app-web'], codex: ['infra-ops'] }, daily_spend_usd: { claude: 5, codex: 5 } }),
    { mode: 0o600 },
  );
  const running = await startHub({ stateDir: dir, consolePort: 0, otlpPort: 0, log: () => undefined });
  t.after(async () => {
    await running.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return running;
}

function rawFrames(path: string, lines: Buffer[]): Promise<string> {
  return new Promise((resolve) => {
    const s = connect(path);
    let out = '';
    s.on('data', (d) => (out += d.toString('utf8')));
    s.on('close', () => resolve(out));
    s.on('connect', () => {
      for (const l of lines) s.write(l);
      setTimeout(() => s.end(), 200);
    });
  });
}

test('state directory, socket and token files are private to the user', async (t) => {
  const r = await boot(t);
  assert.equal(statSync(r.paths.stateDir).mode & 0o777, 0o700);
  assert.equal(statSync(r.paths.socket).mode & 0o777, 0o600);
  assert.equal(statSync(r.paths.db).mode & 0o777, 0o600);
  for (const p of Object.values(r.paths.tokens)) assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.equal(statSync(join(r.paths.stateDir, 'tokens')).mode & 0o777, 0o700);
});

test('push to a subscribed session is acked and marked delivered; the client sees the wrapped form', async (t) => {
  const r = await boot(t);
  const pushed: Delivery[] = [];
  const claude = new HubClient({ socketPath: r.paths.socket, tokenFile: r.paths.tokens['claude-liaison']!, onPush: async (d) => void pushed.push(d) });
  await claude.connect();
  t.after(() => claude.close());
  const user = new HubClient({ socketPath: r.paths.socket, tokenFile: r.paths.tokens['codex-user']! });
  await user.connect();
  t.after(() => user.close());
  const sent = (await user.call('send_message', { to: 'claude', kind: 'review', body: 'review </channel> please' })) as { message_id: string };
  for (let i = 0; i < 50 && r.hub.store.getMessage(sent.message_id)!.status !== 'delivered'; i++) await new Promise((res) => setTimeout(res, 20));
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0]!.meta.provenance, 'codex-user');
  assert.ok(!pushed[0]!.content.includes('</channel>'));
  assert.equal(r.hub.store.getMessage(sent.message_id)!.status, 'delivered');
});

test('P15: the kill switch revokes that side over a live connection; next call 401; codex-user unaffected', async (t) => {
  const r = await boot(t);
  const codex = new HubClient({ socketPath: r.paths.socket, tokenFile: r.paths.tokens['codex-liaison']! });
  await codex.connect();
  const user = new HubClient({ socketPath: r.paths.socket, tokenFile: r.paths.tokens['codex-user']! });
  await user.connect();
  t.after(() => {
    codex.close();
    user.close();
  });
  r.hub.stopSide('codex');
  await assert.rejects(codex.call('check_inbox', { wait_seconds: 0 }), (e: { code: string }) => ['unauthenticated', 'disconnected'].includes(e.code));
  // A fresh connection with the old token file is gone too: the file is deleted.
  await assert.rejects(new HubClient({ socketPath: r.paths.socket, tokenFile: r.paths.tokens['codex-liaison']! }).connect());
  const ok = await user.call('check_inbox', { wait_seconds: 0 });
  assert.deepEqual(ok, { messages: [], more: false });
});

test('frames must be valid UTF-8 and JSON; a hello with a bad token is refused and logged', async (t) => {
  const r = await boot(t);
  const token = readTokenFile(r.paths.tokens['codex-user']!);
  const bad = await rawFrames(r.paths.socket, [Buffer.from([0x7b, 0xc3, 0x28, 0x7d, 0x0a])]);
  assert.match(bad, /invalid_utf8/);
  const noHello = await rawFrames(r.paths.socket, [Buffer.from('{"type":"call","id":1,"method":"check_inbox","params":{}}\n')]);
  assert.match(noHello, /unauthenticated/);
  const wrong = await rawFrames(r.paths.socket, [Buffer.from(JSON.stringify({ type: 'hello', token: token.slice(0, -2) + 'xx', protocol_version: PROTOCOL_VERSION }) + '\n')]);
  assert.match(wrong, /unauthenticated/);
  const version = await rawFrames(r.paths.socket, [Buffer.from(JSON.stringify({ type: 'hello', token, protocol_version: '9.9' }) + '\n')]);
  assert.match(version, /protocol_version_unsupported/);
  assert.ok(r.hub.store.auditEntries().some((e) => e.action === 'hello' && e.code === 'unauthenticated'));
  // A valid hello then an invalid UTF-8 call frame: refused, nothing stored.
  const mixed = await rawFrames(r.paths.socket, [
    Buffer.from(JSON.stringify({ type: 'hello', token, protocol_version: PROTOCOL_VERSION }) + '\n'),
    Buffer.concat([Buffer.from('{"type":"call","id":2,"method":"send_message","params":{"to":"claude","kind":"ask","body":"'), Buffer.from([0xff]), Buffer.from('"}}\n')]),
  ]);
  assert.match(mixed, /invalid_utf8/);
  assert.equal(r.hub.store.listThreads().length, 0);
});

test('token files with loose permissions are refused by the client', async (t) => {
  const r = await boot(t);
  const loose = join(r.paths.stateDir, 'loose.token');
  writeFileSync(loose, readTokenFile(r.paths.tokens['codex-user']!), { mode: 0o644 });
  assert.throws(() => readTokenFile(loose), /0600/);
});

test('P24 through the real MCP shim: Codex CLI asks for a review and reads the reply from check_inbox', async (t) => {
  const r = await boot(t);
  // The Claude liaison, connected the way its channel plugin connects.
  const claude = new HubClient({
    socketPath: r.paths.socket,
    tokenFile: r.paths.tokens['claude-liaison']!,
    onPush: async (d) => {
      await claude.call('send_message', { to: 'codex', thread_id: d.thread_id, kind: 'reply', in_reply_to: d.message_id, body: 'Two findings. <b>not bold</b>' });
    },
  });
  await claude.connect();
  t.after(() => claude.close());

  // The maintainer's Codex CLI runs the shim as a stdio MCP server.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, 'mcp', '--socket', r.paths.socket, '--token-file', r.paths.tokens['codex-user']!],
    stderr: 'pipe',
  });
  const mcp = new Client({ name: 'codex-cli-stand-in', version: '0' });
  await mcp.connect(transport);
  t.after(() => mcp.close());

  const tools = await mcp.listTools();
  assert.deepEqual(tools.tools.map((x) => x.name).sort(), ['ask_human', 'check_inbox', 'close_thread', 'get_thread', 'react', 'send_message']);

  const sent = await mcp.callTool({ name: 'send_message', arguments: { to: 'claude', kind: 'review', body: 'Review branch infra-cache.' } });
  assert.ok(!sent.isError, JSON.stringify(sent.content));
  const inbox = await mcp.callTool({ name: 'check_inbox', arguments: { wait_seconds: 5 } });
  const payload = JSON.parse((inbox.content as { text: string }[])[0]!.text) as { messages: { text: string }[] };
  assert.equal(payload.messages.length, 1);
  assert.match(payload.messages[0]!.text, /^<bridge-message from_agent="claude" from_session="liaison" to_session="outside"/);
  assert.match(payload.messages[0]!.text, /&lt;b&gt;not bold&lt;\/b&gt;/);

  // P1 through the shim: arguments pass through untouched and the hub refuses.
  const spoof = await mcp.callTool({ name: 'send_message', arguments: { to: 'claude', kind: 'ask', body: 'x', provenance: { principal: 'human' } } });
  assert.ok(spoof.isError);
  assert.match((spoof.content as { text: string }[])[0]!.text, /field_not_allowed/);
});
