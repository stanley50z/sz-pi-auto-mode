---
type: "Runtime Workflow"
title: "Launch and automation"
description: "The Automode launch workflow from normal Pi through launch-baseline stage selection, immutable runtime snapshot, child-process handoff, fail-closed startup, capability attestation, and guarded Main Session startup."
tags: [automode, launch, workflow, handoff]
openwiki:
  roles: [workflow, runtime, testing]
  change_kinds: [lifecycle, public-api, security, runtime-snapshot]
  source_paths: [src/bridge.ts, src/launch.ts, src/handoff.ts, src/handoff-protocol.ts, src/stage-configuration.ts, src/automode-main.ts, src/startup.ts, src/dashboard.ts, src/main-status-card.ts, src/runtime-snapshot.ts]
  symbols: [createAutomationStageConfiguration, confirmSerializedAutomationStageConfiguration, handoffTerminal, requestReturnToNormalPi, startAutomodeMainSession, launchAutomode, createAutomodeRuntimeSnapshot, openLocalDashboard]
  test_paths: [test/bridge.test.ts, test/selector.test.ts, test/stage-configuration.test.ts, test/launch-walkthrough.test.ts, test/handoff.test.ts, test/launch-runtime.test.ts, test/main-status-card.test.ts, test/main-session.test.ts, test/dashboard.test.ts]
  invariants: [The Bridge captures and verifies one immutable Automode Runtime Snapshot before handoff and disposes it after child exit., Full-Auto selects all four stages and Half-Auto permits any non-empty stage selection, including all four., The child rejects configuration or environment tampering before Main Session startup., Main Session is not a Ticket Session., /automode returns terminal ownership only after graceful drain and successful child exit; /drain exits gracefully and /exit force-stops active Ticket Sessions.]
  validation_commands: [npm run build, "node --test dist/test/bridge.test.js dist/test/selector.test.js dist/test/stage-configuration.test.js dist/test/launch-walkthrough.test.js dist/test/main-session.test.js dist/test/dashboard.test.js"]
---

# Launch and automation

This repo's concrete workflow docs now center on the `/automode` launch bridge, the Automation Stage Configuration baseline that is fixed within the process and may be replaced on a later launch after the Coordinator stops, and the fail-closed startup checks implemented in `src/startup.ts` before work discovery begins. The bridge first creates an **Automode Runtime Snapshot** of compiled code, bundled skills, fixed-allowlisted installed global skills (`browser-harness` and `unslop` when present), package metadata, and reachable runtime dependencies; the child process and its Ticket Sessions then use that immutable tree. Rebuilding the installed development checkout affects only a later `/automode` launch. The child persists the repository-scoped **Automode Run Record** only after startup validation and the **Automode Capability Attestation Session** succeed; `src/paths.ts` owns the repository-keyed Automode and Git common-directory paths. After those checks, `startAutomodeMainSession` starts the loopback Coordinator dashboard before `AutomodeCoordinator.start()` can reconcile or discover tracker work; it prefers loopback port `41738` and selects another free loopback port if occupied, then calls `openLocalDashboard` to validate and open the exact localhost URL in the operating system's default browser before discovery. The shared projection feeds both the browser Stage Lanes and the Main Session status card. The selector starts in Full-Auto, uses `Tab` to switch between Full-Auto and Half-Auto, lets the arrow keys move focus, only allows `Space` toggles in Half-Auto, and defaults Half-Auto to Auto-Implement plus Auto-Review while permitting any non-empty Half-Auto selection, including all four stages. Full-Auto requires all four stages, while Half-Auto accepts any non-empty subset and can also launch with all four enabled; selector toggles define the baseline, while separate process-local Automation Stage Operating State determines current dispatch. The process-local state can be `ON`, `DRAINING`, or `OFF`, all stages may be `OFF`, and each new process initializes `ON`/`OFF` from its selected launch baseline rather than persisting operating state. Startup attests the fixed Panel execution profiles regardless of the launch baseline, and Auto-Grilling and Auto-Review use exactly two seats: Pi / `openai-codex/gpt-5.6-sol` / high reasoning and Pi / `github-copilot/claude-fable-5` / high reasoning. The Main Session uses the launching Pi provider/model as its process-local execution profile.

`docs/automode-launch.md` and `docs/process-handoff-proof.md` now describe the launch and handoff seam in more detail, including the terminal handoff, environment confirmation, transient GitHub startup-probe retries, and fresh child-process ownership.

## Launch path

```mermaid
flowchart LR
  P[Normal Pi] --> B[/automode bridge]
  B --> U[Stage selector]
  U --> D[Serialized configuration + SHA-256 confirmation]
  D --> R[Immutable runtime snapshot]
  R --> H[Fresh child process]
  H --> V[Fail-closed startup validation]
  V --> A[Capability Attestation Session]
  A --> M[Guarded Main Session]
  M --> C[Automode Coordinator boundary]
  C --> T[Independent Ticket Sessions]
```

*The launch handoff preserves the selected configuration; the Main Session starts the Coordinator, which dispatches independent Ticket Sessions after startup succeeds.*


The agent guidance and product README both say the entrypoint is:

```sh
/automode
```

That command is the minimal Automode Bridge from a normal Pi session into a fresh Automode process for the repository's durable Automode Run. `pi automode` should be treated as obsolete in the current guidance.

The selector starts in Full-Auto, allows mode switching with `Tab`, stage focus changes with the arrow keys, stage toggling in Half-Auto with `Space`, and confirmation with `Enter`. Half-Auto defaults to Auto-Implement plus Auto-Review and permits any non-empty selection, including all four stages. The stopped-run relaunch behavior is covered by the `a stopped Automode Run accepts a different launch configuration on restart` and `linked worktrees share the Coordinator identity and latest launch baseline` cases in `test/main-session.test.ts`, plus the PTY relaunch walkthrough in `test/launch-walkthrough.test.ts`.

