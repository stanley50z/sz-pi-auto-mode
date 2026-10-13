import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadExternalReviewBots, GitHubExternalReviews, type ExternalReviewBot } from "../src/external-review.js";
import { createTicketPanelExtension } from "../src/ticket-panel-extension.js";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

const headSha = "abcdef1234567890abcdef1234567890abcdef12";
const bot = { name: "Cursor", comment: "@cursor review", author: "cursor[bot]", checkName: "Cursor Bugbot" };
const context = { round: 1, headSha, brief: "Review the exact diff." };

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "external-review-"));
  const repository = join(directory, "repo");
  const agent = join(directory, "agent");
  mkdirSync(join(repository, ".pi"), { recursive: true });
  mkdirSync(agent);
  return { directory, repository, agent };
}

test("repository review-bot settings replace global defaults, including an empty override", () => {
  const { repository, agent } = fixture();
  writeFileSync(join(agent, "automode-review.json"), JSON.stringify({ bots: [bot] }));
  assert.deepEqual(loadExternalReviewBots(repository, agent), [bot]);
  writeFileSync(join(repository, ".pi", "automode-review.json"), JSON.stringify({ bots: [] }));
  assert.deepEqual(loadExternalReviewBots(repository, agent), []);
});

test("the review tool posts the exact snippet and waits for a fresh completed check before returning findings", async () => {
  const { directory } = fixture();
  const posted: string[] = [];
  let complete = false;
  let panelStarted = false;
  let poll!: () => void;
  let waiting!: () => void;
  const waitingForBot = new Promise<void>((resolve) => { waiting = resolve; });
  const oldCheck = { id: 1, name: "Cursor Bugbot", status: "completed", conclusion: "success", head_sha: headSha };
  const currentCheck = { id: 2, name: "Cursor Bugbot", status: "in_progress", conclusion: null, head_sha: headSha, started_at: "2026-01-01T00:00:01Z" };
  const runner = {
    async run(_command: string, args: readonly string[]) {
      const endpoint = args.find((arg) => arg.startsWith("repos/"))!;
      if (args.includes("POST")) {
        posted.push(args.find((arg) => arg.startsWith("body="))!.slice(5));
        return JSON.stringify({ id: 20, created_at: "2026-01-01T00:00:00Z" });
      }
      if (endpoint.endsWith("/pulls/42")) return JSON.stringify([{ state: "open", head: { sha: headSha } }]);
      if (endpoint.includes("/check-runs?")) return JSON.stringify([{ check_runs: posted.length ? [oldCheck, { ...currentCheck, status: complete ? "completed" : "in_progress", conclusion: complete ? "neutral" : null }] : [oldCheck] }]);
      if (endpoint.includes("/reviews?")) return "[[]]";
      if (endpoint.includes("/comments?")) return JSON.stringify([complete && endpoint.includes("/pulls/") ? [{ id: 30, user: { login: "cursor[bot]" }, body: "A real finding", commit_id: headSha, path: "src/app.ts", line: 12, created_at: "2026-01-01T00:01:00Z", updated_at: "2026-01-01T00:01:00Z" }] : []]);
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    },
  };
  const externalReviews = new GitHubExternalReviews({ cwd: directory, itemUrl: "https://github.com/owner/repo/pull/42", bots: [bot], stateDirectory: join(directory, "state"), runner, wait: async () => { waiting(); await new Promise<void>((resolve) => { poll = resolve; }); } });
  let tool!: ToolDefinition;
  const extension = createTicketPanelExtension(async () => {
    panelStarted = true;
    assert.deepEqual(posted, ["@cursor review"]);
    return { markdown: "No actionable findings.", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  }, [{ harness: "pi", provider: "openai", model: "test", reasoning: "low" }], undefined, externalReviews);
  const pi = { registerTool(value: ToolDefinition) { tool = value; } } as unknown as ExtensionAPI;
  if (typeof extension === "function") await extension(pi); else await extension.factory(pi);
  let settled = false;
  const pending = tool.execute("call", { kind: "review", context }, undefined, undefined, {} as never).then((result) => { settled = true; return result; });
  await waitingForBot;
  assert.equal(panelStarted, true);
  assert.equal(settled, false);
  complete = true;
  poll();
  const result = await pending;
  const details = result.details as { externalReports: Array<{ bot: string; comments: Array<{ body: string }> }> };
  assert.equal(details.externalReports[0]!.bot, "Cursor");
  assert.equal(details.externalReports[0]!.comments[0]!.body, "A real finding");
  assert.match(readFileSync(join(directory, "state", "activity.log"), "utf8"), /Cursor/);
});

function githubFixture(bots: readonly ExternalReviewBot[] = [bot]) {
  const { directory } = fixture();
  const stateDirectory = join(directory, "state");
  const posted: string[] = [];
  let sha = headSha;
  let reviews: unknown[] = [];
  let comments: unknown[] = [];
  let checks: unknown[] = [];
  const runner = {
    async run(_command: string, args: readonly string[]) {
      const endpoint = args.find((arg) => arg.startsWith("repos/"))!;
      if (args.includes("POST")) {
        posted.push(args.find((arg) => arg.startsWith("body="))!.slice(5));
        return JSON.stringify({ id: 100 + posted.length, created_at: "2026-01-01T00:00:00Z" });
      }
      if (endpoint.endsWith("/pulls/42")) return JSON.stringify([{ state: "open", head: { sha } }]);
      if (endpoint.includes("/check-runs?")) return JSON.stringify([{ check_runs: checks }]);
      if (endpoint.includes("/reviews?")) return JSON.stringify([reviews]);
      if (endpoint.includes("/issues/") && endpoint.includes("/comments?")) return JSON.stringify([comments]);
      if (endpoint.includes("/pulls/") && endpoint.includes("/comments?")) return "[[]]";
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    },
  };
  const options = { cwd: directory, itemUrl: "https://github.com/owner/repo/pull/42", bots, stateDirectory, runner };
  return { posted, options,
    setHead(value: string) { sha = value; },
    setReviews(value: unknown[]) { reviews = value; },
    setComments(value: unknown[]) { comments = value; },
    setChecks(value: unknown[]) { checks = value; },
  };
}

const submittedReview = { id: 10, user: { login: "cursor[bot]" }, body: "No actionable findings.", commit_id: headSha, state: "COMMENTED", submitted_at: "2026-01-01T00:01:00Z" };
const finishedCheck = { id: 11, name: "Cursor Bugbot", status: "completed", conclusion: "success", head_sha: headSha, started_at: "2026-01-01T00:00:01Z" };

test("recovery reuses its exact trigger while each substantive round posts a new comment", async () => {
  const f = githubFixture();
  const external = new GitHubExternalReviews(f.options);
  await external.begin(context);
  await new GitHubExternalReviews(f.options).begin(context);
  assert.deepEqual(f.posted, ["@cursor review"]);
  f.setChecks([finishedCheck]);
  assert.equal((await external.wait(context))[0]!.comments.length, 0);
  await external.begin({ ...context, round: 2 });
  assert.deepEqual(f.posted, ["@cursor review", "@cursor review"]);
});

test("changing the configured bot set cannot reuse a partially different round", async () => {
  const f = githubFixture();
  await new GitHubExternalReviews(f.options).begin(context);
  await assert.rejects(new GitHubExternalReviews({ ...f.options, bots: [] }).begin(context), /configuration changed/);
});

test("head changes and cancellation stop the external wait with persistent diagnostics", async () => {
  const f = githubFixture();
  const external = new GitHubExternalReviews(f.options);
  await external.begin(context);
  f.setHead("1234567890abcdef1234567890abcdef12345678");
  await assert.rejects(external.wait(context), /pinned head/);
  assert.match(readFileSync(join(f.options.stateDirectory, "crash-report.txt"), "utf8"), /pinned head/);
  f.setHead(headSha);
  const controller = new AbortController();
  const cancellable = new GitHubExternalReviews({ ...f.options, wait: async () => { controller.abort(); } });
  await assert.rejects(cancellable.wait(context, controller.signal), /abort/i);
});

test("submitted reviews must match author, head, and current round; acknowledgments never satisfy the default wait", async () => {
  const f = githubFixture([{ name: "Cursor", comment: "@cursor review", author: "cursor[bot]" }]);
  const external = new GitHubExternalReviews({ ...f.options, wait: async () => { throw new Error("still waiting"); } });
  f.setReviews([submittedReview]);
  await external.begin(context);
  f.setReviews([submittedReview, { ...submittedReview, id: 12, user: { login: "someone-else" } }, { ...submittedReview, id: 13, commit_id: "old-head" }, { ...submittedReview, id: 14, state: "PENDING", submitted_at: null }]);
  f.setComments([{ id: 20, user: { login: "cursor[bot]" }, body: "Review started", updated_at: "2026-01-01T00:00:01Z" }]);
  await assert.rejects(external.wait(context), /still waiting/);
  f.setReviews([{ ...submittedReview, id: 15 }]);
  assert.equal((await external.wait(context))[0]!.reviews[0]!.id, 15);
});

test("all configured bots must finish and edited completion comments can report a no-findings result", async () => {
  const f = githubFixture([bot, { name: "Other", comment: "@other review", author: "other[bot]", completionPattern: "^Review complete:" }]);
  const comment = { id: 20, user: { login: "other[bot]" }, body: "Review started", updated_at: "2025-12-31T23:00:00Z" };
  f.setComments([comment]);
  const external = new GitHubExternalReviews({ ...f.options, wait: async () => { throw new Error("still waiting"); } });
  await external.begin(context);
  assert.deepEqual(f.posted, ["@cursor review", "@other review"]);
  f.setChecks([finishedCheck]);
  await assert.rejects(external.wait(context), /still waiting/);
  f.setComments([{ ...comment, body: "Review complete: no issues", updated_at: "2026-01-01T00:01:00Z" }]);
  assert.deepEqual((await external.wait(context)).map((report) => report.bot), ["Cursor", "Other"]);
});

test("completion observed after an earlier comments read still returns the bot's published findings", async () => {
  const f = githubFixture();
  const external = new GitHubExternalReviews(f.options);
  await external.begin(context);
  f.setChecks([finishedCheck]);
  const runner = {
    async run(command: string, args: readonly string[], cwd: string) {
      const response = await f.options.runner.run(command, args);
      if (args.some((arg) => arg.includes("/check-runs?"))) {
        f.setComments([{ id: 30, user: { login: "cursor[bot]" }, body: "Published finding", created_at: "2026-01-01T00:01:00Z", updated_at: "2026-01-01T00:01:00Z" }]);
      }
      return response;
    },
  };
  const reports = await new GitHubExternalReviews({ ...f.options, runner }).wait(context);
  assert.equal(reports[0]!.comments[0]?.body, "Published finding");
});

test("a failed Panel seat cancels the external wait and preserves completed reports for publication", async () => {
  const f = githubFixture();
  const external = new GitHubExternalReviews(f.options);
  let tool!: ToolDefinition;
  const extension = createTicketPanelExtension(async ({ attribution }) => {
    if (attribution.seat === "seat-2") throw new Error("provider unavailable");
    return { markdown: "No actionable findings.", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  }, [
    { harness: "pi", provider: "openai", model: "one", reasoning: "low" },
    { harness: "pi", provider: "openai", model: "two", reasoning: "low" },
  ], undefined, external);
  const pi = { registerTool(value: ToolDefinition) { tool = value; } } as unknown as ExtensionAPI;
  if (typeof extension === "function") await extension(pi); else await extension.factory(pi);
  const result = await tool.execute("call", { kind: "review", context }, AbortSignal.timeout(500), undefined, {} as never);
  const details = result.details as { reports: unknown[]; failures: unknown[]; externalFailures: string[] };
  assert.equal(details.reports.length, 1);
  assert.equal(details.failures.length, 1);
  assert.match(details.externalFailures[0]!, /built-in Review Panel failed/);
});

test("invalid configuration is an error rather than silently disabling the requested wait", () => {
  const { repository, agent } = fixture();
  writeFileSync(join(agent, "automode-review.json"), JSON.stringify({ bots: [bot] }));
  writeFileSync(join(repository, ".pi", "automode-review.json"), JSON.stringify({ bots: [{ ...bot, comment: "" }] }));
  assert.throws(() => loadExternalReviewBots(repository, agent), /requires comment/);
});
