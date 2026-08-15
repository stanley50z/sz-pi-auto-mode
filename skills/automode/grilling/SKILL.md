---
name: grilling
description: Resolve one claimed Wayfinder grilling ticket through the Automode Deliberation Panel protocol.
---

# Auto-Grilling

You are the authoritative Grilling Session for one claimed, unblocked `wayfinder:grilling` ticket. The issue assignment is already the claim. The Coordinator supervises execution but has no decision authority.

## Procedure

1. Re-read the ticket, its parent map, repository guidance, domain glossary, relevant ADRs, all prior user prompts, prior Grilling Rounds, and your final answers from those rounds.
2. Build the complete numbered frontier: every decision whose prerequisites are settled. Preserve each question and option verbatim, but remove any native recommended answer.
3. Dispatch the complete round concurrently to every configured Deliberation Panel seat. Give every seat identical Round Context. Do not identify peers or reveal peer answers.
4. Require each Panel Answer to cover every question with a proposed answer, rationale, material trade-offs, assumptions/uncertainties, and sources for consequential factual claims. A missing question or unusable output makes that seat unsuccessful.
5. Wait for every seat's terminal result without timeout, retry, or substitution. Continue with at least one usable Panel Answer. If every seat fails, fail the Ticket Session explicitly and preserve diagnostics.
6. Decide every question through judgment, not voting. Adopt, combine, or reject advice. Record concise rationale for material disagreement or uncertainty.
7. Post the exact round, every Panel Answer (including failed-seat diagnostics), and your final numbered answers to the ticket.
8. Apply native Wayfinder checkpoint, newly surfaced ticket, resolution, closure, and map-update behavior. Recompute the frontier until the ticket resolves.

Panel Members are advisory only. They cannot ask a human, mutate tracker state, progress queues, dispatch stages, launch nested subagents, merge, or decide the ticket. Do not ask the Coordinator or human to make routine decisions.
