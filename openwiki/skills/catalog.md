---
type: "Skill Catalog"
title: "Bundled Automode and native skills"
description: "Map of the repository's native shared/support skills and Automode stage-specific skills, including how capability profiles select them."
tags: [skills, automode, repository]
openwiki:
  roles: [repository, architecture, workflow]
  change_kinds: [configuration, public-api]
  source_paths: [src/capability-profile.ts, skills/automode, skills/native]
  symbols: [createAutomodeCapabilityProfile, STAGE_SKILLS]
  test_paths: [test/capability-profile.test.ts, test/capability-session.test.ts]
  validation_commands: [npm run build, "node --test dist/test/capability-profile.test.js dist/test/capability-session.test.js"]
---

# Bundled Automode and native skills

The repository packages two skill trees. `skills/native` contains the baseline guidance available to the controlled profile; `skills/automode` contains stage-owned replacements used only when that stage is enabled. `src/capability-profile.ts` is the canonical registry and resolves each resource to an absolute source root so command provenance can be attested.

## Profile selection

| Category | Native resources | Automode resources |
|---|---|---|
| Shared | `wayfinder`, `to-spec`, `to-tickets`, `domain-modeling`, `research`, `codebase-design`, `commit`, `resolving-merge-conflicts`, `handoff`, `setup-matt-pocock-skills` | none |
| Support | `browser-harness`, `ketch`, `diagnosing-bugs`, `openwiki`, `writing-for-agents`, `wizard` | none |
| Auto-Triage | `triage` fallback | `triage` |
| Auto-Grilling | `grilling` fallback | `grilling` |
| Auto-Implement | `prototype`, `implement`, `tdd` fallback | `prototype`, `implement`, `tdd` |
| Auto-Review | `code-review` fallback | `code-review` |

Disabled stage skills remain native rather than disappearing, while enabled stages switch ownership to the Automode tree. This selection is part of the immutable capability profile and is checked by `test/capability-profile.test.ts`.

## Change navigation

When changing a skill, start with its `SKILL.md` and any referenced companion documents, then verify the corresponding registry entry and canonical command attestation. Stage behavior changes require the profile and capability-session tests; guidance-only changes normally need the bundled-standards tests when they affect required structure (for example, canonical Wayfinder map sections or triage label routing). The adjacent `normal-pi-discovery` tests cover the controlled resource-discovery contract when normal-Pi guidance or filtering changes. Do not hand-edit `dist/`; `npm run build` regenerates it from TypeScript. The [capability boundary](../architecture/capability-boundary.md) documents trust, resource allowlisting, and shipped-surface checks.
