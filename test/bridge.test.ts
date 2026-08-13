import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import automodeBridge, { type AutomodeBridgeDependencies } from "../src/bridge.js";
import { AUTOMATION_STAGES } from "../src/stage-configuration.js";

test("the bridge registers /automode and cancellation has no launch side effects", async () => {
  let command: { name: string; handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
  let launches = 0;
  const pi = {
    registerFlag() {},
    getFlag() { return false; },
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      command = { name, handler: options.handler };
    },
  } as unknown as ExtensionAPI;
  const dependencies: AutomodeBridgeDependencies = {
    selectConfiguration: async () => null,
    launch: async () => { launches += 1; throw new Error("must not launch"); },
    launchProof: false,
  };

  automodeBridge(pi, dependencies);
  assert.equal(command?.name, "automode");
  await command!.handler("", { cwd: "C:/repo", mode: "tui", waitForIdle: async () => {}, ui: { notify() {} } });
  assert.equal(launches, 0);
});

test("a confirmed configuration is serialized before terminal handoff", async () => {
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const launches: Array<{ cwd: string; serializedConfiguration: string }> = [];
  const pi = {
    registerFlag() {},
    getFlag() { return false; },
    registerCommand(_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      handler = options.handler;
    },
  } as unknown as ExtensionAPI;
  automodeBridge(pi, {
    selectConfiguration: async () => ({ mode: "full", stages: AUTOMATION_STAGES }),
    launch: async (request) => { launches.push(request); throw new Error("handoff test stop"); },
    launchProof: false,
  });

  await assert.rejects(
    () => handler!("", { cwd: "C:/repo", mode: "tui", waitForIdle: async () => {}, ui: { notify() {} } }),
    /handoff test stop/,
  );
  assert.deepEqual(launches, [{
    cwd: "C:/repo",
    serializedConfiguration: '{"mode":"full","stages":["auto-triage","auto-grilling","auto-implement","auto-review"]}',
    launchProof: false,
  }]);
});
