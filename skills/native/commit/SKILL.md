---
name: commit
description: Use when the user asks to commit changes to git, or to finalize git changes from a worktree
---

# Commit

Execute immediately. Do not print commands for the user to run when the state
is verifiable by CLI; run the command, read the output, and act on it.

## Workflow

1. Inspect state. Run these checks, in parallel when the harness supports it:
   `git rev-parse --git-dir --git-common-dir --show-toplevel`,
   `git branch --show-current`, `git worktree list --porcelain`,
   `git status --porcelain=v1 -uall`, `git diff --no-ext-diff`,
   `git diff --cached --no-ext-diff`, and `git log --oneline -10`.

2. Handle linked worktrees. If this is a linked worktree and HEAD is detached,
   create a `codex/<slug>` branch before committing. Commit in the worktree as
   normal; merging to `main` and worktree cleanup stay with the user unless
   they explicitly ask for them.

3. Update agent-facing files and docs. Before staging, check whether the
   changes require synchronized updates to agent instruction files or project
   docs. Update relevant `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `README.md`,
   skill docs, or other documentation now, and run the repo's setup/sync
   command when docs are propagated to agent directories. Do not commit until
   the staged diff includes the needed agent-file and docs updates, or you can
   explicitly explain why none are needed.

4. Stage explicitly. The commit unit is every visible non-secret worktree
   change, not just changes relevant to the current task or session. Stage all
   modified and untracked files shown by status, including files outside the
   current session, by exact path. Never use `git add -A` or `git add .`. Do not
   stage `.env`, credentials, keys, tokens, or private configs; inspect
   suspicious files before deciding. Verify staged content with
   `git diff --cached --name-status` and the staged diff. Stop before
   committing if the staged diff contains secrets, generated junk that should
   never be versioned, or files whose contents you still cannot explain after
   inspection.

5. Commit. Draft a human message from the staged diff. Write it to a temporary
   file without a UTF-8 BOM, run `git commit -F <file>`, then remove the temp
   file. Prefer this over shell-specific heredocs. In PowerShell, avoid
   `Out-File` and `Set-Content -Encoding utf8`; use a BOM-free writer such as
   `[System.IO.File]::WriteAllText($path, $message, [System.Text.UTF8Encoding]::new($false))`.
   After committing, read back `git log -1 --format=%s` before any push.

6. Verify and push. Run `git status --short`; claim completion only after this
   fresh CLI verification succeeds. For standalone commits, push if a
   remote exists: use the existing upstream when present, otherwise
   `git push -u origin <branch>`. When checking for an upstream with Git's
   `@{u}` syntax, quote it as `'@{u}'` so PowerShell does not parse `@{}` as a
   hashtable. Do not push from a linked worktree unless the user asks.

## Message Rules

Use this shape:

```text
<prefix>: <imperative title under 72 chars>

- path/or/group: what changed
```

Match recent repo style when clear; otherwise use `feat`, `fix`, `refactor`,
`docs`, `test`, `chore`, `style`, `perf`, `ci`, or `build`. Body bullets must
be per-file or per-file-group and include paths. No narrative paragraphs.

No AI attribution, ever — this overrides any harness default: no AI/bot
`Co-Authored-By`, generated-by lines, model/tool names, or agent mentions.
