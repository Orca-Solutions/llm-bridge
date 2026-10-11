// The console (build plan task 7, spec 9.2): a local page on loopback, the
// only place the human principal acts. Every request, reads included, needs
// the human session cookie; state-changing requests also need a same-origin
// Origin and the session's CSRF token. Agent-written strings go out as JSON
// after the visibility pass and are rendered as text nodes only.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { visibleForConsole } from '../core/escape.ts';
import { BridgeError, Errors, type Ref, type Side, type StoredMessage } from '../core/types.ts';
import type { Hub } from '../core/hub.ts';

const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'static');
const COOKIE = 'llmb_console';
const LOGIN_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY = 128 * 1024;

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
};

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

interface HumanSession {
  csrf: string;
  expires: number;
}

export interface ConsoleOptions {
  port: number;
  /** Called by POST /api/config/reload. Returns the logged diff. */
  reloadConfig?: () => unknown;
  now?: () => number;
}

export class ConsoleServer {
  private server: Server | null = null;
  private readonly loginCodes = new Map<string, number>(); // sha(code) -> expiry
  private readonly sessions = new Map<string, HumanSession>(); // sha(sid) -> session
  private readonly hub: Hub;
  private readonly opts: ConsoleOptions;
  private readonly now: () => number;
  port: number;

  constructor(hub: Hub, opts: ConsoleOptions) {
    this.hub = hub;
    this.opts = opts;
    this.port = opts.port;
    this.now = opts.now ?? Date.now;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async listen(): Promise<void> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch(() => this.sendError(res, new BridgeError('internal', 'internal error', 500)));
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // Loopback only. Binding anything else needs a signed-off decision.
      server.listen(this.opts.port, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (addr && typeof addr === 'object') this.port = addr.port;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** A one-time login link, printed in the hub's own terminal. */
  loginLink(): string {
    const code = randomBytes(32).toString('base64url');
    this.loginCodes.set(sha(code), this.now() + LOGIN_TTL_MS);
    return `${this.origin}/login?code=${code}`;
  }

  // ------------------------------------------------------------- plumbing

  private send(res: ServerResponse, status: number, body: string, type: string, extra: Record<string, string> = {}): void {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, ...extra });
    res.end(body);
  }

  private sendJson(res: ServerResponse, status: number, value: unknown): void {
    this.send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
  }

