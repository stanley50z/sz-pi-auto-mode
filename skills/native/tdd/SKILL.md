---
name: tdd
description: Use when implementing any feature or bugfix, before writing implementation code
---

# Test-Driven Development

This skill is based on Matt Pocock's `tdd` skill under its upstream name. It
keeps the v1.2 emphasis on agreed test seams and independent expected values,
while retaining the local requirements for command timeouts, user-requirement
test priority, explicit failure over fallback behavior, stale v1/v2 test
cleanup, end-to-end behavior coverage with real data when available, and
visual UI testing plus browser-driven behavior walkthroughs for web apps.

## Philosophy

**Core principle**: Tests should verify behavior through public interfaces,
not implementation details. Code can change entirely; tests shouldn't.

**Good tests** are integration-style: they exercise real code paths through
public APIs. They describe what the system does, not how it does it. A good
test reads like a specification - "user can checkout with valid cart" tells
you exactly what capability exists. These tests survive refactors because they
don't care about internal structure.

**Bad tests** are coupled to implementation. They mock internal collaborators,
test private methods, or verify through external means (like querying a
database directly instead of using the interface). The warning sign: your test
breaks when you refactor, but behavior hasn't changed. If you rename an
internal function and tests fail, those tests were testing implementation, not
behavior.

See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for mocking
guidelines.

For UI work, see [visual-tests.md](visual-tests.md). UI look-and-feel is
verified visually, and UI behavior is verified with a live browser
walkthrough — neither uses component/DOM/snapshot code tests.

## Seams: Where Tests Go

A **seam** is the public boundary you test at: the interface where behavior is
observable without reaching inside the implementation.

Test only at pre-agreed seams. Before writing the first test, identify the
public interface under test and confirm it with the user unless the existing
spec already pins it down. No test should be written against an unconfirmed
internal helper just because it is convenient.

Ask: "What public interface are we testing, and which behavior should prove it
works?"

When the shape of that interface is itself in question — how deep the module
is, where the seam belongs, what the interface should expose — use the
`/codebase-design` skill for the vocabulary. It is the shared source of the
module, interface, depth, seam, adapter, leverage and locality terms, and it
is a reference to consult, not a session to run.

## Timeout Rule

Every test run MUST have a command-level timeout. This is a first-class TDD
rule, not an optional safety net.

If a test command can hang, the agent can hang with it. Never run bare
`npm test`, `pytest`, `go test`, `cargo test`, `vitest`, `jest`, `bun test`,
`deno test`, or similar commands without a timeout around the process.

Use an external timeout that kills the stuck process, not just an in-test
assertion timeout. Runner-level test timeouts help, but they do not replace a
command-level timeout.

Reasonable defaults:

- Single test or focused RED/GREEN check: 30-60 seconds
- Small package or file-level suite: 2-5 minutes
- Full project suite: 5-15 minutes

If a command times out, treat that as a failure that must be debugged. Do not
re-run the same hanging command without changing anything.

## What to Test First

Tests should be derived from user requirements, not implementation details.

The requirements the user actually asked for drive the primary test suite. Each
one should have at least one behavioral test that verifies the feature works as
the user described it, from the outside.

Supporting design decisions get lighter testing. They're often covered
implicitly by the user-requirement tests. Don't write separate tests for
internal functions just because they exist.

Test hierarchy:

1. User-requirement tests - verify features the user asked for, from the user's
   perspective.
2. Edge case / error tests - cover failure modes and boundaries of the
   user-facing behavior.
3. Implementation tests - only when the internal behavior is complex enough to
   warrant direct verification. Ask: "would the user care if this worked
   differently internally?" If no, skip the dedicated internal test.

The test for "login redirects to dashboard" is not
`expect(generateToken()).toBeString()`. It is
`expect(afterLogin().currentPage).toBe('/dashboard')`. Test the feature, not
the plumbing.

## End-to-End Tests Are Required

Unit and integration tests drive the RED/GREEN loop, but they do not finish
the job. Bias the suite toward end-to-end coverage:

- Every user requirement gets at least one end-to-end test or verified run
  that enters through the real entry point (CLI invocation, HTTP request,
  browser workflow) and exercises the full stack with no mocked internals.
- The feature gets a full end-to-end run on real data when real or
  production-like data is available — sample files, fixture dumps, a dev
  database, a live dev API. Minimal synthetic input is a fallback, not the
  default; if only synthetic data exists, say so when reporting results.
- For web apps, end-to-end means the real browser: open the app, click the
  actual buttons, type real input, and review the result the user would see.
  This behavior walkthrough is required on top of the visual checks, not
  instead of them.
