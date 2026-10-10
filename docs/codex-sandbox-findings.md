# Codex liaison: what its sandbox does and doesn't stop

Build plan task 11 asks for these to be tested and recorded. Each line says how it was checked. "CI" means `test/gate/codex.test.ts`, which runs the pinned Codex CLI (0.157.0) on Linux; the Mac results come from the local gate steps.

| Attempt from inside the Codex sandbox | Result | Checked |
|---|---|---|
| Write inside the clone | Allowed | CI |
| Write outside the clone | Denied (read-only file system) | CI |
| Write to `/tmp` or `$TMPDIR` | Denied (`exclude_slash_tmp`, `exclude_tmpdir_env_var`) | CI |
| Write to the clone's `.git` (hooks, config, index) | Denied: Codex keeps `.git` read-only, so it can't commit either | CI |
| Network (HTTPS) | Denied | CI |
| Connect to a Unix socket (the hub's, or anything else) | Denied | CI |
| `terraform apply`, `kubectl`, `helm`, cloud CLIs, `docker push`, `ssh`, `git push`, `gh`, `npm publish` | Forbidden by execpolicy rules in the liaison's `CODEX_HOME` | CI checks the rules; the local gate checks a real refusal |
| **Read outside the clone** | **Allowed** | CI |

## The read gap

Codex's `workspace-write` sandbox limits writes and network, not reads. A Codex process can read any file jason's user can: the hub's token files and audit log, the Claude liaison's config folder, `~/.ssh`. What keeps that from mattering in Phase 1:

- Network is off and Unix sockets are blocked, so what it reads can only leave through the bridge, where the secrets scan parks the thread.
- The clone-time credential check (task 8) refuses to start a session when credential files are in the repo or near the clone.
- Its writes are limited to its clone, and the hub, not Codex, commits that work to the bare repo, where the repo-file guard scans it.

The fix is the "before unattended" step: run the hub and agents under separate OS users. Codex's beta permission profiles (`default_permissions` with `":root" = "deny"`) can deny reads, but they can't be combined with `sandbox_mode`, which the bridge pins and the argv guard checks; they stay unevaluated until they leave beta.

This belongs in SECURITY.md as well; that file is maintainer-owned, so the text above is offered for jason to add.

## How the liaison's work reaches you

Codex can't commit (its sandbox keeps `.git` read-only). After each turn the hub commits whatever changed in the clone to `agent/codex-liaison` in the project's bare repo. It does that with the bare repo as the git directory and a private index, so no git process ever reads the clone's own `.git`. Fetch it like the Claude side's branches: `git fetch bridge agent/codex-liaison`.
