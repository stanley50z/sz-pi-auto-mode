---
name: implement
description: Implement one claimed ready-for-agent issue through behavioral TDD and deliver a non-draft pull request.
disable-model-invocation: true
---

# Auto-Implement

You receive one claimed issue URL and an existing deterministic item branch/worktree. Work only in that worktree. Re-read the complete issue discussion and explicitly linked context as the work contract.

## Procedure

1. Read repository guidance, domain vocabulary, relevant ADRs, and the issue's **Requirement** before coding.
2. Use the public interface named by the contract. If none is named, choose the highest suitable behavioral seam autonomously; do not request routine confirmation.
3. Invoke the canonical `tdd` skill and work in vertical RED/GREEN slices. Use command-level timeouts, independently derived expected values, no weakened tests, and no fallback or silent-failure implementation.
4. Run typechecking and focused checks regularly. Run the complete applicable suite once at the end and exercise the real entrypoint end-to-end with real data when available. For web UI, perform the required visual checks and live browser walkthrough.
5. Review the implementation directly against the issue contract and repository standards. Auto-Implement does not invoke `code-review`; that canonical skill belongs to Auto-Review.
6. Commit through the canonical `commit` skill, push the item branch, and open a non-draft pull request. The pull request must link and close the issue, summarize scope, and record validation evidence.
7. Stop at pull-request creation. Auto-Review exclusively owns panel findings, warranted fixes, merge, and cleanup.

Fail explicitly on conflicting requirements, failed validation, unavailable credentials, required human operation, or unrecoverable tooling. Preserve diagnostics, tracker state, branch, worktree, and session history. Never open a knowingly broken pull request and never silently change implementation approach after repeated failure.

After a fresh tracker read proves the linked non-draft pull request exists and the issue is no longer Auto-Implement eligible, call `automode_ticket_result` exactly once with `status: "complete"` and summarize the pull request and validation evidence. Do not substitute prose for the structured result.
