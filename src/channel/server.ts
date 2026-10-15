// The Claude-side channel plugin (build plan task 10, spec 6.1). Claude Code
// spawns it from the hub-owned CLAUDE_CONFIG_DIR; it connects to the hub's
// session socket with its own 0600 token file, receives pushes, and emits each
// as a `notifications/claude/channel` event. It also exposes the bridge tools
// so the liaison can reply and react.
//
// It declares `claude/channel` and nothing else under `experimental`: the
// `claude/channel/permission` key is absent, not false (P12). Meta keys come
// only from the hub's allowlist; content is the hub's escaped text.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { HubCallError, HubClient } from '../hub/client.ts';
import { META_KEYS, type Delivery } from '../core/delivery.ts';
import { META_VALUE } from '../core/config.ts';
import { TOOL_DEFINITIONS } from '../core/tools.ts';
import { CLAUDE_CHANNEL_USAGE, CLAUDE_STANDING_RULE } from '../core/standing-rule.ts';

export const CHANNEL_CAPABILITIES = {
  experimental: { 'claude/channel': {} },
  tools: {},
} as const;

export const CHANNEL_INSTRUCTIONS = `${CLAUDE_STANDING_RULE}\n\n${CLAUDE_CHANNEL_USAGE}`;

/** Re-check a delivery before handing it to Claude Code: only allowlisted
 * meta keys with pattern-safe values, and content with no angle brackets.
 * Anything else is a hub bug and is dropped (fail closed). */
export function checkDelivery(d: Pick<Delivery, 'content' | 'meta'>): { content: string; meta: Record<string, string> } | null {
  if (!d || typeof d.content !== 'string' || typeof d.meta !== 'object' || d.meta === null) return null;
  if (d.content.includes('<') || d.content.includes('>')) return null;
  const meta: Record<string, string> = {};
  for (const [k, v] of Object.entries(d.meta)) {
    if (!(META_KEYS as readonly string[]).includes(k) || typeof v !== 'string' || !META_VALUE.test(v)) return null;
    meta[k] = v;
  }
  return { content: d.content, meta };
}

export async function runChannel(socketPath: string, tokenFile: string): Promise<void> {
  const mcp = new Server({ name: 'bridge', version: '0.1.0' }, { capabilities: CHANNEL_CAPABILITIES, instructions: CHANNEL_INSTRUCTIONS });

  const onPush = async (d: Delivery) => {
    // Reactions that ride along go first, each as its own channel event with
    // event="reaction"; then the message. Any failed check drops the whole
    // delivery (fail closed).
    const events = [...(d.reactions ?? []), d].map((x) => checkDelivery(x));
    if (events.some((e) => e === null)) throw new Error('delivery failed the channel check');
    for (const params of events) await mcp.notification({ method: 'notifications/claude/channel', params: params! });
  };
  const clientOpts = () => ({ socketPath, tokenFile, onPush, onClose: () => void connectLoop() });
  let client = new HubClient(clientOpts());

  // Keep a connection to the hub. A revoked token (kill switch) fails until
  // the maintainer resumes the side from the console and a new token file
  // appears; the kill switch also kills this process with its session.
  const connectLoop = async (): Promise<void> => {
    for (;;) {
      client = new HubClient(clientOpts());
      try {
        await client.connect();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  };

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS.map((t) => ({ ...t })) }));
  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const result = await client.call(req.params.name, req.params.arguments ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const e = err instanceof HubCallError ? { code: err.code, message: err.message } : { code: 'channel_error', message: 'hub unreachable' };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: e }) }] };
    }
  });

  // Connect to the hub only once Claude Code has finished initializing, so
  // the first pushes aren't written before the session registered the channel.
  mcp.oninitialized = () => void connectLoop();
  await mcp.connect(new StdioServerTransport());
}
