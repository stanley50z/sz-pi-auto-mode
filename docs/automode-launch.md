# Automode Bridge launch

After installing this repository as a Pi package, normal Pi registers `/automode` as an extension command. Extension commands are handled before ordinary model input, so the launch command is not submitted as a prompt.

```sh
npm ci
pi install .
```

The selector starts in Full-Auto with all four stages enabled. The minimum supported terminal size is 32 columns by 20 rows; labels, stage states, validation, and every control hint remain available at that size alongside Pi's reserved terminal rows.

- `Tab` switches Full-Auto/Half-Auto mode.
- Up, down, left, and right arrow keys move stage focus.
- `Space` toggles the focused stage only in Half-Auto.
- Half-Auto launches only with one to three enabled stages; zero and four show a validation message.
- `Escape` cancels without launching a process.
- `Enter` confirms a valid configuration.

Confirmation serializes and validates the Automation Stage Configuration, passes it to the child as `AUTOMODE_STAGE_CONFIGURATION`, and passes a matching confirmation digest as `AUTOMODE_STAGE_CONFIGURATION_CONFIRMATION`. The bridge also captures the active Pi provider and model as the default Reviewer execution profile and passes it through `AUTOMODE_DEFAULT_REVIEWER_EXECUTION`. The child rejects invalid launch data before Main Session startup. The bridge resolves nested working directories to the Git repository root, gives the fresh child process the inherited terminal through the proven handoff seam, and exits normal Pi with the child's status.

After every startup check and canonical-resource attestation succeeds, the child persists a Coordinator-bound Automode Run Record at `<git-common-dir>/automode/automode-run.json`. The record contains the durable Coordinator identity, fixed Automation Stage Configuration, default Reviewer execution profile, and explicitly allowlisted project skill files; it is not the Automode Capability Profile. Native Main Session history remains isolated under `~/.pi/automode/<repository-key>/sessions`, and the configuration is appended to Main Session state. Restarting the same Automode Run from another Pi home or linked worktree with different settings fails; `/new`, `/resume`, `/fork`, and `/clone` replacement paths are cancelled.

`src/capability-session.ts` constructs only the startup Automode Capability Attestation Session and disposes it before Main Session creation. After the run record exists, `src/coordinator.ts` hosts discovery and supervision while `src/ticket-session.ts` launches one independent full child process per item. Each child creates or resumes controlled persistent Pi history and receives one deterministic canonical skill command; the Main Session never performs ticket work.

Before work discovery, startup fails closed unless all of these checks succeed:

- Git identifies the same repository root selected by the Bridge.
- `gh` is authenticated for `github.com`, resolves the same repository as the local `origin`, and grants the mutation permission required by the enabled stages.
- Pi can resolve the fixed ordinary Ticket Session model; panel-enabled configurations can also resolve the captured default Reviewer profile and every additional configured profile.
- Pi's public command registry and resource diagnostics show exactly one canonical command per controlled skill, from the expected native or Automode-owned source root.
- The repository's Agent guidance, domain context, and directly referenced tracker/domain documents load while ambient extensions, skills, prompts, themes, and project settings remain excluded; the controlled `/fast` extension explicitly reuses normal Pi's synchronized OpenAI fast-mode state.
- The repository Coordinator lock is available.

The durable Coordinator identity, Automode Run Record, and live lock are stored under the repository's Git common directory so linked worktrees and processes using different home/config roots still share one fixed run. A live `coordinator.lock` permits only one Coordinator process; a clean stop removes the lock, and a restart reuses the identity and fixed Automation Stage Configuration. Ordinary Ticket Sessions use Pi / `openai-codex/gpt-5.6-sol` / high reasoning. Auto-Grilling and Auto-Review always include one default Pi seat using the provider and model active when `/automode` launches. They currently add Pi / `github-copilot/claude-fable-5` and Pi / `openai-codex/gpt-5.6-sol`, all at high reasoning; the protocol supports zero or more additional seats. Project executable skills load only when the project is explicitly trusted and each path is explicitly allowlisted.

After startup, the Coordinator reconciles surviving bookkeeping before new claims, takes a complete GitHub snapshot, and polls every 30 seconds. Material changes trigger a full enabled-stage scan in Auto-Triage, Auto-Grilling, Auto-Implement, then Auto-Review precedence. Unrelated eligible items launch without a software concurrency cap. Every item has one updateable bookkeeping comment, at most five attempts, fresh tracker proof after a clean turn, and preserved diagnostics on exhaustion. Prototype waiting is idle until external material feedback changes the snapshot. The first interrupt stops discovery and drains; the second forces active Ticket Sessions.

Auto-Implement uses deterministic branches and worktrees under `.worktree`; recovery resumes surviving sessions and reconstructs missing worktrees from branches. Auto-Grilling and Auto-Review use the controlled configured Panel runtime with identical immutable context, hidden peers, one captured default Pi seat, zero or more additional seats, and read-only advisory tools. Review workspaces are pinned to the exact pull-request head and checked for pushability before fixes. Successful review cleanup is gated on a completed merge.

## Validation

```sh
npm test
```

The suite includes a real-Pi RPC smoke test proving command registration and pre-model handling, selector behavior and minimum-size readability checks, and real-Pi PTY walkthroughs of the Full-Auto and Half-Auto happy paths. The PTY walkthroughs prove no model turn starts, the child is fresh, nested launch directories resolve to the repository root, and the confirmed configuration remains immutable. A process-boundary test tampers with the serialized environment payload and proves startup rejects it. Coordinator tests cover polling, precedence, independent dispatch, retries, recovery, prototype waiting, and shutdown; process tests exercise persistent Ticket Session IPC; real Git fixtures prove deterministic worktree creation/recovery/cleanup; and a deterministic Full-Auto journey advances representative work through all four stages to merge.
