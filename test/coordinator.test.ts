import assert from "node:assert/strict";
import test from "node:test";
import {
  AutomodeCoordinator,
  type BookkeepingRecord,
  type CoordinatorClock,
  type CoordinatorSupervisionEvent,
  type CoordinatorTracker,
  type TicketSessionHandle,
  type TicketSessionHost,
  type TicketSessionObservedActivity,
  type TicketSessionRequest,
  type TicketWorkspaceManager,
  type WorkflowItem,
  type WorkflowSnapshot,
} from "../src/coordinator.js";
import { AutomodeRestartRequiredError } from "../src/restart-required.js";
import { createAutomationStageConfiguration } from "../src/stage-configuration.js";

class ManualClock implements CoordinatorClock {
  callback: (() => void | Promise<void>) | undefined;
  interval: number | undefined;
  current = new Date("2026-02-03T04:05:06.000Z");

  now() { return this.current; }

  every(milliseconds: number, callback: () => void | Promise<void>) {
    this.interval = milliseconds;
    this.callback = callback;
    return { dispose: () => { this.callback = undefined; } };
  }
}

class FakeTracker implements CoordinatorTracker {
  readonly calls: string[] = [];
  readonly records = new Map<string, BookkeepingRecord>();

  constructor(public items: WorkflowItem[]) {}

  async listBookkeeping(): Promise<readonly BookkeepingRecord[]> {
    this.calls.push("list-bookkeeping");
    return [...this.records.values()];
  }

  async snapshot(): Promise<WorkflowSnapshot> {
    this.calls.push("snapshot");
    return { revision: this.items.map((item) => item.materialVersion).join("|"), items: structuredClone(this.items) };
  }

  async read(item: Pick<WorkflowItem, "kind" | "number">): Promise<WorkflowItem> {
    this.calls.push(`read:${item.kind}:${item.number}`);
    const found = this.items.find((candidate) => candidate.kind === item.kind && candidate.number === item.number);
    if (!found) throw new Error(`missing item ${item.number}`);
    return structuredClone(found);
  }

  async claim(item: WorkflowItem, actor: string): Promise<void> {
    this.calls.push(`claim:${item.number}`);
    const found = this.items.find((candidate) => candidate.kind === item.kind && candidate.number === item.number)!;
    found.assignees = [actor];
  }

  async upsertBookkeeping(record: BookkeepingRecord): Promise<void> {
    this.calls.push(`bookkeeping:${record.lifecycle}:${record.attempt}`);
    this.records.set(`${record.item.kind}:${record.item.number}`, structuredClone(record));
  }
}

const fakeWorkspaces: TicketWorkspaceManager = {
  async prepare({ item, skillName, existing }) {
    return existing ?? {
      branch: `automode/${skillName}-${item.number}`,
      worktree: `/worktrees/${skillName}-${item.number}`,
    };
  },
  async completeReview() {},
};

class FakeTicketSessions implements TicketSessionHost {
  readonly requests: TicketSessionRequest[] = [];

  constructor(private readonly onStart: (request: TicketSessionRequest) => void | Promise<void>) {}

  async start(request: TicketSessionRequest): Promise<TicketSessionHandle> {
    this.requests.push(request);
    await this.onStart(request);
    return {
      processId: `process-${request.item.number}`,
      sessionId: `session-${request.item.number}`,
      sessionFile: `/sessions/${request.item.number}.jsonl`,
      completion: Promise.resolve({ status: "clean", summary: "Fixture completed." }),
      terminate: async () => undefined,
    };
  }
}

function issue(overrides: Partial<WorkflowItem> = {}): WorkflowItem {
  return {
    kind: "issue",
    number: 7,
    url: "https://github.com/owner/repository/issues/7",
    state: "open",
    labels: ["needs-triage"],
    assignees: [],
    blockedBy: 0,
    updatedAt: "2026-01-01T00:00:00Z",
    materialVersion: "issue-7-v1",
    ...overrides,
  };
}

function candidateFor(coordinator: AutomodeCoordinator, itemNumber: number) {
  return coordinator.getProjection().lanes
    .flatMap((lane) => lane.candidates)
    .find((candidate) => candidate.item.number === itemNumber);
}

test("a changed Automode runtime stops dispatch until the Coordinator restarts", async () => {
  const tracker = new FakeTracker([issue({ number: 59, materialVersion: "59-a" })]);
  const sessions = new FakeTicketSessions(() => {
    throw new AutomodeRestartRequiredError("The Ticket Session runtime changed; restart Automode");
  });
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("half", ["auto-triage"]),
    actor: "automation-user",
    tracker,
    sessions,
    clock: new ManualClock(),
  });

  await coordinator.start();
  await coordinator.waitForIdle();

  assert.equal(sessions.requests.length, 1);
  assert.equal(tracker.records.get("issue:59")?.lifecycle, "failed");
  assert.equal(tracker.records.get("issue:59")?.attempt, 1);
  assert.match(tracker.records.get("issue:59")?.diagnostic ?? "", /restart Automode/i);
  await coordinator.whenStopped();
});

test("projects queued, claimed, and running lifecycle from Coordinator state", async () => {
  const tracker = new FakeTracker([
    issue({ number: 60, labels: ["ready-for-agent"], materialVersion: "60-a" }),
  ]);
  let finishClaim!: () => void;
  const claimGate = new Promise<void>((resolve) => { finishClaim = resolve; });
  tracker.claim = async (item, actor) => {
    tracker.calls.push(`claim:${item.number}`);
    await claimGate;
    const found = tracker.items.find((candidate) => candidate.number === item.number)!;
    found.assignees = [actor];
  };
  let finishStartup!: () => void;
  const startupGate = new Promise<void>((resolve) => { finishStartup = resolve; });
  let finishSession!: () => void;
  const completion = new Promise<{ status: "clean"; summary: string }>((resolve) => {
    finishSession = () => {
      const item = tracker.items[0]!;
      item.outputPullRequest = "https://github.com/owner/repository/pull/60";
      item.materialVersion = "60-done";
      resolve({ status: "clean", summary: "Fixture completed." });
    };
  });
  let sessionStarts = 0;
  let emitActivity!: (activity: TicketSessionObservedActivity) => void;
  const sessions: TicketSessionHost = {
    async start() {
      sessionStarts += 1;
      await startupGate;
      return {
        processId: "process-60",
        sessionId: "session-60",
        sessionFile: "/sessions/60.jsonl",
        history: [{
          occurredAt: "2026-08-17T11:59:00.000Z",
          kind: "thinking",
          message: "**Recovering persisted Pi conversation history**",
        }],
        subscribe(listener) {
          emitActivity = listener;
          return () => undefined;
        },
        completion,
        terminate: async () => undefined,
      };
    },
  };
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("half", ["auto-implement"]),
    actor: "automation-user",
    tracker,
    sessions,
    workspaces: fakeWorkspaces,
    clock: new ManualClock(),
  });
  const supervision: CoordinatorSupervisionEvent[] = [];
  coordinator.subscribe((event) => supervision.push(event));

  await coordinator.start();
  assert.equal(candidateFor(coordinator, 60)?.status, "queued");
  assert.match(candidateFor(coordinator, 60)?.reason ?? "", /claim/i);
  assert.deepEqual(coordinator.getProjection().totals, {
    candidates: 1, active: 0, queued: 1, held: 0, retrying: 0, exhausted: 0,
  });

  finishClaim();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(candidateFor(coordinator, 60)?.status, "claimed");
  assert.match(candidateFor(coordinator, 60)?.reason ?? "", /start|workspace/i);
  assert.equal(coordinator.getProjection().totals.active, 1);

  finishStartup();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(candidateFor(coordinator, 60)?.status, "running");
  assert.equal(candidateFor(coordinator, 60)?.attempt, 1);
  assert.deepEqual(candidateFor(coordinator, 60)?.session, {
    processId: "process-60",
    sessionId: "session-60",
    sessionFile: "/sessions/60.jsonl",
    workspace: "/worktrees/implement-60",
    startedAt: "2026-08-17T11:59:00.000Z",
  });
  assert.equal(coordinator.getProjection().totals.active, 1);
  assert.equal(sessionStarts, 1);
  assert.equal(
    supervision.find((event) => event.type === "activity" && event.activity.data.source === "persisted")?.type,
    "activity",
  );
  emitActivity({
    occurredAt: "2026-08-17T12:00:00.000Z",
    kind: "assistant",
    message: "Focused tests are running.",
  });
  assert.equal(
    supervision.find((event) => event.type === "activity" && event.activity.message === "Focused tests are running.")?.type,
    "activity",
  );

  finishSession();
  await coordinator.waitForIdle();
  coordinator.interrupt();
  await coordinator.whenStopped();
});

