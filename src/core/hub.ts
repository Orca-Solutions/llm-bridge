// The hub core: the five bridge tools, the router, the guards and the human
// actions (build plan tasks 2, 5 and 6; spec sections 4, 5, 7.3 and 10).
//
// Transport-free. The session socket (src/hub/socket.ts) and the console
// (src/console/server.ts) call into this class; neither makes trust
// decisions of its own.
import { EventEmitter } from 'node:events';
import { assertWellFormed, escapeForModel } from './escape.ts';
import { scanSecrets } from './secrets.ts';
import { renderDelivery, renderReaction, type Delivery, type ReactionDelivery } from './delivery.ts';
import { ID_PATTERNS, newMessageId, newQuestionId, newReactionId, newThreadId } from './ids.ts';
import { emojiFor, lookupReaction, REACTION_NONE } from './reactions.ts';
import type { HubConfig } from './config.ts';
import type { Store } from './store.ts';
import type { TokenRegistry } from './auth.ts';
import {
  BridgeError,
  Errors,
  KINDS,
  type Kind,
  type OpenedBy,
  type ParkReason,
  type Principal,
  type Reaction,
  type Ref,
  type SessionInfo,
  type Side,
  type StoredMessage,
  type Thread,
  type ToSession,
} from './types.ts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
export const CHECK_INBOX_MAX_WAIT_S = 45;
export const CHECK_INBOX_MAX_MESSAGES = 20;
/** At most this many pending reactions ride along with one delivery. */
export const REACTIONS_PER_DELIVERY = 20;

/** Fields the hub stamps. A sender that supplies any of them is refused. */
const HUB_FIELDS = new Set([
  'protocol_version',
  'id',
  'from',
  'projects',
  'provenance',
  'hop',
  'turn',
  'created_at',
  'provider',
  'owner',
  'to_session',
  'opened_by',
  'parent_thread_id',
]);
const SEND_FIELDS = new Set([
  'to',
  'thread_id',
  'kind',
  'body',
  'refs',
  'expects_reply',
  'in_reply_to',
  'project_session',
  'bind_project',
]);

export type BridgeTool = 'send_message' | 'check_inbox' | 'get_thread' | 'ask_human' | 'close_thread' | 'react';
export const BRIDGE_TOOLS: readonly BridgeTool[] = ['send_message', 'check_inbox', 'get_thread', 'ask_human', 'close_thread', 'react'];

interface Actor {
  /** A Principal, or `hub` for the hub's own actions, or `unauthenticated`. */
  principal: Principal | 'hub' | 'unauthenticated';
  name: string;
}

const HUMAN: Actor = { principal: 'human', name: 'console' };
const HUB: Actor = { principal: 'hub', name: 'hub' };

/** The fixed session set for Phase 1: one liaison per side plus the
 * maintainer's own Codex client (spec 9.1). */
export function phase1Sessions(config: HubConfig): SessionInfo[] {
  return [
    { name: 'claude-liaison', principal: 'claude-adapter', side: 'claude', role: 'liaison', project: config.projects.claude[0]! },
    { name: 'codex-liaison', principal: 'codex-adapter', side: 'codex', role: 'liaison', project: config.projects.codex[0]! },
    { name: 'codex-user', principal: 'codex-user', side: 'codex', role: 'outside', project: null },
  ];
}

function liaisonName(side: Side): string {
  return `${side}-liaison`;
}


function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function checkText(v: unknown, name: string, maxBytes: number): string {
  if (typeof v !== 'string') throw Errors.invalidInput(`${name} must be a string`);
  try {
    assertWellFormed(v);
  } catch {
    throw Errors.invalidUtf8();
  }
  if (Buffer.byteLength(v, 'utf8') > maxBytes) {
    throw name === 'body' ? Errors.bodyTooLarge() : Errors.invalidInput(`${name} is too long`);
  }
  return v;
}

export interface HubOptions {
  store: Store;
  tokens: TokenRegistry;
  config: HubConfig;
  now?: () => number;
}

export interface SendResult {
  message_id: string;
  thread_id: string;
  state: 'queued' | 'parked';
  park_reason: ParkReason | null;
}

type PushFn = (delivery: Delivery) => Promise<boolean>;

export class Hub extends EventEmitter {
  readonly store: Store;
  readonly tokens: TokenRegistry;
  config: HubConfig;
  private readonly now: () => number;
  private readonly push = new Map<string, PushFn>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly sessionsByName = new Map<string, SessionInfo>();

  constructor(opts: HubOptions) {
    super();
    this.store = opts.store;
    this.tokens = opts.tokens;
    this.config = opts.config;
    this.now = opts.now ?? Date.now;
    for (const s of phase1Sessions(this.config)) this.sessionsByName.set(s.name, s);
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString();
  }

  private day(ms = this.now()): string {
    return new Date(ms).toISOString().slice(0, 10);
  }

  session(name: string): SessionInfo | undefined {
    return this.sessionsByName.get(name);
  }

  /** Issue (or re-issue) a session's token file. Returns its path. */
  issueToken(name: string): string {
    const s = this.sessionsByName.get(name);
    if (!s) throw new Error(`unknown session ${name}`);
    const path = this.tokens.issue(s);
    this.audit(HUB, 'token.issue', 'ok', null, null, null, { session: name });
    return path;
  }

  // ------------------------------------------------------------------ audit

  audit(
    actor: Actor,
    action: string,
    outcome: 'ok' | 'refused' | 'parked' | 'error',
    code: string | null,
    threadId: string | null,
    messageId: string | null,
    detail: Record<string, unknown> | null = null,
  ): void {
    this.store.audit({
      at: this.iso(),
      principal: actor.principal,
      actor: actor.name,
      action,
      outcome,
      code,
      thread_id: threadId,
      message_id: messageId,
      detail,
    });
  }

