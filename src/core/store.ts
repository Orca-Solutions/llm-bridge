// SQLite message store: threads, messages, questions, approval records,
// spend and the audit log (build plan task 2). Uses Node's built-in
// node:sqlite, so there is no native dependency and no install script.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type {
  ApprovalRecord,
  MessageStatus,
  ParkReason,
  Question,
  Ref,
  Side,
  StoredMessage,
  Thread,
  ThreadState,
} from './types.ts';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  project_claude TEXT,
  project_codex TEXT,
  opened_by TEXT NOT NULL,
  opener_name TEXT NOT NULL,
  parent_thread_id TEXT REFERENCES threads(id),
  owner TEXT NOT NULL,
  state TEXT NOT NULL,
  park_reason TEXT,
  turns INTEGER NOT NULL DEFAULT 0,
  hops INTEGER NOT NULL DEFAULT 0,
  close_outcome TEXT,
  close_note TEXT,
  closed_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS participants (
  thread_id TEXT NOT NULL REFERENCES threads(id),
  session_name TEXT NOT NULL,
  PRIMARY KEY (thread_id, session_name)
);

CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  from_agent TEXT NOT NULL,
  from_session TEXT NOT NULL,
  from_name TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  to_session TEXT NOT NULL,
  to_name TEXT NOT NULL,
  principal TEXT NOT NULL,
  via TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  refs TEXT NOT NULL,
  expects_reply INTEGER NOT NULL,
  in_reply_to TEXT,
  hop INTEGER NOT NULL,
  turn INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  provider TEXT,
  status TEXT NOT NULL,
  park_reason TEXT,
  redacted INTEGER NOT NULL DEFAULT 0,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS messages_inbox ON messages (to_name, status, seq);
CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread_id, seq);
CREATE INDEX IF NOT EXISTS messages_time ON messages (created_ms);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  asked_by TEXT NOT NULL,
  question TEXT NOT NULL,
  options TEXT NOT NULL,
  created_at TEXT NOT NULL,
  answered_at TEXT,
  answer_message_id TEXT
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  side TEXT NOT NULL,
  project TEXT,
  action TEXT NOT NULL,
  action_hash TEXT NOT NULL,
  origin_chain TEXT NOT NULL,
  state TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spend (
  side TEXT NOT NULL,
  day TEXT NOT NULL,
  usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (side, day)
);

CREATE TABLE IF NOT EXISTS guard_refs (
  project TEXT NOT NULL,
  ref TEXT NOT NULL,
  sha TEXT NOT NULL,
  PRIMARY KEY (project, ref)
);

