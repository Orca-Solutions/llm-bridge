// Kill switch gate test (build plan task 9): an agent leaves a `nohup sleep`
// running, plus a double-forked one that is reparented before any snapshot;
// Stop kills them all within seconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { Supervisor } from '../../src/supervisor/proc.ts';
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