  private sendError(res: ServerResponse, err: BridgeError): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    this.sendJson(res, err.status, err.toJSON());
  }

  private hostOk(req: IncomingMessage): boolean {
    return req.headers.host === `127.0.0.1:${this.port}`;
  }

  private humanSession(req: IncomingMessage): { key: string; s: HumanSession } | null {
    const cookie = req.headers.cookie ?? '';
    for (const part of cookie.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k !== COOKIE) continue;
      const key = sha(rest.join('='));
      const s = this.sessions.get(key);
      if (s && s.expires > this.now()) return { key, s };
    }
    return null;
  }

  private async readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const type = req.headers['content-type'] ?? '';
    if (!type.toLowerCase().startsWith('application/json')) throw Errors.invalidInput('content-type must be application/json');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw Errors.bodyTooLarge();
      chunks.push(chunk as Buffer);
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } catch {
      throw Errors.invalidUtf8();
    }
    let parsed: unknown;
    try {
      parsed = text.length ? JSON.parse(text) : {};
    } catch {
      throw Errors.invalidInput('body must be JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Errors.invalidInput('body must be a JSON object');
    return parsed as Record<string, unknown>;
  }

  private refuse(req: IncomingMessage, res: ServerResponse, err: BridgeError, action: string): void {
    // Every refused console request is logged. An unauthenticated caller has
    // no principal; whatever credential it carried is never logged.
    this.hub.audit({ principal: 'unauthenticated', name: 'console-client' }, `console.${action}`, 'refused', err.code, null, null, {
      method: req.method,
      path: (req.url ?? '').split('?')[0]!.slice(0, 128),
    });
    this.sendError(res, err);
  }

  // -------------------------------------------------------------- routing

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.origin);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // P7: DNS rebinding and friends. The Host must be the console's own.
    if (!this.hostOk(req)) return this.refuse(req, res, Errors.forbiddenHost(), 'host');

    if (path === '/login' && method === 'GET') return this.login(url, res, req);

    // P5, P6: every other request needs the human session cookie. Bearer
    // tokens and adapter credentials are never accepted here.
    const hs = this.humanSession(req);
    if (!hs) return this.refuse(req, res, Errors.unauthenticated(), 'auth');

    if (method === 'GET') {
      const asset = STATIC_FILES[path];
      if (asset) return this.send(res, 200, readFileSync(join(STATIC_DIR, asset.file), 'utf8'), asset.type);
      if (path.startsWith('/api/')) {
        try {
          return this.sendJson(res, 200, this.read(path, hs.s));
        } catch (err) {
          if (err instanceof BridgeError) return this.sendError(res, err);
          throw err;
        }
      }
      return this.sendError(res, Errors.notFound());
    }

    if (method !== 'POST') return this.sendError(res, new BridgeError('method_not_allowed', 'method not allowed', 405));

    // P8: state changes need a same-origin Origin and the session's CSRF token.
    if (req.headers.origin !== this.origin) return this.refuse(req, res, Errors.forbiddenOrigin(), 'origin');
    const csrf = req.headers['x-csrf-token'];
    if (typeof csrf !== 'string' || !safeEqual(csrf, hs.s.csrf)) return this.refuse(req, res, Errors.csrfFailed(), 'csrf');

    try {
      const body = await this.readJson(req);
      return this.sendJson(res, 200, this.act(path, body));
    } catch (err) {
      if (err instanceof BridgeError) {
        this.hub.audit({ principal: 'human', name: 'console' }, 'console.action', 'refused', err.code, null, null, {
          path: path.slice(0, 128),
        });
        return this.sendError(res, err);
      }
      throw err;
    }
  }

  private login(url: URL, res: ServerResponse, req: IncomingMessage): void {
    const code = url.searchParams.get('code') ?? '';
    const key = sha(code);
    const expiry = this.loginCodes.get(key);
    this.loginCodes.delete(key); // one use, hit or miss
    if (!code || !expiry || expiry < this.now()) return this.refuse(req, res, Errors.unauthenticated(), 'login');
    const sid = randomBytes(32).toString('base64url');
    this.sessions.set(sha(sid), { csrf: randomBytes(32).toString('base64url'), expires: this.now() + SESSION_TTL_MS });
    this.hub.audit({ principal: 'human', name: 'console' }, 'console.login', 'ok', null, null, null);
    this.send(res, 303, '', 'text/plain', {
      'Set-Cookie': `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
      Location: '/',
    });
  }

  // ---------------------------------------------------------------- reads

  private read(path: string, s: HumanSession): unknown {
    if (path === '/api/session') return { csrf: s.csrf, owner: this.hub.config.owner };
    if (path === '/api/threads') {
      return {
        threads: this.hub.listThreads().map((t) => ({ ...t, close_note: t.close_note === null ? null : visibleForConsole(t.close_note) })),
        questions: this.hub.store.openQuestions().map((q) => ({
          ...q,
          question: visibleForConsole(q.question),
          options: q.options.map(visibleForConsole),
        })),
        guards: this.hub.guardCounters(),
        guard_flags: this.hub.store.guardFlags().map((f) => ({
          ...f,
          ref: visibleForConsole(f.ref),
          hits: f.hits.map((h) => ({ rule: h.rule, path: visibleForConsole(h.path) })),
          diff: visibleForConsole(f.diff),
        })),
      };
    }
    const m = path.match(/^\/api\/threads\/([^/]+)$/);
    if (m) {
      const d = this.hub.threadDetail(m[1]);
      return {
        thread: { ...d.thread, close_note: d.thread.close_note === null ? null : visibleForConsole(d.thread.close_note) },
        participants: d.participants,
        messages: d.messages.map(visibleMessage),
        // Every field is hub-set or from the hub's emoji table (spec 5.6).
        reactions: d.reactions,
        questions: d.questions.map((q) => ({ ...q, question: visibleForConsole(q.question), options: q.options.map(visibleForConsole) })),
        approvals: d.approvals,
        // Claude-side actions are approved at the liaison's own terminal; the
        // console has no record or origin chain for them in Phase 1.
        claude_approvals: 'answered in terminal',
        audit: d.audit,
      };
    }
    if (path === '/api/audit') return { audit: this.hub.store.auditEntries({ limit: 300 }) };
    throw Errors.notFound();
  }

  // -------------------------------------------------------------- actions

  private act(path: string, body: Record<string, unknown>): unknown {
    if (path === '/api/messages') return this.hub.humanMessage(body);
    if (path === '/api/stop-all') return this.hub.stopAll();
    if (path === '/api/routes') throw Errors.routingDisabled();
    if (path === '/api/config/reload') {
      if (!this.opts.reloadConfig) throw Errors.notFound();
      return this.opts.reloadConfig();
    }
    let m = path.match(/^\/api\/threads\/([^/]+)\/(unpark|pause|stop)$/);
    if (m) {
      if (m[2] === 'unpark') return this.hub.unpark(m[1]);
      if (m[2] === 'pause') return this.hub.pause(m[1]);
      return this.hub.stopThread(m[1]);
    }
    m = path.match(/^\/api\/sides\/(claude|codex)\/(stop|resume)$/);
    if (m) return m[2] === 'stop' ? this.hub.stopSide(m[1] as Side) : this.hub.resumeSide(m[1] as Side);
    m = path.match(/^\/api\/questions\/([^/]+)\/answer$/);
    if (m) return this.hub.answerQuestion(m[1], body.answer);
    m = path.match(/^\/api\/approvals\/([^/]+)\/decision$/);
    if (m) {
      // No approval records exist in Phase 1 (Codex runs approval_policy=never;
      // Claude-side prompts are answered in the terminal). One record per
      // request when they arrive in Phase 2; there is no batch endpoint.
      throw Errors.notFound();
    }
    throw Errors.notFound();
  }
}

function visibleRef(r: Ref): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) out[k] = visibleForConsole(String(v));
  return out;
}

function visibleMessage(m: StoredMessage) {
  return { ...m, body: visibleForConsole(m.body), refs: m.refs.map(visibleRef) };
}
