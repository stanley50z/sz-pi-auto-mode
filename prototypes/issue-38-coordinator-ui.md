# Issue #38 — Automode Coordinator UI prototype

> **Throwaway prototype.** This branch explores interaction design only. Do not promote this code directly into production.

## Question

Which information architecture lets a developer supervise an Automode Run without turning the Main Session into a Ticket Session?

## Human decision checkpoint

The first review settled the primary direction:

- The full Coordinator GUI is a repository-local **web app** served on `localhost` for the life of the Coordinator process.
- The Main Session TUI is intentionally small: it shows the dashboard URL plus general run statistics and shutdown guidance.
- The web app defaults to **Stage Lanes**.
- Each lane shows **all open stage candidates**, not only active Ticket Sessions: queued, claimed/starting, running, waiting, blocked, exhausted, and human-owned items.
- Every non-running card explains why Automode has not picked it up yet.
- The dashboard combines the Coordinator's live in-memory supervision state with the latest GitHub snapshot. It does not introduce a second workflow database; GitHub remains the workflow source of truth.
- Browser controls use the **safe supervision** set: inspect session activity, refresh discovery, and graceful drain. Force-stop remains a deliberate second `Ctrl-C` in the Main Session TUI.
- Each Stage Lane has an `ON`/`DRAINING`/`OFF` control. Switching off a Stage stops new dispatches immediately, lets active Ticket Sessions settle, then hands future candidates back to human control.
- All four Stages may be off, leaving the process in monitor-only mode. Re-enabling a Stage requests an immediate full eligibility scan.
- Stage changes are process-local: a Coordinator restart resets them to the `/automode` launch selection rather than persisting them in the Automode Run Record.
- Running Ticket Sessions remain background processes. Selecting a card opens a live, read-only browser activity view with current structured events, prior attempts, errors, and persisted history.
- Settled items move to a collapsed Recent section for the rest of the current Coordinator process; restart clears that process-local history.
- Production uses fixed port `41738` and fails before discovery if that port is occupied.
- The server is available on loopback and through `tailscale serve` without an application password. Tailscale failure leaves Automode running localhost-only with a prominent error.
- The TUI keeps a compact status card with both links, repository/run identity, four Stage states, run counts, poll timing, Tailscale error state, and two-step `Ctrl-C` guidance.

This direction intentionally supersedes #21's immutable-configuration rule for the live process. The implementation specification and domain language must distinguish the launch selection from mutable process-local Stage state before production implementation. See `docs/automode-dashboard-design.md` for acceptance criteria and ticket decomposition.

## Run

Run the approved web direction:

```sh
npm run prototype:coordinator-ui
```

Then open <http://localhost:41738/prototypes/issue-38-coordinator-ui.html?variant=lanes&state=active>.

The superseded initial TUI exploration remains available as primary-source history with `npm run prototype:coordinator-ui:tui-history`. Both artifacts use simulated data and do not mutate GitHub or the repository.

## Controls

| Key | Action |
|---|---|
| `←` / `→` | Switch among the three design variants |
| `↑` / `↓` | Select a Ticket Session |
| `[` / `]` | Cycle loading, empty, active, degraded, draining, exhausted, and recovered states |
| `Enter` / `d` | Expand or collapse selected Ticket Session details |
| `o` | Preview separate Ticket Session inspection without merging context |
| `r` | Preview an immediate tracker refresh |
| `g` | Preview graceful drain |
| `Ctrl-C` twice | Preview graceful then forced shutdown semantics |
| `?` | Show the design constraints represented by the prototype |
| `Esc` | Close |

## Variants

### 1. Command Deck

A dense, persistent roster and detail pane. It optimizes for answering “what is every Ticket Session doing right now?” but can compete with the Main Session transcript.

### 2. Stage Lanes

A workflow-first board grouped by Automation Stage. It makes queue ownership and stage balance obvious, but retry and session-level diagnostics require another level of detail.

### 3. Pulse + Exceptions

A quiet event stream with exceptions promoted above routine activity. It preserves the Main Session as a conversation and supervision surface, but gives less immediate spatial awareness of all active work.

## Proposed shared constraints

These are represented consistently so the evaluation focuses on information architecture:

- Always show repository, run identity, fixed Automation Stage Configuration, discovery state, and active/retrying/exhausted counts.
- Keep Ticket Session transcripts out of Main Session context. “Inspect” should open or resume the durable Ticket Session separately.
- Limit Main Session controls to supervision: inspect, refresh discovery, graceful drain, and second-interrupt force stop.
- Represent states with text as well as theme color.
- Support `80×24` as the baseline. Enhance split layouts around `104–112` columns. Treat dimensions below `60×18` as unsupported with an explicit resize message.
- Keep routine activity compact; preserve failures, retry attempts, shutdown transitions, and recovery evidence.

## Remaining feedback requested

1. What authentication or unguessable-token boundary should protect the localhost dashboard and its mutation controls?
2. Should the localhost port be fixed, chosen dynamically, or stable per repository?
3. What exact compact statistics and shutdown guidance should remain in the Main Session TUI beside the dashboard link?
