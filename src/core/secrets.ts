// Minimal secrets scan (spec 6.4): known key prefixes and private-key blocks.
// Runs on every agent-supplied string before escaping. A hit parks the thread
// with `secret_scan`; the stored copy has the match redacted so the secret
// never lands in the database or the audit log.

interface Rule {
  name: string;
  pattern: RegExp;
}

const RULES: Rule[] = [
  { name: 'private-key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----|$)/g },
  { name: 'aws-access-key', pattern: /\b(AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { name: 'github-token', pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g },
  { name: 'github-pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
  { name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openai-key', pattern: /\bsk-(proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'stripe-key', pattern: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  // The hub's own session tokens (see auth.ts) carry this prefix so a leaked
  // one is caught here too.
  { name: 'bridge-token', pattern: /\bllmb_[A-Za-z0-9_-]{40,}/g },
];

export interface ScanResult {
  hits: string[];
  redacted: string;
}

function matches(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  const hit = pattern.test(text);
  pattern.lastIndex = 0;
  return hit;
}

export function scanSecrets(text: string): ScanResult {
  // Scan the raw string and its NFKC form, so fullwidth look-alike prefixes
  // don't slip past. Redaction applies to the raw form.
  const folded = text.normalize('NFKC');
  const hits: string[] = [];
  let hiddenByNormalisation = false;
  for (const rule of RULES) {
    const raw = matches(rule.pattern, text);
    const nfkc = matches(rule.pattern, folded);
    if (raw || nfkc) hits.push(rule.name);
    if (nfkc && !raw) hiddenByNormalisation = true;
  }
  if (hits.length === 0) return { hits, redacted: text };
  // A secret only visible after NFKC can't be located in the raw string
  // reliably, so the whole string is redacted: fail closed.
  if (hiddenByNormalisation) return { hits, redacted: '[REDACTED:normalised-secret]' };
  let redacted = text;
  for (const rule of RULES) redacted = redacted.replace(rule.pattern, `[REDACTED:${rule.name}]`);
  return { hits, redacted };
}