- Scripted e2e suites (Playwright, Cypress, etc.) count as end-to-end tests
  where the project has them, but they do not replace the live browser
  walkthrough of the changed flow.

## UI Tests: Visual Plus End-to-End Behavior

<HARD-GATE>
UI look-and-feel is tested visually: do not write code tests for UI layout,
styling, responsive behavior, visual hierarchy, or interaction-state
appearance. UI behavior is tested end-to-end in a real browser: click the
actual buttons, submit real input, and review the result. Both are required;
neither replaces the other.
</HARD-GATE>

For UI work, the RED/GREEN loop is still one behavior at a time, but the test
artifact is visual evidence and inspection notes. Use [visual-tests.md](visual-tests.md)
for the checklist.

Tool priority:

1. Use the strongest available real-browser inspection tool that supports
   screenshots, live inspection, and simulated clicks/keys.
2. For local `file://` pages, prefer Chrome DevTools MCP when it is available.
3. In Codex, the Chrome plugin may satisfy this role; in Claude Code, t3code,
   or other harnesses, use Chrome DevTools MCP or the harness's equivalent
   DevTools/browser MCP.
4. If no DevTools-capable browser tool is available, use the best available
   browser/screenshot tool and state the fallback.

Project instructions may name a more specific browser tool for a target. Follow
those instructions when they are more specific than this default order.

When opening a browser for visual inspection, use full-screen unless the user,
project, or target viewport specifies otherwise.

Visual checks must cover:

- Text is not clipped, truncated unexpectedly, overflowing its container, or
  hidden behind other elements.
- UI components align to a coherent grid and do not drift by a few pixels.
- Horizontal and vertical visual weight feel balanced; the screen should not
  feel lopsided, crowded in one area, or empty in another.
- Spacing, grouping, and hierarchy make the primary workflow obvious.
- Interactive states are visible and usable: hover, focus, active, disabled,
  selected, loading, empty, and error states when relevant.
- Responsive layouts work at realistic desktop and mobile viewports.
- The inspection is based on screenshots or live browser observation, not DOM
  guesses or implementation details.

Behavior walkthroughs must cover:

- The full user workflow of the changed feature, performed live in the
  browser: navigate, click the real controls, enter input, submit.
- The result the user would see: correct data rendered, state changes applied,
  navigation and redirects landing where expected, and persistence across a
  reload when relevant.
- Reachable error and edge flows, not just the happy path.
- Real data when available, per the end-to-end rules above.

## Anti-Pattern: Horizontal Slices

**DO NOT write all tests first, then all implementation.** This is "horizontal
slicing" - treating RED as "write all tests" and GREEN as "write all code."

This produces poor tests:

- Tests written in bulk test imagined behavior, not actual behavior
- You end up testing the shape of things (data structures, function signatures)
  rather than user-facing behavior
- Tests become insensitive to real changes - they pass when behavior breaks,
  fail when behavior is fine
- You outrun your headlights, committing to test structure before understanding
  the implementation

**Correct approach**: Vertical slices via tracer bullets. One test -> one
implementation -> repeat. Each test responds to what you learned from the
previous cycle. Because you just wrote the code, you know exactly what behavior
matters and how to verify it.

```text
WRONG (horizontal):
  RED:   test1, test2, test3, test4, test5
  GREEN: impl1, impl2, impl3, impl4, impl5

RIGHT (vertical):
  RED->GREEN: test1->impl1
  RED->GREEN: test2->impl2
  RED->GREEN: test3->impl3
  ...
```

## Anti-Pattern: Tautological Tests

Expected values must come from an independent source of truth: a spec example,
a known literal, a fixture, or a worked scenario. A test is tautological when
the assertion recomputes the expected value the same way the implementation
does, so it passes by construction.

Bad:

```typescript
const expected = items.reduce((sum, item) => sum + item.price, 0);
expect(calculateTotal(items)).toBe(expected);
```

Good:

```typescript
expect(calculateTotal([{ price: 10 }, { price: 5 }])).toBe(15);
```

## Workflow

### 1. Planning

When exploring the codebase, use the project's domain glossary so that test
names and interface vocabulary match the project's language, and respect ADRs
in the area you're touching.

Before writing any code:

- [ ] Confirm with user what interface changes are needed
- [ ] Confirm with user which user-facing behaviors to test first
- [ ] Identify the end-to-end entry point and what real data is available for
      the final full run
- [ ] For UI changes, define the visual states and viewports to inspect and
      the user workflows to walk through in the browser
- [ ] Identify and confirm the public seam under test
- [ ] Identify opportunities for [deep modules](deep-modules.md)
- [ ] Design interfaces for [testability](interface-design.md)
- [ ] List the behaviors to test, not implementation steps
- [ ] Confirm whether existing v1 behavior is being preserved or replaced

