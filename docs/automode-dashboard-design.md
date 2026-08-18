# Automode Dashboard interaction design

Status: human-approved design for issue #38. The prototype is on branch `prototype/issue-38-coordinator-ui` under `prototypes/`.

## Product decision

After `/automode` launches a fresh Main Session, the Automode Coordinator starts a repository-local web dashboard. The Main Session TUI is a compact status and shutdown surface; the browser is the comprehensive supervision surface.

The Automode Dashboard:

- uses Stage Lanes as its default and only primary layout
- shows every open Stage Candidate, not only active Ticket Sessions
- exposes live read-only Ticket Session activity and process-local prior-attempt history
- provides safe supervisory controls
- controls process-local Automation Stage Operating State
- does not perform ticket work or become a workflow database

GitHub remains the workflow source of truth. The Coordinator owns live process state. A Coordinator restart reconstructs authoritative work using the existing recovery contract and clears dashboard-only recent history.

## Main Session TUI

The TUI shows a compact status card containing:

- repository and Automode Run identity
- fixed localhost URL and Tailscale URL when available
- `ON`, `DRAINING`, or `OFF` for all four Automation Stages
- total open Stage Candidates and active, queued, held, retrying, and exhausted counts
- last successful poll and next scheduled poll
- first-`Ctrl-C` graceful drain and second-`Ctrl-C` force-stop guidance
- a prominent Tailscale exposure error when remote access is unavailable

It does not repeat Stage Lane cards, Ticket Session transcripts, or detailed history.

## Network and lifecycle

- The dashboard uses fixed port `41738`.
- If port `41738` is occupied, Automode startup fails before discovery or claim.
- The application binds to loopback for local access.
- It also requests private tailnet exposure through `tailscale serve` with no application password.
- If Tailscale is unavailable or exposure fails, Automode continues localhost-only and shows an error in both the TUI and dashboard.
- Tailnet identity and ACLs govern remote access. Mutation requests still enforce allowed hosts, same-origin checks, and CSRF protection without showing a login prompt.
- The dashboard server starts and stops with the Coordinator process.

## Stage Lanes

The four lanes are Auto-Triage, Auto-Grilling, Auto-Implement, and Auto-Review.

Each open tracker item appears in at most one lane. When several Stages recognize the same item, existing workflow precedence applies: Auto-Triage, Auto-Grilling, Auto-Implement, then Auto-Review.

A Stage Candidate is displayed even when Automode cannot dispatch it. Cards distinguish:

- `QUEUED` — eligible but not yet claimed
- `CLAIMED` — claimed while Ticket Session/workspace startup is in progress
- `RUNNING` — owned by a live Ticket Session
- `WAITING` — durable Ticket Session is idle pending external feedback or state
- `RETRYING` — a retry is scheduled within the five-attempt budget
- `BLOCKED` — native dependencies prevent dispatch
- `HUMAN-OWNED` — assignment or current Stage state leaves the item under human control
- `EXHAUSTED` — five attempts were consumed; evidence is preserved

Every non-running card explains why Automode has not picked it up. Lane headers show candidate, active, queued, and held totals.

Candidate coverage:

- Auto-Triage: every open issue recognized by the Auto-Triage queue, including assigned/conflicting candidates that are not currently eligible
- Auto-Grilling: every open grilling child ticket, including blocked and assigned candidates
- Auto-Implement: open prototype and production implementation candidates, including blocked, assigned, claimed, and output-PR-suppressed candidates
- Auto-Review: every open non-draft pull request

## Automation Stage Operating State

Each lane has one process-local control:

- `ON` — normal discovery and dispatch
- `DRAINING` — no new dispatches; active Ticket Sessions may settle
- `OFF` — no dispatch; matching work is human-controlled

Switching an `ON` Stage off transitions immediately to `DRAINING` when it has active Ticket Sessions, then to `OFF` when they settle. With no active Ticket Sessions it transitions directly to `OFF`.

Re-enabling an `OFF` or `DRAINING` Stage transitions it to `ON` and requests an immediate full eligibility scan. All four Stages may be `OFF`, leaving the Coordinator in monitor-only mode.

Operating State is not written to the Automode Run Record. A Coordinator process restart restores all four states from the `/automode` launch Automation Stage Configuration. The launch mode label remains Full-Auto or Half-Auto and does not change with process-local state.

This behavior supersedes #21's rule that the selected Stage settings remain immutable for the live process. The durable launch baseline remains fixed.

## Ticket Session activity

Selecting a card opens a read-only activity drawer.

For a live or persisted Ticket Session it shows:

- item, Stage, lifecycle state, attempt count, session identity, and workspace
- live structured Pi events and tool activity
- errors and terminal results
- prior attempts retained for the current Coordinator process
- persisted Pi conversation history needed to understand resumed work

The activity view never sends prompts, mutates ticket work, attaches a second Pi process, or imports Ticket Session context into the Main Session.

Ticket Sessions continue as isolated background Pi processes. There is no live terminal attach or takeover in this design.

For a candidate without a Ticket Session, the drawer explains eligibility, blocking, ownership, or Stage-state reasons and says that no session exists yet.

## Recent activity

When an item stops matching its Stage Lane, it moves to a collapsed Recent section. Recent entries remain until the current Coordinator process exits. They are not persisted in the Automode Run Record and clear on restart.

## Browser controls

