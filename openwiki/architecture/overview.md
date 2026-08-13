# Architecture overview

The repository now has a concrete `/automode` launch seam. Normal Pi registers the command, shows a stage selector, serializes an immutable Automation Stage Configuration, and hands off to a fresh Automode Main Session in a child process.

The current vocabulary in `CONTEXT.md` matches the implementation more closely: Automode is a durable repository-scoped run with a Main Session that hosts the repository-singleton Automode Coordinator, while independent Ticket Sessions do the actual ticket work.

## Implemented architecture

### Bridge and child process boundary

`src/bridge.ts` registers `/automode` as a Pi extension command. The command waits for idle, opens the selector only in TUI mode, and launches the child with the repository root plus a serialized Automation Stage Configuration. `src/launch.ts` then passes `AUTOMODE_STAGE_CONFIGURATION` and a SHA-256 confirmation digest into the child process, which rejects tampered payloads before Main Session startup.

### Immutable run configuration

`src/stage-configuration.ts` defines the four stages, the Full-Auto/Half-Auto modes, and the validation rules: Full-Auto requires all four stages, while Half-Auto requires one to three. `src/automode-main.ts` persists the confirmed configuration to `~/.pi/automode/<repository-key>/stage-configuration.json` and refuses to start a different configuration for the same run.

### Main Session and ticket boundary

The Main Session is started with an Automode-specific system prompt and an extension that cancels session switching and forking. That keeps the Main Session as the coordinator boundary rather than a place where ticket work or session replacement can happen.

### Stage model

The MVP still has four independently selectable stages: Auto-Triage, Auto-Grilling, Auto-Implement, and Auto-Review. Full-Auto enables all four; Half-Auto enables one to three; planning remains human-controlled.

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