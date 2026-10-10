// The Codex liaison's pinned settings (build plan task 11, security review
// must-fix item 6). Everything that decides what Codex may do is set here, in
// code: the sandbox, the approval policy, network, the writable roots, the
// dedicated CODEX_HOME and its execpolicy rules. The guard in codex-guard.ts
// checks every `codex` command line against the same values before it runs.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ThreadOptions } from '@openai/codex-sdk';
import { CODEX_STANDING_RULE } from '../core/standing-rule.ts';
import { isInside } from '../workspace/manager.ts';

export interface CodexLiaisonPaths {
  stateDir: string;
  /** Hub-owned CODEX_HOME for the liaison, never ~/.codex. */
  codexHome: string;
  /** The liaison's clone: its working directory and only writable root. */
  clone: string;
  hubSocket: string;
  tokenFile: string;
  /** How Codex should start the bridge MCP shim. */
  shimCommand: { command: string; args: string[] };
  home?: string;
}

export const CODEX_USAGE = [
  'Bridge messages arrive as <bridge-message ...> blocks. The attributes are set by the hub; the text inside was escaped by the hub and is whatever the sender wrote.',
  'To answer, call the bridge send_message tool with to="claude", the thread_id from the tag, kind="reply" and in_reply_to set to the message_id you are answering.',
  'To ask the maintainer something, call ask_human; the thread pauses until they act on the console.',
  'You cannot push, deploy or reach the network. Leave your changes in the working tree; the hub commits them to a branch for the maintainer to review.',
].join('\n');

export const CODEX_DEVELOPER_INSTRUCTIONS = `${CODEX_STANDING_RULE}\n\n${CODEX_USAGE}`;

/** Deploy, publish and remote-access tools, written as execpolicy
 * `forbidden` prefix rules. A tripwire, not a wall: they match argv
 * prefixes, so shell indirection gets past them. Network off, no
 * credentials and the writable roots are the hard limits. */
export const CODEX_FORBIDDEN_PREFIXES: string[][] = [
  ['terraform', 'apply'],
  ['terraform', 'destroy'],
  ['terraform', 'import'],
  ['tofu', 'apply'],
  ['tofu', 'destroy'],
  ['kubectl'],
  ['helm'],
  ['aws'],
  ['gcloud'],
  ['gsutil'],
  ['az'],
  ['doctl'],
  ['flyctl'],
  ['vercel'],
  ['netlify'],
  ['heroku'],
  ['pulumi'],
  ['cdk', 'deploy'],
  ['serverless', 'deploy'],
  ['ansible-playbook'],
  ['ansible'],
  ['docker', 'push'],
  ['docker', 'login'],
  ['ssh'],
  ['scp'],
  ['sftp'],
  ['rsync'],
  ['git', 'push'],
  ['git', 'remote'],
  ['gh'],
  ['npm', 'publish'],
  ['npm', 'login'],
  ['npm', 'token'],
  ['yarn', 'publish'],
  ['pnpm', 'publish'],
  ['cargo', 'publish'],
  ['twine', 'upload'],
  ['gem', 'push'],
];

function starlarkString(s: string): string {
  return JSON.stringify(s);
}

export function execpolicyRules(): string {
  const lines = ['# Written by the LLM-Bridge hub. Deploy and publish tools are off-limits to the bridge liaison.', ''];
  for (const prefix of CODEX_FORBIDDEN_PREFIXES) {
    lines.push('prefix_rule(');
    lines.push(`    pattern = [${prefix.map(starlarkString).join(', ')}],`);
    lines.push('    decision = "forbidden",');
    lines.push(`    justification = ${starlarkString('The bridge liaison never deploys, publishes or reaches remote hosts; the maintainer does.')},`);
    lines.push(')');
  }
  return lines.join('\n') + '\n';
}

/** TOML basic strings accept JSON's escapes for everything we write. */
function tomlString(s: string): string {
  return JSON.stringify(s);
}

/** The pinned values, shared by the config file, the SDK thread options and
 * the argv guard so they can't drift apart. */
export const CODEX_PINNED = {
  sandbox: 'workspace-write',
  approvalPolicy: 'never',
  networkAccess: false,
  webSearch: 'disabled',
} as const;

