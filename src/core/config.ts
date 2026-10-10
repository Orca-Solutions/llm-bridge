// Hub config (spec 7.1). Owned by the hub, kept in its state directory,
// outside every agent clone and sandbox write root. Read at start and on an
// explicit console reload only; a config that fails validation is refused and
// the previous one stays in force.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Side } from './types.ts';

export const META_VALUE = /^[A-Za-z0-9_.:-]{1,64}$/;

export interface Limits {
  hops: number;
  turns: number;
  global_per_hour: number;
  principal_per_hour: number;
  project_per_hour: number;
  route_per_hour: number;
  threads_per_day: number;
  concurrent_threads: number;
  body_bytes: number;
}

export const DEFAULT_LIMITS: Limits = {
  hops: 8,
  turns: 20,
  global_per_hour: 60,
  principal_per_hour: 40,
  project_per_hour: 30,
  route_per_hour: 20,
  threads_per_day: 20,
  concurrent_threads: 5,
  body_bytes: 64 * 1024,
};

export interface HubConfig {
  owner: string;
  projects: Record<Side, string[]>;
  routes: unknown[];
  routing_enabled: false;
  /** Estimated USD per side per day (D13), set by the maintainer at first run. */
  daily_spend_usd: Record<Side, number>;
  limits: Limits;
  console_port: number;
  /** Where the agents' bare repos and clones live: outside the state
   * directory (agents can't read that) and outside the maintainer's own
   * checkouts. */
  workspace: { repos_dir: string; clones_dir: string };
  /** Loopback port for the OTLP receiver that measures Claude-side spend. */
  otlp_port: number;
}

export class ConfigError extends Error {}

function positiveInt(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new ConfigError(`${name} must be a positive integer`);
  return v;
}

export function validateConfig(raw: unknown): HubConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('config must be an object');
  const c = raw as Record<string, unknown>;
  const allowed = new Set(['owner', 'projects', 'routes', 'routing_enabled', 'daily_spend_usd', 'limits', 'console_port', 'workspace', 'otlp_port']);
  for (const k of Object.keys(c)) if (!allowed.has(k)) throw new ConfigError(`unknown config key: ${k}`);

  const owner = c.owner ?? 'jason';
  if (typeof owner !== 'string' || !META_VALUE.test(owner)) throw new ConfigError('owner must match the meta value pattern');

  const projects = c.projects as Record<string, unknown> | undefined;
  if (!projects || typeof projects !== 'object') throw new ConfigError('projects is required');
  const out: Record<Side, string[]> = { claude: [], codex: [] };
  for (const side of ['claude', 'codex'] as const) {
    const list = projects[side];
    if (!Array.isArray(list)) throw new ConfigError(`projects.${side} must be a list`);
    for (const name of list) {
      if (typeof name !== 'string' || !META_VALUE.test(name)) throw new ConfigError(`bad project name on ${side}`);
    }
    out[side] = list as string[];
  }
  for (const k of Object.keys(projects)) if (k !== 'claude' && k !== 'codex') throw new ConfigError(`unknown side: ${k}`);

  if (c.routing_enabled !== undefined && c.routing_enabled !== false) {
    // Turning routing on is the routing milestone (tasks 13 to 15), behind
    // its own gate. Phase 1 refuses to start with it on.
    throw new ConfigError('routing_enabled must be false in Phase 1');
  }
  // Phase 1 runs with exactly one registered project per side (spec 7.3).
  if (out.claude.length !== 1 || out.codex.length !== 1) {
    throw new ConfigError('Phase 1 needs exactly one registered project per side');
  }
  const routes = c.routes ?? [];
  if (!Array.isArray(routes) || routes.length > 0) throw new ConfigError('routes must be empty while routing is off');

  const spend = c.daily_spend_usd as Record<string, unknown> | undefined;
  if (!spend || typeof spend !== 'object') throw new ConfigError('daily_spend_usd is required (set at first run)');
  const daily: Record<Side, number> = { claude: 0, codex: 0 };
  for (const side of ['claude', 'codex'] as const) {
    const v = spend[side];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new ConfigError(`daily_spend_usd.${side} must be a positive number`);
    daily[side] = v;
  }

  const limitsRaw = (c.limits ?? {}) as Record<string, unknown>;
  if (typeof limitsRaw !== 'object' || Array.isArray(limitsRaw)) throw new ConfigError('limits must be an object');
  const limits: Limits = { ...DEFAULT_LIMITS };
  for (const [k, v] of Object.entries(limitsRaw)) {
    if (!(k in DEFAULT_LIMITS)) throw new ConfigError(`unknown limit: ${k}`);
    (limits as unknown as Record<string, number>)[k] = positiveInt(v, `limits.${k}`);
  }
  if (limits.body_bytes > DEFAULT_LIMITS.body_bytes) throw new ConfigError('limits.body_bytes may not exceed 64 KiB');

  const port = c.console_port ?? 7077;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new ConfigError('console_port must be 1024 to 65535');
  }

  const otlp = c.otlp_port ?? 7078;
  if (typeof otlp !== 'number' || !Number.isInteger(otlp) || otlp < 1024 || otlp > 65535 || otlp === port) {
    throw new ConfigError('otlp_port must be 1024 to 65535 and differ from console_port');
  }

  const wsRaw = (c.workspace ?? {}) as Record<string, unknown>;
  if (typeof wsRaw !== 'object' || Array.isArray(wsRaw)) throw new ConfigError('workspace must be an object');
  for (const k of Object.keys(wsRaw)) if (k !== 'repos_dir' && k !== 'clones_dir') throw new ConfigError(`unknown workspace key: ${k}`);
  const dirOf = (v: unknown, fallback: string, name: string): string => {
    const d = v ?? fallback;
    if (typeof d !== 'string' || !isAbsolute(d)) throw new ConfigError(`workspace.${name} must be an absolute path`);
    return d;
  };
  const workspace = {
    repos_dir: dirOf(wsRaw.repos_dir, join(homedir(), 'bridge', 'repos'), 'repos_dir'),
    clones_dir: dirOf(wsRaw.clones_dir, join(homedir(), 'bridge', 'clones'), 'clones_dir'),
  };

  return { owner, projects: out, routes: [], routing_enabled: false, daily_spend_usd: daily, limits, console_port: port, workspace, otlp_port: otlp };
}

export function loadConfig(path: string): HubConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(`cannot read config: ${(err as Error).message}`);
  }
  return validateConfig(raw);
}
