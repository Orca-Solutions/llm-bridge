# Decision log

What was decided, why, and who decided it, so settled questions stay settled. To reopen a settled row, add a new row that supersedes it; don't edit the old one. A provisional row is updated in place when jason decides it.

Status values: **Settled** (jason decided), **Research** (settled by the research threads; jason can overrule), **Provisional** (the plan's recommended option, in use until jason answers).

Last updated 2026-10-09.

## Decisions

| # | Date | Decision | Why | Status | Source |
|---|---|---|---|---|---|
| D1 | 2026-10-09 | Free and open source, no commercial or paid version | "Pay it forward." The only legal shape is bring-your-own-account anyway, which is hard to charge for | Settled | jason; plan decision 1 |
| D2 | 2026-10-09 | Trial `codex-plugin-cc` for about two weeks before building; build only if jason misses Codex starting work on Claude | The plugin already covers Claude-to-Codex delegation for about an hour of setup | Settled | jason; plan decision 2 |
| D3 | 2026-10-09 | The Claude liaison is a Claude Code session fed by a custom channel, in Manual or acceptEdits mode, with no permission relay. Agent SDK is the fallback | jason keeps a live session to type into, on jason's own plan; the trust rules already cover channel mode | Settled | jason; plan decision 3 |
| D4 | 2026-10-09 | v1 runs on jason's own Claude and ChatGPT plans, with API-key mode built in for later | Personal use on your own plan is allowed and costs nothing extra; others will need API keys | Settled | jason; plan decision 4 |
| D5 | 2026-10-09 | Autonomy limits: 8 hops, 20 turns per thread, a daily spend cap jason sets, edits only inside each side's own clone | Enough for a review round trip while stopping runaway loops. The dollar figure is set at first run | Settled | jason; plan decision 5 |
| D6 | 2026-10-09 | v1 runs on jason's dev machine | Needs jason's repos and CLIs; nothing exposed; existing logins work | Settled | jason; plan decision 6 |
| D7 | 2026-10-09 | TypeScript on Node, with SQLite | One language with the web console; the TypeScript Codex SDK drives local threads (it wraps `codex exec --experimental-json` and isn't labelled stable) and the MCP SDK ships TypeScript. Python was close, since OpenAI's Python SDK drives the App Server | Settled | jason; plan decision 7 |
| D8 | 2026-10-09 | One liaison per side, each routing anywhere on its own side from a registered project list (for example, dev on Claude to devops on Codex). Projects don't pair across the bridge. Routing switches on right after the Phase 1 single-project gate, behind its own gate | jason's usual flow is an app team on Claude talking to devops on Codex | Settled | jason; plan decision 8; security review findings 16 to 20 |
| D9 | 2026-10-09 | License: Apache-2.0 | Permissive like MIT, plus an explicit patent grant, which suits a tool other devs may build on. Same license as `codex-plugin-cc` | Settled | jason, 2026-10-10 |
| D10 | 2026-10-09 | Working name "LLM-Bridge" until a public name is chosen. The name can't contain "Claude Code" | Anthropic's terms bar "Claude Code" in a product name | Provisional | This thread; plan's billing section |
| D11 | 2026-10-10 | No plugin trial; build starts with Phase 1. Supersedes D2 | jason wants two-way communication from the start, and `codex-plugin-cc` goes one direction only | Settled | jason |
| D12 | 2026-10-10 | Routing-milestone Claude workers run `claude -p` without `--bare`, with `--setting-sources user --strict-mcp-config --mcp-config` (bridge tools only) and an explicit `--permission-mode`, relying on sparse checkout (P21) for isolation | `--bare` never reads OAuth credentials and needs an API key, which D4 reserves for later, and it still applies the project's `env` block | Settled | jason, approving the pre-build review's recommendation |
| D13 | 2026-10-10 | The daily spend cap is estimated USD computed by the hub from token counts at list price, per side per day: Claude side from OpenTelemetry metrics, Codex side from SDK `turn.completed` usage | No vendor caps or bills an interactive subscription session, so the hub has to measure | Research | Pre-build review 1.3 |
| D14 | 2026-10-10 | v1 runs on jason's MacBook Air (macOS). A Linux machine may come later; the docs keep the Linux socket setup for that | `sandbox.network.allowUnixSockets` works only on macOS, so the OS decides the setup in spec 9.1 | Settled | jason, 2026-10-10 |
| R1 | 2026-10-09 | The OpenAI-side liaison is a Codex thread, not a ChatGPT chat | Nothing can push a message into a ChatGPT chat; ChatGPT is only a later front door | Research | Plan, "Interface" |
| R2 | 2026-10-09 | Write our own small message bus, not mcp_agent_mail | Reviewing it would cost about as much as writing one (est. 15 to 30 h), and its human marker can be imitated | Research | build-vs-adopt.md |
| R3 | 2026-10-09 | OpenClaw is not the base. Optional later as a chat-app front door, with its own review | Too large to review (est. 40 h or more), poor security record, no longer covered by Anthropic plans | Research | Plan, "OpenClaw: fit and verdict" |
| R4 | 2026-10-09 | The Claude liaison never runs in auto mode and never gets `--dangerously-skip-permissions` | Auto mode's classifier can accept an approval stated in conversation, and Codex's messages arrive in that conversation | Research | Security review finding 1 |
| R5 | 2026-10-09 | Agents never act as jason. Peer messages are information, never approval; approvals come only from jason through the console or a native prompt | jason's hard requirement | Settled | jason; plan, "Trust model" |
| R6 | 2026-10-09 | All eight security-review must-fix items are Phase 1 requirements | Without them three escalation paths stay open | Research | security-review.md |
| R7 | 2026-10-09 | Agents work in clones of a local bare repo, never worktrees of jason's checkout; jason does every push to GitHub | Worktrees inherit jason's standing approvals and workspace trust | Research | Security review finding 2 |
| R8 | 2026-10-09 | Every adopted tool gets a security review first, a pinned version and a reviewed diff per update | jason's rule against agents "running amok" | Settled | jason; plan, "Approaches compared" |
| R9 | 2026-10-09 | Messages are pushed and every tool call returns in seconds, not blocking calls | MCP tool timeouts are about 60 seconds; real tasks take minutes | Research | Plan, "Interface" |
| R10 | 2026-10-09 | `codex mcp-server` is not used | Removed by OpenAI on 2026-09-05; use the Codex SDK, then the App Server | Research | Plan, "Approaches compared" |
| R11 | 2026-10-09 | Routing guards: the hub validates destinations against its own project list and stamps the source; routes are a default-deny allowlist; caps per project and per route; CI and infrastructure files flagged in any repo; deploy tools denied on devops threads; no state or credential files near agent clones | Routing widens the blast radius from one clone to every registered repo, and devops repos touch live systems | Research | Security re-check of decision 8; plan routing section |
| R12 | 2026-10-09 | jason's own Codex app and CLI chats get their own agent principal (`codex-user`). Only the console composer carries jason's stamp, and it steers but never approves | What reaches the bridge from a Codex chat is model output, even when jason typed the prompt | Research | Plan, "Interface"; security review finding 14 |
| R13 | 2026-10-09 | A thread carries one project per side, stamped by the hub and fixed once set; fan-out opens one thread per destination | A thread can run from dev on one side to devops on the other, so one project name can't describe both ends | Research | Design thread; protocol spec section 7 |
| R14 | 2026-10-09 | Escaping uses a Unicode allowlist after NFKC, covers every agent-supplied string, and the liaison's standing rule comes from hub-owned config, never the agent clone | A blocklist misses tag characters and new lookalikes; the clone's CLAUDE.md is writable by the other agent | Research | Security review thread's check of these docs |

## How to add an entry

Give it the next number, today's date, the decision in one line, why in one line, its status and where it came from. If it replaces an earlier row, say "Supersedes Dn" in the Why column and leave the old row as it is.