test("retains candidates settled in this process as Recent and clears them on restart", async () => {
  const settled = issue({ number: 61, labels: ["needs-triage"], materialVersion: "61-a" });
  const tracker = new FakeTracker([settled]);
  const sessions = new FakeTicketSessions(() => {
    settled.state = "closed";
    settled.materialVersion = "61-done";
  });
  const configuration = createAutomationStageConfiguration("half", ["auto-triage"]);
  const first = new AutomodeCoordinator({
    configuration,
    actor: "automation-user",
    tracker,
    sessions,
    workspaces: fakeWorkspaces,
    clock: new ManualClock(),
  });

  await first.start();
  await first.waitForIdle();
  assert.deepEqual(first.getProjection().lanes.flatMap((lane) => lane.candidates), []);
  assert.deepEqual(first.getProjection().recent, [{
    item: { kind: "issue", number: 61, url: settled.url },
    stage: "auto-triage",
    skillName: "triage",
    status: "settled",
    reason: "The Ticket Session settled this Stage and fresh tracker state proves completion.",
    attempt: 1,
    settledAt: "2026-02-03T04:05:06.000Z",
    session: {
      processId: "process-61",
      sessionId: "session-61",
      sessionFile: "/sessions/61.jsonl",
      startedAt: "2026-02-03T04:05:06.000Z",
      endedAt: "2026-02-03T04:05:06.000Z",
    },
  }]);
  first.interrupt();
  await first.whenStopped();

  const restarted = new AutomodeCoordinator({
    configuration,
    actor: "automation-user",
    tracker,
    sessions,
    workspaces: fakeWorkspaces,
    clock: new ManualClock(),
  });
  await restarted.start();
  assert.deepEqual(restarted.getProjection().recent, []);
  restarted.interrupt();
  await restarted.whenStopped();
});

test("projects every recognized open Stage Candidate once using workflow precedence and shared totals", async () => {
  const tracker = new FakeTracker([
    issue({
      number: 1,
      labels: ["needs-triage", "ready-for-human", "wayfinder:grilling"],
      materialVersion: "1-a",
    }),
    issue({ number: 2, labels: ["wayfinder:grilling"], blockedBy: 2, materialVersion: "2-a" }),
    issue({
      number: 3,
      labels: ["ready-for-agent"],
      outputPullRequest: "https://github.com/owner/repository/pull/30",
      materialVersion: "3-a",
    }),
    issue({ number: 4, state: "closed", labels: ["ready-for-agent"], materialVersion: "4-a" }),
    issue({
      number: 6,
      labels: ["needs-triage"],
      assignees: ["automation-user"],
      materialVersion: "6-a",
    }),
    {
      kind: "pull-request",
      number: 5,
      url: "https://github.com/owner/repository/pull/5",
      state: "open",
      labels: [],
      assignees: [],
      blockedBy: 0,
      updatedAt: "2026-01-01T00:00:00Z",
      materialVersion: "5-a",
      draft: true,
    },
  ]);
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("full", [
      "auto-triage",
      "auto-grilling",
      "auto-implement",
      "auto-review",
    ]),
    actor: "automation-user",
    tracker,
    sessions: new FakeTicketSessions(() => { throw new Error("held candidates must not dispatch"); }),
    workspaces: fakeWorkspaces,
    clock: new ManualClock(),
  });

  await coordinator.start();
  const projection = coordinator.getProjection();

  assert.deepEqual(
    projection.lanes.map((lane) => ({
      stage: lane.stage,
      candidates: lane.candidates.map((candidate) => [candidate.item.number, candidate.status]),
      totals: lane.totals,
    })),
    [
      {
        stage: "auto-triage",
        candidates: [[1, "human-owned"], [6, "human-owned"]],
        totals: { candidates: 2, active: 0, queued: 0, held: 2, retrying: 0, exhausted: 0 },
      },
      {
        stage: "auto-grilling",
        candidates: [[2, "blocked"]],
        totals: { candidates: 1, active: 0, queued: 0, held: 1, retrying: 0, exhausted: 0 },
      },
      {
        stage: "auto-implement",
        candidates: [[3, "human-owned"]],
        totals: { candidates: 1, active: 0, queued: 0, held: 1, retrying: 0, exhausted: 0 },
      },
      {
        stage: "auto-review",
        candidates: [],
        totals: { candidates: 0, active: 0, queued: 0, held: 0, retrying: 0, exhausted: 0 },
      },
    ],
  );
  assert.deepEqual(projection.totals, {
    candidates: 4,
    active: 0,
    queued: 0,
    held: 4,
    retrying: 0,
    exhausted: 0,
  });
  for (const candidate of projection.lanes.flatMap((lane) => lane.candidates)) {
    assert.ok(candidate.reason.length > 0);
  }
  coordinator.interrupt();
  await coordinator.whenStopped();
});

test("spec parents stay out of Auto-Implement even when mislabeled ready-for-agent", async () => {
  const tracker = new FakeTracker([
    issue({ number: 110, labels: ["enhancement", "spec", "ready-for-agent"], materialVersion: "110-a" }),
  ]);
  const sessions = new FakeTicketSessions(() => {
    throw new Error("spec parents must not dispatch");
  });
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("half", ["auto-implement"]),
    actor: "automation-user",
    tracker,
    sessions,
    workspaces: fakeWorkspaces,
    clock: new ManualClock(),
  });

  await coordinator.start();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(sessions.requests.length, 0);
  assert.deepEqual(
    coordinator.getProjection().lanes.find((lane) => lane.stage === "auto-implement")?.candidates,
    [],
  );
  coordinator.interrupt();
  await coordinator.whenStopped();
});

