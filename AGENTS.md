## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage labels for issue routing. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses the single-context domain docs layout. See `docs/agents/domain.md`.

<!-- OPENWIKI:START -->

## OpenWiki

This repository uses OpenWiki for recurring code documentation. Start with `openwiki/quickstart.md`, then follow its links to architecture, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

Refresh OpenWiki locally with `OPENWIKI_PROVIDER=openai-chatgpt openwiki code --update --print`; this repository intentionally has no OpenWiki CI workflow. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and regenerating them locally.

<!-- OPENWIKI:END -->
