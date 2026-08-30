---
status: accepted
---

# Use a local web dashboard for Coordinator supervision

Automode uses a Coordinator-owned web dashboard, rather than a multiplexed Pi TUI, as its comprehensive supervision surface. Stage Lanes must show all open Stage Candidates and live read-only Ticket Session activity, while the Main Session TUI retains only links, compact statistics, Tailscale errors, and shutdown guidance. This preserves Ticket Session context isolation while making concurrent background work inspectable on desktop and mobile.

The dashboard binds locally and may be exposed without an application password through the user's tailnet. ADR-0002 replaces this decision's original fixed-port and exclusive Tailscale configuration rules so dashboards for different repositories can run together. Tailscale failure degrades to localhost-only with a visible error. GitHub and the Coordinator remain authoritative; the dashboard is not a workflow database.

The browser may change process-local Automation Stage Operating State (`ON`, `DRAINING`, or `OFF`). Those changes supersede the MVP's immutable live-process Stage rule but do not rewrite the durable launch baseline: all four Stages may be off, active work drains before a Stage turns off, re-enabling triggers a full scan, and Coordinator restart restores the `/automode` launch Automation Stage Configuration.