test("Stage Operating State drains active work, suppresses dispatch, and scans immediately when re-enabled", async () => {
  const first = issue({ number: 11, labels: ["ready-for-agent"], materialVersion: "11-a" });
  const tracker = new FakeTracker([first]);
  const requests: TicketSessionRequest[] = [];
  let settleFirst!: () => void;
  const sessions: TicketSessionHost = {
    async start(request) {
      requests.push(request);
      const item = tracker.items.find((candidate) => candidate.number === request.item.number)!;
      if (request.item.number === 11) {
        return {
          processId: "process-11",
          sessionId: "session-11",
          sessionFile: "/sessions/11.jsonl",
          completion: new Promise<{ status: "clean"; summary: string }>((resolve) => {
            settleFirst = () => {
              item.outputPullRequest = "https://github.com/owner/repository/pull/11";
              item.materialVersion = "11-done";
              resolve({ status: "clean", summary: "Fixture completed." });
            };
          }),
          terminate: async () => undefined,
        };
      }
      item.outputPullRequest = "https://github.com/owner/repository/pull/12";
      item.materialVersion = "12-done";
      return {
        processId: "process-12",
        sessionId: "session-12",
        sessionFile: "/sessions/12.jsonl",
        completion: Promise.resolve({ status: "clean", summary: "Fixture completed." }),
        terminate: async () => undefined,
      };
    },
  };
  const clock = new ManualClock();
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("half", ["auto-implement"]),
    actor: "automation-user",
    tracker,
    sessions,
    workspaces: fakeWorkspaces,
    clock,
  });

  await coordinator.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(requests.map((request) => request.item.number), [11]);

  assert.equal(await coordinator.setStageOperatingState("auto-implement", "OFF"), "DRAINING");
  assert.equal(
    coordinator.getProjection().lanes.find((lane) => lane.stage === "auto-implement")?.operatingState,
    "DRAINING",
  );
  tracker.items.push(issue({ number: 12, labels: ["ready-for-agent"], materialVersion: "12-a" }));
  await clock.callback?.();
  assert.deepEqual(requests.map((request) => request.item.number), [11]);

  settleFirst();
  await coordinator.waitForIdle();
  const allOff = coordinator.getProjection().lanes;
  assert.ok(allOff.every((lane) => lane.operatingState === "OFF"));
  assert.ok(clock.callback, "monitoring continues while all Stages are OFF");

  assert.equal(await coordinator.setStageOperatingState("auto-implement", "ON"), "ON");
  await coordinator.waitForIdle();
  assert.deepEqual(requests.map((request) => request.item.number), [11, 12]);

  coordinator.interrupt();
  await coordinator.whenStopped();
});

test("a Stage drain preserves retry budget and session continuity for re-enable", async () => {
  const item = issue({ number: 63, labels: ["ready-for-agent"], materialVersion: "63-a" });
  const tracker = new FakeTracker([item]);
  const requests: TicketSessionRequest[] = [];
  let finishFirst!: () => void;
  const firstCompletion = new Promise<{ status: "error"; error: string }>((resolve) => {
    finishFirst = () => resolve({ status: "error", error: "attempt failed while draining" });
  });
  const sessions: TicketSessionHost = {
    async start(request) {
      requests.push(request);
      if (requests.length === 2) {
        item.outputPullRequest = "https://github.com/owner/repository/pull/63";
        item.materialVersion = "63-delivered";
      }
      return {
        processId: `process-${requests.length}`,
        sessionId: "session-63",
        sessionFile: "/sessions/63.jsonl",
        completion: requests.length === 1 ? firstCompletion : Promise.resolve({ status: "clean", summary: "Fixture completed." }),
        terminate: async () => undefined,
      };
    },
  };
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("half", ["auto-implement"]),
    actor: "automation-user",
    tracker,
    sessions,
    workspaces: fakeWorkspaces,
    clock: new ManualClock(),
  });

  await coordinator.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(await coordinator.setStageOperatingState("auto-implement", "OFF"), "DRAINING");
  finishFirst();
  await coordinator.waitForIdle();
  assert.equal(tracker.records.get("issue:63")?.lifecycle, "retrying");
  assert.equal(tracker.records.get("issue:63")?.attempt, 1);

  await coordinator.setStageOperatingState("auto-implement", "ON");
  await coordinator.waitForIdle();
  assert.deepEqual(requests.map(({ attempt, resumeSessionFile }) => ({ attempt, resumeSessionFile })), [
    { attempt: 1, resumeSessionFile: undefined },
    { attempt: 2, resumeSessionFile: "/sessions/63.jsonl" },
  ]);
  coordinator.interrupt();
  await coordinator.whenStopped();
});

test("Coordinator restart restores Stage Operating State from the launch baseline", async () => {
  const configuration = createAutomationStageConfiguration("half", ["auto-triage"]);
  const tracker = new FakeTracker([]);
  const options = {
    configuration,
    actor: "automation-user",
    tracker,
    sessions: new FakeTicketSessions(() => undefined),
    workspaces: fakeWorkspaces,
  };
  const first = new AutomodeCoordinator({ ...options, clock: new ManualClock() });
  await first.start();
  assert.equal(await first.setStageOperatingState("auto-triage", "OFF"), "OFF");
  assert.equal(await first.setStageOperatingState("auto-review", "ON"), "ON");
  first.interrupt();
  await first.whenStopped();

  const restarted = new AutomodeCoordinator({ ...options, clock: new ManualClock() });
  assert.deepEqual(
    restarted.getProjection().lanes.map((lane) => [lane.stage, lane.operatingState]),
    [
      ["auto-triage", "ON"],
      ["auto-grilling", "OFF"],
      ["auto-implement", "OFF"],
      ["auto-review", "OFF"],
    ],
  );
  await restarted.start();
  restarted.interrupt();
  await restarted.whenStopped();
});

test("recovery resets attempts but preserves session continuity for a Stage restored OFF", async () => {
  const recovered = issue({
    number: 62,
    labels: ["ready-for-agent"],
    assignees: ["automation-user"],
    materialVersion: "62-running",
  });
  const tracker = new FakeTracker([recovered]);
  tracker.records.set("issue:62", {
    version: 1,
    item: { kind: "issue", number: 62, url: recovered.url },
    stage: "auto-implement",
    skillName: "implement",
    attempt: 2,
    lifecycle: "running",
    materialVersion: recovered.materialVersion,
    sessionId: "session-62",
    sessionFile: "/sessions/62.jsonl",
  });
  const sessions = new FakeTicketSessions((request) => {
    recovered.outputPullRequest = "https://github.com/owner/repository/pull/62";
    recovered.materialVersion = "62-delivered";
    assert.equal(request.attempt, 1);
    assert.equal(request.resumeSessionFile, "/sessions/62.jsonl");
  });
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("half", ["auto-triage"]),
    actor: "automation-user",
    tracker,
    sessions,
    workspaces: fakeWorkspaces,
    clock: new ManualClock(),
  });

  await coordinator.start();
  assert.equal(sessions.requests.length, 0);
  assert.equal(tracker.records.get("issue:62")?.lifecycle, "running");
  assert.equal(candidateFor(coordinator, 62)?.status, "human-owned");
  assert.match(candidateFor(coordinator, 62)?.reason ?? "", /OFF|human-controlled/);

  await coordinator.setStageOperatingState("auto-implement", "ON");
  await coordinator.waitForIdle();
  assert.equal(sessions.requests.length, 1);
  assert.equal(tracker.records.get("issue:62")?.lifecycle, "succeeded");
  coordinator.interrupt();
  await coordinator.whenStopped();
});

