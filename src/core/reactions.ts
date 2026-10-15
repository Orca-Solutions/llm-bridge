// The reaction vocabulary (spec 5.6). The table is generated once from
// Unicode's emoji-test.txt by tools/gen-emoji-table.ts and committed; the hub
// only looks things up in it. A reaction is accepted only when the input is
// exactly an entry's emoji, one of its listed alternate forms, or its name.
// No parsing or normalising: anything else is invalid_reaction.
//
// What a model receives is always the table's own ASCII name, never the bytes
// the reacting agent sent.
import { readFileSync } from 'node:fs';
import { META_VALUE } from './config.ts';

interface TableEntry {
  e: string;
  n: string;
  a?: string[];
}

/** Clears the sender's reaction on a message. */
export const REACTION_NONE = 'none';

export interface ReactionEntry {
  /** The delivered name, ASCII `[a-z0-9_]`, at most 64 characters. */
  name: string;
  /** The fully-qualified emoji, for the console. */
  emoji: string;
}

const table = JSON.parse(readFileSync(new URL('./emoji-table.json', import.meta.url), 'utf8')) as { version: string; entries: TableEntry[] };

export const EMOJI_TABLE_VERSION = table.version;

const byKey = new Map<string, ReactionEntry>();
const byName = new Map<string, ReactionEntry>();
for (const t of table.entries) {
  // A table entry outside the pattern is a build bug: refuse to start.
  if (!/^[a-z0-9_]{1,64}$/.test(t.n) || !META_VALUE.test(t.n)) throw new Error(`emoji table name fails the pattern: ${t.n}`);
  const entry: ReactionEntry = { name: t.n, emoji: t.e };
  for (const key of [t.n, t.e, ...(t.a ?? [])]) {
    if (byKey.has(key) || key === REACTION_NONE) throw new Error('emoji table has a duplicate key');
    byKey.set(key, entry);
  }
  byName.set(t.n, entry);
}

export const EMOJI_TABLE_SIZE = byName.size;

/** The entry an input names, `none`, or null when it isn't an exact match. */
export function lookupReaction(input: unknown): ReactionEntry | typeof REACTION_NONE | null {
  if (typeof input !== 'string') return null;
  if (input === REACTION_NONE) return REACTION_NONE;
  return byKey.get(input) ?? null;
}

/** The emoji for a stored name, for the console. */
export function emojiFor(name: string): string | null {
  return byName.get(name)?.emoji ?? null;
}

/** Every entry, for tests. */
export function allReactions(): ReactionEntry[] {
  return [...byName.values()];
}
