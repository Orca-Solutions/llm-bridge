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

export interface StartOptions {
  stateDir: string;
  /** Override the console port (tests use 0). */
  consolePort?: number;
  log?: (line: string) => void;
}

export interface RunningHub {
  hub: Hub;
  socket: SessionSocket;
  console: ConsoleServer;
  config: HubConfig;
  paths: { stateDir: string; socket: string; config: string; db: string; tokens: Record<string, string> };
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

  log(`LLM-Bridge hub running.`);
  log(`  session socket: ${socketPath}`);
  log(`  console login (one use, 10 minutes): ${consoleServer.loginLink()}`);
  for (const [name, path] of Object.entries(tokenPaths)) log(`  ${name} token file: ${path}`);

  return {
    hub,
    socket,
    console: consoleServer,
    config,
    paths: { stateDir: opts.stateDir, socket: socketPath, config: configPath, db: dbPath, tokens: tokenPaths },
    stop: async () => {
      await consoleServer.close();
      await socket.close();
      store.close();
    },
  };
}
