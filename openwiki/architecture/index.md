# Files

- [Automode capability boundary](capability-boundary.md) - Defines the allowlisted skills, tools, models, settings, guidance, and project-resource rules exposed to Automode sessions, plus canonical provenance attestation.
- [Automode Coordinator and Ticket Sessions](coordinator.md) - Runtime coordination for GitHub workflow discovery, stage precedence, Ticket Session dispatch, bookkeeping recovery, retries, and isolated Git workspaces.
- [Automode Coordinator dashboard and Stage Lanes](dashboard.md) - The local Coordinator-owned web dashboard that projects Stage Candidates and Ticket Session activity, exposes safe supervision commands, and keeps process-local Stage Operating State separate from the Automode Run Record.
- [Architecture overview](overview.md) - Runtime architecture for the Automode bridge, immutable runtime snapshot, fail-closed startup, controlled capability session, Main Session, and repository Coordinator lifecycle, including relaunch configuration replacement.
- [Review Panel and controlled advisory seats](panels.md) - The configurable Panel runtime used by Auto-Grilling and Auto-Review, including its two fixed Pi seats, isolated child processes, immutable context, hidden peers, high-reasoning execution profiles, and read-only advisory tools.
