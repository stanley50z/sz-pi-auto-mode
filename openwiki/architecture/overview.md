---
type: "Architecture Overview"
title: "Automode architecture overview"
description: "Startup, capability attestation, Main Session bootstrapping, and the durable Automode Run Record that anchors one repository-scoped run."
tags: [automode, architecture, startup, attestation, run-record]
openwiki:
  roles: [architecture, lifecycle, integration, testing]
  change_kinds: [lifecycle, integration, persistence, security]
  source_paths: [src/automode-main.ts, src/startup.ts, src/capability-session.ts, src/session.ts, src/paths.ts, src/coordinator-lock.ts, src/stage-configuration.ts, README.md, docs/automode-launch.md, CONTEXT.md]
  symbols: [startAutomodeMainSession, validateAutomodeStartup, createCapabilitySession, createMainSessionRuntime, acquireRepositoryCoordinator, persistAutomodeRunRecord]
  test_paths: [test/startup.test.ts, test/stage-configuration.test.ts, test/coordinator.test.ts]
  invariants: [The Automode Run Record stores the durable launch baseline, default Reviewer execution profile, and allowlisted project skill files., The record excludes process-local Automation Stage Operating State., /automode launches a fresh Main Session; normal Pi does not gain Automode capabilities in-place., Linked worktrees and different Pi homes must converge on one Coordinator-bound run under the Git common directory., Startup fails closed before work discovery if repository identity, GitHub write access, execution profiles, or canonical skills cannot be attested., The capability attestation session is startup-only and is disposed before Main Session creation.]
  validation_commands: [npm run build, "node --test dist/test/stage-configuration.test.js dist/test/startup.test.js dist/test/main-session.test.js dist/test/coordinator.test.js"]
---

# Automode architecture overview

The architecture is a two-step boundary:

1. a bridge and startup phase validate the repository, attested capability surface, and durable launch baseline;
2. a Main Session phase hosts the repository singleton Coordinator for the active Automode Run.

## Startup path

`src/automode-main.ts` is the top-level orchestrator. It parses the confirmed Automation Stage Configuration, calls `validateAutomodeStartup`, acquires the repository Coordinator lease, performs startup-only capability attestation, creates the Main Session runtime, and then persists the Automode Run Record.

The important detail is ordering:

- the launch configuration is confirmed before any run state is created;
- startup validation proves the repository root, GitHub identity, repository slug, and required execution profiles;
- `createCapabilitySession` is used only for attestation and is disposed before the Main Session exists;
- only after those checks does the code create the Main Session runtime and write the run record.

`src/startup.ts` performs the fail-closed checks. It verifies Git root identity, GitHub origin, authenticated GitHub actor, repository view permission, and the required execution profiles. It also attests every required panel execution profile, even when a corresponding panel stage starts `OFF`, so later process-local state changes do not widen the capability boundary.

## Automode Run Record

The Automode Run Record is the Coordinator-bound durable record that anchors one Automode Run. It stores:

- the repository Coordinator identity,
- the fixed Automation Stage Configuration baseline,
- the default Reviewer execution profile,
- and the explicitly allowlisted project skill files.

It does not store the live Automation Stage Operating State. That state belongs to the Coordinator process and is restored from the baseline whenever the Coordinator restarts.

`startAutomodeMainSession` writes the record under the repository's Git common directory. That placement keeps linked worktrees and different Pi homes in the same durable run rather than letting them diverge into separate baseline values.

## Main Session and Coordinator

The Main Session is the repository-scoped session that hosts the Automode Coordinator. It is not a Ticket Session and it does not do tracker work. Its job is to keep the repository singleton session alive, append the stage configuration and coordinator metadata to the native session history, and expose lifecycle hooks for starting and interrupting the Coordinator.

`AutomodeCoordinator` is constructed with:

- the confirmed launch configuration,
- the authenticated actor,
- the GitHub tracker,
- the Ticket Session host,
- and the workspace manager.

The Coordinator restores process-local stage operating states from the durable baseline, then takes over discovery, dispatch, recovery, and polling.

## Change guidance

Change this page when you touch any of the following:

- startup validation or GitHub attestation in `src/startup.ts`,
- run-record persistence or coordinator lease handling in `src/automode-main.ts`,
- capability-session startup semantics in `src/capability-session.ts`,
- or the baseline/operating-state split in `src/stage-configuration.ts`.

Keep the following stable:

- the capability attestation session is startup-only,
- the Automode Run Record remains the durable source for the launch baseline,
- and live operating-state edits are not persisted across Coordinator restarts.
