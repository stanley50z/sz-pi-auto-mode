# sz-pi-auto-mode

An early-stage Pi extension that provides **Automode**, a distinct repository-scoped experience for automating the Matt Pocock workflow.

Install the local Pi package, then invoke the bridge from a normal Pi session:

```sh
npm ci
pi install .
```

```text
/automode
```

The minimal **Automode Bridge** opens a keyboard-driven Full-Auto/Half-Auto stage selector. `Tab` changes mode, all four arrow keys move stage focus, `Space` toggles stages in Half-Auto, `Enter` launches, and `Escape` cancels without side effects. Confirmation serializes and confirms the immutable **Automation Stage Configuration**, leaves normal Pi, and launches a fresh isolated Main Session at the Git repository root. Automode reuses Pi credentials but loads isolated settings, resources, prompt, and session storage.

## Automode MVP

The MVP has four independently selectable **Automation Stages**:

- **Auto-Triage** — processes `needs-triage` issues.
- **Auto-Grilling** — resolves `wayfinder:grilling` tickets with an authoritative Grilling Session and an advisory Deliberation Panel.
- **Auto-Implement** — handles `wayfinder:prototype` tickets and implements `ready-for-agent` issues through non-draft pull-request creation.
- **Auto-Review** — reviews open non-draft pull requests with an in-house Review Panel, applies warranted fixes, validates, merges, and cleans up.

Full-Auto enables all four stages. Half-Auto enables one to three. The selected Automation Stage Configuration stays fixed for the durable Automode Run. The Main Session hosts a repository-singleton Automode Coordinator; independent Ticket Sessions perform ticket work. GitHub is the workflow source of truth, with best-effort recovery from tracker, Git/worktree, and native Pi session state.

Planning remains human-controlled: Wayfinder map creation, `to-spec`, and approved `to-tickets` decomposition are outside the automated stages.

The canonical implementation specification is [GitHub issue #21](https://github.com/stanley50z/sz-pi-auto-mode/issues/21). Its decision history is indexed by the [Wayfinder map](https://github.com/stanley50z/sz-pi-auto-mode/issues/1).

## Separately planned

Personal-WeChat/OpenClaw channel integration is outside the Automode workflow MVP and must be charted separately.

## Development proof

The `/automode` launch flow is documented in [docs/automode-launch.md](docs/automode-launch.md). The underlying isolated process-handoff seam is documented in [docs/process-handoff-proof.md](docs/process-handoff-proof.md).
