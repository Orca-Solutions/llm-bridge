// The Codex liaison adapter (build plan task 11). The hub runs it: one
// long-lived Codex thread through the TypeScript SDK, fed one turn per bridge
// message. It reaches the hub like any session, over the socket with the
// codex-liaison token, and the Codex model replies through the bridge MCP
// shim registered in its CODEX_HOME.
//
// Every run goes through the argv guard (codex-guard.ts), which refuses a
// command line that drifts from the pinned settings. The SDK reports commands
// only after they run, so the adapter can't block one; it logs what failed.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Codex, type Thread, type ThreadEvent, type Usage } from '@openai/codex-sdk';
import type { Hub } from '../core/hub.ts';
import type { Delivery } from '../core/delivery.ts';
import { HubClient } from '../hub/client.ts';
import { agentEnv } from '../workspace/env.ts';
import { codexConfigOverrides, codexThreadOptions, prepareCodexHome, type CodexLiaisonPaths } from '../liaison/codex.ts';
import { GUARD_BIN_VAR, GUARD_CLONE_VAR, GUARD_REFUSED_EXIT } from '../liaison/codex-guard.ts';
import { findCodexBinary } from '../liaison/codex-bin.ts';

export const GUARD_BIN = fileURLToPath(new URL('../../bin/codex-guard.js', import.meta.url));
export const CODEX_SESSION = 'codex-liaison';
/** The branch in the bare repo the hub commits the liaison's work to. */
export const CODEX_BRANCH = 'agent/codex-liaison';

const HUB_ACTOR = { principal: 'codex-adapter', name: CODEX_SESSION } as const;

export interface Prices {
  input: number;
  cached_input: number;
  output: number;
}

/** Estimated USD for one turn at list price (D13). OpenAI usage counts
 * cached tokens inside input_tokens and reasoning inside output_tokens. */
export function turnCost(u: Usage, prices: Prices): number {
  const cached = Math.min(u.cached_input_tokens ?? 0, u.input_tokens ?? 0);
  const fresh = (u.input_tokens ?? 0) - cached;
  return (fresh * prices.input + cached * prices.cached_input + (u.output_tokens ?? 0) * prices.output) / 1_000_000;
}

export interface CodexAdapterOptions {
  hub: Hub;
  paths: CodexLiaisonPaths;
  /** Bridge-only gitconfig (no credential helper). */
  gitConfigPath: string;
  /** The project's bare repo; the liaison's work is committed there. */
  bareRepo: string;
  /** The commit the clone was made from. */
  baseCommit: string;
  /** A private git index for snapshots, in the hub's state directory. */
  indexFile: string;
  /** Kill-switch marker every Codex process carries. */
  marker: string;
  /** Where the Codex thread id is kept between hub restarts. */
  threadFile: string;
  prices: Prices;
  /** Tests point this at a stand-in binary; normally the pinned CLI. */
  codexBin?: string;
  log?: (line: string) => void;
}

export class CodexAdapter {
  private readonly opts: CodexAdapterOptions;
  private readonly queue: Delivery[] = [];
  private client: HubClient | null = null;
  private thread: Thread | null = null;
  private abort: AbortController | null = null;
  private lastAgentText: string | null = null;
  private pumping = false;
  private stopped = false;
  private idle: Promise<void> = Promise.resolve();

  constructor(opts: CodexAdapterOptions) {
    this.opts = opts;
  }

  private audit(action: string, outcome: 'ok' | 'refused' | 'error', code: string | null, d: Delivery | null, detail: Record<string, unknown> | null = null): void {
    try {
      this.opts.hub.audit(HUB_ACTOR, action, outcome, code, d?.thread_id ?? null, d?.message_id ?? null, detail);
    } catch {
      /* hub closing */
    }
  }

  /** The environment Codex runs with: the scrubbed allowlist, its own
   * CODEX_HOME, the marker, and what the guard needs. */
  env(): Record<string, string> {
    const real = this.opts.codexBin ? { bin: this.opts.codexBin, pathDirs: [] } : findCodexBinary();
    const env = agentEnv(process.env, {
      gitConfigPath: this.opts.gitConfigPath,
      sessionMarker: this.opts.marker,
      extra: { CODEX_HOME: this.opts.paths.codexHome, [GUARD_BIN_VAR]: real.bin, [GUARD_CLONE_VAR]: this.opts.paths.clone },
    });
    if (real.pathDirs.length > 0) env.PATH = [...real.pathDirs, env.PATH ?? ''].filter(Boolean).join(':');
    return env;
  }

  async start(): Promise<void> {
    this.stopped = false;
    prepareCodexHome(this.opts.paths);
    const codex = new Codex({ codexPathOverride: GUARD_BIN, env: this.env(), config: codexConfigOverrides() as never });
    const options = codexThreadOptions(this.opts.paths);
    const saved = existsSync(this.opts.threadFile) ? readFileSync(this.opts.threadFile, 'utf8').trim() : '';
    this.thread = /^[0-9a-zA-Z-]{8,64}$/.test(saved) ? codex.resumeThread(saved, { ...options }) : codex.startThread({ ...options });
    this.client = new HubClient({
      socketPath: this.opts.paths.hubSocket,
      tokenFile: this.opts.paths.tokenFile,
      onPush: async (d) => this.enqueue(d),
    });
    await this.client.connect();
    this.audit('codex.start', 'ok', null, null, { resumed: saved.length > 0 });
  }

  /** Accept a delivery. Acked once queued: the adapter owns it from here. */
  private enqueue(d: Delivery): void {
    if (this.stopped) throw new Error('stopped');
    this.queue.push(d);
    if (!this.pumping) this.idle = this.pump();
  }

