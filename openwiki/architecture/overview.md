---
type: "Architecture Overview"
title: "Architecture overview"
description: "Runtime architecture for the Automode bridge, immutable configuration, fail-closed startup, controlled capability session, Main Session, and repository Coordinator lifecycle."
tags: [automode, architecture, lifecycle, startup]
openwiki:
  roles: [architecture, runtime, testing]
  change_kinds: [lifecycle, public-api, security]
  source_paths: [src/bridge.ts, src/automode-main.ts, src/startup.ts, src/coordinator-lock.ts]
  symbols: [startAutomodeMainSession, validateAutomodeStartup, acquireRepositoryCoordinator]
  test_paths: [test/startup.test.ts, test/main-session.test.ts, test/coordinator-lock.test.ts]
  invariants: [Startup validation and execution attestation complete before work discovery., One live repository Coordinator owns the durable run., Main Session replacement and forking are cancelled.]
  validation_commands: [npm run build, "node --test dist/test/startup.test.js dist/test/main-session.test.js dist/test/coordinator-lock.test.js"]
---

# Architecture overview

The repository now has a concrete `/automode` launch seam. Normal Pi registers the command, shows a stage selector, serializes an immutable Automation Stage Configuration, and hands off to a fresh Automode Main Session in a child process.

The current vocabulary in `CONTEXT.md` matches the implementation: Automode is a durable repository-scoped run with a Main Session that hosts the repository-singleton Automode Coordinator, while independent Ticket Sessions do the actual ticket work. Startup is intentionally fail-closed: the bridge and child validate repository identity, GitHub origin binding, required GitHub permission, fixed execution profiles, canonical skill provenance, and the live Coordinator lock before work discovery starts. The persisted Coordinator-bound state is the **Automode Run Record**, not the Automode Capability Profile. The capability session used during startup is the **Automode Capability Attestation Session**, not a Ticket Session.

## Implemented architecture

### Bridge and child process boundary

`src/automode-main.ts`, `src/startup.ts`, `src/capability-profile.ts`, `src/capability-session.ts`, `src/controlled-services.ts`, and `src/coordinator-lock.ts` now implement the startup and session boundary. The bridge/launch seam serializes the selected Automation Stage Configuration, hands it to the child process, and the child rejects tampered payloads before Main Session startup. `createCapabilitySession` is specifically the startup-only Automode Capability Attestation Session; Ticket Session construction is a later, currently undocumented boundary.

### Immutable run configuration

`src/stage-configuration.ts` defines the four stages, the Full-Auto/Half-Auto modes, and the validation rules: Full-Auto requires all four stages, while Half-Auto requires one to three. `src/startup.ts` validates repository identity, GitHub origin binding, required permission, and execution profiles; `src/automode-main.ts` persists the confirmed **Automode Run Record** only after startup validation and capability attestation succeed, and refuses to start a different configuration for the same run. The capability profile remains the in-memory allowlist used to construct and attest sessions.

### Main Session, Coordinator, and ticket boundary

The Main Session is started with an Automode-specific system prompt and an extension that cancels session switching and forking. That keeps the Main Session as the coordinator boundary rather than a place where ticket work or session replacement can happen. `src/coordinator-lock.ts` keeps the durable Coordinator identity and the live `coordinator.lock` under the repository Git common directory, so different home/config roots still contend for the same repository-level Coordinator.

### Startup binding and stage model

Startup binds `gh` authentication to `github.com`, requires that the remote `origin` resolve to the same GitHub repository as the local checkout, and checks the required GitHub permission for the enabled stages before work discovery starts. `src/startup.ts` also authenticates Claude Code and runs an exact configured model/reasoning probe for each required Claude Code execution profile; a reported probe error fails closed. `src/capability-profile.ts` and `src/capability-session.ts` define the fixed execution profiles, canonical skill provenance, and controlled-service boundaries. The MVP still has four independently selectable stages: Auto-Triage, Auto-Grilling, Auto-Implement, and Auto-Review. Full-Auto enables all four; Half-Auto enables one to three; planning remains human-controlled.

### Run and Coordinator lifecycle

`startAutomodeMainSession` verifies the confirmed configuration, validates the repository and GitHub binding, attests required execution profiles, acquires the repository Coordinator lease, creates and disposes the **Automode Capability Attestation Session**, creates the Main Session, and only then persists the fixed Automode Run Record to `automode-run.json`. The record contains the Coordinator ID, stage configuration, and project-resource selection; the capability profile itself remains an in-memory allowlist. Any failure disposes the provisional runtime and releases the lease. `acquireRepositoryCoordinator` stores a durable UUID in `coordinator-identity.json` and uses `coordinator.lock` with stale-lock recovery; the Git common-directory paths from `src/paths.ts` make linked worktrees and different Pi homes contend for the same owner and run record. A second live owner fails closed, while repeated starts reuse the identity and reject a changed run configuration.

```mermaid
sequenceDiagram
  participant B as Bridge
  participant M as Main child
  participant V as Startup validation
  participant L as Coordinator lease
  participant C as Capability session
  participant S as Main Session
  B->>M: serialized configuration + digest
  M->>V: validate repository, GitHub, profiles
  V-->>M: validated startup
  M->>L: acquire repository lock
  M->>C: create Capability Attestation Session
  C-->>M: attested capability surface
  M->>S: create guarded Main Session
  M->>M: persist Automode Run Record
  S-->>B: interactive Automode run
```

*The ordering is fail-closed: no run record or work discovery precedes validation and attestation.*

### Separate WeChat integration boundary

Personal-WeChat/OpenClaw channel integration is still explicitly outside the Automode MVP and remains a future adjacent boundary; see the [WeChat integration note](../integrations/wechat.md).

## Change navigation and validation

Start runtime changes at the owning symbol above, then follow the adjacent [capability boundary](capability-boundary.md) or [launch workflow](../workflows/launch-and-automation.md). Keep the focused tests in the front matter narrow. Use the full `npm test` only when changing package-wide lifecycle, public registration, or cross-boundary behavior; `npm run prove:handoff` is conditional for process-terminal handoff changes.

## What future agents should start with

When implementation evolves, document:

1. the Coordinator/Ticket Session lifecycle and recovery model
2. the boundary between normal Pi config and Automode config
3. any eventual work-queue discovery and ticket claiming logic
4. the interface between Automode and any future WeChat integration

## Evidence

- [`README.md`](../../README.md)
- [`CONTEXT.md`](../../CONTEXT.md)
- [`docs/automode-launch.md`](../../docs/automode-launch.md)
- [`src/bridge.ts`](../../src/bridge.ts)
- [`src/launch.ts`](../../src/launch.ts)
- [`src/automode-main.ts`](../../src/automode-main.ts)
- [`src/stage-configuration.ts`](../../src/stage-configuration.ts)