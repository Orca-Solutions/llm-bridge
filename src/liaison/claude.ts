// The Claude liaison launcher (build plan task 10, security review must-fix
// items 1 and 5).
//
// The liaison is an interactive Claude Code session: a development channel
// loads only interactively and asks for confirmation at each start, and Claude
// Code spawns the channel server itself. So the hub generates the session's
// settings, config folder and command line, and the maintainer runs it in a
// terminal (`llm-bridge liaison claude`) and answers the confirmation. The
// launcher writes a pid file so the hub's supervisor can kill the session's
// whole process tree on Stop.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CLAUDE_STANDING_RULE } from '../core/standing-rule.ts';
import { isInside } from '../workspace/manager.ts';

/** The only permission modes the liaison may run in (security review
 * must-fix 1). Never auto, never bypass. */
/** Claude Code's per-server tool-call limit for the bridge, in ms. */
export const BRIDGE_TOOL_TIMEOUT_MS = 120_000;

export const LIAISON_MODES = ['default', 'acceptEdits'] as const;
export type LiaisonMode = (typeof LIAISON_MODES)[number];

function checkMode(mode: string): LiaisonMode {
  if (!(LIAISON_MODES as readonly string[]).includes(mode)) throw new Error(`the liaison runs only in ${LIAISON_MODES.join(' or ')} mode`);
  return mode as LiaisonMode;
}

/** Consequential Bash commands, denied at the one level nothing can override. */
export const BASH_DENY = [
  'git push',
  'git remote add',
  'git remote set-url',
  'git config --global',
  'git config credential',
  'git credential',
  'gh',
  'hub',
  'glab',
  'npm publish',
  'npm login',
  'npm adduser',
  'npm token',
  'yarn publish',
  'yarn npm publish',
  'pnpm publish',
  'bun publish',
  'cargo publish',
  'twine upload',
  'gem push',
  'docker push',
  'docker login',
  'terraform apply',
  'terraform destroy',
  'terraform import',
  'tofu apply',
  'tofu destroy',
  'pulumi up',
  'pulumi destroy',
  'cdk deploy',
  'cdk destroy',
  'serverless deploy',
  'sls deploy',
  'kubectl',
  'helm',
  'aws',
  'gcloud',
  'gsutil',
  'az',
  'doctl',
  'flyctl',
  'fly',
  'vercel',
  'netlify',
  'heroku',
  'ansible-playbook',
  'ansible',
  'ssh',
  'scp',
  'sftp',
  'rsync',
];

/** Files that are instructions or config for an agent or the maintainer's
 * tools: the liaison can't edit them (the repo-file guard flags them too). */
export const EDIT_DENY_PATHS = [
  '.claude/**',
  '**/.claude/**',
  '.mcp.json',
  '**/.mcp.json',
  'CLAUDE.md',
  '**/CLAUDE.md',
  'CLAUDE.local.md',
  '**/CLAUDE.local.md',
  'AGENTS.md',
  '**/AGENTS.md',
  '.envrc',
  '**/.envrc',
  '.codex/**',
  '**/.codex/**',
  '.agents/**',
  '**/.agents/**',
  '.vscode/**',
  '**/.vscode/**',
  '.github/**',
  'Makefile',
  '**/Makefile',
  '.husky/**',
  '.git/hooks/**',
  '.git/config',
];

/** Paths at the clone root that sandboxed Bash may not write. */
export const CLONE_WRITE_DENY = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.claude', '.mcp.json', '.envrc', '.codex', '.agents', '.vscode', '.github', 'Makefile', '.husky', '.git/hooks', '.git/config'];

export interface LiaisonPaths {
  stateDir: string;
  /** Hub-owned CLAUDE_CONFIG_DIR for the liaison. */
  configDir: string;
  settingsFile: string;
  hubSocket: string;
  tokenFile: string;
  clone: string;
  bareRepo: string;
  gitConfigPath: string;
  /** How Claude Code should start the channel server. */
  channelCommand: { command: string; args: string[] };
  otlpEndpoint: string;
  home?: string;
}

function abs(p: string): string {
  return resolve(p);
}

/** Permission rules use //abs for absolute paths and ~/ for home. */
function ruleAbs(p: string): string {
  return '/' + abs(p);
}

