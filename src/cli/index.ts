// llm-bridge command line.
//
//   llm-bridge init --claude-project NAME --codex-project NAME --daily-spend-usd N [--state-dir DIR] [--console-port P]
//   llm-bridge hub [--state-dir DIR] [--codex]
//   llm-bridge mcp --socket PATH --token-file PATH
//   llm-bridge repo add PROJECT --from PATH [--state-dir DIR]
//   llm-bridge liaison claude [--state-dir DIR] [--clone PATH] [--mode default|acceptEdits] [--no-mode-flag]
//   llm-bridge channel --socket PATH --token-file PATH   (Claude Code runs this)
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, validateConfig } from '../core/config.ts';
import { checkVersions } from '../core/versions.ts';
import { ensureStateDir, startHub } from '../hub/main.ts';
import { runShim } from '../shim/bridge-mcp.ts';
import { runChannel } from '../channel/server.ts';
import { runClaudeLiaison } from '../liaison/launch.ts';
import type { LiaisonMode } from '../liaison/claude.ts';
import { WorkspaceManager, workspacePaths } from '../workspace/manager.ts';

const DEFAULT_STATE_DIR = join(homedir(), '.llm-bridge');

function usage(): never {
  process.stderr.write(
    [
      'usage:',
      '  llm-bridge init --claude-project NAME --codex-project NAME --daily-spend-usd N [--state-dir DIR] [--console-port P]',
      '  llm-bridge hub [--state-dir DIR] [--codex]',
      '  llm-bridge mcp --socket PATH --token-file PATH',
      '  llm-bridge repo add PROJECT --from PATH [--state-dir DIR]',
      '  llm-bridge liaison claude [--state-dir DIR] [--clone PATH] [--mode default|acceptEdits] [--no-mode-flag]',
      '  llm-bridge channel --socket PATH --token-file PATH',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === 'init') {
    const { values } = parseArgs({
      args: rest,
      options: {
        'state-dir': { type: 'string' },
        'claude-project': { type: 'string' },
        'codex-project': { type: 'string' },
        'daily-spend-usd': { type: 'string' },
        'console-port': { type: 'string' },
      },
    });
    const stateDir = resolve(values['state-dir'] ?? DEFAULT_STATE_DIR);
    const spend = Number(values['daily-spend-usd']);
    if (!values['claude-project'] || !values['codex-project'] || !Number.isFinite(spend)) usage();
    const config = validateConfig({
      owner: 'jason',
      projects: { claude: [values['claude-project']], codex: [values['codex-project']] },
      routes: [],
      routing_enabled: false,
      daily_spend_usd: { claude: spend, codex: spend },
      console_port: values['console-port'] ? Number(values['console-port']) : 7077,
    });
    ensureStateDir(stateDir);
    const path = join(stateDir, 'config.json');
    if (existsSync(path)) throw new Error(`${path} exists; edit it and reload from the console instead`);
    writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    process.stdout.write(`wrote ${path}\n`);
    return;
  }
  if (command === 'hub') {
    const { values } = parseArgs({ args: rest, options: { 'state-dir': { type: 'string' }, codex: { type: 'boolean' } } });
    const versions = checkVersions();
    if (versions.problems.length > 0) {
      for (const p of versions.problems) process.stderr.write(`refusing to start: ${p}\n`);
      process.exit(1);
    }
    process.stdout.write(`claude ${versions.claude}, codex ${versions.codex ?? 'not found'}\n`);
    const running = await startHub({ stateDir: resolve(values['state-dir'] ?? DEFAULT_STATE_DIR), codex: values.codex });
    const shutdown = () => void running.stop().then(() => process.exit(0));
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }
  if (command === 'mcp') {
    const { values } = parseArgs({ args: rest, options: { socket: { type: 'string' }, 'token-file': { type: 'string' } } });
    if (!values.socket || !values['token-file']) usage();
    await runShim(values.socket, values['token-file']);
    return;
  }
  if (command === 'channel') {
    const { values } = parseArgs({ args: rest, options: { socket: { type: 'string' }, 'token-file': { type: 'string' } } });
    if (!values.socket || !values['token-file']) usage();
    await runChannel(values.socket, values['token-file']);
    return;
  }
  if (command === 'repo') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { from: { type: 'string' }, 'state-dir': { type: 'string' } },
    });
    if (positionals[0] !== 'add' || !positionals[1] || !values.from) usage();
    const project = positionals[1]!;
    const stateDir = resolve(values['state-dir'] ?? DEFAULT_STATE_DIR);
    const config = loadConfig(join(stateDir, 'config.json'));
    if (!config.projects.claude.includes(project) && !config.projects.codex.includes(project)) {
      throw new Error(`${project} is not a registered project in ${join(stateDir, 'config.json')}`);
    }
    const wp = workspacePaths(config.workspace);
    const ws = new WorkspaceManager({ reposDir: wp.reposDir, clonesDir: wp.clonesDir, gitConfigPath: wp.gitConfigPath });
    const bare = ws.addRepo(project, values.from);
    // The guard's starting point: everything already in the repo is the
    // maintainer's; anything agents push after this is checked.
    const baselineDir = join(stateDir, 'guard-baseline');
    mkdirSync(baselineDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(baselineDir, `${project}.json`), JSON.stringify(ws.scanGuard(project, {}).seen, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(
      [
        `bare repo: ${bare}`,
        'Agents push branches there; nothing reaches GitHub from it. To review their work in your checkout:',
        `  git remote add bridge ${bare}`,
        '  git fetch bridge',
        '',
      ].join('\n'),
    );
    return;
  }
  if (command === 'liaison') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        'state-dir': { type: 'string' },
        clone: { type: 'string' },
        mode: { type: 'string' },
        'no-mode-flag': { type: 'boolean' },
      },
    });
    if (positionals[0] !== 'claude') usage();
    const code = await runClaudeLiaison({
      stateDir: resolve(values['state-dir'] ?? DEFAULT_STATE_DIR),
      clone: values.clone,
      mode: (values.mode ?? 'default') as LiaisonMode,
      pinModeFlag: !values['no-mode-flag'],
    });
    process.exit(code);
  }
  usage();
}
