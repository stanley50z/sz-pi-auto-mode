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

Confirmation serializes and validates the Automation Stage Configuration, passes it to the child as `AUTOMODE_STAGE_CONFIGURATION`, and passes a matching confirmation digest as `AUTOMODE_STAGE_CONFIGURATION_CONFIRMATION`. The child rejects a changed payload before Main Session startup. The bridge resolves nested working directories to the Git repository root, gives the fresh child process the inherited terminal through the proven handoff seam, and exits normal Pi with the child's status.

After every startup check and canonical-resource attestation succeeds, the child persists a Coordinator-bound Automode Run Record at `<git-common-dir>/automode/automode-run.json`. The record contains the durable Coordinator identity, fixed Automation Stage Configuration, and explicitly allowlisted project skill files; it is not the Automode Capability Profile. Native Main Session history remains isolated under `~/.pi/automode/<repository-key>/sessions`, and the configuration is appended to Main Session state. Restarting the same Automode Run from another Pi home or linked worktree with different settings fails; `/new`, `/resume`, `/fork`, and `/clone` replacement paths are cancelled.

`src/capability-session.ts` constructs only the startup Automode Capability Attestation Session and disposes it before Main Session creation. It does not construct or wire Ticket Sessions; Ticket Session orchestration arrives in later tickets.

Before work discovery, startup fails closed unless all of these checks succeed:

- Git identifies the same repository root selected by the Bridge.
- `gh` is authenticated for `github.com`, resolves the same repository as the local `origin`, and grants the mutation permission required by the enabled stages.
- Pi can resolve the fixed ordinary Ticket Session model; panel-enabled configurations can also resolve every fixed panel profile, including an authenticated live Claude Code probe using the exact `claude-fable-5` model and high reasoning.
- Pi's public command registry and resource diagnostics show exactly one canonical command per controlled skill, from the expected native or Automode-owned source root.
- The repository's Agent guidance, domain context, and directly referenced tracker/domain documents load while ambient extensions, skills, prompts, themes, and project settings remain excluded; the controlled `/fast` extension explicitly reuses normal Pi's synchronized OpenAI fast-mode state.
- The repository Coordinator lock is available.

The durable Coordinator identity, Automode Run Record, and live lock are stored under the repository's Git common directory so linked worktrees and processes using different home/config roots still share one fixed run. A live `coordinator.lock` permits only one Coordinator process; a clean stop removes the lock, and a restart reuses the identity and fixed Automation Stage Configuration. Ordinary Ticket Sessions use Pi / `openai-codex/gpt-5.6-sol` / high reasoning. Auto-Grilling and Auto-Review additionally require Pi / `openai-codex/gpt-5.6-sol`, Pi / `kimi-coding/k3`, and Claude Code / `claude-fable-5`, all at high reasoning. Project executable skills load only when the project is explicitly trusted and each path is explicitly allowlisted.

Queue discovery and ticket claiming arrive in later tickets; this startup boundary reads repository metadata for validation but does not discover or mutate eligible tracker work.

## Validation

```sh
npm test
```

The suite includes a real-Pi RPC smoke test proving command registration and pre-model handling, selector behavior and minimum-size readability checks, and real-Pi PTY walkthroughs of the Full-Auto and Half-Auto happy paths. The PTY walkthroughs prove no model turn starts, the child is fresh, nested launch directories resolve to the repository root, and the confirmed configuration remains immutable. A process-boundary test tampers with the serialized environment payload and proves startup rejects it.
