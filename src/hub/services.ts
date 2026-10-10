// Background services the hub runs next to the socket and console:
//
// - RunWatcher: picks up the pid files the liaison launchers write in
//   <state>/run/ and hands each session to the supervisor, so Stop kills the
//   session's whole process tree (build plan task 9).
// - GuardScanner: scans the bare repos for agent commits touching guarded
//   files and records them for the console (task 8).
// - OtlpReceiver: a loopback OTLP/HTTP JSON endpoint that turns Claude Code's
//   cost metric into the Claude side's spend estimate (D13).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Hub } from '../core/hub.ts';
import type { Side } from '../core/types.ts';
import { pidsWithMarker, type Supervisor } from '../supervisor/proc.ts';
import type { WorkspaceManager } from '../workspace/manager.ts';

const HUB_ACTOR = { principal: 'hub', name: 'hub' } as const;

// ---------------------------------------------------------------- run files

export interface RunRecord {
  name: string;
  side: Side;
  pid: number;
  marker: string;
}

export const MARKER_PATTERN = /^[A-Za-z0-9-]{16,64}$/;

export function parseRunRecord(raw: unknown): RunRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || (r.side !== 'claude' && r.side !== 'codex')) return null;
  if (typeof r.pid !== 'number' || !Number.isInteger(r.pid) || r.pid < 2) return null;
  if (typeof r.marker !== 'string' || !MARKER_PATTERN.test(r.marker)) return null;
  return { name: r.name, side: r.side, pid: r.pid, marker: r.marker };
}

export class RunWatcher {
  private readonly dir: string;
  private readonly hub: Hub;
  private readonly supervisor: Supervisor;
  private readonly seen = new Map<string, string>(); // file -> marker
  private timer: NodeJS.Timeout | null = null;

  constructor(dir: string, hub: Hub, supervisor: Supervisor) {
    this.dir = dir;
    this.hub = hub;
    this.supervisor = supervisor;
  }

  start(intervalMs = 1000): void {
    this.scan();
    this.timer = setInterval(() => this.scan(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Track every new run file whose process really carries its marker; a
   * file naming some other process is refused, so a stray file can't point
   * the kill switch at it. */
  scan(): void {
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return;
    }
    for (const file of files) {
      let rec: RunRecord | null = null;
      try {
        rec = parseRunRecord(JSON.parse(readFileSync(join(this.dir, file), 'utf8')));
      } catch {
        rec = null;
      }
      if (rec && this.seen.get(file) === rec.marker) continue;
      const session = rec ? this.hub.session(rec.name) : undefined;
      if (!rec || !session || session.side !== rec.side) {
        if (this.seen.get(file) !== 'invalid') this.hub.audit(HUB_ACTOR, 'session.track', 'refused', 'invalid_run_file', null, null, { file });
        this.seen.set(file, 'invalid');
        continue;
      }
      this.seen.set(file, rec.marker);
      if (!pidsWithMarker(rec.marker).includes(rec.pid)) {
        // Gone already, or not the process the file claims.
        this.hub.audit(HUB_ACTOR, 'session.track', 'refused', 'marker_mismatch', null, null, { name: rec.name, pid: rec.pid });
        continue;
      }
      this.supervisor.track({ name: rec.name, side: rec.side, rootPid: rec.pid, marker: rec.marker });
      this.hub.audit(HUB_ACTOR, 'session.track', 'ok', null, null, null, { name: rec.name, pid: rec.pid });
    }
  }
}

// -------------------------------------------------------------- guard scans

export class GuardScanner {
  private readonly hub: Hub;
  private readonly reposDir: string;
  private readonly makeWorkspace: () => WorkspaceManager;
  private ws: WorkspaceManager | null = null;
  private readonly baselineDir: string;
  private timer: NodeJS.Timeout | null = null;

  /** The workspace is made only once its repos folder exists (after the
   * first `llm-bridge repo add`), so a hub started before that needs no
   * restart. */
  constructor(hub: Hub, reposDir: string, makeWorkspace: () => WorkspaceManager, baselineDir: string) {
    this.hub = hub;
    this.reposDir = reposDir;
    this.makeWorkspace = makeWorkspace;
    this.baselineDir = baselineDir;
  }

  start(intervalMs = 30_000): void {
    this.scan();
    this.timer = setInterval(() => this.scan(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The refs `repo add` recorded when it created the bare repo, so commits
   * pushed before the hub's first scan are still checked. */
  private baseline(project: string): Record<string, string> | null {
    const file = join(this.baselineDir, `${project}.json`);
    if (!existsSync(file)) return null;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && /^[0-9a-f]{40,64}$/.test(v)) out[k] = v;
      return out;
    } catch {
      return null;
    }
  }

  scan(): number {
    if (!this.ws) {
      if (!existsSync(this.reposDir)) return 0;
      this.ws = this.makeWorkspace();
    }
    const ws = this.ws;
    let added = 0;
    const projects = [...this.hub.config.projects.claude, ...this.hub.config.projects.codex];
    for (const project of new Set(projects)) {
      if (!existsSync(ws.barePath(project))) continue;
      try {
        let since = this.hub.store.guardRefs(project);
        if (since === null) {
          const base = this.baseline(project);
          if (base === null) {
            // No baseline from `repo add`: take the repo as it is now.
            this.hub.store.setGuardRefs(project, ws.scanGuard(project, {}).seen);
            this.hub.audit(HUB_ACTOR, 'guard.baseline', 'ok', null, null, null, { project, source: 'first_scan' });
            continue;
          }
          since = base;
        }
        const report = ws.scanGuard(project, since);
        added += this.hub.recordGuardFlags(report.flags);
        this.hub.store.setGuardRefs(project, report.seen);
      } catch (err) {
        this.hub.audit(HUB_ACTOR, 'guard.scan', 'error', 'scan_failed', null, null, { project, error: String((err as Error).message).slice(0, 200) });
      }
    }
    return added;
  }
}

// ------------------------------------------------------------ OTLP receiver

/** Claude Code's cost counter, in USD. */
export const CLAUDE_COST_METRIC = 'claude_code.cost.usage';
const MAX_OTLP_BODY = 1024 * 1024;
const CUMULATIVE = 2;

type Json = Record<string, unknown>;

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return null;
}

function list(v: unknown): Json[] {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Json[]) : [];
}

/** Sum the cost metric in one OTLP JSON export. Delta points add as they
 * are; cumulative points add their increase over the last value seen for
 * the same series, so a cumulative exporter can't be double counted. */
export class CostMeter {
  private readonly last = new Map<string, number>();

