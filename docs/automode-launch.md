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

The child persists the fixed run configuration at `~/.pi/automode/<repository-key>/stage-configuration.json`, targets native Main Session history under `~/.pi/automode/<repository-key>/sessions`, and appends the configuration to Main Session state. Restarting the same Automode Run with a different configuration fails; `/new`, `/resume`, `/fork`, and `/clone` replacement paths are cancelled.

Issue #23 intentionally launches against an empty eligible queue. Queue discovery and Coordinator behavior arrive in later tickets; the Main Session therefore starts idle rather than touching GitHub work.

## Validation

```sh
npm test
```

The suite includes a real-Pi RPC smoke test proving command registration and pre-model handling, selector behavior and minimum-size readability checks, and real-Pi PTY walkthroughs of the Full-Auto and Half-Auto happy paths. The PTY walkthroughs prove no model turn starts, the child is fresh, nested launch directories resolve to the repository root, and the confirmed configuration remains immutable. A process-boundary test tampers with the serialized environment payload and proves startup rejects it.
