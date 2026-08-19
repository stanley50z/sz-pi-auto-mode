A code wiki for this repository.

Repository-specific constraints:

- Treat source code, tests, `CONTEXT.md`, and `docs/automode-launch.md` as authoritative.
- Use the exact domain vocabulary from `CONTEXT.md`. The persisted Coordinator-bound state is the **Automode Run Record**, not the Automode Capability Profile. Do not describe a capability profile as a durable run record or persisted file.
- The Automode Run Record lives under the Git common directory so linked worktrees and different Pi homes share one fixed run.
- The capability session used during startup is an **Automode Capability Attestation Session**, not a Ticket Session. Never describe `src/capability-session.ts` or `createCapabilitySession` as constructing or wiring Ticket Sessions.
- OpenWiki refresh is intentionally local-only with `OPENWIKI_PROVIDER=openai-chatgpt openwiki code --update --print`. This repository must not have or recommend a scheduled OpenWiki CI workflow.
- Preserve `/automode` as the launch entrypoint; `pi automode` is obsolete.
- The Main Session TUI uses `/drain` for a graceful drain and `/exit` to force-stop active Ticket Sessions before exit. Automode does not intercept `Ctrl-C`; Pi retains its default TUI behavior. Remove every generated claim that a first user interrupt drains or a second user interrupt forces, including in quickstart, architecture overview/coordinator/dashboard, and launch workflow pages. The Coordinator retains an internal two-phase lifecycle API, but the user-facing controls are the two slash commands.
- The Main Session status card shows repository/run identity, dashboard links, Stage states, candidate totals, poll timing, lifecycle guidance, and Tailscale errors. It does not show Ticket Session activity or a bounded activity summary.
- Panel seat counts are configurable. Every panel includes the Pi provider/model active when `/automode` launches; the current additional seats are Pi / `github-copilot/claude-fable-5` and Pi / `openai-codex/gpt-5.6-sol`, all at high reasoning.
- Keep Personal-WeChat outside the Automode MVP.
