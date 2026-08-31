import assert from "node:assert/strict";
import test from "node:test";
import {
  createPanelSeats,
  createProductionPanelSeatLauncher,
  runGrillingPanel,
  runReviewPanel,
  type GrillingSeatLaunchRequest,
  type PanelSeatLaunchRequest,
  type PanelSeatLauncher,
  type ProductionPanelProcessLauncher,
} from "../src/panel-runtime.js";

const panelExecutions = [
  { harness: "pi", provider: "anthropic", model: "claude-opus-4-8", reasoning: "high" },
  { harness: "pi", provider: "github-copilot", model: "claude-fable-5", reasoning: "high" },
  { harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "high" },
] as const;
const panelSeats = createPanelSeats(panelExecutions);

function assertGrillingLaunch(request: PanelSeatLaunchRequest): asserts request is GrillingSeatLaunchRequest {
  assert.equal(request.kind, "grilling");
}

function usableGrillingAnswer(proposedAnswer: string) {
  return {
    answers: [{
      questionNumber: 1,
      proposedAnswer,
      rationale: "It satisfies the stated constraint.",
      materialTradeoffs: "It favors simplicity over flexibility.",
      assumptionsOrUncertainties: "No material uncertainty.",
      sources: [],
    }],
  };
}

function reviewResult(markdown: string) {
  return {
    markdown,
    usage: {
      input: 1_000,
      output: 100,
      cacheRead: 800,
      cacheWrite: 0,
      totalTokens: 1_900,
      cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
    },
  };
}

test("panel attribution supports any positive configured seat count", () => {
  assert.deepEqual(createPanelSeats([{
    harness: "pi",
    provider: "anthropic",
    model: "claude-opus-4-8",
    reasoning: "high",
  }]).map(({ seat }) => seat), ["seat-1"]);
  assert.deepEqual(createPanelSeats([...panelExecutions, {
    harness: "pi",
    provider: "openai-codex",
    model: "gpt-5.6-terra",
    reasoning: "high",
  }]).map(({ seat }) => seat), ["seat-1", "seat-2", "seat-3", "seat-4"]);
  assert.throws(() => createPanelSeats([]), /at least one configured seat/);
});

test("a grilling round launches every configured seat concurrently with one immutable context", async () => {
  const launches: PanelSeatLaunchRequest[] = [];
  const completions: Array<(value: unknown) => void> = [];
  const launcher: PanelSeatLauncher = (request) => {
    launches.push(request);
    return new Promise((resolve) => completions.push(resolve));
  };

  const running = runGrillingPanel({
    context: {
      userPrompts: ["Prefer the smallest safe MVP."],
      priorRounds: [],
      priorFinalAnswers: [],
      round: {
        number: 1,
        questions: [{
          number: 1,
          question: "Which option should the MVP use?",
          options: ["A", "B"],
          recommendation: "A",
        }],
      },
    },
  }, launcher, panelSeats);

  await Promise.resolve();
  assert.equal(launches.length, 3);
  assert.deepEqual(launches.map(({ attribution }) => attribution), panelSeats);
  assert.equal(launches[0]!.context, launches[1]!.context);
  assert.equal(launches[1]!.context, launches[2]!.context);
  assert.equal(Object.isFrozen(launches[0]!.context), true);
  assertGrillingLaunch(launches[0]!);
  assert.equal(Object.isFrozen(launches[0]!.context.round.questions), true);

  completions.forEach((complete, index) => complete(usableGrillingAnswer(`answer-${index + 1}`)));
  const result = await running;
  assert.equal(result.answers.length, 3);
});

