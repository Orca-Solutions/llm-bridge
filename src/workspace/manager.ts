// Workspace manager (build plan task 8). Agents work in their own clones of a
// local bare repo, which is their only remote. The maintainer fetches from
// the bare repo, reviews, and pushes to GitHub; agents never can, because no
// credential reaches their environment.
//
// Layout (outside the hub's state directory, which agents can't read):
//   <repos_dir>/<project>.git           bare, denyNonFastForwards, denyDeletes
//   <clones_dir>/<side>/<project>-<id>  sparse clone, origin = the bare repo
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { ulid } from '../core/ids.ts';
import type { Side } from '../core/types.ts';

/** Paths left out of every agent clone (P21), so no session loads
 * repo-controlled settings, hooks or MCP servers. Patterns match at any depth. */
export const SPARSE_EXCLUDES = ['.claude/', '.mcp.json', '.codex/', '.agents/', '.envrc', '.vscode/'];

/** The repo-file guard's list: instruction, config, CI, infrastructure and
 * deploy files. A commit touching any of them is flagged on the console with
 * its diff before the maintainer fetches. */
export const GUARDED_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'claude-settings', re: /(^|\/)\.claude\// },
  { name: 'claude-md', re: /(^|\/)CLAUDE(\.local)?\.md$/ },
  { name: 'agents-md', re: /(^|\/)AGENTS(\.override)?\.md$/ },
  { name: 'mcp-json', re: /(^|\/)\.mcp\.json$/ },
  { name: 'codex', re: /(^|\/)\.codex\// },
  { name: 'agents-dir', re: /(^|\/)\.agents\// },
  { name: 'envrc', re: /(^|\/)\.envrc$/ },
  { name: 'vscode', re: /(^|\/)\.vscode\// },
  { name: 'package-json', re: /(^|\/)package\.json$/ },
  { name: 'makefile', re: /(^|\/)(GNU)?[Mm]akefile$|\.mk$/ },
  { name: 'git-hooks-config', re: /(^|\/)\.(husky|githooks)\/|(^|\/)\.pre-commit-config\.ya?ml$|(^|\/)lefthook\.ya?ml$/ },
  { name: 'github-workflows', re: /(^|\/)\.github\/(workflows|actions)\// },
  { name: 'gitlab-ci', re: /(^|\/)\.gitlab-ci\.ya?ml$/ },
  { name: 'jenkins', re: /(^|\/)Jenkinsfile$/ },
  { name: 'circleci', re: /(^|\/)\.circleci\// },
  { name: 'other-ci', re: /(^|\/)(\.travis\.ya?ml|azure-pipelines\.ya?ml|bitbucket-pipelines\.ya?ml|\.buildkite\/.*|\.drone\.ya?ml)$/ },
  { name: 'dockerfile', re: /(^|\/)(Dockerfile|Containerfile)(\.[^/]*)?$|\.dockerfile$|(^|\/)(docker-)?compose(\.[^/]*)?\.ya?ml$/ },
  { name: 'terraform', re: /\.(tf|tfvars|tf\.json|hcl)$|(^|\/)\.terraform\.lock\.hcl$/ },
  { name: 'pulumi', re: /(^|\/)Pulumi(\.[^/]*)?\.ya?ml$/ },
  { name: 'cloudformation', re: /(^|\/)(cloudformation|cfn)\/|\.(template|cfn)\.(json|ya?ml)$|(^|\/)template\.ya?ml$/ },
  { name: 'cdk', re: /(^|\/)cdk(\.context)?\.json$/ },
  { name: 'helm', re: /(^|\/)(Chart\.ya?ml|values([.-][^/]*)?\.ya?ml)$|(^|\/)charts\// },
  { name: 'kubernetes', re: /(^|\/)(k8s|kubernetes|manifests|kustomize)\/|(^|\/)kustomization\.ya?ml$/ },
  { name: 'ansible', re: /(^|\/)(ansible|playbooks|roles)\/|(^|\/)(playbook|site)\.ya?ml$|(^|\/)ansible\.cfg$/ },
  { name: 'deploy-scripts', re: /(^|\/)(deploy|release|publish)[^/]*\.(sh|bash|zsh|ps1|py|js|ts|mjs|rb)$|(^|\/)(deploy|release)\// },
  { name: 'serverless', re: /(^|\/)(serverless|netlify|vercel|fly|app|render)\.(ya?ml|toml|json)$|(^|\/)Procfile$/ },
];

export function guardedHits(paths: string[]): { path: string; rule: string }[] {
  const hits: { path: string; rule: string }[] = [];
  for (const p of paths) {
    const rule = GUARDED_PATTERNS.find((g) => g.re.test(p));
    if (rule) hits.push({ path: p, rule: rule.name });
  }
  return hits;
}

/** Credential and state files that must not be in or near an agent clone. */
const FORBIDDEN_FILE = [
  /\.tfstate(\.backup)?$/,
  /(^|\/)terraform\.tfstate\.d\//,
  /(^|\/)kubeconfig[^/]*$/,
  /(^|\/)\.kube\//,
  /(^|\/)\.env(\.[^/]*)?$/,
  /(^|\/)\.aws\//,
  /(^|\/)\.config\/gcloud\//,
  /(^|\/)\.ssh\//,
  /(^|\/)\.netrc$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.pypirc$/,
  /(^|\/)\.docker\/config\.json$/,
];
const ALLOWED_TEMPLATE = /\.(example|sample|template|dist)$/;

/** A filled-in tfvars is a *.tfvars that isn't an example; the guard flags
 * them too, but at clone time they block the session. */
const FILLED_TFVARS = /\.tfvars(\.json)?$/;

export function forbiddenFiles(paths: string[]): string[] {
  return paths.filter((p) => !ALLOWED_TEMPLATE.test(p) && (FORBIDDEN_FILE.some((re) => re.test(p)) || FILLED_TFVARS.test(p)));
}

export class WorkspaceError extends Error {}

export interface WorkspaceOptions {
  reposDir: string;
  clonesDir: string;
  /** A bridge-only gitconfig used as GIT_CONFIG_GLOBAL for agents. */
  gitConfigPath: string;
  home?: string;
}

function git(args: string[], cwd?: string, env: NodeJS.ProcessEnv = gitEnv()): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** The environment for git commands the hub runs on agents' behalf: no user
 * config, no credential helpers, no prompts. */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
  };
}

export const BRIDGE_GITCONFIG = `# Bridge-only git config for agent sessions (written by the hub).
[credential]
\thelper =
[core]
\taskPass =
[user]
\tname = LLM-Bridge agent
\temail = agent@llm-bridge.invalid
[protocol]
\tallow = never
[protocol "file"]
\tallow = always
[init]
\tdefaultBranch = main
`;

export class WorkspaceManager {
  readonly reposDir: string;
  readonly clonesDir: string;
  readonly gitConfigPath: string;
  private readonly home: string;

  constructor(opts: WorkspaceOptions) {
    this.reposDir = resolve(opts.reposDir);
    this.clonesDir = resolve(opts.clonesDir);
    this.gitConfigPath = resolve(opts.gitConfigPath);
    this.home = resolve(opts.home ?? homedir());
    mkdirSync(this.reposDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.clonesDir, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(this.gitConfigPath), { recursive: true, mode: 0o700 });
    writeFileSync(this.gitConfigPath, BRIDGE_GITCONFIG, { mode: 0o600 });
  }

  barePath(project: string): string {
    return join(this.reposDir, `${project}.git`);
  }

  /** Create the bare repo for a project from the maintainer's checkout. */
  addRepo(project: string, sourcePath: string): string {
    const bare = this.barePath(project);
    if (existsSync(bare)) throw new WorkspaceError(`${bare} already exists`);
    git(['clone', '--bare', '--no-local', '--no-hardlinks', resolve(sourcePath), bare]);
    // The bare repo must not point back at the maintainer's checkout.
    try {
      git(['remote', 'remove', 'origin'], bare);
    } catch {
      /* no remote */
    }
    git(['config', 'receive.denyNonFastForwards', 'true'], bare);
    git(['config', 'receive.denyDeletes', 'true'], bare);
    git(['config', 'receive.denyCurrentBranch', 'refuse'], bare);
    git(['config', 'core.hooksPath', '/dev/null'], bare);
    return bare;
  }

  /** The guarded-file and credential checks over every file in a tree. */
  private treeFiles(gitDir: string, ref = 'HEAD'): string[] {
    const out = git(['ls-tree', '-r', '--name-only', '-z', ref], gitDir);
    return out.split('\0').filter(Boolean);
  }

  /** Refuse to start a session when credential or state files are in the
   * repo or in the clone's parent directories (up to, not including, $HOME;
   * the sandbox's read denies cover $HOME's own credential folders). */
  checkNoCredentials(bare: string, clonePath: string): void {
    const found = forbiddenFiles(this.treeFiles(bare));
    let dir = dirname(clonePath);
    while (dir.startsWith(this.home + sep) && dir !== this.home) {
      for (const name of safeReaddir(dir)) {
        if (forbiddenFiles([name, `${name}/`]).length > 0) found.push(join(dir, name));
      }
      dir = dirname(dir);
    }
    if (found.length > 0) throw new WorkspaceError(`credential or state files near the clone: ${found.join(', ')}`);
  }

  /** A fresh sparse clone for one side and project. */
  createClone(side: Side, project: string): string {
    const bare = this.barePath(project);
    if (!existsSync(bare)) throw new WorkspaceError(`no bare repo for ${project}; run \`llm-bridge repo add\``);
    const clone = join(this.clonesDir, side, `${project}-${ulid().toLowerCase()}`);
    mkdirSync(dirname(clone), { recursive: true, mode: 0o700 });
    this.checkNoCredentials(bare, clone);
    git(['clone', '--quiet', '--no-local', '--no-hardlinks', '--no-checkout', bare, clone]);
    git(['config', 'credential.helper', ''], clone);
    git(['config', 'core.hooksPath', '.git/hooks'], clone);
    git(['sparse-checkout', 'set', '--no-cone', '/*', ...SPARSE_EXCLUDES.map((p) => `!${p}`)], clone);
    const head = git(['symbolic-ref', '--short', 'HEAD'], bare);
    git(['checkout', '--quiet', head], clone);
    this.assertClone(clone, bare);
    return clone;
  }

  /** Invariants every clone must keep: a real .git directory (never a
   * worktree), the bare repo as its only remote, no credential helper, and
   * none of the sparse-excluded paths on disk (P21). */
  assertClone(clone: string, bare: string): void {
    const dotgit = join(clone, '.git');
    if (!lstatSync(dotgit).isDirectory()) throw new WorkspaceError('clone .git is not a directory (a worktree?)');
    const remotes = git(['remote', '-v'], clone).split('\n').filter(Boolean);
    for (const line of remotes) {
      const url = line.split(/\s+/)[1]!;
      if (resolve(url) !== resolve(bare)) throw new WorkspaceError(`clone has a remote other than the bare repo: ${url}`);
    }
    const helpers = gitOrEmpty(['config', '--get-all', 'credential.helper'], clone).split('\n').filter(Boolean);
    if (helpers.length > 0) throw new WorkspaceError('clone has a credential helper');
    const present = findExcluded(clone);
    if (present.length > 0) throw new WorkspaceError(`sparse-excluded paths present: ${present.join(', ')}`);
  }

  /** Repo-file guard: list commits on agent branches in the bare repo that
   * touch guarded files, with their diffs, since `since` (ref -> sha). */
  scanGuard(project: string, since: Record<string, string>): GuardReport {
    const bare = this.barePath(project);
    const refs = git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'], bare)
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [ref, sha] = l.split(' ');
        return { ref: ref!, sha: sha! };
      });
    const flags: GuardFlag[] = [];
    const seen: Record<string, string> = {};
    for (const { ref, sha } of refs) {
      seen[ref] = sha;
      const old = since[ref];
      if (old === sha) continue;
      const range = old ? [`${old}..${sha}`] : [sha, ...Object.values(since).map((s) => `^${s}`)];
      const commits = git(['rev-list', ...range], bare).split('\n').filter(Boolean);
      for (const commit of commits) {
        const files = git(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', commit], bare).split('\0').filter(Boolean);
        const hits = guardedHits(files);
        if (hits.length === 0) continue;
        const diff = git(['show', '--format=%H%n%an <%ae>%n%s%n', commit, '--', ...hits.map((h) => h.path)], bare);
        flags.push({ project, ref, commit, hits, diff });
      }
    }
    return { flags, seen };
  }
}

export interface GuardFlag {
  project: string;
  ref: string;
  commit: string;
  hits: { path: string; rule: string }[];
  diff: string;
}

export interface GuardReport {
  flags: GuardFlag[];
  seen: Record<string, string>;
}

function gitOrEmpty(args: string[], cwd: string): string {
  try {
    return git(args, cwd);
  } catch {
    return '';
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function findExcluded(root: string): string[] {
  const names = new Set(SPARSE_EXCLUDES.map((p) => p.replace(/\/$/, '')));
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 12) return;
    for (const name of safeReaddir(dir)) {
      if (name === '.git') continue;
      const full = join(dir, name);
      if (names.has(name)) found.push(full);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

export function isInside(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p + sep);
}

