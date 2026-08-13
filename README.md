# sz-pi-full-auto

An early-stage Pi extension that provides **Automode**, a distinct repository-scoped experience for automating the Matt Pocock workflow.

From a normal Pi session, invoke:

```text
/automode
```

The minimal **Automode Bridge** opens a Full-Auto/Half-Auto stage selector, leaves the normal Pi experience, and launches a fresh isolated Automode process in the same repository. Automode reuses Pi credentials but loads a controlled configuration, capability profile, skill set, prompt, and session boundary.

## Automode MVP

The MVP has four independently selectable **Automation Stages**:

- **Auto-Triage** — processes `needs-triage` issues.
- **Auto-Grilling** — resolves `wayfinder:grilling` tickets with an authoritative Grilling Session and an advisory Deliberation Panel.
- **Auto-Implement** — handles `wayfinder:prototype` tickets and implements `ready-for-agent` issues through non-draft pull-request creation.
- **Auto-Review** — reviews open non-draft pull requests with an in-house Review Panel, applies warranted fixes, validates, merges, and cleans up.

Full-Auto enables all four stages. Half-Auto enables one to three. The selected profile stays fixed for the durable Automode Run. The Main Session hosts a repository-singleton Automode Coordinator; independent Ticket Sessions perform ticket work. GitHub is the workflow source of truth, with best-effort recovery from tracker, Git/worktree, and native Pi session state.

Planning remains human-controlled: Wayfinder map creation, `to-spec`, and approved `to-tickets` decomposition are outside the automated stages.

The canonical implementation specification is [GitHub issue #21](https://github.com/stanley50z/sz-pi-full-auto/issues/21). Its decision history is indexed by the [Wayfinder map](https://github.com/stanley50z/sz-pi-full-auto/issues/1).

## Separately planned

Personal-WeChat/OpenClaw channel integration is outside the Automode workflow MVP and must be charted separately.

## Development proof

The isolated Pi process-handoff seam is runnable and documented in [docs/process-handoff-proof.md](docs/process-handoff-proof.md).
