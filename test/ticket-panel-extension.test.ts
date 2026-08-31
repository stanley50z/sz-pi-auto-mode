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

test("the controlled panel tool streams attributed nested-session activity", async () => {
  const nested: unknown[] = [];
  const launcher: PanelSeatLauncher = async (request) => {
    request.onActivity?.({ kind: "thinking", message: "Inspecting the diff" });
    return "No actionable findings.";
  };
  let tool: ToolDefinition | undefined;
  const pi = { registerTool(value: ToolDefinition) { tool = value; } } as unknown as ExtensionAPI;
  const extension = createTicketPanelExtension(launcher, [{
    harness: "pi",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoning: "high",
  }], (activity) => nested.push(activity));
  if (typeof extension === "function") await extension(pi);
  else await extension.factory(pi);

  await tool!.execute("panel-call-1", {
    kind: "review",
    context: {
      round: 1,
      headSha: "abcdef1234567890",
      brief: "Review the exact diff.",
    },
  }, undefined, undefined, {} as never);

  assert.equal(nested.length, 3);
  assert.deepEqual(nested.map((entry) => ({
    toolCallId: (entry as { toolCallId: string }).toolCallId,
    toolName: (entry as { toolName: string }).toolName,
    type: (entry as { child: { type: string } }).child.type,
  })), [
    { toolCallId: "panel-call-1", toolName: "automode_panel", type: "started" },
    { toolCallId: "panel-call-1", toolName: "automode_panel", type: "activity" },
    { toolCallId: "panel-call-1", toolName: "automode_panel", type: "settled" },
  ]);
});

test("the controlled panel tool returns completed reviews with failed-seat diagnostics", async () => {
  const launcher: PanelSeatLauncher = async ({ attribution }) => {
    if (attribution.seat === "seat-2") throw new Error("provider unavailable");
    return "**[P1] Validate the path**\n\n`src/app.ts:42` accepts traversal.";
  };
  let tool: ToolDefinition | undefined;
  const pi = { registerTool(value: ToolDefinition) { tool = value; } } as unknown as ExtensionAPI;
  const extension = createTicketPanelExtension(launcher, [
    {
      harness: "pi",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoning: "high",
    },
    {
      harness: "pi",
      provider: "github-copilot",
      model: "claude-fable-5",
      reasoning: "high",
    },
  ]);
  if (typeof extension === "function") await extension(pi);
  else await extension.factory(pi);

  const result = await tool!.execute("call", {
    kind: "review",
    context: {
      round: 1,
      headSha: "abcdef1234567890",
      brief: "Review the implementation against its linked issue and repository standards. Inspect the exact diff and validation evidence.",
    },
  }, undefined, undefined, {} as never);

  const details = result.details as {
    reports: Array<{ seat: string; markdown: string }>;
    failures: Array<{ attribution: { seat: string }; error: string }>;
  };
  assert.deepEqual(details.reports.map(({ seat, markdown }) => [seat, markdown]), [[
    "seat-1",
    "**[P1] Validate the path**\n\n`src/app.ts:42` accepts traversal.",
  ]]);
  assert.deepEqual(details.failures.map(({ attribution, error }) => [attribution.seat, error]), [[
    "seat-2",
    "provider unavailable",
  ]]);
});
