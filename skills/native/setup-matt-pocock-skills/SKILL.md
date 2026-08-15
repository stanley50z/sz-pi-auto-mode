---
name: setup-matt-pocock-skills
description: Configure a GitHub repo for the engineering skills — GitHub Issues, triage label vocabulary, and domain doc layout. Use when the user asks to set up the engineering skills in a repo, or when another skill needs the one-time repo configuration. Requires a reachable GitHub remote; stops and asks the user to create one when missing.
---

# Setup Matt Pocock's Skills

Scaffold the per-repo configuration that the engineering skills assume:

- **Issue tracker** — GitHub Issues
- **Triage labels** — the strings used for the five canonical triage roles
- **Domain docs** — where `CONTEXT.md` and ADRs live, and the consumer rules for reading them

**This skill is non-interactive after its GitHub prerequisite passes.** Do not quiz the user section by section or show drafts for approval. Explore, validate GitHub, apply the standing defaults below, write, then report what was written.

## Process

### 1. Explore

Look at the current repo to understand its starting state. Read whatever exists; don't assume:

- `git remote -v` and `.git/config` — which remote is the GitHub repo?
- `AGENTS.md` and `CLAUDE.md` at the repo root — does either exist? Is there already an `## Agent skills` section in either?
- `CONTEXT.md` and `CONTEXT-MAP.md` at the repo root
- `docs/adr/` and any `src/*/docs/adr/` directories
- `docs/agents/` — does this skill's prior output already exist?
- Is the `triage` skill installed? Check the exact sibling file `../triage/SKILL.md` relative to this skill before consulting available skills. An exact file check follows a symlinked skill directory; directory-only discovery may omit it. Treat either that file or a visible `triage` skill as installed. Do not infer that `triage` is absent merely because it is missing from the model's available-skills list: user-invoked copies carry `disable-model-invocation: true` and are intentionally hidden there. This decides whether triage labels are written at all.
- Monorepo signals — a `pnpm-workspace.yaml`, a `workspaces` field in `package.json`, or a populated `packages/*` with its own `src/`. Present only in a genuinely large multi-package repo; their absence means single-context, which is almost every repo.

### 2. Require GitHub

Require a configured, reachable GitHub remote before writing anything:

- Resolve the repository from its configured GitHub remote with `gh repo view --json nameWithOwner,url`.
- If no GitHub remote exists, the remote is not reachable, or `gh` cannot resolve it, **stop without writing files or labels**. Ask the user to create or connect the GitHub repository, then rerun this skill.
- Do not fall back to local Markdown, GitLab, Jira, Linear, or another tracker.
- Once the prerequisite passes, use **GitHub Issues** and seed from [issue-tracker-github.md](./issue-tracker-github.md).

The GitHub template carries a "PRs as a request surface" flag, defaulted **off** — leave it off and don't raise it; a user who wants external PRs in the triage queue can flip the flag in the file later.

**Triage labels — always the five canonical defaults**, each label string equal to its role name: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. Skip labels entirely when the `triage` skill isn't installed — an uninstalled skill needs no labels. On GitHub, create any of the five labels the repo doesn't have yet with `gh label create`.

**Domain docs — single-context by default:** one `CONTEXT.md` + `docs/adr/` at the repo root. Choose **multi-context** (a root `CONTEXT-MAP.md` pointing to per-context `CONTEXT.md` files) automatically when exploration found monorepo signals.

**Agent instructions file:**

- If `CLAUDE.md` exists, edit it.
- Else if `AGENTS.md` exists, edit it.
- If neither exists, create `AGENTS.md`.

Never create `AGENTS.md` when `CLAUDE.md` already exists (or vice versa) — always edit the one that's already there.

### 3. Write

If an `## Agent skills` block already exists in the chosen file, update its contents in-place rather than appending a duplicate. Don't overwrite user edits to the surrounding sections.

The block:

```markdown
## Agent skills

### Issue tracker

[one-line summary of where issues are tracked]. See `docs/agents/issue-tracker.md`.

### Triage labels

[one-line summary of the label vocabulary]. See `docs/agents/triage-labels.md`.

### Domain docs

[one-line summary of layout — "single-context" or "multi-context"]. See `docs/agents/domain.md`.
```

Include the `### Triage labels` sub-block, and write `docs/agents/triage-labels.md`, only when `triage` is installed. When it isn't, both are omitted.

Then write the docs files using the seed templates in this skill folder as a starting point:

- [issue-tracker-github.md](./issue-tracker-github.md) — GitHub issue tracker
- [triage-labels.md](./triage-labels.md) — label mapping (only if `triage` is installed)
- [domain.md](./domain.md) — domain doc consumer rules + layout

### 4. Report

Tell the user what was configured, in a few lines: which GitHub repository was resolved from which remote, the label vocabulary and any labels created, the domain doc layout, which instructions file got the `## Agent skills` block, and which `docs/agents/*.md` files were written. Mention they can edit `docs/agents/*.md` directly later — re-running this skill is only necessary to restart from scratch.
