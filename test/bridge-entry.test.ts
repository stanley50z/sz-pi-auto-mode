import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import automodeBridgeEntry, { type AutomodeCommandModule } from "../src/bridge-entry.js";

test("normal Pi defers Automode implementation loading until /automode is invoked", async () => {
  let command: {
    name: string;
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  } | undefined;
  let loads = 0;
  const invocations: Array<{ args: string; ctx: ExtensionCommandContext }> = [];
  const pi = {
    registerCommand(name: string, options: {
      handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    }) {
      command = { name, handler: options.handler };
    },
  } as unknown as ExtensionAPI;
  const context = { mode: "tui" } as ExtensionCommandContext;
  const load = async (): Promise<AutomodeCommandModule> => {
    loads += 1;
    return {
      runAutomodeCommand: async (args, ctx) => {
        invocations.push({ args, ctx });
      },
    };
  };

  automodeBridgeEntry(pi, load);

  assert.equal(command?.name, "automode");
  assert.equal(loads, 0);
  await command?.handler("full", context);
  assert.equal(loads, 1);
  assert.deepEqual(invocations, [{ args: "full", ctx: context }]);
});
