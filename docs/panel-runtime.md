# Controlled Panel runtime

Auto-Grilling and Auto-Review expose one `automode_panel` tool inside their controlled Ticket Sessions. The tool delegates to `runGrillingPanel` or `runReviewPanel` in `src/panel-runtime.ts`; there is no `PanelRuntime` class or `PanelProcessHost` abstraction.

Both functions launch every configured seat concurrently through a `PanelSeatLauncher`. The default panel contains Pi / `openai-codex/gpt-5.6-sol` and Pi / `github-copilot/claude-fable-5`, both at high reasoning. These profiles belong to each Automode process and do not come from the launching Main Session or the durable Run Record. Every seat receives the same deeply frozen context and a prompt that hides peers and prohibits tracker mutation, queue progression, nested subagents, merges, and human questions. The only seat tools are `read`, `grep`, `find`, and `ls` (mapped to `Read`, `Grep`, and `Glob` for Claude Code).

`CliPanelProcessLauncher` in `src/panel-process.ts` is the production `ProductionPanelProcessLauncher`. It starts controlled `pi --mode json` or `claude --print --output-format json` processes with each exact configured harness/model/reasoning profile and disables ambient Pi resources and context. The process transport remains machine-readable, but a Reviewer writes ordinary Markdown for the authoritative Review Session to interpret. Grilling retains its structured answer contract because the Grilling Session must map answers back to numbered questions. Pi seats run the launching Pi package's JavaScript CLI through `process.execPath`, rather than invoking an npm command shim that Node cannot spawn directly on Windows. The process adapter has no custom versioned child IPC protocol.

Grilling accepts at least one complete usable Panel Answer after every configured seat terminates and records failed seats without retry or substitution. Review receives a small parent-owned context containing the round, exact head SHA, and a prose review brief. It returns every non-empty Markdown report with parent-generated seat and head attribution alongside all failed-seat diagnostics. The Review Session publishes each completed report as a commit-pinned GitHub pull-request review with inline comments on exact changed lines, even when another seat failed. Missing seats still prevent disposition, fixes, and merge. The authoritative Grilling Session or Review Session judges and applies the results; the Panel never does.

Focused validation:

```sh
npm run build && node --test dist/test/panel-runtime.test.js dist/test/panel-process.test.js dist/test/ticket-panel-extension.test.js
```
