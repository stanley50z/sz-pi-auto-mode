---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

# Implement

Implement the work described by the user in the spec or tickets.

Work one ticket at a time from the frontier (tickets whose blockers are all done). Read the ticket's **Requirement** before coding.

Use `/tdd` where possible, at pre-agreed seams. For UI layout, styling, responsive behavior, visual hierarchy, and interaction states, use the visual RED/GREEN checks from the tdd skill — no component tests, DOM assertions, or snapshot tests. UI behavior additionally gets the tdd skill's live browser walkthrough: click the actual buttons, enter input, and review the result.

Run typechecking regularly, single test files regularly, and the full test suite once at the end. Before closing a ticket that changes user-facing behavior, run the tdd skill's end-to-end pass: a full run through the real entry point on real data when available, and for web apps the live browser walkthrough of the changed flow.

## Hard Rules

- **No fallbacks, no silent failure.** Implement the feature for real — no default returns, no swallowed errors, no `?? fallbackValue` to make a test pass. If it can't be implemented, let the test fail and say so.
- **Suggest, don't auto-apply.** When the planned approach keeps failing, stop and present alternatives to the user. The user decides which direction to take.
- **Version upgrades:** when replacing v1 with v2, remove or rewrite stale v1 tests *before* implementing v2. Never add v1 fallback paths unless the user explicitly asks for backward compatibility.

## When the User Requests a Change Mid-Implementation

Treat it as a new requirement and propagate it to every artifact, not just the code in front of you:

1. **Spec** — update the published spec on the tracker
2. **Tickets** — update or add tickets on the tracker, remove stale ones
3. **Tests** — remove/rewrite tests for old behavior, write tests for new
4. **Implementation** — update the code

A mid-implementation change has the same authority as an initial requirement stated during grilling.

## Close Out

Once done:

1. Use `/code-review` to review the work and address what it finds.
2. Commit to the current branch with the commit skill.
3. Push the feature branch and create a ready-to-review pull request. The PR must not be a draft; give it a clear title and a body that summarizes the change, links the relevant spec or tickets, and lists the validation performed.
4. Ask the user to test the feature themselves before wrapping up — automated tests passing does not mean it works as they expected.
