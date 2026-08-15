import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createTicketSessionResultExtension } from "../src/ticket-session-result.js";

test("the controlled result tool records one explicit terminal status and rejects duplicates", async () => {
  let tool: ToolDefinition | undefined;
  const pi = {
    registerTool(definition: ToolDefinition) {
      tool = definition;
    },
  } as unknown as ExtensionAPI;
  const result = createTicketSessionResultExtension();
  if (typeof result.extension === "function") await result.extension(pi);
  else await result.extension.factory(pi);
  assert.equal(tool?.name, "automode_ticket_result");

  const first = await tool!.execute(
    "call-1",
    { status: "waiting", summary: "Prototype published; waiting for external feedback." },
    undefined,
    undefined,
    {} as never,
  );
  assert.equal(first.terminate, true);
  assert.deepEqual(result.read(), {
    status: "waiting",
    summary: "Prototype published; waiting for external feedback.",
  });
  await assert.rejects(
    () => tool!.execute(
      "call-2",
      { status: "complete", summary: "duplicate" },
      undefined,
      undefined,
      {} as never,
    ),
    /already reported/,
  );
});