test("recovery retains elapsed timing for a waiting Ticket Session", async () => {
  const waiting = issue({
    number: 63,
    labels: ["ready-for-agent"],
    assignees: ["automation-user"],
    materialVersion: "63-waiting",
  });
  const tracker = new FakeTracker([waiting]);
  tracker.records.set("issue:63", {
    version: 1,
    item: { kind: "issue", number: 63, url: waiting.url },
    stage: "auto-implement",
    skillName: "implement",
    attempt: 1,
    lifecycle: "awaiting-feedback",
    materialVersion: waiting.materialVersion,
    sessionId: "session-63",
    sessionFile: "/sessions/63.jsonl",
    startedAt: "2026-02-03T03:55:00.000Z",
    endedAt: "2026-02-03T04:05:00.000Z",
  });
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("half", ["auto-implement"]),
    actor: "automation-user",
    tracker,
    sessions: new FakeTicketSessions(() => undefined),
    workspaces: fakeWorkspaces,
    clock: new ManualClock(),
  });

  await coordinator.start();
  assert.deepEqual(candidateFor(coordinator, 63)?.session, {
    sessionId: "session-63",
    sessionFile: "/sessions/63.jsonl",
    startedAt: "2026-02-03T03:55:00.000Z",
    endedAt: "2026-02-03T04:05:00.000Z",
  });
  coordinator.interrupt();
  await coordinator.whenStopped();
});

test("startup dispatches one claimed Auto-Triage Ticket Session and requires fresh tracker proof", async () => {
  const tracker = new FakeTracker([issue()]);
  const sessions = new FakeTicketSessions((request) => {
    assert.equal(request.skillName, "triage");
    const item = tracker.items[0]!;
    item.labels = ["bug", "ready-for-agent"];
    item.assignees = [];
    item.materialVersion = "issue-7-v2";
  });
  const clock = new ManualClock();
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("full", [
      "auto-triage",
      "auto-grilling",
      "auto-implement",
      "auto-review",
    ]),
    actor: "automation-user",
    tracker,
    sessions,
    workspaces: fakeWorkspaces,
    clock,
  });

  await coordinator.start();
  await coordinator.waitForIdle();

  assert.equal(clock.interval, 30_000);
  assert.deepEqual(sessions.requests.map(({ stage, skillName, attempt }) => ({ stage, skillName, attempt })), [
    { stage: "auto-triage", skillName: "triage", attempt: 1 },
  ]);
  assert.deepEqual(tracker.calls.slice(0, 5), [
    "list-bookkeeping",
    "snapshot",
    "claim:7",
    "read:issue:7",
    "bookkeeping:running:1",
  ]);
  assert.ok(tracker.calls.includes("read:issue:7"));
  assert.equal(tracker.records.get("issue:7")?.lifecycle, "succeeded");
  assert.equal(coordinator.interrupt(), "draining");
  await coordinator.whenStopped();
});

test("the Coordinator projection reports successful and next scheduled poll timing", async () => {
  const clock = new ManualClock();
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("half", ["auto-triage"]),
    actor: "automation-user",
    tracker: new FakeTracker([]),
    sessions: new FakeTicketSessions(async () => undefined),
    clock,
  });

  await coordinator.start();
  assert.deepEqual(coordinator.getProjection().poll, {
    lastSuccessfulPoll: "2026-02-03T04:05:06.000Z",
    nextScheduledPoll: "2026-02-03T04:05:36.000Z",
  });

  clock.current = new Date("2026-02-03T04:05:36.000Z");
  await clock.callback?.();
  assert.deepEqual(coordinator.getProjection().poll, {
    lastSuccessfulPoll: "2026-02-03T04:05:36.000Z",
    nextScheduledPoll: "2026-02-03T04:06:06.000Z",
  });

  coordinator.interrupt();
  assert.deepEqual(coordinator.getProjection().poll, {
    lastSuccessfulPoll: "2026-02-03T04:05:36.000Z",
  });
  await coordinator.whenStopped();
});

test("a failed background poll preserves the Coordinator and reports recovery on the next poll", async () => {
  const tracker = new FakeTracker([]);
  const successfulSnapshot = tracker.snapshot.bind(tracker);
  let pollFails = false;
  tracker.snapshot = async () => {
    if (pollFails) throw new Error("temporary GitHub outage");
    return successfulSnapshot();
  };
  const clock = new ManualClock();
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("half", ["auto-triage"]),
    actor: "automation-user",
    tracker,
    sessions: new FakeTicketSessions(async () => undefined),
    clock,
  });

  await coordinator.start();
  pollFails = true;
  clock.current = new Date("2026-02-03T04:05:36.000Z");
  await assert.doesNotReject(async () => clock.callback?.());
  assert.deepEqual(coordinator.getProjection().poll, {
    lastSuccessfulPoll: "2026-02-03T04:05:06.000Z",
    nextScheduledPoll: "2026-02-03T04:06:06.000Z",
    error: "temporary GitHub outage",
  });

  pollFails = false;
  clock.current = new Date("2026-02-03T04:06:06.000Z");
  await clock.callback?.();
  assert.deepEqual(coordinator.getProjection().poll, {
    lastSuccessfulPoll: "2026-02-03T04:06:06.000Z",
    nextScheduledPoll: "2026-02-03T04:06:36.000Z",
  });

  coordinator.interrupt();
  await coordinator.whenStopped();
});

test("polling rescans all enabled stages only when the 30-second material snapshot changes", async () => {
  const tracker = new FakeTracker([]);
  const sessions = new FakeTicketSessions((request) => {
    const item = tracker.items.find((candidate) => candidate.number === request.item.number)!;
    item.outputPullRequest = "https://github.com/owner/repository/pull/12";
    item.materialVersion = "issue-8-v2";
  });
  const clock = new ManualClock();
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("half", ["auto-implement"]),
    actor: "automation-user",
    tracker,
    sessions,
    workspaces: fakeWorkspaces,
    clock,
  });

  await coordinator.start();
  await clock.callback?.();
  assert.equal(sessions.requests.length, 0);

  tracker.items.push(issue({
    number: 8,
    url: "https://github.com/owner/repository/issues/8",
    labels: ["ready-for-agent"],
    materialVersion: "issue-8-v1",
  }));
  await clock.callback?.();
  await coordinator.waitForIdle();

  assert.deepEqual(sessions.requests.map(({ skillName, item }) => [skillName, item.number]), [["implement", 8]]);
  coordinator.interrupt();
  await coordinator.whenStopped();
});

