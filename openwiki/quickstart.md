# OpenWiki quickstart

This repository is an early-stage Pi extension centered on **Automode**, a distinct repository-scoped experience for automating the Matt Pocock workflow. The current source evidence says:

- the product launches from **`/automode` inside normal Pi**
- `pi automode` is obsolete in the agent guidance
- Automode uses an immutable stage configuration, a confirmed handoff digest, and a repository-scoped Main Session / Ticket Session split
- startup fails closed until repository access, capability profile attestation, canonical skill provenance, and the repository Coordinator lock all validate
- the MVP is organized into four Automation Stages: Auto-Triage, Auto-Grilling, Auto-Implement, and Auto-Review
- Personal-WeChat integration is planned separately from the Automode MVP

Start here, then follow the section pages below for the small set of concepts that currently exist in the repo.

## What this wiki covers

- the product shape and why the repo exists
- the TypeScript application surfaces that implement Automode
- the Automode architecture boundary and stage model
- the launch and workflow surface described by the source docs
- the repository's operating conventions for issue tracking and local OpenWiki updates

## Major sections

- [Architecture overview](architecture/overview.md)
- [Launch and automation](workflows/launch-and-automation.md)
- [Integrations](integrations/wechat.md)
- [Operations](operations.md)

## Canonical source docs

- [`README.md`](../README.md) — top-level product framing and Automode MVP summary
- [`CONTEXT.md`](../CONTEXT.md) — canonical Automode domain language
- [`docs/agents/issue-tracker.md`](../docs/agents/issue-tracker.md) — GitHub issue workflow and Wayfinder conventions
- [`docs/agents/domain.md`](../docs/agents/domain.md) — how domain docs are meant to be consumed
- [`docs/agents/triage-labels.md`](../docs/agents/triage-labels.md) — label mapping for skills and triage

## Source evidence

- [`README.md`](../README.md) — product summary and MVP scope
- [`AGENTS.md`](../AGENTS.md) — OpenWiki guidance and `/automode` entrypoint note
- [`CLAUDE.md`](../CLAUDE.md) — the same OpenWiki guidance in a second agent-facing file

## Notes for future updates

The repository now has TypeScript application code for startup validation, capability profiles and sessions, controlled services, and repository coordinator locking, so the wiki should point readers to those implementation surfaces. `src/paths.ts` owns the repository-scoped `AutomodePaths.capabilityProfileFile` path, which is persisted only after startup validation and capability attestation succeed. The root `CONTEXT.md` still captures the current Automode vocabulary, but implementation files are now part of the source evidence.