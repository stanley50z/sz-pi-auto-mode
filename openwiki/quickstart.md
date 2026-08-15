---
type: "Repository Guide"
title: "OpenWiki quickstart"
description: "Entry point for navigating the Automode repository architecture, launch workflow, capability boundary, bundled skills, integrations, and focused validation paths."
tags: [repository, automode, navigation]
openwiki:
  roles: [repository, architecture, testing]
  change_kinds: [public-api, lifecycle, configuration]
  source_paths: [README.md, src/automode-main.ts, src/startup.ts, package.json]
  validation_commands: [npm run build]
---

# OpenWiki quickstart

This repository is an early-stage Pi extension centered on **Automode**, a distinct repository-scoped experience for automating the Matt Pocock workflow. The current source evidence says:

- the product launches from **`/automode` inside normal Pi**
- `pi automode` is obsolete in the agent guidance
- Automode uses an immutable stage configuration, a confirmed handoff digest, and a repository-scoped Main Session / Ticket Session split
- startup fails closed until repository access, the Automode Capability Attestation Session, canonical skill provenance, and the repository Coordinator lock all validate
- the MVP is organized into four Automation Stages: Auto-Triage, Auto-Grilling, Auto-Implement, and Auto-Review
- panel-enabled startup authenticates Claude Code and probes each exact configured Claude Code model/reasoning profile
- the Automode Run Record is shared through the Git common directory, independently of Pi home/config roots
- Personal-WeChat integration is planned separately from the Automode MVP

Start here, then follow the section pages below for the repository's runtime seams and change-routing guidance.

## Change-routing table

| Change area or user intent | Relevant wiki page | Exact source entry points | Important symbols or types | Focused tests | Minimal validation command |
|---|---|---|---|---|---|
| Change `/automode` launch or handoff | [Launch and automation](workflows/launch-and-automation.md) | `src/bridge.ts`, `src/launch.ts`, `src/automode-main.ts` | `startAutomodeMainSession`, `parseConfirmedAutomationStageConfiguration` | `test/bridge.test.ts`, `test/stage-configuration.test.ts`, `test/process-handoff.test.ts` | `npm run build && node --test dist/test/bridge.test.js dist/test/stage-configuration.test.js dist/test/process-handoff.test.js` |
| Change startup safety, GitHub access, or Claude Code probes | [Architecture overview](architecture/overview.md) | `src/startup.ts`, `src/automode-main.ts` | `validateAutomodeStartup`, `attestClaudeCodeExecutionProfile` | `test/startup.test.ts` | `npm run build && node --test dist/test/startup.test.js` |
| Change skills, tools, models, or resource isolation | [Capability boundary](architecture/capability-boundary.md) | `src/capability-profile.ts`, `src/capability-session.ts`, `src/controlled-services.ts`, `src/attestation.ts` | `createAutomodeCapabilityProfile`, `createCapabilitySession`, `attestCanonicalCommands` | `test/capability-profile.test.ts`, `test/capability-session.test.ts`, `test/attestation.test.ts` | `npm run build && node --test dist/test/capability-profile.test.js dist/test/capability-session.test.js dist/test/attestation.test.js` |
| Add or route a bundled skill | [Skill catalog](skills/catalog.md) | `skills/native/*`, `skills/automode/*`, `src/capability-profile.ts` | `STAGE_SKILLS`, `CapabilitySkill` | `test/capability-profile.test.ts`, `test/capability-session.test.ts` | `npm run build && node --test dist/test/capability-profile.test.js dist/test/capability-session.test.js` |
| Change Coordinator/run persistence or repository paths | [Architecture overview](architecture/overview.md) | `src/coordinator-lock.ts`, `src/paths.ts`, `src/automode-main.ts` | `acquireRepositoryCoordinator`, `persistAutomodeRunRecord`, `AutomodePaths.runRecordFile` | `test/coordinator-lock.test.ts`, `test/main-session.test.ts`, `test/paths.test.ts` | `npm run build && node --test dist/test/coordinator-lock.test.js dist/test/main-session.test.js dist/test/paths.test.js` |
| Change `/fast` or provider request behavior | [Fast mode](integrations/fast-mode.md) | `src/fast-mode.ts`, `src/controlled-services.ts` | `createAutomodeFastModeExtension` | `test/capability-session.test.ts`, `test/real-pi-smoke.test.ts` | `npm run build && node --test dist/test/capability-session.test.js dist/test/real-pi-smoke.test.js` |

## What this wiki covers

- the product shape and why the repo exists
- the TypeScript application surfaces that implement Automode
- the Automode architecture boundary and stage model
- the launch and workflow surface described by the source docs
- the repository's operating conventions for issue tracking and local OpenWiki updates

## Major sections

- [Architecture overview](architecture/overview.md)
- [Launch and automation](workflows/launch-and-automation.md)
- [Capability boundary](architecture/capability-boundary.md)
- [Bundled skill catalog](skills/catalog.md)
- [Fast mode integration](integrations/fast-mode.md)
- [Personal WeChat integration](integrations/wechat.md)
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

## Backlog

- Work-queue discovery, ticket claiming, and Ticket Session recovery remain undocumented because the current implementation stops at the Main Session boundary (`src/automode-main.ts`); do not infer those workflows from the attestation session.
- Personal-WeChat transport remains planned without implementation evidence (`README.md`); see [Personal WeChat](integrations/wechat.md).

## Notes for future updates

The repository has TypeScript application code for startup validation, capability profiles and the Automode Capability Attestation Session, controlled services, fast mode, and repository Coordinator locking. Keep the durable persisted concept named the Automode Run Record; the capability profile is the allowlist used during session construction. The root `CONTEXT.md` remains the canonical vocabulary source.