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
//    escaped before the next snapshot). On macOS, ps can't show the
//    environment of Apple's own binaries (sh, sleep and the rest of /bin and
//    /usr/bin), so this net sees only other programs there; nets 1 and 3
//    still cover Apple's;
// 3. SIGTERM to every known process group, then SIGKILL after a grace period;
// 4. the working folder: any of the user's processes with no terminal whose
//    working folder is inside that side's clones. This is the net that finds
//    an Apple binary on macOS once its shell has exited: `nohup sleep &` in
//    the liaison's Bash leaves the sleep reparented to launchd, in a process
//    group whose leader is gone, with an environment ps can't show. A process
//    with a terminal is yours (a shell you cd'd into a clone), so it is never
//    a target.
//
// Net 4 is a heuristic for leftovers, not a wall against an agent that means
// to stay alive: changing folder before daemonizing, or wrapping the process
// in a pty so it has a terminal, both escape it, and on macOS nets 1 to 3
// then miss any Apple binary once its shell has exited. Stop is best-effort
// against a deliberately evasive agent until agents run under their own OS
// user, where Stop becomes a user-wide kill (the "before unattended" step).
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { SESSION_MARKER_VAR } from '../workspace/env.ts';

export interface ProcInfo {
  pid: number;
  ppid: number;
  pgid: number;
  /** Controlling terminal, or null for none. */
  tty: string | null;
  start: string;
}

export function snapshot(): ProcInfo[] {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,tty=,lstart='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const procs: ProcInfo[] = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (m) {
      const tty = /^(\?+|-)$/.test(m[4]!) ? null : m[4]!;
      procs.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), tty, start: m[5]!.trim() });
    }
  }
  return procs;
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

export interface CwdScanOptions {
  /** How to read working folders; defaults to /proc on Linux, lsof elsewhere. */
  method?: 'proc' | 'lsof';
  lsofBin?: string;
  /** lsof can block on a stale network mount; Stop must not wait on it. */
  timeoutMs?: number;
}

export interface CwdScan {
  /** pid -> working folder, for the current user's processes inside the roots. */
  cwds: Map<number, string>;
  /** Why the scan could not run, or null. */
  failure: string | null;
}

/** The current user's processes whose working folder is inside one of
 * `roots`. */
export function cwdsUnder(roots: string[], opts: CwdScanOptions = {}): CwdScan {
  const real = roots.flatMap((r) => {
    try {
      return [realpathSync(r)];
    } catch {
      return [];
    }
  });
  const found = new Map<number, string>();
  if (real.length === 0) return { cwds: found, failure: null };
  const keep = (pid: number, cwd: string) => {
    if (real.some((r) => inside(cwd, r))) found.set(pid, cwd);
  };
  const method = opts.method ?? (process.platform === 'linux' ? 'proc' : 'lsof');
  if (method === 'proc') {
    for (const p of snapshot()) {
      try {
        keep(p.pid, readlinkSync(`/proc/${p.pid}/cwd`));
      } catch {
        /* not ours, or gone */
      }
    }
    return { cwds: found, failure: null };
  }
  // macOS: lsof reads working folders for Apple's binaries too. It exits 1
  // when some process vanished mid-scan, so read stdout whatever the status.
  const r = spawnSync(opts.lsofBin ?? 'lsof', ['-a', '-u', String(process.getuid!()), '-d', 'cwd', '-Fpn', '-w'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: opts.timeoutMs ?? 5000,
    killSignal: 'SIGKILL',
  });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    return { cwds: found, failure: code === 'ETIMEDOUT' ? 'lsof timed out' : `lsof failed: ${code ?? r.error.message}` };
  }
  let pid = 0;
  for (const line of (r.stdout ?? '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid > 0) keep(pid, line.slice(1));
  }
  return { cwds: found, failure: null };
}

export interface Net4 {
  /** Folders where the side's agents work (its clones). */
  roots: string[];
  scan?: CwdScanOptions;
  /** Told when the scan could not run, so the audit log shows it. */
  onFailure?: (reason: string) => void;
}

