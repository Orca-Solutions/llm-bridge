# LLM-Bridge (working name)

Let a Codex agent and a Claude Code session talk to each other directly, with you as the only one who can approve anything.

> **Status: design only.** Nothing is built yet. The docs here are the plan; code comes after the maintainer green-lights Phase 1.

Not affiliated with or endorsed by Anthropic or OpenAI. Claude, Claude Code, Codex and ChatGPT are their owners' trademarks.

## What it does

Each side gets one long-lived **liaison** agent, and each liaison coordinates its own side's agents natively. A small local **hub** passes messages between them.

```
 you ──terminal──▶ Claude liaison (Claude Code)          Codex liaison (Codex SDK) ◀──console── you
                        │   ▲                                    ▲   │
                channel │   │ bridge tools          bridge tools │   │ new turn
                        ▼   │                                    │   ▼
                  ┌──────────────────────── Bridge hub ─────────────────────────┐
                  │ message store · router & guards · console · kill switch     │
                  └─────────────────────────────────────────────────────────────┘
```

- Codex can ask Claude for a review, hand it a task, or hold a capped multi-turn conversation, and the reverse.
- Every send returns at once; the answer arrives later as a new turn, so long tasks don't hit tool timeouts.
- You watch both sides in a local console, can join the conversation, and can stop everything.

## The trust model, in one paragraph

Agents never stand in for you. The hub stamps who sent each message; agents can't set it. No message can be an approval: approvals happen only at Claude Code's own permission prompt in your terminal, or with a click on the console. Peer messages are escaped so they can't break out of their wrapper or imitate you. The Claude liaison never runs in auto mode, and both agents work in clones of a local bare repo with no credentials, so pushing to GitHub stays with you. Full rules: [docs/protocol-spec.md](docs/protocol-spec.md) section 2, and [SECURITY.md](SECURITY.md).

## Requirements (planned)

- macOS or Linux, with Node (the bridge is TypeScript)
- Claude Code, signed in with your own plan or API key. Custom channels currently need the `--dangerously-load-development-channels` flag while Channels is in preview.
- Codex, signed in with your own ChatGPT plan or API key

Each user brings their own accounts. The bridge never touches vendor login tokens and never pays for, resells or intermediates anyone's usage.

## Roadmap

1. **Phase 0:** trial OpenAI's official `codex-plugin-cc` first.
2. **Phase 1:** hub, console, Claude liaison over a channel, Codex liaison over the Codex SDK, with every security gate test passing.
3. **Routing, right after the Phase 1 gate:** each liaison routes to projects on its own side (for example, an app team on Claude asking devops on Codex), through a hub-checked allowlist.
4. **Phase 2:** Codex App Server, Codex approvals on the console.
5. **Later:** more models as new adapters, other users, an optional ChatGPT front door, each with its own review.

## Docs

- [Protocol spec](docs/protocol-spec.md): message format, tools, wrapper, auth, guards
- [Phase 1 build plan](docs/phase1-build-plan.md): tasks with their done criteria
- [Decision log](docs/decision-log.md): what was decided and why
- [Security review](docs/research/security-review.md)
- [AGENTS.md](AGENTS.md): rules for AI agents working on this repo

## License

[Apache-2.0](LICENSE).
