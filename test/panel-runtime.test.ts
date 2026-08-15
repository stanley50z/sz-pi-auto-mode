import assert from "node:assert/strict";
import test from "node:test";
import {
  createProductionPanelSeatLauncher,
  runGrillingPanel,
  runReviewPanel,
  type GrillingSeatLaunchRequest,
  type PanelSeatLaunchRequest,
  type PanelSeatLauncher,
  type ProductionPanelProcessLauncher,
} from "../src/panel-runtime.js";

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

test("a grilling round launches exactly the three configured seats concurrently with one immutable context", async () => {
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
  }, launcher);

  await Promise.resolve();
  assert.equal(launches.length, 3);
  assert.deepEqual(launches.map(({ attribution }) => attribution), [
    {
      seat: "seat-1",
      harness: "pi",
      providerSlug: "openai-codex",
      modelSlug: "gpt-5.6-sol",
      reasoningLevel: "high",
    },
    {
      seat: "seat-2",
      harness: "pi",
      providerSlug: "kimi-coding",
      modelSlug: "k3",
      reasoningLevel: "high",
    },
    {
      seat: "seat-3",
      harness: "claude-code",
      providerSlug: "anthropic",
      modelSlug: "claude-fable-5",
      reasoningLevel: "high",
    },
  ]);
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
  }, launcher);

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
    }, launcher),
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
  }, launcher);

  assert.deepEqual(result.answers.map(({ attribution }) => attribution.seat), ["seat-3"]);
  assert.deepEqual(result.failures.map(({ attribution, error }) => [attribution.seat, error]), [
    ["seat-1", "harness unavailable"],
    ["seat-2", "Panel answer must cover every question exactly once"],
  ]);
});

test("grilling fails only after all three seats fail and never retries or substitutes", async () => {
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
    }, launcher),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.match((error as Error).message, /all three.*failed/i);
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

test("review launches all three seats concurrently on one immutable exact-head context and returns exact attribution", async () => {
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
      pullRequestBody: "Closes #40",
      linkedIssueOrSpecification: "Issue #40 and specification #21",
      repositoryGuidance: ["AGENTS.md: follow TDD"],
      mergeBaseDiff: "diff --git a/src/a.ts b/src/a.ts",
      commits: ["abc123 Implement runtime"],
      validationEvidence: ["npm test passed"],
    },
  }, launcher);

  await Promise.resolve();
  assert.equal(launches.length, 3);
  assert.equal(launches.every(({ kind }) => kind === "review"), true);
  assert.equal(launches[0]!.context, launches[1]!.context);
  assert.equal(launches[1]!.context, launches[2]!.context);
  assert.equal(Object.isFrozen(launches[0]!.context), true);
  assert.equal(launches.every((launch) => launch.prompt === launches[0]!.prompt), true);

  completions.forEach((complete) => complete({ outcome: "no-actionable-findings", findings: [] }));
  const result = await running;
  assert.deepEqual(result.reports, [
    {
      round: 1,
      headSha: "0123456789abcdef",
      seat: "seat-1",
      harness: "pi",
      providerSlug: "openai-codex",
      modelSlug: "gpt-5.6-sol",
      reasoningLevel: "high",
      outcome: "no-actionable-findings",
      findings: [],
    },
    {
      round: 1,
      headSha: "0123456789abcdef",
      seat: "seat-2",
      harness: "pi",
      providerSlug: "kimi-coding",
      modelSlug: "k3",
      reasoningLevel: "high",
      outcome: "no-actionable-findings",
      findings: [],
    },
    {
      round: 1,
      headSha: "0123456789abcdef",
      seat: "seat-3",
      harness: "claude-code",
      providerSlug: "anthropic",
      modelSlug: "claude-fable-5",
      reasoningLevel: "high",
      outcome: "no-actionable-findings",
      findings: [],
    },
  ]);
});

test("review fails after every seat terminates unless all three reports are usable", async () => {
  const calls: string[] = [];
  const launcher: PanelSeatLauncher = async ({ attribution }) => {
    calls.push(attribution.seat);
    if (attribution.seat === "seat-2") {
      return {
        outcome: "findings",
        findings: [{ rootCause: "missing evidence", violatedRequirement: "Spec #21", evidence: "" }],
      };
    }
    return {
      outcome: "findings",
      findings: [{
        rootCause: "The parser accepts an incomplete report",
        violatedRequirement: "Every finding requires concrete evidence",
        evidence: "src/parser.ts:42 accepts an empty evidence field",
      }],
    };
  };

  await assert.rejects(
    () => runReviewPanel({
      context: {
        round: 2,
        headSha: "fedcba9876543210",
        pullRequestBody: "Closes #40",
        linkedIssueOrSpecification: "Specification #21",
        repositoryGuidance: ["AGENTS.md"],
        mergeBaseDiff: "diff --git a/src/parser.ts b/src/parser.ts",
        commits: ["def456 Fix parser"],
        validationEvidence: ["focused tests pass"],
        priorFindings: ["Parser accepted incomplete reports"],
        reviewSessionDispositions: ["Valid and in scope"],
        fixDiff: "diff --git a/src/parser.ts b/src/parser.ts",
      },
    }, launcher),
    (error: unknown) => {
      const failure = error as Error & {
        failures: Array<{ attribution: { seat: string }; error: string }>;
        successfulResults: unknown[];
      };
      assert.match(failure.message, /all three configured seats/i);
      assert.deepEqual(failure.failures.map(({ attribution }) => attribution.seat), ["seat-2"]);
      assert.match(failure.failures[0]!.error, /requires a root cause, violated requirement, and evidence/);
      assert.equal(failure.successfulResults.length, 2);
      return true;
    },
  );
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