test("grilling seats receive verbatim questions without recommendations, peers, or mutation and nested-dispatch tools", async () => {
  const launches: PanelSeatLaunchRequest[] = [];
  const launcher: PanelSeatLauncher = async (request) => {
    launches.push(request);
    return usableGrillingAnswer("B");
  };

  await runGrillingPanel({
    context: {
      userPrompts: ["Keep this prompt unchanged."],
      priorRounds: [],
      priorFinalAnswers: [],
      round: {
        number: 4,
        questions: [{
          number: 1,
          question: "Choose A or B — exactly as written?",
          options: ["A — faster", "B — safer"],
          recommendation: "Choose A.",
        }],
      },
    },
  }, launcher, panelSeats);

  const first = launches[0]!;
  assertGrillingLaunch(first);
  assert.equal(first.context.round.questions[0]!.question, "Choose A or B — exactly as written?");
  assert.deepEqual(first.context.round.questions[0]!.options, ["A — faster", "B — safer"]);
  assert.equal("recommendation" in first.context.round.questions[0]!, false);
  assert.doesNotMatch(first.prompt, /Choose A\.|peer|panel member|other reviewer/i);
  assert.match(first.prompt, /answer every question/i);
  assert.deepEqual(first.tools, ["read", "grep", "find", "ls"]);
  assert.equal(first.tools.some((tool) => /dispatch|subagent|tracker|github|merge/i.test(tool)), false);
});

test("grilling rejects incomplete prior-round context before launching a seat", async () => {
  let launches = 0;
  const launcher: PanelSeatLauncher = async () => {
    launches += 1;
    return usableGrillingAnswer("unused");
  };

  await assert.rejects(
    () => runGrillingPanel({
      context: {
        userPrompts: ["Initial direction", "Follow-up direction"],
        priorRounds: [{ number: 1, questions: [{ number: 1, question: "Earlier question?" }] }],
        priorFinalAnswers: [],
        round: { number: 2, questions: [{ number: 1, question: "Current question?" }] },
      },
    }, launcher, panelSeats),
    /complete final answers for every prior round/,
  );
  assert.equal(launches, 0);
});

test("grilling validates every question and continues with one success while recording all member failures", async () => {
  const launcher: PanelSeatLauncher = async ({ attribution }) => {
    if (attribution.seat === "seat-1") throw new Error("harness unavailable");
    if (attribution.seat === "seat-2") return usableGrillingAnswer("only question one");
    return {
      answers: [
        usableGrillingAnswer("answer one").answers[0],
        {
          questionNumber: 2,
          proposedAnswer: "answer two",
          rationale: "It covers question two.",
          materialTradeoffs: "A bounded trade-off.",
          assumptionsOrUncertainties: "None.",
          sources: ["https://example.test/source"],
        },
      ],
    };
  };

  const result = await runGrillingPanel({
    context: {
      userPrompts: ["Answer both."],
      priorRounds: [],
      priorFinalAnswers: [],
      round: {
        number: 2,
        questions: [
          { number: 1, question: "First?" },
          { number: 2, question: "Second?" },
        ],
      },
    },
  }, launcher, panelSeats);

  assert.deepEqual(result.answers.map(({ attribution }) => attribution.seat), ["seat-3"]);
  assert.deepEqual(result.failures.map(({ attribution, error }) => [attribution.seat, error]), [
    ["seat-1", "harness unavailable"],
    ["seat-2", "Panel answer must cover every question exactly once"],
  ]);
});

test("grilling fails only after every configured seat fails and never retries or substitutes", async () => {
  const calls: string[] = [];
  const launcher: PanelSeatLauncher = async ({ attribution }) => {
    calls.push(attribution.seat);
    throw new Error(`${attribution.seat} unavailable`);
  };

  await assert.rejects(
    () => runGrillingPanel({
      context: {
        userPrompts: ["Decide."],
        priorRounds: [],
        priorFinalAnswers: [],
        round: { number: 1, questions: [{ number: 1, question: "Proceed?" }] },
      },
    }, launcher, panelSeats),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.match((error as Error).message, /every configured seat failed/i);
      assert.deepEqual(
        (error as Error & { failures: Array<{ attribution: { seat: string } }> }).failures
          .map(({ attribution }) => attribution.seat),
        ["seat-1", "seat-2", "seat-3"],
      );
      return true;
    },
  );
  assert.deepEqual(calls, ["seat-1", "seat-2", "seat-3"]);
});

