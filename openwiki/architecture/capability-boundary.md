---
type: "Architecture Detail"
title: "Automode capability boundary"
description: "The fail-closed capability surface for Automode sessions, including skill allowlists, controlled services, startup attestation, and the startup-only capability session."
tags: [automode, architecture, capability, attestation, skills]
openwiki:
  roles: [architecture, lifecycle, security, testing]
  change_kinds: [capability, attestation, security, integration]
  source_paths: [src/capability-profile.ts, src/capability-session.ts, src/controlled-services.ts, src/attestation.ts, src/startup.ts]
  symbols: [createAutomodeCapabilityProfile, parsePiExecutionProfile, createControlledServices, controlledGuidanceFiles, attestCanonicalCommands, isPathInside, validateAutomodeStartup, attestClaudeCodeExecutionProfile]
  test_paths: [test/capability-profile.test.ts, test/capability-session.test.ts, test/attestation.test.ts, test/startup.test.ts]
  invariants: [Automode sessions use a hard-coded fail-closed profile instead of inheriting arbitrary Pi capabilities., The capability attestation session exists only during startup and is disposed before Main Session creation., Controlled services load only repository guidance, allowed skill paths, and the controlled fast-mode extension., Canonical skill provenance must resolve to each skill's SKILL.md and stay inside the repository., Startup fails closed if required Pi or Claude Code execution profiles are missing or invalid.]
  validation_commands: [npm run build, "node --test dist/test/capability-profile.test.js dist/test/capability-session.test.js dist/test/attestation.test.js dist/test/startup.test.js"]
---

# Automode capability boundary

The capability boundary defines what an Automode run may see before work starts and what it may not inherit from normal Pi.

## What is included

`src/capability-profile.ts` builds the explicit Automode capability profile:

- shared native skills such as `wayfinder`, `to-spec`, `to-tickets`, `domain-modeling`, `research`, `codebase-design`, `commit`, `resolving-merge-conflicts`, `handoff`, and `setup-matt-pocock-skills`;
- support skills such as `browser-harness`, `ketch`, `diagnosing-bugs`, `openwiki`, `writing-for-agents`, and `wizard`;
- stage skills owned by Automode for triage, grilling, implementation, and review;
- a fixed tool list, controlled settings, and the ordinary / panel execution profiles.

The profile is explicit and deterministic. It is not discovered from ambient Pi state.

## Startup attestation

`src/startup.ts` uses the capability profile to attest the required execution surface before the Main Session exists. The startup path validates:

- the repository root and GitHub identity;
- the default Reviewer execution profile;
- any additional panel execution profiles, even if their panel stages start `OFF`;
- and the Claude Code profile when the selected profile requires it.

That attestation is fail-closed. If a required profile is unavailable, startup stops before Automode can claim the repository Coordinator.

## Controlled services and provenance

`src/controlled-services.ts` narrows the session services to the repository guidance and the allowlisted skill roots. It loads only markdown guidance files that stay inside the repository and pulls in `CONTEXT.md` when present.

`src/attestation.ts` verifies two important properties:

- canonical commands exist exactly once for the expected skill roots;
- each command resolves to the matching `SKILL.md` under the canonical source root and not outside the repository.

This is what keeps the capability boundary tied to the intended source tree instead of ambient global or project-wide resources.

## Capability session lifecycle

`src/capability-session.ts` constructs the Automode Capability Attestation Session only for startup. The session is a temporary attestation boundary, not a persisted run record and not a replacement for the Main Session.

The correct responsibility split is:

- capability session: prove the controlled surface at startup;
- main session: host the Automode Coordinator after attestation succeeds.

## Change guidance

Update this page when the allowlisted skills change, when controlled guidance loading changes, when attestation rules change, or when startup begins checking a new execution profile.

Keep the durable record semantics stable: the Automode Run Record stores launch configuration and coordinator identity, not the live capability session state.