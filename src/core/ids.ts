// ULIDs (https://github.com/ulid/spec): 48-bit time + 80 bits of randomness,
// Crockford base32. Monotonic within one process so ids sort by creation order.
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(time: number): string {
  let out = '';
  let t = time;
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function freshRandom(): number[] {
  const bytes = randomBytes(16);
  const digits: number[] = [];
  for (let i = 0; i < 16; i++) digits.push(bytes[i]! % 32);
  return digits;
}

function increment(digits: number[]): number[] {
  const next = digits.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]! < 31) {
      next[i] = next[i]! + 1;
      return next;
    }
    next[i] = 0;
  }
  throw new Error('ULID random component overflow');
}

export function ulid(now: number = Date.now()): string {
  if (now <= lastTime) {
    lastRandom = increment(lastRandom);
  } else {
    lastTime = now;
    lastRandom = freshRandom();
  }
  return encodeTime(lastTime) + lastRandom.map((d) => ALPHABET[d]).join('');
}

export const ID_PATTERNS = {
  message: /^msg_[0-9A-HJKMNP-TV-Z]{26}$/,
  thread: /^thr_[0-9A-HJKMNP-TV-Z]{26}$/,
  approval: /^apr_[0-9A-HJKMNP-TV-Z]{26}$/,
  question: /^qst_[0-9A-HJKMNP-TV-Z]{26}$/,
  reaction: /^rx_[0-9A-HJKMNP-TV-Z]{26}$/,
} as const;

export const newMessageId = (): string => `msg_${ulid()}`;
export const newThreadId = (): string => `thr_${ulid()}`;
export const newApprovalId = (): string => `apr_${ulid()}`;
export const newQuestionId = (): string => `qst_${ulid()}`;
export const newReactionId = (): string => `rx_${ulid()}`;