  // ---------------------------------------------------- session entry point

  /** Authenticate a presented token. Unknown or revoked tokens get null. */
  authenticate(token: unknown): SessionInfo | null {
    return this.tokens.authenticate(token);
  }

  /** Every bridge tool call goes through here. The token is re-checked on
   * every call, so a revoked session's next call gets 401 (P15). */
  async call(token: string, method: unknown, params: unknown): Promise<unknown> {
    const session = this.tokens.authenticate(token);
    if (!session) {
      this.audit({ principal: 'unauthenticated', name: 'unknown' }, 'call', 'refused', 'unauthenticated', null, null);
      throw Errors.unauthenticated();
    }
    const actor: Actor = { principal: session.principal, name: session.name };
    if (typeof method !== 'string' || !(BRIDGE_TOOLS as readonly string[]).includes(method)) {
      // Adapter tokens can call only the bridge tools; anything else is 401.
      this.audit(actor, 'call.unknown', 'refused', 'unauthenticated', null, null);
      throw Errors.unauthenticated();
    }
    try {
      switch (method as BridgeTool) {
        case 'send_message':
          return this.sendMessage(session, params);
        case 'check_inbox':
          return await this.checkInbox(session, token, params);
        case 'get_thread':
          return this.getThread(session, params);
        case 'ask_human':
          return this.askHuman(session, params);
        case 'close_thread':
          return this.closeThread(session, params);
        case 'react':
          return this.react(session, params);
      }
    } catch (err) {
      if (err instanceof BridgeError) {
        this.audit(actor, method, 'refused', err.code, threadIdOf(params), null, { reason: err.message });
        throw err;
      }
      this.audit(actor, method, 'error', 'internal', threadIdOf(params), null);
      throw err;
    }
  }

  // ------------------------------------------------------------ send_message

  private validateRefs(raw: unknown): Ref[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw Errors.invalidRef('refs must be a list');
    if (raw.length > 32) throw Errors.invalidRef('at most 32 refs');
    const known = new Set([...this.config.projects.claude, ...this.config.projects.codex]);
    return raw.map((r): Ref => {
      if (!isPlainObject(r)) throw Errors.invalidRef('each ref must be an object');
      const str = (k: string, required: boolean): string | undefined => {
        const v = r[k];
        if (v === undefined && !required) return undefined;
        if (typeof v !== 'string' || v.length === 0 || v.length > 1024) throw Errors.invalidRef(`${k} must be a short string`);
        try {
          assertWellFormed(v);
        } catch {
          throw Errors.invalidUtf8();
        }
        return v;
      };
      const only = (keys: string[]) => {
        for (const k of Object.keys(r)) if (!keys.includes(k)) throw Errors.invalidRef(`unexpected field on ${String(r.type)} ref`);
      };
      switch (r.type) {
        case 'git': {
          only(['type', 'repo', 'branch', 'commit', 'path']);
          const repo = str('repo', true)!;
          if (!known.has(repo)) throw Errors.invalidRef('repo must be a registered project');
          const path = str('path', false);
          if (path !== undefined && (path.startsWith('/') || path.split(/[\\/]/).includes('..'))) {
            throw Errors.invalidRef('path must be relative to the repo root, without ..');
          }
          const ref: Ref = { type: 'git', repo };
          const branch = str('branch', false);
          const commit = str('commit', false);
          if (branch !== undefined) ref.branch = branch;
          if (commit !== undefined) ref.commit = commit;
          if (path !== undefined) ref.path = path;
          return ref;
        }
        case 'message': {
          only(['type', 'message_id']);
          const id = str('message_id', true)!;
          if (!ID_PATTERNS.message.test(id)) throw Errors.invalidRef('message_id is malformed');
          return { type: 'message', message_id: id };
        }
        case 'url': {
          only(['type', 'url']);
          const url = str('url', true)!;
          let parsed: URL;
          try {
            parsed = new URL(url);
          } catch {
            throw Errors.invalidRef('url is malformed');
          }
          if (parsed.protocol !== 'https:') throw Errors.invalidRef('url must be https');
          return { type: 'url', url };
        }
        default:
          throw Errors.invalidRef('type must be git, message or url');
      }
    });
  }

  private parseSend(params: unknown) {
    if (!isPlainObject(params)) throw Errors.invalidInput('arguments must be an object');
    // P1: any hub field is refused, not corrected. Checked before anything else
    // so the attempt shows in the audit log under its own code.
    for (const k of Object.keys(params)) if (HUB_FIELDS.has(k)) throw Errors.fieldNotAllowed(k);
    if (isPlainObject(params.to)) throw Errors.fieldNotAllowed('to.session');
    for (const k of Object.keys(params)) if (!SEND_FIELDS.has(k)) throw Errors.unknownField(k.slice(0, 64));

    // P14: routing legs are refused while routing is off.
    if (params.project_session !== undefined && params.project_session !== false) throw Errors.routingDisabled();
    if (params.bind_project !== undefined && params.bind_project !== null) throw Errors.routingDisabled();

    // P10
    if (typeof params.kind !== 'string' || !(KINDS as readonly string[]).includes(params.kind)) throw Errors.invalidKind();
    const kind = params.kind as Kind;

    if (params.to !== 'claude' && params.to !== 'codex') throw Errors.routeForbidden();
    const to = params.to as Side;

    // P23: a malformed thread id gets the same answer as one the caller isn't on.
    let threadId: string | null = null;
    if (params.thread_id !== undefined && params.thread_id !== null) {
      if (typeof params.thread_id !== 'string' || !ID_PATTERNS.thread.test(params.thread_id)) throw Errors.notAParticipant();
      threadId = params.thread_id;
    }

    const body = checkText(params.body, 'body', this.config.limits.body_bytes);
    const refs = this.validateRefs(params.refs);

    let inReplyTo: string | null = null;
    if (params.in_reply_to !== undefined && params.in_reply_to !== null) {
      if (typeof params.in_reply_to !== 'string' || !ID_PATTERNS.message.test(params.in_reply_to)) {
        throw Errors.invalidInput('in_reply_to must be a message id');
      }
      inReplyTo = params.in_reply_to;
    }
    if (kind === 'reply' && !inReplyTo) throw Errors.invalidInput('a reply needs in_reply_to');

    let expectsReply = kind !== 'status' && kind !== 'reply';
    if (params.expects_reply !== undefined) {
      if (typeof params.expects_reply !== 'boolean') throw Errors.invalidInput('expects_reply must be a boolean');
      expectsReply = params.expects_reply;
    }
    return { kind, to, threadId, body, refs, inReplyTo, expectsReply };
  }

