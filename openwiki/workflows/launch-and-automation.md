---
type: "Runtime Workflow"
title: "Launch and automation"
description: "The Automode launch workflow from normal Pi through immutable stage selection, child-process handoff, fail-closed startup, capability attestation, and guarded Main Session startup."
tags: [automode, launch, workflow, handoff]
openwiki:
  roles: [workflow, runtime, testing]
  change_kinds: [lifecycle, public-api, security]
  source_paths: [src/bridge.ts, src/launch.ts, src/stage-configuration.ts, src/automode-main.ts, src/startup.ts]
  symbols: [createAutomationStageConfiguration, confirmSerializedAutomationStageConfiguration, startAutomodeMainSession]
  test_paths: [test/bridge.test.ts, test/selector.test.ts, test/stage-configuration.test.ts, test/launch-walkthrough.test.ts]
  invariants: [Full-Auto selects all four stages and Half-Auto selects one to three., The child rejects configuration or environment tampering before Main Session startup., Main Session is not a Ticket Session.]
  validation_commands: [npm run build, "node --test dist/test/bridge.test.js dist/test/selector.test.js dist/test/stage-configuration.test.js dist/test/launch-walkthrough.test.js"]
---

# Launch and automation

This repo's concrete workflow docs now center on the `/automode` launch bridge, the immutable stage configuration that survives the process handoff, and the fail-closed startup checks implemented in `src/startup.ts` before work discovery begins. The child persists the repository-scoped **Automode Run Record** only after startup validation and the **Automode Capability Attestation Session** succeed; `src/paths.ts` owns the repository-keyed Automode and Git common-directory paths. Panel-enabled startup attests the fixed panel execution profiles before work discovery, and the current MVP uses the default Pi seat active at launch plus the configured Pi / `github-copilot/claude-fable-5` and Pi / `openai-codex/gpt-5.6-sol` seats for grilling and review.
`docs/automode-launch.md` and `docs/process-handoff-proof.md` now describe the launch and handoff seam in more detail, including the terminal handoff, environment confirmation, and fresh child-process ownership.

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

The selector starts in Full-Auto, allows mode switching with `Tab`, stage focus changes with the arrow keys, stage toggling in Half-Auto with `Space`, and confirmation with `Enter`. Half-Auto is only valid when one to three stages are enabled.

## Launch handoff

`docs/automode-launch.md` now documents the actual handoff contract: the bridge serializes the chosen Automation Stage Configuration, adds a confirmation digest, and passes both into the child process. The child rejects any changed payload before Main Session startup, validates the repository root, GitHub origin, and required permission, then runs the **Automode Capability Attestation Session**, persists the fixed Automode Run Record under the repository's Git common directory, and resolves nested working directories back to the repository root. `src/controlled-services.ts` and `src/capability-session.ts` define the controlled capability surface used for attestation; they do not construct Ticket Sessions.

## Stage configuration

`src/stage-configuration.ts` is the canonical contract. The four stages are Auto-Triage, Auto-Grilling, Auto-Implement, and Auto-Review. `createAutomationStageConfiguration` rejects unknown or duplicate stages, requires all four for Full-Auto, permits one through three for Half-Auto, and stores stages in canonical order. The bridge serializes that object and hashes it with SHA-256; `parseConfirmedAutomationStageConfiguration` uses a timing-safe comparison before parsing again in the child.

## Startup ordering and change safety

The child calls `startAutomodeMainSession`, which validates repository identity, GitHub origin/authentication/access, resolves and validates the authenticated GitHub actor, applies stage-dependent permission (`TRIAGE` for read-oriented stages and `WRITE` when implement or review is enabled), and checks required Pi/Claude Code execution profiles before acquiring the Coordinator or persisting the run record. Claude Code profiles are additionally checked by `attestClaudeCodeExecutionProfile`, which requires authentication and probes the exact configured model and reasoning level with no tools or session persistence; a reported probe error fails closed. The capability and Coordinator details are canonical on the [architecture overview](../architecture/overview.md) and [capability boundary](../architecture/capability-boundary.md).

For launch changes, update bridge/selector serialization and child parsing together; focused tests cover cancellation, keyboard selection, digest tampering, environment tampering, and fresh-process ownership. Coordinator shutdown is two-phase: the first interrupt drains while preserving the repository lock, and the second forces active Ticket Sessions; disposal waits for Coordinator stop before releasing that lock. `npm run prove:handoff` is conditional and required when terminal ownership or child handoff behavior changes.

## Local documentation refresh

OpenWiki documentation is refreshed locally with:

```sh
OPENWIKI_PROVIDER=openai-chatgpt openwiki code --update --print
```

The repository intentionally has no OpenWiki CI workflow. Regeneration stays local because it uses the saved ChatGPT-subscription login rather than a metered API key.

## Why this matters

For future implementation work, the automation story should answer:

- how `/automode` is invoked from the normal Pi experience
- how the immutable stage configuration is serialized and confirmed across the process boundary
- how Automode stays isolated from normal Pi configuration
- how the Main Session persists its fixed Automode Run Record after validation, while the Capability Profile remains an in-memory allowlist
- how the repository-level Coordinator identity and lock are shared through the Git common directory
- how local documentation refreshes fit into the repo's maintenance loop

## Evidence

- [`README.md`](../../README.md)
- [`docs/automode-launch.md`](../../docs/automode-launch.md)
- [`AGENTS.md`](../../AGENTS.md)
- [`CLAUDE.md`](../../CLAUDE.md)