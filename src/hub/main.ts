// Start the hub: state directory, config, store, tokens, the session socket
// and the console. Everything lives in the state directory, which stays
// outside every agent clone and sandbox write root.
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../core/store.ts';
import { TokenRegistry } from '../core/auth.ts';
import { Hub, phase1Sessions } from '../core/hub.ts';
import { loadConfig, type HubConfig } from '../core/config.ts';
import { SessionSocket } from './socket.ts';
import { ConsoleServer } from '../console/server.ts';
import { Supervisor } from '../supervisor/proc.ts';
import { WorkspaceManager, workspacePaths } from '../workspace/manager.ts';
import { GuardScanner, OtlpReceiver, RunWatcher } from './services.ts';
import { startCodexLiaison, type CodexLiaison } from '../adapters/codex-launch.ts';

export interface StartOptions {
  stateDir: string;
  /** Override the console port (tests use 0). */
  consolePort?: number;
  /** Override the OTLP receiver port (tests use 0). */
  otlpPort?: number;
  /** Run the Codex liaison in the hub (Milestone B). */
  codex?: boolean;
  /** Tests: a stand-in for the pinned Codex binary. */
  codexBin?: string;
  log?: (line: string) => void;
}

export interface RunningHub {
  hub: Hub;
  socket: SessionSocket;
  console: ConsoleServer;
  config: HubConfig;
  supervisor: Supervisor;
  guard: GuardScanner;
  codex: CodexLiaison | null;
  otlpPort: number;
  paths: { stateDir: string; socket: string; config: string; db: string; tokens: Record<string, string>; run: string };
  stop: () => Promise<void>;
}

export function ensureStateDir(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
}

export async function startHub(opts: StartOptions): Promise<RunningHub> {
  const log = opts.log ?? ((l: string) => process.stdout.write(l + '\n'));
  ensureStateDir(opts.stateDir);
  const configPath = join(opts.stateDir, 'config.json');
  if (!existsSync(configPath)) throw new Error(`no config at ${configPath}; run \`llm-bridge init\` first`);
  const config = loadConfig(configPath);
  const dbPath = join(opts.stateDir, 'bridge.db');
  const store = new Store(dbPath);
  chmodSync(dbPath, 0o600);
  const tokens = new TokenRegistry(opts.stateDir);
  const hub = new Hub({ store, tokens, config });

  const tokenPaths: Record<string, string> = {};
  for (const s of phase1Sessions(config)) tokenPaths[s.name] = hub.issueToken(s.name);

  const socketPath = join(opts.stateDir, 'hub.sock');
  const socket = new SessionSocket(hub, socketPath);
  await socket.listen();

  const consoleServer = new ConsoleServer(hub, {
    port: opts.consolePort ?? config.console_port,
    reloadConfig: () => {
      // Phase 1 config has nothing a reload may change except limits and the
      // spend cap; routing stays off whatever the file says.
      const before = hub.config;
      const next = loadConfig(configPath);
      hub.config = next;
      const diff = { before, after: next };
      hub.audit({ principal: 'human', name: 'console' }, 'config.reload', 'ok', null, null, null, diff as unknown as Record<string, unknown>);
      return diff;
    },
  });
  await consoleServer.listen();

  // Kill switch: the liaison launchers write <state>/run/<session>.json; the
  // supervisor tracks each session's process tree and kills it on Stop.
  const runDir = join(opts.stateDir, 'run');
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  // Net 4 kills what a side leaves running in its own clones (see proc.ts).
  const supervisor = new Supervisor({ workRoots: (side) => [join(workspacePaths(config.workspace).clonesDir, side)] });
  const watcher = new RunWatcher(runDir, hub, supervisor);
  watcher.start();
  const kills = new Set<Promise<void>>();
  hub.on('stop-side', (side: string) => {
    watcher.scan();
    const k = supervisor
      .killSide(side)
      .then((pids) => hub.audit({ principal: 'hub', name: 'hub' }, 'kill_switch.processes', 'ok', null, null, null, { side, killed: pids.length }))
      .catch((err) => log(`kill switch for ${side} failed: ${(err as Error).message}`))
      .finally(() => kills.delete(k));
    kills.add(k);
  });

  // Repo-file guard over the bare repos, once `llm-bridge repo add` made them.
  const wsPaths = workspacePaths(config.workspace);
  const guard = new GuardScanner(
    hub,
    wsPaths.reposDir,
    () => new WorkspaceManager({ reposDir: wsPaths.reposDir, clonesDir: wsPaths.clonesDir, gitConfigPath: wsPaths.gitConfigPath }),
    join(opts.stateDir, 'guard-baseline'),
  );
  guard.start();

  // Claude-side spend (D13) from Claude Code's OTel cost metric.
  const otlp = new OtlpReceiver(hub, opts.otlpPort ?? config.otlp_port);
  const otlpPort = await otlp.listen();

  // The Codex liaison runs inside the hub. Stop halts it (and the
  // supervisor kills its processes); Resume starts it again.
  let codex: CodexLiaison | null = null;
  if (opts.codex) {
    codex = await startCodexLiaison({ hub, config, stateDir: opts.stateDir, supervisor, codexBin: opts.codexBin, log });
    const liaison = codex;
    hub.on('stop-side', (side: string) => {
      if (side === 'codex') liaison.adapter.stop();
    });
    hub.on('resume-side', (side: string) => {
      if (side !== 'codex') return;
      liaison.adapter.start().catch((err) => log(`Codex liaison failed to restart: ${(err as Error).message}`));
    });
  }

  log(`LLM-Bridge hub running.`);
  log(`  session socket: ${socketPath}`);
  log(`  console login (one use, 10 minutes): ${consoleServer.loginLink()}`);
  for (const [name, path] of Object.entries(tokenPaths)) log(`  ${name} token file: ${path}`);
  log(`  spend meter (OTLP, loopback): http://127.0.0.1:${otlpPort}`);

  return {
    hub,
    socket,
    console: consoleServer,
    config,
    supervisor,
    guard,
    codex,
    otlpPort,
    paths: { stateDir: opts.stateDir, socket: socketPath, config: configPath, db: dbPath, tokens: tokenPaths, run: runDir },
    stop: async () => {
      watcher.stop();
      guard.stop();
      codex?.adapter.stop();
      await Promise.all([...kills]);
      supervisor.stopAll();
      await otlp.close();
      await consoleServer.close();
      await socket.close();
      store.close();
    },
  };
}
