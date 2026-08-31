import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubReviewDispositionPublisher,
  type ReviewDispositionCommandRunner,
} from "../src/review-disposition.js";

const usage = {
  input: 1_200,
  output: 300,
  cacheRead: 800,
  cacheWrite: 50,
  totalTokens: 2_350,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.45678 },
};

test("the final Auto-Review disposition reports exact whole-session usage after the review settles", async () => {
  const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
  const runner: ReviewDispositionCommandRunner = {
    async run(command, args, cwd) {
      calls.push({ command, args, cwd });
    },
  };
  const publisher = new GitHubReviewDispositionPublisher({
    cwd: "C:/repository",
    runner,
  });

  await publisher.publish(
    "https://github.com/owner/repository/pull/42",
    "## Automode final validation\n\nValidated exact head `abcdef1`.",
    usage,
  );

  assert.deepEqual(calls, [{
    command: "gh",
    cwd: "C:/repository",
    args: [
      "api",
      "--method", "POST",
      "repos/owner/repository/issues/42/comments",
      "-f",
      "body=## Automode final validation\n\nValidated exact head `abcdef1`.\n\n### Automode usage\n\nReview Session plus all Reviewer sessions in every round. Input: 2,050 tokens; output: 300 tokens; cached input: 800 tokens; calculated cost: $0.4568.",
    ],
  }]);
});

test("the final disposition publisher rejects a non-pull-request URL without tracker mutation", async () => {
  let calls = 0;
  const publisher = new GitHubReviewDispositionPublisher({
    cwd: "C:/repository",
    runner: { async run() { calls += 1; } },
  });

  await assert.rejects(
    () => publisher.publish("https://github.com/owner/repository/issues/42", "Disposition", usage),
    /pull-request URL/,
  );
  assert.equal(calls, 0);
});
