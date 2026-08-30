---
type: "Runtime Workflow"
title: "Launch and automation"
description: "The Automode launch workflow from normal Pi through fixed launch-baseline stage selection, child-process handoff, fail-closed startup, capability attestation, and guarded Main Session startup."
tags: [automode, launch, workflow, handoff]
openwiki:
  roles: [workflow, runtime, testing]
  change_kinds: [lifecycle, public-api, security]
  source_paths: [src/bridge.ts, src/launch.ts, src/stage-configuration.ts, src/automode-main.ts, src/startup.ts, src/dashboard.ts, src/main-status-card.ts]
  symbols: [createAutomationStageConfiguration, confirmSerializedAutomationStageConfiguration, startAutomodeMainSession]
  test_paths: [test/bridge.test.ts, test/selector.test.ts, test/stage-configuration.test.ts, test/launch-walkthrough.test.ts]
  invariants: [Full-Auto selects all four stages and Half-Auto permits any non-empty stage selection, including all four., The child rejects configuration or environment tampering before Main Session startup., Main Session is not a Ticket Session.]
  validation_commands: [npm run build, "node --test dist/test/bridge.test.js dist/test/selector.test.js dist/test/stage-configuration.test.js dist/test/launch-walkthrough.test.js"]
---

# Launch and automation

This repo's concrete workflow docs now center on the `/automode` launch bridge, the fixed Automation Stage Configuration baseline that survives the process handoff, and the fail-closed startup checks implemented in `src/startup.ts` before work discovery begins. The child persists the repository-scoped **Automode Run Record** only after startup validation and the **Automode Capability Attestation Session** succeed; `src/paths.ts` owns the repository-keyed Automode and Git common-directory paths. After those checks, `startAutomodeMainSession` starts the loopback Coordinator dashboard before `AutomodeCoordinator.start()` can reconcile or discover tracker work; it prefers loopback port `41738` and selects another free loopback port if occupied. The shared projection feeds both the browser Stage Lanes and the Main Session status card. The selector starts in Full-Auto, uses `Tab` to switch between Full-Auto and Half-Auto, lets the arrow keys move focus, only allows `Space` toggles in Half-Auto, and defaults Half-Auto to Auto-Implement plus Auto-Review while permitting any non-empty Half-Auto selection, including all four stages. Full-Auto requires all four stages, while Half-Auto accepts any non-empty subset and can also launch with all four enabled; selector toggles define the baseline, while separate process-local Automation Stage Operating State determines current dispatch. The process-local state can be `ON`, `DRAINING`, or `OFF`, all stages may be `OFF`, and a restart restores `ON`/`OFF` from the launch baseline rather than persisting operating state. Startup attests the fixed Panel execution profiles regardless of the launch baseline, and Auto-Grilling and Auto-Review use exactly two seats: Pi / `openai-codex/gpt-5.6-sol` / high reasoning and Pi / `github-copilot/claude-fable-5` / high reasoning.

`docs/automode-launch.md` and `docs/process-handoff-proof.md` now describe the launch and handoff seam in more detail, including the terminal handoff, environment confirmation, transient GitHub startup-probe retries, and fresh child-process ownership.

## Launch path

```mermaid
flowchart LR
  P[Normal Pi] --> B[/automode bridge]
  B --> U[Stage selector]
  U --> D[Serialized configuration + SHA-256 confirmation]
  D --> H[Fresh child process]
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

The selector starts in Full-Auto, allows mode switching with `Tab`, stage focus changes with the arrow keys, stage toggling in Half-Auto with `Space`, and confirmation with `Enter`. Half-Auto defaults to Auto-Implement plus Auto-Review and permits any non-empty selection, including all four stages.

## Launch handoff

`docs/automode-launch.md` now documents the actual handoff contract: the bridge serializes the chosen Automation Stage Configuration, adds a confirmation digest, and passes both into the child process. The child rejects any changed payload before Main Session startup, validates the repository root, GitHub origin, and required permission, then runs the **Automode Capability Attestation Session**, persists the fixed Automode Run Record under the repository's Git common directory, and resolves nested working directories back to the repository root. `src/controlled-services.ts` and `src/capability-session.ts` define the controlled capability surface used for attestation; they do not construct Ticket Sessions.

## Stage configuration

`src/stage-configuration.ts` is the canonical contract. The four stages are Auto-Triage, Auto-Grilling, Auto-Implement, and Auto-Review. `createAutomationStageConfiguration` rejects unknown or duplicate stages, requires all four for Full-Auto, permits any non-empty Half-Auto selection including all four, and stores stages in canonical order. The bridge serializes that object and hashes it with SHA-256; `parseConfirmedAutomationStageConfiguration` uses a timing-safe comparison before parsing again in the child.

## Startup ordering and change safety

The child calls `startAutomodeMainSession`, which validates repository identity, GitHub origin/authentication/access, resolves the authenticated GitHub actor from `gh auth status --active` metadata, applies stage-dependent permission (`TRIAGE` for read-oriented stages and `WRITE` when implement or review is enabled), and checks required Pi/Claude Code execution profiles before acquiring the Coordinator or persisting the run record. GitHub startup failures are retried for up to 30 seconds before the startup path fails closed. Claude Code profiles are additionally checked by `attestClaudeCodeExecutionProfile`, which requires authentication and probes the exact configured model and reasoning level with no tools or session persistence; a reported probe error fails closed. The capability and Coordinator details are canonical on the [architecture overview](../architecture/overview.md) and [capability boundary](../architecture/capability-boundary.md).

For launch changes, update bridge/selector serialization and child parsing together; focused tests cover cancellation, keyboard selection, digest tampering, environment tampering, and fresh-process ownership. The Main Session keeps `/drain` and `/exit` as the user-facing lifecycle controls; `/drain` gracefully drains and exits after active Ticket Sessions settle, `/exit` force-stops active Ticket Sessions and exits after cleanup, and Automode does not intercept `Ctrl-C` so Pi retains its default TUI behavior. Do not reintroduce interrupt-based shutdown claims in launch docs. `npm run prove:handoff` is conditional and required when terminal ownership or child handoff behavior changes.

## Local documentation refresh

OpenWiki documentation is refreshed locally with:

```sh
OPENWIKI_PROVIDER=openai-chatgpt openwiki code --update --print
```

The repository intentionally has no OpenWiki CI workflow. Regeneration stays local because it uses the saved ChatGPT-subscription login rather than a metered API key.

## Why this matters

For future implementation work, the automation story should answer:

- how `/automode` is invoked from the normal Pi experience
- how the fixed launch-baseline stage configuration is serialized and confirmed across the process boundary
- how Automode stays isolated from normal Pi configuration
- how the Main Session persists its fixed Automode Run Record after validation, while the Capability Profile remains an in-memory allowlist
- how the repository-level Coordinator identity and lock are shared through the Git common directory
- how local documentation refreshes fit into the repo's maintenance loop

## Evidence

- [`README.md`](../../README.md)
- [`docs/automode-launch.md`](../../docs/automode-launch.md)
- [`AGENTS.md`](../../AGENTS.md)
- [`CLAUDE.md`](../../CLAUDE.md)