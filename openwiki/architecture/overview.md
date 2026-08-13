# Architecture overview

The repository now has a concrete `/automode` launch seam. Normal Pi registers the command, shows a stage selector, serializes an immutable Automation Stage Configuration, and hands off to a fresh Automode Main Session in a child process.

The current vocabulary in `CONTEXT.md` matches the implementation more closely: Automode is a durable repository-scoped run with a Main Session that hosts the repository-singleton Automode Coordinator, while independent Ticket Sessions do the actual ticket work. Startup is intentionally fail-closed: the bridge and child validate repository identity, GitHub origin binding, required GitHub permission, fixed execution profiles, canonical skill provenance, and the live Coordinator lock before work discovery starts.

## Implemented architecture

### Bridge and child process boundary

`src/automode-main.ts`, `src/startup.ts`, `src/capability-profile.ts`, `src/capability-session.ts`, `src/controlled-services.ts`, and `src/coordinator-lock.ts` now implement the startup and session boundary. The bridge/launch seam serializes the selected Automation Stage Configuration, hands it to the child process, and the child rejects tampered payloads before Main Session startup.

### Immutable run configuration

`src/stage-configuration.ts` defines the four stages, the Full-Auto/Half-Auto modes, and the validation rules: Full-Auto requires all four stages, while Half-Auto requires one to three. `src/paths.ts` now owns `AutomodePaths.capabilityProfileFile` alongside the repository-scoped session and coordinator paths. `src/startup.ts` validates repository identity, GitHub origin binding, required permission, and execution profiles; `src/automode-main.ts` persists the confirmed run state to that capability-profile file only after startup validation and capability attestation succeed, and refuses to start a different configuration for the same run.

### Main Session, Coordinator, and ticket boundary

The Main Session is started with an Automode-specific system prompt and an extension that cancels session switching and forking. That keeps the Main Session as the coordinator boundary rather than a place where ticket work or session replacement can happen. `src/coordinator-lock.ts` keeps the durable Coordinator identity and the live `coordinator.lock` under the repository Git common directory, so different home/config roots still contend for the same repository-level Coordinator.

### Startup binding and stage model

Startup binds `gh` authentication to `github.com`, requires that the remote `origin` resolve to the same GitHub repository as the local checkout, and checks the required GitHub permission for the enabled stages before work discovery starts. `src/capability-profile.ts` and `src/capability-session.ts` define the fixed execution profiles, canonical skill provenance, and controlled-service boundaries. The MVP still has four independently selectable stages: Auto-Triage, Auto-Grilling, Auto-Implement, and Auto-Review. Full-Auto enables all four; Half-Auto enables one to three; planning remains human-controlled.

### Separate WeChat integration boundary

Personal-WeChat/OpenClaw channel integration is still explicitly outside the Automode MVP and remains a future adjacent boundary rather than part of the current Automode architecture.

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