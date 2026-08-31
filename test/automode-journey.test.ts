import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import automodeBridge from "../src/bridge.js";
import { startAutomodeMainSession } from "../src/automode-main.js";
import {
  AutomodeCoordinator,
  type BookkeepingRecord,
  type CoordinatorClock,
  type CoordinatorTracker,
  type TicketSessionHost,
  type TicketWorkspaceManager,
  type WorkflowItem,
} from "../src/coordinator.js";
import {
  AUTOMATION_STAGES,
  confirmSerializedAutomationStageConfiguration,
  createAutomationStageConfiguration,
} from "../src/stage-configuration.js";

class JourneyClock implements CoordinatorClock {
  callback: (() => void | Promise<void>) | undefined;
  now() { return new Date("2026-02-03T04:05:06.000Z"); }
  every(_milliseconds: number, callback: () => void | Promise<void>) {
    this.callback = callback;
    return { dispose: () => { this.callback = undefined; } };
  }
}

test("a deterministic /automode journey advances triage, grilling, implementation, and review to merge", async () => {
  const items: WorkflowItem[] = [
    {
      kind: "issue", number: 60, url: "https://github.com/o/r/issues/60", state: "open",
      labels: ["needs-triage"], assignees: [], blockedBy: 0,
      updatedAt: "2026-01-01T00:00:00Z", materialVersion: "60-triage",
    },
    {
      kind: "issue", number: 61, url: "https://github.com/o/r/issues/61", state: "open",
      labels: ["wayfinder:grilling"], assignees: [], blockedBy: 0,
      updatedAt: "2026-01-01T00:00:00Z", materialVersion: "61-grilling",
    },
  ];
  const records = new Map<string, BookkeepingRecord>();
  const tracker: CoordinatorTracker = {
    async listBookkeeping() { return [...records.values()]; },
    async snapshot() {
      return {
        revision: items.map((item) => item.materialVersion).join("|"),
        items: structuredClone(items),
      };
    },
    async read(reference) {
      return structuredClone(items.find((item) => item.kind === reference.kind && item.number === reference.number)!);
    },
    async claim(reference, actor) {
      items.find((item) => item.number === reference.number)!.assignees = [actor];
    },
    async upsertBookkeeping(record) { records.set(`${record.item.kind}:${record.item.number}`, record); },
  };
  const dispatched: string[] = [];
  const sessions: TicketSessionHost = {
    async start(request) {
      dispatched.push(`${request.skillName}#${request.item.number}`);
      const item = items.find((candidate) => candidate.kind === request.item.kind && candidate.number === request.item.number)!;
      if (request.skillName === "triage") {
        item.labels = ["enhancement", "ready-for-agent"];
        item.assignees = [];
        item.materialVersion = "60-ready";
      } else if (request.skillName === "grilling") {
        item.state = "closed";
        item.assignees = [];
        item.materialVersion = "61-resolved";
      } else if (request.skillName === "implement") {
        item.outputPullRequest = "https://github.com/o/r/pull/70";
        item.materialVersion = "60-delivered";
        items.push({
          kind: "pull-request", number: 70, url: "https://github.com/o/r/pull/70", state: "open",
          labels: [], assignees: [], blockedBy: 0, draft: false,
          headSha: "0123456789abcdef0123456789abcdef01234567",
          headBranch: "automode/issue-60", headRepository: "o/r",
          updatedAt: "2026-01-01T00:01:00Z", materialVersion: "70-review",
        });
      } else {
        item.state = "closed";
        item.merged = true;
        item.materialVersion = "70-merged";
      }
      return {
        processId: `process-${request.item.number}`,
        sessionId: `session-${request.item.number}`,
        sessionFile: `/sessions/${request.item.number}.jsonl`,
        completion: Promise.resolve({ status: "clean", summary: "Fixture completed." }),
        terminate: async () => undefined,
      };
    },
  };
  const workspaces: TicketWorkspaceManager = {
    async prepare({ item, existing }) {
      return existing ?? { branch: `automode/issue-${item.number}`, worktree: `/worktrees/${item.number}` };
    },
    async completeReview() {},
  };
  const clock = new JourneyClock();
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("full", [
      "auto-triage", "auto-grilling", "auto-implement", "auto-review",
    ]),
    actor: "automation-user",
    tracker,
    sessions,
    workspaces,
    clock,
  });

  const fixture = mkdtempSync(join(tmpdir(), "automode-full-journey-"));
  const repository = join(fixture, "repository");
  const home = join(fixture, "home");
  mkdirSync(join(repository, ".git"), { recursive: true });
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const pi = {
    registerCommand(_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      command = options.handler;
    },
  } as unknown as ExtensionAPI;
  automodeBridge(pi, {
    selectConfiguration: async () => createAutomationStageConfiguration("full", AUTOMATION_STAGES),
    launch: async (request) => {
      const main = await startAutomodeMainSession({
        repository: request.cwd,
        serializedConfiguration: request.serializedConfiguration,
        configurationConfirmation: confirmSerializedAutomationStageConfiguration(request.serializedConfiguration),
        mainExecution: request.mainExecution,
        home,
        model: getBuiltinModel("openai-codex", "gpt-5.6-sol"),
        capabilityModel: getBuiltinModel("openai-codex", "gpt-5.6-sol"),
        coordinator,
        openDashboardInBrowser: async () => undefined,
        createDashboard() {
          return {
            async start() { return { localUrl: "http://127.0.0.1:41738" }; },
            publish() {},
            appendActivity() {},
            async stop() {},
          };
        },
        startupValidation: {
          runner: {
            async run(commandName, args, cwd) {
              if (commandName === "git" && args[0] === "rev-parse") return cwd;
              if (commandName === "git" && args[0] === "remote") return "https://github.com/owner/repository.git";
              if (args[0] === "auth") return "automation-user";
              return JSON.stringify({
                id: "repository-id",
                nameWithOwner: "owner/repository",
                url: "https://github.com/owner/repository",
                viewerPermission: "ADMIN",
              });
            },
          },
          attestExecutions: async () => undefined,
        },
      });
      await main.startCoordinator();
      await coordinator.waitForIdle();
      await clock.callback?.();
      await coordinator.waitForIdle();
      await clock.callback?.();
      await coordinator.waitForIdle();
      main.interruptCoordinator();
      await coordinator.whenStopped();
      await main.dispose();
      throw new Error("deterministic journey complete");
    },
  });
  assert.ok(command);
  await assert.rejects(
    () => command!("", {
      cwd: repository,
      mode: "tui",
      model: getBuiltinModel("openai-codex", "gpt-5.6-sol"),
      waitForIdle: async () => undefined,
      ui: { notify() {} },
    }),
    /deterministic journey complete/,
  );

  assert.deepEqual(dispatched, ["triage#60", "grilling#61", "implement#60", "code-review#70"]);
  assert.equal(items.find((item) => item.number === 70)?.state, "closed");
  assert.equal(records.get("pull-request:70")?.lifecycle, "succeeded");
});