test("workflow precedence dispatches each item once while unrelated eligible items start independently", async () => {
  const tracker = new FakeTracker([
    issue({ number: 21, labels: ["needs-triage", "wayfinder:grilling"], materialVersion: "21-a" }),
    issue({ number: 22, labels: ["wayfinder:grilling"], materialVersion: "22-a" }),
    issue({ number: 23, labels: ["ready-for-agent"], materialVersion: "23-a" }),
    {
      kind: "pull-request",
      number: 24,
      url: "https://github.com/owner/repository/pull/24",
      state: "open",
      labels: [],
      assignees: [],
      blockedBy: 0,
      updatedAt: "2026-01-01T00:00:00Z",
      materialVersion: "24-a",
      draft: false,
      headSha: "abc123",
    },
  ]);
  const releases = new Map<number, () => void>();
  const requests: TicketSessionRequest[] = [];
  const sessions: TicketSessionHost = {
    async start(request) {
      requests.push(request);
      const completion = new Promise<{ status: "clean"; summary: string }>((resolve) => {
        releases.set(request.item.number, () => {
          const item = tracker.items.find((candidate) => candidate.number === request.item.number)!;
          item.state = "closed";
          if (item.kind === "pull-request") item.merged = true;
          item.materialVersion += "-done";
          resolve({ status: "clean", summary: "Fixture completed." });
        });
      });
      return {
        processId: `process-${request.item.number}`,
        sessionId: `session-${request.item.number}`,
        sessionFile: `/sessions/${request.item.number}.jsonl`,
        completion,
        terminate: async () => undefined,
      };
    },
  };
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("full", [
      "auto-triage",
      "auto-grilling",
      "auto-implement",
      "auto-review",
    ]),
    actor: "automation-user",
    tracker,
    sessions,
    workspaces: fakeWorkspaces,
    clock: new ManualClock(),
  });

  await coordinator.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual([...releases.keys()].sort((left, right) => left - right), [21, 22, 23, 24]);
  assert.deepEqual(requests.map(({ item, skillName }) => [item.number, skillName]).sort((left, right) => Number(left[0]) - Number(right[0])), [
    [21, "triage"],
    [22, "grilling"],
    [23, "implement"],
    [24, "code-review"],
  ]);

  for (const release of releases.values()) release();
  await coordinator.waitForIdle();
  coordinator.interrupt();
  await coordinator.whenStopped();
});

test("five retained-session attempts exhaust only the failing item and an external update can reconsider it", async () => {
  const tracker = new FakeTracker([
    issue({ number: 31, labels: ["ready-for-agent"], materialVersion: "31-a" }),
    issue({ number: 32, labels: ["ready-for-agent"], materialVersion: "32-a" }),
  ]);
  const requests: TicketSessionRequest[] = [];
  let reconsidered = false;
  const sessions = new FakeTicketSessions((request) => {
    requests.push(request);
    const item = tracker.items.find((candidate) => candidate.number === request.item.number)!;
    if (request.item.number === 32 || reconsidered) {
      item.outputPullRequest = `https://github.com/owner/repository/pull/${request.item.number}`;
      item.materialVersion += "-delivered";
    }
  });
  const clock = new ManualClock();
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("half", ["auto-implement"]),
    actor: "automation-user",
    tracker,
    sessions,
    workspaces: fakeWorkspaces,
    clock,
  });

  await coordinator.start();
  await coordinator.waitForIdle();

  const failed = requests.filter((request) => request.item.number === 31);
  assert.equal(failed.length, 5);
  assert.deepEqual(failed.map((request) => request.attempt), [1, 2, 3, 4, 5]);
  assert.equal(failed[0]!.resumeSessionFile, undefined);
  assert.deepEqual(failed.slice(1).map((request) => request.resumeSessionFile), [
    "/sessions/31.jsonl",
    "/sessions/31.jsonl",
    "/sessions/31.jsonl",
    "/sessions/31.jsonl",
  ]);
  assert.equal(tracker.records.get("issue:31")?.lifecycle, "exhausted");
  assert.equal(tracker.records.get("issue:32")?.lifecycle, "succeeded");
  assert.equal(candidateFor(coordinator, 31)?.status, "exhausted");
  assert.equal(candidateFor(coordinator, 31)?.attempt, 5);
  assert.match(candidateFor(coordinator, 31)?.reason ?? "", /five attempts|evidence/i);
  assert.equal(coordinator.getProjection().totals.exhausted, 1);

  const exhausted = tracker.items.find((item) => item.number === 31)!;
  exhausted.materialVersion = "31-external-update";
  reconsidered = true;
  await clock.callback?.();
  await coordinator.waitForIdle();

  assert.equal(requests.filter((request) => request.item.number === 31).length, 6);
  assert.equal(tracker.records.get("issue:31")?.lifecycle, "succeeded");
  coordinator.interrupt();
  await coordinator.whenStopped();
});

test("Ticket Session launch failures are projected as retrying within the shared attempt budget", async () => {
  const tracker = new FakeTracker([issue({ number: 39, labels: ["ready-for-agent"], materialVersion: "39-a" })]);
  let releaseRetryRecord!: () => void;
  const retryRecordGate = new Promise<void>((resolve) => { releaseRetryRecord = resolve; });
  const originalUpsert = tracker.upsertBookkeeping.bind(tracker);
  tracker.upsertBookkeeping = async (record) => {
    if (record.lifecycle === "retrying" && record.attempt === 1) await retryRecordGate;
    await originalUpsert(record);
  };
  let starts = 0;
  let finishThirdAttempt!: () => void;
  const thirdAttempt = new Promise<{ status: "clean"; summary: string }>((resolve) => {
    finishThirdAttempt = () => {
      const item = tracker.items[0]!;
      item.outputPullRequest = "https://github.com/owner/repository/pull/39";
      item.materialVersion = "39-delivered";
      resolve({ status: "clean", summary: "Fixture completed." });
    };
  });
  const sessions: TicketSessionHost = {
    async start() {
      starts += 1;
      if (starts < 3) throw new Error(`spawn failed ${starts}`);
      return {
        processId: "process-39",
        sessionId: "session-39",
        sessionFile: "/sessions/39.jsonl",
        completion: thirdAttempt,
        terminate: async () => undefined,
      };
    },
  };
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("half", ["auto-implement"]),
    actor: "automation-user",
    tracker,
    sessions,
    workspaces: fakeWorkspaces,
    clock: new ManualClock(),
  });

  await coordinator.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(candidateFor(coordinator, 39)?.status, "retrying");
  assert.equal(candidateFor(coordinator, 39)?.attempt, 1);
  assert.match(candidateFor(coordinator, 39)?.reason ?? "", /spawn failed 1|retry/i);
  assert.equal(coordinator.getProjection().totals.retrying, 1);

  releaseRetryRecord();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(starts, 3);
  assert.equal(candidateFor(coordinator, 39)?.status, "running");
  assert.equal(candidateFor(coordinator, 39)?.attempt, 3);
  assert.equal(coordinator.getProjection().totals.active, 1);
  assert.equal(coordinator.getProjection().totals.retrying, 0);

  finishThirdAttempt();
  await coordinator.waitForIdle();

  assert.equal(tracker.records.get("issue:39")?.attempt, 3);
  assert.equal(tracker.records.get("issue:39")?.lifecycle, "succeeded");
  coordinator.interrupt();
  await coordinator.whenStopped();
});

