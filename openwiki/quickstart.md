---
type: "Repository Guide"
title: "OpenWiki quickstart"
description: "Entry point for navigating the Automode repository architecture, launch workflow, capability boundary, bundled skills, integrations, and focused validation paths."
tags: [repository, automode, navigation]
openwiki:
  roles: [repository, architecture, testing]
  change_kinds: [public-api, lifecycle, configuration]
  source_paths: [README.md, src/automode-main.ts, src/startup.ts, package.json]
  validation_commands: [npm run build]
---

# OpenWiki quickstart

This repository is an early-stage Pi extension centered on **Automode**, a distinct repository-scoped experience for automating the Matt Pocock workflow. The current source evidence says:

- the product launches from **`/automode` inside normal Pi**
- `pi automode` is obsolete in the agent guidance
- Automode uses a fixed launch-baseline Automation Stage Configuration, a separate process-local Automation Stage Operating State (`ON`, `DRAINING`, `OFF`), and a repository-scoped Main Session / Coordinator boundary; independent full-process Ticket Sessions perform stage work
- the `/automode` bridge hands off to a fresh child process that confirms the serialized launch baseline, keeps terminal ownership in the launch seam, and starts from a selector that defaults to Full-Auto but allows Half-Auto to use any non-empty stage selection, including all four stages; the launching Pi provider/model configures only that process's Main Session, including models resolved from normal `models.json`; the dashboard design and supervision ADR document the Coordinator web surface
- startup fails closed until repository access, the Automode Capability Attestation Session, canonical skill provenance, and the repository Coordinator lock all validate; GitHub actor binding comes from `gh auth status --active` metadata, and transient GitHub startup failures are retried for up to 30 seconds before the startup path fails closed
- the MVP is organized into four Automation Stages: Auto-Triage, Auto-Grilling, Auto-Implement, and Auto-Review
- startup attests the fixed Panel execution profiles regardless of the launch baseline; Auto-Grilling and Auto-Review use exactly two Panel seats: Pi / `openai-codex/gpt-5.6-sol` / high reasoning and Pi / `github-copilot/claude-fable-5` / high reasoning
- the Automode Run Record is shared through the Git common directory, independently of Pi home/config roots, and is the durable Coordinator-bound record rather than the capability allowlist
- the Coordinator reconciles all bookkeeping states before claims, resets recovered `running`, `retrying`, `failed`, and `exhausted` records to attempt one for each new Coordinator process while preserving valid Ticket Session history and workspaces, uses complete snapshots whose revisions include `updated_at`, recovers missing, cross-home, or incompatible sessions and missing worktrees, requires merged proof before Auto-Review cleanup, and fails fast on unwritable fork heads; the five-attempt budget is per Coordinator process, not persistent across restarts
- any Ticket Session may report `waiting` after one attempt; the Coordinator holds it without consuming retries until a material tracker update, while preserving its structured summary in bookkeeping, terminal activity, candidate reason, and dashboard cards/latest structured activity; Auto-Implement and Auto-Review accept an equivalently complete issue discussion when no templated Agent Brief exists, so missing headings alone do not block work
- closed unmerged pull requests are abandoned outputs: they do not conflict with an open or merged pull request closing the same issue
- shutdown is controlled from the Main Session with `/drain` to gracefully drain and exit after active Ticket Sessions settle and `/exit` to force-stop active Ticket Sessions before exiting; Automode does not intercept `Ctrl-C`, so Pi retains its default TUI behavior, and the Coordinator releases its lock only after stopping
- Personal-WeChat integration is planned separately from the Automode MVP
- the Coordinator dashboard prefers loopback port `41738`, selects another free loopback port when occupied, optionally exposes a private Tailscale URL, projects Stage Candidates and bounded activity, and delegates only safe supervision commands; it can run concurrently for different repositories, adopts only an exact matching Tailscale handler, and removes only the exact handler it owns; the Main Session status card shows repository/run identity, dashboard links, Stage states, candidate totals, poll timing, lifecycle guidance, and Tailscale errors, and exposes `/drain` and `/exit` as the only user-facing shutdown commands
- Auto-Grilling and Auto-Review use hidden-peer Panel runtimes with exactly two current seats: Pi / `openai-codex/gpt-5.6-sol` / high reasoning and Pi / `github-copilot/claude-fable-5` / high reasoning

Start here, then follow the section pages below for the repository's runtime seams and change-routing guidance.

## Change-routing table