Ask: "What should the public interface look like? Which behaviors are most
important to test?"

You can't test everything. Focus testing effort on user requirements, critical
paths, and complex logic, not every possible edge case.

### 2. Tracer Bullet

Write ONE test that confirms ONE thing about the system:

```text
RED:   Write test for first behavior -> test fails
GREEN: Write minimal code to pass -> test passes
```

This is your tracer bullet - it proves the path works end-to-end.

Verify RED with a timeout. Confirm the test fails for the expected reason
(feature missing), not because of a typo, setup error, or hang.

### 3. Incremental Loop

For each remaining behavior:

```text
RED:   Write next test -> fails
GREEN: Minimal code to pass -> passes
```

Rules:

- One test at a time
- Only enough code to pass the current test
- Don't anticipate future tests
- Keep tests focused on observable behavior
- Keep each test at the confirmed seam
- Run every RED and GREEN check with a timeout
- For UI, use visual inspection plus a browser behavior walkthrough instead of
  code tests

### 4. No Fallbacks, No Silent Failure

<HARD-GATE>
Never write fallback code, default returns, or silent error swallowing to make a
test pass. If the feature doesn't work, the code must fail explicitly.
</HARD-GATE>

Bad:

```typescript
function search(query: string): Result[] {
  try {
    return database.search(query);
  } catch {
    return [];
  }
}
```

That code can make a test green while hiding a broken feature.

Good:

```typescript
function search(query: string): Result[] {
  return database.search(query);
}
```

Rules:

- If you can't implement the feature, let the test fail. Don't fake it.
- Error handling is for expected user-facing error cases, not for masking
  incomplete implementation.
- If you're adding a `try/catch`, default return, or `?? fallbackValue` to make
  a test green, stop and ask whether the code works correctly in production.
- If the planned approach keeps failing, stop and present alternatives to the
  user instead of silently switching approaches.

### 5. Version Upgrades

When the user asks to upgrade, expand, or replace existing behavior (v1) with a
new version (v2):

- Remove or update stale v1 tests first. Tests asserting intentionally replaced
  behavior will pull the implementation back toward v1.
- Never create `if v2 fails, fall back to v1` code unless the user explicitly
  asks for backward compatibility.
- Write new tests for v2 behavior. The test suite should reflect what the user
  wants now, not what existed before.
- If v2 can't be implemented as described, surface the problem. Don't silently
  preserve v1.

### 6. Review-Driven Refactor

Refactoring is not part of the RED/GREEN implementation loop. Get the behavior
green first, then review the diff and refactor deliberately.

For non-trivial diffs, run or request `code-review` before refactoring. Use the
Standards findings and [refactor candidates](refactoring.md) to decide what to
clean up:

- [ ] Extract duplication
- [ ] Deepen modules by moving complexity behind simple interfaces
- [ ] Apply SOLID principles where natural
- [ ] Consider what new code reveals about existing code
- [ ] Run tests after each refactor step, with a timeout

**Never refactor while RED.** Get to GREEN first.

### 7. End-to-End Pass

Before calling the feature done:

- [ ] Run the feature end-to-end through its real entry point, full stack, no
      mocked internals
- [ ] Use real data for this run when it is available; note explicitly when
      only synthetic data existed
- [ ] For web apps, walk the changed flow in a real browser: click the actual
      buttons, enter input, and review the rendered result
- [ ] Run the full test suite once, with a timeout

If the end-to-end pass exposes a failure, return to the RED/GREEN loop — do
not patch around it or declare partial success.

## Checklist Per Cycle

```text
[ ] Test is driven by a user requirement, edge case, or justified internal complexity
[ ] Test describes behavior, not implementation
[ ] Test uses public interface only
[ ] Public seam under test was confirmed or already pinned by the spec
[ ] Expected values come from an independent source of truth
[ ] Test would survive internal refactor
[ ] RED run failed for the expected reason
[ ] RED and GREEN commands used command-level timeouts
[ ] UI changes were verified visually and behaviorally in the browser, not with code tests
[ ] Visual check covered clipping/overflow, alignment, visual balance, states, and responsive viewports
[ ] Feature has at least one end-to-end test/run through the real entry point
[ ] Final end-to-end run used real data when available (noted if only synthetic data existed)
[ ] Web app flows were walked through live: buttons clicked, results reviewed
[ ] Code is minimal for this test
[ ] No speculative features added
[ ] No fallback/default/silent failure added to make the test pass
[ ] Stale v1 tests were removed or updated before implementing v2 behavior
```