test("a new Coordinator process resets a durable failed attempt budget", async () => {
  const recovered = issue({
    number: 40,
    labels: ["ready-for-agent"],
    assignees: ["automation-user"],
    materialVersion: "40-failed",
  });
  const tracker = new FakeTracker([recovered]);
  tracker.records.set("issue:40", {
    version: 1,
    item: { kind: "issue", number: 40, url: recovered.url },
    stage: "auto-implement",
    skillName: "implement",
    attempt: 4,
    lifecycle: "failed",
    materialVersion: recovered.materialVersion,
    diagnostic: "process disappeared",
  });
  const sessions = new FakeTicketSessions((request) => {
    assert.equal(request.attempt, 1);
    recovered.outputPullRequest = "https://github.com/owner/repository/pull/40";
    recovered.materialVersion = "40-delivered";
  });
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("half", ["auto-implement"]),
    actor: "automation-user",
    tracker,
    sessions,
    workspaces: fakeWorkspaces,
    clock: new ManualClock(),
  });

  await coordinator.start();
  await coordinator.waitForIdle();

  assert.equal(sessions.requests.length, 1);
  assert.equal(tracker.records.get("issue:40")?.attempt, 1);
  assert.equal(tracker.records.get("issue:40")?.lifecycle, "succeeded");
  coordinator.interrupt();
  await coordinator.whenStopped();
});

test("startup resumes recoverable bookkeeping before scanning for fresh claims", async () => {
  const recoveredItem = issue({
    number: 41,
    labels: ["ready-for-agent"],
    assignees: ["automation-user"],
    materialVersion: "41-a",
  });
  const tracker = new FakeTracker([recoveredItem]);
  tracker.records.set("issue:41", {
    version: 1,
    item: { kind: "issue", number: 41, url: recoveredItem.url },
    stage: "auto-implement",
    skillName: "implement",
    attempt: 3,
    lifecycle: "retrying",
    materialVersion: "41-a",
    sessionId: "session-41",
    sessionFile: "/sessions/41.jsonl",
  });
  const sessions = new FakeTicketSessions((request) => {
    const item = tracker.items[0]!;
    item.outputPullRequest = "https://github.com/owner/repository/pull/41";
    item.materialVersion = "41-b";
    assert.equal(request.attempt, 1);
    assert.equal(request.resumeSessionFile, "/sessions/41.jsonl");
  });
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("half", ["auto-implement"]),
    actor: "automation-user",
    tracker,
    sessions,
    workspaces: fakeWorkspaces,
    clock: new ManualClock(),
  });

  await coordinator.start();
  await coordinator.waitForIdle();

  assert.deepEqual(tracker.calls.slice(0, 3), ["list-bookkeeping", "read:issue:41", "snapshot"]);
  assert.equal(sessions.requests.length, 1);
  assert.equal(tracker.records.get("issue:41")?.lifecycle, "succeeded");
  coordinator.interrupt();
  await coordinator.whenStopped();
});

test("recovery finalizes tracker-complete work instead of redispatching it", async () => {
  const completed = issue({
    number: 42,
    labels: ["ready-for-agent"],
    assignees: ["automation-user"],
    state: "closed",
    materialVersion: "42-complete",
  });
  const tracker = new FakeTracker([completed]);
  tracker.records.set("issue:42", {
    version: 1,
    item: { kind: "issue", number: 42, url: completed.url },
    stage: "auto-implement",
    skillName: "implement",
    attempt: 2,
    lifecycle: "running",
    materialVersion: "42-before-crash",
  });
  const sessions = new FakeTicketSessions(() => { throw new Error("must not redispatch completed work"); });
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("half", ["auto-implement"]),
    actor: "automation-user",
    tracker,
    sessions,
    workspaces: fakeWorkspaces,
    clock: new ManualClock(),
  });

  await coordinator.start();
  await coordinator.waitForIdle();

  assert.equal(sessions.requests.length, 0);
  assert.equal(tracker.records.get("issue:42")?.lifecycle, "succeeded");
  coordinator.interrupt();
  await coordinator.whenStopped();
});

test("a new Coordinator process resets an exhausted attempt budget", async () => {
  const recovered = issue({
    number: 43,
    labels: ["ready-for-agent"],
    assignees: ["automation-user"],
    materialVersion: "43-attempt-5",
  });
  const tracker = new FakeTracker([recovered]);
  tracker.records.set("issue:43", {
    version: 1,
    item: { kind: "issue", number: 43, url: recovered.url },
    stage: "auto-implement",
    skillName: "implement",
    attempt: 5,
    lifecycle: "exhausted",
    materialVersion: recovered.materialVersion,
    sessionId: "session-43",
    sessionFile: "/sessions/43.jsonl",
  });
  const sessions = new FakeTicketSessions(() => {
    recovered.outputPullRequest = "https://github.com/owner/repository/pull/43";
    recovered.materialVersion = "43-complete";
  });
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("half", ["auto-implement"]),
    actor: "automation-user",
    tracker,
    sessions,
    workspaces: fakeWorkspaces,
    clock: new ManualClock(),
  });

  await coordinator.start();
  await coordinator.waitForIdle();

  assert.deepEqual(sessions.requests.map(({ attempt, resumeSessionFile }) => ({ attempt, resumeSessionFile })), [{
    attempt: 1,
    resumeSessionFile: "/sessions/43.jsonl",
  }]);
  assert.equal(tracker.records.get("issue:43")?.lifecycle, "succeeded");
  coordinator.interrupt();
  await coordinator.whenStopped();
});

test("Auto-Review requires merged proof and finalizes the project only after merge", async () => {
  const pullRequest: WorkflowItem = {
    kind: "pull-request",
    number: 44,
    url: "https://github.com/owner/repository/pull/44",
    state: "open",
    labels: [],
    assignees: [],
    blockedBy: 0,
    draft: false,
    merged: false,
    headSha: "0123456789abcdef0123456789abcdef01234567",
    headBranch: "automode/issue-44",
    headRepository: "owner/repository",
    updatedAt: "2026-01-01T00:00:00Z",
    materialVersion: "44-open",
  };
  const tracker = new FakeTracker([pullRequest]);
  let starts = 0;
  const sessions: TicketSessionHost = {
    async start(request) {
      starts += 1;
      pullRequest.state = "closed";
      pullRequest.merged = starts === 2;
      pullRequest.materialVersion = starts === 1 ? "44-closed-unmerged" : "44-merged";
      return {
        processId: `process-${starts}`,
        sessionId: "session-44",
        sessionFile: "/sessions/44.jsonl",
        completion: Promise.resolve({ status: "clean", summary: "Fixture completed." }),
        terminate: async () => undefined,
      };
    },
  };
  const finalizations: number[] = [];
  const workspaces = {
    ...fakeWorkspaces,
    async completeReview(item: WorkflowItem) { finalizations.push(item.number); },
  };
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("half", ["auto-review"]),
    actor: "automation-user",
    tracker,
    sessions,
    workspaces,
    clock: new ManualClock(),
  });

  await coordinator.start();
  await coordinator.waitForIdle();

  assert.equal(starts, 2);
  assert.deepEqual(finalizations, [44]);
  assert.equal(tracker.records.get("pull-request:44")?.lifecycle, "succeeded");
  coordinator.interrupt();
  await coordinator.whenStopped();
});

