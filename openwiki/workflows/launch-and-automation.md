# Launch and automation

This repo's concrete workflow docs now center on the `/automode` launch bridge and the immutable stage configuration that survives the process handoff.

## Launch path

The agent guidance and product README both say the entrypoint is:

```sh
/automode
```

That command is the minimal Automode Bridge from a normal Pi session into a fresh Automode process for the repository's durable Automode Run. `pi automode` should be treated as obsolete in the current guidance.

The selector starts in Full-Auto, allows mode switching with `Tab`, stage focus changes with the arrow keys, stage toggling in Half-Auto with `Space`, and confirmation with `Enter`. Half-Auto is only valid when one to three stages are enabled.

## Launch handoff

`docs/automode-launch.md` now documents the actual handoff contract: the bridge serializes the chosen Automation Stage Configuration, adds a confirmation digest, and passes both into the child process. The child rejects any changed payload before Main Session startup, persists the fixed configuration, and resolves nested working directories back to the repository root.

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
- how the Main Session persists its fixed run state
- how local documentation refreshes fit into the repo's maintenance loop

## Evidence

- [`README.md`](../../README.md)
- [`docs/automode-launch.md`](../../docs/automode-launch.md)
- [`AGENTS.md`](../../AGENTS.md)
- [`CLAUDE.md`](../../CLAUDE.md)