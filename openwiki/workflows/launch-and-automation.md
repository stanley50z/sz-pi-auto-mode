---
type: "Workflow"
title: "Launch and automation"
description: "The /automode launch workflow, from the bridge selector through terminal handoff, startup attestation, coordinator lock acquisition, and Main Session bootstrapping."
tags: [automode, workflow, launch, startup]
openwiki:
  roles: [workflow, lifecycle, integration, testing]
  change_kinds: [launch, startup, handoff, coordination]
  source_paths: [src/bridge.ts, src/launch.ts, src/stage-configuration.ts, src/automode-main.ts, src/startup.ts, src/capability-session.ts, src/coordinator-lock.ts, src/coordinator.ts, src/ticket-session.ts, docs/automode-launch.md]
  symbols: [automodeBridge, selectAutomationStageConfiguration, createAutomodeLaunchPlan, launchAutomode, createAutomationStageConfiguration, serializeAutomationStageConfiguration, validateAutomodeStartup, attestClaudeCodeExecutionProfile, acquireRepositoryCoordinator, AutomodeCoordinator, createCanonicalTicketSessionPrompt]
  test_paths: [test/bridge.test.ts, test/selector.test.ts, test/stage-configuration.test.ts, test/process-handoff.test.ts, test/startup.test.ts, test/main-session.test.ts]
  invariants: [The /automode entrypoint must leave normal Pi and start a fresh Automode process rather than toggling Pi in place., The selected Automation Stage Configuration is serialized and confirmed before launch, then treated as the durable baseline for the run., The capability attestation session is startup-only and ends before the Main Session starts., The Coordinator lock and durable identity live under the Git common directory so linked worktrees share one run., Ticket Sessions remain isolated child processes and never become the Main Session itself.]
  validation_commands: [npm run build, "node --test dist/test/bridge.test.js dist/test/selector.test.js dist/test/stage-configuration.test.js dist/test/process-handoff.test.js dist/test/startup.test.js dist/test/main-session.test.js"]
---

# Launch and automation

This workflow starts in normal Pi and ends with a running Automode Coordinator in a new Main Session.

## Launch entrypoint

`src/bridge.ts` registers `/automode` as the extension command. The bridge waits for Pi to go idle, opens the selector, captures the current Pi model as the default Reviewer seat, and launches Automode with the confirmed configuration.

`src/stage-configuration.ts` owns the launch baseline rules:

- Full-Auto selects all four Automation Stages;
- Half-Auto requires at least one selected stage;
- the serialized configuration is confirmed before launch;
- and the selected baseline is ordered deterministically.

## Child-process handoff

`src/launch.ts` turns the confirmed request into the child-process plan and passes the serialized configuration, confirmation digest, and default Reviewer execution profile into the child environment. `docs/automode-launch.md` documents the user-visible launch behavior and the handoff boundary.

The launch path is intentionally one-way: normal Pi exits after the child is handed the terminal.

## Startup and coordinator boot

`src/automode-main.ts` performs the repository launch sequence inside the child process. The order matters:

1. validate repository identity and GitHub access;
2. attest the required execution profiles;
3. acquire the repository Coordinator lock;
4. create and dispose the startup-only capability session;
5. start the Main Session and persist the durable Automode Run Record.

`src/coordinator-lock.ts` keeps one live Coordinator per repository. The durable coordinator identity and lock live under the Git common directory so different Pi homes and linked worktrees still share the same run.

## Coordinator and Ticket Sessions

`src/coordinator.ts` owns dispatch, retry, recovery, and stage precedence after startup. It never does ticket work itself. Instead, it claims eligible work and launches isolated Ticket Sessions.

`src/ticket-session.ts` keeps each ticket in its own durable logical Pi session, with canonical prompting and persistent history. The Main Session hosts the Coordinator; the Coordinator hosts the workflow; the Ticket Session does the item work.

## Validation and source of truth

The launch behavior is documented in `docs/automode-launch.md`. The code path and tests are the source of truth when they disagree with prose.

## Change guidance

Update this page when the bridge flow changes, when launch serialization or confirmation changes, when startup adds or removes a gate, or when the Coordinator/Ticket Session boundary changes.