// Session credentials (build plan task 4, spec 9.1).
//
// One 256-bit token per session, bound to its side, role and project. Tokens
// are handed over only as 0600 files in the hub's state directory, never by
// environment variable or command-line argument. The hub keeps only a SHA-256
// of each live token, in memory; restarting the hub or a session issues a new
// token.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionInfo, Side } from './types.ts';

export const TOKEN_PREFIX = 'llmb_';

function hash(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

interface LiveToken {
  hash: Buffer;
  session: SessionInfo;
}

export class TokenRegistry {
  private readonly tokens = new Map<string, LiveToken>(); // keyed by session name
  private readonly dir: string;

  constructor(stateDir: string) {
    this.dir = join(stateDir, 'tokens');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
  }

  tokenPath(sessionName: string): string {
    if (!/^[a-z0-9-]{1,64}$/.test(sessionName)) throw new Error('bad session name');
    return join(this.dir, `${sessionName}.token`);
  }

  /** Issue a fresh token for a session, replacing any earlier one, and write
   * it to the session's 0600 token file. Returns the file path, not the token. */
  issue(session: SessionInfo): string {
    const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const path = this.tokenPath(session.name);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, token + '\n', { mode: 0o600, flag: 'wx' });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    this.tokens.set(session.name, { hash: hash(token), session });
    return path;
  }

  /** Revoke a session's token: its next call fails with 401. */
  revoke(sessionName: string): void {
    this.tokens.delete(sessionName);
    rmSync(this.tokenPath(sessionName), { force: true });
  }

  revokeSide(side: Side, keep: (s: SessionInfo) => boolean = () => false): string[] {
    const revoked: string[] = [];
    for (const { session } of [...this.tokens.values()]) {
      if (session.side === side && !keep(session)) {
        this.revoke(session.name);
        revoked.push(session.name);
      }
    }
    return revoked;
  }

  /** Constant-time lookup. Returns the session, or null for anything else. */
  authenticate(token: unknown): SessionInfo | null {
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX) || token.length > 128) return null;
    const presented = hash(token);
    let found: SessionInfo | null = null;
    for (const live of this.tokens.values()) {
      if (timingSafeEqual(presented, live.hash)) found = live.session;
    }
    return found;
  }

  /** True while `session` still holds a live token (not revoked since). */
  isLive(session: SessionInfo, presentedToken: string): boolean {
    const live = this.tokens.get(session.name);
    return !!live && timingSafeEqual(hash(presentedToken), live.hash);
  }

  /** True while the session holds any live token. */
  hasToken(sessionName: string): boolean {
    return this.tokens.has(sessionName);
  }

  sessions(): SessionInfo[] {
    return [...this.tokens.values()].map((t) => t.session);
  }
}
