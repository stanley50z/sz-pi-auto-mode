A code wiki for this repository.

Repository-specific constraints:

- Treat source code, tests, `CONTEXT.md`, and `docs/automode-launch.md` as authoritative.
- Use the exact domain vocabulary from `CONTEXT.md`. The persisted Coordinator-bound state is the **Automode Run Record**, not the Automode Capability Profile. Do not describe a capability profile as a durable run record or persisted file.
- The Automode Run Record lives under the Git common directory so linked worktrees and different Pi homes share one fixed run.
- The capability session used during startup is an **Automode Capability Attestation Session**, not a Ticket Session. Never describe `src/capability-session.ts` or `createCapabilitySession` as constructing or wiring Ticket Sessions.
- OpenWiki refresh is intentionally local-only with `OPENWIKI_PROVIDER=openai-chatgpt openwiki code --update --print`. This repository must not have or recommend a scheduled OpenWiki CI workflow.
- Preserve `/automode` as the launch entrypoint; `pi automode` is obsolete.
- Keep Personal-WeChat outside the Automode MVP.