| Change area or user intent | Relevant wiki page | Exact source entry points | Important symbols or types | Focused tests | Minimal validation command |
|---|---|---|---|---|---|
| Change `/automode` launch or handoff | [Launch and automation](workflows/launch-and-automation.md) | `src/bridge.ts`, `src/launch.ts`, `src/automode-main.ts` | `startAutomodeMainSession`, `parseConfirmedAutomationStageConfiguration` | `test/bridge.test.ts`, `test/stage-configuration.test.ts`, `test/process-handoff.test.ts` | `npm run build && node --test dist/test/bridge.test.js dist/test/stage-configuration.test.js dist/test/process-handoff.test.js` |
| Change startup safety, GitHub access, actor binding, or Claude Code probes | [Architecture overview](architecture/overview.md) | `src/startup.ts`, `src/automode-main.ts` | `validateAutomodeStartup`, `attestClaudeCodeExecutionProfile`, `ValidatedAutomodeStartup.actor` | `test/startup.test.ts`, `test/main-session.test.ts` | `npm run build && node --test dist/test/startup.test.js dist/test/main-session.test.js` |
| Change skills, tools, models, or resource isolation | [Capability boundary](architecture/capability-boundary.md) | `src/capability-profile.ts`, `src/capability-session.ts`, `src/controlled-services.ts`, `src/attestation.ts` | `createAutomodeCapabilityProfile`, `createCapabilitySession`, `attestCanonicalCommands` | `test/capability-profile.test.ts`, `test/capability-session.test.ts`, `test/attestation.test.ts` | `npm run build && node --test dist/test/capability-profile.test.js dist/test/capability-session.test.js dist/test/attestation.test.js` |
| Add or route a bundled skill | [Skill catalog](skills/catalog.md) | `skills/native/*`, `skills/automode/*`, `src/capability-profile.ts` | `STAGE_SKILLS`, `CapabilitySkill` | `test/capability-profile.test.ts`, `test/capability-session.test.ts` | `npm run build && node --test dist/test/capability-profile.test.js dist/test/capability-session.test.js` |
| Change Coordinator/run persistence or repository paths | [Architecture overview](architecture/overview.md) | `src/coordinator-lock.ts`, `src/paths.ts`, `src/automode-main.ts` | `acquireRepositoryCoordinator`, `persistAutomodeRunRecord`, `AutomodePaths.runRecordFile` | `test/coordinator-lock.test.ts`, `test/main-session.test.ts`, `test/paths.test.ts` | `npm run build && node --test dist/test/coordinator-lock.test.js dist/test/main-session.test.js dist/test/paths.test.js` |
| Change Ticket Session runtime compatibility or restart behavior | [Coordinator and Ticket Sessions](architecture/coordinator.md) | `src/ticket-session.ts`, `src/restart-required.ts`, `src/coordinator.ts` | `TicketSessionHost`, `ticketSessionRuntimeFingerprint`, `AutomodeRestartRequiredError`, `AutomodeCoordinator` | `test/ticket-session.test.ts`, `test/coordinator.test.ts` | `npm run build && node --test dist/test/ticket-session.test.js dist/test/coordinator.test.js` |
| Change work discovery, Ticket Sessions, GitHub bookkeeping, or worktrees | [Coordinator and Ticket Sessions](architecture/coordinator.md) | `src/coordinator.ts`, `src/ticket-session.ts`, `src/github-tracker.ts`, `src/workspace.ts` | `AutomodeCoordinator`, `AutomodeTicketSessionHost`, `GitHubTracker`, `WorkspaceManager` | `test/coordinator.test.ts`, `test/ticket-session.test.ts`, `test/ticket-session-result.test.ts`, `test/github-tracker.test.ts`, `test/workspace.test.ts` | `npm run build && node --test dist/test/coordinator.test.js dist/test/ticket-session.test.js dist/test/github-tracker.test.js dist/test/workspace.test.js` |
| Change `/fast` or provider request behavior | [Fast mode](integrations/fast-mode.md) | `src/fast-mode.ts`, `src/controlled-services.ts` | `createAutomodeFastModeExtension` | `test/capability-session.test.ts`, `test/real-pi-smoke.test.ts` | `npm run build && node --test dist/test/capability-session.test.js dist/test/real-pi-smoke.test.js` |
| Change local OpenWiki refresh or repository operating guidance | [Operations](operations.md) | `README.md`, `AGENTS.md`, `CLAUDE.md`, `package.json` | `OPENWIKI_PROVIDER=openai-chatgpt openwiki code --update --print` | none; documentation-only | no source validation; run the local OpenWiki command when regenerating |
| Change Panel seats, hidden-peer execution, Markdown Review reports, advisory failure diagnostics, or review/grilling tools | [Review Panel and controlled advisory seats](architecture/panels.md) | `src/panel-runtime.ts`, `src/panel-process.ts`, `src/ticket-panel-extension.ts`, `src/launch.ts`, `src/ticket-session-main.ts` | `runGrillingPanel`, `runReviewPanel`, `PanelRuntimeError`, `CliPanelProcessLauncher`, `createTicketPanelExtension` | `test/panel-runtime.test.ts`, `test/panel-process.test.ts`, `test/ticket-panel-extension.test.ts` | `npm run build && node --test dist/test/panel-runtime.test.js dist/test/panel-process.test.js dist/test/ticket-panel-extension.test.js` |
| Change Coordinator dashboard, Stage Lanes, browser controls, initial-prompt display, transcript activity projection, or Main Session status card | [Coordinator dashboard](architecture/dashboard.md) | `src/dashboard.ts`, `src/dashboard-ui.ts`, `src/automode-main.ts`, `src/main-status-card.ts`, `src/coordinator.ts`, `src/ticket-session-prompt.ts`, `src/ticket-transcript.ts` | `CoordinatorDashboard`, `DashboardProjection`, `DashboardCommand`, `DashboardActivityEntry`, `createDashboardProjection`, `createCanonicalTicketSessionPrompt`, `createAssistantTranscript`, `createAutomodeStatusCard` | `test/dashboard.test.ts`, `test/dashboard-ui.test.ts`, `test/main-session.test.ts`, `test/main-status-card.test.ts`, `test/coordinator.test.ts`, `test/ticket-session.test.ts` | `npm run build && node --test dist/test/dashboard.test.js dist/test/dashboard-ui.test.js dist/test/main-status-card.test.js dist/test/ticket-session.test.js` |
| Change Ticket Session waiting, retained summaries, or work-contract fallback | [Coordinator and Ticket Sessions](architecture/coordinator.md) and [Skill catalog](skills/catalog.md) | `src/coordinator.ts`, `src/ticket-session.ts`, `src/ticket-session-main.ts`, `src/ticket-session-result.ts`, `skills/automode/implement/SKILL.md`, `skills/automode/code-review/SKILL.md` | `TicketSessionTerminalResult`, `AutomodeCoordinator`, `createTicketSessionResultExtension`, `runAttempts`, `BookkeepingRecord` | `test/coordinator.test.ts`, `test/bundled-standards.test.ts`, `test/ticket-session.test.ts` | `npm run build && node --test dist/test/coordinator.test.js dist/test/bundled-standards.test.js dist/test/ticket-session.test.js` |