  /** Who a send is delivered to, per the table in spec 5.1 (routing off). */
  private resolveRecipient(session: SessionInfo, to: Side, thread: Thread | null): { name: string; toSession: ToSession } {
    if (session.role === 'outside') {
      // A codex-user client may send only to the Claude liaison.
      if (to !== 'claude') throw Errors.routeForbidden();
      return { name: liaisonName('claude'), toSession: 'liaison' };
    }
    if (session.role === 'liaison') {
      if (to === session.side) throw Errors.routeForbidden();
      // A reply on a thread a codex-user client opened goes back to that
      // client's inbox (spec 5.1, P24), not to the Codex liaison.
      if (thread && thread.opened_by === 'codex-user' && to === 'codex') {
        return { name: thread.opener_name, toSession: 'outside' };
      }
      return { name: liaisonName(to), toSession: 'liaison' };
    }
    // Project sessions don't exist until routing is on.
    throw Errors.routeForbidden();
  }

  private openedByFor(session: SessionInfo): OpenedBy {
    if (session.role === 'outside') return 'codex-user';
    return `${session.side}:${session.role}` as OpenedBy;
  }

  private newThread(openedBy: OpenedBy, openerName: string): Thread {
    const now = this.iso();
    const thread: Thread = {
      id: newThreadId(),
      // Phase 1 (spec 7.3): both sides stamped at open from the single
      // registered project per side.
      project_claude: this.config.projects.claude[0]!,
      project_codex: this.config.projects.codex[0]!,
      opened_by: openedBy,
      opener_name: openerName,
      parent_thread_id: null,
      owner: this.config.owner,
      state: 'open',
      park_reason: null,
      turns: 0,
      hops: 0,
      close_outcome: null,
      close_note: null,
      closed_by: null,
      created_at: now,
      updated_at: now,
    };
    this.store.insertThread(thread);
    return thread;
  }

  /** Guards for an agent-originated message (spec 10). Returns the park
   * reason that trips first, or null. */
  private tripGuards(session: SessionInfo, thread: Thread, hops: number, turns: number): ParkReason | null {
    const L = this.config.limits;
    if (hops > L.hops) return 'hop_limit';
    if (turns > L.turns) return 'turn_limit';
    const since = this.now() - HOUR_MS;
    if (this.store.countAgentMessagesSince(since) >= L.global_per_hour) return 'rate_limit';
    if (this.store.countAgentMessagesSince(since, { principal: session.principal }) >= L.principal_per_hour) return 'rate_limit';
    if (this.spendTripped(session.side)) return 'spend_limit';
    const project = session.side === 'claude' ? thread.project_claude : thread.project_codex;
    if (project && this.store.countAgentMessagesSince(since, { fromSide: session.side, project }) >= L.project_per_hour) {
      return 'project_limit';
    }
    return null;
  }