  costIn(body: unknown): number {
    let usd = 0;
    for (const rm of list((body as Json)?.resourceMetrics)) {
      for (const sm of list(rm.scopeMetrics)) {
        for (const m of list(sm.metrics)) {
          if (m.name !== CLAUDE_COST_METRIC) continue;
          const sum = (m.sum ?? {}) as Json;
          const cumulative = sum.aggregationTemporality === CUMULATIVE || sum.aggregationTemporality === 'AGGREGATION_TEMPORALITY_CUMULATIVE';
          for (const dp of list(sum.dataPoints)) {
            const v = asNumber(dp.asDouble ?? dp.asInt);
            if (v === null || v < 0) continue;
            if (!cumulative) {
              usd += v;
              continue;
            }
            const key = JSON.stringify(list(dp.attributes).map((a) => [a.key, a.value]).sort());
            const prev = this.last.get(key) ?? 0;
            this.last.set(key, v);
            usd += v >= prev ? v - prev : v; // a reset starts the count again
          }
        }
      }
    }
    return usd;
  }
}

export class OtlpReceiver {
  private readonly hub: Hub;
  private readonly port: number;
  private readonly meter = new CostMeter();
  private server: Server | null = null;

  constructor(hub: Hub, port: number) {
    this.hub = hub;
    this.port = port;
  }

  async listen(): Promise<number> {
    const server = createServer((req, res) => void this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    return typeof addr === 'object' && addr ? addr.port : this.port;
  }

  async close(): Promise<void> {
    const s = this.server;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }

  private done(res: ServerResponse, status: number): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end('{}');
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const addr = this.server?.address();
    const port = typeof addr === 'object' && addr ? addr.port : this.port;
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return this.done(res, 403);
    // A browser page can't post here: no CORS, and only JSON is accepted.
    if (req.headers.origin !== undefined) return this.done(res, 403);
    if (req.method !== 'POST' || req.url !== '/v1/metrics') return this.done(res, 404);
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return this.done(res, 415);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_OTLP_BODY) return this.done(res, 413);
      chunks.push(c as Buffer);
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return this.done(res, 400);
    }
    const usd = this.meter.costIn(body);
    if (usd > 0) this.hub.recordSpend('claude', usd, 'otel');
    return this.done(res, 200);
  }
}
