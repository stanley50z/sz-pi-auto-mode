import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import automodeBridge, {
  selectAutomationStageConfiguration,
  type AutomodeBridgeDependencies,
} from "../src/bridge.js";
import { AUTOMATION_STAGES } from "../src/stage-configuration.js";

type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

function bridgeHarness() {
  let command: { name: string; handler: CommandHandler } | undefined;
  const pi = {
    registerFlag() {},
    getFlag() { return false; },
    registerCommand(name: string, options: { handler: CommandHandler }) {
      command = { name, handler: options.handler };
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    command: () => {
      assert.ok(command);
      return command;
    },
  };
}

function commandContext(cwd: string) {
  return {
    cwd,
    mode: "tui",
    model: { provider: "anthropic", id: "claude-opus-4-8" },
    waitForIdle: async () => {},
    ui: { notify() {} },
  };
}

test("the bridge registers /automode and cancellation has no launch side effects", async () => {
  const harness = bridgeHarness();
  let launches = 0;
  const dependencies: AutomodeBridgeDependencies = {
    selectConfiguration: async () => null,
    launch: async () => { launches += 1; throw new Error("must not launch"); },
  };

  automodeBridge(harness.pi, dependencies);
  assert.equal(harness.command().name, "automode");
  await harness.command().handler("", commandContext("C:/repo"));
  assert.equal(launches, 0);
});

test("dismissing the selector is a clean cancellation", async () => {
  const result = await selectAutomationStageConfiguration({
    mode: "tui",
    ui: { custom: async () => undefined },
  } as never);

  assert.equal(result, null);
});

test("a confirmed configuration is serialized and launches from the repository root", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-bridge-"));
  const repository = join(fixture, "repository");
  const nestedDirectory = join(repository, "src", "feature");
  mkdirSync(join(repository, ".git"), { recursive: true });
  mkdirSync(nestedDirectory, { recursive: true });
  const harness = bridgeHarness();
  const launches: Array<{
    cwd: string;
    serializedConfiguration: string;
    defaultReviewerExecution: {
      harness: "pi";
      provider: string;
      model: string;
      reasoning: "high";
    };
  }> = [];
  automodeBridge(harness.pi, {
    selectConfiguration: async () => ({ mode: "full", stages: AUTOMATION_STAGES }),
    launch: async (request) => { launches.push(request); throw new Error("handoff test stop"); },
  });

  await assert.rejects(
    () => harness.command().handler("", commandContext(nestedDirectory)),
    /handoff test stop/,
  );
  assert.deepEqual(launches, [{
    cwd: repository,
    serializedConfiguration: '{"mode":"full","stages":["auto-triage","auto-grilling","auto-implement","auto-review"]}',
    defaultReviewerExecution: {
      harness: "pi",
      provider: "anthropic",
      model: "claude-opus-4-8",
      reasoning: "high",
    },
  }]);
});
