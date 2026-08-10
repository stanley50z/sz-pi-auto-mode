# Launch and automation

This repo currently names one concrete command and a local documentation-maintenance path.

## Launch path

The README says the extension is launched with:

```sh
pi automode
```

At this stage, that command should be treated as the product's intended entrypoint, not as a verified implementation detail. There is no inspected source file yet that shows how the command is wired up.

## Local documentation refresh

OpenWiki documentation is refreshed locally with:

```sh
OPENWIKI_PROVIDER=openai-chatgpt openwiki code --update --print
```

The repository intentionally does not run OpenWiki in GitHub Actions because local generation uses the saved ChatGPT-subscription login rather than a metered API key.

## Why this matters

For future implementation work, the automation story should answer:

- how `pi automode` is invoked
- how automode stays isolated from normal Pi configuration
- whether workflow execution is interactive, scheduled, event-driven, or hybrid
- how locally generated documentation fits into the repo's maintenance loop

## Evidence

- [`README.md`](../../README.md)
- [`AGENTS.md`](../../AGENTS.md)
- [`CLAUDE.md`](../../CLAUDE.md)