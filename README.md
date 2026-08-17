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

The minimal **Automode Bridge** opens a keyboard-driven Full-Auto/Half-Auto stage selector. `Tab` changes mode, all four arrow keys move stage focus, `Space` toggles stages in Half-Auto, `Enter` launches, and `Escape` cancels without side effects. Confirmation serializes and confirms the immutable **Automation Stage Configuration**, leaves normal Pi, and launches a fresh isolated Main Session at the Git repository root. Automode reuses Pi credentials but loads an explicit fail-closed Capability Profile with isolated settings, resources, prompt, and session storage.

Before any work discovery, startup verifies the local Git root, authenticated GitHub repository access, every required execution profile, canonical skill identity/provenance, and the repository-singleton Coordinator lock. Enabled stages receive extension-owned Automode Stage Skills; disabled stages retain bundled unchanged native skills. Ambient global and project executable resources are excluded unless a project resource is both trusted and explicitly allowlisted; the controlled `/fast` command explicitly reuses normal Pi's synchronized OpenAI fast-mode state. Ordinary Ticket Sessions are fixed to Pi / `openai-codex/gpt-5.6-sol` / high reasoning. Each panel always includes a default Pi seat using the provider and model active when `/automode` launches; the current additional seats are Pi / `github-copilot/claude-fable-5` and Pi / `openai-codex/gpt-5.6-sol`, both at high reasoning. The Coordinator-bound Automode Run Record survives process restarts under the Git common directory, while an atomic live-process lock prevents competing Coordinators.

## Automode MVP

The MVP has four independently selectable **Automation Stages**:

- **Auto-Triage** — processes `needs-triage` issues.
- **Auto-Grilling** — resolves `wayfinder:grilling` tickets with an authoritative Grilling Session and an advisory Deliberation Panel.
- **Auto-Implement** — handles `wayfinder:prototype` tickets and implements `ready-for-agent` issues through non-draft pull-request creation.
- **Auto-Review** — reviews open non-draft pull requests with an in-house Review Panel, applies warranted fixes, validates, merges, and cleans up.

Full-Auto enables all four stages. Half-Auto enables one to three. The selected Automation Stage Configuration stays fixed for the durable Automode Run. The Main Session hosts a repository-singleton Automode Coordinator; independent full-process Ticket Sessions perform ticket work through deterministic canonical skill dispatch. The Coordinator reconciles durable bookkeeping before new claims, polls complete GitHub snapshots every 30 seconds, processes unrelated eligible items independently, requires clean turns plus fresh tracker proof, and enforces a five-attempt budget with two-phase shutdown. GitHub is the workflow source of truth, with best-effort recovery from tracker bookkeeping, deterministic `.worktree` branches, and native Pi session state. Auto-Grilling and Auto-Review use three fixed, independent, hidden-peer Panel seats; Auto-Implement creates non-draft pull requests and Auto-Review alone validates, fixes, merges, and cleans up.

Planning remains human-controlled: Wayfinder map creation, `to-spec`, and approved `to-tickets` decomposition are outside the automated stages.

The canonical implementation specification is [GitHub issue #21](https://github.com/stanley50z/sz-pi-auto-mode/issues/21). Its decision history is indexed by the [Wayfinder map](https://github.com/stanley50z/sz-pi-auto-mode/issues/1).

## Separately planned

Personal-WeChat/OpenClaw channel integration is outside the Automode workflow MVP and must be charted separately.

## Development proof

The `/automode` launch flow is documented in [docs/automode-launch.md](docs/automode-launch.md). The underlying isolated process-handoff seam is documented in [docs/process-handoff-proof.md](docs/process-handoff-proof.md).

Refresh generated OpenWiki documentation locally with `OPENWIKI_PROVIDER=openai-chatgpt openwiki code --update --print`. This repository intentionally has no OpenWiki CI or scheduled GitHub Actions workflow; do not hand-edit generated OpenWiki pages or generated agent-file blocks.
