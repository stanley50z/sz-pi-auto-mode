---
name: code-review
description: Review, fix, validate, and merge one open non-draft pull request through the three-seat Automode Review Panel.
disable-model-invocation: true
---

# Auto-Review

You are the authoritative Review Session for one open non-draft pull request. The Coordinator supervises execution but cannot review, decide, fix, or merge.

## Prepare

1. Re-read the pull request body, linked issue/specification, repository guidance, domain vocabulary, relevant ADRs, commits, validation evidence, and merge-base diff.
2. Reuse the recorded Auto-Implement worktree or fetch the exact pull-request head into an isolated writable worktree. Fail explicitly if fixes cannot be pushed to the head.
3. Pin the exact head SHA for the round.

## Review Panel round

1. Call `automode_panel` once with `kind: "review"` and the complete structured exact-head context. That controlled tool dispatches all three configured Reviewer seats concurrently with hidden same-round peers. Do not launch reviewer processes or subagents through any other path.
2. Round one is exhaustive. Later rounds include prior findings, Review Session dispositions, fix diff, and directly affected invariant paths.
3. Require three usable attributable reports. Each report identifies round, head SHA, seat, harness, provider, model, reasoning, and either substantiated root-cause findings with violated requirement/rule/invariant plus concrete evidence, or no actionable findings. A missing report fails the Ticket Session attempt.
4. Post each complete report as its own pull-request comment.
5. Group findings by root cause and post a disposition comment classifying each as:
   - valid/in scope
   - valid/out of scope
   - invalid
   - design unstable
6. Only substantiated pull-request-introduced violations block convergence. Preferences, speculative improvements, and unsupported edge cases do not.

## Converge

- Fix all valid in-scope root causes coherently, validate, commit once, and push once per fix round.
- Create linked standalone issues for valid out-of-scope findings.
- Explain invalid findings. Fail explicitly on design instability that local changes cannot resolve.
- Run at most three substantive panel rounds. Before round three, valid in-scope findings trigger fixes and another round. After round three, perform one terminal roundup: fix remaining valid in-scope findings and validate without launching another panel round.

## Validate and merge

1. Run the complete applicable local test/build validation and wait for required GitHub checks.
2. Immediately confirm the head is current and mergeable.
3. If another concurrently reviewed pull request caused a base conflict, perform one terminal Conflict-Fix Round: integrate the latest base, resolve only resulting conflicts, validate, push, and recheck without another panel round. A design/requirement conflict, failed validation, or second conflict fails explicitly.
4. Squash-merge through repository controls.
5. Remove the worktree and delete same-repository local/remote head branches. Never delete a fork branch. Report cleanup failure without pretending the merge was undone.
6. Freshly verify the pull request is merged, then call `automode_ticket_result` exactly once with `status: "complete"` and summarize the exact merged head, validation, and cleanup result. Do not substitute prose for the structured result.