export const CREDENTIAL_DIRS = ['~/.ssh', '~/.aws', '~/.kube', '~/.config/gcloud', '~/.azure', '~/.gnupg', '~/.docker', '~/.config/gh', '~/.codex', '~/.claude'];
export const CREDENTIAL_FILES = ['~/.netrc', '~/.npmrc', '~/.pypirc', '~/.git-credentials', '~/.claude.json', '~/.gitconfig'];
export const CREDENTIAL_ENV = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITLAB_TOKEN',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'SSH_AUTH_SOCK',
];

export function otelEnv(endpoint: string): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'none',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${endpoint}/v1/metrics`,
    OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'delta',
    OTEL_METRIC_EXPORT_INTERVAL: '30000',
  };
}

/** The hub-owned settings file the liaison runs under. */
export function liaisonSettings(p: LiaisonPaths, mode: LiaisonMode = 'default'): Record<string, unknown> {
  checkMode(mode);
  // The read denies cover the token files and socket only because they live
  // in the state directory; refuse any layout where they don't.
  for (const [name, path] of [['token file', p.tokenFile], ['hub socket', p.hubSocket], ['settings file', p.settingsFile]] as const) {
    if (!isInside(path, p.stateDir)) throw new Error(`the ${name} must be inside the hub state directory`);
  }
  for (const [name, path] of [['clone', p.clone], ['bare repo', p.bareRepo], ['git config', p.gitConfigPath], ['config folder', p.configDir]] as const) {
    if (isInside(path, p.stateDir)) throw new Error(`the ${name} must be outside the hub state directory`);
  }
  // The config folder itself stays readable (Claude Code's shell snapshots
  // live there and sandboxed Bash sources them); its login files don't.
  const configSecrets = ['.credentials.json', '.claude.json'].map((f) => join(abs(p.configDir), f));
  const readDeny = [abs(p.stateDir), ...configSecrets, ...CREDENTIAL_DIRS, ...CREDENTIAL_FILES];
  return {
    permissions: {
      defaultMode: mode,
      disableBypassPermissionsMode: 'disable',
      deny: [
        ...BASH_DENY.flatMap((c) => [`Bash(${c})`, `Bash(${c} *)`]),
        // The security review's own patterns, kept verbatim alongside the
        // per-command pairs above.
        'Bash(git push*)',
        'Bash(npm publish*)',
        'Bash(curl*|*sh)',
        'Bash(wget*|*sh)',
        'Bash(curl * | sh)',
        'Bash(curl * | bash)',
        'Bash(curl * | zsh)',
        'Bash(wget * | sh)',
        'Bash(wget * | bash)',
        ...EDIT_DENY_PATHS.map((x) => `Edit(${x})`),
        `Read(${ruleAbs(p.stateDir)}/**)`,
        ...CREDENTIAL_DIRS.map((d) => `Read(${d}/**)`),
        ...CREDENTIAL_FILES.map((f) => `Read(${f})`),
        ...configSecrets.map((f) => `Read(${ruleAbs(f)})`),
        `Edit(${ruleAbs(p.stateDir)}/**)`,
        `Edit(${ruleAbs(p.configDir)}/**)`,
        `Edit(${ruleAbs(p.gitConfigPath)})`,
        `Edit(${ruleAbs(p.settingsFile)})`,
        // Cross-session messaging stays off in every bridge session.
        'SendMessage',
        'ListAgents',
        // Claude Code's built-in screen control, should it ever be switched on.
        'mcp__computer-use',
      ],
      allow: ['mcp__bridge__check_inbox', 'mcp__bridge__get_thread', 'mcp__bridge__ask_human', 'mcp__bridge__close_thread'],
    },
    disableAutoMode: 'disable',
    crossSessionInbound: 'refuse',
    isolatePeerMachines: true,
    disableAllHooks: true,
    enableAllProjectMcpServers: false,
    // Nothing from the maintainer's claude.ai account reaches the liaison:
    // no connectors (they write to outside services) and no synced skills.
    disableClaudeAiConnectors: true,
    syncClaudeAiSkills: false,
    // Claude Code ships a built-in "computer-use" server (screen, mouse and
    // keyboard). It is off unless switched on in /mcp; this keeps it from
    // loading at all.
    deniedMcpServers: [{ serverName: 'computer-use' }],
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      filesystem: {
        denyRead: readDeny,
        // Pushes go to the local bare repo, never its hooks or config.
        allowWrite: [abs(p.bareRepo)],
        denyWrite: [
          join(abs(p.bareRepo), 'hooks'),
          join(abs(p.bareRepo), 'config'),
          abs(p.configDir),
          abs(p.stateDir),
          abs(p.gitConfigPath),
          abs(p.settingsFile),
          // Sandboxed Bash can write the clone, so the instruction files at
          // its root are closed to it too, not only to the Edit tool. Deeper
          // copies are the repo-file guard's job.
          ...CLONE_WRITE_DENY.map((f) => join(abs(p.clone), f)),
        ],
      },
      network: {
        allowedDomains: [],
        strictAllowlist: true,
        // No Unix sockets at all from sandboxed Bash: the channel process,
        // which runs outside the sandbox, carries every hub call. This is
        // stricter than listing the hub's socket and holds on Linux too.
        allowUnixSockets: [],
        allowAllUnixSockets: false,
      },
      credentials: {
        files: [...CREDENTIAL_DIRS, ...CREDENTIAL_FILES].map((path) => ({ path, mode: 'deny' })),
        envVars: CREDENTIAL_ENV.map((name) => ({ name, mode: 'deny' })),
      },
    },
    env: { ...otelEnv(p.otlpEndpoint), MCP_PROTOCOL_NEGOTIATION: 'legacy', CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
  };
}

function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

/** Write the hub-owned config folder: settings (also as the folder's user
 * settings, so the file alone pins the mode), the standing rule as its
 * CLAUDE.md, and the channel registration plus pre-accepted trust for the
 * clone in its .claude.json. Never touches the maintainer's own ~/.claude*. */
export function prepareConfigDir(p: LiaisonPaths, mode: LiaisonMode = 'default'): void {
  const home = resolve(p.home ?? homedir());
  const dir = abs(p.configDir);
  if (dir === join(home, '.claude') || dir === home) throw new Error('the liaison config folder must not be the maintainer’s own');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const settings = liaisonSettings(p, mode);
  writeJson(p.settingsFile, settings);
  writeJson(join(dir, 'settings.json'), settings);
  writeFileSync(join(dir, 'CLAUDE.md'), `# Bridge liaison standing rule\n\n${CLAUDE_STANDING_RULE}\n`, { mode: 0o600 });

  // Merge into .claude.json: Claude Code keeps its own state there (login,
  // onboarding), so only the bridge's keys are set.
  const stateFile = join(dir, '.claude.json');
  let state: Record<string, unknown> = {};
  if (existsSync(stateFile)) {
    try {
      state = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
    } catch {
      state = {};
    }
  }
  // Only the bridge channel server; nothing else is registered here. Its
  // timeout covers check_inbox's longest wait (45 s) with room to spare.
  state.mcpServers = { bridge: { type: 'stdio', command: p.channelCommand.command, args: p.channelCommand.args, env: {}, timeout: BRIDGE_TOOL_TIMEOUT_MS } };
  const projects = (state.projects && typeof state.projects === 'object' ? state.projects : {}) as Record<string, Record<string, unknown>>;
  // Safe only because the clone is sparse (P21): no .claude/, no .mcp.json.
  projects[abs(p.clone)] = { ...(projects[abs(p.clone)] ?? {}), hasTrustDialogAccepted: true, enabledMcpjsonServers: [], disabledMcpjsonServers: [] };
  state.projects = projects;
  writeJson(stateFile, state);
}

export interface LaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  envExtra: Record<string, string>;
}

/** The command line for the liaison. `pinModeFlag: false` leaves out
 * --permission-mode, for the gate test that proves the settings file alone
 * pins the mode. */
export function liaisonCommand(p: LiaisonPaths, opts: { pinModeFlag?: boolean; claudeBin?: string; mode?: LiaisonMode } = {}): LaunchSpec {
  const mode = checkMode(opts.mode ?? 'default');
  const args = ['--dangerously-load-development-channels', 'server:bridge'];
  if (opts.pinModeFlag !== false) args.push('--permission-mode', mode);
  args.push('--settings', abs(p.settingsFile), '--append-system-prompt', CLAUDE_STANDING_RULE);
  return {
    command: opts.claudeBin ?? 'claude',
    args,
    cwd: abs(p.clone),
    envExtra: {
      CLAUDE_CONFIG_DIR: abs(p.configDir),
      MCP_PROTOCOL_NEGOTIATION: 'legacy',
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      ...otelEnv(p.otlpEndpoint),
    },
  };
}
