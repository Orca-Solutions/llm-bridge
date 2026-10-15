// The Codex SDK runs this instead of `codex` (codexPathOverride). It checks
// the command line and environment against the pinned settings and only then
// runs the real binary with the same arguments, stdin and stdout. Anything
// off and it exits 64 without starting Codex; the adapter logs the refusal.
// The TypeScript SDK can't report the settings Codex actually applied, so
// this check on what it was asked to apply is the strongest one available
// until the App Server (Phase 2).
import { spawn } from 'node:child_process';
import { checkCodexArgv } from './codex.ts';

export const GUARD_BIN_VAR = 'LLM_BRIDGE_CODEX_BIN';
export const GUARD_CLONE_VAR = 'LLM_BRIDGE_CODEX_CLONE';
export const GUARD_REFUSED_EXIT = 64;

export function runGuard(argv: string[], env: NodeJS.ProcessEnv): void {
  const real = env[GUARD_BIN_VAR];
  const clone = env[GUARD_CLONE_VAR];
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && k !== GUARD_BIN_VAR && k !== GUARD_CLONE_VAR) childEnv[k] = v;
  const problems = !real || !clone ? ['the guard was started without its expectations'] : checkCodexArgv(argv, childEnv, { clone, codexHome: childEnv.CODEX_HOME ?? '' });
  if (!real || !clone || !childEnv.CODEX_HOME) problems.push('CODEX_HOME is not set');
  if (problems.length > 0) {
    process.stderr.write(`llm-bridge codex guard refused this run: ${problems.join('; ')}\n`);
    process.exit(GUARD_REFUSED_EXIT);
  }
  // Start Codex in its clone, not wherever the hub happens to run.
  const child = spawn(real!, argv, { cwd: clone!, env: childEnv, stdio: 'inherit' });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => child.kill(sig));
  child.on('error', (err) => {
    process.stderr.write(`llm-bridge codex guard: ${err.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
}
