// The session socket: a Unix socket in the hub's state directory, the only
// way sessions and outside clients reach the hub (spec 9.1). Newline-delimited
// JSON frames, strict UTF-8, token presented once in a hello frame and
// re-checked by the hub on every call.
//
// Frames, client to hub:
//   {"type":"hello","token":"…","protocol_version":"0.1","push":false}
//   {"type":"call","id":1,"method":"send_message","params":{…}}
//   {"type":"ack","message_id":"msg_…"}
// Frames, hub to client:
//   {"type":"welcome","session":{"name":…,"side":…,"role":…}}
//   {"type":"result","id":1,"result":{…}}  |  {"type":"error","id":1,"error":{…}}
//   {"type":"push","delivery":{message_id,thread_id,meta,content,text}}
import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, rmSync } from 'node:fs';
import { decodeUtf8Strict } from '../core/escape.ts';
import { BridgeError, Errors, PROTOCOL_VERSION, type SessionInfo, type Side } from '../core/types.ts';
import type { Hub } from '../core/hub.ts';
import type { Delivery } from '../core/delivery.ts';

export const MAX_FRAME_BYTES = 256 * 1024;
const ACK_TIMEOUT_MS = 10_000;

/** Split a byte stream into lines, failing on oversize frames. */
export class LineReader {
  private chunks: Buffer[] = [];
  private size = 0;
  private readonly onLine: (line: Buffer) => void;
  private readonly onOversize: () => void;
  constructor(onLine: (line: Buffer) => void, onOversize: () => void) {
    this.onLine = onLine;
    this.onOversize = onOversize;
  }
  push(data: Buffer): void {
    let start = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 0x0a) {
        const part = data.subarray(start, i);
        const line = this.chunks.length ? Buffer.concat([...this.chunks, part]) : part;
        this.chunks = [];
        this.size = 0;
        start = i + 1;
        if (line.length > MAX_FRAME_BYTES) return this.onOversize();
        this.onLine(line);
      }
    }
    if (start < data.length) {
      const rest = data.subarray(start);
      this.size += rest.length;
      if (this.size > MAX_FRAME_BYTES) return this.onOversize();
      this.chunks.push(Buffer.from(rest));
    }
  }
}

interface Conn {
  socket: Socket;
  session: SessionInfo | null;
  token: string | null;
  pendingAcks: Map<string, (ok: boolean) => void>;
  pushFn: ((d: Delivery) => Promise<boolean>) | null;
}

export class SessionSocket {
  private server: Server | null = null;
  private readonly conns = new Set<Conn>();
  private readonly hub: Hub;
  readonly path: string;

  constructor(hub: Hub, path: string) {
    this.hub = hub;
    this.path = path;
    hub.on('stop-side', (side: Side) => this.dropSide(side));
  }

  async listen(): Promise<void> {
    rmSync(this.path, { force: true });
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    const oldMask = process.umask(0o177);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.path, () => resolve());
      });
    } finally {
      process.umask(oldMask);
    }
    chmodSync(this.path, 0o600);
  }

  async close(): Promise<void> {
    for (const c of this.conns) c.socket.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    rmSync(this.path, { force: true });
  }

  /** Close the connections of a stopped side, except the codex-user client. */
  private dropSide(side: Side): void {
    for (const c of this.conns) {
      if (c.session && c.session.side === side && c.session.role !== 'outside') this.drop(c);
    }
  }

  private drop(c: Conn): void {
    if (c.session && c.pushFn) this.hub.detachPush(c.session.name, c.pushFn);
    for (const resolve of c.pendingAcks.values()) resolve(false);
    c.pendingAcks.clear();
    c.socket.destroy();
    this.conns.delete(c);
  }

  private send(c: Conn, frame: unknown): void {
    if (!c.socket.destroyed) c.socket.write(JSON.stringify(frame) + '\n');
  }

  private fail(c: Conn, err: BridgeError, id: unknown = null): void {
    this.send(c, { type: 'error', id, ...err.toJSON() });
  }

  private accept(socket: Socket): void {
    const c: Conn = { socket, session: null, token: null, pendingAcks: new Map(), pushFn: null };
    this.conns.add(c);
    const reader = new LineReader(
      (line) => void this.onLine(c, line),
      () => {
        this.fail(c, Errors.invalidInput('frame too large'));
        this.drop(c);
      },
    );
    socket.on('data', (d: Buffer) => reader.push(d));
    socket.on('close', () => this.drop(c));
    socket.on('error', () => this.drop(c));
  }

  private async onLine(c: Conn, line: Buffer): Promise<void> {
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(decodeUtf8Strict(line));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      frame = parsed as Record<string, unknown>;
    } catch (err) {
      // Invalid UTF-8 or JSON: refused, nothing stored, logged.
      const code = (err as { code?: string }).code === 'invalid_utf8' ? Errors.invalidUtf8() : Errors.invalidInput('bad frame');
      this.hub.audit({ principal: c.session?.principal ?? 'unauthenticated', name: c.session?.name ?? 'unknown' }, 'frame', 'refused', code.code, null, null);
      this.fail(c, code);
      if (!c.session) this.drop(c);
      return;
    }

    if (!c.session) {
      if (frame.type !== 'hello') {
        this.fail(c, Errors.unauthenticated());
        return this.drop(c);
      }
      if (frame.protocol_version !== PROTOCOL_VERSION) {
        this.fail(c, Errors.protocolVersionUnsupported());
        return this.drop(c);
      }
      const session = this.hub.authenticate(frame.token);
      if (!session) {
        this.hub.audit({ principal: 'unauthenticated', name: 'unknown' }, 'hello', 'refused', 'unauthenticated', null, null);
        this.fail(c, Errors.unauthenticated());
        return this.drop(c);
      }
      c.session = session;
      c.token = frame.token as string;
      this.hub.audit({ principal: session.principal, name: session.name }, 'hello', 'ok', null, null, null, { push: frame.push === true });
      this.send(c, { type: 'welcome', session: { name: session.name, side: session.side, role: session.role } });
      if (frame.push === true) this.enablePush(c);
      return;
    }

    if (frame.type === 'ack') {
      const id = frame.message_id;
      if (typeof id === 'string') {
        const resolve = c.pendingAcks.get(id);
        c.pendingAcks.delete(id);
        resolve?.(true);
      }
      return;
    }

    if (frame.type === 'call') {
      try {
        const result = await this.hub.call(c.token!, frame.method, frame.params);
        this.send(c, { type: 'result', id: frame.id ?? null, result });
      } catch (err) {
        if (err instanceof BridgeError) {
          this.fail(c, err, frame.id ?? null);
          if (err.code === 'unauthenticated') this.drop(c);
        } else {
          this.fail(c, new BridgeError('internal', 'internal error', 500), frame.id ?? null);
        }
      }
      return;
    }
    this.fail(c, Errors.invalidInput('unknown frame type'));
  }

  private enablePush(c: Conn): void {
    const session = c.session!;
    const fn = (delivery: Delivery): Promise<boolean> => {
      // Re-check the token before every push: a revoked session gets nothing.
      if (!c.token || !this.hub.tokens.isLive(session, c.token)) {
        this.drop(c);
        return Promise.resolve(false);
      }
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          c.pendingAcks.delete(delivery.message_id);
          resolve(false);
        }, ACK_TIMEOUT_MS);
        c.pendingAcks.set(delivery.message_id, (ok) => {
          clearTimeout(timer);
          resolve(ok);
        });
        this.send(c, { type: 'push', delivery });
      });
    };
    c.pushFn = fn;
    this.hub.attachPush(session.name, fn);
  }
}