## Launch handoff

`docs/automode-launch.md` now documents the actual handoff contract: the bridge serializes the chosen Automation Stage Configuration, adds a confirmation digest, and passes both into the child process. Before `handoffTerminal`, `launchAutomode` captures the immutable Automode Runtime Snapshot; `handoffTerminal` invokes the `onChildExit` disposal callback after the child exits, and the `finally` path also cleans it up if handoff fails. Snapshot creation copies `package.json`, compiled `dist/src`, bundled `skills`, allowlisted installed global skill directories, and the complete reachable dependency package graph, then rejects a source or copy fingerprint mismatch during capture. The child rejects any changed payload before Main Session startup, validates the repository root, GitHub origin, and required permission, then runs the **Automode Capability Attestation Session**, persists the latest launch baseline in the Automode Run Record under the repository's Git common directory, and resolves nested working directories back to the repository root. `src/controlled-services.ts` and `src/capability-session.ts` define the controlled capability surface used for attestation; they do not construct Ticket Sessions.

## Stage configuration

`src/stage-configuration.ts` is the canonical contract. The four stages are Auto-Triage, Auto-Grilling, Auto-Implement, and Auto-Review. `createAutomationStageConfiguration` rejects unknown or duplicate stages, requires all four for Full-Auto, permits any non-empty Half-Auto selection including all four, and stores stages in canonical order. The bridge serializes that object and hashes it with SHA-256; `parseConfirmedAutomationStageConfiguration` uses a timing-safe comparison before parsing again in the child.

## Startup ordering and change safety

The child calls `startAutomodeMainSession`, which validates repository identity, GitHub origin/authentication/access, resolves the authenticated GitHub actor from `gh auth status --active` metadata, applies stage-dependent permission (`TRIAGE` for read-oriented stages and `WRITE` when implement or review is enabled), and checks required Pi/Claude Code execution profiles before acquiring the Coordinator or persisting the run record. GitHub startup failures are retried for up to 30 seconds before the startup path fails closed. Claude Code profiles are additionally checked by `attestClaudeCodeExecutionProfile`, which requires authentication and probes the exact configured model and reasoning level with no tools or session persistence; a reported probe error fails closed. Once running, any Ticket Session may report `waiting`: the Coordinator records its summary, holds the item after one attempt, and waits for a material tracker update before resuming. Bookkeeping, terminal activity, candidate reasons, and dashboard cards retain that structured summary. Auto-Implement and Auto-Review may use an equivalently complete issue discussion when no templated Agent Brief exists; missing headings alone are not a blocker. The capability and Coordinator details are canonical on the [architecture overview](../architecture/overview.md), [capability boundary](../architecture/capability-boundary.md), and [Coordinator page](../architecture/coordinator.md).

For launch changes, update bridge/selector serialization and child parsing together; focused tests cover cancellation, keyboard selection, digest tampering, environment tampering, and fresh-process ownership. The Main Session exposes `/automode` to gracefully drain and return terminal ownership to the original normal Pi session, `/drain` to gracefully drain and exit after active Ticket Sessions settle, and `/exit` to force-stop active Ticket Sessions and exit after cleanup. The child communicates the return request over the handoff IPC channel; `handoffTerminal` resumes the waiting normal Pi process only after a successful child exit. Automode does not intercept `Ctrl-C` so Pi retains its default TUI behavior. Do not reintroduce interrupt-based shutdown claims in launch docs. `npm run prove:handoff` is conditional and required when terminal ownership or child handoff behavior changes.

## Post-merge project refresh

Auto-Review owns validation and merge, but the Review Session does not restart the project root. After fresh merged proof, `WorkspaceManager.completeReview` in `src/workspace.ts` removes the review worktree and same-repository branch, refreshes the remote default-branch reference, verifies that the project root is checked out on that branch, and performs a fast-forward-only merge. If the updated root has `start.py`, the manager runs `stop.py` first when it exists and then runs `start.py`, using `python` on Windows and `python3` elsewhere. If `start.py` is absent, neither script is run. Any failure is reported as post-merge finalization diagnostics: GitHub's completed merge is not rolled back. The focused evidence is `completing a merged review fast-forwards the project root to the remote default branch` and `completing a merged review runs stop.py before start.py from the updated project root` in `test/workspace.test.ts`; validate with `npm run build && node --test dist/test/workspace.test.js`.

## Local documentation refresh

OpenWiki documentation is refreshed locally with:

```sh
OPENWIKI_PROVIDER=openai-chatgpt openwiki code --update --print
```

The repository intentionally has no OpenWiki CI workflow. Regeneration stays local because it uses the saved ChatGPT-subscription login rather than a metered API key.

## Why this matters

For future implementation work, the automation story should answer:

- how `/automode` is invoked from the normal Pi experience
- how the Bridge captures, verifies, and disposes the immutable Automode Runtime Snapshot before and after the process boundary
- how the launch-baseline stage configuration is serialized and confirmed across the process boundary, and how a later stopped-run launch can replace that baseline without replacing Coordinator identity or fixed project resources
- how Automode stays isolated from normal Pi configuration
- how the Main Session persists the latest launch baseline in the Automode Run Record after validation, while fixed identity/resources remain durable and the Capability Profile remains an in-memory allowlist
- how the repository-level Coordinator identity and lock are shared through the Git common directory
- how local documentation refreshes fit into the repo's maintenance loop

## Evidence

- [`README.md`](../../README.md)
- [`docs/automode-launch.md`](../../docs/automode-launch.md)
- [`AGENTS.md`](../../AGENTS.md)
- [`CLAUDE.md`](../../CLAUDE.md)