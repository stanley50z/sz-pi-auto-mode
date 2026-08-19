# Automode Dashboard browser validation

Validated: 2026-08-19 for PR #56.

This proof covers two public seams without turning responsive layout into a DOM or snapshot test:

- `test/dashboard.test.ts` launches real Pi, enters `/automode`, confirms the selector, derives the dashboard base URL from the Main Session TUI's rendered OSC-8 hyperlink, observes live activity through that target, and requests graceful drain.
- `test/dashboard-browser-proof-main.ts` serves the production dashboard module and assets with representative queued, blocked, running, exhausted, and empty Stage Lane data. `test/dashboard-browser-walkthrough.py` drives that surface through browser-harness using real keyboard events and visual captures.

The browser proof data is synthetic and deterministic. It exists to make visual states reproducible; it is not a claim that the walkthrough read live GitHub data. The black-box `/automode` acceptance likewise uses its purpose-built tracker and Ticket Session fixture while exercising the real Pi/process/TUI/HTTP boundaries.

## Reproduce

In one terminal, start the proof entrypoint:

```powershell
npm run prove:dashboard
```

Copy the `dashboardUrl` printed by the command. In a second PowerShell terminal, run the checked-in walkthrough through browser-harness:

```powershell
$env:AUTOMODE_DASHBOARD_URL = 'http://127.0.0.1:41738'
Get-Content -LiteralPath 'test\dashboard-browser-walkthrough.py' -Raw -Encoding UTF8 | browser-harness
```

The walkthrough records the browser session, writes screenshots to a temporary directory by default, prints the exact recording and artifact paths, and closes only its Automode task tab. The final Graceful drain action stops the proof entrypoint.

## Recorded result

The browser-harness run completed with `result: passed` and a 79-frame recording named `automode-dashboard-pr56-20260818-235726`.

| Viewport | Result |
| --- | --- |
| `1440×900` | Exact CSS viewport and PNG dimensions; four Stage Lanes remain aligned; queued, blocked, running, exhausted, empty, and Tailscale-degraded states are legible; no horizontal page overflow. |
| `1024×768` | Exact CSS viewport and PNG dimensions; summary, controls, and two-column lanes retain hierarchy and spacing; no horizontal page overflow. |
| `390×844` | Exact CSS viewport and PNG dimensions; lanes stack vertically, controls remain reachable, focused controls have a visible ring, and the activity drawer remains readable without horizontal page overflow. |

The visual review found no clipped text, unintended overlap, hidden controls, alignment drift, or unbalanced primary hierarchy at the approved sizes. Vertical scrolling is expected at compact and narrow sizes.

The keyboard walkthrough verified:

- Tab reaches the Auto-Grilling Stage control; Enter transitions `ON → OFF`, Tab reacquires the enabled control, and Enter returns it to `ON`.
- Tab reaches the running `#50` card; Enter opens the named read-only activity dialog with retained prior-attempt history and the live `npm test — live activity proof` event.
- Escape closes the drawer and restores focus to the inspected card; reopening and activating Close dismisses it again.
- Tab and Enter activate Refresh snapshot and visibly update the last-poll timestamp.
- Tab and Enter activate Graceful drain; lifecycle becomes `DRAINING`, Stage controls become disabled, and server shutdown produces the explicit disconnected/stale banner.

Generated screenshots were reviewed from the browser-harness temporary artifact directory and intentionally were not checked into Git. The checked-in walkthrough regenerates them at the exact approved dimensions.
