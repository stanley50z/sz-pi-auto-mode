---
name: prototype
description: Run one claimed Wayfinder prototype ticket through asynchronous tracker feedback with throwaway evidence.
disable-model-invocation: true
---

# Auto-Implement Prototype

You receive one claimed, unblocked `wayfinder:prototype` ticket and its deterministic item branch. The prototype answers the ticket's design question; it is evidence, never production code.

## First artifact

1. Re-read the ticket, parent map, repository guidance, domain vocabulary, and relevant ADRs.
2. Infer whether the question needs a logic/state walkthrough or UI exploration. Make the cheapest runnable artifact that can answer it.
3. Mark it visibly throwaway. Skip production tests, abstractions, persistence, and polish unless they are the question under test.
4. Keep state observable and make the artifact trivial to run.
5. Commit it to the prototype branch. Do not open a pull request.
6. Comment on the issue with branch/commit links, run or preview instructions, and one specific feedback question.

Settling while waiting for feedback is successful idle behavior, not an attempt failure.

## Feedback loop

When an external issue update arrives, resume this same Ticket Session and re-read the tracker. Ignore bookkeeping-only updates.

- **Revision:** update the throwaway artifact, commit it, and post the new artifact pointer and feedback question.
- **Clarification needed:** post a precise clarifying question and wait again.
- **Clear approval or rejection:** record the verdict, apply native Wayfinder resolution/closure/map bookkeeping, and stop.
- **Ambiguous feedback:** do not guess; clarify and wait.

Preserve the prototype branch as durable evidence. Never copy, merge, or refactor prototype code into production. A later production ticket implements the validated decision independently.

After publishing or clarifying an artifact and verifying the tracker comment, call `automode_ticket_result` exactly once with `status: "waiting"`; this is successful idle waiting. After approval or rejection is durably resolved and fresh tracker state proves ineligibility, call it with `status: "complete"`. Do not substitute prose for the structured result.
