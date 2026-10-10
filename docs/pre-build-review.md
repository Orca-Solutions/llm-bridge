# Pre-build review of the LLM-Bridge planning docs

Independent review, 2026-10-09. Reviewer: a fresh thread that wrote none of these docs. Scope: consistency across the plan, protocol spec, build plan, decision log and starter files; feasibility of the vendor features the plan relies on, checked against the vendors' current docs and source on 2026-10-09; gaps that would stall a builder; whether the Phase 1 scope and estimates are realistic. Security was reviewed separately and is not reopened here.

**No doc has been changed.** Every item below is a proposal for jason to accept or reject. "Owner" says which thread would make the change.

## Verdict

**Not ready to build yet, but close.** The architecture holds, every settled decision is feasible, and the trust model survives contact with the vendors' current docs. What blocks a builder is eleven concrete items: five places where the docs assume a vendor feature works differently than it does, three contradictions between the plan and the spec (and the spec says the plan wins, so the plan has to be fixed), and three gaps a builder would hit in the first milestone. All are wording and config changes; none needs a new component or reopens a decision. Fixing them is a few hours of editing.

Two things jason should know even if nothing else is read:

1. **The Claude liaison must be an interactive terminal session that jason confirms at every start.** A custom channel loads only with `--dangerously-load-development-channels`, which "prompts for confirmation, so it takes effect in interactive sessions. With `-p`, Claude Code ignores the flag." The approved `--channels` list is Anthropic's, or an org allowlist that only Team and Enterprise admins can set. A Pro or Max account has no way to allowlist its own channel. The plan already says the liaison is a session jason types into, so the decision stands, but the build plan treats the liaison as a process the hub launches and kills, and the routing milestone's "project sessions fed by the hub's channel" would each need their own terminal and confirmation. (Sources: [channels](https://code.claude.com/docs/en/channels#research-preview), [channels reference](https://code.claude.com/docs/en/channels-reference#test-during-the-research-preview).)
2. **The Phase 1 estimate is about half of what the task list implies.** The plan carries 15 to 25 h for Phases 1 and 2 plus 9 to 18 h of trust work. The build plan's twelve tasks, with 23 conformance tests, a property-tested escaping library, a hardened console, four-principal auth, a workspace manager with sparse clones and a repo-file guard, a process supervisor, a channel plugin and a Codex adapter, read as 40 to 70 h for one developer working with an AI assistant. That is still reasonable for a personal open-source tool, but it is two months of evenings, not two weekends. Details in section 5.

Phase 0 (trial `codex-plugin-cc`) needs none of these fixes and can start now.

## 1. Must fix before Phase 1 starts

Each item: what the docs say, what is actually true, the proposed fix, the owner.

### 1.1 The liaison and routing sessions can't be headless channel sessions

- **Docs say:** build plan task 9 has the hub start "each liaison and its channel process in its own process group"; task 10 is a "launcher"; task 14 has Claude project sessions "fed by the hub's channel"; the plan's Trust model says "the hub starts the Claude liaison with its own settings file and config folder".
- **True:** the dev flag only works in an interactive session and prompts for confirmation each start; `-p` ignores it. Claude Code spawns the channel server itself as a stdio subprocess ("Claude Code spawns this process"); the hub can't start the channel process separately, it can only talk to it. A channel server is registered in the project `.mcp.json` or in the user-level `~/.claude.json`, which under `CLAUDE_CONFIG_DIR` is the hub-owned config dir, so hub-owned registration works. Also: "Events only arrive while the session is open."
- **Fix:** (a) Build plan task 9 and 10: the hub generates the liaison's command line and settings, and either jason runs it in his own terminal or the hub runs it inside a pty it owns (tmux or similar) that jason attaches to; either way jason answers the dev-flag confirmation and the trust dialog (1.9). The kill switch targets the process group of the session the hub started or was told about. (b) Build plan task 14: Claude project sessions are `claude -p` workers pulling through `check_inbox` (see 1.2), not channel sessions; an interactive channel session per project is possible but is one terminal and one confirmation each. (c) Spec 6.1: say the channel server is registered user-scope in the hub-owned `CLAUDE_CONFIG_DIR`, connects to the hub's socket with its token file, and runs outside the Bash sandbox (so the `denyRead` on token files doesn't cover it, by design).
- **Owner:** founding docs thread (build plan, spec); design thread (plan wording).

### 1.2 `--bare` workers need an API key, which Decision 4 didn't plan for

- **Docs say:** build plan task 14 and spec section 3: project sessions on the Claude side include `claude -p --bare` workers; Decision 4: v1 runs on jason's own plans.
- **True:** "In bare mode, Claude Code never reads OAuth credentials or the system keychain. For the Anthropic API, set `ANTHROPIC_API_KEY`." `--bare` also doesn't bind the cross-session inbox socket (fine, workers use `check_inbox`), and it still applies the project's `env` block and helpers, so `--setting-sources user` is needed too. ([headless](https://code.claude.com/docs/en/headless), [permissions](https://code.claude.com/docs/en/permissions#what-runs-before-you-trust-a-folder))
- **Fix:** decide one of: (a) routing workers use API-key mode (Decision 4 already has it "built in"; say so in the build plan and decision log), or (b) workers run `claude -p` without `--bare`, relying on sparse checkout (P21 already removes `.claude/`, `.mcp.json`) plus `--setting-sources user --strict-mcp-config --mcp-config <bridge only>` to get the same isolation on a subscription login. Either way, every `-p` launch passes `--permission-mode` explicitly, because a `-p` run "can be `auto` when the session doesn't fetch feature flags". This is a routing-milestone item, not Milestone A, but the decision log should record it now.
- **Owner:** founding docs thread; jason decides (a) or (b). Recommendation: (b) for v1, since it keeps Decision 4 intact and P21 already does the work.

### 1.3 The daily spend cap has no measurement mechanism on either side

- **Docs say:** Decision 5 and spec section 10: "Daily spend per side, set by jason at first run"; build plan task 5 P13: the spend limit parks the thread. Nothing says where the number comes from.
- **True:** Claude Code has no spend cap for interactive sessions (`--max-budget-usd` is print mode only). An external process can read usage through OpenTelemetry (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`, metrics `claude_code.cost.usage` in USD and `claude_code.token.usage`, exported every 60 s by default) or the statusline JSON; both are client-side estimates at list price. On a subscription there is no dollar spend at all, only plan usage. The Codex TypeScript SDK reports tokens per turn (`turn.completed` usage: input, cached, output, reasoning) and no dollar figure; the App Server (Phase 2) adds `estimatedUsageUsdMicros`. ([monitoring](https://code.claude.com/docs/en/monitoring-usage), [costs](https://code.claude.com/docs/en/costs))
- **Fix:** spec section 10 defines the cap as estimated USD computed by the hub from tokens at list price, per side per day, and names the source: OTel metrics from the Claude liaison (the hub runs a small OTLP receiver, and the hub-owned settings set the OTel env vars) and `turn.completed` usage from the Codex SDK. On trip, the hub parks the side's threads and stops feeding the channel; it can't stop the session itself. Build plan task 5 gets a "Done when" line for the OTel receiver. Decision log D5: add "measured as estimated USD from token counts, not billed dollars".
- **Owner:** founding docs thread.

### 1.4 Build plan task 11 asks for something the Codex TypeScript SDK can't do

- **Docs say:** task 11 "Done when": "The pinned settings are read back from the running thread and match."
- **True:** the TS SDK's `thread.started` event carries only `thread_id`; no event or call reports the effective sandbox or approval policy. The App Server's `thread/start` response does (`approvalPolicy`, `sandbox`, `cwd`), but that is Phase 2. The SDK passes settings as `--sandbox` and `--config` flags on the `codex exec --experimental-json` process it spawns. (Sources: `sdk/typescript/src/threadOptions.ts`, `codex-rs/exec/src/exec_events.rs` at openai/codex HEAD 47b8057.)
- **Fix:** reword the test to "the hub asserts the spawned `codex` process's argument list carries `--sandbox workspace-write`, `approval_policy=never`, `sandbox_workspace_write.network_access=false` and the clone as the only `--add-dir`", or move the Codex adapter to the App Server in Phase 1 (which also brings approvals to the console earlier, but is the surface OpenAI labels experimental). Recommendation: the argv assertion in Phase 1; readback when Phase 2 lands.
- **Owner:** founding docs thread.

### 1.5 Codex can't reach a Unix socket, and its MCP token option is an environment variable

- **Docs say:** spec 9.1: "The hub listens on a Unix socket for sessions and outside clients"; "Tokens are passed by file, never by environment variable"; build plan task 11: "The bridge MCP server is registered in the liaison's `CODEX_HOME` and in jason's own `config.toml`".
- **True:** Codex's MCP client supports stdio and streamable HTTP only ("STDIO and Streamable HTTP only"; `McpServerTransportConfig` has two variants). Its bearer-token option is `bearer_token_env_var`. MCP servers Codex spawns run unsandboxed, with network, whatever `network_access` says. ([Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), `codex-rs/config/src/mcp_types.rs`, `rmcp-client/src/stdio_server_launcher.rs`)
- **Fix:** spec 9.1 and task 11: the bridge is registered in each `config.toml` as a stdio command, a hub-owned shim that reads its `0600` token file and connects to the hub socket. The shim lives in the hub's install, never in a clone. State that the shim runs outside Codex's sandbox by design. The same shape serves jason's `codex-user` client.
- **Owner:** founding docs thread.

### 1.6 The plan and the spec disagree on how routing works

- **Docs say:** plan, "Option: a liaison that routes across projects": "Claude Code already lets your sessions message each other (cross-session messaging)", a reachability table for cross-session sockets, and the Trust model's deny on `SendMessage` and `ListAgents` "until routing (decision 8) is turned on". Spec 7.2 rule 7: "No leg skips the hub"; build plan task 14: project sessions are fed by the hub's channel or `check_inbox`.
- **True:** both mechanisms exist, but they are different designs. Cross-session messaging has no hub in the path, so the hub couldn't stamp, escape, count hops or log those legs, and the docs say its "don't change CLAUDE.md or permissions" guard is an instruction to the model, not enforcement. The spec's hub-only routing is the one the security re-check approved.
- **Fix:** plan: rewrite that section so routing legs go through the hub; keep the cross-session facts as background on why the liaison's deny rules exist; change "until routing is turned on" to a permanent deny of `SendMessage` and `ListAgents` in every bridge session. Spec's "plan wins" clause makes this a must-fix.
- **Owner:** design thread.

### 1.7 Two more plan-versus-spec contradictions

- **Principals.** Plan Trust model: "There are three principals: the Claude adapter, the Codex adapter and you." Spec 9.1 and Decision R12: four, with `codex-user`. Fix the plan.
- **Channel instructions.** Plan rule 7: "The channel's instructions say every event comes from the Codex agent, never from you." Spec 6.1 delivers jason's console notes through the same channel with `provenance="human"` and a two-class standing rule. The plan's one-class wording would have the liaison treat jason's own console notes as agent text. Fix the plan to the two-class rule.
- **R6 wording.** Plan, routing gate: "The liaison must refuse by deny rule". Spec R6 was reworded (the forward is an allowed `send_message`; the enforced control is the project session's push deny). The plan still has the old sentence. Fix the plan.
- **Owner:** design thread.

### 1.8 Milestone A has no defined reply path to jason's Codex CLI

- **Docs say:** build plan Milestone A check: "jason's own Codex CLI sends a `review` through the MCP endpoint, the Claude liaison reviews in its clone and replies". Spec 5.1's table: a liaison sending to the other side is delivered to "the other side's liaison"; a `codex-user` client may send only to the Claude liaison. There is no Codex liaison in Milestone A, and nothing in 5.1 or 6 says a reply to a `from.session = "outside"` sender is delivered to that client's `check_inbox`.
- **Fix:** spec 5.1: add a row, "Liaison, `to` the other side, on a thread opened by a `codex-user` client: delivered to that client's inbox (`to.session = "outside"`)", and say in 5.2 that `check_inbox` with the `codex-user` token returns those. Also add "outside" to `to.session` in 4.2. Add a conformance test (P24) so the Milestone A check is covered.
- **Owner:** founding docs thread.

### 1.9 The liaison will be asked to trust its clone, and the plan says never to

- **Docs say:** plan Trust model rule 9 and security review item 7: "You never accept Claude Code's workspace-trust dialog for an agent clone."
- **True:** the trust dialog "shows in interactive sessions only", is keyed on the git repository root, and is stored in the config dir's `.claude.json`. The interactive liaison started in its clone will get the dialog. Accepting it enables only the clone's `permissions.allow` and `additionalDirectories` from `.claude/settings.json`, which the sparse checkout (P21) removes anyway; deny rules are unaffected. ([permissions](https://code.claude.com/docs/en/permissions#project-allow-rules-and-workspace-trust))
- **Fix:** reword the rule: "Trust for an agent clone is only ever accepted in the hub-owned `CLAUDE_CONFIG_DIR`, never in jason's own `~/.claude.json`, and only because the clone is sparse (no `.claude/`, no `.mcp.json`)." Build plan task 10 gets a line: the launcher pre-sets `projects["<clone>"].hasTrustDialogAccepted` in the hub-owned `.claude.json` so the dialog doesn't appear at all.
- **Owner:** design thread (plan), founding docs thread (build plan).

### 1.10 No minimum Claude Code version is pinned, and several rules depend on one

- Channels permission relay: before v2.1.234 Claude Code "treated `false` as declared", and only from v2.1.234 do permission requests go only to registered channels. `--permission-prompts none` needs v2.1.259. Auto mode became the interactive default in v2.1.283. Cross-session messaging exists from v2.1.224. Bare mode became fully bare in v2.1.286. Codex: `tool_timeout_sec` default 60, `codex mcp-server` gone since 2026-09-05, confirmed.
- **Fix:** build plan task 1 (or a new "Versions" table in the spec): minimum Claude Code 2.1.286, the Codex CLI and `@openai/codex-sdk` versions used in Phase 0, and `@modelcontextprotocol/sdk` pinned to a 1.x release that does not negotiate 2026-07-28. The hub checks `claude --version` and `codex --version` at start and refuses to launch below the minimum. Also set `MCP_PROTOCOL_NEGOTIATION=legacy` in the liaison's env as a second guard for the channel registration rule in task 10.
- **Owner:** founding docs thread.

### 1.11 The launcher must pin the permission mode explicitly, not just avoid auto

- **Docs say:** task 10: "Permission mode `default` or `acceptEdits`, never `auto`".
- **True:** since v2.1.283 "auto mode is the built-in starting permission mode for interactive terminal" sessions, and in auto mode "if you tell Claude that a blocked action is allowed, the classifier reads that as your approval and can clear the block". Whether a channel body counts as a user message to the classifier is not documented either way. So an interactive liaison started without an explicit mode lands in auto mode.
- **Fix:** task 10: the launcher passes `--permission-mode default` (or `acceptEdits`) on the command line and sets `permissions.defaultMode` in the hub-owned settings; the gate asserts the running mode (the statusline JSON or `/permissions` output shows it). The three spoofing tests already run per mode; add "and once with no `--permission-mode` flag, to prove the settings file alone pins it".
- **Owner:** founding docs thread.

## 2. Should fix before the task that needs it

- **2.1 `sandbox.network.allowUnixSockets` is macOS-only.** "Claude Code ignores this list on Linux and WSL2; use `allowAllUnixSockets` there instead." Spec 9.1, task 10 and P20 rely on it. Fix: state the platform; on Linux, leave Unix sockets blocked (the default) and have the channel process, which is outside the sandbox, do all hub traffic. Which OS jason's dev machine runs should be recorded in the decision log, since several sandbox details depend on it. ([sandboxing](https://code.claude.com/docs/en/sandboxing))
- **2.2 Codex can read the whole disk under `workspace-write`, but a read restriction now exists.** The spec's residual-gap note (9.1) is right for legacy `sandbox_mode`. Codex's beta permission profiles (`default_permissions`, `[permissions.<name>.filesystem]` with `":root" = "deny"`) can deny reads, but they are mutually exclusive with `sandbox_mode`/`--sandbox`, and the SDK's `sandboxMode` option passes `--sandbox`, which silently turns profiles off. Fix: task 11 evaluates profiles (leave `sandboxMode` unset, pass `config: { default_permissions: ... }`); if they hold up, the "Codex reads" limitation in SECURITY.md and spec 9.1 shrinks to "beta feature". Also answers the plan's open line "Whether Codex can read outside its workspace still needs verifying": it can, unless profiles are used.
- **2.3 Per-thread Codex instructions need one `Codex` instance per instruction set.** The TS SDK has no thread-level instructions option; `developer_instructions` goes in `new Codex({ config: { developer_instructions }, env })`. Task 11 and 14: say so. The `env` option replaces the whole environment ("will not inherit variables from `process.env`"), which is exactly the scrubbed-environment behaviour the plan wants, but PATH and HOME must be in the allowlist.
- **2.4 A separate `CODEX_HOME` needs its own login.** Credentials live in `$CODEX_HOME/auth.json` (or a keyring entry keyed on the `CODEX_HOME` path). Task 11 needs a one-time `codex login` in the liaison's home, or `apiKey`. Nothing says this today; a builder would hit it on first run.
- **2.5 Execpolicy rules work under `never` but are bypassable by shell indirection.** Confirmed that `forbidden` rules apply in exec and SDK runs, so the task 11 `terraform apply`/`kubectl` test can pass as written. But matching is on argv prefixes, and `bash -lc` scripts with substitutions, env assignments or control flow are matched as one token list, so `x=$(kubectl ...)` or `env kubectl` get past. Codex also has `PreToolUse` hooks that can deny, with their own trust step. Fix: SECURITY.md and task 11 keep the "network off and no credentials are the hard guarantee" sentence, and say execpolicy is a tripwire, not a wall.
- **2.6 The TS SDK isn't labelled stable.** Only the Python SDK carries that label; the TS SDK wraps `codex exec --experimental-json`. Decision D7's rationale and the plan's "Codex liaison" paragraph say "stable". Doesn't change the language choice; fix the wording so nobody relies on it.
- **2.7 `check_inbox` is not a real fallback for an interactive liaison.** Spec 5.2 and task 10: "Fallback to `check_inbox` when the channel won't load." An interactive session doesn't poll on its own; something has to prompt it each time. The real fallback is Decision 3's Agent SDK. Reword: `check_inbox` serves outside clients and `-p` workers; the liaison's fallback is the Agent SDK.
- **2.8 Starter README paths.** README links `docs/protocol-spec.md`, `docs/security-review.md` and friends; the files live under `founding/` and `bridge-design/`. Task 1 should state the mapping into the repo's `docs/`.
- **2.9 Plan "Interface" paragraph** says "ChatGPT developer mode can also post into the bridge" in v1; the same doc puts the ChatGPT front door in Phase 3. Drop the v1 mention.
- **2.10 Phase 0 review scope, two facts to feed it.** `codex-plugin-cc` v1.0.6 spawns `codex app-server` directly (not the SDK) through a per-session broker on a Unix socket, with `approvalPolicy: "never"`, `sandbox: "read-only"` by default and `workspace-write` with `--write` (the rescue agent adds `--write` by default). It inherits jason's normal `CODEX_HOME` and environment, so jason's credentials are in reach of what it runs; that is the thing for task 0.1 to look at. `/codex:transfer` exists and reads transcripts under `~/.claude/projects`. Hooks: SessionStart/SessionEnd lifecycle, and a Stop review gate that is off unless enabled.

## 3. Confirmed as described

Facts the docs rely on that check out against current sources, so a builder can trust them:

- Channel shape, `meta` keys as tag attributes (keys must be identifiers; underscores fine, the spec's names comply), `instructions` delivered at connect, reply tools go through normal permission prompts, events batched while the session is busy.
- Channels work with Console API-key auth as well as claude.ai login (so Decision 4's API-key mode is a config change, except on Bedrock/Vertex/Foundry where channels don't exist).
- A channel server negotiating MCP 2026-07-28 isn't registered; older handshake works.
- `claude/channel/permission` capability, omitted key, and "anyone who can reply through the channel can approve or deny tool use": all as the plan quotes.
- Cross-session messaging: `SendMessage`/`ListAgents`, `crossSessionInbound` accept/hold/refuse (project-scope `accept` is ignored; must come from `--settings`, user or managed), `isolatePeerMachines`, the "never counts as your consent" guarantee, loop throttling, per-session socket restricted to the OS user.
- `--permission-prompts none` exists (v2.1.259+), as does `--permission-mode dontAsk`. `--settings`, `--mcp-config`, `--strict-mcp-config`, `--permission-prompt-tool`, `--append-system-prompt`, `--setting-sources` all exist.
- Deny rules win at every level and in every mode; `Read()` deny covers the Read tool (the spec's "both `denyRead` and `Read()` denies" is the right pairing, since the sandbox's `denyRead` doesn't stop the Read tool). The sandbox covers Bash only; MCP servers, hooks and file tools run outside it.
- `CLAUDE_CONFIG_DIR` relocates settings, `.claude.json`, plugins and the user `CLAUDE.md`.
- Codex SDK thread options map exactly: `sandboxMode`, `workingDirectory`, `approvalPolicy`, `networkAccessEnabled`, `additionalDirectories`, `skipGitRepoCheck`. `approval_policy = never` fails closed: exec "never ask[s] for approvals in headless mode" and rejects approval requests; dangerous commands become forbidden. The task 11 "unverified item" will pass.
- `codex mcp-server` deprecated 2026-08-24, removed 2026-09-05. App Server is JSON-RPC over stdio (also WebSocket and Unix socket), experimental, with `turn/steer` and approval requests to the client; an official Python SDK drives it.
- Codex subagents exist and inherit the sandbox.
- Spec section 6 escaping, section 7 routing, section 8 approval records, section 13 tests, and the build plan's task order are internally consistent with each other and with the decision log. Decisions D1 to D8 and R1 to R14 match what the plan and spec implement, with the exceptions in sections 1.6 and 1.7.

## 4. Settled decisions: all feasible

| Decision | Status after this review |
|---|---|
| D3 channel liaison, Manual/acceptEdits, no relay | Feasible. Interactive only, dev-flag confirmation each start (1.1), mode pinned explicitly (1.11). |
| D4 own plans, API-key mode built in | Feasible for both liaisons. `--bare` workers need an API key (1.2). |
| D5 8 hops, 20 turns, daily cap | Feasible; the cap needs a defined metric and source (1.3). |
| D7 TypeScript | Feasible. The TS SDK isn't labelled stable (2.6); nothing it lacks blocks Phase 1 once 1.4 is reworded. |
| D8 routing after the gate | Feasible through the hub (1.6), with `-p` workers rather than channel sessions on the Claude side (1.1, 1.2). |
| D2, D6, R10 | Confirmed; Phase 0 can start now. |

## 5. Scope and estimates

The build plan's task list is the right shape: trust path first, tests as "Done when", value (Codex CLI asking Claude for a review) at the end of Milestone A. The scope is realistic for a personal open-source tool. The hours are not.

| Item | Plan's figure | This review's estimate | Why |
|---|---|---|---|
| Phase 0 | 5 to 9 h | 5 to 9 h | Matches the plugin's size (v1.0.6, small). |
| Milestone A (tasks 1 to 10) | included in 15 to 25 h | 25 to 45 h | Escaping library with property tests (3), four-principal auth over a socket plus token files (4), console with CSRF, CSP, Host and Origin checks and the visibility pass (7), workspace manager with bare repos, sparse clones, environment allowlist and the repo-file guard (8), channel plugin with the pre-2026-07-28 handshake and the interactive launcher (10). Each is small, but each carries two to six gate tests. |
| Milestone B (tasks 11, 12) | included in 15 to 25 h | 10 to 20 h | Codex adapter, argv assertions, execpolicy, full gate run, re-review. |
| Trust controls and must-fix items | 9 to 18 h | folded into the above | They are the tasks now, not an add-on. |
| Routing milestone (13 to 15) | not estimated | 15 to 25 h | Registry, routes, fan-out, `-p` worker launcher, R1 to R9. |
| Phase 2 (App Server, console approvals) | in the 15 to 25 h | 10 to 20 h | Not in Phase 1's task list at all. |

So Phase 1 alone is roughly 40 to 70 h, against the plan's 24 to 43 h for Phases 1 and 2 together. The numbers in the plan came from the build-vs-adopt thread before the gate list existed; they were right for a prototype, and the gate list is what turned the prototype into the product. Suggested change: build plan "Phase 1 tasks" paragraph states 40 to 70 h for tasks 1 to 12 and marks it as the reviewer's range; plan "Phased plan" table gets the same. If the number is a problem, the one place to cut without touching the trust path is task 7: a Phase 1 console that is read-only timeline plus the `ask_human` panel plus Stop, with approvals and the composer arriving in Phase 2 when there is something to approve. That saves perhaps 5 to 8 h. Nothing else should be cut; the security review was explicit that the must-fix items are the point.

## 6. What was checked and how

- Read in full: the Architecture Plan (rev 101), `protocol-spec.md`, `phase1-build-plan.md`, `decision-log.md`, `starter/README.md`, `SECURITY.md`, `AGENTS.md`, `CLAUDE.md`, `LICENSE`, and the relevant sections of `security-review.md`, `build-vs-adopt.md` and `prior-art.md`.
- Vendor facts were fetched on 2026-10-09 from code.claude.com/docs (channels, channels-reference, cross-session-messaging, headless, cli-reference, permissions, permission-modes, auto-mode-config, sandboxing, settings-reference, env-vars, monitoring-usage, costs, mcp, claude-directory), modelcontextprotocol.io (2026-07-28 changelog), learn.chatgpt.com (codex-sdk, app-server, mcp, non-interactive-mode, subagents, changelog), and source at `github.com/openai/codex` (HEAD 47b8057) and `github.com/openai/codex-plugin-cc` (v1.0.6). Two research workers did the fetching; their reports are summarised here, and the quotes above are theirs.
- Not checked: anything in the security review's own findings (closed separately); the ChatGPT front door (Phase 3); OpenClaw claims (not in Phase 1); Anthropic's legal page wording on plan usage (the plan's reading is the stricter one, which is the safe side).
