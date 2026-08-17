import assert from "node:assert/strict";
import test from "node:test";
import type { CoordinatorTracker } from "../src/coordinator.js";
import {
  AUTOMODE_BOOKKEEPING_MARKER,
  GitHubTracker,
  type GitHubCommandRunner,
} from "../src/github-tracker.js";
import type { TrackerBookkeeping } from "../src/tracker.js";

class FixtureRunner implements GitHubCommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];

  constructor(private readonly responses: Readonly<Record<string, unknown>>) {}

  async run(command: string, args: readonly string[], cwd: string): Promise<string> {
    this.calls.push({ command, args, cwd });
    if (args[0] === "api" && args[1] === "graphql") {
      const number = args.find((argument) => argument.startsWith("number="))?.slice("number=".length);
      const legacyEndpoint = `repos/owner/repository/issues/${number}/comments?per_page=100`;
      const pages = this.responses[legacyEndpoint];
      if (!Array.isArray(pages)) throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
      return JSON.stringify(pages.map((page) => ({
        data: {
          repository: {
            pullRequest: {
              comments: {
                nodes: (page as Array<Record<string, unknown>>).map((comment) => ({
                  id: comment.node_id,
                  databaseId: comment.id,
                  body: comment.body,
                  author: comment.user,
                  createdAt: comment.created_at,
                  updatedAt: comment.updated_at,
                })),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      })));
    }
    const endpoint = args.find((argument) => argument.startsWith("repos/"));
    if (!endpoint || !(endpoint in this.responses)) {
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    }
    return JSON.stringify(this.responses[endpoint]);
  }
}

function issue(number: number, overrides: Record<string, unknown> = {}) {
  return {
    id: number * 100,
    node_id: `ISSUE_${number}`,
    number,
    html_url: `https://github.com/owner/repository/issues/${number}`,
    state: "open",
    title: `Issue ${number}`,
    body: `Body ${number}`,
    created_at: "2026-08-14T10:00:00Z",
    updated_at: "2026-08-14T11:00:00Z",
    labels: [{ name: "ready-for-agent" }, { name: "bug" }],
    assignees: [{ login: "zeta" }, { login: "alpha" }],
    issue_dependencies_summary: { blocked_by: 0 },
    ...overrides,
  };
}

test("a complete tracker snapshot normalizes every paginated issue and pull request", async () => {
  const pullIssue = issue(3, {
    node_id: "PR_3",
    html_url: "https://github.com/owner/repository/pull/3",
    labels: [{ name: "review" }],
    assignees: [],
    issue_dependencies_summary: { blocked_by: 2 },
    pull_request: { url: "https://api.github.com/repos/owner/repository/pulls/3" },
  });
  const runner = new FixtureRunner({
    "repos/owner/repository/issues?state=open&per_page=100": [
      [issue(2)],
      [pullIssue],
    ],
    "repos/owner/repository/pulls?state=open&per_page=100": [
      [{
        number: 3,
        node_id: "PR_3",
        html_url: "https://github.com/owner/repository/pull/3",
        body: "",
        head: {
          sha: "abc123",
          ref: "automode/issue-2",
          repo: { full_name: "owner/repository" },
        },
        draft: false,
        merged_at: null,
      }],
    ],
    "repos/owner/repository/issues/2/comments?per_page=100": [
      [{
        id: 201,
        node_id: "COMMENT_201",
        body: "external context",
        user: { login: "reporter" },
        created_at: "2026-08-14T10:30:00Z",
        updated_at: "2026-08-14T10:30:00Z",
      }],
    ],
    "repos/owner/repository/issues/3/comments?per_page=100": [[], []],
  });
  const tracker = new GitHubTracker({
    cwd: "C:\\repository",
    repository: "owner/repository",
    actor: "automode-bot",
    runner,
  });
  const coordinatorTracker: CoordinatorTracker = tracker;

  const snapshot = await tracker.snapshot();
  assert.equal(coordinatorTracker, tracker);

  assert.match(snapshot.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(snapshot.items, [
    {
      id: "owner/repository#2",
      nodeId: "ISSUE_2",
      kind: "issue",
      number: 2,
      url: "https://github.com/owner/repository/issues/2",
      state: "open",
      title: "Issue 2",
      body: "Body 2",
      createdAt: "2026-08-14T10:00:00.000Z",
      updatedAt: "2026-08-14T11:00:00.000Z",
      labels: ["bug", "ready-for-agent"],
      assignees: ["alpha", "zeta"],
      blockedBy: 0,
      comments: [{
        id: "201",
        nodeId: "COMMENT_201",
        author: "reporter",
        body: "external context",
        createdAt: "2026-08-14T10:30:00.000Z",
        updatedAt: "2026-08-14T10:30:00.000Z",
      }],
      bookkeeping: null,
      bookkeepingRevision: null,
      materialVersion: snapshot.items[0]!.materialVersion,
    },
    {
      id: "owner/repository#3",
      nodeId: "PR_3",
      kind: "pull-request",
      number: 3,
      url: "https://github.com/owner/repository/pull/3",
      state: "open",
      title: "Issue 3",
      body: "Body 3",
      createdAt: "2026-08-14T10:00:00.000Z",
      updatedAt: "2026-08-14T11:00:00.000Z",
      labels: ["review"],
      assignees: [],
      blockedBy: 2,
      headSha: "abc123",
      headBranch: "automode/issue-2",
      headRepository: "owner/repository",
      draft: false,
      merged: false,
      comments: [],
      bookkeeping: null,
      bookkeepingRevision: null,
      materialVersion: snapshot.items[1]!.materialVersion,
    },
  ]);
  assert.match(snapshot.items[0]!.materialVersion, /^[a-f0-9]{64}$/);
  assert.match(snapshot.items[1]!.materialVersion, /^[a-f0-9]{64}$/);
  assert.equal(runner.calls.every((call) => call.command === "gh"), true);
  assert.equal(runner.calls.every((call) => call.args.includes("--paginate")), true);
  assert.equal(runner.calls.every((call) => call.args.includes("--slurp")), true);
});

test("pull-request comments use GraphQL when GitHub's REST issue-comments route is unavailable", async () => {
  const pullIssue = issue(15, {
    node_id: "PR_15",
    html_url: "https://github.com/owner/repository/pull/15",
    labels: [{ name: "review" }],
    assignees: [],
    pull_request: { url: "https://api.github.com/repos/owner/repository/pulls/15" },
  });
  const runner: GitHubCommandRunner = {
    async run(command, args) {
      const endpoint = args.find((argument) => argument.startsWith("repos/"));
      if (endpoint === "repos/owner/repository/issues/15") return JSON.stringify(pullIssue);
      if (endpoint === "repos/owner/repository/pulls/15") {
        return JSON.stringify({
          number: 15,
          head: {
            sha: "abc123",
            ref: "automode/issue-14",
            repo: { full_name: "owner/repository" },
          },
          draft: false,
          merged_at: null,
        });
      }
      if (endpoint === "repos/owner/repository/issues/15/comments?per_page=100") {
        throw new Error("gh: Not Found (HTTP 404)");
      }
      if (command === "gh" && args[0] === "api" && args[1] === "graphql") {
        return JSON.stringify([{
          data: {
            repository: {
              pullRequest: {
                comments: {
                  nodes: [{
                    id: "IC_PR_1501",
                    databaseId: 1501,
                    body: "review context",
                    author: { login: "reviewer" },
                    createdAt: "2026-08-14T10:30:00Z",
                    updatedAt: "2026-08-14T10:30:00Z",
                  }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }]);
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    },
  };
  const tracker = new GitHubTracker({
    cwd: "C:\\repository",
    repository: "owner/repository",
    actor: "automode-bot",
    runner,
  });

  const snapshot = await tracker.reread({ kind: "pull-request", number: 15 });

  assert.deepEqual(snapshot.comments, [{
    id: "1501",
    nodeId: "IC_PR_1501",
    author: "reviewer",
    body: "review context",
    createdAt: "2026-08-14T10:30:00.000Z",
    updatedAt: "2026-08-14T10:30:00.000Z",
  }]);
});

test("an issue with GitHub's omitted dependency summary has no open blockers", async () => {
  const runner = new FixtureRunner({
    "repos/owner/repository/issues/36": issue(36, {
      assignees: [],
      issue_dependencies_summary: undefined,
    }),
    "repos/owner/repository/issues/36/comments?per_page=100": [[]],
    "repos/owner/repository/pulls?state=open&per_page=100": [[]],
  });
  const tracker = new GitHubTracker({
    cwd: "C:\\repository",
    repository: "owner/repository",
    actor: "automode-bot",
    runner,
  });

  const snapshot = await tracker.reread({ kind: "issue", number: 36 });

  assert.equal(snapshot.blockedBy, 0);
});

test("an updated_at-only external change advances the complete snapshot revision", async () => {
  let updatedAt = "2026-08-14T11:00:00Z";
  const runner: GitHubCommandRunner = {
    async run(_command, args) {
      const endpoint = args.find((argument) => argument.startsWith("repos/"));
      if (endpoint === "repos/owner/repository/issues?state=open&per_page=100") {
        return JSON.stringify([[issue(5, { updated_at: updatedAt, assignees: [] })]]);
      }
      if (endpoint === "repos/owner/repository/pulls?state=open&per_page=100") return JSON.stringify([[]]);
      if (endpoint === "repos/owner/repository/issues/5/comments?per_page=100") return JSON.stringify([[]]);
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
  };
  const tracker = new GitHubTracker({
    cwd: "C:\\repository",
    repository: "owner/repository",
    actor: "automode-bot",
    runner,
  });

  const before = await tracker.snapshot();
  updatedAt = "2026-08-14T11:01:00Z";
  const after = await tracker.snapshot();

  assert.notEqual(before.revision, after.revision);
  assert.equal(before.items[0]!.materialVersion, after.items[0]!.materialVersion);
});

test("an open linked delivery pull request removes an issue from production eligibility proof", async () => {
  const runner = new FixtureRunner({
    "repos/owner/repository/issues/6": issue(6, { assignees: [] }),
    "repos/owner/repository/issues/6/comments?per_page=100": [[]],
    "repos/owner/repository/issues/7": issue(7, { assignees: [] }),
    "repos/owner/repository/issues/7/comments?per_page=100": [[]],
    "repos/owner/repository/pulls?state=open&per_page=100": [[{
      number: 60,
      html_url: "https://github.com/owner/repository/pull/60",
      body: "Implements the requested change.\n\nCloses #6; follow-up #7",
    }]],
  });
  const tracker = new GitHubTracker({
    cwd: "C:\\repository",
    repository: "owner/repository",
    actor: "automode-bot",
    runner,
  });

  const reread = await tracker.reread({ kind: "issue", number: 6 });
  const followUp = await tracker.reread({ kind: "issue", number: 7 });

  assert.equal(reread.outputPullRequest, "https://github.com/owner/repository/pull/60");
  assert.equal(followUp.outputPullRequest, undefined);
});

test("claim and release reread an issue and verify unambiguous ownership", async () => {
  let assignees: Array<{ login: string }> = [];
  const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
  const runner: GitHubCommandRunner = {
    async run(command, args, cwd) {
      calls.push({ command, args, cwd });
      const endpoint = args.find((argument) => argument.startsWith("repos/"));
      if (endpoint === "repos/owner/repository/issues/7") {
        return JSON.stringify(issue(7, { assignees }));
      }
      if (endpoint === "repos/owner/repository/issues/7/comments?per_page=100") {
        return JSON.stringify([[]]);
      }
      if (endpoint === "repos/owner/repository/pulls?state=open&per_page=100") {
        return JSON.stringify([[]]);
      }
      if (endpoint === "repos/owner/repository/issues/7/assignees") {
        if (args.includes("POST")) assignees = [{ login: "automode-bot" }];
        else if (args.includes("DELETE")) assignees = [];
        else throw new Error("assignee mutation had no method");
        return JSON.stringify({ assignees });
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    },
  };
  const tracker = new GitHubTracker({
    cwd: "C:\\repository",
    repository: "owner/repository",
    actor: "automode-bot",
    runner,
  });

  await tracker.claim({ kind: "issue", number: 7 }, "automode-bot");
  const claimed = await tracker.read({ kind: "issue", number: 7 });
  await tracker.release({ kind: "issue", number: 7 }, "automode-bot");
  const released = await tracker.read({ kind: "issue", number: 7 });

  assert.deepEqual(claimed.assignees, ["automode-bot"]);
  assert.deepEqual(released.assignees, []);
  assert.deepEqual(
    calls.filter((call) => call.args.includes("--method")).map((call) => call.args),
    [
      [
        "api",
        "--method",
        "POST",
        "repos/owner/repository/issues/7/assignees",
        "--raw-field",
        "assignees[]=automode-bot",
      ],
      [
        "api",
        "--method",
        "DELETE",
        "repos/owner/repository/issues/7/assignees",
        "--raw-field",
        "assignees[]=automode-bot",
      ],
    ],
  );
});

test("bookkeeping creates one marked comment, updates it in place, and does not change material revision", async () => {
  let commentBody: string | undefined;
  let mutationCount = 0;
  const mutationCalls: readonly string[][] = [];
  const calls = mutationCalls as string[][];
  const runner: GitHubCommandRunner = {
    async run(command, args) {
      const endpoint = args.find((argument) => argument.startsWith("repos/"));
      if (endpoint === "repos/owner/repository/issues/9") {
        return JSON.stringify(issue(9, {
          updated_at: mutationCount === 0
            ? "2026-08-14T11:00:00Z"
            : `2026-08-14T11:0${mutationCount}:00Z`,
          assignees: [],
        }));
      }
      if (
        endpoint === "repos/owner/repository/issues?state=open&per_page=100"
        || endpoint === "repos/owner/repository/issues?state=all&per_page=100"
      ) {
        return JSON.stringify([[issue(9, {
          updated_at: `2026-08-14T11:0${mutationCount}:00Z`,
          assignees: [],
        })]]);
      }
      if (
        endpoint === "repos/owner/repository/pulls?state=open&per_page=100"
        || endpoint === "repos/owner/repository/pulls?state=all&per_page=100"
      ) {
        return JSON.stringify([[]]);
      }
      if (endpoint === "repos/owner/repository/issues/9/comments?per_page=100") {
        return JSON.stringify([commentBody === undefined ? [] : [{
          id: 901,
          node_id: "COMMENT_901",
          body: commentBody,
          user: { login: "automode-bot" },
          created_at: "2026-08-14T11:01:00Z",
          updated_at: `2026-08-14T11:0${mutationCount}:00Z`,
        }]]);
      }
      if (
        endpoint === "repos/owner/repository/issues/9/comments"
        || endpoint === "repos/owner/repository/issues/comments/901"
      ) {
        calls.push([...args]);
        const bodyArgument = args.find((argument) => argument.startsWith("body="));
        assert.ok(bodyArgument);
        commentBody = bodyArgument.slice("body=".length);
        mutationCount += 1;
        return JSON.stringify({ id: 901 });
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    },
  };
  const tracker = new GitHubTracker({
    cwd: "C:\\repository",
    repository: "owner/repository",
    actor: "automode-bot",
    runner,
  });
  const first: TrackerBookkeeping = {
    version: 1,
    item: {
      kind: "issue",
      number: 9,
      url: "https://github.com/owner/repository/issues/9",
    },
    stage: "auto-implement",
    skillName: "implement",
    lifecycle: "running",
    materialVersion: "external-a",
    sessionId: "session-9",
    sessionFile: "C:/sessions/session-9.jsonl",
    workspace: {
      branch: "automode/issue-9",
      worktree: "C:/repository/.worktree/issue-9",
    },
    attempt: 1,
  };
  const second: TrackerBookkeeping = {
    ...first,
    attempt: 2,
    lifecycle: "retrying",
    materialVersion: "external-b",
  };

  await tracker.upsertBookkeeping(first);
  const created = await tracker.read(first.item);
  await tracker.upsertBookkeeping(second);
  const updated = await tracker.read(second.item);
  const recovered = await tracker.listBookkeeping();

  assert.equal(commentBody?.split("\n", 1)[0], AUTOMODE_BOOKKEEPING_MARKER);
  assert.equal(created.materialVersion, updated.materialVersion);
  assert.notEqual(created.bookkeepingRevision, updated.bookkeepingRevision);
  assert.deepEqual(updated.bookkeeping?.value, second);
  assert.deepEqual(recovered, [second]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]?.slice(0, 4), [
    "api",
    "--method",
    "POST",
    "repos/owner/repository/issues/9/comments",
  ]);
  assert.deepEqual(calls[1]?.slice(0, 4), [
    "api",
    "--method",
    "PATCH",
    "repos/owner/repository/issues/comments/901",
  ]);
});

test("recovery reads bookkeeping from closed items before fresh open discovery", async () => {
  const value: TrackerBookkeeping = {
    version: 1,
    item: { kind: "issue", number: 10, url: "https://github.com/owner/repository/issues/10" },
    stage: "auto-implement",
    skillName: "implement",
    attempt: 4,
    lifecycle: "retrying",
    materialVersion: "closed-10",
  };
  const runner = new FixtureRunner({
    "repos/owner/repository/issues?state=all&per_page=100": [[issue(10, { state: "closed", assignees: [] })]],
    "repos/owner/repository/pulls?state=all&per_page=100": [[]],
    "repos/owner/repository/issues/10/comments?per_page=100": [[{
      id: 1001,
      node_id: "COMMENT_1001",
      body: `${AUTOMODE_BOOKKEEPING_MARKER}\n${JSON.stringify({ version: 1, value })}`,
      user: { login: "automode-bot" },
      created_at: "2026-08-14T11:00:00Z",
      updated_at: "2026-08-14T11:00:00Z",
    }]],
  });
  const tracker = new GitHubTracker({
    cwd: "C:\\repository",
    repository: "owner/repository",
    actor: "automode-bot",
    runner,
  });

  assert.deepEqual(await tracker.listBookkeeping(), [value]);
});

test("a marked bookkeeping comment owned by another actor fails closed", async () => {
  const value: TrackerBookkeeping = {
    version: 1,
    item: {
      kind: "issue",
      number: 11,
      url: "https://github.com/owner/repository/issues/11",
    },
    stage: "auto-triage",
    skillName: "triage",
    lifecycle: "running",
    materialVersion: "external-11",
    sessionId: "session-11",
    sessionFile: "C:/sessions/session-11.jsonl",
    attempt: 1,
  };
  const runner = new FixtureRunner({
    "repos/owner/repository/issues/11": issue(11, { assignees: [] }),
    "repos/owner/repository/issues/11/comments?per_page=100": [[{
      id: 1101,
      node_id: "COMMENT_1101",
      body: `${AUTOMODE_BOOKKEEPING_MARKER}\n${JSON.stringify({ version: 1, value })}`,
      user: { login: "another-user" },
      created_at: "2026-08-14T11:00:00Z",
      updated_at: "2026-08-14T11:00:00Z",
    }]],
  });
  const tracker = new GitHubTracker({
    cwd: "C:\\repository",
    repository: "owner/repository",
    actor: "automode-bot",
    runner,
  });

  await assert.rejects(
    () => tracker.reread({ kind: "issue", number: 11 }),
    /bookkeeping comment 1101 is not owned by automode-bot/,
  );
});

test("malformed REST pagination and ambiguous bookkeeping fail closed", async () => {
  const malformed = new GitHubTracker({
    cwd: "C:\\repository",
    repository: "owner/repository",
    actor: "automode-bot",
    runner: new FixtureRunner({
      "repos/owner/repository/issues?state=open&per_page=100": { items: [] },
      "repos/owner/repository/pulls?state=open&per_page=100": [[]],
    }),
  });
  await assert.rejects(
    () => malformed.snapshot(),
    /Malformed GitHub open issues: expected paginated arrays/,
  );

  const value: TrackerBookkeeping = {
    version: 1,
    item: {
      kind: "pull-request",
      number: 12,
      url: "https://github.com/owner/repository/pull/12",
    },
    stage: "auto-review",
    skillName: "code-review",
    lifecycle: "running",
    materialVersion: "external-12",
    sessionId: "session-12",
    sessionFile: "C:/sessions/session-12.jsonl",
    attempt: 1,
  };
  const marked = (id: number) => ({
    id,
    node_id: `COMMENT_${id}`,
    body: `${AUTOMODE_BOOKKEEPING_MARKER}\n${JSON.stringify({ version: 1, value })}`,
    user: { login: "automode-bot" },
    created_at: "2026-08-14T11:00:00Z",
    updated_at: "2026-08-14T11:00:00Z",
  });
  const ambiguous = new GitHubTracker({
    cwd: "C:\\repository",
    repository: "owner/repository",
    actor: "automode-bot",
    runner: new FixtureRunner({
      "repos/owner/repository/issues/12": issue(12, { assignees: [] }),
      "repos/owner/repository/issues/12/comments?per_page=100": [[marked(1201)], [marked(1202)]],
    }),
  });
  await assert.rejects(
    () => ambiguous.reread({ kind: "issue", number: 12 }),
    /Ambiguous GitHub bookkeeping on item #12: found 2 comments/,
  );

  const mismatchedRecord: TrackerBookkeeping = {
    version: 1,
    item: {
      kind: "issue",
      number: 14,
      url: "https://github.com/owner/repository/issues/14",
    },
    stage: "auto-triage",
    skillName: "triage",
    attempt: 1,
    lifecycle: "running",
    materialVersion: "external-14",
  };
  const mismatched = new GitHubTracker({
    cwd: "C:\\repository",
    repository: "owner/repository",
    actor: "automode-bot",
    runner: new FixtureRunner({
      "repos/owner/repository/issues/13": issue(13, { assignees: [] }),
      "repos/owner/repository/issues/13/comments?per_page=100": [[]],
      "repos/owner/repository/pulls?state=open&per_page=100": [[]],
    }),
  });
  await assert.rejects(
    () => mismatched.updateBookkeeping({ kind: "issue", number: 13 }, mismatchedRecord),
    /bookkeeping identity does not match GitHub item #13/,
  );
});