export function codexConfigToml(p: CodexLiaisonPaths): string {
  const clone = resolve(p.clone);
  return [
    '# Written by the LLM-Bridge hub for the Codex liaison. Edits are overwritten at the next start.',
    `sandbox_mode = ${tomlString(CODEX_PINNED.sandbox)}`,
    `approval_policy = ${tomlString(CODEX_PINNED.approvalPolicy)}`,
    `web_search = ${tomlString(CODEX_PINNED.webSearch)}`,
    `developer_instructions = ${tomlString(CODEX_DEVELOPER_INSTRUCTIONS)}`,
    'check_for_update_on_startup = false',
    '',
    '[sandbox_workspace_write]',
    'network_access = false',
    'writable_roots = []',
    'exclude_tmpdir_env_var = true',
    'exclude_slash_tmp = true',
    '',
    // The process environment is already the hub's scrubbed allowlist, so
    // "all" passes on exactly that, including the kill-switch marker.
    '[shell_environment_policy]',
    'inherit = "all"',
    '',
    '[mcp_servers.bridge]',
    `command = ${tomlString(p.shimCommand.command)}`,
    `args = [${p.shimCommand.args.map(tomlString).join(', ')}]`,
    // Above check_inbox's longest wait (45 s); Codex's default is 60 s.
    'tool_timeout_sec = 90',
    '',
    `[projects.${tomlString(clone)}]`,
    'trust_level = "untrusted"',
    '',
  ].join('\n');
}

