# Operations

This repository's current operating conventions come from the agent guidance files and the agent-domain docs.

## Issue tracking

The repo treats GitHub Issues as the system of record for issues and specs. `docs/agents/issue-tracker.md` is the canonical source for the `gh`-based issue workflow, including:

- creating issues
- reading issues and comments
- listing issues with labels and state filters
- commenting, labeling, and closing issues

That makes GitHub the main coordination surface for future work items.

## OpenWiki maintenance

OpenWiki is maintained locally using the saved ChatGPT-subscription login:

```sh
OPENWIKI_PROVIDER=openai-chatgpt openwiki code --update --print
```

The repository intentionally has no OpenWiki CI workflow. `AGENTS.md` and `CLAUDE.md` both point readers to `openwiki/quickstart.md` and warn against hand-editing generated OpenWiki pages unless explicitly asked.

## Repo conventions worth preserving

- keep generated docs under `openwiki/`
- prefer source updates plus regeneration over hand-editing generated pages
- keep issue/spec discussion in GitHub Issues rather than scattering it across ad hoc notes
- use the agent docs under `docs/agents/` as the authoritative operating references

## Evidence

- [`AGENTS.md`](../AGENTS.md)
- [`CLAUDE.md`](../CLAUDE.md)
- [`docs/agents/issue-tracker.md`](../docs/agents/issue-tracker.md)