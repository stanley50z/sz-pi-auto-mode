import {
  createCoordinatorDashboard,
  type CoordinatorDashboard,
  type DashboardCommand,
  type DashboardProjection,
} from "../src/dashboard.js";
import type {
  DashboardLaneProjection,
  DashboardStageCandidate,
} from "../src/dashboard-ui.js";
import {
  AUTOMATION_STAGES,
  type AutomationStage,
  type AutomationStageOperatingStateValue,
} from "../src/stage-configuration.js";

const now = "2026-08-18T16:00:00.000Z";
const nextPollAt = "2026-08-18T16:00:30.000Z";
type BrowserProofControlCommand = "EMPTY" | "STOP";

const proofCandidates: Readonly<Record<AutomationStage, readonly DashboardStageCandidate[]>> = {
  "auto-triage": [
    {
      key: "issue:101:auto-triage",
      itemKey: "issue:101",
      item: "#101",
      title: "Clarify incoming bug report",
      url: "https://github.com/owner/repository/issues/101",
      stage: "auto-triage",
      status: "queued",
      reason: "Eligible now; waiting for the Coordinator to claim it.",
      attempt: 0,
    },
    {
      key: "issue:102:auto-triage",
      itemKey: "issue:102",
      item: "#102",
      title: "Blocked intake with native dependencies",
      url: "https://github.com/owner/repository/issues/102",
      stage: "auto-triage",
      status: "blocked",
      reason: "Blocked by 2 open native dependencies.",
      attempt: 0,
    },
  ],
  "auto-grilling": [],
  "auto-implement": [{
    key: "issue:50:auto-implement",
    itemKey: "issue:50",
    item: "#50",
    title: "Integrate the compact Main Session status card",
    url: "https://github.com/owner/repository/issues/50",
    stage: "auto-implement",
    status: "running",
    reason: "Owned by a live Ticket Session.",
    activity: "The implementation now passes the full suite.",
    attempt: 2,
    session: {
      processId: "dashboard-proof-process",
      sessionId: "dashboard-proof-session",
      sessionFile: ".pi/agent/sessions/dashboard-proof-session.jsonl",
      workspace: "worktrees/issue-50",
      attempts: [{
        attempt: 1,
        state: "settled",
        events: [{
          id: "proof-prior-attempt",
          timestamp: "2026-08-18T15:59:00.000Z",
          kind: "terminal",
          message: "Previous attempt retained for inspection.",
        }],
        terminalResult: "Retry scheduled after an external failure.",
      }],
    },
  }],
  "auto-review": [{
    key: "pull-request:103:auto-review",
    itemKey: "pull-request:103",
    item: "PR #103",
    title: "Preserve exhausted review evidence",
    url: "https://github.com/owner/repository/pull/103",
    stage: "auto-review",
    status: "exhausted",
    reason: "Five attempts were exhausted; evidence is preserved for diagnosis.",
    attempt: 5,
  }],
};

const emptyProofCandidates: Readonly<Record<AutomationStage, readonly DashboardStageCandidate[]>> = {
  "auto-triage": [],
  "auto-grilling": [],
  "auto-implement": [],
  "auto-review": [],
};

function candidateTotals(candidates: readonly DashboardStageCandidate[]) {
  return candidates.reduce((totals, candidate) => ({
    candidates: totals.candidates + 1,
    active: totals.active + (candidate.status === "claimed" || candidate.status === "running" ? 1 : 0),
    queued: totals.queued + (candidate.status === "queued" ? 1 : 0),
    held: totals.held + (["waiting", "blocked", "human-owned"].includes(candidate.status) ? 1 : 0),
    retrying: totals.retrying + (candidate.status === "retrying" ? 1 : 0),
    exhausted: totals.exhausted + (candidate.status === "exhausted" ? 1 : 0),
  }), { candidates: 0, active: 0, queued: 0, held: 0, retrying: 0, exhausted: 0 });
}

function parseControlCommand(input: Buffer | string): BrowserProofControlCommand {
  const command = input.toString().trim().toUpperCase();
  if (command === "EMPTY" || command === "STOP") return command;
  throw new Error(`Unsupported dashboard browser proof command: ${command}`);
}