test("review launches every configured seat concurrently on one immutable exact-head context and returns exact attribution", async () => {
  const launches: PanelSeatLaunchRequest[] = [];
  const completions: Array<(value: unknown) => void> = [];
  const launcher: PanelSeatLauncher = (request) => {
    launches.push(request);
    return new Promise((resolve) => completions.push(resolve));
  };

  const running = runReviewPanel({
    context: {
      round: 1,
      headSha: "0123456789abcdef",
      brief: "Review PR #40 against specification #21 and AGENTS.md. Inspect the merge-base diff and recorded validation evidence.",
    },
  }, launcher, panelSeats);

  await Promise.resolve();
  assert.equal(launches.length, 3);
  assert.equal(launches.every(({ kind }) => kind === "review"), true);
  assert.equal(launches[0]!.context, launches[1]!.context);
  assert.equal(launches[1]!.context, launches[2]!.context);
  assert.equal(Object.isFrozen(launches[0]!.context), true);
  assert.equal(launches.every((launch) => launch.prompt === launches[0]!.prompt), true);
  const prompt = launches[0]!.prompt;
  assert.match(prompt, /## Review round\n\n1/);
  assert.match(prompt, /## Pinned head\n\n0123456789abcdef/);
  assert.match(prompt, /## Review brief\n\nReview PR #40 against specification #21 and AGENTS\.md\./);
  assert.match(prompt, /## Expected report/);
  assert.match(prompt, /## Limits/);
  assert.doesNotMatch(prompt, /\{"round"|"headSha"|"brief"/);

  completions.forEach((complete, index) => complete({
    markdown: index === 0
      ? "No actionable findings."
      : `**[P1] Fix the parser**\n\n\`src/parser.ts:42\` accepts incomplete input.`,
    usage: {
      input: 1_000 + index,
      output: 100 + index,
      cacheRead: 800 + index,
      cacheWrite: 0,
      totalTokens: 1_900 + (index * 3),
      cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
    },
  }));
  const result = await running;
  assert.deepEqual(result.reports, panelSeats.map((seat, index) => ({
    round: 1,
    headSha: "0123456789abcdef",
    ...seat,
    markdown: index === 0
      ? "No actionable findings."
      : "**[P1] Fix the parser**\n\n`src/parser.ts:42` accepts incomplete input.",
    usage: {
      input: 1_000 + index,
      output: 100 + index,
      cacheRead: 800 + index,
      cacheWrite: 0,
      totalTokens: 1_900 + (index * 3),
      cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
    },
    usageSummary: `Input: ${(1_800 + (index * 2)).toLocaleString("en-US")} tokens; output: ${100 + index} tokens; cached input: ${800 + index} tokens; calculated cost: $0.0310.`,
  })));
  assert.deepEqual(result.failures, []);
});

test("review streams each panel seat prompt and transcript activity", async () => {
  const activity: unknown[] = [];
  const seat = createPanelSeats([panelExecutions[0]!]);
  const launcher: PanelSeatLauncher = async (request) => {
    request.onActivity?.({
      kind: "thinking",
      message: "Inspecting the exact diff",
    });
    request.onActivity?.({
      kind: "tools",
      message: "+ 3 tool calls",
      toolCount: 3,
    });
    return reviewResult("No actionable findings.");
  };

  await runReviewPanel({
    context: {
      round: 1,
      headSha: "0123456789abcdef",
      brief: "Review the exact pull-request head against its work contract.",
    },
  }, launcher, seat, (event) => activity.push(event));

  assert.deepEqual(activity, [
    {
      type: "started",
      id: "seat-1",
      source: "panel",
      label: "seat-1 · claude-opus-4-8",
      harness: "pi",
      provider: "anthropic",
      model: "claude-opus-4-8",
      reasoning: "high",
      headSha: "0123456789abcdef",
      initialPrompt: activity.length > 0
        ? (activity[0] as { initialPrompt: string }).initialPrompt
        : "",
    },
    {
      type: "activity",
      id: "seat-1",
      source: "panel",
      label: "seat-1 · claude-opus-4-8",
      harness: "pi",
      provider: "anthropic",
      model: "claude-opus-4-8",
      reasoning: "high",
      headSha: "0123456789abcdef",
      activity: { kind: "thinking", message: "Inspecting the exact diff" },
    },
    {
      type: "activity",
      id: "seat-1",
      source: "panel",
      label: "seat-1 · claude-opus-4-8",
      harness: "pi",
      provider: "anthropic",
      model: "claude-opus-4-8",
      reasoning: "high",
      headSha: "0123456789abcdef",
      activity: { kind: "tools", message: "+ 3 tool calls", toolCount: 3 },
    },
    {
      type: "settled",
      id: "seat-1",
      source: "panel",
      label: "seat-1 · claude-opus-4-8",
      harness: "pi",
      provider: "anthropic",
      model: "claude-opus-4-8",
      reasoning: "high",
      headSha: "0123456789abcdef",
      status: "completed",
    },
  ]);
  assert.match((activity[0] as { initialPrompt: string }).initialPrompt, /0123456789abcdef/);
  assert.match((activity[0] as { initialPrompt: string }).initialPrompt, /Review the exact pull-request head/);
});

test("review returns every completed report alongside failed-seat diagnostics", async () => {
  const calls: string[] = [];
  const launcher: PanelSeatLauncher = async ({ attribution }) => {
    calls.push(attribution.seat);
    if (attribution.seat === "seat-2") throw new Error("provider connection closed");
    return reviewResult("**[P1] Fix the parser**\n\n`src/parser.ts:42` accepts incomplete input.");
  };

  const result = await runReviewPanel({
    context: {
      round: 2,
      headSha: "fedcba9876543210",
      brief: "Re-review the parser fix against specification #21. Prior finding: incomplete reports were accepted. The Review Session marked it valid and in scope; inspect the fix diff and focused test evidence.",
    },
  }, launcher, panelSeats);

  assert.deepEqual(result.reports.map(({ seat, markdown }) => [seat, markdown]), [
    ["seat-1", "**[P1] Fix the parser**\n\n`src/parser.ts:42` accepts incomplete input."],
    ["seat-3", "**[P1] Fix the parser**\n\n`src/parser.ts:42` accepts incomplete input."],
  ]);
  assert.deepEqual(result.failures.map(({ attribution, error }) => [attribution.seat, error]), [
    ["seat-2", "provider connection closed"],
  ]);
  assert.deepEqual(calls, ["seat-1", "seat-2", "seat-3"]);
});

test("the production adapter delegates to a process launcher and fails closed on unavailable or invalid harness output", async () => {
  assert.throws(
    () => createProductionPanelSeatLauncher(),
    /production Panel process launcher is unavailable/,
  );

  const processRequests: PanelSeatLaunchRequest[] = [];
  const processLauncher: ProductionPanelProcessLauncher = {
    async launch(request) {
      processRequests.push(request);
      return {
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify(usableGrillingAnswer("process answer")),
        stderr: "",
      };
    },
  };
  const seatLauncher = createProductionPanelSeatLauncher(processLauncher);
  const request: PanelSeatLaunchRequest = {
    kind: "grilling",
    attribution: {
      seat: "seat-1",
      harness: "pi",
      providerSlug: "openai-codex",
      modelSlug: "gpt-5.6-sol",
      reasoningLevel: "high",
    },
    context: {
      userPrompts: ["Decide."],
      priorRounds: [],
      priorFinalAnswers: [],
      round: { number: 1, questions: [{ number: 1, question: "Proceed?" }] },
    },
    prompt: "structured prompt",
    tools: ["read"],
  };

  assert.deepEqual(await seatLauncher(request), usableGrillingAnswer("process answer"));
  assert.deepEqual(processRequests, [request]);

  const failed = createProductionPanelSeatLauncher({
    async launch() {
      return { exitCode: 127, signal: null, stdout: "", stderr: "harness not found" };
    },
  });
  await assert.rejects(() => failed(request), /exited with code 127.*harness not found/);

  const malformed = createProductionPanelSeatLauncher({
    async launch() {
      return { exitCode: 0, signal: null, stdout: "not json", stderr: "" };
    },
  });
  await assert.rejects(() => malformed(request), /invalid structured output/);
});