  private sendMessage(session: SessionInfo, params: unknown): SendResult {
    const p = this.parseSend(params);
    const actor: Actor = { principal: session.principal, name: session.name };

    return this.store.tx(() => {
      let thread: Thread;
      if (p.threadId) {
        const existing = this.store.getThread(p.threadId);
        if (!existing || !this.store.isParticipant(existing.id, session.name)) throw Errors.notAParticipant();
        thread = existing;
        if (thread.state === 'closed' || thread.state === 'cancelled') throw Errors.threadClosed();
        if (thread.state === 'parked') throw Errors.threadParked();
      } else {
        const L = this.config.limits;
        if (this.store.countThreadsCreatedSince(this.iso(this.now() - DAY_MS)) >= L.threads_per_day) throw Errors.limitThreads();
        if (this.store.countLiveThreads() >= L.concurrent_threads) throw Errors.limitThreads();
        thread = this.newThread(this.openedByFor(session), session.name);
        this.store.addParticipant(thread.id, session.name);
        this.audit(actor, 'thread.open', 'ok', null, thread.id, null, { opened_by: thread.opened_by });
      }

      const recipient = this.resolveRecipient(session, p.to, p.threadId ? thread : null);

      if (p.inReplyTo) {
        const target = this.store.getMessage(p.inReplyTo);
        if (!target || target.thread_id !== thread.id) throw Errors.invalidInput('in_reply_to must be on the same thread');
      }
      for (const r of p.refs) {
        if (r.type === 'message') {
          const target = this.store.getMessage(r.message_id);
          if (!target || target.thread_id !== thread.id) throw Errors.invalidRef('message ref must be on the same thread');
        }
      }

      // Secrets scan on every agent-supplied string, before anything is
      // stored. A hit stores a redacted copy and parks the thread.
      const bodyScan = scanSecrets(p.body);
      const refScanHits = p.refs.flatMap((r) => Object.values(r).flatMap((v) => scanSecrets(String(v)).hits));
      const secretHit = bodyScan.hits.length > 0 || refScanHits.length > 0;
      const refs = refScanHits.length > 0 ? p.refs.map((r) => redactRef(r)) : p.refs;

      const addsHop = p.kind !== 'status';
      const hops = thread.hops + (addsHop ? 1 : 0);
      const turns = thread.turns + 1;
      const park: ParkReason | null = secretHit ? 'secret_scan' : this.tripGuards(session, thread, hops, turns);

      const nowMs = this.now();
      const message = this.store.insertMessage(
        {
          id: newMessageId(),
          thread_id: thread.id,
          from_agent: session.side,
          from_session: session.role,
          from_name: session.name,
          to_agent: p.to,
          to_session: recipient.toSession,
          to_name: recipient.name,
          principal: session.principal,
          via: session.side === 'claude' ? 'channel' : 'mcp',
          kind: p.kind,
          body: bodyScan.redacted,
          refs,
          expects_reply: p.expectsReply,
          in_reply_to: p.inReplyTo,
          hop: hops,
          turn: turns,
          created_at: this.iso(nowMs),
          provider: null,
          status: park ? 'held' : 'queued',
          park_reason: park,
          redacted: secretHit,
          delivered_at: null,
        },
        nowMs,
      );
      this.store.updateThread(thread.id, { hops, turns }, this.iso());
      this.store.addParticipant(thread.id, recipient.name);

      if (park) {
        this.parkThread(thread.id, park, actor);
        if (park === 'spend_limit') this.parkSide(session.side, 'spend_limit', actor);
        this.audit(actor, 'send_message', 'parked', park, thread.id, message.id, { kind: p.kind, to: p.to });
        return { message_id: message.id, thread_id: thread.id, state: 'parked' as const, park_reason: park };
      }
      this.audit(actor, 'send_message', 'ok', null, thread.id, message.id, {
        kind: p.kind,
        to: p.to,
        to_session: recipient.toSession,
        hop: hops,
        turn: turns,
      });
      queueMicrotask(() => this.dispatch(message.id));
      return { message_id: message.id, thread_id: thread.id, state: 'queued' as const, park_reason: null };
    });
  }

  // ------------------------------------------------------------- delivery

  /** Register a push target (the channel plugin's live connection). Queued
   * messages for that session flush immediately. */
  attachPush(sessionName: string, fn: PushFn): void {
    this.push.set(sessionName, fn);
    for (const m of this.store.queuedFor(sessionName, 1000)) queueMicrotask(() => this.dispatch(m.id));
  }

  detachPush(sessionName: string, fn: PushFn): void {
    if (this.push.get(sessionName) === fn) this.push.delete(sessionName);
  }

  private recipientSide(m: StoredMessage): Side {
    return m.to_agent;
  }

  /** Deliver one queued message: push if the recipient has a live push
   * target, else wake any check_inbox waiter. */
  private async dispatch(messageId: string): Promise<void> {
    const m = this.store.getMessage(messageId);
    if (!m || m.status !== 'queued') return;
    const thread = this.store.getThread(m.thread_id);
    if (!thread || thread.state !== 'open') return;
    const pushFn = this.push.get(m.to_name);
    if (pushFn) {
      let delivery: Delivery;
      try {
        delivery = renderDelivery(m, thread, this.recipientSide(m));
        const reactions = this.pendingReactions(m.to_name, this.recipientSide(m));
        if (reactions.length > 0) delivery.reactions = reactions;
      } catch {
        // Fail closed: nothing delivered, logged.
        this.audit(HUB, 'deliver', 'error', 'wrapper_failed', m.thread_id, m.id);
        return;
      }
      let ok = false;
      try {
        ok = await pushFn(delivery);
      } catch {
        ok = false;
      }
      const again = this.store.getMessage(messageId);
      if (ok && again && again.status === 'queued') {
        this.store.setMessageStatus(m.id, 'delivered', this.iso());
        this.audit(HUB, 'deliver', 'ok', null, m.thread_id, m.id, { to: m.to_name, path: 'push' });
        this.markReactionsDelivered(delivery.reactions ?? [], m.to_name, 'push');
      }
      return;
    }
    const ws = this.waiters.get(m.to_name);
    if (ws) for (const w of [...ws]) w();
  }

  // ------------------------------------------------------------ check_inbox

