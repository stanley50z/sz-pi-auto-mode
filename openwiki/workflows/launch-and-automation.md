# Launch and automation

This repo's concrete workflow docs now center on the `/automode` launch bridge, the immutable stage configuration that survives the process handoff, and the fail-closed startup checks implemented in `src/startup.ts` before work discovery begins. The child persists a repository-scoped capability profile only after startup validation and capability attestation succeed, and that profile is the durable run record for the Automode session; `src/paths.ts` owns the underlying `AutomodePaths.capabilityProfileFile` path.

## Launch path

The agent guidance and product README both say the entrypoint is:

```sh
/automode
```

That command is the minimal Automode Bridge from a normal Pi session into a fresh Automode process for the repository's durable Automode Run. `pi automode` should be treated as obsolete in the current guidance.

The selector starts in Full-Auto, allows mode switching with `Tab`, stage focus changes with the arrow keys, stage toggling in Half-Auto with `Space`, and confirmation with `Enter`. Half-Auto is only valid when one to three stages are enabled.

## Launch handoff

`docs/automode-launch.md` now documents the actual handoff contract: the bridge serializes the chosen Automation Stage Configuration, adds a confirmation digest, and passes both into the child process. The child rejects any changed payload before Main Session startup, validates the repository root, GitHub origin, and required permission, then persists the fixed capability profile through `AutomodePaths.capabilityProfileFile` and resolves nested working directories back to the repository root. `src/controlled-services.ts` and `src/capability-session.ts` show how the Main Session and ticket sessions are wired to the fixed skill, tool, and model boundaries.

## Local documentation refresh

OpenWiki documentation is refreshed locally with:

```sh
OPENWIKI_PROVIDER=openai-chatgpt openwiki code --update --print
```

The repository intentionally has no OpenWiki CI workflow. Regeneration stays local because it uses the saved ChatGPT-subscription login rather than a metered API key.

## Why this matters

For future implementation work, the automation story should answer:

- how `/automode` is invoked from the normal Pi experience
- how the immutable stage configuration is serialized and confirmed across the process boundary
- how Automode stays isolated from normal Pi configuration
- how the Main Session persists its fixed run state and repository-scoped capability profile after validation
- how the repository-level Coordinator identity and lock are shared through the Git common directory
- how local documentation refreshes fit into the repo's maintenance loop

## Evidence

- [`README.md`](../../README.md)
- [`docs/automode-launch.md`](../../docs/automode-launch.md)
- [`AGENTS.md`](../../AGENTS.md)
- [`CLAUDE.md`](../../CLAUDE.md)