test("merged reviews expose finalization warnings without retrying or losing merge success", async () => {
  const item = issue({ kind: "pull-request", number: 153, draft: false, labels: [] });
  const tracker = new FakeTracker([item]);
  const sessions = new FakeTicketSessions(() => { item.state = "closed"; item.merged = true; });
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("half", ["auto-review"]),
    actor: "automation-user", tracker, sessions, clock: new ManualClock(),
    workspaces: {
      ...fakeWorkspaces,
      async completeReview() { throw new Error("Cleanup failed: Permission denied"); },
    },
  });
  await coordinator.start();
  await coordinator.waitForIdle();
  assert.equal(tracker.records.get("pull-request:153")?.lifecycle, "succeeded");
  assert.equal(sessions.requests.length, 1);
  assert.match(coordinator.getProjection().warnings?.[0]?.message ?? "", /Cleanup failed: Permission denied/u);
  assert.equal(coordinator.getProjection().warnings?.[0]?.item.number, 153);
  coordinator.interrupt();
  await coordinator.whenStopped();
});

test("relaunch restores persisted post-merge warnings without rerunning merged reviews", async () => {
  const tracker = new FakeTracker([]);
  tracker.records.set("pull-request:153", {
    version: 1,
    item: { kind: "pull-request", number: 153, url: "https://github.com/owner/repository/pull/153" },
    stage: "auto-review", skillName: "code-review", attempt: 1, lifecycle: "succeeded",
    materialVersion: "merged-153", diagnostic: "Merge succeeded but post-merge finalization failed: Permission denied",
  });
  const sessions = new FakeTicketSessions(() => {});
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("half", ["auto-review"]),
    actor: "automation-user", tracker, sessions, clock: new ManualClock(), workspaces: fakeWorkspaces,
  });
  await coordinator.start();
  assert.match(coordinator.getProjection().warnings?.[0]?.message ?? "", /Permission denied/u);
  assert.equal(sessions.requests.length, 0);
  coordinator.interrupt();
  await coordinator.whenStopped();
});

test("a failed root branch read is visible without presenting the old branch as current", async () => {
  let failRead = false;
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("half", ["auto-review"]),
    actor: "automation-user", tracker: new FakeTracker([]),
    sessions: new FakeTicketSessions(() => {}), clock: new ManualClock(),
    workspaces: {
      ...fakeWorkspaces,
      async readRootBranch() {
        if (failRead) throw new Error("Git branch lookup failed");
        return "main";
      },
    },
  });
  await coordinator.start();
  assert.equal(coordinator.getProjection().rootCheckout?.branch, "main");
  failRead = true;
  await coordinator.refresh();
  assert.deepEqual(coordinator.getProjection().rootCheckout, { error: "Git branch lookup failed" });
  failRead = false;
  await coordinator.refresh();
  assert.deepEqual(coordinator.getProjection().rootCheckout, { branch: "main" });
  coordinator.interrupt();
  await coordinator.whenStopped();
});

test("any waiting Ticket Session holds after one attempt and exposes its summary", async () => {
  const implementation = issue({
    number: 47,
    labels: ["ready-for-agent"],
    assignees: ["automation-user"],
    materialVersion: "47-initial",
  });
  const tracker = new FakeTracker([implementation]);
  const sessions = new FakeTicketSessions(() => undefined);
  sessions.start = async (request) => {
    sessions.requests.push(request);
    return {
      processId: "process-47",
      sessionId: "session-47",
      sessionFile: "/sessions/47.jsonl",
      completion: Promise.resolve({
        status: "waiting",
        summary: "The issue contract needs one substantive clarification.",
      }),
      terminate: async () => undefined,
    };
  };
  const clock = new ManualClock();
  const supervision: CoordinatorSupervisionEvent[] = [];
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("half", ["auto-implement"]),
    actor: "automation-user",
    tracker,
    sessions,
    workspaces: fakeWorkspaces,
    clock,
  });
  coordinator.subscribe((event) => supervision.push(event));

  await coordinator.start();
  await coordinator.waitForIdle();

  assert.equal(sessions.requests.length, 1);
  assert.equal(tracker.records.get("issue:47")?.lifecycle, "awaiting-feedback");
  assert.equal(tracker.records.get("issue:47")?.attempt, 1);
  assert.match(tracker.records.get("issue:47")?.diagnostic ?? "", /substantive clarification/);
  assert.equal(candidateFor(coordinator, 47)?.status, "waiting");
  assert.match(candidateFor(coordinator, 47)?.reason ?? "", /substantive clarification/);
  assert.ok(supervision.some((event) =>
    event.type === "activity" && /substantive clarification/.test(event.activity.message)
  ));

  await clock.callback?.();
  assert.equal(sessions.requests.length, 1);
  coordinator.interrupt();
  await coordinator.whenStopped();
});

test("waiting does not pin an item that changed Stage during the Ticket Session", async () => {
  const item = issue({ number: 48, labels: ["wayfinder:prototype"], materialVersion: "48-prototype" });
  const tracker = new FakeTracker([item]);
  const requests: TicketSessionRequest[] = [];
  const sessions: TicketSessionHost = {
    async start(request) {
      requests.push(request);
      if (request.skillName === "prototype") {
        item.labels = ["needs-triage"];
        item.assignees = [];
        item.materialVersion = "48-triage";
        return {
          processId: "process-prototype-48",
          sessionId: "session-prototype-48",
          sessionFile: "/sessions/prototype-48.jsonl",
          completion: Promise.resolve({
            status: "waiting" as const,
            summary: "Prototype feedback is required.",
          }),
          terminate: async () => undefined,
        };
      }
      item.state = "closed";
      item.materialVersion = "48-complete";
      return {
        processId: "process-triage-48",
        sessionId: "session-triage-48",
        sessionFile: "/sessions/triage-48.jsonl",
        completion: Promise.resolve({ status: "clean" as const, summary: "Triage completed." }),
        terminate: async () => undefined,
      };
    },
  };
  const clock = new ManualClock();
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("full", [
      "auto-triage", "auto-grilling", "auto-implement", "auto-review",
    ]),
    actor: "automation-user",
    tracker,
    sessions,
    workspaces: fakeWorkspaces,
    clock,
  });

  await coordinator.start();
  await coordinator.waitForIdle();
  assert.equal(tracker.records.get("issue:48")?.lifecycle, "failed");
  assert.equal(requests.length, 1);

  await clock.callback?.();
  await coordinator.waitForIdle();
  assert.deepEqual(requests.map(({ skillName }) => skillName), ["prototype", "triage"]);
  assert.equal(tracker.records.get("issue:48")?.lifecycle, "succeeded");
  coordinator.interrupt();
  await coordinator.whenStopped();
});

