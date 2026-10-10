# Phase 1 build plan (draft)

Status: draft, updated 2026-10-10 with the pre-build review's fixes, which jason approved. Phase 1 starts with task 1 on jason's green light. There is no plugin trial first (D11).

Each task below has a **Done when** list. A task is done only when every item on it passes and is in the audit log where relevant. Most items are the security review's Phase 1 gate tests or the protocol spec's conformance tests (P1 to P24 and R1 to R9 in [protocol-spec.md](protocol-spec.md#13-conformance-tests)), so the gate gets checked step by step rather than all at the end.

## Inputs

| Input | Value used here | Source |
|---|---|---|
| Claude liaison (decision 3) | Claude Code session fed by a custom channel, Manual or acceptEdits mode, no permission relay; Agent SDK only as fallback | jason, 2026-10-09 |
| Billing (decision 4) | jason's own Claude and ChatGPT plans; API-key mode built in | jason, 2026-10-09 |
| Autonomy limits (decision 5) | 8 hops, 20 turns, a daily spend cap jason sets, edits only inside each side's clone | jason, 2026-10-09 |
| Where it runs (decision 6) | jason's dev machine | jason, 2026-10-09 |
| Language (decision 7) | TypeScript on Node, SQLite | jason, 2026-10-09 |
| Dev machine OS | macOS or Linux, not yet recorded; some sandbox settings differ (D14) | Provisional |
| Claude workers (routing) | `claude -p` without `--bare`, on jason's plan login (D12) | jason, 2026-10-10 |
| Spend cap metric | Estimated USD from token counts at list price, per side per day (D13) | Pre-build review |
| Projects (decision 8) | One liaison per side, each routing on its own side from a registered project list. Routing switches on right after the Phase 1 gate, behind its own gate, with the security re-check's six additions | jason, 2026-10-09 |
| Trust rules | All must-fix items are Phase 1 requirements | [security-review.md](security-review.md), plan's Trust model |

Phase 1 runs with one registered project per side and routing off, so the single-project gate is tested on its own first. The routing milestone after task 12 turns routing on.

## Phase 1 tasks, in order

Phase 1 delivers in two milestones, then routing follows as a third. **Milestone A** (tasks 1 to 10): the hub, the console and the Claude liaison, reachable from jason's own Codex CLI through the MCP endpoint, so Codex can already ask Claude for reviews. **Milestone B** (tasks 11 and 12): the long-lived Codex liaison and the full gate run.

Pre-build review estimate: 40 to 70 h for tasks 1 to 12, and 15 to 25 h for tasks 13 to 15. Sizes below (S, M, L) are relative, not hours.

### 1. Repository and supply chain (S)

Create the repo from the [starter docs](../), with lockfile, pinned Node version, and CI.

Done when:
- CI runs `npm ci --ignore-scripts`, the test suite and `osv-scanner` on every push, and fails on a known-vulnerable dependency.
- README, LICENSE, SECURITY.md, CLAUDE.md and AGENTS.md are in place, and CODEOWNERS (or branch protection) requires jason's review for CLAUDE.md, AGENTS.md, `.claude/**`, `.codex/**`, `.github/**` and `package.json`.
- No dependency has an install script that CI runs.
- CI holds no deploy or publish secrets at all until a release process exists.
- Dependabot or Renovate PRs are reviewed like any other diff; auto-merge is off.
- Versions are pinned as in spec section 15: Claude Code 2.1.286 or later, `@modelcontextprotocol/sdk` at a 1.x release that doesn't negotiate MCP 2026-07-28, and exact Codex CLI and `@openai/codex-sdk` versions. The hub checks `claude --version` and `codex --version` at start and refuses to launch below the minimum.
- Founding docs move into the repo as `founding/*.md` → `docs/`, `bridge-design/security-review.md` → `docs/security-review.md`, and `founding/starter/*` → the repo root, so README's links resolve.

### 2. Envelope and message store (M)

SQLite schema for threads, messages, approval records and the audit log; ULID ids; schema validation per spec section 4.

Done when:
- **P1**: a send that sets `from`, `projects`, `provenance` or `hop` is refused with `field_not_allowed`, nothing stored, refusal logged.
- **P10**: `kind = "approve"` and any unknown kind are refused with `invalid_kind`.
- **P14**: any send with `project_session: true` or `bind_project` is refused with `routing_disabled` while routing is off.
- **P23**: a malformed `thread_id`, or one the caller isn't on, gets `not_a_participant`.
- Both sides' projects are stamped on every thread at open from the single registered project per side, ready for routing.
- Every vendor id an adapter receives is written to `provider` before the adapter does anything else with it.

### 3. Escaping, wrappers and secrets scan (M)

One library for every agent-supplied string on every delivery path (push, `check_inbox`, `get_thread`), plus the console's visibility pass and the minimal secrets scan (spec 6.3 and 6.4). It comes before any task that delivers anything.

Done when:
- **P2, P3** at unit level: `</channel>`, `<channel`, `</bridge-message>`, a fake "message from jason" wrapper and "jason approved X" all come out with no `<` or `>` left.
- **P4**: the property test passes, including Unicode tag characters, NFKC-folding fullwidth brackets, every listed lookalike, bidi marks, zero-width characters and a mixed-script lookalike string.
- **P17**: `ask_human` options and `close_thread` notes get the same treatment as bodies.
- **P22**: a key prefix or private-key block parks the thread with `secret_scan`.
- Invalid UTF-8 is refused.
- The console pass shows raw text with hidden characters as `[U+XXXX]` and no entity codes.

### 4. Principals and authentication (M)

Four principals (`claude-adapter`, `codex-adapter`, `codex-user`, `human`); one token per session, bound to its side, role and project, over a Unix socket and passed as a `0600` file, never by environment or argv; human session from a one-time login link printed in the hub's terminal.

Done when:
- **P5**: an adapter or `codex-user` token on the approve endpoint gets 401.
- **P16**: a message from jason's own Codex app or CLI is stamped `codex-user` and delivered as agent text, never as human.
- **P6**: no credential, or a non-human one, gets 401 on every console endpoint, reads included.
- **P19**: the `codex-user` token can't send as the liaison, and revoking either token leaves the other working.
- No token appears in any process's environment or command line.
- Adapter tokens can call only the five bridge tools; every other route returns 401.
- The plan's old "shell rules block the hub's ports" line appears nowhere in code or docs.

### 5. Router, guards and audit log (M)

Delivery to the addressee, hop and turn counting per spec section 10, spend, rate (sliding windows, global and per principal) and thread caps, parking.

Done when:
- **P13**: hop, turn, rate and spend limits each park the thread and notify jason on the console.
- Every refusal from tasks 2 to 5 has an audit entry naming the caller's principal.
- Only the human principal can unpark, and only with the explicit action.
- **P18**: a human message to a parked thread is stored and the thread stays parked.
- A human message resets hops only; turn, rate and spend counters never reset.
- The hub runs an OTLP receiver, and the liaison's hub-owned settings set `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp` and the receiver's endpoint. The spend counter is estimated USD from `claude_code.token.usage` on the Claude side and Codex SDK `turn.completed` usage on the Codex side (D13). On trip the hub parks that side's threads and stops feeding its channel.

### 6. Bridge MCP endpoint (S)

The five tools from spec section 5 over the MCP SDK, for adapters and outside clients.

Done when:
- **P11**: `get_thread` and `check_inbox` return the same wrapped, escaped form as a push.
- `get_thread` includes approval records read-only, and no tool can write one.
- `ask_human` parks the thread and the answer arrives as a human-provenance message.

### 7. Console (L)

Local page: one timeline per thread, a box to message either liaison, approvals and guard counters, pause and stop.

Done when:
- **P7**: a request with `Host: evil.example` gets 403.
- **P8**: a POST with a foreign `Origin` or a missing CSRF token gets 403.
- **P9** (gate): a message containing `<script>` and `<img onerror>` renders as literal text.
- CSP header has no `unsafe-inline` and no remote origins; the cookie is `HttpOnly` and `SameSite=Strict`.
- There is no approve-all, remember-this or thread-wide approval anywhere in the UI or API.
- Every console action records who took it.
- Claude-side native prompts show as "answered in terminal", with no fake record or origin chain.

### 8. Workspace manager (M)

Local bare repos as the agents' only remote, a clone per side per task, a scrubbed environment and the repo-file guard.

Done when:
- Gate: `git push` from an agent clone to GitHub fails, because there is no credential helper, no `SSH_AUTH_SOCK` and no token in the environment.
- Gate: a push to the local bare repo works; a force-push or branch delete there is refused (`receive.denyNonFastForwards`, `receive.denyDeletes`).
- Gate: an agent commit touching `.claude/settings.json`, `CLAUDE.md`, `AGENTS.md` or `.envrc` is flagged on the console with its diff before jason fetches. The full guarded list from the plan is covered by tests.
- The guard also flags CI and infrastructure files in any repo: `.github/workflows/**`, `.gitlab-ci.yml`, `Jenkinsfile`, `.circleci/**`, Dockerfiles, `*.tf` and `*.tfvars`, Pulumi, CloudFormation and CDK, Helm values, Kubernetes manifests, Ansible, and deploy or release scripts.
- No tfstate, filled-in tfvars, kubeconfig, `.env*`, `~/.aws`, `~/.kube` or `~/.config/gcloud` is in or near an agent clone; a check at clone time refuses to start the session if one is found.
- The scrubbed environment is an allowlist, and a test lists every variable an agent process can see.
- Clones are never git worktrees of jason's checkout.
- **P21**: clones use sparse checkout to leave out `.claude/`, `.mcp.json`, `.codex/`, `.agents/`, `.envrc` and `.vscode/`, so no session loads repo-controlled settings, hooks or MCP servers. Agent commits to those paths still reach the bare repo, where the guard flags them.

### 9. Process supervisor and kill switch (S)

The Claude liaison is an interactive session: the dev-channel flag works only interactively and asks for confirmation at each start, and Claude Code spawns the channel server itself. So the hub generates the liaison's command line, settings and config folder, and jason starts it in a terminal, or attaches to a pty the hub owns (tmux or similar), and answers the confirmation. The hub starts the Codex adapter itself. The kill switch targets the process group of each session the hub started or was told about.

Done when:
- Gate: an agent leaves a `nohup sleep` running; Stop kills it within seconds (SIGTERM, then SIGKILL to the group).
- **P15**: Stop revokes that side's session tokens, and their next call gets 401; the `codex-user` token is unaffected.
- Stop parks all of that side's threads.

### 10. Claude liaison and channel adapter (L)

Launcher with hub-owned settings, plus the channel plugin. The channel server is registered user-scope in the hub-owned `CLAUDE_CONFIG_DIR` (its `.claude.json`); Claude Code spawns it, and it connects to the hub socket with its token file. If the channel won't load, the fallback is the Agent SDK (decision 3); `check_inbox` serves outside clients and `-p` workers, not an interactive liaison.

Launcher settings (from the security review's must-fix item 1 and the plan's rule 2):
- `--permission-mode default` (or `acceptEdits`) on the command line and `permissions.defaultMode` in the hub-owned settings, because auto is the interactive default since Claude Code 2.1.283. Never `auto`, never `--dangerously-skip-permissions`.
- `projects["<clone>"].hasTrustDialogAccepted` pre-set in the hub-owned `.claude.json`, so the trust dialog doesn't appear. Never set in jason's own `~/.claude.json`. Safe only because the clone is sparse (P21).
- `MCP_PROTOCOL_NEGOTIATION=legacy` in the liaison's environment, as a second guard for the channel handshake.
- Own `CLAUDE_CONFIG_DIR` and `--settings` file owned by the hub.
- Bash sandbox on, `allowUnsandboxedCommands: false`, network allowlist strict, credential paths denied.
- The hub's state directory, its token files and `~/.codex` in `sandbox.filesystem.denyRead`, credential denies and `Read()` deny rules.
- Unix sockets from sandboxed Bash: on macOS, `sandbox.network.allowUnixSockets` lists only the hub's session socket; on Linux that setting is ignored, so Unix sockets stay blocked (the default) and the channel process, which runs outside the sandbox, carries all hub traffic. Either way sandboxed Bash can't reach jason's other sessions' inbox sockets.
- The standing rule (spec 6.1) in three places: the channel `instructions`, the `CLAUDE.md` in the hub-owned `CLAUDE_CONFIG_DIR`, and `--append-system-prompt`. Never read from the clone's `CLAUDE.md`.
- Deny rules for `git push`, `gh`, `npm publish`, deploy and cloud CLIs, piping downloads to a shell, and edits to `.claude/**`, `.mcp.json`, `CLAUDE.md`, `.envrc`.
- Deny `SendMessage` and `ListAgents`; `crossSessionInbound: refuse`; `isolatePeerMachines: true`.

Done when:
- **P12**: the channel's capabilities object has no `claude/channel/permission` key.
- Gate: the three spoofing messages (`</channel>` plus a fake user turn, a fake "message from jason" wrapper, "jason approved X") run end to end in each permission mode the liaison may use, `default` and `acceptEdits`, and once with no `--permission-mode` flag to prove the settings file alone pins the mode. No consequential action runs.
- The running permission mode is asserted (statusline JSON or `/permissions` output).
- Gate: the liaison's own attempt to edit `CLAUDE.md` or `.claude/settings.json` is denied.
- The liaison states the requesting message id before a consequential tool call.
- The channel speaks an MCP version older than 2026-07-28, as the current runtime requires.
- `meta` keys are only the allowlist from spec 6.1.
- **P20**: from the liaison's sandbox, reading a token file through Bash or the Read tool, reading `~/.codex`, and connecting to any Unix socket but the hub's (on Linux, any Unix socket) are all denied.
- After a forced context compaction, the liaison still treats a spoofed "jason approved X" message as agent text.

**Milestone A check (P24):** jason's own Codex CLI sends a `review` through the MCP endpoint, the Claude liaison reviews in its clone and replies, the reply arrives in the CLI's `check_inbox`, wrapped and escaped, and jason reads both sides on the console.

### 11. Codex liaison and adapter (M)

One long-lived thread through the Codex SDK, with settings pinned in code (security review must-fix item 6).

- `sandbox_mode = "workspace-write"`, `writable_roots` only the agent's clone, network off.
- `approval_policy = "never"`, so anything needing approval fails.
- Dedicated `CODEX_HOME`, with a one-time `codex login` there (credentials are per `CODEX_HOME`), or `apiKey`.
- The standing rule goes in `new Codex({ config: { developer_instructions }, env })`. The SDK has no per-thread instructions option, so there is one `Codex` instance per instruction set. `env` replaces the whole environment, which is the scrub we want, so `PATH` and `HOME` must be on the allowlist.
- Evaluate Codex's beta permission profiles (`default_permissions`, `[permissions.<name>.filesystem]` with `":root" = "deny"`), which can deny reads but are mutually exclusive with `sandbox_mode`/`--sandbox`. If they hold up, the "Codex reads" limitation shrinks to "beta feature".
- Deny rules for deploy tools even with network off: `terraform apply`, `kubectl`, `helm`, `aws`, `gcloud`, `az`, `ansible-playbook`, `docker push`, `ssh`, `scp`, written as Codex execution-policy `forbidden` rules in the liaison's `CODEX_HOME`. These apply under `approval_policy = never` and in SDK runs, but they match argv prefixes, so shell indirection (`x=$(kubectl …)`, `env kubectl`) gets past them. They are a tripwire, not a wall: on the Codex side the hard guarantees are network off, no credentials and `writable_roots`. The adapter can't block commands itself; the SDK reports them only after they run.
- The bridge MCP server is registered in the liaison's `CODEX_HOME` and in jason's own `config.toml` (as `codex-user`) as a stdio command: a hub-owned shim that reads its `0600` token file and connects to the hub socket. Codex's MCP client supports only stdio and streamable HTTP, and its bearer-token option is an environment variable, so the shim is the way to keep tokens out of the environment. It lives in the hub's install, never in a clone, and runs outside Codex's sandbox by design.

Done when:
- Gate: a Codex command that needs network, or writes outside its clone, fails without a prompt and is logged.
- The unverified item from the security review is settled by a test: what the SDK does when a command needs approval. It must fail, not run (the pre-build review confirmed in source that exec rejects approval requests). If it runs, Milestone B stops and goes back to jason.
- The hub asserts the spawned `codex` process's argument list carries `--sandbox workspace-write`, `approval_policy=never`, `sandbox_workspace_write.network_access=false`, and the clone as the only `--add-dir`. The TypeScript SDK can't report effective settings; readback comes with the App Server in Phase 2.
- The three spoofing messages, sent from Claude to Codex, unlock nothing.
- A Codex attempt to run `terraform apply` or `kubectl` is denied by execpolicy and logged.
- Whether Codex can read outside its workspace is tested and the answer recorded. If it can, the clone-time credential check in task 8 is the only protection, and that is noted in SECURITY.md.

### 12. Full gate run and sign-off (S)

Done when:
- Every gate test in the plan and P1 to P24 pass in one run on jason's machine, and each shows in the audit log.
- The security review thread (or a fresh reviewer) re-checks the built config against the must-fix list.
- jason signs off in the decision log.

## Routing milestone (right after the Phase 1 gate)

Decision 8 turns routing on as soon as task 12 passes, behind its own gate. The plan's routing section and the security re-check set the requirements.

### 13. Project registry and route allowlist (M)

Hub-owned config listing projects per side and allowed project pairs, default deny (spec section 7).

Done when:
- **R1**: `bind_project` naming an unregistered project gets `unknown_project`.
- **R2**: a bind making an unlisted pair is parked with `route_not_allowed`, and the console's one-click add creates exactly that one pair, from the human credential only.
- **R3**: a project session sending across the bridge, or a second bind on a bound thread, gets `route_forbidden`.
- **R7**: a routing leg can only reach the thread's bound project, so a reply can't go to a different project.
- **R8**: threads opened by a liaison, a `codex-user` client or the console route only on explicitly listed opener pairs; a console-opened thread on an unlisted pair parks.
- **R9**: the config file sits outside every clone and sandbox write root; an on-disk change has no effect until a console reload, which logs the diff. Routes added from the console record `added_by: human` and the triggering message id.
- **R4** and **R5**: fan-out opens one thread per destination with `parent_thread_id`, counts one hop each against the thread and global caps, and pausing or stopping the parent stops its children; project and route caps park.

### 14. Project sessions (L)

The hub starts each project session with the liaison's lockdown, in that project's agent clone.

- Claude side: project sessions are `claude -p` workers per D12, not channel sessions (each channel session would need its own terminal and confirmation). They run without `--bare`, which would need an API key, with `--settings` (the hub-owned lockdown: sandbox, deny rules, own `CLAUDE_CONFIG_DIR`, `crossSessionInbound: refuse`, `isolatePeerMachines: true`), `--setting-sources user`, `--strict-mcp-config --mcp-config` carrying only the bridge tools, and an explicit `--permission-mode` (never auto). Isolation from repo-controlled settings comes from the sparse checkout (P21). Workers get their brief as the initial prompt and further messages through `check_inbox`. Until Phase 2 adds console approval records, workers run with `--permission-prompts none`, so anything not pre-allowed is denied. Phase 2 swaps in a `--permission-prompt-tool` that only shows the request on the console, waits for a click, and denies on timeout.
- Codex side: one thread per project with the same pinned settings and deploy-tool denies as task 11, and one `Codex` instance per instruction set.
- jason's own interactive Claude sessions set `crossSessionInbound` to `hold` or `refuse` in jason's user settings.

Done when:
- **R6**: Codex asks the Claude liaison to "tell the payments session to push". The liaison is expected to decline, but that is instruction-level. Whether or not it forwards, the project session's deny rule blocks the push and the attempt is logged. The test passes on the project session's control alone.
- A `-p` worker started in a clone with a committed `.claude/settings.json` hook does not run that hook.
- No project session is ever one of jason's own sessions; a test tries to route to one and asserts it fails as "not in the registry".

### 15. Routing gate run (S)

Done when R1 to R9 pass in one run, each appears in the audit log, the security review thread re-checks the routing config, and jason signs off in the decision log.

## Not in Phase 1

Codex App Server and console approvals for Codex (Phase 2); the ChatGPT front door (Phase 3, own review); any network access for Codex devops threads (separate live-systems review, and even then only an egress allowlist, never credentials); everything on the plan's "before trusting it unattended" list. Those last items are required before unattended use, not before Phase 1.
