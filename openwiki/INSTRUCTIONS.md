---
type: Reference
title: OpenWiki generation brief
description: Repository-specific vocabulary, architecture constraints, and documentation requirements for the Automode code wiki.
tags: [openwiki, automode, documentation]
---

A code wiki for this repository.

Repository-specific constraints:

- Treat source code, tests, `CONTEXT.md`, and `docs/automode-launch.md` as authoritative.
- Use the exact domain vocabulary from `CONTEXT.md`. The persisted Coordinator-bound state is the **Automode Run Record**, not the Automode Capability Profile. Do not describe a capability profile as a durable run record or persisted file.
- The Automode Run Record lives under the Git common directory so linked worktrees and different Pi homes share one fixed run.
- The capability session used during startup is an **Automode Capability Attestation Session**, not a Ticket Session. Never describe `src/capability-session.ts` or `createCapabilitySession` as constructing or wiring Ticket Sessions.
- OpenWiki refresh is intentionally local-only with `OPENWIKI_PROVIDER=openai-chatgpt openwiki code --update --print`. This repository must not have or recommend a scheduled OpenWiki CI workflow.
- Preserve `/automode` as the launch entrypoint; `pi automode` is obsolete.
- The Main Session TUI uses `/automode` to gracefully drain and return terminal ownership to the original normal Pi session, `/drain` to gracefully drain and exit, and `/exit` to force-stop active Ticket Sessions before exit. Automode does not intercept `Ctrl-C`; Pi retains its default TUI behavior. Remove every generated claim that a first user interrupt drains or a second user interrupt forces, including in quickstart, architecture overview/coordinator/dashboard, and launch workflow pages. The Coordinator retains an internal two-phase lifecycle API, but the user-facing controls are these three slash commands.
- The Main Session status card shows repository/run identity, dashboard links, Stage states, candidate totals, poll timing, lifecycle guidance, and Tailscale errors. It does not show Ticket Session activity or a bounded activity summary.
- The Main Session inherits normal Pi's provider, model, and reasoning at `/automode` launch. Each new or resumed Ticket Session captures the Main Session's current execution at dispatch; running workers keep their captured settings. Both Panels keep Pi / `openai-codex/gpt-6-astra` and Pi / `github-copilot/claude-fable-5` as fixed high-reasoning seats. If neither seat matches the captured Main Session provider/model, add that execution as a third seat with inherited reasoning. Reasoning differences alone do not add a duplicate. Execution profiles remain process-local and are excluded from the Automode Run Record.
- Dashboard loopback ports are concurrent: the Coordinator prefers `41738` when available and otherwise requests a free loopback port, so different repositories can run dashboards at the same time. The CLI dashboard exposure handler owns only its exact Tailscale root handler: it reuses an existing handler targeting that dashboard URL or creates an unused HTTPS-port root handler, and shutdown removes only the handler it owns without replacing or removing handlers belonging to other processes. Tailscale exposure failure must leave the exact localhost dashboard URL available and surface the error in the supervision surfaces.
- The Bridge captures one immutable Automode Runtime Snapshot before process handoff. The Main Session, Ticket Sessions, Panel runtime code, bundled skills, package metadata, and runtime dependency packages use that snapshot. Rebuilding the installed development checkout affects only a later `/automode` launch. The Ticket Session runtime fingerprint guards the private snapshot against mutation; never describe checkout changes as draining an active Coordinator.
- Review Panel seats return non-empty Markdown, not model-authored structured JSON. Their parent-owned request contains only `round`, exact `headSha`, and a prose `brief`. `runReviewPanel` returns every completed attributed report alongside failed-seat diagnostics; it does not throw a review quorum `PanelRuntimeError` or discard successful reports. Grilling alone retains structured model answers.
- The authoritative Review Session publishes every completed seat as a commit-pinned GitHub pull-request review, with findings attached as inline comments on exact changed lines. Missing seats still block disposition, fixes, and merge after completed reviews are durable.
- Ticket Session IPC is protocol version 4; launch requests carry the validated `mainExecution` profile. Dashboard Ticket Session transcripts keep ordinary tools aggregated while `automode_panel` and native `subagent_*` launches remain visible. Panel seats stream and persist their bounded prompt, profile, pinned review head, lifecycle, assistant/thinking activity, and aggregate tool counts as validated nested-session events for a read-only split child-session inspector. This observation path does not add native subagent capabilities to Automode.
- Keep Personal-WeChat outside the Automode MVP.
