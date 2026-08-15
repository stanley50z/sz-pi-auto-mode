import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AutomodeTicketSessionHost,
  TicketSessionHost,
  type TicketSessionProcess,
  type TicketSessionProcessLauncher,
  type TicketSessionStartMessage,
} from "../src/ticket-session.js";
import {
  createControlledTicketSession,
  runTicketSessionChild,
  type TicketSessionChildSession,
} from "../src/ticket-session-main.js";
import { createAutomationStageConfiguration } from "../src/stage-configuration.js";

async function sendFixtureMessage(message: unknown): Promise<void> {
  if (!process.send) throw new Error("Ticket Session fixture child requires IPC");
  await new Promise<void>((resolveSend, rejectSend) => {
    process.send!(message, (error: Error | null) => {
      if (error) rejectSend(error);
      else resolveSend();
    });
  });
}

async function runFixtureChild(): Promise<void> {
  const message = await new Promise<unknown>((resolveMessage) => process.once("message", resolveMessage));
  const start = message as TicketSessionStartMessage;
  if (start.type !== "ticket-session:start" || start.version !== 1) {
    throw new Error("Fixture child received invalid start request");
  }
  const sessionId = "fixture-persistent-session";
  const sessionFile = join(process.cwd(), "fixture-ticket-session.jsonl");
  writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: sessionId, cwd: process.cwd() })}\n`);
  let activity: ((event: { activity: string }) => void) | undefined;
  let sends = Promise.resolve();
  const result = await runTicketSessionChild(start.request, async () => ({
    sessionId,
    sessionFile,
    subscribe(listener) {
      activity = listener;
      return () => { activity = undefined; };
    },
    async prompt(prompt) {
      appendFileSync(sessionFile, `${JSON.stringify({ type: "prompt", prompt })}\n`);
      activity?.({ activity: "agent_settled" });
      return "clean";
    },
    async abort() {},
    dispose() {},
  }), (event) => {
    sends = sends.then(() => sendFixtureMessage({ type: "ticket-session:event", version: 1, event }));
  });
  await sends;
  await sendFixtureMessage({ type: "ticket-session:terminal", version: 1, result });
  process.disconnect();
}

if (process.env.AUTOMODE_TICKET_SESSION_FIXTURE_CHILD === "1") {
  await runFixtureChild();
} else {

class FakeTicketProcess extends EventEmitter implements TicketSessionProcess {
  readonly pid = 4242;
  readonly sent: unknown[] = [];
  readonly killed: NodeJS.Signals[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  send(message: unknown, callback: (error: Error | null) => void): boolean {
    this.sent.push(message);
    callback(null);
    return true;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed.push(signal);
    return true;
  }
}

const configuration = createAutomationStageConfiguration("half", ["auto-triage"]);

test("TicketSessionHost launches one child in the actual item cwd with deterministic canonical dispatch", async () => {
  const cwd = join(mkdtempSync(join(tmpdir(), "ticket-host-")), "worktree");
  mkdirSync(cwd);
  const child = new FakeTicketProcess();
  const launches: Parameters<TicketSessionProcessLauncher>[0][] = [];
  const launcher: TicketSessionProcessLauncher = (options) => {
    launches.push(options);
    return child;
  };
  const host = new TicketSessionHost({
    childEntrypoint: join(cwd, "ticket-session-main.js"),
    launcher,
  });

  const run = host.launch({
    cwd,
    skillName: "triage",
    itemUrl: "https://github.com/owner/repository/issues/17",
    configuration,
    sessionName: "Auto-Triage #17",
  });

  assert.equal(launches.length, 1);
  assert.equal(launches[0]!.cwd, cwd);
  assert.equal(launches[0]!.entrypoint, join(cwd, "ticket-session-main.js"));
  assert.deepEqual(child.sent, [{
    type: "ticket-session:start",
    version: 1,
    request: {
      cwd,
      skillName: "triage",
      itemUrl: "https://github.com/owner/repository/issues/17",
      prompt: "/skill:triage https://github.com/owner/repository/issues/17",
      configuration,
      sessionName: "Auto-Triage #17",
    },
  }]);

  child.emit("message", {
    type: "ticket-session:terminal",
    version: 1,
    result: {
      status: "clean",
      sessionId: "session-17",
      sessionFile: join(cwd, "session-17.jsonl"),
    },
  });
  child.exitCode = 0;
  child.emit("exit", 0, null);
  assert.deepEqual(await run.completion, {
    status: "clean",
    sessionId: "session-17",
    sessionFile: join(cwd, "session-17.jsonl"),
    exitCode: 0,
    signal: null,
  });
});

test("Coordinator recovery starts replacement history when the recorded session file is gone", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ticket-missing-history-"));
  mkdirSync(join(cwd, ".git"));
  const child = new FakeTicketProcess();
  const processHost = new TicketSessionHost({
    childEntrypoint: join(cwd, "ticket-session-main.js"),
    launcher: () => child,
  });
  const adapter = new AutomodeTicketSessionHost({
    repository: cwd,
    configuration,
    processHost,
  });

  const starting = adapter.start({
    item: { kind: "issue", number: 170, url: "https://github.com/owner/repository/issues/170" },
    stage: "auto-triage",
    skillName: "triage",
    attempt: 2,
    resumeSessionFile: join(cwd, "missing-session.jsonl"),
  });
  child.emit("message", {
    type: "ticket-session:event",
    version: 1,
    event: {
      type: "lifecycle",
      state: "ready",
      timestamp: Date.now(),
      sessionId: "replacement-session",
      sessionFile: join(cwd, "replacement-session.jsonl"),
    },
  });
  const handle = await starting;
  const sent = child.sent[0] as TicketSessionStartMessage;

  assert.equal(sent.request.resumeSessionFile, undefined);
  assert.equal(handle.sessionId, "replacement-session");
  child.emit("message", {
    type: "ticket-session:terminal",
    version: 1,
    result: {
      status: "clean",
      sessionId: "replacement-session",
      sessionFile: join(cwd, "replacement-session.jsonl"),
    },
  });
  child.exitCode = 0;
  child.emit("exit", 0, null);
  await handle.completion;
});

test("the child reports persistent identity and structured activity around one canonical prompt", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ticket-child-"));
  const sessionFile = join(cwd, "session.jsonl");
  const prompts: string[] = [];
  let activityListener: ((activity: { activity: string; toolName?: string; isError?: boolean }) => void) | undefined;
  let disposed = false;
  const session: TicketSessionChildSession = {
    sessionId: "durable-session",
    sessionFile,
    subscribe(listener) {
      activityListener = listener;
      return () => { activityListener = undefined; };
    },
    async prompt(prompt) {
      prompts.push(prompt);
      activityListener?.({ activity: "tool_execution_start", toolName: "read" });
      return "clean";
    },
    async abort() {},
    dispose() { disposed = true; },
  };
  const events: unknown[] = [];

  const result = await runTicketSessionChild({
    cwd,
    skillName: "triage",
    itemUrl: "https://github.com/owner/repository/issues/18",
    prompt: "/skill:triage https://github.com/owner/repository/issues/18",
    configuration,
  }, async () => session, (event) => events.push(event), { cwd });

  assert.deepEqual(prompts, ["/skill:triage https://github.com/owner/repository/issues/18"]);
  assert.deepEqual(events.map((event) => (event as { type: string }).type), [
    "lifecycle",
    "lifecycle",
    "lifecycle",
    "activity",
  ]);
  assert.deepEqual(events[1], {
    type: "lifecycle",
    state: "ready",
    timestamp: (events[1] as { timestamp: number }).timestamp,
    sessionId: "durable-session",
    sessionFile,
  });
  assert.deepEqual(result, {
    status: "clean",
    sessionId: "durable-session",
    sessionFile,
  });
  assert.equal(disposed, true);
});

test("terminate is idempotent and forces a child that does not stop gracefully", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ticket-terminate-"));
  const child = new FakeTicketProcess();
  const host = new TicketSessionHost({
    childEntrypoint: join(cwd, "ticket-session-main.js"),
    launcher: () => child,
    terminationGraceMs: 5,
  });
  const run = host.launch({
    cwd,
    skillName: "triage",
    itemUrl: "https://github.com/owner/repository/issues/19",
    configuration,
  });

  const first = run.terminate();
  const second = run.terminate();
  assert.equal(first, second);
  assert.equal(child.sent.filter((message) =>
    (message as { type?: string }).type === "ticket-session:terminate").length, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(child.killed, ["SIGKILL"]);

  child.signalCode = "SIGKILL";
  child.emit("exit", null, "SIGKILL");
  const result = await first;
  assert.equal(result.status, "error");
  assert.match(result.error!, /without a terminal result/);
});

test("graceful termination aborts and disposes the controlled child session", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ticket-graceful-"));
  const controller = new AbortController();
  let aborted = 0;
  let disposed = 0;
  const running = runTicketSessionChild({
    cwd,
    skillName: "triage",
    itemUrl: "https://github.com/owner/repository/issues/20",
    prompt: "/skill:triage https://github.com/owner/repository/issues/20",
    configuration,
  }, async () => ({
    sessionId: "graceful-session",
    sessionFile: join(cwd, "graceful-session.jsonl"),
    subscribe: () => () => {},
    prompt: () => new Promise<"clean">(() => {}),
    async abort() { aborted += 1; },
    dispose() { disposed += 1; },
  }), () => {}, { cwd, signal: controller.signal });

  controller.abort();
  const result = await running;
  assert.equal(result.status, "error");
  assert.match(result.error!, /terminated/);
  assert.equal(aborted, 1);
  assert.equal(disposed, 1);
});

test("the child returns an explicit error terminal result when the controlled turn fails", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ticket-error-"));
  let disposed = false;
  const result = await runTicketSessionChild({
    cwd,
    skillName: "triage",
    itemUrl: "https://github.com/owner/repository/issues/20",
    prompt: "/skill:triage https://github.com/owner/repository/issues/20",
    configuration,
  }, async () => ({
    sessionId: "failed-session",
    sessionFile: join(cwd, "failed-session.jsonl"),
    subscribe: () => () => {},
    async prompt() { throw new Error("model turn failed"); },
    async abort() {},
    dispose() { disposed = true; },
  }), () => {}, { cwd });

  assert.equal(result.status, "error");
  assert.equal(result.sessionId, "failed-session");
  assert.match(result.error!, /model turn failed/);
  assert.equal(disposed, true);
});

test("an exact persisted session file can resume and settle waiting", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ticket-resume-"));
  const sessionFile = join(cwd, "existing-session.jsonl");
  writeFileSync(sessionFile, "persisted session fixture\n");
  let receivedResume: string | undefined;

  const result = await runTicketSessionChild({
    cwd,
    skillName: "prototype",
    itemUrl: "https://github.com/owner/repository/issues/21",
    prompt: "/skill:prototype https://github.com/owner/repository/issues/21",
    configuration: createAutomationStageConfiguration("half", ["auto-implement"]),
    resumeSessionFile: sessionFile,
  }, async (request) => {
    receivedResume = request.resumeSessionFile;
    return {
      sessionId: "persisted-session-id",
      sessionFile,
      subscribe: () => () => {},
      async prompt() { return "waiting"; },
      async abort() {},
      dispose() {},
    };
  }, () => {}, { cwd });

  assert.equal(receivedResume, sessionFile);
  assert.deepEqual(result, {
    status: "waiting",
    sessionId: "persisted-session-id",
    sessionFile,
  });
});

test("the production child adapter rejects a skill not owned by an enabled stage", async () => {
  await assert.rejects(
    () => createControlledTicketSession({
      cwd: process.cwd(),
      skillName: "triage",
      itemUrl: "https://github.com/owner/repository/issues/22",
      prompt: "/skill:triage https://github.com/owner/repository/issues/22",
      configuration: createAutomationStageConfiguration("half", ["auto-review"]),
    }),
    /not owned by an enabled Automation Stage/,
  );
});

test("the public host seam completes a full child-process run with persistent history", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ticket-process-e2e-"));
  mkdirSync(join(cwd, ".git"));
  const events: unknown[] = [];
  const host = new TicketSessionHost({
    childEntrypoint: fileURLToPath(import.meta.url),
    env: { ...process.env, AUTOMODE_TICKET_SESSION_FIXTURE_CHILD: "1" },
  });
  const run = host.launch({
    cwd,
    skillName: "triage",
    itemUrl: "https://github.com/owner/repository/issues/22",
    configuration,
  });
  run.subscribe((event) => events.push(event));

  const result = await run.completion;
  assert.equal(result.status, "clean");
  assert.equal(result.sessionId, "fixture-persistent-session");
  assert.ok(result.sessionFile);
  assert.equal(existsSync(result.sessionFile!), true);
  assert.match(
    readFileSync(result.sessionFile!, "utf8"),
    /\/skill:triage https:\/\/github\.com\/owner\/repository\/issues\/22/,
  );
  assert.notEqual(run.processId, process.pid);
  assert.equal(events.some((event) =>
    (event as { type?: string; state?: string }).type === "lifecycle"
    && (event as { state?: string }).state === "ready"), true);
  assert.equal(events.some((event) =>
    (event as { type?: string; activity?: string }).type === "activity"
    && (event as { activity?: string }).activity === "agent_settled"), true);
});

}