The browser exposes only safe supervision:

- inspect Stage Candidate or Ticket Session activity
- request an immediate fresh tracker snapshot/full scan
- begin graceful repository-wide drain
- change one Automation Stage Operating State

Force-stop, retry-budget reset, tracker mutation, ticket prompting, and per-session termination are not browser controls. Repository-wide force-stop remains the second `Ctrl-C` in the Main Session TUI.

## Responsive and accessible behavior

- Primary desktop target: `1440×900` and wider
- Supported compact desktop/tablet target: `1024×768`
- Supported narrow read/inspect target: `390×844`; Stage Lanes stack vertically
- No horizontal page scrolling at supported sizes
- Status is always represented by text, not color alone
- Every card and control is keyboard reachable with visible focus
- Live updates do not steal focus or unexpectedly reorder the card currently being inspected
- The activity drawer has an accessible dialog name, close action, Escape handling, and focus containment in production

## Public seams

Implementation should place one deep dashboard module behind a small Coordinator-facing interface:

- start on fixed port with the initial dashboard projection
- publish a replacement dashboard projection after Coordinator/tracker changes
- append structured Ticket Session activity
- receive typed supervisory commands
- stop idempotently

The public product seam is HTTP plus the Main Session TUI:

- a snapshot endpoint for the current projection
- a live event stream for projection and activity updates
- typed mutation endpoints for refresh, drain, and Stage Operating State
- static web assets

The browser must not read GitHub, Pi session files, worktrees, or the Automode Run Record directly. Those details remain behind the Coordinator/dashboard module interface.

## Acceptance criteria

### Launch and TUI

- [ ] `/automode` starts the dashboard before discovery on port `41738`.
- [ ] Port collision fails startup before any claim or tracker mutation.
- [ ] The Main Session TUI renders the compact status card and exact working links.
- [ ] Dashboard shutdown is idempotent and follows Coordinator shutdown.
- [ ] Tailscale exposure succeeds without an app password, or Automode continues localhost-only with a visible error.

### Stage projection

- [ ] Every open Stage Candidate appears in exactly one precedence-selected lane.
- [ ] Queued, claimed, running, waiting, retrying, blocked, human-owned, and exhausted examples are distinguishable by text.
- [ ] Every non-running candidate exposes a concrete reason it has not been dispatched.
- [ ] Lane and run totals update from the same projection as the cards.
- [ ] Settled candidates move to process-local Recent and disappear after restart.

### Stage controls

- [ ] Turning off an inactive Stage transitions directly to `OFF` and prevents new dispatch.
- [ ] Turning off a Stage with active Ticket Sessions transitions to `DRAINING`, starts no new work, and reaches `OFF` after active work settles.
- [ ] Re-enabling a Stage requests an immediate full eligibility scan.
- [ ] All four Stages may be `OFF` without stopping the Coordinator or dashboard.
- [ ] Restart restores Stage Operating State from the launch Automation Stage Configuration.

### Session activity

- [ ] Selecting an active card opens live read-only structured activity without starting another Pi process.
- [ ] Prior persisted conversation/attempt history is visible after retry or recovery.
- [ ] A candidate without a Ticket Session clearly says no session exists and explains why.
- [ ] Browser inspection never mutates or injects context into a Ticket Session or Main Session.

### Controls and security

- [ ] Browser refresh and graceful-drain commands reach the owning Coordinator exactly once per accepted request.
- [ ] The browser has no force-stop, retry reset, prompt, tracker-mutation, or per-session termination control.
- [ ] Remote access is limited to the tailnet path; mutation requests enforce host, origin, and CSRF checks without a login prompt.
- [ ] A stale browser receives an explicit disconnected/stale state and cannot present mutations as successful.

### Visual and end-to-end validation

- [ ] Visual inspection passes at `1440×900`, `1024×768`, and `390×844` for active, queued, blocked, draining, exhausted, disconnected, and empty states.
- [ ] Keyboard walkthrough covers Stage controls, card inspection, activity drawer close/Escape, refresh, and graceful drain.
- [ ] A black-box `/automode` run proves TUI link → web Stage Lanes → live Ticket Session activity → graceful drain.
- [ ] Full repository validation and `git diff --check` pass with command-level timeouts.

## Proposed ticket decomposition

1. **Revise the Stage configuration contract and domain documentation**
   - Introduce Automation Stage Operating State.
   - Amend #21's immutable live-process rule while preserving the durable launch baseline.
   - Update run-record, mode, shutdown, and recovery acceptance tests/docs.

2. **Build the Coordinator dashboard module and network boundary**
   - Fixed-port startup/failure, loopback server, static assets, snapshot/event/mutation interface, host/origin/CSRF checks, optional `tailscale serve`, and idempotent shutdown.

3. **Project all Stage Candidates and process-local Stage state**
   - Complete candidate classification, precedence, status/reason projection, lane/run totals, `ON`/`DRAINING`/`OFF` transitions, immediate scan, monitor-only mode, and restart reset.

4. **Build Stage Lanes and live Ticket Session activity**
   - Responsive accessible browser UI, process-local Recent section, structured live events, persisted history reconstruction, and disconnected/error states.

5. **Integrate the compact Main Session TUI and black-box acceptance**
   - Status card, exact links, Tailscale errors, Ctrl-C guidance, visual walkthroughs, and `/automode` end-to-end coverage.
