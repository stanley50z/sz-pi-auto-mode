---
name: code-review
description: Review, fix, validate, and merge one open non-draft pull request through the configured Automode Review Panel.
disable-model-invocation: true
---

# Auto-Review

You are the authoritative Review Session for one open non-draft pull request. The Coordinator supervises execution but cannot review, decide, fix, or merge.

## Prepare

1. Re-read the pull request body, linked issue/specification, repository guidance, domain vocabulary, relevant ADRs, commits, validation evidence, and merge-base diff. Load the [Agent Brief verification contract](../../native/triage/AGENT-BRIEF.md). When no Agent Brief exists, use an equivalently complete issue discussion as the work contract if it settles required behavior, public seams, verification, dependencies, and human gates. Do not reject review only because template headings are absent. Identify the work contract's predicate, proof steps, and required evidence.
2. Reuse the recorded Auto-Implement worktree or fetch the exact pull-request head into an isolated writable worktree. Fail explicitly if fixes cannot be pushed to the head.
3. Pin the exact head SHA for the round.

## Review Panel round

1. Call `automode_panel` once with `kind: "review"` and `context: { round, headSha, brief }`. The brief is ordinary prose containing the complete pull-request, work-contract, repository-guidance, diff, commit, validation, and prior-round context needed for this round. The controlled tool dispatches every configured Reviewer seat concurrently against the same head SHA with hidden same-round peers. Do not launch reviewer processes or subagents through any other path.
2. Round one is exhaustive. A later-round brief includes prior findings, Review Session dispositions, the fix diff, and directly affected invariant paths.
3. Interpret each completed Reviewer's Markdown with your own judgment. A usable report either says no actionable findings or substantiates pull-request-introduced root causes with an exact changed path and line or range, violated requirement/rule/invariant, and concrete evidence. Formatting differences do not make a substantive report unusable.
4. Post every completed Reviewer report even when another seat failed. Publish one actual GitHub pull-request review per seat, not an ordinary pull-request comment:
   - Confirm the pull request still points to the pinned head immediately before posting.
   - Read existing reviews first. A hidden marker keyed by round, head SHA, and seat makes publication idempotent across retries.
   - Submit `POST /repos/{owner}/{repo}/pulls/{number}/reviews` through `gh api`. Set `commit_id` to the pinned head and `event: "COMMENT"` so advisory seats neither approve nor request changes.
   - Format the review body as `## Automode review: <model>`, `Reviewed commit: <short SHA>`, a concise summary or `No actionable findings.`, full seat/provider/model/reasoning attribution, and the hidden marker. Put `Usage: <usageSummary>` at the end of the review body, using that report's parent-generated `usageSummary` unchanged.
   - Validate each finding against the pinned diff, then attach it to the smallest relevant changed line. Each GitHub review comment supplies `path`, `line`, `side: "RIGHT"`, and `body`; add `start_line` and `start_side` for a range. Format the body as `**[P0-P3] <finding title>**` followed by the evidence and violated requirement. A claimed finding without an attachable changed line is not ready to publish.
5. After every completed report is durable, treat each failed or unusable seat as a missing report. Post one concise failed-seat diagnostic and fail the Ticket Session attempt without disposition, fixes, or merge. Preserve already published reviews for the retry.
6. When every configured seat has a durable usable review, group findings by root cause and post a disposition comment classifying each as:
   - valid/in scope
   - valid/out of scope
   - invalid
   - design unstable
7. Only substantiated pull-request-introduced violations block convergence. Preferences, speculative improvements, and unsupported edge cases do not.

## Converge

- Fix all valid in-scope root causes coherently, validate, commit once, and push once per fix round.
- Create linked standalone issues for valid out-of-scope findings.
- Explain invalid findings. Fail explicitly on design instability that local changes cannot resolve.
- Run at most three substantive panel rounds. Before round three, valid in-scope findings trigger fixes and another round. After round three, perform one terminal roundup: fix remaining valid in-scope findings and validate without launching another panel round.
- If the work contract remains substantively incomplete or a required human decision blocks review, record the blocker once and call `automode_ticket_result` with `status: "waiting"`. The Coordinator holds the item until a material tracker update; do not consume retries by repeating an unchanged blocker.

## Validate and merge

1. Re-run every applicable proof step from the work contract against the final head and compare the observation with its expected result. Confirm the pull request preserves the required evidence. Then run the complete applicable local test/build validation and wait for required GitHub checks. Unavailable required proof is a failed validation.
2. Immediately confirm the head is current and mergeable.
3. If another concurrently reviewed pull request caused a base conflict, perform one terminal Conflict-Fix Round: integrate the latest base, resolve only resulting conflicts, validate, push, and recheck without another panel round. A design/requirement conflict, failed validation, or second conflict fails explicitly.
4. Squash-merge through repository controls.
5. Remove the worktree and delete same-repository local/remote head branches. Never delete a fork branch. Report cleanup failure without pretending the merge was undone.
6. Freshly verify the pull request is merged, then call `automode_ticket_result` exactly once with `status: "complete"`, a summary of the exact merged head, validation, and cleanup result, and `finalDisposition` containing the complete `## Automode final validation` Markdown. Do not post that final disposition yourself. The controlled runtime appends exact whole-session token and cost totals and posts it after the full Review Session settles. Do not substitute prose for the structured result.
