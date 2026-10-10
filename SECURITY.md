# Security policy

## Status

LLM-Bridge (working name) is pre-release. Nothing is published, and there are no supported versions yet. This file describes how reports will be handled once the repository is public.

## Reporting a vulnerability

Please report privately through GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"). Don't open a public issue for a security problem.

You can expect an acknowledgement within 7 days. This is a one-maintainer, unpaid project, so fixes land as time allows, with trust-path issues first.

If the problem is in Claude Code, Codex, ChatGPT or another vendor's product rather than in this bridge, report it to that vendor as well.

## What we most want to hear about

The bridge's core promise is that an AI agent can never stand in for its human user. Anything that breaks that is in scope and high priority:

- An agent's message counted as the user's approval, or delivered as if the user wrote it.
- A message body that escapes its delivery wrapper (`</channel>`, `</bridge-message>`, lookalike characters, bidi tricks).
- A sender able to set hub-owned fields such as `from`, `provenance` or `hop`.
- An adapter credential accepted on a human-only endpoint, or any way around the console's Host, Origin, CSRF or content-security checks.
- Agent-written text rendered as HTML in the console.
- An agent reaching a git remote other than its local bare repo, or a credential, from inside the environment the hub gives it.
- Guard, rate-limit or kill-switch bypasses that let agents run on after the user stops them.
- Vulnerable or malicious dependencies.

## Known limitations

These are documented, not bugs:

- **Same OS user.** In v1 the hub and both agents run as the user's own OS account. An agent process that tries hard enough can read files the hub writes, including its tokens and audit log. Running the hub under a separate OS user, or the whole bridge in a VM, is required before unattended use. Until then, treat the audit log as a convenience, not evidence.
- **Preview APIs.** Claude Code Channels is a research preview, and a custom channel loads only with a development flag. The Codex App Server is experimental.
- **Prompt injection.** Agents read repos, pull requests and web pages that can contain instructions. That includes the `CLAUDE.md` and `AGENTS.md` in an agent clone, which the other side's agent can commit to and which a session reads before the user reviews that commit. The bridge contains what those instructions can do (the standing rule comes from hub-owned config, not the clone; deny rules, sandboxes, sparse clones without `.claude/` or `.mcp.json`, no credentials); it can't stop an agent from reading them.
- **Codex deploy tools.** Denies on deploy tools (`terraform apply`, `kubectl` and similar) for Codex rely on Codex's execution-policy rules. Where those can't express a rule, the hard guarantees on the Codex side are network off, no credentials and a write-restricted workspace, and the deny is instruction-level only.
- **Codex reads.** Codex's sandbox does not restrict reads outside its workspace, so until the hub runs under its own OS user a Codex process can read the hub's token files and audit log.

## Design references

- Threat model and trust rules: `docs/protocol-spec.md` section 2, and the architecture plan's Trust model.
- Independent security review: `docs/security-review.md`.
