---
type: "Skills Catalog"
title: "Automode skill catalog"
description: "The bundled shared, support, and stage skills that Automode exposes through its explicit capability profile."
tags: [automode, skills, catalog, capability]
openwiki:
  roles: [architecture, skills, testing]
  change_kinds: [skills, capability, attestation]
  source_paths: [src/capability-profile.ts, src/capability-session.ts, src/attestation.ts, src/ticket-session-main.ts, src/controlled-services.ts, src/ticket-session.ts]
  symbols: [createAutomodeCapabilityProfile, parsePiExecutionProfile, createControlledServices, attestCanonicalCommands, createCanonicalTicketSessionPrompt]
  test_paths: [test/capability-profile.test.ts, test/capability-session.test.ts, test/ticket-session.test.ts]
  invariants: [Shared skills are native and reusable across Automode stages., Support skills are native helpers that remain available inside the fail-closed capability profile., Stage skills are owned by Automode and resolve to stage-specific canonical SKILL.md roots., Ticket Session prompts are canonical and must match the skill name and item URL exactly., Canonical command attestation rejects duplicate, missing, or off-root skill provenance.]
  validation_commands: [npm run build, "node --test dist/test/capability-profile.test.js dist/test/capability-session.test.js dist/test/ticket-session.test.js"]
---

# Automode skill catalog

This page maps the skill groups that the capability profile exposes to Automode.

## Shared native skills

`src/capability-profile.ts` includes the shared native skills that Automode reuses across stages:

- `wayfinder`
- `to-spec`
- `to-tickets`
- `domain-modeling`
- `research`
- `codebase-design`
- `commit`
- `resolving-merge-conflicts`
- `handoff`
- `setup-matt-pocock-skills`

These are treated as native shared skills, not Automode-owned stage skills.

## Native support skills

The capability profile also includes native support skills:

- `browser-harness`
- `ketch`
- `diagnosing-bugs`
- `openwiki`
- `writing-for-agents`
- `wizard`

They support controlled repository work but are still part of the native skill surface.

## Automode stage skills

Automode owns the stage-specific skills that are used to dispatch tracker work through Ticket Sessions:

- `triage`
- `grilling`
- `prototype`
- `implement`
- `tdd`
- `code-review`

`src/ticket-session-main.ts` verifies that the requested skill is one of these canonical Automode stage skills before creating the controlled Ticket Session environment.

## Why this catalog matters

The catalog is the public shape of the controlled skill surface. It matters because startup attestation and command provenance both depend on the same canonical names and source roots.

## Change guidance

Update this page when the capability profile adds or removes bundled skills, when a stage skill changes ownership, or when canonical ticket-session prompting changes.