// Shared types for the hub core. Field names follow the protocol spec
// (docs/protocol-spec.md, section 4).

export const PROTOCOL_VERSION = '0.2';

export type Side = 'claude' | 'codex';
export const SIDES: readonly Side[] = ['claude', 'codex'];

export type Principal = 'human' | 'claude-adapter' | 'codex-adapter' | 'codex-user';
export type SessionRole = 'liaison' | 'project' | 'outside';
export type FromSession = SessionRole | 'console';
export type ToSession = 'liaison' | 'project' | 'outside';

export type Kind = 'ask' | 'task' | 'review' | 'reply' | 'status';
export const KINDS: readonly Kind[] = ['ask', 'task', 'review', 'reply', 'status'];

export type ThreadState = 'open' | 'parked' | 'closed' | 'cancelled';
export type ParkReason =
  | 'hop_limit'
  | 'turn_limit'
  | 'rate_limit'
  | 'spend_limit'
  | 'project_limit'
  | 'route_limit'
  | 'route_not_allowed'
  | 'ask_human'
  | 'kill_switch'
  | 'secret_scan'
  | 'paused';

export type OpenedBy =
  | 'claude:project'
  | 'codex:project'
  | 'claude:liaison'
  | 'codex:liaison'
  | 'codex-user'
  | 'human';

export type MessageStatus = 'queued' | 'delivered' | 'held' | 'discarded';

/** An authenticated caller over the session socket. `name` is the stable
 * session identity (for example `claude-liaison`); tokens rotate under it. */
export interface SessionInfo {
  name: string;
  principal: Exclude<Principal, 'human'>;
  side: Side;
  role: SessionRole;
  project: string | null;
}

export type Ref =
  | { type: 'git'; repo: string; branch?: string; commit?: string; path?: string }
  | { type: 'message'; message_id: string }
  | { type: 'url'; url: string };

export interface StoredMessage {
  id: string;
  thread_id: string;
  seq: number;
  from_agent: Side | 'human';
  from_session: FromSession;
  from_name: string;
  to_agent: Side;
  to_session: ToSession;
  to_name: string;
  principal: Principal;
  via: 'console' | 'channel' | 'mcp' | 'codex-sdk';
  kind: Kind;
  body: string;
  refs: Ref[];
  expects_reply: boolean;
  in_reply_to: string | null;
  hop: number;
  turn: number;
  created_at: string;
  provider: Record<string, unknown> | null;
  status: MessageStatus;
  park_reason: ParkReason | null;
  redacted: boolean;
  delivered_at: string | null;
}

export interface Thread {
  id: string;
  project_claude: string | null;
  project_codex: string | null;
  opened_by: OpenedBy;
  opener_name: string;
  parent_thread_id: string | null;
  owner: string;
  state: ThreadState;
  park_reason: ParkReason | null;
  turns: number;
  hops: number;
  close_outcome: 'done' | 'cancelled' | null;
  close_note: string | null;
  closed_by: string | null;
  created_at: string;
  updated_at: string;
}

/** A reaction (spec 5.6): its own record, never a message. `reaction` is a
 * name from the emoji table, or `none` for a cleared one. One row per
 * sender per message; a new reaction replaces the old. */
export interface Reaction {
  id: string;
  thread_id: string;
  message_id: string;
  from_agent: Side;
  from_session: SessionRole;
  from_name: string;
  principal: Exclude<Principal, 'human'>;
  /** The session that sent the reacted-to message, and the only one the
   * reaction is delivered to. */
  to_name: string;
  reaction: string;
  created_at: string;
  delivered_at: string | null;
}

export interface Question {
  id: string;
  thread_id: string;
  asked_by: string;
  question: string;
  options: string[];
  created_at: string;
  answered_at: string | null;
  answer_message_id: string | null;
}

export interface ApprovalRecord {
  id: string;
  thread_id: string;
  side: Side;
  project: string | null;
  action: unknown;
  action_hash: string;
  origin_chain: string[];
  state: 'pending' | 'approved' | 'denied' | 'expired';
  decided_by: 'human' | null;
  decided_at: string | null;
  expires_at: string;
}

export class BridgeError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
  toJSON(): { error: { code: string; message: string } } {
    return { error: { code: this.code, message: this.message } };
  }
}

/** Error codes and HTTP-equivalent statuses from spec section 11. Messages
 * are fixed strings: an error never echoes an agent-supplied string. */
export const Errors = {
  unauthenticated: () => new BridgeError('unauthenticated', 'missing, wrong or revoked credential', 401),
  forbiddenHost: () => new BridgeError('forbidden_host', 'Host header not allowed', 403),
  forbiddenOrigin: () => new BridgeError('forbidden_origin', 'Origin not allowed', 403),
  csrfFailed: () => new BridgeError('csrf_failed', 'missing or wrong CSRF token', 403),
  fieldNotAllowed: (field: string) => new BridgeError('field_not_allowed', `field is set by the hub: ${field}`, 400),
  unknownField: (field: string) => new BridgeError('unknown_field', `unknown field: ${field}`, 400),
  invalidKind: () => new BridgeError('invalid_kind', 'kind must be one of ask, task, review, reply, status', 400),
  invalidRef: (why: string) => new BridgeError('invalid_ref', `invalid ref: ${why}`, 400),
  invalidInput: (why: string) => new BridgeError('invalid_input', `invalid input: ${why}`, 400),
  bodyTooLarge: () => new BridgeError('body_too_large', 'body exceeds 64 KiB', 400),
  invalidUtf8: () => new BridgeError('invalid_utf8', 'text is not valid UTF-8', 400),
  unknownProject: () => new BridgeError('unknown_project', 'project is not registered for this side', 400),
  routeForbidden: () => new BridgeError('route_forbidden', 'this session cannot send there', 403),
  unknownThread: () => new BridgeError('unknown_thread', 'no such thread', 404),
  notAParticipant: () => new BridgeError('not_a_participant', 'malformed thread id, or not a thread this session takes part in', 404),
  threadClosed: () => new BridgeError('thread_closed', 'thread is closed', 409),
  threadParked: () => new BridgeError('thread_parked', 'thread is parked until the human acts', 409),
  routingDisabled: () => new BridgeError('routing_disabled', 'routing is off', 409),
  limitThreads: () => new BridgeError('limit_threads', 'new-thread or concurrent-thread limit reached', 429),
  protocolVersionUnsupported: () => new BridgeError('protocol_version_unsupported', 'protocol version not supported', 400),
  invalidReaction: () =>
    new BridgeError(
      'invalid_reaction',
      'reaction must be exactly one standard emoji or its name from the hub table, or none; sign-off emoji (check marks, OK, rocket, 100), flags built from tag characters and non-emoji text are refused',
      400,
    ),
  limitReactions: () => new BridgeError('limit_reactions', 'reaction rate limit reached', 429),
  notFound: () => new BridgeError('not_found', 'not found', 404),
} as const;
