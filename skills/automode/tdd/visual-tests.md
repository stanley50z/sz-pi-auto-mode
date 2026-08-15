# Visual and End-to-End UI Tests

UI look-and-feel is tested visually: do not write code tests for UI layout,
styling, responsive behavior, visual hierarchy, or interaction-state
appearance. UI behavior is additionally verified with a live end-to-end
browser walkthrough (see below). Neither check replaces the other.

## Tool Priority

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

## Visual RED/GREEN

For UI work, the TDD cycle becomes:

```text
RED:   Open the current UI and capture/inspect the broken or missing state
GREEN: Implement the smallest change
VERIFY: Reopen, interact, screenshot, and inspect the relevant viewports/states
```

The evidence is a screenshot or live browser observation plus concise notes.
Do not replace visual inspection with DOM assertions, snapshot tests, component
unit tests, or "it should render" tests.

## Required Checks

Inspect each relevant screen/state for:

- Text clipping, unintended truncation, overflow, or hidden text.
- Labels, button text, badges, and table cells fitting inside their containers.
- UI components aligned to a coherent grid.
- Balanced horizontal and vertical visual weight.
- Clear hierarchy, grouping, and spacing.
- No incoherent overlap between adjacent sections, controls, cards, modals, or
  navigation.
- Responsive behavior at realistic desktop and mobile viewports.
- Hover, focus, active, disabled, selected, loading, empty, and error states
  when those states exist.
- No unexpected scrollbars, layout jumps, or off-screen controls.

## Visual Quality Rules

- Text must remain readable and fully visible.
- Controls must have enough space for their longest expected labels.
- Repeated components should line up consistently.
- Dense UIs should still scan cleanly; spacious UIs should not feel empty.
- Primary actions and current state should be visually obvious.
- Visual decisions should serve the product workflow, not decoration.

## End-to-End Behavior Walkthrough

Visual checks confirm the UI looks right; the walkthrough confirms it works.
For every changed flow in a web app, drive the real UI in the browser using
the same tool priority as above:

- Perform the actual user workflow: navigate to the page, click the real
  buttons and controls, type input into the real fields, submit.
- Use real data when it is available (dev database, sample files, live dev
  API) rather than only placeholder input.
- Review the result the user would see: rendered data is correct, state
  changes took effect, navigation and redirects land where expected, and
  changes persist across a reload when relevant.
- Exercise reachable error and edge flows, not just the happy path.
- Capture evidence of the outcome — screenshots or observation notes of the
  result state, not just the initial screen.

Scripted e2e suites (Playwright, Cypress, etc.) are good additions where the
project uses them, but they do not replace this live walkthrough of the
changed flow.
