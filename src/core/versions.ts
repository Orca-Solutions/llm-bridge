// Version pins (spec section 15). The hub refuses to start below them.
import { execFileSync } from 'node:child_process';

/** Claude Code: channel relay fixes (2.1.234), --permission-prompts none
 * (2.1.259), auto as interactive default (2.1.283), fully bare mode (2.1.286). */
export const CLAUDE_CODE_MIN = '2.1.286';

/** Codex CLI: pinned exactly at Milestone B together with @openai/codex-sdk.
 * Until then the hub only records which version is installed. */
export const CODEX_CLI_PIN: string | null = null;

export function parseVersion(text: string): number[] | null {
  const m = text.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function atLeast(found: number[], min: number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if (found[i]! > min[i]!) return true;
    if (found[i]! < min[i]!) return false;
  }
  return true;
}

export interface VersionReport {
  claude: string | null;
  codex: string | null;
  problems: string[];
}

function run(cmd: string): string | null {
  try {
    return execFileSync(cmd, ['--version'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export function checkVersions(runner: (cmd: string) => string | null = run): VersionReport {
  const problems: string[] = [];
  const claudeOut = runner('claude');
  const claude = claudeOut ? parseVersion(claudeOut) : null;
  if (!claude) problems.push('claude: not found or version unreadable');
  else if (!atLeast(claude, parseVersion(CLAUDE_CODE_MIN)!)) problems.push(`claude: ${claude.join('.')} is below the minimum ${CLAUDE_CODE_MIN}`);
  const codexOut = runner('codex');
  const codex = codexOut ? parseVersion(codexOut) : null;
  if (CODEX_CLI_PIN) {
    if (!codex) problems.push('codex: not found or version unreadable');
    else if (codex.join('.') !== CODEX_CLI_PIN) problems.push(`codex: ${codex.join('.')} is not the pinned ${CODEX_CLI_PIN}`);
  }
  return { claude: claude?.join('.') ?? null, codex: codex?.join('.') ?? null, problems };
}
