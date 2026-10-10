// The delivery wrapper (spec 6.1, 6.2). Every path to a model (push,
// check_inbox, get_thread) builds its text here, so they can't drift apart
// (P11). Attributes come only from hub-set fields; the agent controls only the
// escaped strings inside.
import { escapeForModel } from './escape.ts';
import { META_VALUE } from './config.ts';
import type { Ref, Side, StoredMessage, Thread } from './types.ts';

/** The fixed meta-key allowlist from spec 6.1, in output order. */
export const META_KEYS = [
  'from_agent',
  'from_session',
  'to_session',
  'provenance',
  'project_claude',
  'project_codex',
  'thread_id',
  'message_id',
  'kind',
  'hop',
  'turn',
  'expects_reply',
  'in_reply_to',
] as const;

export type Meta = Partial<Record<(typeof META_KEYS)[number], string>>;

export interface Delivery {
  message_id: string;
  thread_id: string;
  /** For the channel plugin, which hands meta and content to Claude Code. */
  meta: Meta;
  content: string;
  /** The full wrapped form, exactly as the session sees it. */
  text: string;
}

export class WrapperError extends Error {}

function renderRef(ref: Ref): string {
  const parts: string[] = [`type=${ref.type}`];
  for (const [k, v] of Object.entries(ref)) {
    if (k === 'type') continue;
    parts.push(`${k}=${escapeForModel(String(v))}`);
  }
  return `ref: ${parts.join(' ')}`;
}

/** Projects show as the project name, or the opener class while a side is
 * unbound (routing only; Phase 1 always has both). */
function projectFor(thread: Thread, side: Side): string {
  const p = side === 'claude' ? thread.project_claude : thread.project_codex;
  if (p) return p;
  return thread.opened_by.replace(':', '-');
}

export function buildMeta(m: StoredMessage, thread: Thread): Meta {
  const meta: Meta = {
    from_agent: m.from_agent,
    from_session: m.from_session,
    to_session: m.to_session,
    provenance: m.principal,
    project_claude: projectFor(thread, 'claude'),
    project_codex: projectFor(thread, 'codex'),
    thread_id: m.thread_id,
    message_id: m.id,
    kind: m.kind,
    hop: String(m.hop),
    turn: String(m.turn),
    expects_reply: m.expects_reply ? 'true' : 'false',
  };
  if (m.in_reply_to) meta.in_reply_to = m.in_reply_to;
  for (const [k, v] of Object.entries(meta)) {
    // A value outside the pattern is a hub bug: fail closed.
    if (!(META_KEYS as readonly string[]).includes(k) || !META_VALUE.test(v)) {
      throw new WrapperError(`meta value for ${k} fails the allowlist`);
    }
  }
  return meta;
}

export function buildContent(m: StoredMessage): string {
  const lines = [escapeForModel(m.body)];
  if (m.refs.length > 0) lines.push('', ...m.refs.map(renderRef));
  return lines.join('\n');
}

function attrs(meta: Meta): string {
  return META_KEYS.filter((k) => meta[k] !== undefined)
    .map((k) => `${k}="${meta[k]}"`)
    .join(' ');
}

export function wrap(side: Side, meta: Meta, content: string): string {
  if (side === 'claude') return `<channel source="bridge" ${attrs(meta)}>\n${content}\n</channel>`;
  return `<bridge-message ${attrs(meta)}>\n${content}\n</bridge-message>`;
}

/** The delivered form of a message for a session on `recipientSide`. */
export function renderDelivery(m: StoredMessage, thread: Thread, recipientSide: Side): Delivery {
  const meta = buildMeta(m, thread);
  const content = buildContent(m);
  return { message_id: m.id, thread_id: m.thread_id, meta, content, text: wrap(recipientSide, meta, content) };
}
