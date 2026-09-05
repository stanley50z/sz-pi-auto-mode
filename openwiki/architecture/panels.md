---
type: "Panel Runtime"
title: "Review Panel and controlled advisory seats"
description: "The configurable Panel runtime used by Auto-Grilling and Auto-Review, including fixed and inherited Pi seats, isolated child processes, immutable context, hidden peers, execution profiles, and read-only advisory tools."
tags: [automode, panels, grilling, review, isolation]
openwiki:
  roles: [architecture, workflow, testing]
  change_kinds: [lifecycle, integration, security]
  source_paths: [src/panel-runtime.ts, src/panel-process.ts, src/capability-profile.ts, src/ticket-panel-extension.ts, src/ticket-session-main.ts, src/ticket-session-result.ts, src/review-disposition.ts, src/usage.ts, src/nested-session.ts, src/launch.ts]
  symbols: [runGrillingPanel, runReviewPanel, PanelRuntimeError, CliPanelProcessLauncher, createProductionPanelSeatLauncher, createTicketPanelExtension, TicketPanelNestedActivity, GitHubReviewDispositionPublisher, formatUsageSummary]
  test_paths: [test/panel-runtime.test.ts, test/panel-process.test.ts, test/capability-profile.test.ts, test/execution-inheritance.test.ts, test/ticket-panel-extension.test.ts, test/ticket-session-result.test.ts, test/review-disposition.test.ts]
  invariants: [Every configured Panel seat executes independently., Peers receive identical immutable context without peer answers., Advisory tools cannot mutate tracker or advance workflow., Review reports are Markdown and each failed seat retains attributed diagnostics., Reviewer usage is required and attributed per seat., Final validation usage is appended only after the complete Review Session settles., Pi seats launch the launching Pi package entrypoint through process.execPath.]
  validation_commands: [npm run build, "node --test dist/test/panel-runtime.test.js dist/test/panel-process.test.js dist/test/capability-profile.test.js dist/test/execution-inheritance.test.js dist/test/ticket-panel-extension.test.js dist/test/ticket-session-result.test.js dist/test/review-disposition.test.js"]
---

# Review Panel and controlled advisory seats

Auto-Grilling and Auto-Review use a controlled Panel runtime rather than allowing the Main Session or Coordinator to make stage decisions. The Panel always includes two fixed high-reasoning seats: Pi / `openai-codex/gpt-6-astra` and Pi / `github-copilot/claude-fable-5`. If the captured Main Session provider/model matches neither fixed seat, that execution is appended as a third seat; a reasoning-level difference alone does not add a duplicate. The Main Session's process-local execution profile is separate from the Automode Run Record and is not persisted there. Each Ticket Session captures the current Main Session execution at dispatch; already-running workers retain their captured settings. Production launches are supplied through the `PanelSeatLauncher` seam and `CliPanelProcessLauncher`; peers do not see one another's answers. The authoritative Grilling Session or Review Session receives the advisory results and remains responsible for decisions and tracker progression.

```mermaid
sequenceDiagram
  participant S as Ticket Session
  participant R as Panel runtime
  participant A as Pi Codex seat
  participant B as Pi Claude seat
  S->>R: immutable context + task
  par independent seats
    R->>A: execute advisory prompt
    R->>B: execute advisory prompt
  end
  A-->>R: grilling answer or review Markdown
  B-->>R: grilling answer or review Markdown
  R-->>S: attributed results and failures
```

*Panel seats advise; the owning Ticket Session decides what to do with their results.*

## Boundary and invariants

`src/ticket-panel-extension.ts` provides the controlled `automode_panel` advisory tool for `grilling` and `review`, using TypeBox parameters and returning structured results. Its tools are read-only and scoped to the task context; a Panel seat cannot advance a queue, dispatch a stage, ask the human, mutate tracker state, or merge a pull request. `src/panel-process.ts` implements the production `CliPanelProcessLauncher`, which starts controlled `pi --mode json` or `claude --print --output-format json` processes for the exact execution profile and disables ambient Pi resources and context. Grilling output is parsed as structured JSON; Review output is preserved as non-empty Markdown for the parent Review Session to interpret. For Pi seats, it invokes the launching Pi package's `dist/bundle/cli.js` through `process.execPath` rather than an npm command shim; `src/launch.ts` supplies that package location as `AUTOMODE_PI_PACKAGE_DIR`, and `ticket-session-main.ts` requires it before constructing a Panel launcher. This keeps the child invocation spawnable on Windows while preserving the launching package. There is no `PanelRuntime` class, `PanelProcessHost`, versioned panel IPC, or seat cleanup protocol.