function proofProjection(
  states: Readonly<Record<AutomationStage, AutomationStageOperatingStateValue>>,
  lifecycle: DashboardProjection["run"]["lifecycle"],
  lastSuccessfulPoll = now,
  candidates: Readonly<Record<AutomationStage, readonly DashboardStageCandidate[]>> = proofCandidates,
): DashboardProjection {
  const lanes: DashboardLaneProjection[] = AUTOMATION_STAGES.map((stage) => ({
    stage,
    operatingState: states[stage],
    candidates: candidates[stage],
    totals: candidateTotals(candidates[stage]),
  }));
  return {
    version: 1,
    repository: {
      name: "owner/repository",
      url: "https://github.com/owner/repository",
    },
    run: {
      id: "dashboard-browser-proof",
      mode: "full",
      lifecycle,
      lastSuccessfulPoll,
      nextPoll: nextPollAt,
    },
    totals: candidateTotals(lanes.flatMap((lane) => lane.candidates)),
    lanes,
    recent: [],
  };
}

async function main(): Promise<void> {
  let states: Record<AutomationStage, AutomationStageOperatingStateValue> = {
    "auto-triage": "ON",
    "auto-grilling": "ON",
    "auto-implement": "ON",
    "auto-review": "ON",
  };
  let projection = proofProjection(states, "active");
  let dashboard!: CoordinatorDashboard;
  let stopTimer: NodeJS.Timeout | undefined;
  let resolveDrained!: () => void;
  const drained = new Promise<void>((resolve) => { resolveDrained = resolve; });
  let stopping: Promise<void> | undefined;

  const publish = () => dashboard.publish(projection);
  const onCommand = async (command: DashboardCommand) => {
    if (command.type === "refresh") {
      projection = proofProjection(states, projection.run.lifecycle, new Date().toISOString());
      publish();
      return;
    }
    if (command.type === "set-stage-state") {
      states = { ...states, [command.stage]: command.state };
      projection = proofProjection(states, projection.run.lifecycle, projection.run.lastSuccessfulPoll);
      publish();
      return;
    }

    states = {
      "auto-triage": "OFF",
      "auto-grilling": "OFF",
      "auto-implement": "DRAINING",
      "auto-review": "OFF",
    };
    projection = proofProjection(states, "draining", projection.run.lastSuccessfulPoll);
    publish();
    stopTimer = setTimeout(() => {
      stop();
    }, 4_000);
  };

  dashboard = createCoordinatorDashboard({
    onCommand,
    tailscale: {
      async expose() { throw new Error("Tailscale is unavailable in the browser proof"); },
      async stop() {},
    },
  });
  const status = await dashboard.start(projection);
  process.stdout.write(`AUTOMODE_DASHBOARD_BROWSER_PROOF ${JSON.stringify({
    dashboardUrl: status.localUrl,
    viewports: ["1440x900", "1024x768", "390x844"],
  })}\n`);
  dashboard.appendActivity({
    id: "proof-live-thinking",
    itemKey: "issue:50",
    occurredAt: new Date().toISOString(),
    kind: "thinking",
    message: "**Reviewing code consistency and diffs**",
    data: {
      source: "live",
      attempt: 2,
      sessionId: "dashboard-proof-session",
      toolCount: 3,
    },
  });
  dashboard.appendActivity({
    id: "proof-live-assistant",
    itemKey: "issue:50",
    occurredAt: new Date().toISOString(),
    kind: "assistant",
    message: "The implementation now passes the full suite.",
    data: {
      source: "live",
      attempt: 2,
      sessionId: "dashboard-proof-session",
    },
  });

  function stop() {
    if (stopTimer) clearTimeout(stopTimer);
    if (!stopping) stopping = dashboard.stop().finally(resolveDrained);
  }
  const onInput = (chunk: Buffer | string) => {
    const command = parseControlCommand(chunk);
    if (command === "EMPTY") {
      projection = proofProjection(states, "empty", projection.run.lastSuccessfulPoll, emptyProofCandidates);
      publish();
      return;
    }
    if (command === "STOP") stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdin.on("data", onInput);
  process.stdin.resume();
  try {
    await drained;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.stdin.off("data", onInput);
    process.stdin.pause();
  }
}

await main();
