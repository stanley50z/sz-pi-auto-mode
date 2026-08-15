import assert from "node:assert/strict";
import test from "node:test";
import {
  AutomodeCoordinator,
  type BookkeepingRecord,
  type CoordinatorClock,
  type CoordinatorTracker,
  type TicketSessionHandle,
  type TicketSessionHost,
  type TicketSessionRequest,
  type TicketWorkspaceManager,
  type WorkflowItem,
  type WorkflowSnapshot,
} from "../src/coordinator.js";
import { createAutomationStageConfiguration } from "../src/stage-configuration.js";

class ManualClock implements CoordinatorClock {
  callback: (() => void | Promise<void>) | undefined;
  interval: number | undefined;

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
      completion: Promise.resolve({ status: "clean" }),
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
      const completion = new Promise<{ status: "clean" }>((resolve) => {
        releases.set(request.item.number, () => {
          const item = tracker.items.find((candidate) => candidate.number === request.item.number)!;
          item.state = "closed";
          if (item.kind === "pull-request") item.merged = true;
          item.materialVersion += "-done";
          resolve({ status: "clean" });
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

test("Ticket Session launch failures consume the same five-attempt budget and retry", async () => {
  const tracker = new FakeTracker([issue({ number: 39, labels: ["ready-for-agent"], materialVersion: "39-a" })]);
  let starts = 0;
  const sessions: TicketSessionHost = {
    async start(request) {
      starts += 1;
      if (starts < 3) throw new Error(`spawn failed ${starts}`);
      const item = tracker.items[0]!;
      item.outputPullRequest = "https://github.com/owner/repository/pull/39";
      item.materialVersion = "39-delivered";
      return {
        processId: "process-39",
        sessionId: "session-39",
        sessionFile: "/sessions/39.jsonl",
        completion: Promise.resolve({ status: "clean" }),
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
  await coordinator.waitForIdle();

  assert.equal(starts, 3);
  assert.equal(tracker.records.get("issue:39")?.attempt, 3);
  assert.equal(tracker.records.get("issue:39")?.lifecycle, "succeeded");
  coordinator.interrupt();
  await coordinator.whenStopped();
});

test("a durable failed record resumes at the next attempt instead of resetting", async () => {
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
    assert.equal(request.attempt, 5);
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
  assert.equal(tracker.records.get("issue:40")?.attempt, 5);
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
    assert.equal(request.attempt, 4);
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

test("recovery never resets a durable fifth attempt", async () => {
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
    lifecycle: "running",
    materialVersion: recovered.materialVersion,
  });
  const sessions = new FakeTicketSessions(() => { throw new Error("must not relaunch"); });
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
  assert.equal(tracker.records.get("issue:43")?.lifecycle, "exhausted");
  coordinator.interrupt();
  await coordinator.whenStopped();
});

test("Auto-Review requires merged proof and reports cleanup only after merge", async () => {
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
        completion: Promise.resolve({ status: "clean" }),
        terminate: async () => undefined,
      };
    },
  };
  const cleanups: number[] = [];
  const workspaces = {
    ...fakeWorkspaces,
    async completeReview(item: WorkflowItem) { cleanups.push(item.number); },
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
  assert.deepEqual(cleanups, [44]);
  assert.equal(tracker.records.get("pull-request:44")?.lifecycle, "succeeded");
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
          requests.length === 1 ? { status: "waiting" as const } : { status: "clean" as const },
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
  assert.deepEqual(terminations, []);
  assert.equal(coordinator.interrupt(), "forcing");
  await coordinator.whenStopped();

  assert.deepEqual(terminations, [true]);
});
