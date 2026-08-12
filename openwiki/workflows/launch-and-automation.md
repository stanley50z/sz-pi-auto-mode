# Launch and automation

This repo currently names one concrete launch path and one local documentation-maintenance path.

## Launch path

The agent guidance now says the entrypoint is:

```sh
/automode
```

That command is the minimal Automode Bridge from a normal Pi session into a fresh Automode process for the repository's durable Automode Run. `pi automode` should be treated as obsolete in the current guidance.

## Local documentation refresh

OpenWiki documentation is refreshed locally with:

```sh
OPENWIKI_PROVIDER=openai-chatgpt openwiki code --update --print
```

The repository intentionally has no OpenWiki CI workflow. Regeneration stays local because it uses the saved ChatGPT-subscription login rather than a metered API key.

## Why this matters

For future implementation work, the automation story should answer:

- how `/automode` is invoked from the normal Pi experience
- how Automode stays isolated from normal Pi configuration
- how the Coordinator reconstructs work after restart
- how local documentation refreshes fit into the repo's maintenance loop

## Evidence

- [`README.md`](../../README.md)
- [`AGENTS.md`](../../AGENTS.md)
- [`CLAUDE.md`](../../CLAUDE.md)