  private async checkInbox(session: SessionInfo, token: string, params: unknown): Promise<unknown> {
    const p = params === undefined ? {} : params;
    if (!isPlainObject(p)) throw Errors.invalidInput('arguments must be an object');
    for (const k of Object.keys(p)) if (k !== 'wait_seconds' && k !== 'max') throw Errors.unknownField(k.slice(0, 64));
    const wait = p.wait_seconds === undefined ? CHECK_INBOX_MAX_WAIT_S : p.wait_seconds;
    const max = p.max === undefined ? CHECK_INBOX_MAX_MESSAGES : p.max;
    if (typeof wait !== 'number' || !Number.isFinite(wait) || wait < 0) throw Errors.invalidInput('wait_seconds must be a number');
    if (typeof max !== 'number' || !Number.isInteger(max) || max < 1) throw Errors.invalidInput('max must be a positive integer');
    const waitMs = Math.min(wait, CHECK_INBOX_MAX_WAIT_S) * 1000;
    const limit = Math.min(max, CHECK_INBOX_MAX_MESSAGES);

    if (this.store.countQueuedFor(session.name) === 0 && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const set = this.waiters.get(session.name) ?? new Set<() => void>();
        this.waiters.set(session.name, set);
        const done = () => {
          clearTimeout(timer);
          set.delete(done);
          resolve();
        };
        const timer = setTimeout(done, waitMs);
        set.add(done);
      });
    }
    // The token may have been revoked while waiting.
    if (!this.tokens.isLive(session, token)) throw Errors.unauthenticated();

    const out: Delivery[] = [];
    for (const m of this.store.queuedFor(session.name, limit)) {
      const thread = this.store.getThread(m.thread_id);
      if (!thread || thread.state !== 'open') continue;
      out.push(renderDelivery(m, thread, session.side));
      this.store.setMessageStatus(m.id, 'delivered', this.iso());
      this.audit({ principal: session.principal, name: session.name }, 'deliver', 'ok', null, m.thread_id, m.id, {
        to: session.name,
        path: 'check_inbox',
      });
    }
    // Pending reactions come with every check_inbox answer; they never end
    // the wait on their own (spec 5.6).
    const reactions = this.pendingReactions(session.name, session.side);
    this.markReactionsDelivered(reactions, session.name, 'check_inbox');
    return {
      ...(reactions.length > 0 ? { reactions: reactions.map((r) => ({ reaction_id: r.reaction_id, thread_id: r.thread_id, text: r.text })) } : {}),
      messages: out.map((d) => ({ message_id: d.message_id, thread_id: d.thread_id, text: d.text })),
      more: this.store.countQueuedFor(session.name) > 0,
    };
  }

  // ------------------------------------------------------------- get_thread

  private participantThread(session: SessionInfo, params: unknown, allowed: string[]): { thread: Thread; p: Record<string, unknown> } {
    if (!isPlainObject(params)) throw Errors.invalidInput('arguments must be an object');
    for (const k of Object.keys(params)) {
      if (HUB_FIELDS.has(k)) throw Errors.fieldNotAllowed(k);
      if (!allowed.includes(k)) throw Errors.unknownField(k.slice(0, 64));
    }
    const id = params.thread_id;
    if (typeof id !== 'string' || !ID_PATTERNS.thread.test(id)) throw Errors.notAParticipant();
    const thread = this.store.getThread(id);
    if (!thread || !this.store.isParticipant(id, session.name)) throw Errors.notAParticipant();
    return { thread, p: params };
  }

  private getThread(session: SessionInfo, params: unknown): unknown {
    const { thread } = this.participantThread(session, params, ['thread_id']);
    const messages = this.store
      .threadMessages(thread.id)
      // Delivered messages, plus the caller's own sends. Held messages to
      // others stay out of view until the human releases them.
      .filter((m) => m.status === 'delivered' || m.from_name === session.name)
      .map((m) => {
        const d = renderDelivery(m, thread, session.side);
        return { message_id: d.message_id, text: d.text };
      });
    // Reactions on the caller's own messages and the caller's own reactions.
    const reactions = this.store
      .reactionsOn(thread.id)
      .filter((r) => r.to_name === session.name || r.from_name === session.name)
      .map((r) => ({ reaction_id: r.id, text: renderReaction(r, thread, session.side).text }));
    const questions = this.store.questionsOn(thread.id).map((q) => ({
      question_id: q.id,
      question: escapeForModel(q.question),
      options: q.options.map((o) => escapeForModel(o)),
      answered: q.answered_at !== null,
    }));
    return {
      thread: {
        id: thread.id,
        projects: { claude: thread.project_claude, codex: thread.project_codex },
        opened_by: thread.opened_by,
        state: thread.state,
        park_reason: thread.park_reason,
        counters: { turns: thread.turns, hops: thread.hops },
        parent_thread_id: thread.parent_thread_id,
        close_outcome: thread.close_outcome,
        close_note: thread.close_note === null ? null : escapeForModel(thread.close_note),
      },
      messages,
      reactions,
      questions,
      // Read-only. No tool writes these (spec 5.3, 8).
      approvals: this.store.approvalsOn(thread.id).map((a) => ({
        id: a.id,
        side: a.side,
        project: a.project,
        action_hash: a.action_hash,
        state: a.state,
        decided_by: a.decided_by,
        decided_at: a.decided_at,
      })),
    };
  }

  // ------------------------------------------------------------------ react

  /** React to a message the caller received (spec 5.6). A reaction is not a
   * message: no turn, no hop, no wake, and it never unparks a thread or
   * resets hops. It goes only to the session that sent the message. */
  private react(session: SessionInfo, params: unknown): unknown {
    if (!isPlainObject(params)) throw Errors.invalidInput('arguments must be an object');
    for (const k of Object.keys(params)) {
      if (HUB_FIELDS.has(k)) throw Errors.fieldNotAllowed(k);
      if (k !== 'message_id' && k !== 'reaction') throw Errors.unknownField(k.slice(0, 64));
    }
    // P25: a malformed id, a message the caller didn't receive, or one on a
    // thread it isn't on all get the same answer.
    const id = params.message_id;
    if (typeof id !== 'string' || !ID_PATTERNS.message.test(id)) throw Errors.notAParticipant();
    const m = this.store.getMessage(id);
    if (!m || m.to_name !== session.name || m.status !== 'delivered' || !this.store.isParticipant(m.thread_id, session.name)) {
      throw Errors.notAParticipant();
    }
    const thread = this.store.getThread(m.thread_id)!;
    if (thread.state === 'closed' || thread.state === 'cancelled') throw Errors.threadClosed();

    const actor: Actor = { principal: session.principal, name: session.name };
    const entry = lookupReaction(params.reaction);
    if (!entry) {
      // Kept for the log as code points only, so the rejected text is inert
      // wherever the log is read. Never delivered to a model.
      this.audit(actor, 'react.rejected', 'refused', 'invalid_reaction', thread.id, m.id, { input: codePoints(params.reaction) });
      throw Errors.invalidReaction();
    }
    if (this.store.countReactionsSince(session.principal, this.iso(this.now() - HOUR_MS)) >= this.config.limits.reactions_per_hour) {
      throw Errors.limitReactions();
    }
    const name = entry === REACTION_NONE ? REACTION_NONE : entry.name;
    return this.store.tx(() => {
      const existing = this.store.getReaction(session.name, m.id);
      if (name === REACTION_NONE && (!existing || existing.reaction === REACTION_NONE)) {
        this.audit(actor, 'react', 'ok', null, thread.id, m.id, { reaction: name });
        return { reaction_id: existing?.id ?? null, state: 'cleared' };
      }
      const r: Reaction = {
        id: newReactionId(),
        thread_id: thread.id,
        message_id: m.id,
        from_agent: session.side,
        from_session: session.role,
        from_name: session.name,
        principal: session.principal,
        to_name: m.from_name,
        reaction: name,
        created_at: this.iso(),
        delivered_at: null,
      };
      this.store.upsertReaction(r);
      this.audit(actor, 'react', 'ok', null, thread.id, m.id, { reaction: name, to: r.to_name });
      return { reaction_id: r.id, state: name === REACTION_NONE ? 'cleared' : 'stored' };
    });
  }

  /** Undelivered reactions for a session, rendered for its side, oldest
   * first and at most REACTIONS_PER_DELIVERY. */
  private pendingReactions(sessionName: string, side: Side): ReactionDelivery[] {
    const out: ReactionDelivery[] = [];
    for (const r of this.store.pendingReactionsFor(sessionName, REACTIONS_PER_DELIVERY)) {
      const thread = this.store.getThread(r.thread_id);
      if (thread) out.push(renderReaction(r, thread, side));
    }
    return out;
  }

  private markReactionsDelivered(reactions: ReactionDelivery[], to: string, path: string): void {
    for (const r of reactions) {
      this.store.markReactionDelivered(r.reaction_id, this.iso());
      this.audit(HUB, 'deliver.reaction', 'ok', null, r.thread_id, null, { reaction_id: r.reaction_id, to, path });
    }
  }

  // -------------------------------------------------------------- ask_human

  private askHuman(session: SessionInfo, params: unknown): unknown {
    const { thread, p } = this.participantThread(session, params, ['thread_id', 'question', 'options']);
    if (thread.state === 'closed' || thread.state === 'cancelled') throw Errors.threadClosed();
    const question = checkText(p.question, 'question', 8 * 1024);
    let options: string[] = [];
    if (p.options !== undefined && p.options !== null) {
      if (!Array.isArray(p.options) || p.options.length > 4) throw Errors.invalidInput('options must be a list of at most 4');
      options = p.options.map((o, i) => checkText(o, `options[${i}]`, 512));
    }
    const scans = [question, ...options].map((s) => scanSecrets(s));
    const secretHit = scans.some((s) => s.hits.length > 0);
    const actor: Actor = { principal: session.principal, name: session.name };
    return this.store.tx(() => {
      const q = {
        id: newQuestionId(),
        thread_id: thread.id,
        asked_by: session.name,
        question: scans[0]!.redacted,
        options: scans.slice(1).map((s) => s.redacted),
        created_at: this.iso(),
        answered_at: null,
        answer_message_id: null,
      };
      this.store.insertQuestion(q);
      const reason: ParkReason = secretHit ? 'secret_scan' : 'ask_human';
      this.parkThread(thread.id, reason, actor);
      this.audit(actor, 'ask_human', 'parked', reason, thread.id, null, { question_id: q.id });
      return { question_id: q.id, thread_id: thread.id, state: 'parked', park_reason: reason };
    });
  }

  // ----------------------------------------------------------- close_thread

  private closeThread(session: SessionInfo, params: unknown): unknown {
    const { thread, p } = this.participantThread(session, params, ['thread_id', 'outcome', 'note']);
    if (thread.state === 'closed' || thread.state === 'cancelled') throw Errors.threadClosed();
    if (p.outcome !== 'done' && p.outcome !== 'cancelled') throw Errors.invalidInput('outcome must be done or cancelled');
    const note = p.note === undefined || p.note === null ? null : scanSecrets(checkText(p.note, 'note', 8 * 1024)).redacted;
    const actor: Actor = { principal: session.principal, name: session.name };
    return this.store.tx(() => {
      const discarded = this.store.discardPending(thread.id);
      this.store.updateThread(
        thread.id,
        {
          state: p.outcome === 'done' ? 'closed' : 'cancelled',
          close_outcome: p.outcome as 'done' | 'cancelled',
          close_note: note,
          closed_by: session.name,
          park_reason: null,
        },
        this.iso(),
      );
      this.audit(actor, 'close_thread', 'ok', null, thread.id, null, { outcome: p.outcome, discarded });
      return { thread_id: thread.id, state: p.outcome === 'done' ? 'closed' : 'cancelled' };
    });
  }

  // ---------------------------------------------------------------- parking

  private parkThread(threadId: string, reason: ParkReason, actor: Actor): void {
    const t = this.store.getThread(threadId);
    if (!t || t.state === 'closed' || t.state === 'cancelled') return;
    // Hold anything still queued on the thread: a parked thread delivers nothing.
    for (const m of this.store.threadMessages(threadId)) {
      if (m.status === 'queued') this.store.setMessageStatus(m.id, 'held');
    }
    if (t.state === 'parked') return; // keep the first reason
    this.store.updateThread(threadId, { state: 'parked', park_reason: reason }, this.iso());
    this.audit(actor, 'thread.park', 'parked', reason, threadId, null);
    this.emit('parked', { thread_id: threadId, reason });
  }

  /** Park every live thread that involves `side`. With routing off every
   * thread spans both sides, so in Phase 1 that is every live thread. */
  private parkSide(_side: Side, reason: ParkReason, actor: Actor): void {
    for (const t of this.store.threadsWithState(['open', 'parked'])) this.parkThread(t.id, reason, actor);
  }

  // ------------------------------------------------------------------ spend

  spendTripped(side: Side): boolean {
    return this.store.spendOn(side, this.day()) >= this.config.daily_spend_usd[side];
  }

  /** Record estimated spend for a side (D13). Called by the usage sources
   * (the OTLP receiver on the Claude side, Codex SDK turn usage). */
  recordSpend(side: Side, usd: number, source: string): void {
    if (!Number.isFinite(usd) || usd < 0) return;
    this.store.tx(() => {
      const total = this.store.addSpend(side, this.day(), usd);
      this.audit(HUB, 'spend.record', 'ok', null, null, null, { side, usd, total, source });
      if (total >= this.config.daily_spend_usd[side]) this.parkSide(side, 'spend_limit', HUB);
    });
  }

  // ---------------------------------------------------------- human actions
  // Only the console calls these, and only after it has checked the human
  // credential, Host, Origin and CSRF token.

  humanMessage(input: { thread_id?: unknown; to?: unknown; kind?: unknown; body?: unknown }): { thread_id: string; message_ids: string[] } {
    const targets: Side[] =
      input.to === 'both' ? ['claude', 'codex'] : input.to === 'claude' || input.to === 'codex' ? [input.to] : [];
    if (targets.length === 0) throw Errors.invalidInput('to must be claude, codex or both');
    const kind = (input.kind ?? 'ask') as Kind;
    if (!(KINDS as readonly string[]).includes(kind) || kind === 'reply') throw Errors.invalidKind();
    const body = checkText(input.body, 'body', this.config.limits.body_bytes);
    if (body.trim().length === 0) throw Errors.invalidInput('body is empty');

    return this.store.tx(() => {
      let thread: Thread;
      if (input.thread_id !== undefined && input.thread_id !== null && input.thread_id !== '') {
        if (typeof input.thread_id !== 'string' || !ID_PATTERNS.thread.test(input.thread_id)) throw Errors.unknownThread();
        const t = this.store.getThread(input.thread_id);
        if (!t) throw Errors.unknownThread();
        if (t.state === 'closed' || t.state === 'cancelled') throw Errors.threadClosed();
        thread = t;
      } else {
        thread = this.newThread('human', 'console');
        this.audit(HUMAN, 'thread.open', 'ok', null, thread.id, null, { opened_by: 'human' });
      }
      const ids: string[] = [];
      let turns = thread.turns;
      for (const side of targets) {
        turns += 1;
        const name = liaisonName(side);
        const nowMs = this.now();
        // A human message resets hops to 0 (spec 10). On a parked thread it is
        // stored and held; the thread stays parked (P18).
        const held = thread.state === 'parked';
        const m = this.store.insertMessage(
          {
            id: newMessageId(),
            thread_id: thread.id,
            from_agent: 'human',
            from_session: 'console',
            from_name: 'console',
            to_agent: side,
            to_session: 'liaison',
            to_name: name,
            principal: 'human',
            via: 'console',
            kind,
            body,
            refs: [],
            expects_reply: kind !== 'status',
            in_reply_to: null,
            hop: 0,
            turn: turns,
            created_at: this.iso(nowMs),
            provider: null,
            status: held ? 'held' : 'queued',
            park_reason: held ? thread.park_reason : null,
            redacted: false,
            delivered_at: null,
          },
          nowMs,
        );
        this.store.addParticipant(thread.id, name);
        ids.push(m.id);
        this.audit(HUMAN, 'human.message', held ? 'parked' : 'ok', held ? 'thread_parked' : null, thread.id, m.id, {
          to: side,
          kind,
        });
        if (!held) queueMicrotask(() => this.dispatch(m.id));
      }
      this.store.updateThread(thread.id, { hops: 0, turns }, this.iso());
      return { thread_id: thread.id, message_ids: ids };
    });
  }

  answerQuestion(questionId: unknown, answer: unknown): { message_id: string } {
    if (typeof questionId !== 'string' || !ID_PATTERNS.question.test(questionId)) throw Errors.notFound();
    const q = this.store.getQuestion(questionId);
    if (!q) throw Errors.notFound();
    if (q.answered_at) throw Errors.invalidInput('already answered');
    const asker = this.sessionsByName.get(q.asked_by);
    if (!asker) throw Errors.notFound();
    const text = checkText(answer, 'answer', 16 * 1024);
    // The answer is a human-provenance message to the asker. It is guidance,
    // never an approval. The thread stays parked until the human unparks it.
    const thread = this.store.getThread(q.thread_id)!;
    if (asker.role === 'outside') throw Errors.invalidInput('answers go to liaisons only in Phase 1');
    const { message_ids } = this.humanMessage({ thread_id: thread.id, to: asker.side, kind: 'ask', body: text });
    this.store.answerQuestion(q.id, message_ids[0]!, this.iso());
    this.audit(HUMAN, 'question.answer', 'ok', null, q.thread_id, message_ids[0]!, { question_id: q.id });
    return { message_id: message_ids[0]! };
  }

  private requireThread(id: unknown): Thread {
    if (typeof id !== 'string' || !ID_PATTERNS.thread.test(id)) throw Errors.unknownThread();
    const t = this.store.getThread(id);
    if (!t) throw Errors.unknownThread();
    return t;
  }

  /** The explicit unpark action. Releases held messages in order. Unparking
   * a hop-limited thread also resets hops: the human re-steered it, as with a
   * human message. Turn, rate and spend counters never reset. */
  unpark(threadId: unknown): { thread_id: string; released: string[] } {
    const t = this.requireThread(threadId);
    if (t.state !== 'parked') throw Errors.invalidInput('thread is not parked');
    return this.store.tx(() => {
      const fields: Partial<Thread> = { state: 'open', park_reason: null };
      if (t.park_reason === 'hop_limit') fields.hops = 0;
      this.store.updateThread(t.id, fields, this.iso());
      const released: string[] = [];
      for (const m of this.store.heldOn(t.id)) {
        this.store.setMessageStatus(m.id, 'queued');
        released.push(m.id);
        queueMicrotask(() => this.dispatch(m.id));
      }
      this.audit(HUMAN, 'thread.unpark', 'ok', null, t.id, null, { previous_reason: t.park_reason, released });
      return { thread_id: t.id, released };
    });
  }

  pause(threadId: unknown): { thread_id: string } {
    const t = this.requireThread(threadId);
    if (t.state === 'closed' || t.state === 'cancelled') throw Errors.threadClosed();
    this.store.tx(() => this.parkThread(t.id, 'paused', HUMAN));
    this.audit(HUMAN, 'thread.pause', 'ok', null, t.id, null);
    return { thread_id: t.id };
  }

  stopThread(threadId: unknown): { thread_id: string; discarded: string[] } {
    const t = this.requireThread(threadId);
    if (t.state === 'closed' || t.state === 'cancelled') throw Errors.threadClosed();
    return this.store.tx(() => {
      const discarded = this.store.discardPending(t.id);
      this.store.updateThread(t.id, { state: 'cancelled', close_outcome: 'cancelled', closed_by: 'console', park_reason: null }, this.iso());
      this.audit(HUMAN, 'thread.stop', 'ok', null, t.id, null, { discarded });
      return { thread_id: t.id, discarded };
    });
  }

  /** Kill switch for one side (build plan task 9, P15): revoke that side's
   * session tokens (the codex-user token is a separate principal and is left
   * alone), park every live thread, and ask the supervisor to kill the
   * side's process groups. */
  stopSide(side: Side): { revoked: string[] } {
    const revoked = this.tokens.revokeSide(side, (s) => s.role === 'outside');
    this.store.tx(() => this.parkSide(side, 'kill_switch', HUMAN));
    this.audit(HUMAN, 'kill_switch', 'ok', null, null, null, { side, revoked });
    this.emit('stop-side', side);
    return { revoked };
  }

  /** Undo a side's kill switch: issue fresh token files for its revoked
   * sessions. Threads parked by the stop stay parked until the maintainer
   * unparks each one. */
  resumeSide(side: Side): { issued: string[] } {
    const issued: string[] = [];
    for (const s of this.sessionsByName.values()) {
      if (s.side !== side || this.tokens.hasToken(s.name)) continue;
      this.tokens.issue(s);
      issued.push(s.name);
    }
    this.audit(HUMAN, 'side.resume', 'ok', null, null, null, { side, issued });
    this.emit('resume-side', side);
    return { issued };
  }

  /** Record repo-file guard hits (build plan task 8) for the console. */
  recordGuardFlags(flags: { project: string; ref: string; commit: string; hits: { path: string; rule: string }[]; diff: string }[]): number {
    let added = 0;
    for (const f of flags) {
      if (!this.store.addGuardFlag(f, this.iso())) continue;
      added++;
      this.audit(HUB, 'guard.flag', 'ok', null, null, null, { project: f.project, ref: f.ref, commit: f.commit, rules: f.hits.map((h) => h.rule) });
    }
    return added;
  }

  stopAll(): { revoked: string[] } {
    const revoked = [...this.stopSide('claude').revoked, ...this.stopSide('codex').revoked];
    return { revoked };
  }

  // ------------------------------------------------------------- console reads

  listThreads(): Thread[] {
    return this.store.listThreads();
  }

  threadDetail(threadId: unknown) {
    const t = this.requireThread(threadId);
    return {
      thread: t,
      participants: this.store.participants(t.id),
      messages: this.store.threadMessages(t.id),
      reactions: this.store.reactionsOn(t.id).map((r) => ({ ...r, emoji: emojiFor(r.reaction) })),
      questions: this.store.questionsOn(t.id),
      approvals: this.store.approvalsOn(t.id),
      audit: this.store.auditEntries({ thread_id: t.id, limit: 200 }),
    };
  }

  guardCounters() {
    const since = this.now() - HOUR_MS;
    return {
      limits: this.config.limits,
      messages_last_hour: this.store.countAgentMessagesSince(since),
      by_principal: Object.fromEntries(
        (['claude-adapter', 'codex-adapter', 'codex-user'] as const).map((p) => [p, this.store.countAgentMessagesSince(since, { principal: p })]),
      ),
      spend_today_usd: { claude: this.store.spendOn('claude', this.day()), codex: this.store.spendOn('codex', this.day()) },
      daily_spend_usd: this.config.daily_spend_usd,
      live_threads: this.store.countLiveThreads(),
    };
  }
}

function threadIdOf(params: unknown): string | null {
  if (isPlainObject(params) && typeof params.thread_id === 'string' && ID_PATTERNS.thread.test(params.thread_id)) {
    return params.thread_id;
  }
  return null;
}

/** A rejected reaction input as `U+XXXX` code points, at most 32 of them. */
function codePoints(v: unknown): string {
  if (typeof v !== 'string') return `(${v === null ? 'null' : typeof v})`;
  const cps = [...v].slice(0, 32).map((c) => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'));
  return cps.join(' ') + ([...v].length > 32 ? ' …' : '');
}

function redactRef(r: Ref): Ref {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) out[k] = k === 'type' ? String(v) : scanSecrets(String(v)).redacted;
  return out as unknown as Ref;
}