test("prototype waiting is idle until external material feedback resumes the same session", async () => {
  const prototype = issue({
    number: 45,
    labels: ["wayfinder:prototype"],
    materialVersion: "45-initial",
  });
  const tracker = new FakeTracker([prototype]);
  const requests: TicketSessionRequest[] = [];
  const sessions: TicketSessionHost = {
    async start(request) {
      requests.push(request);
      if (requests.length === 2) {
        prototype.state = "closed";
        prototype.materialVersion = "45-resolved";
      }
      return {
        processId: `process-${requests.length}`,
        sessionId: "prototype-session-45",
        sessionFile: "/sessions/prototype-45.jsonl",
        completion: Promise.resolve(
          requests.length === 1 ? { status: "waiting" as const, summary: "Waiting for feedback." } : { status: "clean" as const, summary: "Fixture completed." },
        ),
        terminate: async () => undefined,
      };
    },
  };
  const clock = new ManualClock();
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("half", ["auto-implement"]),
    actor: "automation-user",
    tracker,
    sessions,
    workspaces: fakeWorkspaces,
    clock,
  });

  await coordinator.start();
  await coordinator.waitForIdle();
  assert.equal(tracker.records.get("issue:45")?.lifecycle, "awaiting-feedback");
  assert.equal(candidateFor(coordinator, 45)?.status, "waiting");
  assert.match(candidateFor(coordinator, 45)?.reason ?? "", /material tracker change|waiting for feedback/i);
  assert.equal(
    coordinator.getProjection().lanes.find((lane) => lane.stage === "auto-implement")?.totals.held,
    1,
  );
  await clock.callback?.();
  assert.equal(requests.length, 1);

  prototype.materialVersion = "45-external-feedback";
  await clock.callback?.();
  await coordinator.waitForIdle();

  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.attempt, 1);
  assert.equal(requests[1]!.resumeSessionFile, "/sessions/prototype-45.jsonl");
  assert.equal(tracker.records.get("issue:45")?.lifecycle, "succeeded");
  coordinator.interrupt();
  await coordinator.whenStopped();
});

test("material feedback that changes Stage precedence leaves the old waiting session and dispatches the new Stage", async () => {
  const item = issue({ number: 46, labels: ["wayfinder:prototype"], materialVersion: "46-prototype" });
  const tracker = new FakeTracker([item]);
  const requests: TicketSessionRequest[] = [];
  const sessions: TicketSessionHost = {
    async start(request) {
      requests.push(request);
      if (request.skillName === "triage") {
        item.state = "closed";
        item.materialVersion = "46-settled";
      }
      return {
        processId: `process-${requests.length}`,
        sessionId: `session-${requests.length}`,
        sessionFile: `/sessions/${requests.length}.jsonl`,
        completion: Promise.resolve(
          request.skillName === "prototype" ? { status: "waiting" as const, summary: "Waiting for feedback." } : { status: "clean" as const, summary: "Fixture completed." },
        ),
        terminate: async () => undefined,
      };
    },
  };
  const clock = new ManualClock();
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("full", [
      "auto-triage", "auto-grilling", "auto-implement", "auto-review",
    ]),
    actor: "automation-user",
    tracker,
    sessions,
    workspaces: fakeWorkspaces,
    clock,
  });

  await coordinator.start();
  await coordinator.waitForIdle();
  item.labels = ["needs-triage"];
  item.assignees = [];
  item.materialVersion = "46-needs-triage";
  await clock.callback?.();
  await coordinator.waitForIdle();

  assert.deepEqual(requests.map(({ skillName, attempt, resumeSessionFile }) => ({
    skillName, attempt, resumeSessionFile,
  })), [
    { skillName: "prototype", attempt: 1, resumeSessionFile: undefined },
    { skillName: "triage", attempt: 1, resumeSessionFile: undefined },
  ]);
  coordinator.interrupt();
  await coordinator.whenStopped();
});

test("the first interrupt drains without retry and the second forces active Ticket Sessions", async () => {
  const tracker = new FakeTracker([issue({ number: 51, labels: ["ready-for-agent"], materialVersion: "51-a" })]);
  let complete!: (result: { status: "error"; error: string }) => void;
  const completion = new Promise<{ status: "error"; error: string }>((resolve) => { complete = resolve; });
  const terminations: boolean[] = [];
  const sessions: TicketSessionHost = {
    async start(request) {
      return {
        processId: `process-${request.item.number}`,
        sessionId: `session-${request.item.number}`,
        sessionFile: `/sessions/${request.item.number}.jsonl`,
        completion,
        async terminate(force) {
          terminations.push(force);
          complete({ status: "error", error: "forced" });
        },
      };
    },
  };
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("half", ["auto-implement"]),
    actor: "automation-user",
    tracker,
    sessions,
    workspaces: fakeWorkspaces,
    clock: new ManualClock(),
  });

  await coordinator.start();
  assert.equal(coordinator.interrupt(), "draining");
  assert.equal(
    coordinator.getProjection().lanes.find((lane) => lane.stage === "auto-implement")?.operatingState,
    "DRAINING",
  );
  assert.deepEqual(terminations, []);
  assert.equal(coordinator.interrupt(), "forcing");
  await coordinator.whenStopped();

  assert.equal(
    coordinator.getProjection().lanes.find((lane) => lane.stage === "auto-implement")?.operatingState,
    "OFF",
  );
  assert.deepEqual(terminations, [true]);
});

test("the second interrupt force-stops a Ticket Session that has not reported ready", async () => {
  const tracker = new FakeTracker([issue({ number: 52, labels: ["ready-for-agent"], materialVersion: "52-a" })]);
  let rejectStarting!: (error: Error) => void;
  let started = false;
  const forced: Array<{ key: string; force: boolean }> = [];
  const sessions: TicketSessionHost = {
    async start(): Promise<TicketSessionHandle> {
      started = true;
      return new Promise<TicketSessionHandle>((_resolve, reject) => { rejectStarting = reject; });
    },
    async terminateStarting(key, force) {
      forced.push({ key, force });
      rejectStarting(new Error("forced before ready"));
    },
  };
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("half", ["auto-implement"]),
    actor: "automation-user",
    tracker,
    sessions,
    workspaces: fakeWorkspaces,
    clock: new ManualClock(),
  });

  await coordinator.start();
  while (!started) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(coordinator.interrupt(), "draining");
  assert.equal(coordinator.interrupt(), "forcing");
  await coordinator.whenStopped();
  assert.deepEqual(forced, [{ key: "issue:52", force: true }]);
});
