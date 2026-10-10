# Build vs adopt: ChatGPT/Codex ↔ Claude Code bridge

Written 2026-10-09 for jason. Builds on [prior-art.md](prior-art.md) (what exists) and the sibling design thread (how a build would look). Analysis only; nothing is being built.

Effort figures are my estimates for one experienced developer working with Claude Code / Codex assistance. They are not measured, so treat them as ranges for comparison, not commitments.

## Bottom line

- **Don't build from scratch, and don't adopt one tool wholesale.** No existing tool does the two-liaison, two-way model. The cheapest route that does is a thin layer of your own glued onto official parts (Codex App Server or SDK, a Claude Code channel, a small message bus).
- **For your personal need, building that thin layer is worth it, but only if you need Codex to start conversations with Claude.** If "talk to each other" mostly means Claude hands work to Codex and gets results back, OpenAI's official `codex-plugin-cc` already does that for about an hour of setup, and building anything is poor payoff.
- **Commercial prospects are weak today.** Demand is real, but the shape of product you could legally ship is a free, local, bring-your-own-subscription tool, which is hard to charge for. Distribution is also gated by Anthropic's channel allowlist while channels are in preview. And both vendors have shown they will ship cross-vendor bridges themselves. Best realistic payoff is reputation and an open-source user base, not revenue.
- **Recommended path:** install `codex-plugin-cc` now (it becomes the Claude→Codex adapter either way), build the personal bridge with a model-neutral protocol so it stays open-sourceable, and revisit commercial only when specific signals appear (listed at the end).

## The three options

| | A. Adopt only | B. Build personal bridge on official parts | C. Build a product for others |
|---|---|---|---|
| What it is | Install `codex-plugin-cc`; optionally PAL MCP or OpenClaw for "ask another model" | Codex liaison (App Server / SDK) + Claude liaison (Claude Code session with a custom channel) + a small bus of our own (a few hundred lines, estimate) + loop guard + id persistence | B, plus installer, cross-platform support, docs, tests, security review, more model adapters; for paid: hosted relay, accounts, billing, support |
| Gives you | Claude→Codex delegation, reviews, resumable Codex threads, background jobs | Two persistent peers; either side can start a conversation; each coordinates its own sub-agents | Same, for other people |
| Doesn't give you | Codex starting work on Claude; one liaison per side; persistent peer conversation | Polished install; anything for other users | n/a |
| Up-front effort (est.) | 1–3 h setup, plus 3–6 h security review | Working prototype 15–25 h; daily-driver quality another 20–40 h | Open-source release: B + 60–120 h. Paid product: several hundred hours more |
| Ongoing upkeep (est.) | ~0 (vendor maintains it) | 2–4 h/month, spiky when a preview API changes | OSS: 5–15 h/month plus issues. Paid: a part-time job |
| Main risk | It's simply not the model you want | Preview APIs change under you | Terms, distribution gate, vendor ships it first |

## Time, effort and payoff

### A. Adopt only
- **Payoff:** high per hour. Covers the most common real use (second-opinion reviews, delegating a task to Codex and getting results back) with an official, maintained tool.
- **Cost:** near zero. Caveat from the prior-art research: its optional Stop-hook review gate can loop and burn usage, so leave it off at first.
- **Verdict:** do this regardless. Even under option B, this plugin is the natural Claude→Codex adapter.

