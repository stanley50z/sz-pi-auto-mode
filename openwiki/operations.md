---
type: "Operations Guide"
title: "Operations"
description: "Repository operating conventions for GitHub issue coordination, local OpenWiki maintenance, and narrow validation of the TypeScript package."
tags: [operations, github, openwiki, testing]
openwiki:
  roles: [operations, repository]
  change_kinds: [configuration]
  source_paths: [docs/agents/issue-tracker.md, AGENTS.md, package.json]
  validation_commands: [npm run build]
---

# Operations

This repository's current operating conventions come from the agent guidance files and the agent-domain docs.

## Focused validation

The package uses TypeScript compilation followed by Node's built-in test runner. `npm run build` is the smallest compile check. Focused tests run from `dist/test/*.test.js`; use the commands named by the relevant wiki page. `npm test` is the broad package check, while `npm run prove:handoff` is conditional for process-handoff changes because it builds and runs the terminal proof. The deterministic Full-Auto journey is the narrow cross-stage smoke test when Coordinator, workspace, or Panel wiring changes; use the full suite only for package-wide lifecycle or shipped-surface changes. Coordinator, tracker, workspace, Ticket Session, and Panel changes have narrower commands in their page metadata; use broader checks only for cross-boundary or package registration changes.

## Issue tracking

The repo treats GitHub Issues as the system of record for issues and specs. The live Automode Coordinator also consumes complete GitHub snapshots and writes one updateable Automode bookkeeping comment per item through `GitHubTracker`; `architecture/coordinator.md` is canonical for that runtime contract. `docs/agents/issue-tracker.md` remains the canonical source for the human `gh`-based issue workflow, including:

- creating issues
- reading issues and comments
- listing issues with labels and state filters
- commenting, labeling, and closing issues

That makes GitHub the main coordination surface for future work items.

## OpenWiki maintenance

OpenWiki is maintained locally using the saved ChatGPT-subscription login:

```sh
OPENWIKI_PROVIDER=openai-chatgpt openwiki code --update --print
```

The repository intentionally has no OpenWiki CI workflow. `AGENTS.md` and `CLAUDE.md` both point readers to `openwiki/quickstart.md` and warn against hand-editing generated OpenWiki pages unless explicitly asked.

## Repo conventions worth preserving

- keep generated docs under `openwiki/`
- prefer source updates plus regeneration over hand-editing generated pages
- keep issue/spec discussion in GitHub Issues rather than scattering it across ad hoc notes
- use the agent docs under `docs/agents/` as the authoritative operating references

## Evidence

- [`AGENTS.md`](../AGENTS.md)
- [`CLAUDE.md`](../CLAUDE.md)
- [`docs/agents/issue-tracker.md`](../docs/agents/issue-tracker.md)