/** Pids for net 4: no terminal, working folder inside the roots. Pids are
 * not checked against reuse between this scan and the kill; the window is
 * milliseconds, and the worst case is a SIGTERM to a fresh process of yours. */
export function pidsWorkingIn(net: Net4, procs: ProcInfo[] = snapshot()): number[] {
  if (net.roots.length === 0) return [];
  const { cwds, failure } = cwdsUnder(net.roots, net.scan);
  if (failure) net.onFailure?.(failure);
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  return [...cwds.keys()].filter((pid) => {
    const p = byPid.get(pid);
    return p !== undefined && p.tty === null;
  });
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
  private readonly net4: Net4;
  private readonly known = new Map<number, ProcInfo>(); // pid -> info
  private timer: NodeJS.Timeout | null = null;

  constructor(session: TrackedSession, intervalMs = 1000, net4: Net4 = { roots: [] }) {
    this.session = session;
    this.net4 = net4;
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
    // Net 4's finds are killed with their descendants, and their process
    // group only when its leader is gone (an orphaned group), so a stray
    // helper of some app of yours working in a clone never takes that app's
    // whole group with it.
    const byCwd = pidsWorkingIn(this.net4, procs).filter((pid) => !pids.has(pid));
    for (const pid of [...pids]) for (const d of descendants(pid, procs)) pids.add(d.pid);
    const self = new Set([process.pid, process.ppid]);
    const selfPgid = current.get(process.pid)?.pgid;
    const pgids = new Set<number>();
    for (const pid of pids) {
      const p = current.get(pid);
      if (p && p.pgid > 1 && p.pgid !== selfPgid) pgids.add(p.pgid);
    }
    for (const pid of byCwd) {
      pids.add(pid);
      for (const d of descendants(pid, procs)) if (d.tty === null) pids.add(d.pid);
      const p = current.get(pid);
      if (p && p.pgid > 1 && p.pgid !== selfPgid && !current.has(p.pgid)) pgids.add(p.pgid);
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
export async function killMarker(marker: string, graceMs = 2000, net4: Net4 = { roots: [] }): Promise<number[]> {
  const collect = (): number[] => {
    const procs = snapshot();
    const pids = new Set<number>(pidsWithMarker(marker));
    for (const pid of [...pids]) for (const d of descendants(pid, procs)) pids.add(d.pid);
    for (const pid of pidsWorkingIn(net4, procs)) {
      pids.add(pid);
      for (const d of descendants(pid, procs)) if (d.tty === null) pids.add(d.pid);
    }
    pids.delete(process.pid);
    pids.delete(process.ppid);
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
export interface SupervisorOptions {
  /** Folders where a side's agents work (its clones), for net 4. */
  workRoots?: (side: string) => string[];
  cwdScan?: CwdScanOptions;
  /** Net 4 could not run for this side (lsof missing or stuck). */
  onNet4Failure?: (side: string, reason: string) => void;
}

export class Supervisor {
  private readonly trackers = new Map<string, ProcessTracker>();
  private readonly markers = new Map<string, { side: string; marker: string }>();
  private readonly opts: SupervisorOptions;

  constructor(opts: SupervisorOptions = {}) {
    this.opts = opts;
  }

  private net4(side: string): Net4 {
    let told = false;
    return {
      roots: this.opts.workRoots?.(side) ?? [],
      scan: this.opts.cwdScan,
      onFailure: (reason) => {
        if (told) return;
        told = true;
        this.opts.onNet4Failure?.(side, reason);
      },
    };
  }

  /** A session the hub runs in-process: tracked by its marker alone. */
  trackMarker(name: string, side: string, marker: string): void {
    this.markers.set(name, { side, marker });
  }

  track(session: TrackedSession): void {
    this.trackers.get(session.name)?.stopPolling();
    this.trackers.set(session.name, new ProcessTracker(session, 1000, this.net4(session.side)));
  }

  tracked(): TrackedSession[] {
    return [...this.trackers.values()].map((t) => t.session);
  }

  async killSide(side: string): Promise<number[]> {
    const killed: number[] = [];
    for (const m of this.markers.values()) if (m.side === side) killed.push(...(await killMarker(m.marker, 2000, this.net4(side))));
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
