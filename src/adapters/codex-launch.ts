// Start the Codex liaison inside the hub (`llm-bridge hub --codex`): its
// clone (reused across restarts), its CODEX_HOME and the adapter. The kill
// switch stops the adapter and kills every process carrying its marker.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hub } from '../core/hub.ts';
import type { HubConfig } from '../core/config.ts';
import type { Supervisor } from '../supervisor/proc.ts';
import { WorkspaceError, WorkspaceManager, isInside, workspacePaths } from '../workspace/manager.ts';
import { CodexAdapter, CODEX_SESSION } from './codex.ts';

const BIN = fileURLToPath(new URL('../../bin/llm-bridge.js', import.meta.url));

interface CloneRecord {
  clone: string;
  base: string;
}

export interface CodexLiaison {
  adapter: CodexAdapter;
  clone: string;
  marker: string;
}

export async function startCodexLiaison(o: {
  hub: Hub;
  config: HubConfig;
  stateDir: string;
  supervisor: Supervisor;
  codexBin?: string;
  log: (line: string) => void;
}): Promise<CodexLiaison> {
  const wp = workspacePaths(o.config.workspace);
  const ws = new WorkspaceManager({ reposDir: wp.reposDir, clonesDir: wp.clonesDir, gitConfigPath: wp.gitConfigPath });
  const project = o.config.projects.codex[0]!;
  const bare = ws.barePath(project);
  if (!existsSync(bare)) throw new WorkspaceError(`no bare repo for ${project}; run \`llm-bridge repo add ${project} --from <path>\``);

  // One clone for the liaison's life, so its long-lived thread keeps its
  // working tree. The base commit is read once, when the hub made the clone.
  const recordFile = join(o.stateDir, `${CODEX_SESSION}.clone.json`);
  let rec: CloneRecord | null = null;
  try {
    const raw = JSON.parse(readFileSync(recordFile, 'utf8')) as CloneRecord;
    if (typeof raw.clone === 'string' && /^[0-9a-f]{40,64}$/.test(raw.base) && isInside(raw.clone, join(wp.clonesDir, 'codex')) && existsSync(raw.clone)) rec = raw;
  } catch {
    rec = null;
  }
  if (!rec) {
    const clone = ws.createClone('codex', project);
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: clone, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: wp.gitConfigPath } }).trim();
    rec = { clone, base };
    writeFileSync(recordFile, JSON.stringify(rec) + '\n', { mode: 0o600 });
  }
  ws.checkNoCredentials(bare, rec.clone);

  const hubSocket = join(o.stateDir, 'hub.sock');
  const tokenFile = join(o.stateDir, 'tokens', `${CODEX_SESSION}.token`);
  const marker = randomBytes(16).toString('hex');
  o.supervisor.trackMarker(CODEX_SESSION, 'codex', marker);
  const adapter = new CodexAdapter({
    hub: o.hub,
    paths: {
      stateDir: o.stateDir,
      codexHome: wp.codexHome,
      clone: rec.clone,
      hubSocket,
      tokenFile,
      shimCommand: { command: process.execPath, args: [BIN, 'mcp', '--socket', hubSocket, '--token-file', tokenFile] },
    },
    gitConfigPath: wp.gitConfigPath,
    bareRepo: bare,
    baseCommit: rec.base,
    indexFile: join(o.stateDir, `${CODEX_SESSION}.index`),
    marker,
    threadFile: join(o.stateDir, `${CODEX_SESSION}.thread`),
    prices: o.config.codex_usd_per_mtok,
    codexBin: o.codexBin,
    log: o.log,
  });
  await adapter.start();
  o.log(`  Codex liaison: clone ${rec.clone}, CODEX_HOME ${wp.codexHome}`);
  return { adapter, clone: rec.clone, marker };
}
