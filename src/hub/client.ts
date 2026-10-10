// Client for the session socket, used by the MCP shim and the channel plugin.
// Reads its token from a 0600 file; the token never goes in argv or env.
import { connect, type Socket } from 'node:net';
import { readFileSync, statSync } from 'node:fs';
import { LineReader } from './socket.ts';
import { decodeUtf8Strict } from '../core/escape.ts';
import { PROTOCOL_VERSION } from '../core/types.ts';
import type { Delivery } from '../core/delivery.ts';

export class HubCallError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Read a token file, refusing one that other users can read. */
export function readTokenFile(path: string): string {
  const st = statSync(path);
  if ((st.mode & 0o077) !== 0) throw new Error(`token file ${path} must be mode 0600`);
  return readFileSync(path, 'utf8').trim();
}

export interface ClientOptions {
  socketPath: string;
  tokenFile: string;
  /** Ask the hub to push deliveries to this connection (the channel plugin). */
  onPush?: (delivery: Delivery) => Promise<void>;
}

export class HubClient {
  private socket: Socket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  session: { name: string; side: string; role: string } | null = null;
  private readonly opts: ClientOptions;

  constructor(opts: ClientOptions) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const token = readTokenFile(this.opts.tokenFile);
    const socket = connect(this.opts.socketPath);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
    const welcome = new Promise<void>((resolve, reject) => {
      const reader = new LineReader(
        (line) => {
          let frame: Record<string, unknown>;
          try {
            frame = JSON.parse(decodeUtf8Strict(line)) as Record<string, unknown>;
          } catch {
            return;
          }
          if (frame.type === 'welcome') {
            this.session = frame.session as HubClient['session'];
            resolve();
          } else if (frame.type === 'error' && (frame.id === null || frame.id === undefined)) {
            const e = frame.error as { code: string; message: string };
            reject(new HubCallError(e.code, e.message));
            this.failAll(new HubCallError(e.code, e.message));
          } else {
            this.onFrame(frame);
          }
        },
        () => socket.destroy(),
      );
      socket.on('data', (d: Buffer) => reader.push(d));
      socket.on('close', () => {
        reject(new HubCallError('disconnected', 'hub connection closed'));
        this.failAll(new HubCallError('disconnected', 'hub connection closed'));
      });
    });
    socket.write(JSON.stringify({ type: 'hello', token, protocol_version: PROTOCOL_VERSION, push: !!this.opts.onPush }) + '\n');
    await welcome;
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private onFrame(frame: Record<string, unknown>): void {
    if (frame.type === 'result' || frame.type === 'error') {
      const p = this.pending.get(frame.id as number);
      if (!p) return;
      this.pending.delete(frame.id as number);
      if (frame.type === 'result') p.resolve(frame.result);
      else {
        const e = frame.error as { code: string; message: string };
        p.reject(new HubCallError(e.code, e.message));
      }
      return;
    }
    if (frame.type === 'push' && this.opts.onPush) {
      const delivery = frame.delivery as Delivery;
      this.opts
        .onPush(delivery)
        .then(() => this.socket?.write(JSON.stringify({ type: 'ack', message_id: delivery.message_id }) + '\n'))
        .catch(() => undefined);
    }
  }

  call(method: string, params: unknown): Promise<unknown> {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new HubCallError('disconnected', 'not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket!.write(JSON.stringify({ type: 'call', id, method, params }) + '\n');
    });
  }

  close(): void {
    this.socket?.destroy();
  }
}