## What this wiki covers

- the product shape and why the repo exists
- the TypeScript application surfaces that implement Automode
- the Automode architecture boundary and stage model
- the launch and workflow surface described by the source docs
- the repository's operating conventions for issue tracking and local OpenWiki updates

## Major sections

- [Architecture overview](architecture/overview.md)
- [Coordinator dashboard and Stage Lanes](architecture/dashboard.md)
- [Coordinator and Ticket Sessions](architecture/coordinator.md)
- [Launch and automation](workflows/launch-and-automation.md)
- [Capability boundary](architecture/capability-boundary.md)
- [Review Panel and controlled advisory seats](architecture/panels.md)
- [Coordinator dashboard design](../docs/automode-dashboard-design.md)
- [Coordinator supervision ADR](../docs/adr/0001-use-a-local-web-dashboard-for-coordinator-supervision.md)
- [Bundled skill catalog](skills/catalog.md)
- [Fast mode integration](integrations/fast-mode.md)
- [Personal WeChat integration](integrations/wechat.md)
- [Operations](operations.md)

## Canonical source docs

- [`README.md`](../README.md) — top-level product framing and Automode MVP summary
- [`CONTEXT.md`](../CONTEXT.md) — canonical Automode domain language
- [`docs/agents/issue-tracker.md`](../docs/agents/issue-tracker.md) — GitHub issue workflow and Wayfinder conventions
- [`docs/agents/domain.md`](../docs/agents/domain.md) — how domain docs are meant to be consumed
- [`docs/agents/triage-labels.md`](../docs/agents/triage-labels.md) — label mapping for skills and triage
- [`docs/adr/0003-reset-attempt-budgets-on-process-launch.md`](../docs/adr/0003-reset-attempt-budgets-on-process-launch.md) — accepted rationale for per-process attempt budgets

## Source evidence

- [`README.md`](../README.md) — product summary and MVP scope
- [`AGENTS.md`](../AGENTS.md) — OpenWiki guidance and `/automode` entrypoint note
- [`CLAUDE.md`](../CLAUDE.md) — the same OpenWiki guidance in a second agent-facing file

## Backlog

- Personal-WeChat transport remains planned without implementation evidence (`README.md`); see [Personal WeChat](integrations/wechat.md).

## Notes for future updates

The repository has TypeScript application code for startup validation, capability profiles and the Automode Capability Attestation Session, controlled services, fast mode, repository Coordinator locking, GitHub tracking, Ticket Sessions, isolated workspaces, and the configurable Panel runtime. Keep the durable persisted concept named the Automode Run Record; the capability profile is the allowlist used during session construction. The root `CONTEXT.md` remains the canonical vocabulary source.