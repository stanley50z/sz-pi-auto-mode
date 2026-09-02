---
type: "Skill Catalog"
title: "Bundled Automode and native skills"
description: "Map of the repository's native shared/support skills and Automode stage-specific skills, including how capability profiles select them."
tags: [skills, automode, repository]
openwiki:
  roles: [repository, architecture, workflow]
  change_kinds: [configuration, public-api, runtime-snapshot]
  source_paths: [src/capability-profile.ts, src/global-skills.ts, src/runtime-snapshot.ts, skills/automode, skills/native]
  symbols: [createAutomodeCapabilityProfile, GLOBAL_SKILL_ALLOWLIST, resolveAllowlistedGlobalSkills, STAGE_SKILLS]
  test_paths: [test/capability-profile.test.ts, test/capability-session.test.ts, test/launch-runtime.test.ts, test/bundled-standards.test.ts]
  validation_commands: [npm run build, "node --test dist/test/capability-profile.test.js dist/test/capability-session.test.js dist/test/launch-runtime.test.js dist/test/bundled-standards.test.js"]
---

# Bundled Automode and native skills

The repository packages two skill trees. `skills/native` contains the baseline guidance available to the controlled profile; `skills/automode` contains extension-owned Automode Stage Skills that are preloaded and pre-attested regardless of launch baseline. In addition, the profile admits only the fixed installed-global allowlist `browser-harness` and `unslop` when exactly one valid installed source is discoverable. `src/capability-profile.ts` and `src/global-skills.ts` are the canonical registry/discovery seams; the Bridge snapshots admitted global skill directories so they remain stable for the process. Ticket Sessions receive one canonical `/skill:<name> <item-url>` command; the Coordinator selects the stage skill, while the child process loads the immutable capability configuration.

## Profile selection

| Category | Native counterparts | Automode resources |
|---|---|---|
| Shared | `wayfinder`, `to-spec`, `to-tickets`, `domain-modeling`, `research`, `codebase-design`, `commit`, `resolving-merge-conflicts`, `handoff`, `setup-matt-pocock-skills` | none |
| Support | `ketch`, `diagnosing-bugs`, `writing-for-agents`, `wizard` | `browser-harness`, `unslop` from the fixed installed-global allowlist when present |
| Auto-Triage | `triage` | `triage` |
| Auto-Grilling | `grilling` | `grilling` |
| Auto-Implement | `prototype`, `implement`, `tdd` | `prototype`, `implement`, `tdd` |
| Auto-Review | `code-review` | `code-review` |

Every extension-owned Automode Stage Skill is preloaded and pre-attested regardless of the launch baseline. An OFF Stage prevents Coordinator dispatch; it does not substitute a native skill inside Automode. Installed global skills are a separate support category: `resolveAllowlistedGlobalSkills` searches the normal Pi skill root and `~/.agents/skills`, admits at most one real-path source for each allowlisted name, and omits absent names. The launch Bridge copies admitted directories into the Automode Runtime Snapshot before handoff; later edits to the installed source affect only a later launch. This fixed capability profile is checked by test/capability-profile.test.ts and the snapshot/discovery seam by test/launch-runtime.test.ts. The Coordinator maps `auto-implement` to `prototype` when an item carries `wayfinder:prototype`, otherwise to `implement`; the remaining runtime mappings are `auto-triage` -> `triage`, `auto-grilling` -> `grilling`, and `auto-review` -> `code-review`. `createCanonicalTicketSessionPrompt` validates the skill slug and item URL before producing the child prompt.

The `/to-spec` skill treats a spec issue as a parent and progress tracker, not implementation work: it should receive a configured non-executable label such as `spec` and no triage state. `/to-tickets` creates and wires implementation tickets first, verifies their parent and blocking graph, and only then applies `ready-for-agent`. Coordinator dispatch independently enforces the non-executable `spec` and `wayfinder:map` labels, preventing mislabeled spec parents from entering Auto-Implement. These tracker-graph rules are covered by `skills/native/to-spec/SKILL.md`, `skills/native/to-tickets/SKILL.md`, `src/coordinator.ts`, and `test/coordinator.test.ts`.

Auto-Implement and Auto-Review use the Agent Brief as a verification contract when present. If no templated Agent Brief exists, the complete issue discussion may serve as an equivalent contract when it settles behavior, public seams, verification, dependencies, and human gates; absent template headings alone are not a blocker. A substantively incomplete contract or required human decision is instead an explicit blocker that the Stage Skill can report as `waiting` with a summary. This rule belongs to `skills/automode/implement/SKILL.md` and `skills/automode/code-review/SKILL.md`, with structural coverage in `test/bundled-standards.test.ts`. It is separate from the Ticket Session result transport and waiting lifecycle described in the [Coordinator page](../architecture/coordinator.md).

## Change navigation

When changing a skill, start with its `SKILL.md` and any referenced companion documents, then verify the corresponding registry entry and canonical command attestation. Stage behavior changes require the profile and capability-session tests; guidance-only changes normally need the bundled-standards tests when they affect required structure (for example, canonical Wayfinder map sections or triage label routing). The adjacent `normal-pi-discovery` tests cover the controlled resource-discovery contract when normal-Pi guidance or filtering changes. Do not hand-edit `dist/`; `npm run build` regenerates it from TypeScript. The [capability boundary](../architecture/capability-boundary.md) documents trust, resource allowlisting, and shipped-surface checks.
