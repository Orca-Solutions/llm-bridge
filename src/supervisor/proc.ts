// Process supervisor and kill switch (build plan task 9, security review
// must-fix 8). Agents start builds, watchers, `nohup`'d servers and
// subagents, so stopping a side means killing every process that descends
// from its sessions, not just the session itself.
//
// Three nets, because any one can miss:
// 1. a tree snapshot every second, remembering every descendant and its
//    process group, so a child that is later reparented is still known;
// 2. the session marker variable every agent process inherits, found by
//    scanning the user's processes at kill time (catches a double fork that
//    escaped before the next snapshot);
// 3. SIGTERM to every known process group, then SIGKILL after a grace period.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { SESSION_MARKER_VAR } from '../workspace/env.ts';

export interface ProcInfo {
  pid: number;
  ppid: number;
  pgid: number;
  start: string;
}

export function snapshot(): ProcInfo[] {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const procs: ProcInfo[] = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), start: m[4]!.trim() });
  }
  return procs;
}

/** PIDs of the current user's processes whose environment carries `marker`. */
export function pidsWithMarker(marker: string): number[] {
  const needle = `${SESSION_MARKER_VAR}=${marker}`;
  const found: number[] = [];
  if (process.platform === 'linux') {
    for (const p of snapshot()) {
      try {
        const env = readFileSync(`/proc/${p.pid}/environ`, 'utf8');
        if (env.split('\0').includes(needle)) found.push(p.pid);
      } catch {
        /* not ours, or gone */
      }
    }
    return found;
  }
  // macOS: BSD ps prints the environment after the command with -E.
  try {
    const out = execFileSync('ps', ['-x', '-E', '-ww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (m && m[2]!.split(/\s+/).includes(needle)) found.push(Number(m[1]));
    }
  } catch {
    /* ps unavailable: the other two nets still apply */
  }
  return found;
}

function descendants(root: number, procs: ProcInfo[]): ProcInfo[] {
  const byParent = new Map<number, ProcInfo[]>();
  for (const p of procs) {
    const list = byParent.get(p.ppid) ?? [];
    list.push(p);
    byParent.set(p.ppid, list);
  }
  const out: ProcInfo[] = [];
  const stack = [root];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop()!;
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      stack.push(child.pid);
    }
  }
  return out;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface TrackedSession {
  name: string;
  side: string;
  rootPid: number;
  marker: string;
}

export class ProcessTracker {
  readonly session: TrackedSession;
  private readonly known = new Map<number, ProcInfo>(); // pid -> info
  private timer: NodeJS.Timeout | null = null;

  constructor(session: TrackedSession, intervalMs = 1000) {
    this.session = session;
    this.poll();
    this.timer = setInterval(() => this.poll(), intervalMs);
    this.timer.unref();
  }

  poll(): void {
    let procs: ProcInfo[];
    try {
      procs = snapshot();
    } catch {
      return;
    }
    const root = procs.find((p) => p.pid === this.session.rootPid);
    if (root) this.known.set(root.pid, root);
    for (const p of descendants(this.session.rootPid, procs)) this.known.set(p.pid, p);
    // Children of anything we already know, even after their parent died.
    for (const p of procs) if (this.known.has(p.ppid) && !this.known.has(p.pid)) this.known.set(p.pid, p);
  }

  stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Every process to kill now, with pid-reuse protection by start time. */
  targets(): { pids: number[]; pgids: number[] } {
    this.poll();
    const procs = snapshot();
    const current = new Map(procs.map((p) => [p.pid, p]));
    const pids = new Set<number>();
    for (const [pid, info] of this.known) {
      const now = current.get(pid);
      if (now && now.start === info.start) pids.add(pid);
    }
    for (const pid of pidsWithMarker(this.session.marker)) pids.add(pid);
    for (const pid of [...pids]) for (const d of descendants(pid, procs)) pids.add(d.pid);
    const self = new Set([process.pid, process.ppid]);
    const selfPgid = current.get(process.pid)?.pgid;
    const pgids = new Set<number>();
    for (const pid of pids) {
      const p = current.get(pid);
      if (p && p.pgid > 1 && p.pgid !== selfPgid) pgids.add(p.pgid);
    }
    for (const s of self) pids.delete(s);
    return { pids: [...pids], pgids: [...pgids] };
  }

  /** SIGTERM to every target group and process, SIGKILL whatever is left
   * after `graceMs`. Resolves with the pids that were signalled. */
  async kill(graceMs = 2000): Promise<number[]> {
    this.stopPolling();
    const { pids, pgids } = this.targets();
    const signal = (sig: NodeJS.Signals) => {
      for (const g of pgids) {
        try {
          process.kill(-g, sig);
        } catch {
          /* gone */
        }
      }
      for (const p of pids) {
        try {
          process.kill(p, sig);
        } catch {
          /* gone */
        }
      }
    };
    signal('SIGTERM');
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && pids.some(alive)) await new Promise((r) => setTimeout(r, 100));
    if (pids.some(alive)) signal('SIGKILL');
    // Anything started in the meantime with the marker goes too.
    for (const p of pidsWithMarker(this.session.marker)) {
      try {
        process.kill(p, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    return pids;
  }
}

/** Kill every process carrying `marker` and everything below it: for
 * sessions the hub runs itself (the Codex liaison), whose processes are the
 * hub's own children and share its process group. Never the hub itself. */
export async function killMarker(marker: string, graceMs = 2000): Promise<number[]> {
  const collect = (): number[] => {
    const procs = snapshot();
    const pids = new Set<number>(pidsWithMarker(marker));
    for (const pid of [...pids]) for (const d of descendants(pid, procs)) pids.add(d.pid);
    pids.delete(process.pid);
    return [...pids];
  };
  const pids = collect();
  for (const p of pids) {
    try {
      process.kill(p, 'SIGTERM');
    } catch {
      /* gone */
    }
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && pids.some(alive)) await new Promise((r) => setTimeout(r, 100));
  for (const p of [...pids.filter(alive), ...collect()]) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  return pids;
}

/** Keeps a tracker per running session and kills a whole side on demand. */
export class Supervisor {
  private readonly trackers = new Map<string, ProcessTracker>();
  private readonly markers = new Map<string, { side: string; marker: string }>();

  /** A session the hub runs in-process: tracked by its marker alone. */
  trackMarker(name: string, side: string, marker: string): void {
    this.markers.set(name, { side, marker });
  }

  track(session: TrackedSession): void {
    this.trackers.get(session.name)?.stopPolling();
    this.trackers.set(session.name, new ProcessTracker(session));
  }

  tracked(): TrackedSession[] {
    return [...this.trackers.values()].map((t) => t.session);
  }

  async killSide(side: string): Promise<number[]> {
    const killed: number[] = [];
    for (const m of this.markers.values()) if (m.side === side) killed.push(...(await killMarker(m.marker)));
    for (const [name, t] of [...this.trackers]) {
      if (t.session.side !== side) continue;
      killed.push(...(await t.kill()));
      this.trackers.delete(name);
    }
    return killed;
  }

  stopAll(): void {
    for (const t of this.trackers.values()) t.stopPolling();
  }
}
