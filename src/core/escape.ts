// The one escaping library for every agent-supplied string (spec 6.3).
//
// Two passes:
// - escapeForModel: what a model sees, on every delivery path (push,
//   check_inbox, get_thread). After it, no tag of any name can appear.
// - visibleForConsole: what the console shows, as text nodes only. Hidden
//   characters become [U+XXXX] codes, without entity noise.
//
// Stored strings stay raw; these run at delivery time.

export class InvalidTextError extends Error {
  readonly code = 'invalid_utf8';
  constructor() {
    super('text is not valid UTF-8');
  }
}

// Step 3: keep a code point only if it is tab, newline, or in general
// category L, M, N, P, S or Zs.
const ALLOWED = /^[\t\n\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]$/u;

// Variation selectors are category Mn, so the category allowlist would keep
// them. The spec lists them among the characters that must become visible,
// so they are named here explicitly.
const VARIATION_SELECTOR = /^[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u{180B}-\u{180D}\u{180F}]$/u;

// Step 5: angle-bracket lookalikes NFKC does not fold. The first block is the
// spec's list; the second adds lookalikes found while building this, which is
// a tightening, not a change of meaning.
const LOOKALIKES = new Set<number>([
  0x00ab, 0x00bb, 0x2039, 0x203a, 0x226a, 0x226b, 0x2329, 0x232a, 0x276e, 0x276f, 0x2770,
  0x2771, 0x27e8, 0x27e9, 0x27ea, 0x27eb, 0x2991, 0x2992, 0x3008, 0x3009, 0x300a, 0x300b,
  // additions: modifier-letter arrowheads, Canadian syllabics PA/PO, medium
  // angle bracket ornaments, curved angle brackets, less/greater-than lookalikes
  0x02c2, 0x02c3, 0x1438, 0x1433, 0x276c, 0x276d, 0x29fc, 0x29fd, 0x2a7d, 0x2a7e, 0x22d6,
  0x22d7, 0x2264, 0x2265, 0x2276, 0x2277, 0x3014, 0x3015, 0x2993, 0x2994, 0x2995, 0x2996,
  0xfe3d, 0xfe3e, 0xfe3f, 0xfe40,
]);

function codeFor(cp: number): string {
  return `[U+${cp.toString(16).toUpperCase().padStart(4, '0')}]`;
}

/** Step 1: refuse anything that is not well-formed Unicode (a JS string with
 * lone surrogates cannot be encoded as UTF-8). Byte-level checks happen where
 * bytes arrive; see decodeUtf8Strict. */
export function assertWellFormed(text: string): void {
  if (typeof text !== 'string' || !text.isWellFormed()) throw new InvalidTextError();
}

/** Decode bytes as UTF-8, failing closed on any invalid sequence. */
export function decodeUtf8Strict(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new InvalidTextError();
  }
}

function keepOrCode(cp: number, ch: string): string {
  if (VARIATION_SELECTOR.test(ch)) return codeFor(cp);
  if (!ALLOWED.test(ch)) return codeFor(cp);
  return ch;
}

/** The model-facing pass: steps 1 to 5 of spec 6.3. */
export function escapeForModel(text: string): string {
  assertWellFormed(text);
  const normalised = text.normalize('NFKC');
  let out = '';
  for (const ch of normalised) {
    const cp = ch.codePointAt(0)!;
    const kept = keepOrCode(cp, ch);
    if (kept !== ch) {
      out += kept;
      continue;
    }
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (LOOKALIKES.has(cp)) out += codeFor(cp);
    else out += ch;
  }
  return out;
}

/** The console's visibility pass: steps 1, 3 and 5 only. The result is meant
 * for text nodes, never HTML, so `<` stays `<` and no entities appear. */
export function visibleForConsole(text: string): string {
  assertWellFormed(text);
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const kept = keepOrCode(cp, ch);
    if (kept !== ch) out += kept;
    else if (LOOKALIKES.has(cp)) out += codeFor(cp);
    else out += ch;
  }
  return out;
}
