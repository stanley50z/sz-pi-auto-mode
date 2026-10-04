# Attention indicators proposal

Approval pending. Open `index.html` directly. No runtime files changed.

## Request

The operator could see sz-video #67 blocked, but not #65 and #66 needing decisions. #65 was closed with explicit operator approval during this request. #66 remains open pending approval of its Website Capture mock.

## Evidence

The existing live dashboard at port 41738 returned these values from `/api/snapshot` after #65 closed:

- Auto-Implement: #67, blocked, one open native dependency.
- Recent: #65 and #66, both `settled`, with reason `The item no longer matches this Stage after a material tracker change.`
- No attention group; #66 absent from all lane candidates.

A read-only HTTP assertion requiring #66 in a lane or attention group failed. No production mutation was used for the check.

`docs/automode-dashboard-design.md` explicitly sends items that stop matching their lane to collapsed Recent. `src/dashboard-ui.ts` renders that collection as collapsed by default. Queue eligibility and unresolved human attention need separate treatment; changing CSS alone will not recover the current issue state or specific action required.

## Options

- A, recommended: a visible Needs attention section above dispatch lanes.
- B: retain unresolved items in their original lane.

Both preserve actionable reasons, current human-input/failed/paused status, and issue/session access. Completed work belongs in history. The mock's failure and pause examples are illustrative, not claims about #66. The current issue state should take priority over a historical failed attempt, while the attempt result remains in session details. Unresolved attention should be reconstructed from tracker state across Coordinator restarts rather than rely on process-local Recent.

## Mock validation

Browser Harness at 1920 x 958: full-page screenshot inspected, no horizontal overflow, View session opened the read-only explanation, Escape closed it. Test tab closed. No server started. `preview.png` contains both labeled layouts.

Production tests, implementation, and runtime restart are pending layout approval. The live Coordinator uses an immutable runtime snapshot; rebuilding this checkout alone will not update its dashboard.
