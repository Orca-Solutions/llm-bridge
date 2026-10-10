// The bridge MCP shim (spec 9.1): a stdio MCP server that Codex (the liaison's
// CODEX_HOME, or the maintainer's own config.toml as `codex-user`) runs as a
// command. It reads its 0600 token file and forwards the five bridge tools to
// the hub's session socket. Codex's MCP client speaks only stdio and
// streamable HTTP and passes bearer tokens by environment variable, so this
// shim is how the token stays out of every environment.
//
// Usage: llm-bridge mcp --socket <hub.sock> --token-file <codex-user.token>
//
// The shim lives in the hub's install, never in a clone, and runs outside
// Codex's sandbox by design. It forwards arguments untouched: every check is
// the hub's.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { HubClient, HubCallError } from '../hub/client.ts';
import { TOOL_DEFINITIONS } from '../core/tools.ts';

export async function runShim(socketPath: string, tokenFile: string): Promise<void> {
  const client = new HubClient({ socketPath, tokenFile });
  let connected: Promise<void> | null = null;
  const ensure = () => {
    connected ??= client.connect().catch((err) => {
      connected = null;
      throw err;
    });
    return connected;
  };

  const server = new Server({ name: 'llm-bridge', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS.map((t) => ({ ...t })) }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      await ensure();
      const result = await client.call(req.params.name, req.params.arguments ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const e = err instanceof HubCallError ? { code: err.code, message: err.message } : { code: 'shim_error', message: 'hub unreachable' };
      if (err instanceof HubCallError && (err.code === 'unauthenticated' || err.code === 'disconnected')) connected = null;
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: e }) }] };
    }
  });
  await server.connect(new StdioServerTransport());
}
