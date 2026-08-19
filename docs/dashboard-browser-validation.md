# Automode Dashboard browser validation

Validated: 2026-08-19 for PR #56.

The checked-in proof now joins the complete product chain in one browser-harness run:

1. `test/dashboard-browser-walkthrough.py` starts `test/dashboard-browser-black-box-main.ts`.
2. The black-box entrypoint uses the same extracted Pi/PTY launcher as the deterministic acceptance in `test/dashboard.test.ts`; it enters `/automode`, confirms the selector, and derives the raw dashboard target from the Main Session TUI's rendered OSC-8 hyperlink.
3. Browser-harness passes that exact emitted target to `new_tab`, renders Stage Lanes, opens the running `#50` Ticket Session drawer, and observes `npm test — live activity proof` in the live structured activity feed.
4. The browser invokes Graceful drain, captures `DRAINING` at all three approved viewports before the fixture settles, observes the explicit disconnected/stale state after dashboard shutdown, captures that state at all three viewports, and waits for the launched Pi process to exit successfully.

The large Pi/PTY launch block is shared through `test/dashboard-black-box-harness.ts`. Normal `npm test` remains deterministic and noninteractive: its black-box acceptance uses the same launcher and OSC-8 parser but exercises the HTTP seam directly. Browser-harness is invoked only by the explicit dashboard proof command.

## Reproduce

From the repository root, run:

```powershell
npm run prove:dashboard
```

The command builds the repository and launches browser-harness. The walkthrough owns both proof subprocesses, refuses to start if port `41738` is already occupied, closes only its Automode tabs, asks each owned subprocess to stop in `finally`, waits for port `41738` to close, and then stops its recording. Screenshots go to a new temporary artifact directory on every run and are not checked into Git.

## Evidence recorded on 2026-08-19

- Browser-harness recording: `C:\Users\13982\.config\browser-harness\agent-workspace\recordings\automode-dashboard-pr56-20260819-003538` (162 frames).
- Screenshot artifacts: `C:\Users\13982\AppData\Local\Temp\automode-dashboard-browser-proof-vaqqn_bn`.
- TUI-emitted OSC-8 target passed to the browser: `http://127.0.0.1:41738` (Chrome canonicalized `window.location.href` to the equivalent trailing-slash form).
- Launched Pi process for that run: PID `6500`, observed exit code `0` after browser drain.
- The proof ended with port `41738` free and no owned dashboard proof child remaining.

The matrix contains 21 state-specific screenshots:

| State | Evidence source | `1440×900` | `1024×768` | `390×844` |
| --- | --- | --- | --- | --- |
| Active/running | deterministic production-dashboard fixture | inspected | inspected | inspected |
| Queued | deterministic production-dashboard fixture | inspected | inspected | inspected |
| Blocked | deterministic production-dashboard fixture | inspected | inspected | inspected |
| Draining | actual Pi `/automode` process after browser drain | inspected | inspected | inspected |
| Exhausted | deterministic production-dashboard fixture | inspected | inspected | inspected |
| Disconnected/stale | actual Pi `/automode` page after process-owned dashboard shutdown | inspected | inspected | inspected |
| Empty Stage Lane | deterministic production-dashboard fixture | inspected | inspected | inspected |

Every capture verified exact CSS viewport dimensions, exact PNG dimensions, target visibility within the viewport, and `scrollWidth <= innerWidth`. Visual review of all 21 images found no clipped target text, unintended overlap, hidden controls, alignment drift, unbalanced hierarchy, or horizontal page overflow. Four lanes remain aligned at `1440×900`, the board becomes two columns at `1024×768`, and lanes stack vertically at `390×844`. Vertical scrolling is expected at the compact and narrow sizes.

The keyboard walkthrough also verified:

- Tab reaches the Auto-Grilling Stage control; Enter transitions `ON → OFF`, Tab reacquires the enabled control, and Enter returns it to `ON`.
- Tab reaches the running `#50` card; Enter opens the named read-only activity dialog with prior-attempt history in the deterministic visual fixture.
- The actual Pi-launched dashboard drawer contains the live `npm test — live activity proof` event from its Ticket Session fixture.
- Escape closes the drawer and restores focus to the inspected card; reopening and activating Close dismisses it again.
- Tab and Enter activate Refresh snapshot and visibly update the last-poll timestamp.
- Tab and Enter activate Graceful drain on the actual Pi-launched dashboard; lifecycle becomes `DRAINING`, controls disable, dashboard shutdown produces the disconnected/stale banner, and the launched process exits `0`.

## Synthetic limitations

The responsive active/running, queued, blocked, exhausted, and empty examples are deterministic synthetic projections served through the production dashboard module and assets. They exist so every required nonterminal visual state can be inspected reproducibly at all three exact sizes; they are not live GitHub data.

The black-box chain is not the synthetic proof server. It launches real Pi, invokes the real `/automode` Bridge and selector, starts the real Main Session/Coordinator/dashboard process boundary, follows the exact TUI-emitted OSC-8 URL in browser-harness, and proves graceful process exit. Its tracker, startup validation, and Ticket Session work are still purpose-built deterministic acceptance fixtures; it does not authenticate to or mutate live GitHub, and it does not make a live model call.
