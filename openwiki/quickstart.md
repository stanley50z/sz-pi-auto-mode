---
type: "Quickstart"
title: "OpenWiki quickstart"
description: "Entry point for Automode documentation, with links to the architecture, workflow, skill catalog, and related operational notes."
tags: [openwiki, quickstart, automode]
openwiki:
  roles: [entrypoint, navigation]
  change_kinds: [documentation, navigation]
  source_paths: [README.md, CONTEXT.md, docs/automode-launch.md, src/bridge.ts, src/launch.ts, src/stage-configuration.ts, src/startup.ts, src/coordinator.ts, src/ticket-session-main.ts, src/ticket-session.ts]
  symbols: [automodeBridge, selectAutomationStageConfiguration, createAutomodeLaunchPlan, launchAutomode, createAutomationStageConfiguration, serializeAutomationStageConfiguration, validateAutomodeStartup, AutomodeCoordinator, createCanonicalTicketSessionPrompt]
  test_paths: [test/bridge.test.ts, test/selector.test.ts, test/stage-configuration.test.ts, test/startup.test.ts, test/coordinator.test.ts, test/main-session.test.ts]
  routing_table:
    - label: Architecture overview
      path: architecture/overview.md
      purpose: "How startup, attestation, the Main Session, and the Coordinator fit together."
    - label: Capability boundary
      path: architecture/capability-boundary.md
      purpose: "What the fail-closed capability profile exposes and how it is attested."
    - label: Skill catalog
      path: skills/catalog.md
      purpose: "How the bundled shared, support, and stage skills are grouped."
    - label: Launch and automation
      path: workflows/launch-and-automation.md
      purpose: "How /automode launches, hands off the terminal, and boots the durable run."
    - label: Operations
      path: operations.md
      purpose: "Repository maintenance, validation, and OpenWiki refresh notes."
  validation_commands: [npm run build, npm test]
---

# OpenWiki quickstart

Start here when you need the documented shape of Automode in this repository.

## What this wiki covers

This wiki explains the launch bridge, the fail-closed startup path, the durable Automode Run Record, the repository Coordinator, the controlled capability boundary, and the bundled skills that are available to Automode sessions.

## Where to go next

- [Architecture overview](architecture/overview.md) — startup order, capability attestation, Main Session responsibilities, and Coordinator lifecycle.
- [Capability boundary](architecture/capability-boundary.md) — the allowlisted skills, tools, settings, and startup attestation boundary.
- [Skill catalog](skills/catalog.md) — the native shared/support skills and Automode stage skills that make up the controlled skill surface.
- [Launch and automation](workflows/launch-and-automation.md) — `/automode`, the bridge, stage selection, terminal handoff, and run startup.
- [Operations](operations.md) — repository maintenance and validation guidance.

## Routing table

| Area | Page | Use when |
| --- | --- | --- |
| Architecture | [Architecture overview](architecture/overview.md) | You need the startup and runtime model. |
| Architecture | [Capability boundary](architecture/capability-boundary.md) | You need the exact fail-closed capability surface. |
| Skills | [Skill catalog](skills/catalog.md) | You need the canonical bundled skill groups. |
| Workflows | [Launch and automation](workflows/launch-and-automation.md) | You need the `/automode` launch path. |
| Operations | [Operations](operations.md) | You need repo-level validation or wiki maintenance notes. |

## Important vocabulary

- **Automode Bridge**: the `/automode` entrypoint that confirms a launch baseline and exits normal Pi before starting Automode.
- **Automation Stage Configuration**: the durable launch baseline that records Full-Auto or Half-Auto plus the selected stages.
- **Automode Run Record**: the Coordinator-bound durable record under the Git common directory.
- **Main Session**: the repository-scoped session that hosts the Automode Coordinator.
- **Ticket Session**: a durable logical Pi session for one eligible tracker item.

## Change guidance

Update this page when the top-level navigation changes, when the launch path changes materially, or when the repository adds or removes a major documentation section.