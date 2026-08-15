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

test("the controlled panel tool returns a complete three-seat grilling result", async () => {
  const launcher: PanelSeatLauncher = async () => answer();
  let tool: ToolDefinition | undefined;
  const pi = { registerTool(value: ToolDefinition) { tool = value; } } as unknown as ExtensionAPI;
  const extension = createTicketPanelExtension(launcher);
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
  assert.equal((result.details as { answers: unknown[] }).answers.length, 3);
});
