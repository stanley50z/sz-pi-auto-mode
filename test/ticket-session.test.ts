import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AutomodeTicketSessionHost,
  TICKET_SESSION_PROTOCOL_VERSION,
  TicketSessionHost,
  type TicketSessionProcess,
  type TicketSessionProcessLauncher,
  type TicketSessionStartMessage,
} from "../src/ticket-session.js";
import {
  createControlledTicketSession,
  runTicketSessionChild,
  ticketSessionActivityFromAgentEvent,
  type TicketSessionChildActivity,
  type TicketSessionChildSession,
} from "../src/ticket-session-main.js";
import { resolveAutomodePaths } from "../src/paths.js";
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
  if (start.type !== "ticket-session:start" || start.version !== TICKET_SESSION_PROTOCOL_VERSION) {
    throw new Error("Fixture child received invalid start request");
  }
  const sessionId = "fixture-persistent-session";
  const sessionDir = start.request.home
    ? resolveAutomodePaths(process.cwd(), start.request.home, start.request.normalAgentDir).sessionDir
    : process.cwd();
  mkdirSync(sessionDir, { recursive: true });
  const sessionFile = join(sessionDir, "fixture-ticket-session.jsonl");
  let activity: ((event: TicketSessionChildActivity) => void) | undefined;
  let sends = Promise.resolve();
  const result = await runTicketSessionChild(start.request, async () => ({
    sessionId,
    sessionFile,
    subscribe(listener) {
      activity = listener;
      return () => { activity = undefined; };
    },
    async prompt(prompt) {
      const promptRelease = process.env.AUTOMODE_TICKET_SESSION_PROMPT_RELEASE;
      while (promptRelease && !existsSync(promptRelease)) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
      }
      writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: process.cwd() })}\n`);
      appendFileSync(sessionFile, `${JSON.stringify({ type: "prompt", prompt })}\n`);
      activity?.({ activity: "Fixture completed.", kind: "assistant" });
      return { status: "clean", summary: "Fixture completed." };
    },
    async abort() {},
    dispose() {},
  }), (event) => {
    sends = sends.then(() => sendFixtureMessage({ type: "ticket-session:event", version: TICKET_SESSION_PROTOCOL_VERSION, event }));
  });
  await sends;
  await sendFixtureMessage({ type: "ticket-session:terminal", version: TICKET_SESSION_PROTOCOL_VERSION, result });
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
    version: TICKET_SESSION_PROTOCOL_VERSION,
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
    version: TICKET_SESSION_PROTOCOL_VERSION,
    result: {
      status: "clean",
      sessionId: "session-17",
      sessionFile: join(cwd, "session-17.jsonl"),
      summary: "Triage completed.",
    },
  });
  child.exitCode = 0;
  child.emit("exit", 0, null);
  assert.deepEqual(await run.completion, {
    status: "clean",
    sessionId: "session-17",
    sessionFile: join(cwd, "session-17.jsonl"),
    summary: "Triage completed.",
    exitCode: 0,
    signal: null,
  });
});

test("the production host requires a Coordinator restart after its Ticket Session runtime changes", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ticket-runtime-change-"));
  const childEntrypoint = join(cwd, "ticket-session-main.js");
  writeFileSync(childEntrypoint, "// runtime version one\n");
  const host = new TicketSessionHost({ childEntrypoint, env: {} });
  writeFileSync(childEntrypoint, "// runtime version two\n");

  assert.throws(() => host.launch({
    cwd,
    skillName: "triage",
    itemUrl: "https://github.com/owner/repository/issues/171",
    configuration,
  }), /Ticket Session runtime changed.*restart Automode/i);
});

test("the Ticket Session protocol rejects a tool summary without a positive count", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ticket-invalid-tools-"));
  const child = new FakeTicketProcess();
  const host = new TicketSessionHost({
    childEntrypoint: join(cwd, "ticket-session-main.js"),
    launcher: () => child,
  });
  const run = host.launch({
    cwd,
    skillName: "triage",
    itemUrl: "https://github.com/owner/repository/issues/170",
    configuration,
  });
  child.emit("message", {
    type: "ticket-session:event",
    version: TICKET_SESSION_PROTOCOL_VERSION,
    event: {
      type: "lifecycle",
      state: "ready",
      timestamp: Date.now(),
      sessionId: "session-170",
      sessionFile: join(cwd, "session-170.jsonl"),
    },
  });
  await run.ready;

  child.emit("message", {
    type: "ticket-session:event",
    version: TICKET_SESSION_PROTOCOL_VERSION,
    event: {
      type: "activity",
      activity: "+ tool calls",
      timestamp: Date.now(),
      kind: "tools",
    },
  });
  assert.deepEqual(child.killed, ["SIGKILL"]);
  child.signalCode = "SIGKILL";
  child.emit("exit", null, "SIGKILL");
  assert.match((await run.completion).error ?? "", /invalid protocol message/);
});

test("Coordinator recovery replaces mismatched in-root session history instead of importing its context", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ticket-missing-history-"));
  mkdirSync(join(cwd, ".git"));
  const home = join(cwd, "home");
  const sessionDir = resolveAutomodePaths(cwd, home).sessionDir;
  mkdirSync(sessionDir, { recursive: true });
  const replacementSessionFile = join(sessionDir, "replacement-session.jsonl");
  writeFileSync(replacementSessionFile, `${JSON.stringify({
    type: "session", version: 3, id: "replacement-session", timestamp: "2026-08-17T12:00:00.000Z", cwd,
  })}\n`);
  const foreignSessionFile = join(sessionDir, "foreign-session.jsonl");
  writeFileSync(foreignSessionFile, `${JSON.stringify({
    type: "session", version: 3, id: "foreign-session", timestamp: "2026-08-17T11:00:00.000Z", cwd,
  })}\n`);
  const child = new FakeTicketProcess();
  const processHost = new TicketSessionHost({
    childEntrypoint: join(cwd, "ticket-session-main.js"),
    launcher: () => child,
  });
  const adapter = new AutomodeTicketSessionHost({
    repository: cwd,
    configuration,
    home,
    processHost,
  });

  const starting = adapter.start({
    item: { kind: "issue", number: 170, url: "https://github.com/owner/repository/issues/170" },
    stage: "auto-triage",
    skillName: "triage",
    attempt: 2,
    resumeSessionFile: foreignSessionFile,
    resumeSessionId: "replacement-session",
  });
  child.emit("message", {
    type: "ticket-session:event",
    version: TICKET_SESSION_PROTOCOL_VERSION,
    event: {
      type: "lifecycle",
      state: "ready",
      timestamp: Date.now(),
      sessionId: "replacement-session",
      sessionFile: replacementSessionFile,
    },
  });
  const handle = await starting;
  const sent = child.sent[0] as TicketSessionStartMessage;

  assert.equal(sent.request.resumeSessionFile, undefined);
  assert.equal(handle.sessionId, "replacement-session");
  child.emit("message", {
    type: "ticket-session:terminal",
    version: TICKET_SESSION_PROTOCOL_VERSION,
    result: {
      status: "clean",
      sessionId: "replacement-session",
      sessionFile: replacementSessionFile,
      summary: "Replacement completed.",
    },
  });
  child.exitCode = 0;
  child.emit("exit", 0, null);
  await handle.completion;
});

test("a fresh Ticket Session validates its persisted identity before reporting success", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ticket-fresh-identity-"));
  mkdirSync(join(cwd, ".git"));
  const home = join(cwd, "home");
  const sessionDir = resolveAutomodePaths(cwd, home).sessionDir;
  mkdirSync(sessionDir, { recursive: true });
  const sessionFile = join(sessionDir, "fresh-session.jsonl");
  const child = new FakeTicketProcess();
  const adapter = new AutomodeTicketSessionHost({
    repository: cwd,
    configuration,
    home,
    processHost: new TicketSessionHost({
      childEntrypoint: join(cwd, "ticket-session-main.js"),
      launcher: () => child,
    }),
  });

  const starting = adapter.start({
    item: { kind: "issue", number: 45, url: "https://github.com/owner/repository/issues/45" },
    stage: "auto-implement",
    skillName: "implement",
    attempt: 1,
  });
  child.emit("message", {
    type: "ticket-session:event",
    version: TICKET_SESSION_PROTOCOL_VERSION,
    event: {
      type: "lifecycle",
      state: "ready",
      timestamp: Date.now(),
      sessionId: "fresh-session",
      sessionFile,
    },
  });
  const handle = await starting;

  writeFileSync(sessionFile, `${JSON.stringify({
    type: "session", version: 3, id: "different-session", timestamp: "2026-08-17T12:00:00.000Z", cwd,
  })}\n`);
  child.emit("message", {
    type: "ticket-session:terminal",
    version: TICKET_SESSION_PROTOCOL_VERSION,
    result: { status: "clean", sessionId: "fresh-session", sessionFile, summary: "Implementation completed." },
  });
  child.exitCode = 0;
  child.emit("exit", 0, null);

  assert.deepEqual(await handle.completion, {
    status: "error",
    error: "Ticket Session persisted history could not be validated: Ticket Session history identity does not match the ready event",
  });
});

test("the Coordinator host exposes persisted Pi history and future structured activity read-only", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ticket-history-view-"));
  mkdirSync(join(cwd, ".git"));
  const home = join(cwd, "home");
  const sessionDir = resolveAutomodePaths(cwd, home).sessionDir;
  mkdirSync(sessionDir, { recursive: true });
  const sessionFile = join(sessionDir, "persisted-session.jsonl");
  writeFileSync(sessionFile, [
    JSON.stringify({ type: "session", version: 3, id: "session-history", timestamp: "2026-08-17T11:59:00.000Z", cwd }),
    JSON.stringify({ type: "message", id: "entry001", parentId: null, timestamp: "2026-08-17T11:59:01.000Z", message: { role: "user", content: "/skill:implement https://github.com/owner/repository/issues/45", timestamp: 1 } }),
    JSON.stringify({ type: "message", id: "entry002", parentId: "entry001", timestamp: "2026-08-17T11:59:02.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "**Reading the repository**" }, { type: "toolCall", id: "read-1", name: "read", arguments: { path: "CONTEXT.md" } }], timestamp: 2 } }),
    JSON.stringify({ type: "message", id: "entry003", parentId: "entry002", timestamp: "2026-08-17T11:59:03.000Z", message: { role: "user", content: "/skill:implement https://github.com/owner/repository/issues/45", timestamp: 3 } }),
    JSON.stringify({ type: "message", id: "entry004", parentId: "entry003", timestamp: "2026-08-17T11:59:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "Resuming the retry." }, { type: "toolCall", id: "read-2", name: "read", arguments: { path: "src/app.ts" } }, { type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "npm test" } }], timestamp: 4 } }),
  ].join("\n") + "\n");
  const child = new FakeTicketProcess();
  const processHost = new TicketSessionHost({
    childEntrypoint: join(cwd, "ticket-session-main.js"),
    launcher: () => child,
  });
  const adapter = new AutomodeTicketSessionHost({
    repository: cwd,
    configuration,
    home,
    processHost,
  });

  const starting = adapter.start({
    item: { kind: "issue", number: 45, url: "https://github.com/owner/repository/issues/45" },
    stage: "auto-implement",
    skillName: "implement",
    attempt: 2,
    resumeSessionFile: sessionFile,
    resumeSessionId: "session-history",
  });
  child.emit("message", {
    type: "ticket-session:event",
    version: TICKET_SESSION_PROTOCOL_VERSION,
    event: {
      type: "lifecycle",
      state: "ready",
      timestamp: Date.parse("2026-08-17T12:00:00.000Z"),
      sessionId: "session-history",
      sessionFile,
    },
  });
  const handle = await starting;
  assert.equal((child.sent[0] as TicketSessionStartMessage).request.resumeSessionFile, realpathSync(sessionFile));
  assert.deepEqual(handle.history?.map(({ attempt, kind, message, toolCount }) => ({ attempt, kind, message, toolCount })), [
    { attempt: 1, kind: "thinking", message: "**Reading the repository**", toolCount: 1 },
    { attempt: 2, kind: "assistant", message: "Resuming the retry.", toolCount: 2 },
  ]);

  const observed: unknown[] = [];
  const unsubscribe = handle.subscribe?.((activity) => observed.push(activity));
  child.emit("message", {
    type: "ticket-session:event",
    version: TICKET_SESSION_PROTOCOL_VERSION,
    event: {
      type: "activity",
      activity: "**Reviewing code consistency and diffs**",
      timestamp: Date.parse("2026-08-17T12:00:01.000Z"),
      kind: "thinking",
      toolCount: 2,
    },
  });
  assert.deepEqual(observed, [{
    occurredAt: "2026-08-17T12:00:01.000Z",
    kind: "thinking",
    message: "**Reviewing code consistency and diffs**",
    toolCount: 2,
  }]);
  unsubscribe?.();

  child.emit("message", {
    type: "ticket-session:terminal",
    version: TICKET_SESSION_PROTOCOL_VERSION,
    result: { status: "clean", sessionId: "session-history", sessionFile, summary: "Implementation completed." },
  });
  child.exitCode = 0;
  child.emit("exit", 0, null);
  await handle.completion;
});

test("the Coordinator host rejects cross-directory session history and force-stops that child", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ticket-history-boundary-"));
  mkdirSync(join(cwd, ".git"));
  const outsideSession = join(cwd, "outside-session.jsonl");
  writeFileSync(outsideSession, `${JSON.stringify({
    type: "session", version: 3, id: "outside-session", timestamp: "2026-08-17T12:00:00.000Z", cwd,
  })}\n`);
  const child = new FakeTicketProcess();
  const adapter = new AutomodeTicketSessionHost({
    repository: cwd,
    configuration,
    home: join(cwd, "home"),
    processHost: new TicketSessionHost({
      childEntrypoint: join(cwd, "ticket-session-main.js"),
      launcher: () => child,
    }),
  });

  const starting = adapter.start({
    item: { kind: "issue", number: 46, url: "https://github.com/owner/repository/issues/46" },
    stage: "auto-implement",
    skillName: "implement",
    attempt: 1,
  });
  child.emit("message", {
    type: "ticket-session:event",
    version: TICKET_SESSION_PROTOCOL_VERSION,
    event: {
      type: "lifecycle",
      state: "ready",
      timestamp: Date.now(),
      sessionId: "outside-session",
      sessionFile: outsideSession,
    },
  });

  await assert.rejects(
    starting,
    /persisted history could not be validated: Ticket Session reported history outside the controlled session directory/,
  );
  assert.deepEqual(child.killed, ["SIGKILL"]);
  child.signalCode = "SIGKILL";
  child.emit("exit", null, "SIGKILL");
});

test("the child reports persistent identity and structured activity around one canonical prompt", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ticket-child-"));
  const sessionFile = join(cwd, "session.jsonl");
  const prompts: string[] = [];
  let activityListener: ((activity: TicketSessionChildActivity) => void) | undefined;
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
      activityListener?.({ activity: "Reading the repository.", kind: "assistant" });
      return { status: "clean", summary: "Triage completed." };
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
    summary: "Triage completed.",
  });
  assert.equal(disposed, true);
});

test("native Pi events become an ultra-collapsed transcript", () => {
  assert.deepEqual(ticketSessionActivityFromAgentEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "**Reviewing code consistency and diffs**" },
        { type: "toolCall", id: "review-1", name: "read", arguments: { path: "a.ts" } },
        { type: "toolCall", id: "review-2", name: "read", arguments: { path: "b.ts" } },
        { type: "toolCall", id: "review-3", name: "bash", arguments: { command: "git diff" } },
      ],
      stopReason: "toolUse",
    },
  } as never), [{
    activity: "**Reviewing code consistency and diffs**",
    kind: "thinking",
    toolCount: 3,
  }]);
  assert.deepEqual(ticketSessionActivityFromAgentEvent({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "The implementation now passes the full suite." }],
      stopReason: "stop",
    },
  } as never), [{
    activity: "The implementation now passes the full suite.",
    kind: "assistant",
  }]);
  assert.deepEqual(ticketSessionActivityFromAgentEvent({ type: "message_start" } as never), []);
  assert.deepEqual(ticketSessionActivityFromAgentEvent({ type: "message_update" } as never), []);
  assert.deepEqual(ticketSessionActivityFromAgentEvent({ type: "tool_execution_start" } as never), []);
  assert.deepEqual(ticketSessionActivityFromAgentEvent({ type: "tool_execution_end" } as never), []);
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
    prompt: () => new Promise<never>(() => {}),
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
      async prompt() { return { status: "waiting", summary: "Waiting for feedback." }; },
      async abort() {},
      dispose() {},
    };
  }, () => {}, { cwd });

  assert.equal(receivedResume, sessionFile);
  assert.deepEqual(result, {
    status: "waiting",
    sessionId: "persisted-session-id",
    sessionFile,
    summary: "Waiting for feedback.",
  });
});

test("the production child adapter can dispatch a pre-attested Stage outside the launch baseline", async () => {
  const session = await createControlledTicketSession({
    cwd: process.cwd(),
    skillName: "triage",
    itemUrl: "https://github.com/owner/repository/issues/22",
    prompt: "/skill:triage https://github.com/owner/repository/issues/22",
    configuration: createAutomationStageConfiguration("half", ["auto-review"]),
  });
  try {
    assert.ok(session.sessionId);
    assert.ok(session.sessionFile);
  } finally {
    session.dispose();
  }
});

test("the Coordinator adapter completes a fresh child-process run whose history file appears after ready", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ticket-adapter-e2e-"));
  mkdirSync(join(cwd, ".git"));
  const home = join(cwd, "home");
  const preloadMarker = join(cwd, "launching-pi-runtime-loaded");
  const promptRelease = join(cwd, "release-ticket-prompt");
  const runtimeLoader = join(cwd, "launching-pi-runtime-loader.mjs");
  writeFileSync(runtimeLoader, `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(preloadMarker)}, "loaded");
