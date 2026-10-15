// Kill switch gate test (build plan task 9): an agent leaves a `nohup sleep`
// running, plus a double-forked one that is reparented before any snapshot;
// Stop kills them all within seconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Supervisor, cwdsUnder } from '../../src/supervisor/proc.ts';
import { ConfigError, loadConfig, validateConfig } from '../../src/core/config.ts';
import { SESSION_MARKER_VAR } from '../../src/workspace/env.ts';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findSleeps(tag: string): number[] {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter((l) => /^\s*\d+\s+sleep\s/.test(l) && l.trim().endsWith(`sleep ${tag}`))
    .map((l) => Number(l.trim().split(/\s+/)[0]));
}


test('gate: Stop kills the session and everything it left behind, within seconds', async () => {
  const marker = `test-${process.pid}-${Date.now()}`;
  // The "liaison": starts a nohup'd sleep, a double-forked sleep (reparented
  // to init at once), a sleep in its own process group, then waits.
  const script = [
    'nohup sleep 3001 >/dev/null 2>&1 &',
    '( sleep 3002 & ) ',
    'perl -e "setpgrp(0,0); exec q(sleep), q(3003)" &',
    'sleep 3004',
  ].join('\n');
  const child = spawn('bash', ['-c', script], { env: { ...process.env, [SESSION_MARKER_VAR]: marker }, stdio: 'ignore', detached: true });
  const sup = new Supervisor();
  sup.track({ name: 'claude-liaison', side: 'claude', rootPid: child.pid!, marker });
  await new Promise((r) => setTimeout(r, 1500));
  const before = ['3001', '3002', '3003', '3004'].flatMap(findSleeps);
  assert.equal(before.length, 4, `all four sleeps running: ${before}`);

  const started = Date.now();
  await sup.killSide('claude');
  await new Promise((r) => setTimeout(r, 300));
  const after = ['3001', '3002', '3003', '3004'].flatMap(findSleeps).filter(alive);
  assert.deepEqual(after, [], 'nothing left behind');
  assert.ok(Date.now() - started < 5000, 'within seconds');
  assert.ok(!alive(child.pid!));
});

test('the supervisor never signals the hub itself', async () => {
  const sup = new Supervisor();
  sup.track({ name: 'codex-liaison', side: 'codex', rootPid: process.pid, marker: 'never-matches' });
  const killed = await sup.killSide('codex');
  assert.ok(!killed.includes(process.pid));
  assert.ok(alive(process.pid));
});

