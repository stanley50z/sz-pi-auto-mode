import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { startAutomodeMainSession } from "../src/automode-main.js";
import { parsePiExecutionProfile } from "../src/capability-profile.js";
import {
  AutomodeCoordinator,
  type CoordinatorTracker,
  type TicketSessionHost,
  type TicketWorkspaceManager,
  type WorkflowItem,
} from "../src/coordinator.js";
import { createCoordinatorDashboard } from "../src/dashboard.js";
import { parseConfirmedAutomationStageConfiguration } from "../src/stage-configuration.js";

function completionDelayMilliseconds(): number {
  const configured = process.env.AUTOMODE_DASHBOARD_ACCEPTANCE_DELAY_MS;
  if (configured === undefined) return 4_000;
  const milliseconds = Number(configured);
  if (!Number.isInteger(milliseconds) || milliseconds < 1) {
    throw new Error("AUTOMODE_DASHBOARD_ACCEPTANCE_DELAY_MS must be a positive integer");
  }
  return milliseconds;
}

async function main(): Promise<void> {
  const repository = process.argv[2];
  if (!repository) throw new Error("Missing caller repository path");
  const serializedConfiguration = process.env.AUTOMODE_STAGE_CONFIGURATION;
  if (!serializedConfiguration) throw new Error("Missing launch-baseline Automation Stage Configuration");
  const configurationConfirmation = process.env.AUTOMODE_STAGE_CONFIGURATION_CONFIRMATION;
  if (!configurationConfirmation) throw new Error("Missing Automation Stage Configuration confirmation");
  const serializedDefaultReviewer = process.env.AUTOMODE_DEFAULT_REVIEWER_EXECUTION;
  if (!serializedDefaultReviewer) throw new Error("Missing default Reviewer execution profile");
  const defaultReviewerExecution = parsePiExecutionProfile(serializedDefaultReviewer);
  const configuration = parseConfirmedAutomationStageConfiguration(
    serializedConfiguration,
    configurationConfirmation,
  );
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
  const sessions: TicketSessionHost = {
    async start() {
      let activityListener: ((activity: {
        occurredAt: string;
        kind: "tool";
        message: string;
        toolName: string;
      }) => void) | undefined;
      const completion = new Promise<{ status: "clean" }>((resolveCompletion) => {
        setTimeout(() => {
          item.outputPullRequest = "https://github.com/owner/repository/pull/51";
          item.materialVersion = "issue-50-delivered";
          resolveCompletion({ status: "clean" });
        }, completionDelayMilliseconds());
      });
      setTimeout(() => {
        activityListener?.({
          occurredAt: new Date().toISOString(),
          kind: "tool",
          message: "npm test — live activity proof",
          toolName: "bash",
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
        async terminate() {},
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
    defaultReviewerExecution,
    normalAgentDir: process.argv[3] || undefined,
    model: getBuiltinModel("openai-codex", "gpt-5.6-sol"),
    coordinator,
    createDashboard(options) {
      return createCoordinatorDashboard({
        ...options,
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
