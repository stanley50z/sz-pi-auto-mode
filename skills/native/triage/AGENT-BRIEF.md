# Agent Brief verification contract

An Agent Brief is the authoritative work contract posted when an issue or pull
request moves to `ready-for-agent` or `ready-for-human`. The original body and
discussion remain evidence and context. The brief settles what must change,
what proves it, and what must remain unchanged. A `ready-for-human` brief also
names the unresolved judgment or action that prevents unattended work.

For an issue, the contract describes a change to build. For a pull request, it
describes the remaining work on the existing diff.

## Contract rules

### Durable

Write against behavior and public interfaces that should survive repository
movement. Name types, function signatures, commands, configuration shapes, and
user-visible workflows when they are part of the contract. Leave current file
paths, line numbers, and private implementation structure to the implementing
agent's fresh exploration.

### Behavioral

State the required system behavior, including relevant edge and error cases.
Implementation procedure belongs to the implementing agent unless the issue has
already settled a design constraint that later work must preserve.

### Complete

Record all facts needed to start unattended work. A missing reporter fact moves
the issue to `needs-info`. An unresolved product decision or required human
operation moves it to `ready-for-human`. Dependencies listed in a
`ready-for-agent` brief must already be satisfied or independently available.

### Bounded

Name constraints and out-of-scope behavior. The brief should make adjacent work
easy to refuse without inventing a product decision.

## Verification contract

The verification contract makes completion independently checkable by
Auto-Implement and Auto-Review.

- **Predicate:** One falsifiable sentence that distinguishes finished from
  unfinished work on the real interface.
- **Proof:** Numbered checks through public interfaces. Every acceptance
  criterion maps to at least one proof step, and every proof step names the
  setup, action, and expected observation. Use a stable repository command when
  one exists. Otherwise name the interface and observation so the current
  command can be discovered later.
- **Evidence:** The durable output the pull request must record, such as exact
  command results, a failing-then-passing test, a browser walkthrough, a
  screenshot, a trace, or an artifact path. Evidence must let a reviewer tell
  whether the predicate passed without trusting the implementer's summary.

Use the real surface for the load-bearing behavior. Tests may provide regression
protection, but a proxy is insufficient when the user-visible interface can be
exercised directly. Mark unavailable required proof as a blocker rather than a
pass.

## Template

```markdown
## Agent Brief

**Category:** bug / enhancement
**Summary:** One-line description of the required outcome

**Evidence and context:**
- Established fact, reproduction, prior decision, or linked source

**Requirement:**
Describe the behavior that must hold when the work is complete, including
relevant edge and error cases.

**Key interfaces:**
- Public type, function, command, configuration shape, or user workflow and the
  contract it must satisfy

**Acceptance criteria:**
- [ ] AC1: Independently observable behavior
- [ ] AC2: Independently observable behavior

**Verification contract:**
- **Predicate:** One sentence that is true only when the issue is complete
- **Proof:**
  1. AC1: Given <setup>, perform <action> through <public interface>; observe
     <expected result>
  2. AC2: Given <setup>, perform <action> through <public interface>; observe
     <expected result>
- **Evidence:** Exact results or artifacts the pull request must preserve

**Dependencies:**
- Satisfied prerequisite or independently available input

**Human gate:**
- None for `ready-for-agent`; unresolved judgment or action for `ready-for-human`

**Constraints:**
- Settled compatibility, safety, performance, or design constraint

**Out of scope:**
- Adjacent behavior this issue does not change
```

Use `None` with a short reason when a section has no items. Omission is
ambiguous.

## Example

```markdown
## Agent Brief

**Category:** bug
**Summary:** Preserve whole words when truncating skill descriptions

**Evidence and context:**
- Descriptions longer than 1024 characters currently end mid-word.
- The 1024-character limit is an existing compatibility constraint.

**Requirement:**
Descriptions that exceed the limit end at the last complete word that fits and
use `...` to signal truncation. Shorter descriptions remain byte-for-byte
unchanged.

**Key interfaces:**
- The public skill-metadata loading result and its `description` value

**Acceptance criteria:**
- [ ] AC1: Descriptions at or below 1024 characters are unchanged.
- [ ] AC2: Longer descriptions contain only complete words and end with `...`.
- [ ] AC3: The final description, including `...`, is at most 1024 characters.

**Verification contract:**
- **Predicate:** Every loaded description respects the 1024-character limit,
  preserves short input exactly, and truncates long input at a whole word.
- **Proof:**
  1. AC1: Load fixtures of 1023 and 1024 characters through the public metadata
     loader; observe exact equality with each input.
  2. AC2 and AC3: Load a fixture whose 1024th character falls inside a word;
     observe a whole-word ending followed by `...` and a total length no greater
     than 1024.
- **Evidence:** Record the focused test command and its passing output. Preserve
  the failing regression test in the pull request.

**Dependencies:**
- None. The public metadata loader and test runner already exist.

**Human gate:**
- None. This work can run unattended.

**Constraints:**
- Preserve the existing 1024-character compatibility limit.

**Out of scope:**
- Multi-line description support.
- Changing the limit.
```

## Completeness check

The brief is complete only when:

- Evidence supports the stated current behavior or need.
- The requirement describes behavior rather than an edit recipe.
- Every acceptance criterion is independently observable.
- The predicate is falsifiable.
- Proof covers every acceptance criterion on the strongest available surface.
- Expected observations and required evidence are explicit.
- Dependencies are satisfied or independently available.
- The human gate matches the selected readiness state.
- Constraints and out-of-scope behavior bound the work.
