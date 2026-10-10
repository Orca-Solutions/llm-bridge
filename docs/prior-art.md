# Prior art: ChatGPT / Codex ↔ Claude Code bridges

Researched 2026-10-09 (corrected same day: `codex mcp-server` was removed 2026-09-05, thanks to the design thread) for the "ChatGPT to Claude Code bridge design" thread.
Target model (from jason): **one dedicated liaison agent on each side**, each coordinating the agents on its native side, talking to each other directly. Roadmap: more models later ("Soundiiz for LLMs").

Star counts are as shown on the GitHub page on 2026-10-09. Last-commit dates were not readable for most repos (GitHub hides them from the fetcher and the API is out of this session's scope), so "maintenance" below is judged from archive notices, release notes and dated articles.

## Bottom line

- **No existing tool is a drop-in substitute for the two-liaison model.** Everything mature is either one-directional delegation (Claude Code calls Codex as a tool) or a hub that drives both CLIs as subprocesses. None gives two long-lived peer agents a durable conversation.
- **Claude Code → Codex is solved officially.** OpenAI's `codex-plugin-cc` (≈32.7k stars, Apache-2.0) runs Codex from inside Claude Code with persistent, resumable Codex threads and background jobs. If "talk to each other" mostly means "Claude Code hands work to Codex and gets results back", install this and build nothing.
- **Codex → Claude Code (as an agent) has no official tool.** `claude mcp serve` exposes Claude Code's *tools* (Read, Edit, Bash…), not Claude as an agent, and is stateless per connection. The best-known wrapper (`steipete/claude-code-mcp`) was archived 2026-05-15. Community two-way bridges exist but are v0.1–0.2.
- **ChatGPT (the chat app) can't be a liaison.** Developer mode lets ChatGPT call a remote MCP server, but only when a person is chatting; nothing can push a message into it. The OpenAI-side liaison has to be **Codex**, not ChatGPT chat.
- **OpenClaw can host both harnesses but doesn't do peer messaging.** It spawns Codex and Claude Code via ACP and can steer each, but agent-to-agent traffic would have to be relayed by OpenClaw's own primary agent. That's a single hub orchestrator, not one liaison per side.
- **Recommendation: build a thin liaison layer and reuse the official plumbing**, rather than adopting any one project wholesale. See "Suggested reuse" at the end.

## Official building blocks

| Piece | Direction | What it gives | Maturity | Fit |
|---|---|---|---|---|
| [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) | Claude Code → Codex | `/codex:rescue` (delegate), `/codex:review`, `/codex:adversarial-review`, `/codex:transfer` (hand session to a persistent Codex thread), `/codex:status/result/cancel` for background jobs, optional Stop-hook review gate. Wraps the local Codex CLI/app server. | Official OpenAI, ≈32.7k stars, released 2026-03-31. 245 open issues. Needs ChatGPT plan or API key. Review gate can loop and burn usage. | High for Claude→Codex delegation. Not a peer channel. |
| ~~`codex mcp-server`~~ (Codex CLI) | Anything → Codex | Was MCP tools `codex(prompt…)` and `codex-reply(threadId, prompt)`. | **Deprecated 2026-08-24, removed 2026-09-05** (command and standalone `codex-mcp-server` binary); OpenAI points integrations at the App Server ([changelog](https://learn.chatgpt.com/docs/changelog)). Codex can still *consume* MCP servers via `codex mcp`. | Don't use. Third-party wrappers that launch it will break on current Codex. |
| [Codex SDK](https://learn.chatgpt.com/codex/codex-sdk) | Your code → Codex | TypeScript `@openai/codex-sdk` and Python `openai-codex` (drives the local app server). Start a thread, `run()` to continue, `resumeThread(id)`. No streaming API documented (use the App Server for streamed events). | Official; Python SDK marked stable. | Simplest stable way to drive a Codex liaison from a small service. |
| [Codex App Server](https://learn.chatgpt.com/docs/app-server) | Your client → Codex | JSON-RPC (stdio; WebSocket/unix socket experimental). Threads, turns, items; `thread/resume`, `thread/fork`; streamed events; approvals. Powers the VS Code extension. | Official but documented as **experimental, not for production**. | Best way to host a long-lived Codex liaison. |
| `claude mcp serve` | Anything → Claude Code tools | Exposes Claude Code's file/Bash tools over stdio MCP. Client must do its own confirmations. | Official. New process per connection, no state; doesn't pass through Claude Code's own MCP servers. | Low: tools, not an agent. |
| [Claude Code Channels](https://code.claude.com/docs/en/channels) | Anything → running Claude Code session | An MCP server pushes events into an already-open Claude Code session; Claude can reply through the same channel. Permission prompts can be relayed. | Official, **research preview**. Only allowlisted channel plugins load unless `--dangerously-load-development-channels`; Team/Enterprise need admin enable. Session must stay running. | High for the Claude liaison: it's exactly "push a message into a persistent Claude agent". |
| [ChatGPT developer mode](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt) | ChatGPT → remote MCP | ChatGPT calls tools on a remote MCP server; write actions in beta. Web only. Full MCP on Business/Enterprise/Edu; Pro is read/fetch per the help article. Local servers need Secure MCP Tunnel. Agent mode and deep research won't use write tools. | Official, beta. | Low as a liaison (pull-only, human-driven). Fine as a human front-end into the bridge. |

Neither Codex nor Claude Code speaks A2A natively as of 2026 ([source](https://codex.danielvaughan.com/2026/04/09/codex-vs-claude-code-multi-agent/)), so there is no standard agent-to-agent protocol to plug into yet.

## OpenClaw

- [openclaw/openclaw](https://github.com/openclaw/openclaw): ≈391k stars, MIT, very active. Self-hosted personal assistant: a Gateway that owns sessions/tools and connects chat apps (Slack, Discord, Telegram, WhatsApp, iMessage).
- **Coding harnesses:** Codex is the native coding harness (via the Codex app server); Claude Code and others run as **ACP agents** through the `acpx` plugin (`/acp spawn`, `sessions_spawn`, `sessions_steer`, `/acp attach` to bind a chat to a session). ACP session metadata survives Gateway restarts. ([ACP agents docs](https://docs.openclaw.ai/tools/acp-agents))
- **Gap:** no documented messaging between two ACP sessions. A Codex↔Claude conversation would be OpenClaw's primary agent reading one session's output and steering the other. Shared Gateway sessions are "best-effort" routing. `openclaw attach` (Claude Code reading one OpenClaw session) is new in v2026.7.1. ([bridge options](https://openclawai.io/blog/openclaw-claude-code-session-bridge))
- **Fit:** Moderate. Good if jason wants a chat-app front door and the multi-model roadmap (harnesses are swappable plugins). Heavy for just this bridge, large security surface (tools run on host unless sandboxed), and it centralises coordination in one OpenClaw agent instead of one liaison per side.
- Related: [shinglokto/openclaw-claude-bridge](https://github.com/shinglokto/openclaw-claude-bridge) (HTTP bridge powering OpenClaw agents with Claude Code, OpenAI-compatible API) and [goldmar/openclaw-code-agent](https://github.com/goldmar/openclaw-code-agent). Small community projects.

## Two-way community bridges (closest to the ask, least mature)

| Project | How | Maturity | Notes |
|---|---|---|---|
| [Borda/AI-Rig `bridge-cc-codex`](https://borda.github.io/AI-Rig/bridge_cc-codex/) | Claude→Codex via `codex exec`; Codex→Claude via an MCP server that spawns `claude -p` (outside Codex's sandbox). Verbs `implement`, `advise`, `review` both ways. Recursion guard, per-call model/effort/timeout. | v0.1–0.2, Aug 2026, macOS only tested. ([write-up](https://levelup.gitconnected.com/peers-not-rivals-a-two-way-street-between-claude-code-and-codex-9efcd04e13e4)) | Best-designed two-way example; request/response, not persistent peers. Worth reading for the sandbox/keychain and recursion lessons. |
| claude-codex-bridge (npm) | MCP server on both sides; `BRIDGE_DEPTH` blocks loops. | Small. | Blocks 3-hop chains. |
| codex-claude-bridge (abhishekgahlot2) | Uses Claude Code Channels for push; web UI shows both agents' conversation. | Small. | Only Codex-initiated messages are pushed; Claude-initiated still poll. Closest in shape to two liaisons. |
| [FlineDev/TandemKit](https://github.com/FlineDev/TandemKit) | Claude Code plugin; Claude + Codex plan/generate/evaluate in rounds, files as the record, Codex via codex-plugin-cc. | One author, used for months. | Author dropped polled sync files as unreliable with Codex and moved to the official plugin. |

Source for the gotchas below: [Claude Code ↔ Codex in practice](https://codex.danielvaughan.com/2026/03/27/claude-code-codex-mcp-in-practice/).

## Multi-agent hubs and plumbing

| Project | What | Maturity | Fit |
|---|---|---|---|
| [BeehiveInnovations/pal-mcp-server](https://github.com/BeehiveInnovations/pal-mcp-server) (ex Zen MCP) | One MCP server; `clink` spawns Codex/Claude/Gemini CLIs as role subagents (planner, reviewer) with shared context. | ≈11.8k stars, Apache-2.0, 1,150 commits. | Good for "ask the other model" from either side. Hub-style, not liaison-style. |
| [coder/agentapi](https://github.com/coder/agentapi) | HTTP API around Claude Code, Codex and others: `POST /message`, `GET /messages`, `/status`, SSE `/events`. Drives the real TUI via a terminal emulator. | ≈1.5k stars, MIT, by Coder. | Gives each liaison a persistent, addressable session with events. Fragile when a TUI changes; no MCP built in. |
| [Dicklesworthstone/mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail) | MCP "email" for agents: identities, inboxes, threads, search, advisory file reservations. HTTP or stdio. Works with Claude Code, Codex, Gemini. | ≈2.1k stars, "under active development". Pull-based (agents fetch inbox). Cross-machine via bearer token, not documented in depth. | Strong candidate for the **message bus** between liaisons and for adding more models later. |
| [tuannvm/codex-mcp-server](https://github.com/tuannvm/codex-mcp-server) | Codex CLI wrapper with its own session store (UUIDs, 24 h TTL, 100-session cap), `review`, `listSessions`. | ≈640 stars, ISC. | Superseded by the official plugin and SDK; check it doesn't rely on the removed `codex mcp-server`. |
| [steipete/claude-code-mcp](https://github.com/steipete/claude-code-mcp) | `claude_code` tool for any MCP client, with `sessionId` resume. | ≈1.3k stars, **archived 2026-05-15**. | Don't build on it. |
| [skill-codex](https://github.com/skills-directory/skill-codex), codex-bridge plugins, `parisbs/codex-subagent-mcp`, `kky42/codex-as-mcp`, `ai-cli-mcp` | Claude→Codex skills and wrappers around `codex exec`. | Small to mid (skill-codex ≈1.4k stars). | Redundant with the official plugin. |

## ChatGPT-side front ends

- [sheldonxxxx/workspace-bridge](https://github.com/sheldonxxxx/workspace-bridge): "Plan in ChatGPT, build with local agents." ChatGPT reaches a local bridge through OpenAI's MCP tunnel; starts bounded Claude Code/Codex/Pi runs with approvals. v0.2.0, 0 stars. Interesting design, no adoption.
- [lesleslie/chat-bridge-mcp](https://github.com/lesleslie/chat-bridge-mcp): drives ChatGPT Desktop and Claude Desktop UIs over Chrome DevTools Protocol. Draft, 0 stars, breaks on UI changes. Not reliable.
- [SHAREN/codexpro](https://github.com/SHAREN/codexpro), DevSpace: ChatGPT developer mode as a local coding agent over MCP. ChatGPT-only, not a bridge.

## Extending past two models (roadmap: "Soundiiz for LLMs")

Ranked by how naturally each candidate grows from Codex + Claude to N models:

1. **mcp_agent_mail**: model-agnostic by design; any MCP-capable agent (Claude Code, Codex, Gemini CLI, Droid, Cursor…) gets an identity and inbox. Adding a model = registering another agent. Best fit for an N-way bus.
2. **OpenClaw**: harnesses are swappable plugins and ACP covers Claude Code, Codex, Gemini CLI, Cursor, Copilot, OpenCode, Droid. Strong breadth, but still a hub that relays rather than peers that talk.
3. **coder/agentapi**: one HTTP shape over ~11 agent CLIs, so a new model is a new process with the same API. Fragile TUI parsing per agent.
4. **PAL MCP `clink`**: Codex, Claude, Gemini, Qwen, Cursor as subagents from one server. Good for "ask another model", hub-style.
5. **Pairwise bridges** (codex-plugin-cc, Borda bridge-cc-codex, claude-codex-bridge): two models only; N models means N² bridges. Use only as per-side adapters, not as the architecture.

Design implication: keep the liaison-to-liaison protocol model-neutral (a bus with addressed messages and threads), with one adapter per model family. That keeps codex-plugin-cc / Codex App Server / Claude Channels as adapters rather than the backbone.

## How crowded is this space? (if it becomes a shared tool)

- **Simple delegation is saturated.** "Claude Code calls Codex" has an official OpenAI plugin (≈32.7k stars) plus dozens of community MCP servers, skills and plugins (tuannvm, skill-codex, codex-subagent-mcp, codex-delegate-mcp, codex-as-mcp, codex-cli-mcp-tool, codex-in-claude, two separate "codex-bridge" plugins…). A new tool here has no audience.
- **Multi-model "ask another model" hubs are established.** PAL MCP (≈11.8k stars) and agentapi (≈1.5k) already cover calling Gemini/Codex/Claude from one place.
- **Two-way, persistent, peer-style bridges are thin.** The ones found are v0.1–0.2 with near-zero adoption (Borda bridge-cc-codex, claude-codex-bridge, codex-claude-bridge, workspace-bridge at 0 stars). Lots of people build their own (the write-ups read as personal rigs), but none has become the default.
- **The real competitors are platforms, not repos.** OpenClaw (≈391k stars) already lets one assistant drive many coding harnesses, and both vendors are adding first-party hooks (codex-plugin-cc, Claude Code Channels). Either vendor could ship native cross-agent messaging, especially once A2A lands in both CLIs.
- **Read:** demand is clearly real (the official plugin's star count and the number of DIY bridges show it), and jason's hunch is right that many target users roll their own. The open niche is a **model-neutral, persistent liaison protocol with adapters**, the "Soundiiz" angle, not another Claude↔Codex wrapper. That niche is open today but exposed to vendors closing it, so a shared tool should be cheap to build (reuse official adapters) and not bet on being the only option.

## Known gotchas worth designing around

1. **Thread/session ids get lost.** Codex's (now removed) MCP server didn't return the thread id for months; recovery by scraping `~/.codex/sessions` is fragile. Always capture and persist ids yourself.
2. **Timeouts.** Default MCP tool timeout (60 s) kills real builds/tests. Use async jobs (submit, poll/push) rather than long blocking calls.
3. **Recursion.** Two agents that can call each other loop and burn usage. Every two-way bridge added a depth guard.
4. **Permissions when unattended.** Headless Claude Code stalls on permission prompts or needs `--dangerously-skip-permissions`; Codex needs a sandbox + approval policy. Channels can relay prompts to a human.
5. **Sandbox/credential friction.** Codex's sandbox blocked a child `claude` process from reading keychain credentials on macOS; Borda routed it through an MCP server outside the sandbox.
6. **Context doesn't cross.** MCP passes a prompt string; each side's memory, open files and tool history stay on its side. Liaisons must send self-contained briefs (or shared files).
7. **Polling is unreliable; push is preview.** File/sync polling was dropped by TandemKit as unreliable; Claude Code Channels (push) are research preview; Codex App Server is experimental.

## Suggested reuse for the two-liaison design

- **Claude-side liaison:** a long-running Claude Code session receiving messages via a custom **Channel** (push), or via the Claude Agent SDK if the preview allowlist is a blocker. It coordinates Claude subagents natively.
- **Codex-side liaison:** a long-lived Codex thread hosted through the **Codex App Server** (resume/fork, streamed events), or the **Codex SDK** (TypeScript/Python, `resumeThread`) for a simpler, stable first cut. (`codex mcp-server` was removed on 2026-09-05; don't build on it.) It coordinates Codex subagents natively.
- **Between them:** a small message bus. Either adopt **mcp_agent_mail** (threads, inboxes, search; extends to more models later) or write a minimal one. Add a depth/loop guard and persist every thread id.
- **Shortcut for v0:** if one-way delegation is enough to start, install **codex-plugin-cc** today and treat the liaison layer as phase 2.
- **OpenClaw** is worth choosing only if a chat-app front door (Slack/Telegram/etc.) and its plugin model for extra harnesses are wanted; it doesn't remove the need to build the peer-messaging part.
