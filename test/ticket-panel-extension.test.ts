import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createTicketPanelExtension } from "../src/ticket-panel-extension.js";
import type { PanelSeatLauncher } from "../src/panel-runtime.js";

function answer() {
  return {
    answers: [{
      questionNumber: 1,
      proposedAnswer: "Proceed",
      rationale: "Meets the requirement.",
      materialTradeoffs: "None material.",
      assumptionsOrUncertainties: "None.",
      sources: [],
    }],
  };
}

test("the controlled panel tool returns a result from every configured grilling seat", async () => {
  const launcher: PanelSeatLauncher = async () => answer();
  let tool: ToolDefinition | undefined;
  const pi = { registerTool(value: ToolDefinition) { tool = value; } } as unknown as ExtensionAPI;
  const extension = createTicketPanelExtension(launcher, [{
    harness: "pi",
    provider: "github-copilot",
    model: "claude-fable-5",
    reasoning: "high",
  }]);
  if (typeof extension === "function") await extension(pi);
  else await extension.factory(pi);

  const result = await tool!.execute("call", {
    kind: "grilling",
    context: {
      userPrompts: ["Decide."],
      priorRounds: [],
      priorFinalAnswers: [],
      round: { number: 1, questions: [{ number: 1, question: "Proceed?" }] },
    },
  }, undefined, undefined, {} as never);

  assert.equal(tool!.name, "automode_panel");
  assert.equal((result.details as { answers: unknown[] }).answers.length, 1);
});

test("the controlled panel tool exposes each failed review seat diagnostic", async () => {
  const launcher: PanelSeatLauncher = async () => ({
    outcome: "findings",
    findings: [{ rootCause: "Missing evidence" }],
  });
  let tool: ToolDefinition | undefined;
  const pi = { registerTool(value: ToolDefinition) { tool = value; } } as unknown as ExtensionAPI;
  const extension = createTicketPanelExtension(launcher, [{
    harness: "pi",
    provider: "github-copilot",
    model: "claude-fable-5",
    reasoning: "high",
  }]);
  if (typeof extension === "function") await extension(pi);
  else await extension.factory(pi);

  await assert.rejects(
    tool!.execute("call", {
      kind: "review",
      context: {
        round: 1,
        headSha: "abcdef1234567890",
        pullRequestBody: "Implements the requested behavior.",
        linkedIssueOrSpecification: "The linked issue specifies the behavior.",
        repositoryGuidance: ["Follow repository standards."],
        mergeBaseDiff: "diff --git a/src/app.ts b/src/app.ts",
        commits: ["abcdef1 Implement behavior"],
        validationEvidence: ["npm test passed"],
      },
    }, undefined, undefined, {} as never),
    /usable reports from every configured seat.*seat-1.*root cause, violated requirement, and evidence/is,
  );
});
