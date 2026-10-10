// llm-bridge command line.
//
//   llm-bridge init --claude-project NAME --codex-project NAME --daily-spend-usd N [--state-dir DIR] [--console-port P]
//   llm-bridge hub [--state-dir DIR]
//   llm-bridge mcp --socket PATH --token-file PATH
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { validateConfig } from '../core/config.ts';
import { checkVersions } from '../core/versions.ts';
import { ensureStateDir, startHub } from '../hub/main.ts';
import { runShim } from '../shim/bridge-mcp.ts';

const DEFAULT_STATE_DIR = join(homedir(), '.llm-bridge');

function usage(): never {
  process.stderr.write(
    [
      'usage:',
      '  llm-bridge init --claude-project NAME --codex-project NAME --daily-spend-usd N [--state-dir DIR] [--console-port P]',
      '  llm-bridge hub [--state-dir DIR]',
      '  llm-bridge mcp --socket PATH --token-file PATH',
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
    const { values } = parseArgs({ args: rest, options: { 'state-dir': { type: 'string' } } });
    const versions = checkVersions();
    if (versions.problems.length > 0) {
      for (const p of versions.problems) process.stderr.write(`refusing to start: ${p}\n`);
      process.exit(1);
    }
    process.stdout.write(`claude ${versions.claude}, codex ${versions.codex ?? 'not found'}\n`);
    const running = await startHub({ stateDir: resolve(values['state-dir'] ?? DEFAULT_STATE_DIR) });
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
  usage();
}
