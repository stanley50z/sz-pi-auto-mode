# OpenWiki quickstart

This repository is an early-stage Pi extension centered on an autonomous mode launched with `pi automode`. The current source evidence describes two planned capabilities:

- a **workflow system** inspired by Claude Code and Ben Davis's Pi workflow implementation
- a **personal WeChat channel** extraction so a Pi session can be accessed through personal WeChat

Start here, then follow the section pages below for the small set of concepts that currently exist in the repo.

## What this wiki covers

- the product shape and why the repo exists
- the few known architecture boundaries
- the intended launch and automation surface described by the source docs
- the repository's operating conventions for issue tracking and local OpenWiki updates

## Major sections

- [Architecture overview](architecture/overview.md)
- [Launch and automation](workflows/launch-and-automation.md)
- [Integrations](integrations/wechat.md)
- [Operations](operations.md)

## Canonical source docs

- [`README.md`](../README.md) — top-level product framing and launch phrase
- [`docs/agents/issue-tracker.md`](../docs/agents/issue-tracker.md) — GitHub issue workflow
- [`docs/agents/domain.md`](../docs/agents/domain.md) — how domain docs are meant to be consumed
- [`docs/agents/triage-labels.md`](../docs/agents/triage-labels.md) — label mapping for skills and triage

## Source evidence

- [`README.md`](../README.md) — product summary and planned capabilities
- [`AGENTS.md`](../AGENTS.md) — OpenWiki and issue-tracker guidance
- [`CLAUDE.md`](../CLAUDE.md) — same OpenWiki guidance in a second agent-facing file

## Notes for future updates

There is no application code or domain model checked in yet, so the wiki intentionally stays high-level. When implementation files appear, the first follow-up should be a tighter architecture page and a source map for entrypoints, packages, and tests.