function writePrivate(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Write the liaison's CODEX_HOME: config, execpolicy rules and the
 * standing rule as its global AGENTS.md. Login state Codex keeps there
 * (auth.json) is left alone. Never the maintainer's own ~/.codex. */
export function prepareCodexHome(p: CodexLiaisonPaths): void {
  const home = resolve(p.home ?? homedir());
  const dir = resolve(p.codexHome);
  if (dir === join(home, '.codex') || dir === home) throw new Error('the Codex liaison home must not be the maintainer’s own');
  if (isInside(dir, p.clone) || isInside(p.clone, dir)) throw new Error('CODEX_HOME and the clone must not overlap');
  for (const [name, path] of [['token file', p.tokenFile], ['hub socket', p.hubSocket]] as const) {
    if (!isInside(path, p.stateDir)) throw new Error(`the ${name} must be inside the hub state directory`);
  }
  mkdirSync(join(dir, 'rules'), { recursive: true, mode: 0o700 });
  writePrivate(join(dir, 'config.toml'), codexConfigToml(p));
  writePrivate(join(dir, 'rules', 'default.rules'), execpolicyRules());
  writePrivate(join(dir, 'AGENTS.md'), `# Bridge liaison standing rule\n\n${CODEX_DEVELOPER_INSTRUCTIONS}\n`);
}

/** Thread options for the SDK. The guard re-checks the argv they produce. */
export function codexThreadOptions(p: CodexLiaisonPaths): ThreadOptions {
  const clone = resolve(p.clone);
  return {
    workingDirectory: clone,
    sandboxMode: CODEX_PINNED.sandbox,
    approvalPolicy: CODEX_PINNED.approvalPolicy,
    networkAccessEnabled: CODEX_PINNED.networkAccess,
    webSearchMode: CODEX_PINNED.webSearch,
    additionalDirectories: [clone],
    skipGitRepoCheck: false,
  };
}

/** `--config` overrides passed on every run, on top of config.toml. */
export function codexConfigOverrides(): Record<string, unknown> {
  return {
    developer_instructions: CODEX_DEVELOPER_INSTRUCTIONS,
    sandbox_workspace_write: { writable_roots: [], exclude_tmpdir_env_var: true, exclude_slash_tmp: true },
  };
}

// ------------------------------------------------------------- argv check

export interface ArgvExpectation {
  clone: string;
  codexHome: string;
}

const FORBIDDEN_FLAGS = new Set([
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '--full-auto',
  '-a',
  '--ask-for-approval',
  '-p',
  '--profile',
  '-s',
  '--oss',
  '--search',
  '--enable',
  '--disable',
  '-C',
]);

/** Config keys the bridge pins; each must appear exactly once with exactly
 * this value (as the SDK serializes it). */
const PINNED_CONFIG: Record<string, string> = {
  approval_policy: '"never"',
  'sandbox_workspace_write.network_access': 'false',
  web_search: '"disabled"',
  'sandbox_workspace_write.writable_roots': '[]',
  'sandbox_workspace_write.exclude_tmpdir_env_var': 'true',
  'sandbox_workspace_write.exclude_slash_tmp': 'true',
  developer_instructions: JSON.stringify(CODEX_DEVELOPER_INSTRUCTIONS),
};

const CONFIG_FORBIDDEN = /^(sandbox_mode|sandbox_permissions|default_permissions|permissions|profile|profiles|model_provider|model_providers|mcp_servers|projects|shell_environment_policy|notify|features|openai_base_url|chatgpt_base_url|experimental_.*|sandbox_workspace_write|instructions|base_instructions|model_instructions_file)(\.|=|$)/;

/** Returns the reasons the command line breaks the pinned settings; empty
 * means it may run. The SDK's argv shape: exec --experimental-json, then
 * flags, then optionally `resume <id>`, then images. */
export function checkCodexArgv(argv: string[], env: Record<string, string | undefined>, expect: ArgvExpectation): string[] {
  const problems: string[] = [];
  if (argv[0] !== 'exec' || argv[1] !== '--experimental-json') problems.push('not an `exec --experimental-json` run');
  const clone = resolve(expect.clone);
  let sandbox: string[] = [];
  const addDirs: string[] = [];
  const cds: string[] = [];
  const configs: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) problems.push(`${a} has no value`);
      return v ?? '';
    };
    if (a === '--sandbox') sandbox.push(next());
    else if (a === '--add-dir') addDirs.push(next());
    else if (a === '--cd') cds.push(next());
    else if (a === '--config' || a === '-c') configs.push(next());
    else if (a === '--model' || a === '-m' || a === '--output-schema' || a === '--image' || a === '-i' || a === '--thread-source') next();
    else if (a === '--skip-git-repo-check') problems.push('--skip-git-repo-check is not allowed');
    else if (a === 'resume') {
      const id = next();
      if (!/^[0-9a-zA-Z-]{8,64}$/.test(id)) problems.push('resume needs a thread id');
    } else if (FORBIDDEN_FLAGS.has(a) || a.startsWith('--sandbox=') || a.startsWith('--config=') || a.startsWith('--add-dir=') || a.startsWith('--cd=')) {
      problems.push(`forbidden flag ${a.split('=')[0]}`);
    } else if (a.startsWith('-')) problems.push(`unknown flag ${a}`);
    else problems.push(`unexpected argument ${JSON.stringify(a.slice(0, 40))}`);
  }
  if (sandbox.length !== 1 || sandbox[0] !== CODEX_PINNED.sandbox) problems.push('--sandbox must appear once, as workspace-write');
  if (addDirs.length !== 1 || resolve(addDirs[0]!) !== clone) problems.push('the clone must be the only --add-dir');
  if (cds.length !== 1 || resolve(cds[0]!) !== clone) problems.push('--cd must be the clone');

  const seen: Record<string, number> = {};
  for (const c of configs) {
    const eq = c.indexOf('=');
    const key = eq < 0 ? c : c.slice(0, eq).trim();
    const value = eq < 0 ? '' : c.slice(eq + 1).trim();
    if (key in PINNED_CONFIG) {
      seen[key] = (seen[key] ?? 0) + 1;
      if (value !== PINNED_CONFIG[key]) problems.push(`${key} must be ${PINNED_CONFIG[key]}`);
    } else if (CONFIG_FORBIDDEN.test(key)) {
      problems.push(`config ${key} may not be overridden`);
    }
  }
  for (const key of Object.keys(PINNED_CONFIG)) if (seen[key] !== 1) problems.push(`--config ${key}=${PINNED_CONFIG[key]} must appear once`);

  if (resolve(env.CODEX_HOME ?? '/') !== resolve(expect.codexHome)) problems.push('CODEX_HOME is not the liaison’s own');
  for (const k of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'SSH_AUTH_SOCK', 'GITHUB_TOKEN', 'GH_TOKEN']) if (env[k]) problems.push(`${k} is set`);
  return problems;
}