`);
  const adapter = new AutomodeTicketSessionHost({
    repository: cwd,
    configuration,
    home,
    processHost: new TicketSessionHost({
      childEntrypoint: fileURLToPath(import.meta.url),
      env: {
        ...process.env,
        AUTOMODE_PI_RUNTIME_LOADER: pathToFileURL(runtimeLoader).href,
        AUTOMODE_TICKET_SESSION_FIXTURE_CHILD: "1",
        AUTOMODE_TICKET_SESSION_PROMPT_RELEASE: promptRelease,
      },
    }),
  });

  const handle = await adapter.start({
    item: { kind: "issue", number: 22, url: "https://github.com/owner/repository/issues/22" },
    stage: "auto-implement",
    skillName: "implement",
    attempt: 1,
  });
  assert.equal(handle.sessionId, "fixture-persistent-session");
  assert.equal(handle.processId === String(process.pid), false);
  assert.equal(existsSync(handle.sessionFile), false);
  writeFileSync(promptRelease, "continue");

  assert.deepEqual(await handle.completion, { status: "clean", summary: "Fixture completed." });
  assert.equal(existsSync(handle.sessionFile), true);
  assert.match(
    readFileSync(handle.sessionFile, "utf8"),
    /\/skill:implement https:\/\/github\.com\/owner\/repository\/issues\/22/,
  );
  assert.equal(readFileSync(preloadMarker, "utf8"), "loaded");
});

test("the public host seam completes a full child-process run with persistent history", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ticket-process-e2e-"));
  mkdirSync(join(cwd, ".git"));
  const events: unknown[] = [];
  const preloadMarker = join(cwd, "launching-pi-runtime-loaded");
  const runtimeLoader = join(cwd, "launching-pi-runtime-loader.mjs");
  writeFileSync(runtimeLoader, `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(preloadMarker)}, "loaded");
`);
  const host = new TicketSessionHost({
    childEntrypoint: fileURLToPath(import.meta.url),
    env: {
      ...process.env,
      AUTOMODE_PI_RUNTIME_LOADER: pathToFileURL(runtimeLoader).href,
      AUTOMODE_TICKET_SESSION_FIXTURE_CHILD: "1",
    },
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
  assert.equal(readFileSync(preloadMarker, "utf8"), "loaded");
  assert.equal(events.some((event) =>
    (event as { type?: string; state?: string }).type === "lifecycle"
    && (event as { state?: string }).state === "ready"), true);
  assert.equal(events.some((event) =>
    (event as { type?: string; activity?: string; kind?: string }).type === "activity"
    && (event as { activity?: string }).activity === "Fixture completed."
    && (event as { kind?: string }).kind === "assistant"), true);
});

}
