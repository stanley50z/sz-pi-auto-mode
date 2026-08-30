import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { startAutomodeMainSession } from "../src/automode-main.js";
import { parsePiExecutionProfile } from "../src/capability-profile.js";
import {
  AutomodeCoordinator,
  type CoordinatorTracker,
  type TicketSessionHost,
  type TicketSessionObservedActivity,
  type TicketWorkspaceManager,
  type WorkflowItem,
} from "../src/coordinator.js";
import { createCoordinatorDashboard } from "../src/dashboard.js";
import { parseConfirmedAutomationStageConfiguration } from "../src/stage-configuration.js";
import { parsePositiveIntegerMilliseconds } from "./positive-integer-milliseconds.js";

function completionDelayMilliseconds(): number {
  const configured = process.env.AUTOMODE_DASHBOARD_ACCEPTANCE_DELAY_MS;
  if (configured === undefined) return 4_000;
  return parsePositiveIntegerMilliseconds(configured, "AUTOMODE_DASHBOARD_ACCEPTANCE_DELAY_MS");
}

function drainCompletionDelayMilliseconds(): number | undefined {
  const configured = process.env.AUTOMODE_DASHBOARD_ACCEPTANCE_DRAIN_DELAY_MS;
  if (configured === undefined) return undefined;
  return parsePositiveIntegerMilliseconds(
    configured,
    "AUTOMODE_DASHBOARD_ACCEPTANCE_DRAIN_DELAY_MS",
  );
}

async function main(): Promise<void> {
  const repository = process.argv[2];
  if (!repository) throw new Error("Missing caller repository path");
  const serializedConfiguration = process.env.AUTOMODE_STAGE_CONFIGURATION;
  if (!serializedConfiguration) throw new Error("Missing launch-baseline Automation Stage Configuration");
  const configurationConfirmation = process.env.AUTOMODE_STAGE_CONFIGURATION_CONFIRMATION;
  if (!configurationConfirmation) throw new Error("Missing Automation Stage Configuration confirmation");
  const serializedMainExecution = process.env.AUTOMODE_MAIN_EXECUTION;
  if (!serializedMainExecution) throw new Error("Missing Main Session execution profile");
  const mainExecution = parsePiExecutionProfile(serializedMainExecution);
  const configuration = parseConfirmedAutomationStageConfiguration(
    serializedConfiguration,
    configurationConfirmation,
  );
  const drainCompletionDelay = drainCompletionDelayMilliseconds();
  const item: WorkflowItem = {
    kind: "issue",
    number: 50,
    url: "https://github.com/owner/repository/issues/50",
    title: "Integrate the compact Main Session status card",
    state: "open",
    labels: ["ready-for-agent"],
    assignees: [],
    blockedBy: 0,
    updatedAt: "2026-08-18T12:00:00.000Z",
    materialVersion: "issue-50-running",
  };
  const tracker: CoordinatorTracker = {
    async listBookkeeping() { return []; },
    async snapshot() { return { revision: item.materialVersion, items: [structuredClone(item)] }; },
    async read() { return structuredClone(item); },
    async claim(_candidate, actor) { item.assignees = [actor]; },
    async upsertBookkeeping() {},
  };
  let settleSession: (() => void) | undefined;
  let drainSettlementTimer: NodeJS.Timeout | undefined;
  const sessions: TicketSessionHost = {
    async start() {
      let activityListener: ((activity: TicketSessionObservedActivity) => void) | undefined;
      let completionTimer: NodeJS.Timeout | undefined;
      const completion = new Promise<{ status: "clean"; summary: string }>((resolveCompletion) => {
        let settled = false;
        settleSession = () => {
          if (settled) return;
          settled = true;
          if (completionTimer) clearTimeout(completionTimer);
          item.outputPullRequest = "https://github.com/owner/repository/pull/51";
          item.materialVersion = "issue-50-delivered";
          resolveCompletion({ status: "clean", summary: "Fixture completed." });
        };
        if (drainCompletionDelay === undefined) {
          completionTimer = setTimeout(settleSession, completionDelayMilliseconds());
        }
      });
      setTimeout(() => {
        activityListener?.({
          occurredAt: new Date().toISOString(),
          kind: "assistant",
          message: "The implementation now passes the full suite.",
        });
      }, 250);
      return {
        processId: "dashboard-proof-process",
        sessionId: "dashboard-proof-session",
        sessionFile: `${repository}/dashboard-proof-session.jsonl`,
        completion,
        subscribe(listener) {
          activityListener = listener;
          return () => { activityListener = undefined; };
        },
        async terminate() {
          if (drainSettlementTimer) {
            clearTimeout(drainSettlementTimer);
            drainSettlementTimer = undefined;
          }
          settleSession?.();
        },
      };
    },
  };
  const workspaces: TicketWorkspaceManager = {
    async prepare() {
      return { branch: "automode/issue-50", worktree: repository };
    },
    async completeReview() {},
  };
  const coordinator = new AutomodeCoordinator({
    configuration,
    actor: "automation-user",
    tracker,
    sessions,
    workspaces,
  });
  const mainSession = await startAutomodeMainSession({
    repository,
    serializedConfiguration,
    configurationConfirmation,
    mainExecution,
    normalAgentDir: process.argv[3] || undefined,
    model: getBuiltinModel("openai-codex", "gpt-5.6-sol"),
    capabilityModel: getBuiltinModel("openai-codex", "gpt-5.6-sol"),
    coordinator,
    createDashboard(options) {
      return createCoordinatorDashboard({
        ...options,
        async onCommand(command) {
          await options.onCommand(command);
          if (command.type === "drain" && drainCompletionDelay !== undefined && !drainSettlementTimer) {
            drainSettlementTimer = setTimeout(() => settleSession?.(), drainCompletionDelay);
          }
        },
        tailscale: {
          async expose() { throw new Error("Tailscale is unavailable in the acceptance harness"); },
          async stop() {},
        },
      });
    },
    startupValidation: {
      runner: {
        async run(command, args, cwd) {
          if (command === "git" && args[0] === "rev-parse") return cwd;
          if (command === "git" && args[0] === "remote") return "https://github.com/owner/repository.git";
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
  await mainSession.runInteractive();
}

const isEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isEntrypoint) await main();
