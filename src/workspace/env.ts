// The scrubbed environment every agent process starts with (build plan task
// 8, security review must-fix 2). An allowlist: anything not named here is
// dropped, so no SSH_AUTH_SOCK, no tokens, no credential helpers, no cloud
// profiles reach an agent.

/** Variables passed through from the maintainer's environment, if set. */
export const PASS_THROUGH = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'TMPDIR', 'TZ'] as const;

export interface AgentEnvOptions {
  /** The bridge-only gitconfig (credential.helper empty). */
  gitConfigPath: string;
  /** Marks every process descended from this session, for the kill switch. */
  sessionMarker: string;
  /** Hub-set variables for this agent (CLAUDE_CONFIG_DIR, OTel, ...). */
  extra?: Record<string, string>;
}

/** Names that must never reach an agent, whatever `extra` says. */
const NEVER = /^(SSH_AUTH_SOCK|SSH_AGENT_PID|GIT_ASKPASS|SSH_ASKPASS|GH_TOKEN|GITHUB_TOKEN|GITLAB_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN|AWS_.*|AZURE_.*|GOOGLE_APPLICATION_CREDENTIALS|CLOUDSDK_.*|KUBECONFIG|DOCKER_.*|ANTHROPIC_API_KEY|OPENAI_API_KEY|CODEX_API_KEY|LLMB_.*TOKEN.*)$/;

export const SESSION_MARKER_VAR = 'LLM_BRIDGE_SESSION';

export function agentEnv(source: NodeJS.ProcessEnv, opts: AgentEnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASS_THROUGH) {
    const v = source[name];
    if (typeof v === 'string') env[name] = v;
  }
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: opts.gitConfigPath,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    [SESSION_MARKER_VAR]: opts.sessionMarker,
  });
  for (const [k, v] of Object.entries(opts.extra ?? {})) env[k] = v;
  for (const k of Object.keys(env)) {
    if (NEVER.test(k)) throw new Error(`refusing to pass ${k} to an agent`);
  }
  return env;
}