`runReviewPanel` returns every completed, attributed Markdown report alongside `PanelSeatFailure` diagnostics; it does not throw a review quorum `PanelRuntimeError` or discard successful reports. Each usable report also carries parsed token/cost `usage` and a formatted `usageSummary`. The Review Session publishes completed reports as commit-pinned GitHub pull-request reviews with inline comments, but failed or unusable seats remain missing and block disposition, fixes, and merge. Grilling retains its structured answer contract and its own failure policy. Empty or malformed seat output—including missing Reviewer usage—is recorded as a failure rather than treated as advice. The parent-owned review request is deliberately compact—`round`, exact `headSha`, and prose `brief`—so the Review Session controls the assembled evidence and interpretation boundary. `reviewPrompt` formats those fields as explicit Markdown sections (`Review round`, `Pinned head`, `Review brief`, `Expected report`, and `Limits`) rather than embedding model-authored JSON; this keeps the seat contract readable while preserving the exact review head.

`runGrillingPanel` and `runReviewPanel` optionally emit `NestedSessionEvent` values around each seat: a bounded `started` prompt, streamed assistant/thinking or aggregate-tool activity, and a `settled` completion/failure. `createTicketPanelExtension` attaches those events to the exact `automode_panel` tool call; `CliPanelProcessLauncher` streams Pi JSONL assistant messages and projects Claude output as bounded assistant activity. The resulting nested events are observation data for the dashboard's split inspector, not a new execution or subagent capability.

For Auto-Review, `createTicketSessionResultExtension` requires the authoritative Ticket Session to submit a non-empty `finalDisposition` with a completed result. The child captures whole-Review-Session usage from Pi session statistics; `GitHubReviewDispositionPublisher` then posts the supplied `## Automode final validation` Markdown as a GitHub issue comment and appends totals for the Review Session plus every Reviewer session in every round. Per-seat review comments use each report's unchanged `usageSummary`. This final publication happens only after the completed Review Session has all required seat reports and merge/cleanup validation.

Review context is pinned to the exact pull-request head by the workspace and review flow. Grilling and review seats therefore inspect the same immutable starting point, while hidden peer answers preserve independent judgment. The configurable Panel is not a general-purpose worker pool and should not be changed to provide concurrency for ordinary Ticket Sessions. Its seat set is derived in `createAutomodeCapabilityProfile({ mainExecution })`; changing that seam requires updating startup attestation and both capability-profile and execution-inheritance tests. The repository's focused runtime description is [docs/panel-runtime.md](../../docs/panel-runtime.md), and the higher-level coordinator supervision design is [docs/automode-dashboard-design.md](../../docs/automode-dashboard-design.md) with its ADR at [docs/adr/0001-use-a-local-web-dashboard-for-coordinator-supervision.md](../../docs/adr/0001-use-a-local-web-dashboard-for-coordinator-supervision.md).

## Change navigation

- Seat fan-out, report collection, or failure policy: change `runGrillingPanel` / `runReviewPanel` in `src/panel-runtime.ts` and `test/panel-runtime.test.ts`; preserve independent attribution and the distinction between grilling JSON and review Markdown.
- CLI process launch or output normalization: change `CliPanelProcessLauncher` in `src/panel-process.ts`; when changing Pi package propagation, also inspect `src/launch.ts` and `src/ticket-session-main.ts`. Run `test/panel-process.test.ts`.
- Seat failure diagnostics, usage attribution, or Review Session handoff: change `PanelSeatFailure` and `AttributedReviewReport` handling in `src/panel-runtime.ts`, the reporting path in `src/ticket-panel-extension.ts`, or `src/usage.ts`; run `test/panel-runtime.test.ts`, `test/panel-process.test.ts`, and `test/ticket-panel-extension.test.ts`. Do not restore quorum throwing or model-authored structured Review JSON. Reviewer usage is mandatory for usable reports, and cached-input is included in the displayed input total.
- Final validation publication: change `GitHubReviewDispositionPublisher` in `src/review-disposition.ts` or the required result wiring in `src/ticket-session-result.ts` / `src/ticket-session-main.ts`; run `test/review-disposition.test.ts` and `test/ticket-session-result.test.ts`. Preserve the rule that missing seats block disposition and that usage is appended only by the parent publisher.
- Advisory tool permissions or context shaping: change `src/ticket-panel-extension.ts` and `test/ticket-panel-extension.test.ts`.
- Stage integration belongs in the [Coordinator and Ticket Sessions](coordinator.md) page and its focused tests. The [capability boundary](capability-boundary.md) remains canonical for allowlists and execution attestation, and the dashboard design/ADR explain the stage control surface.

Use the focused command in front matter for ordinary changes. Run the broader package suite only when changing the shared process protocol, shipped extension registration, or cross-stage lifecycle.
