// Test fixtures: a hub in a throwaway state directory with the Phase 1
// sessions' tokens issued. Tokens are read back from their 0600 files the
// same way the shim and the channel plugin read them.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.ts';
import { TokenRegistry } from '../src/core/auth.ts';
import { Hub } from '../src/core/hub.ts';
import { validateConfig, type HubConfig } from '../src/core/config.ts';

export interface Fixture {
  dir: string;
  hub: Hub;
  store: Store;
  tokens: Record<'claude' | 'codex' | 'user', string>;
  tokenFiles: Record<'claude' | 'codex' | 'user', string>;
  clock: { now: number };
  cleanup: () => void;
}

export function baseConfig(overrides: Record<string, unknown> = {}): HubConfig {
  return validateConfig({
    owner: 'jason',
    projects: { claude: ['app-web'], codex: ['infra-ops'] },
    daily_spend_usd: { claude: 5, codex: 5 },
    console_port: 7077,
    ...overrides,
  });
}

export function makeHub(overrides: Record<string, unknown> = {}): Fixture {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'llmb-test-')));
  const store = new Store(join(dir, 'bridge.db'));
  const tokens = new TokenRegistry(dir);
  const clock = { now: Date.parse('2026-10-10T12:00:00Z') };
  const hub = new Hub({ store, tokens, config: baseConfig(overrides), now: () => clock.now });
  const tokenFiles = {
    claude: hub.issueToken('claude-liaison'),
    codex: hub.issueToken('codex-liaison'),
    user: hub.issueToken('codex-user'),
  };
  const read = (p: string) => readFileSync(p, 'utf8').trim();
  return {
    dir,
    hub,
    store,
    tokens: { claude: read(tokenFiles.claude), codex: read(tokenFiles.codex), user: read(tokenFiles.user) },
    tokenFiles,
    clock,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Call a bridge tool and return either the result or the error code. */
export async function attempt(f: Fixture, token: string, method: string, params: unknown): Promise<{ ok: true; result: any } | { ok: false; code: string }> {
  try {
    return { ok: true, result: await f.hub.call(token, method, params) };
  } catch (err) {
    return { ok: false, code: (err as { code: string }).code };
  }
}

export async function errorCode(f: Fixture, token: string, method: string, params: unknown): Promise<string> {
  const r = await attempt(f, token, method, params);
  if (r.ok) throw new Error(`expected ${method} to fail, got ${JSON.stringify(r.result)}`);
  return r.code;
}

export const flush = () => new Promise<void>((r) => setImmediate(r));
