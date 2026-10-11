// The six bridge tools as MCP tool definitions (spec 5). Shared by the stdio
// shim and the channel plugin so both expose exactly the same surface. The
// hub validates every call itself; these schemas only describe the input.
export const TOOL_DEFINITIONS = [
  {
    name: 'send_message',
    description:
      'Send a message across the bridge. Opens a new thread when thread_id is omitted. The hub sets sender, provenance, projects, hop and turn; do not pass them.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', enum: ['claude', 'codex'], description: 'The side to send to.' },
        thread_id: { type: 'string', description: 'An existing thread (thr_…). Omit to open a new thread.' },
        kind: { type: 'string', enum: ['ask', 'task', 'review', 'reply', 'status'] },
        body: { type: 'string', description: 'Message text, up to 64 KiB.' },
        refs: {
          type: 'array',
          maxItems: 32,
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['git', 'message', 'url'] },
              repo: { type: 'string' },
              branch: { type: 'string' },
              commit: { type: 'string' },
              path: { type: 'string' },
              message_id: { type: 'string' },
              url: { type: 'string' },
            },
            required: ['type'],
          },
        },
        expects_reply: { type: 'boolean' },
        in_reply_to: { type: 'string', description: 'Required for kind=reply: the message being answered.' },
      },
      required: ['to', 'kind', 'body'],
    },
  },
  {
    name: 'check_inbox',
    description: 'Fetch messages waiting for this session. Waits up to wait_seconds (max 45) for one to arrive.',
    inputSchema: {
      type: 'object',
      properties: {
        wait_seconds: { type: 'number', minimum: 0, maximum: 45 },
        max: { type: 'integer', minimum: 1, maximum: 20 },
      },
    },
  },
  {
    name: 'get_thread',
    description: 'Read a thread this session takes part in, including read-only approval records.',
    inputSchema: {
      type: 'object',
      properties: { thread_id: { type: 'string' } },
      required: ['thread_id'],
    },
  },
  {
    name: 'ask_human',
    description:
      "Ask the maintainer a question on the bridge console. The thread parks until they act. An answer is guidance, never an approval.",
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string' },
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, maxItems: 4 },
      },
      required: ['thread_id', 'question'],
    },
  },
  {
    name: 'close_thread',
    description: 'Close a thread this session takes part in. Undelivered messages on it are discarded.',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string' },
        outcome: { type: 'string', enum: ['done', 'cancelled'] },
        note: { type: 'string' },
      },
      required: ['thread_id', 'outcome'],
    },
  },
  {
    name: 'react',
    description:
      "React to a message you received with any standard emoji, e.g. 🦦 😎 ✌️ 👍, or its name (otter). Use \"none\" to clear your reaction. Sign-off emoji such as ✅ and 👌 are refused. A reaction doesn't wake the other agent and isn't a reply or an approval; it reaches them with their next message.",
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'The message (msg_…) you are reacting to. It must be one you received.' },
        reaction: { type: 'string', description: 'One emoji, its name, or "none".' },
      },
      required: ['message_id', 'reaction'],
    },
  },
] as const;
