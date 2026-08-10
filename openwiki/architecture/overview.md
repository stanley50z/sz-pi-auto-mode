# Architecture overview

The repository is currently a product scaffold rather than a finished application. The only concrete source evidence describes an **early-stage Pi extension** that runs an autonomous mode through `pi automode` and is meant to stay isolated from the user's normal Pi configuration.

## Known architectural intent

### Autonomous mode isolation

The README says automode is intended to be separated from the user's regular Pi setup. That implies future work will likely need a dedicated configuration boundary, separate runtime state, or a launch wrapper that prevents cross-contamination with the normal Pi environment.

### Planned workflow system

A workflow system is explicitly planned, with inspiration from Claude Code and Ben Davis's Pi workflow implementation. No implementation files exist yet, so this is only a design intent and not a documented behavior.

### Personal WeChat access path

The README also calls out a personal WeChat channel integration. The important architectural implication is that WeChat is not just a user-facing add-on; it is intended to be a distinct access surface for a Pi session.

## What is not present yet

- no application entrypoints beyond the product-level launch phrase
- no package manifest or runtime implementation in the inspected evidence
- no domain glossary files such as `CONTEXT.md`
- no ADRs yet, so there are no written architectural decisions to defer to

## Where future agents should start

When code arrives, document:

1. the actual process entrypoint for `pi automode`
2. the boundary between normal Pi config and automode config
3. the workflow engine's state, persistence, and execution model
4. the interface between the workflow system and the WeChat integration

## Evidence

- [`README.md`](../../README.md)
- [`AGENTS.md`](../../AGENTS.md)
- [`CLAUDE.md`](../../CLAUDE.md)