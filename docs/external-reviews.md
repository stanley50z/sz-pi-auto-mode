# External review bots

Auto-Review can trigger additional GitHub review bots alongside its built-in Review Panel. Every substantive review round posts each bot's configured comment as a separate PR comment, with the body preserved exactly. For Cursor, the complete comment is `@cursor review`.

## Configuration

Global defaults live in `automode-review.json` inside normal Pi's effective agent directory (normally `~/.pi/agent`). A repository's `.pi/automode-review.json` replaces the global file; lists are not merged. Use `{ "bots": [] }` in a repository to disable external reviews there. When neither file exists, Auto-Review runs only its built-in Panel.

```json
{
  "bots": [
    {
      "name": "Cursor",
      "comment": "@cursor review",
      "author": "cursor[bot]",
      "checkName": "Cursor Bugbot"
    }
  ]
}
```

The Coordinator reads and validates these settings at launch, before acquiring its repository lock. Ticket Sessions receive the captured settings through the controlled process protocol. Repository settings come from the launching project root, not the PR worktree. Restart Automode after changing settings. Settings are not stored in the durable Run Record.

Each bot needs a unique `name`, a nonblank `comment`, and its exact GitHub `author` login. Select its completion signal:

- With `checkName`, wait for a new completed check run on the pinned head that started after the trigger comment. Check names must uniquely identify the intended integration. Cursor publishes `Cursor Bugbot` even when there are no findings.
- With `completionPattern`, wait for a new or edited top-level/inline comment by the configured author matching this JavaScript regular expression. Make the pattern specific to completed review output, including the bot's no-findings response. An inline comment must belong to the pinned head. Top-level comments have no commit identity, so the configured bot must review the current head when triggered.
- With neither, wait for a newly submitted GitHub PR review by that author on the pinned head. Pending and dismissed reviews do not count.

`checkName` and `completionPattern` are mutually exclusive. Invalid settings fail startup rather than silently skipping a bot. The integration must already be installed and enabled on each repository using these defaults.

[Cursor's documentation](https://cursor.com/docs/bugbot) describes manual triggers and check conclusions. `neutral` can mean findings, cancellation by a newer commit, or an internal error; `failure` can mean unresolved findings. Auto-Review therefore returns check output together with bot comments/reviews, and the Review Session must assess whether it represents a usable completed review. An error is not approval.

## Round behavior

The `automode_panel` tool posts triggers before launching built-in Reviewers. Built-in review and the external wait then run concurrently. It polls GitHub every 30 seconds without a completion deadline. A pending or missing bot blocks disposition; abort the Ticket Session to cancel the wait. A closed PR, changed head, GitHub API failure, or explicitly cancelled/timed-out check fails the external wait.

After observing completion, the tool fetches review/comment evidence again so an earlier concurrent read cannot omit findings published just before the check completed. The tool returns `externalReports` containing each bot's reviews, comments, and check output, or `externalFailures` alongside the completed built-in reports. A failed built-in Panel cancels the external wait and returns the reports that did complete. The Review Session preserves and publishes built-in reports even if an external wait fails, but cannot perform disposition, fixes, or merge while any required review is missing or unusable. When all reviews are usable, it groups findings from both sources in the same disposition.

Each substantive round triggers again, including later fix rounds. A recorded retry of the same PR, round, and head reuses the trigger rather than posting a duplicate. The three-round limit and terminal Conflict-Fix Round remain unchanged; conflict-only integration does not launch another review.

## Diagnostics and recovery

Persistent artifacts live under `<Git common directory>/automode/external-reviews/` (normally `.git/automode/external-reviews/`):

- `activity.log`: triggers, polling waits, completion, and errors.
- `crash-report.txt`: the latest error with its stack trace.
- `<round-key>.json`: the PR/round/head-keyed journal, captured bot configuration, pre-trigger GitHub evidence, and trigger comment identities. Each trigger body stays exact because bookkeeping is kept locally, not appended to the comment.

If execution stops between preparing and confirming a trigger POST, recovery fails explicitly with an uncertain-delivery diagnostic and the journal path. Inspect GitHub and the journal before repairing that entry; blindly retrying could retrigger a bot. Changing the configured bot list while recovering a recorded round also fails explicitly. Journals are shared between worktrees through the Git common directory and retained for diagnosis.

Focused validation:

```sh
npm run build && node --test dist/test/external-review.test.js dist/test/ticket-panel-extension.test.js dist/test/ticket-session.test.js
```

Tests exercise the controlled tool and isolated-process dispatch using deterministic GitHub/model boundary adapters. They cover exact separate comments, waiting for fresh results, all-bot completion, no-findings checks, author/head matching, completion-comment edits, retries, subsequent rounds, configuration precedence, head changes, cancellation, and persistent diagnostics. Live bot execution needs an enabled integration and a real open PR; the deterministic tests do not claim to prove Cursor's hosted execution.