### B. Build the personal bridge
- **What the hours buy beyond A:** Codex can initiate work on Claude; both liaisons keep long-lived context; you get the "one agent per side" structure you described rather than Claude-as-boss.
- **Why it's cheap relative to C:** the hard parts (hosting a persistent Codex thread, pushing messages into a running Claude Code session) are official. Your code is the bus (write a small one; see the security-review section), the loop/depth guard, persisting thread ids, and permission handling.
- **Where the hours actually go** (from the gotchas in prior-art.md): lost thread ids, long tasks hitting tool timeouts, recursion between agents, unattended permission prompts, sandbox and credential friction on macOS. Expect the first prototype to work quickly and the "trust it unattended" stage to take longer than the prototype.
- **Hidden running cost:** two agents talking spend usage on both your plans. Agent-to-agent chatter can eat limits quickly without a depth guard and per-conversation budget. (Separately, OpenAI says existing $200 ChatGPT Pro subscribers drop from 20x to 10x Plus usage on 2026-10-29, per [WorkOS](https://workos.com/blog/sign-in-with-chatgpt-plan-usage-scope).)
- **Maintenance reality:** Codex App Server is documented as experimental and Claude Code channels are a research preview. OpenAI deprecated and removed `codex mcp-server` within about two weeks (2026-08-24 → 2026-09-05). Plan on occasional breakage.
- **Terms:** fine for personal use. Anthropic's terms allow you to sign in to the unmodified Claude Code binary with your own subscription; a custom channel during the preview needs the `--dangerously-load-development-channels` flag on your own machine ([channels docs](https://code.claude.com/docs/en/channels)). Codex runs under your own ChatGPT login.
- **Verdict:** worth it if you'll use Codex-initiated or genuinely back-and-forth work weekly. If after a couple of weeks on option A you rarely miss it, stop there.

### C. Build a product
See the commercial section. The extra effort is mostly not the bridge itself; it's install experience, platform coverage, security, and support.

## Commercial viability

### In favor
- **Demand is real.** OpenAI's official plugin for Claude Code (≈32.7k stars) and the many DIY bridges show people want these tools to work together.
- **The two-way, model-neutral niche is open.** Existing two-way bridges are v0.1–0.2 with near-zero adoption, and nothing has become the default.
- **Your personal build is the MVP.** If B is built with a neutral protocol, the incremental cost to open-source it is moderate.

### Against
1. **What you're allowed to ship limits how you can charge.** Anthropic's [legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) says a product may run the unmodified Claude Code binary only if each end user signs in with their own subscription or API key, and the product may not "pay for, resell, or intermediate Claude usage." Products built on the Agent SDK must use API keys, not subscriptions (enforced since early 2026; Anthropic cut subscription coverage for OpenClaw and similar harnesses on 2026-04-04). You also can't use "Claude Code" in the product name. So the viable shape is a local, bring-your-own-accounts tool, and you can't make money on usage.
2. **Distribution gate on the Claude side.** During the preview, `--channels` only loads plugins on Anthropic's allowlist (or an org's own list). A third-party bridge would tell every user to run a "dangerously" flag, or fall back to polling, which is less real-time. Until channels go GA or you get allowlisted, this is a real adoption barrier.
3. **OpenAI side is more open but still gated for paid products.** Running the user's own Codex is fine. OpenAI's new "Sign in with ChatGPT" plan-usage program (DevDay, 2026-09-29) targets open-source and locally hosted apps; paid or hosted products go through an interest form ([WorkOS summary](https://workos.com/blog/sign-in-with-chatgpt-plan-usage-scope)).
4. **Vendors are building this themselves.** OpenAI shipped an official plugin into its competitor's tool in March 2026. Neither CLI speaks A2A yet, but either vendor adding native cross-agent messaging, or the other direction of the plugin, would remove most of the product's reason to exist.
5. **Comparable products monetize poorly at the local tier.** Conductor (parallel Claude Code / Codex / Cursor agents) is free locally with your own subscriptions and charges $50/month only for cloud workspaces and collaboration ([review](https://vibecoding.app/blog/conductor-review)). Most other players in this space are free open source. A local bridge has no obvious paid hook; a hosted relay for teams or cross-machine use is the most plausible one, and that's the expensive part to build and operate.
6. **"Soundiiz for LLMs" is harder than Soundiiz.** Soundiiz moves static data between services with stable APIs. Here the "services" are live agent runtimes with preview APIs and terms that forbid intermediating usage. The idea isn't wrong, but the moat would be adapter maintenance, which is ongoing labor.

### Realistic outcomes (my judgment, not data)
- **Most likely:** an open-source tool with a modest following, little or no revenue, real value as reputation and portfolio. Moderate upkeep.
- **Upside:** it becomes the default community bridge before vendors close the gap, which could lead to sponsorship, consulting, a hosted team tier, or acquisition interest. Low probability, needs fast execution and active promotion.
- **Downside:** a vendor ships native interop within months and usage drops to near zero. You still keep the personal tool.

### Signals that would change the commercial answer
- Claude Code channels leave research preview, or Anthropic opens allowlisting to third parties.
- After you open-source it, it gains traction without paid promotion (for example, a few hundred stars or recurring issues from strangers within a couple of months).
- People ask for a hosted/team version.
- Six months pass without either vendor shipping native two-way interop.

## Risk: an agent passing itself off as you (approval spoofing)

jason's question (2026-10-09): could one agent treat the other as jason and accept approvals he never gave? Earlier research covered unattended permission prompts and agent recursion, but not this. It is a real risk, and it should shape the build.

### Where the risk actually sits
- **Hard approvals** (the permission prompts in Claude Code and Codex) are answered in each tool's own interface, not by the model. A message from the other agent can't click "allow" on its own. The danger begins when something routes those prompts to a place an agent can answer, or when a side runs with approvals turned off.
- **Soft approvals** are the bigger gap: conversational go-aheads like "jason says ship it" or "approved, proceed." If a liaison runs with broad auto-approval, its only gate is its own judgment about who said what. A message from the other agent that quotes or imitates jason can pass that gate.

### How existing options handle it
| Option | Handling | Gap |
|---|---|---|
| `codex-plugin-cc` | Codex output comes back to Claude as a tool result, not as a user message. Claude Code's prompts stay in your terminal. Codex runs under its own local sandbox and approval policy. | Low risk at default settings. Risk rises if you run either side with approvals off, or let Claude act on "the user approved" text inside Codex output. |
| Claude Code channels | Messages arrive tagged with their source, separate from what you type, and only allowlisted senders get through. | **Permission relay**: per the [channels docs](https://code.claude.com/docs/en/channels), "anyone who can reply through the channel can approve or deny tool use in your session." If the Codex liaison can send on a channel that relays prompts, it can approve Claude's actions. This is exactly your scenario. |
| Codex App Server | Approval requests go to the client program, which decides who answers. Policies include `never` and `unlessTrusted`. | Safe only if the bridge sends those requests to you. If the bridge auto-answers them or forwards them to Claude, Claude becomes the approver. (Inferred from the App Server docs; the approval flow isn't fully documented there.) |
| mcp_agent_mail | Agents have names and the server supports bearer/JWT auth. Human messages come from a special "HumanOverseer" sender with a "MESSAGE FROM HUMAN OVERSEER" banner. | The human marker is a sender name plus banner text; nothing documented stops an agent from copying the banner into its own message, and the docs don't say the sender is bound to the authenticated identity. Don't treat it as proof of you. |
| OpenClaw | One primary agent relays and steers both sessions. | Not verified how ACP permission requests are answered. In a hub design, the relaying agent is the obvious place for spoofed approval to happen, so check before relying on it. |
| Community two-way bridges | Mostly drive `claude -p` / `codex exec` headless with approvals preconfigured or skipped, plus depth guards. | Highest risk: with approvals off, nothing separates "the other agent said so" from "jason said so." |

### What a custom build needs (and why this favors building the glue yourself)
1. **Approvals never travel on the agent bus.** Permission prompts from either side go only to a human-only channel (your terminal, or a phone notification) that neither agent can write to. Don't enable channel permission relay on the bus channel.
2. **Approvals checked by code, not by a model.** When you approve, the bridge records an approval for that specific action. Liaisons can't create one, and text like "jason approved" carries no weight.
3. **Every bus message is labelled as coming from an agent**, and each liaison has a standing rule that the other agent's messages are information, never your approval. The bridge escapes text that imitates your messages or system markers before delivering it.
4. **No bypass modes for consequential actions.** Use sandboxes and allowlists for routine work; destructive or outward-facing actions (push, deploy, delete, send) always go to you.
5. **Audit log** of who asked for what and who approved it.

Estimated cost: roughly 5–10 extra hours on the personal build (my estimate). It also strengthens the commercial case slightly: provable "only the human approves" is a trust feature none of the existing two-way bridges offer.

## Cost of security-reviewing what we adopt

jason's condition (2026-10-09): any existing tool we adopt gets a security code review first. That cost belongs on the adopt side, and so does re-reviewing each upstream update. A full audit isn't part of this analysis; this sizes the job so it can be compared.

Hours are my estimates for a focused review with AI assistance: permission handling, network exposure, credential handling, install scripts, and pinned dependencies scanned with tools (npm audit, pip-audit, osv-scanner) rather than read by hand. Size facts are from each GitHub page or the npm registry on 2026-10-09.

| Candidate | Size and shape | What a review must cover | Initial review (est.) | Re-review per update (est.) |
|---|---|---|---|---|
| `codex-plugin-cc` (official OpenAI) | Small: 29 commits, TypeScript/Node, a plugin folder, scripts, tests. Uses your installed `codex` binary and your Codex config. | The hooks it installs (SessionStart; optional Stop review gate), how it starts Codex and with what sandbox/approval settings, what it reads from your transcript for `/codex:transfer`. | 3–6 h | ~1 h; slow-moving so far |
| Small community two-way bridges (Borda, claude-codex-bridge, etc.) | Small, single-author, v0.1–0.2. | Usually run agents headless with approvals preconfigured or skipped, which is the spoofing risk above. | 2–4 h | Low, but upstream may go quiet |
| coder/agentapi | Medium: Go, 276 commits, HTTP server on port 3284 driving the agent's terminal. | Its HTTP API documents no authentication, only a localhost Host check and CORS list. Any local process could post a message to the agent, which overlaps directly with the spoofing risk. | 6–12 h | 1–2 h |
| mcp_agent_mail | Large: 863 commits, Python 3.14, FastMCP HTTP server on port 8765, web UI with several JS libraries, SQLite, Git, signing/encryption libraries, `curl … \| bash` installer. | Server auth (bearer/JWT), web UI (XSS/sanitising), installer script, sender-identity binding (see spoofing section), many dependencies. Very active, so frequent updates. | 15–30 h | 2–4 h, often |
| PAL MCP server | Large: 1,150 commits, Python, many provider integrations, spawns other CLIs. | How `clink` launches CLIs and with what permissions, handling of several providers' API keys in `.env`. | 15–30 h | 2–4 h |
| OpenClaw | Very large: npm package 2026.9.9 is ≈390 MB unpacked, ≈13,400 files, 66 direct dependencies; fast release cadence. | Gateway, chat-app connectors, plugin system, ACP harness control; tools run on the host unless sandboxed. | Full review impractical for one person. Scoped review of gateway + ACP path: 40 h+ | Hard to keep up with |

What this changes:
- **Option A stays cheapest.** The official plugin plus its review is roughly 5–9 h up front instead of 1–3 h.
- **The bus should be our own, not mcp_agent_mail.** Reviewing mcp_agent_mail (15–30 h, then frequent re-reviews) costs about as much as writing a minimal bus, and a small bus we wrote is quicker to review and can enforce the approval rules above. Keep mcp_agent_mail as a design reference.
- **OpenClaw drops further** for this use. It can't be reviewed at reasonable cost, so adopting it would mean trusting it and sandboxing it.
- **Our own code needs review too,** but it is small and we know it. Budget a few hours of review per milestone.
- **Pin versions and review diffs** for anything adopted; don't auto-update.

## Recommendation

1. **Now:** review `codex-plugin-cc` (3–6 h, estimate), then install and use it. Free, official, and reused later as the Claude→Codex adapter.
2. **If you want two-way peers (your stated model):** build option B, prototype first, with human-only approvals from day one (see the approval-spoofing section) and our own small bus rather than mcp_agent_mail (see the security-review section), with the bus protocol model-neutral (addressed messages and threads, one adapter per model family). Keeping it open-sourceable costs maybe 10–20% more than a throwaway rig.
3. **Defer commercial.** Don't spend effort on installer, billing, or hosting until the signals above show up. If they do, open-sourcing is the cheap first step and tells you whether a paid tier makes sense.

## Decision for jason

Which goal should the next step serve?
- **Personal, open-source-ready (recommended):** build option B with a neutral protocol; commercial revisited later on evidence.
- **Adopt only:** use `codex-plugin-cc`, build nothing for now.
- **Product from the start:** design for other users now; much more effort, weak revenue prospects today.
