# Architecture overview

The repository is currently a product scaffold rather than a finished application. The concrete source evidence now describes a repository-scoped **Automode** experience that starts from `/automode` inside normal Pi and runs with a controlled configuration, capability profile, skill set, prompt, and session boundary.

The current vocabulary in `CONTEXT.md` clarifies that Automode is a durable repository-scoped run with a Main Session that hosts the repository-singleton Automode Coordinator, while independent Ticket Sessions do the actual ticket work.

## Known architectural intent

### Automode isolation boundary

Automode is meant to leave the normal Pi experience and launch a fresh process for the repository's durable Automode Run. That implies a separate configuration boundary and explicit control over which skills and capabilities are available inside the Automode environment.

### Repository-scoped coordinator and ticket sessions

The MVP design distinguishes a repository-singleton **Automode Coordinator** in the Main Session from independent **Ticket Sessions** that do the actual work. The Coordinator supervises work, reconstructs state best-effort after restart, and never performs ticket work itself.

### Automation Stage model

The MVP has four independently selectable stages: Auto-Triage, Auto-Grilling, Auto-Implement, and Auto-Review. Full-Auto enables all four; Half-Auto enables one to three; planning remains human-controlled.

### Separate WeChat integration boundary

Personal-WeChat/OpenClaw channel integration is explicitly outside the Automode MVP and must be charted separately. That makes WeChat a future adjacent boundary rather than part of the current Automode architecture.

## What is not present yet

- no implementation files that show the actual `/automode` wiring
- no package manifest or runtime implementation in the inspected evidence
- no ADRs yet, so there are no written architectural decisions to defer to

## Where future agents should start

When code arrives, document:

1. the actual process entrypoint for `/automode`
2. the boundary between normal Pi config and Automode config
3. the Coordinator/Ticket Session lifecycle and recovery model
4. the interface between Automode and any future WeChat integration

## Evidence

- [`README.md`](../../README.md)
- [`AGENTS.md`](../../AGENTS.md)
- [`CLAUDE.md`](../../CLAUDE.md)