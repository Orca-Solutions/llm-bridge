// `llm-bridge liaison claude`: start the Claude liaison in this terminal.
//
// The hub must be running (it issues the channel's token file). This makes a
// fresh sparse clone (or reuses one with --clone), writes the hub-owned
// config folder and settings, and runs Claude Code with the scrubbed
// environment. The maintainer answers the development-channel confirmation
// and every permission prompt here. A run file in <state>/run/ lets the hub's
// supervisor kill the whole session on Stop.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../core/config.ts';
import { checkVersions } from '../core/versions.ts';
import { WorkspaceError, WorkspaceManager, isInside, workspacePaths } from '../workspace/manager.ts';
import { agentEnv } from '../workspace/env.ts';
import { liaisonCommand, prepareConfigDir, type LaunchSpec, type LiaisonMode, type LiaisonPaths } from './claude.ts';

export const BIN = fileURLToPath(new URL('../../bin/llm-bridge.js', import.meta.url));
export const SESSION_NAME = 'claude-liaison';

export interface ClaudeLaunchOptions {
  stateDir: string;
  clone?: string;
  pinModeFlag?: boolean;
  mode?: LiaisonMode;
  claudeBin?: string;
}

export interface PreparedLaunch {
  paths: LiaisonPaths;
  spec: LaunchSpec;
  env: Record<string, string>;
  marker: string;
  runFile: string;
}

export function prepareClaudeLiaison(opts: ClaudeLaunchOptions): PreparedLaunch {
  const stateDir = resolve(opts.stateDir);
  const config = loadConfig(join(stateDir, 'config.json'));
  const project = config.projects.claude[0]!;
  const hubSocket = join(stateDir, 'hub.sock');
  const tokenFile = join(stateDir, 'tokens', `${SESSION_NAME}.token`);
  if (!existsSync(hubSocket) || !existsSync(tokenFile)) {
    throw new Error('the hub is not running, or the Claude side is stopped; start the hub (or resume the side on the console) first');
  }
  const wp = workspacePaths(config.workspace);
  const ws = new WorkspaceManager({ reposDir: wp.reposDir, clonesDir: wp.clonesDir, gitConfigPath: wp.gitConfigPath });
  const bareRepo = ws.barePath(project);
  let clone: string;
  if (opts.clone) {
    clone = resolve(opts.clone);
    if (!isInside(clone, join(wp.clonesDir, 'claude'))) throw new WorkspaceError('--clone must be a Claude-side clone the hub made');
    ws.checkNoCredentials(bareRepo, clone);
    ws.assertClone(clone, bareRepo);
  } else {
    clone = ws.createClone('claude', project);
  }

  const channelArgs = [BIN, 'channel', '--socket', hubSocket, '--token-file', tokenFile];
  const paths: LiaisonPaths = {
    stateDir,
    configDir: wp.claudeConfigDir,
    settingsFile: join(stateDir, `${SESSION_NAME}.settings.json`),
    hubSocket,
    tokenFile,
    clone,
    bareRepo,
    gitConfigPath: wp.gitConfigPath,
    channelCommand: { command: process.execPath, args: channelArgs },
    otlpEndpoint: `http://127.0.0.1:${config.otlp_port}`,
    denyReadExtra: [wp.codexHome],
  };
  prepareConfigDir(paths, opts.mode);
  const spec = liaisonCommand(paths, { pinModeFlag: opts.pinModeFlag, claudeBin: opts.claudeBin, mode: opts.mode });
  const marker = randomBytes(16).toString('hex');
  const env = agentEnv(process.env, { gitConfigPath: wp.gitConfigPath, sessionMarker: marker, extra: spec.envExtra });
  return { paths, spec, env, marker, runFile: join(stateDir, 'run', `${SESSION_NAME}.json`) };
}

/** Run the liaison in this terminal until it exits. Resolves with its exit code. */
export async function runClaudeLiaison(opts: ClaudeLaunchOptions): Promise<number> {
  if (!opts.claudeBin) {
    const versions = checkVersions();
    const claudeProblems = versions.problems.filter((p) => p.startsWith('claude'));
    if (claudeProblems.length > 0) throw new Error(claudeProblems.join('; '));
  }
  const prep = prepareClaudeLiaison(opts);
  process.stderr.write(`Claude liaison clone: ${prep.paths.clone}\n`);
  process.stderr.write(`Its commits reach you through the bare repo: ${prep.paths.bareRepo}\n`);
  const child = spawn(prep.spec.command, prep.spec.args, { cwd: prep.spec.cwd, env: prep.env, stdio: 'inherit' });
  if (child.pid === undefined) throw new Error(`could not start ${prep.spec.command}`);
  mkdirSync(join(prep.paths.stateDir, 'run'), { recursive: true, mode: 0o700 });
  writeFileSync(prep.runFile, JSON.stringify({ name: SESSION_NAME, side: 'claude', pid: child.pid, marker: prep.marker }) + '\n', { mode: 0o600 });
  // Ctrl-C belongs to Claude Code while it runs.
  const ignore = () => undefined;
  process.on('SIGINT', ignore);
  try {
    return await new Promise<number>((res) => child.on('exit', (code, signal) => res(code ?? (signal ? 128 : 1))));
  } finally {
    process.off('SIGINT', ignore);
    rmSync(prep.runFile, { force: true });
  }
}
