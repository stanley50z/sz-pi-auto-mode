---
name: ketch
description: Use Ketch for public-web discovery, clean page extraction, documentation lookup, and open-source code search. Use for unauthenticated web research before escalating to a browser or Firecrawl.
---

# Ketch

Use the installed `ketch` CLI for unauthenticated public-web work.

- `ketch search <query> --json` for discovery.
- `ketch scrape <url>` for clean Markdown from a known page.
- `ketch docs <library> <query>` for library documentation.
- `ketch code <query>` for open-source code search.
- `ketch crawl <url>` only when the task needs multiple pages from one site.

Run `ketch <command> --help` before using an unfamiliar command. Preserve source URLs and cite consequential factual claims. Fail explicitly when Ketch reports an unavailable backend; do not invent results or silently substitute a different source.
