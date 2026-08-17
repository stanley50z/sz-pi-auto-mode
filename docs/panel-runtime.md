# Controlled Panel runtime

Auto-Grilling and Auto-Review expose one `automode_panel` tool inside their controlled Ticket Sessions. The tool delegates to `runGrillingPanel` or `runReviewPanel` in `src/panel-runtime.ts`; there is no `PanelRuntime` class or `PanelProcessHost` abstraction.

Both functions launch every configured seat concurrently through a `PanelSeatLauncher`. Every panel has one default Pi seat captured from the provider and model active when `/automode` launches, plus zero or more additional seats. Every seat receives the same deeply frozen context and a prompt that hides peers and prohibits tracker mutation, queue progression, nested subagents, merges, and human questions. The only seat tools are `read`, `grep`, `find`, and `ls` (mapped to `Read`, `Grep`, and `Glob` for Claude Code).

`CliPanelProcessLauncher` in `src/panel-process.ts` is the production `ProductionPanelProcessLauncher`. It starts controlled `pi --mode json` or `claude --print --output-format json` processes with each exact configured harness/model/reasoning profile, disables ambient Pi resources and context, and validates direct structured JSON output. The process adapter has no custom versioned child IPC protocol.

Grilling accepts at least one complete usable Panel Answer after every configured seat terminates and records failed seats without retry or substitution. Review requires one complete usable report from every configured seat on the same exact head. The authoritative Grilling Session or Review Session judges and applies the results; the Panel never does.

Focused validation:

```sh
npm run build && node --test dist/test/panel-runtime.test.js dist/test/panel-process.test.js dist/test/ticket-panel-extension.test.js
```