  private async pump(): Promise<void> {
    this.pumping = true;
    try {
      while (!this.stopped && this.queue.length > 0) await this.turn(this.queue.shift()!);
    } finally {
      this.pumping = false;
    }
  }

  /** Resolves when the queue has drained (tests). */
  drained(): Promise<void> {
    return this.idle;
  }

  private async turn(d: Delivery): Promise<void> {
    const thread = this.thread!;
    this.abort = new AbortController();
    this.audit('codex.turn', 'ok', null, d);
    const repliesBefore = this.repliesOn(d.thread_id);
    this.lastAgentText = null;
    let completed = false;
    try {
      const { events } = await thread.runStreamed(d.text, { signal: this.abort.signal });
      for await (const ev of events) {
        this.onEvent(ev, d);
        if (ev.type === 'turn.completed') completed = true;
      }
      // Codex answers through the bridge's send_message; a final message it
      // only wrote into its own transcript reaches nobody. Say so on the
      // console, with what it said (agent text, shown as plain text).
      if (completed && !this.stopped && this.repliesOn(d.thread_id) === repliesBefore) {
        this.audit('codex.no_reply', 'error', 'no_bridge_reply', d, { last_message: (this.lastAgentText ?? '').slice(0, 500) });
      }
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      const refused = msg.includes(`code ${GUARD_REFUSED_EXIT}`) || msg.includes('guard refused');
      this.audit('codex.turn', refused ? 'refused' : 'error', refused ? 'argv_guard' : 'turn_failed', d, { error: msg.slice(0, 500) });
    } finally {
      this.abort = null;
      if (thread.id) this.saveThreadId(thread.id);
      if (!this.stopped) this.snapshot(d);
    }
  }

  private repliesOn(threadId: string): number {
    try {
      return this.opts.hub.store.threadMessages(threadId).filter((m) => m.from_name === CODEX_SESSION).length;
    } catch {
      return 0;
    }
  }

  private onEvent(ev: ThreadEvent, d: Delivery): void {
    if (ev.type === 'thread.started') this.saveThreadId(ev.thread_id);
    else if (ev.type === 'turn.completed') {
      const usd = turnCost(ev.usage, this.opts.prices);
      if (usd > 0) this.opts.hub.recordSpend('codex', usd, 'codex-sdk');
    } else if (ev.type === 'turn.failed') this.audit('codex.turn', 'error', 'turn_failed', d, { error: ev.error.message.slice(0, 500) });
    else if (ev.type === 'error') this.audit('codex.turn', 'error', 'stream_error', d, { error: ev.message.slice(0, 500) });
    else if (ev.type === 'item.completed' && ev.item.type === 'command_execution' && ev.item.status === 'failed') {
      // Network, writes outside the clone and execpolicy denials show up
      // here: the command was refused or failed, and the turn went on.
      this.audit('codex.command', 'refused', 'command_failed', d, { command: ev.item.command.slice(0, 300), exit_code: ev.item.exit_code ?? null });
    } else if (ev.type === 'item.completed' && ev.item.type === 'mcp_tool_call' && ev.item.status === 'failed') {
      this.audit('codex.mcp_call', 'error', 'mcp_call_failed', d, { server: ev.item.server, tool: ev.item.tool, error: (ev.item.error?.message ?? '').slice(0, 300) });
    } else if (ev.type === 'item.completed' && ev.item.type === 'agent_message') {
      this.lastAgentText = ev.item.text;
    }
  }

  private saveThreadId(id: string): void {
    try {
      writeFileSync(this.opts.threadFile, id + '\n', { mode: 0o600 });
    } catch {
      /* state dir gone */
    }
  }

  /** git against the bare repo, with the clone as the work tree and a
   * private index. No git process ever reads the clone's own .git, which
   * Codex might have reached: config, hooks and filters all come from the
   * hub-owned bare repo. */
  private git(args: string[], extraEnv: Record<string, string> = {}): string {
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', `--git-dir=${this.opts.bareRepo}`, `--work-tree=${this.opts.paths.clone}`, ...args], {
      cwd: this.opts.paths.clone,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        GIT_CONFIG_GLOBAL: this.opts.gitConfigPath,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_INDEX_FILE: this.opts.indexFile,
        ...extraEnv,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }

  /** Commit what the liaison has left in its clone to its branch in the
   * bare repo, where the maintainer fetches it and the repo-file guard scans
   * it. Codex can't commit itself: its sandbox keeps .git read-only. */
  private snapshot(d: Delivery): void {
    try {
      const ref = `refs/heads/${CODEX_BRANCH}`;
      let parent: string;
      try {
        parent = this.git(['rev-parse', '--verify', '-q', ref]);
      } catch {
        parent = this.opts.baseCommit;
      }
      this.git(['read-tree', parent]);
      this.git(['add', '-A', '--', '.']);
      const tree = this.git(['write-tree']);
      if (tree === this.git(['rev-parse', `${parent}^{tree}`])) return;
      const commit = this.git(['commit-tree', tree, '-p', parent, '-m', `Codex liaison work for bridge message ${d.message_id}`]);
      this.git(['update-ref', ref, commit, parent === this.opts.baseCommit ? '' : parent]);
      this.audit('codex.snapshot', 'ok', null, d, { commit });
    } catch (err) {
      this.audit('codex.snapshot', 'error', 'snapshot_failed', d, { error: String((err as Error).message).slice(0, 300) });
    }
  }

  /** Kill switch: drop the queue, abort the running turn, disconnect. The
   * supervisor kills any process left with the marker. */
  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    this.abort?.abort();
    this.client?.close();
    this.client = null;
  }
}