test('gate: Stop kills an orphan that macOS hides from the marker scan, found by its working folder, and spares your own terminal there', async (t) => {
  // On macOS the liaison's Bash shell exits right after `nohup sleep &`, so
  // the sleep is reparented to launchd in a process group whose leader is
  // gone, and ps can't show /bin/sleep's environment. Only its working
  // folder, inside the side's clones, still ties it to the liaison.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'llmb-cwd-')));
  const clones = join(root, 'clones');
  const clone = join(clones, 'claude', 'app-web-1');
  const elsewhere = join(root, 'elsewhere');
  mkdirSync(clone, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  const env = { ...process.env };
  delete env[SESSION_MARKER_VAR];
  const orphan = (cwd: string, tag: string) =>
    spawn('perl', ['-e', `setpgrp(0,0); exit 0 if fork; exec q(sleep), q(${tag})`], { cwd, env, stdio: 'ignore', detached: true });
  orphan(clone, '3011'); // the liaison's escaped sleep: no marker, no terminal, in its clone
  orphan(elsewhere, '3012'); // someone else's orphan outside the clones: not ours to kill
  // Your own terminal in the clone: a shell with a controlling tty.
  const pty = 'import pty, os, sys, time\npid, fd = pty.fork()\nif pid == 0:\n    os.chdir(sys.argv[1]); os.execvp("sleep", ["sleep", "3013"])\nelse:\n    time.sleep(600)\n';
  const term = spawn('python3', ['-c', pty, clone], { cwd: elsewhere, env, stdio: 'ignore', detached: true });
  t.after(() => {
    for (const pid of ['3011', '3012', '3013', '3014'].flatMap(findSleeps)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    try {
      process.kill(term.pid!, 'SIGKILL');
    } catch {
      /* gone */
    }
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(['3011', '3012', '3013'].flatMap(findSleeps).length, 3, 'all three running before the liaison is tracked');

  const marker = `test-${process.pid}-${Date.now()}`;
  const liaison = spawn('bash', ['-c', 'sleep 3014'], { cwd: clone, env: { ...process.env, [SESSION_MARKER_VAR]: marker }, stdio: 'ignore', detached: true });
  const sup = new Supervisor({ workRoots: (side) => [join(clones, side)] });
  sup.track({ name: 'claude-liaison', side: 'claude', rootPid: liaison.pid!, marker });
  await new Promise((r) => setTimeout(r, 300));
  await sup.killSide('claude');
  await new Promise((r) => setTimeout(r, 300));

  assert.deepEqual(findSleeps('3011').filter(alive), [], 'the escaped orphan in the clone is gone');
  assert.deepEqual(findSleeps('3014').filter(alive), [], 'the liaison is gone');
  assert.equal(findSleeps('3012').filter(alive).length, 1, 'an orphan outside the clones survives');
  assert.equal(findSleeps('3013').filter(alive).length, 1, 'your own terminal in the clone survives');
  assert.ok(alive(term.pid!));
});

test('net 4 says when it could not run: lsof missing, or stuck past its timeout', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'llmb-lsof-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const missing = cwdsUnder([dir], { method: 'lsof', lsofBin: join(dir, 'no-such-lsof') });
  assert.equal(missing.cwds.size, 0);
  assert.match(missing.failure ?? '', /lsof/);

  const slow = join(dir, 'slow-lsof');
  writeFileSync(slow, '#!/bin/sh\nsleep 10\n');
  chmodSync(slow, 0o755);
  const started = Date.now();
  const stuck = cwdsUnder([dir], { method: 'lsof', lsofBin: slow, timeoutMs: 300 });
  assert.ok(Date.now() - started < 3000, 'a stuck lsof never holds up Stop');
  assert.match(stuck.failure ?? '', /timed out/);

  const failures: string[] = [];
  const sup = new Supervisor({ workRoots: () => [dir], cwdScan: { method: 'lsof', lsofBin: join(dir, 'no-such-lsof') }, onNet4Failure: (side, reason) => failures.push(`${side}: ${reason}`) });
  const child = spawn('sleep', ['3021'], { stdio: 'ignore', detached: true });
  sup.track({ name: 'claude-liaison', side: 'claude', rootPid: child.pid!, marker: 'never-matches' });
  await sup.killSide('claude');
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /^claude: .*lsof/);
});

test('config refuses a clones folder that would point net 4 at your whole home', () => {
  const base = { projects: { claude: ['app-web'], codex: ['infra-ops'] }, daily_spend_usd: { claude: 5, codex: 5 } };
  const home = homedir();
  for (const clones of ['/', home, dirname(home), join(home, 'bridge')]) {
    assert.throws(() => validateConfig({ ...base, workspace: { repos_dir: join(home, 'bridge', 'repos'), clones_dir: clones } }), ConfigError, clones);
  }
  assert.doesNotThrow(() => validateConfig({ ...base, workspace: { repos_dir: join(home, 'bridge', 'repos'), clones_dir: join(home, 'bridge', 'clones') } }));

  // Nor one that holds the hub's own state folder.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'llmb-cfg-')));
  try {
    const state = join(dir, 'state');
    mkdirSync(state);
    writeFileSync(join(state, 'config.json'), JSON.stringify({ ...base, workspace: { repos_dir: join(dir, 'repos'), clones_dir: dir } }));
    assert.throws(() => loadConfig(join(state, 'config.json')), ConfigError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