CREATE TABLE IF NOT EXISTS guard_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  ref TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  hits TEXT NOT NULL,
  diff TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project, commit_sha)
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  principal TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  code TEXT,
  thread_id TEXT,
  message_id TEXT,
  detail TEXT
);
`;

export interface AuditEntry {
  id: number;
  at: string;
  principal: string;
  actor: string;
  action: string;
  outcome: 'ok' | 'refused' | 'parked' | 'error';
  code: string | null;
  thread_id: string | null;
  message_id: string | null;
  detail: Record<string, unknown> | null;
}

type Row = Record<string, SQLInputValue>;

function toMessage(row: Row): StoredMessage {
  return {
    id: row.id as string,
    thread_id: row.thread_id as string,
    seq: Number(row.seq),
    from_agent: row.from_agent as StoredMessage['from_agent'],
    from_session: row.from_session as StoredMessage['from_session'],
    from_name: row.from_name as string,
    to_agent: row.to_agent as Side,
    to_session: row.to_session as StoredMessage['to_session'],
    to_name: row.to_name as string,
    principal: row.principal as StoredMessage['principal'],
    via: row.via as StoredMessage['via'],
    kind: row.kind as StoredMessage['kind'],
    body: row.body as string,
    refs: JSON.parse(row.refs as string) as Ref[],
    expects_reply: Number(row.expects_reply) === 1,
    in_reply_to: (row.in_reply_to as string | null) ?? null,
    hop: Number(row.hop),
    turn: Number(row.turn),
    created_at: row.created_at as string,
    provider: row.provider ? (JSON.parse(row.provider as string) as Record<string, unknown>) : null,
    status: row.status as MessageStatus,
    park_reason: (row.park_reason as ParkReason | null) ?? null,
    redacted: Number(row.redacted) === 1,
    delivered_at: (row.delivered_at as string | null) ?? null,
  };
}

function toThread(row: Row): Thread {
  return {
    id: row.id as string,
    project_claude: (row.project_claude as string | null) ?? null,
    project_codex: (row.project_codex as string | null) ?? null,
    opened_by: row.opened_by as Thread['opened_by'],
    opener_name: row.opener_name as string,
    parent_thread_id: (row.parent_thread_id as string | null) ?? null,
    owner: row.owner as string,
    state: row.state as ThreadState,
    park_reason: (row.park_reason as ParkReason | null) ?? null,
    turns: Number(row.turns),
    hops: Number(row.hops),
    close_outcome: (row.close_outcome as Thread['close_outcome']) ?? null,
    close_note: (row.close_note as string | null) ?? null,
    closed_by: (row.closed_by as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function toQuestion(row: Row): Question {
  return {
    id: row.id as string,
    thread_id: row.thread_id as string,
    asked_by: row.asked_by as string,
    question: row.question as string,
    options: JSON.parse(row.options as string) as string[],
    created_at: row.created_at as string,
    answered_at: (row.answered_at as string | null) ?? null,
    answer_message_id: (row.answer_message_id as string | null) ?? null,
  };
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Run `fn` in one transaction; roll back on any throw. */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- threads ----

  insertThread(t: Thread): void {
    this.db
      .prepare(
        `INSERT INTO threads (id, project_claude, project_codex, opened_by, opener_name, parent_thread_id, owner,
          state, park_reason, turns, hops, close_outcome, close_note, closed_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.id, t.project_claude, t.project_codex, t.opened_by, t.opener_name, t.parent_thread_id, t.owner,
        t.state, t.park_reason, t.turns, t.hops, t.close_outcome, t.close_note, t.closed_by, t.created_at, t.updated_at,
      );
  }

  getThread(id: string): Thread | null {
    const row = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as Row | undefined;
    return row ? toThread(row) : null;
  }

  listThreads(): Thread[] {
    return (this.db.prepare('SELECT * FROM threads ORDER BY created_at DESC, id DESC').all() as Row[]).map(toThread);
  }

  threadsWithState(states: ThreadState[]): Thread[] {
    const marks = states.map(() => '?').join(',');
    return (this.db.prepare(`SELECT * FROM threads WHERE state IN (${marks})`).all(...states) as Row[]).map(toThread);
  }

  updateThread(id: string, fields: Partial<Omit<Thread, 'id'>>, now: string): void {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => (fields as Record<string, SQLInputValue>)[k] ?? null);
    this.db.prepare(`UPDATE threads SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, now, id);
  }

  countThreadsCreatedSince(iso: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM threads WHERE created_at >= ?').get(iso) as Row;
    return Number(row.n);
  }

  countLiveThreads(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM threads WHERE state IN ('open','parked')").get() as Row;
    return Number(row.n);
  }

  addParticipant(threadId: string, sessionName: string): void {
    this.db.prepare('INSERT OR IGNORE INTO participants (thread_id, session_name) VALUES (?, ?)').run(threadId, sessionName);
  }

  isParticipant(threadId: string, sessionName: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM participants WHERE thread_id = ? AND session_name = ?')
      .get(threadId, sessionName);
  }

  participants(threadId: string): string[] {
    return (this.db.prepare('SELECT session_name FROM participants WHERE thread_id = ?').all(threadId) as Row[]).map(
      (r) => r.session_name as string,
    );
  }

  // ---- messages ----

  insertMessage(m: Omit<StoredMessage, 'seq'>, createdMs: number): StoredMessage {
    this.db
      .prepare(
        `INSERT INTO messages (id, thread_id, from_agent, from_session, from_name, to_agent, to_session, to_name,
          principal, via, kind, body, refs, expects_reply, in_reply_to, hop, turn, created_at, created_ms, provider,
          status, park_reason, redacted, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.id, m.thread_id, m.from_agent, m.from_session, m.from_name, m.to_agent, m.to_session, m.to_name,
        m.principal, m.via, m.kind, m.body, JSON.stringify(m.refs), m.expects_reply ? 1 : 0, m.in_reply_to, m.hop,
        m.turn, m.created_at, createdMs, m.provider ? JSON.stringify(m.provider) : null, m.status, m.park_reason,
        m.redacted ? 1 : 0, m.delivered_at,
      );
    return this.getMessage(m.id)!;
  }

  getMessage(id: string): StoredMessage | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
    return row ? toMessage(row) : null;
  }

  threadMessages(threadId: string): StoredMessage[] {
    return (this.db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY seq').all(threadId) as Row[]).map(toMessage);
  }

  queuedFor(sessionName: string, limit: number): StoredMessage[] {
    return (
      this.db
        .prepare("SELECT * FROM messages WHERE to_name = ? AND status = 'queued' ORDER BY seq LIMIT ?")
        .all(sessionName, limit) as Row[]
    ).map(toMessage);
  }

  countQueuedFor(sessionName: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE to_name = ? AND status = 'queued'")
      .get(sessionName) as Row;
    return Number(row.n);
  }

  heldOn(threadId: string): StoredMessage[] {
    return (
      this.db.prepare("SELECT * FROM messages WHERE thread_id = ? AND status = 'held' ORDER BY seq").all(threadId) as Row[]
    ).map(toMessage);
  }

  setMessageStatus(id: string, status: MessageStatus, deliveredAt: string | null = null): void {
    this.db.prepare('UPDATE messages SET status = ?, delivered_at = COALESCE(?, delivered_at) WHERE id = ?').run(
      status,
      deliveredAt,
      id,
    );
  }

  /** Mark undelivered messages on a thread discarded; returns their ids. */
  discardPending(threadId: string): string[] {
    const rows = this.db
      .prepare("SELECT id FROM messages WHERE thread_id = ? AND status IN ('queued','held')")
      .all(threadId) as Row[];
    this.db.prepare("UPDATE messages SET status = 'discarded' WHERE thread_id = ? AND status IN ('queued','held')").run(threadId);
    return rows.map((r) => r.id as string);
  }

  /** Count agent-originated messages since a time, optionally filtered. */
  countAgentMessagesSince(sinceMs: number, filter: { principal?: string; fromSide?: Side; project?: string } = {}): number {
    let sql = "SELECT COUNT(*) AS n FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.created_ms >= ? AND m.principal != 'human'";
    const args: SQLInputValue[] = [sinceMs];
    if (filter.principal) {
      sql += ' AND m.principal = ?';
      args.push(filter.principal);
    }
    if (filter.fromSide && filter.project) {
      sql += filter.fromSide === 'claude' ? ' AND m.from_agent = ? AND t.project_claude = ?' : ' AND m.from_agent = ? AND t.project_codex = ?';
      args.push(filter.fromSide, filter.project);
    }
    const row = this.db.prepare(sql).get(...args) as Row;
    return Number(row.n);
  }

  // ---- questions ----

  insertQuestion(q: Question): void {
    this.db
      .prepare('INSERT INTO questions (id, thread_id, asked_by, question, options, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(q.id, q.thread_id, q.asked_by, q.question, JSON.stringify(q.options), q.created_at);
  }

  getQuestion(id: string): Question | null {
    const row = this.db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as Row | undefined;
    return row ? toQuestion(row) : null;
  }

  questionsOn(threadId: string): Question[] {
    return (this.db.prepare('SELECT * FROM questions WHERE thread_id = ? ORDER BY created_at').all(threadId) as Row[]).map(
      toQuestion,
    );
  }

  openQuestions(): Question[] {
    return (this.db.prepare('SELECT * FROM questions WHERE answered_at IS NULL ORDER BY created_at').all() as Row[]).map(
      toQuestion,
    );
  }

  answerQuestion(id: string, messageId: string, at: string): void {
    this.db.prepare('UPDATE questions SET answered_at = ?, answer_message_id = ? WHERE id = ?').run(at, messageId, id);
  }

  // ---- approvals (read-only to agents; nothing in Phase 1 writes them) ----

  approvalsOn(threadId: string): ApprovalRecord[] {
    return (this.db.prepare('SELECT * FROM approvals WHERE thread_id = ? ORDER BY id').all(threadId) as Row[]).map((r) => ({
      id: r.id as string,
      thread_id: r.thread_id as string,
      side: r.side as Side,
      project: (r.project as string | null) ?? null,
      action: JSON.parse(r.action as string) as unknown,
      action_hash: r.action_hash as string,
      origin_chain: JSON.parse(r.origin_chain as string) as string[],
      state: r.state as ApprovalRecord['state'],
      decided_by: (r.decided_by as 'human' | null) ?? null,
      decided_at: (r.decided_at as string | null) ?? null,
      expires_at: r.expires_at as string,
    }));
  }

  // ---- spend ----

  addSpend(side: Side, day: string, usd: number): number {
    this.db
      .prepare('INSERT INTO spend (side, day, usd) VALUES (?, ?, ?) ON CONFLICT(side, day) DO UPDATE SET usd = usd + excluded.usd')
      .run(side, day, usd);
    return this.spendOn(side, day);
  }

  spendOn(side: Side, day: string): number {
    const row = this.db.prepare('SELECT usd FROM spend WHERE side = ? AND day = ?').get(side, day) as Row | undefined;
    return row ? Number(row.usd) : 0;
  }

  // ---- repo-file guard ----

  guardRefs(project: string): Record<string, string> | null {
    const rows = this.db.prepare('SELECT ref, sha FROM guard_refs WHERE project = ?').all(project) as Row[];
    const known = this.db.prepare("SELECT 1 FROM guard_refs WHERE project = ? AND ref = '#baseline'").get(project);
    if (!known) return null;
    return Object.fromEntries(rows.filter((r) => r.ref !== '#baseline').map((r) => [r.ref as string, r.sha as string]));
  }

  setGuardRefs(project: string, refs: Record<string, string>): void {
    this.db.prepare('DELETE FROM guard_refs WHERE project = ?').run(project);
    const ins = this.db.prepare('INSERT INTO guard_refs (project, ref, sha) VALUES (?, ?, ?)');
    ins.run(project, '#baseline', '-');
    for (const [ref, sha] of Object.entries(refs)) ins.run(project, ref, sha);
  }

  addGuardFlag(f: { project: string; ref: string; commit: string; hits: unknown; diff: string }, at: string): boolean {
    const r = this.db
      .prepare('INSERT OR IGNORE INTO guard_flags (project, ref, commit_sha, hits, diff, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(f.project, f.ref, f.commit, JSON.stringify(f.hits), f.diff, at);
    return Number(r.changes) > 0;
  }

  guardFlags(): { id: number; project: string; ref: string; commit: string; hits: { path: string; rule: string }[]; diff: string; created_at: string }[] {
    return (this.db.prepare('SELECT * FROM guard_flags ORDER BY id DESC').all() as Row[]).map((r) => ({
      id: Number(r.id),
      project: r.project as string,
      ref: r.ref as string,
      commit: r.commit_sha as string,
      hits: JSON.parse(r.hits as string) as { path: string; rule: string }[],
      diff: r.diff as string,
      created_at: r.created_at as string,
    }));
  }

  // ---- audit ----

  audit(e: Omit<AuditEntry, 'id'>): void {
    this.db
      .prepare(
        'INSERT INTO audit (at, principal, actor, action, outcome, code, thread_id, message_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(e.at, e.principal, e.actor, e.action, e.outcome, e.code, e.thread_id, e.message_id, e.detail ? JSON.stringify(e.detail) : null);
  }

  auditEntries(filter: { thread_id?: string; limit?: number } = {}): AuditEntry[] {
    const limit = filter.limit ?? 500;
    const rows = (
      filter.thread_id
        ? this.db.prepare('SELECT * FROM audit WHERE thread_id = ? ORDER BY id DESC LIMIT ?').all(filter.thread_id, limit)
        : this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit)
    ) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      at: r.at as string,
      principal: r.principal as string,
      actor: r.actor as string,
      action: r.action as string,
      outcome: r.outcome as AuditEntry['outcome'],
      code: (r.code as string | null) ?? null,
      thread_id: (r.thread_id as string | null) ?? null,
      message_id: (r.message_id as string | null) ?? null,
      detail: r.detail ? (JSON.parse(r.detail as string) as Record<string, unknown>) : null,
    }));
  }
}
