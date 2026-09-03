import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  automodeRunConfigurationGuard,
  startAutomodeMainSession,
  type StartAutomodeMainOptions,
} from "../src/automode-main.js";
import {
  AutomodeCoordinator,
  type CoordinatorClock,
} from "../src/coordinator.js";
import type { CoordinatorDashboardOptions, DashboardProjection } from "../src/dashboard.js";
import { resolveAutomodePaths } from "../src/paths.js";
import {
  confirmSerializedAutomationStageConfiguration,
  createAutomationStageConfiguration,
  serializeAutomationStageConfiguration,
} from "../src/stage-configuration.js";

type StartForTestOptions = Omit<StartAutomodeMainOptions, "mainExecution"> & {
  mainExecution?: StartAutomodeMainOptions["mainExecution"];
};

function startForTest(options: StartForTestOptions) {
  return startAutomodeMainSession({
    ...options,
    mainExecution: options.mainExecution ?? {
      harness: "pi",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoning: "high",
    },
    model: options.mainExecution
      ? options.model
      : options.model ?? getBuiltinModel("openai-codex", "gpt-5.6-sol"),
    capabilityModel: getBuiltinModel("openai-codex", "gpt-5.6-sol"),
    openDashboardInBrowser: options.openDashboardInBrowser ?? (async () => undefined),
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
}

function confirmedConfiguration(
  mode: "full" | "half",
  stages: Parameters<typeof createAutomationStageConfiguration>[1],
) {
  const serializedConfiguration = serializeAutomationStageConfiguration(
    createAutomationStageConfiguration(mode, stages),
  );
  return {
    serializedConfiguration,
    configurationConfirmation: confirmSerializedAutomationStageConfiguration(serializedConfiguration),
  };
}

function createIdleCoordinator(
  configuration: ReturnType<typeof createAutomationStageConfiguration>,
  events?: string[],
  options?: {
    readonly clock?: CoordinatorClock;
    readonly snapshotError?: () => Error | undefined;
  },
): AutomodeCoordinator {
  const record = (event: string) => { events?.push(event); };
  return new AutomodeCoordinator({
    configuration,
    actor: "automation-user",
    tracker: {
      async listBookkeeping() { record("list-bookkeeping"); return []; },
      async snapshot() {
        record("snapshot");
        const error = options?.snapshotError?.();
        if (error) throw error;
        return { revision: "empty", items: [] };
      },
      async read() { throw new Error("No tracker item exists"); },
      async claim() { throw new Error("No tracker item exists"); },
      async upsertBookkeeping() { throw new Error("No bookkeeping write is expected"); },
    },
    sessions: { async start() { throw new Error("No Ticket Session is expected"); } },
    clock: options?.clock,
  });
}

test("the Automode Run guard cancels Main Session replacement and forking", async () => {
  const handlers = new Map<string, () => unknown>();
  const pi = {
    on(event: string, handler: () => unknown) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  await automodeRunConfigurationGuard.factory(pi);

  assert.deepEqual(await handlers.get("session_before_switch")!(), { cancel: true });
  assert.deepEqual(await handlers.get("session_before_fork")!(), { cancel: true });
});

test("a fresh Main Session separates process-local operating state from the durable launch baseline", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-main-"));
  const repository = join(fixture, "repository");
  const home = join(fixture, "home");
  mkdirSync(join(repository, ".git"), { recursive: true });

  const main = await startForTest({
    repository,
    home,
    ...confirmedConfiguration("half", ["auto-triage", "auto-review"]),
  });
  try {
    assert.equal(main.cwd, repository);
    assert.equal(main.sessionName, "Automode Main — Half-Auto");
    assert.deepEqual(main.configuration, {
      mode: "half",
      stages: ["auto-triage", "auto-review"],
    });
    assert.deepEqual(main.operatingState, {
      byStage: {
        "auto-triage": "ON",
        "auto-grilling": "OFF",
        "auto-implement": "OFF",
        "auto-review": "ON",
      },
    });
    assert.ok(main.sessionFile);
    assert.equal(existsSync(main.sessionFile!), false);
    assert.equal(existsSync(main.runRecordFile), true);
    assert.equal(existsSync(main.coordinatorIdentityFile), true);
    assert.equal(existsSync(main.coordinatorLockFile), true);
    assert.deepEqual(JSON.parse(readFileSync(main.coordinatorIdentityFile, "utf8")), {
      coordinatorId: main.coordinatorId,
    });
    assert.deepEqual(JSON.parse(readFileSync(main.runRecordFile, "utf8")), {
      version: 1,
      coordinatorId: main.coordinatorId,
      stageConfiguration: {
        mode: "half",
        stages: ["auto-triage", "auto-review"],
      },
      projectResources: { trusted: false, skillFiles: [] },
    });
  } finally {
    main.dispose();
  }
  assert.equal(existsSync(main.coordinatorLockFile), false);
});

test("a graceful drain during dashboard startup stops Coordinator discovery", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-dashboard-interrupt-"));
  const repository = join(fixture, "repository");
  const home = join(fixture, "home");
  mkdirSync(join(repository, ".git"), { recursive: true });
  const configuration = createAutomationStageConfiguration("half", ["auto-triage"]);
  const trackerCalls: string[] = [];
  const coordinator = createIdleCoordinator(configuration, trackerCalls);
  let releaseDashboard!: () => void;
  const dashboardReady = new Promise<void>((resolve) => { releaseDashboard = resolve; });
  const main = await startForTest({
    repository,
    home,
    ...confirmedConfiguration("half", ["auto-triage"]),
    coordinator,
    createDashboard() {
      return {
        async start() {
          await dashboardReady;
          return { localUrl: "http://127.0.0.1:41738" };
        },
        publish() {},
        appendActivity() {},
        async stop() {},
      };
    },
  });

  const starting = main.startCoordinator();
  assert.equal(main.interruptCoordinator(), "draining");
  const disposing = main.dispose();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(existsSync(main.coordinatorLockFile), true);
  releaseDashboard();
  await starting;
  await coordinator.whenStopped();
  await disposing;
  assert.deepEqual(trackerCalls, ["list-bookkeeping"]);
  assert.equal(existsSync(main.coordinatorLockFile), false);
});

test("starting Automode opens the exact local dashboard before Coordinator discovery", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-dashboard-open-"));
  const repository = join(fixture, "repository");
  const home = join(fixture, "home");
  mkdirSync(join(repository, ".git"), { recursive: true });
  const configuration = createAutomationStageConfiguration("half", ["auto-triage"]);
  const events: string[] = [];
  const coordinator = createIdleCoordinator(configuration, events);
  const main = await startForTest({
    repository,
    home,
    ...confirmedConfiguration("half", ["auto-triage"]),
    coordinator,
    createDashboard() {
      return {
        async start() {
          events.push("dashboard-start");
          return { localUrl: "http://127.0.0.1:42319" };
        },
        publish() {},
        appendActivity() {},
        async stop() {},
      };
    },
    async openDashboardInBrowser(localUrl) {
      events.push(`dashboard-open:${localUrl}`);
    },
  });

  await main.startCoordinator();
  assert.deepEqual(events.slice(0, 4), [
    "dashboard-start",
    "dashboard-open:http://127.0.0.1:42319",
    "list-bookkeeping",
    "snapshot",
  ]);
  main.interruptCoordinator();
  await coordinator.whenStopped();
  await main.dispose();
});

test("the dashboard starts before Coordinator discovery and stops after the drain", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-dashboard-main-"));
  const repository = join(fixture, "repository");
  const home = join(fixture, "home");
  mkdirSync(join(repository, ".git"), { recursive: true });
  const configuration = createAutomationStageConfiguration("half", ["auto-triage"]);
  const events: string[] = [];
  const published: DashboardProjection[] = [];
  let dashboardOptions: CoordinatorDashboardOptions | undefined;
  const coordinator = createIdleCoordinator(configuration, events);
  const main = await startForTest({
    repository,
    home,
    ...confirmedConfiguration("half", ["auto-triage"]),
    coordinator,
    createDashboard(options) {
      dashboardOptions = options;
      return {
        async start(initialProjection) {
          events.push("dashboard-start");
          published.push(initialProjection);
          return {
            localUrl: "http://127.0.0.1:41738",
            exposureError: "tailscale unavailable",
          };
        },
        publish(projection) { published.push(projection); },
        appendActivity() {},
        async stop() { events.push("dashboard-stop"); },
      };
    },
  });

  await main.startCoordinator();
  assert.deepEqual(events.slice(0, 3), ["dashboard-start", "list-bookkeeping", "snapshot"]);
  assert.ok(dashboardOptions);
  assert.equal(published[0]?.run.lifecycle, "loading");
  assert.equal(published.at(-1)?.run.lifecycle, "degraded");
  assert.equal(published.at(-1)?.tailscaleError, "tailscale unavailable");

  await dashboardOptions.onCommand({ type: "refresh" });
  assert.equal(events.filter((event) => event === "snapshot").length, 2);
  await dashboardOptions.onCommand({
    type: "set-stage-state",
    stage: "auto-triage",
    state: "OFF",
  });
  assert.equal(
    published.at(-1)?.lanes.find((lane) => lane.stage === "auto-triage")?.operatingState,
    "OFF",
  );
  await dashboardOptions.onCommand({ type: "drain" });
  await dashboardOptions.onCommand({ type: "drain" });
  assert.equal(published.at(-1)?.run.lifecycle, "draining");
  await coordinator.whenStopped();
  assert.equal(main.interruptCoordinator(), "forcing");
  await main.dispose();
  assert.equal(events.at(-1), "dashboard-stop");
});

test("a background GitHub poll failure degrades supervision until polling recovers", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-dashboard-poll-failure-"));
  const repository = join(fixture, "repository");
  const home = join(fixture, "home");
  mkdirSync(join(repository, ".git"), { recursive: true });
  const configuration = createAutomationStageConfiguration("half", ["auto-triage"]);
  const published: DashboardProjection[] = [];
  let pollCallback: (() => void | Promise<void>) | undefined;
  let now = new Date("2026-08-18T12:00:00.000Z");
  let snapshotError: Error | undefined;
  const coordinator = createIdleCoordinator(configuration, undefined, {
    clock: {
      now: () => now,
      every(_milliseconds, callback) {
        pollCallback = callback;
        return { dispose: () => { pollCallback = undefined; } };
      },
    },
    snapshotError: () => snapshotError,
  });
  const main = await startForTest({
    repository,
    home,
    ...confirmedConfiguration("half", ["auto-triage"]),
    coordinator,
    createDashboard() {
      return {
        async start(initialProjection) {
          published.push(initialProjection);
          return { localUrl: "http://127.0.0.1:41738" };
        },
        publish(projection) { published.push(projection); },
        appendActivity() {},
        async stop() {},
      };
    },
  });

  await main.startCoordinator();
  snapshotError = new Error("temporary GitHub outage");
  now = new Date("2026-08-18T12:00:30.000Z");
  await pollCallback?.();
  assert.equal(published.at(-1)?.run.lifecycle, "degraded");
  assert.equal(published.at(-1)?.run.pollError, "temporary GitHub outage");

  snapshotError = undefined;
  now = new Date("2026-08-18T12:01:00.000Z");
  await pollCallback?.();
  assert.equal(published.at(-1)?.run.lifecycle, "empty");
  assert.equal(published.at(-1)?.run.pollError, undefined);

  main.interruptCoordinator();
  await coordinator.whenStopped();
  await main.dispose();
});

test("dashboard cleanup failure retains the Coordinator lock until a successful retry", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-dashboard-cleanup-"));
  const repository = join(fixture, "repository");
  const home = join(fixture, "home");
  mkdirSync(join(repository, ".git"), { recursive: true });
  const configuration = createAutomationStageConfiguration("half", ["auto-triage"]);
  const coordinator = createIdleCoordinator(configuration);
  let stopCalls = 0;
  const main = await startForTest({
    repository,
    home,
    ...confirmedConfiguration("half", ["auto-triage"]),
    coordinator,
    createDashboard() {
      return {
        async start() { return { localUrl: "http://127.0.0.1:41738" }; },
        publish() {},
        appendActivity() {},
        async stop() {
          stopCalls += 1;
          if (stopCalls === 1) throw new Error("Tailscale cleanup failed");
        },
      };
    },
  });

  await main.startCoordinator();
  main.interruptCoordinator();
  await coordinator.whenStopped();
  await assert.rejects(() => main.dispose(), /Tailscale cleanup failed/);
  assert.equal(existsSync(main.coordinatorLockFile), true);
  await main.dispose();
  assert.equal(stopCalls, 2);
  assert.equal(existsSync(main.coordinatorLockFile), false);
});

test("dashboard startup failure cleans up its attempt without leaking the Coordinator lock", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-dashboard-startup-failure-"));
  const repository = join(fixture, "repository");
  const home = join(fixture, "home");
  mkdirSync(join(repository, ".git"), { recursive: true });
  let stopCalls = 0;
  const main = await startForTest({
    repository,
    home,
    ...confirmedConfiguration("half", ["auto-triage"]),
    createDashboard() {
      return {
        async start() { throw new Error("Dashboard port unavailable"); },
        publish() {},
        appendActivity() {},
        async stop() { stopCalls += 1; },
      };
    },
  });

  await assert.rejects(() => main.startCoordinator(), /Dashboard port unavailable/);
  assert.equal(existsSync(main.coordinatorLockFile), true);
  await assert.rejects(() => main.dispose(), /Dashboard port unavailable/);
  assert.equal(stopCalls, 1);
  assert.equal(existsSync(main.coordinatorLockFile), false);
});

test("failed startup validation does not persist an Automode Run Record", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-failed-start-"));
  const repository = join(fixture, "repository");
  const home = join(fixture, "home");
  mkdirSync(join(repository, ".git"), { recursive: true });
  const configuration = confirmedConfiguration("half", ["auto-triage"]);

  await assert.rejects(
    () => startAutomodeMainSession({
      repository,
      home,
      ...configuration,
      mainExecution: {
        harness: "pi",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoning: "high",
      },
      startupValidation: {
        runner: {
          async run() {
            throw new Error("GitHub unavailable");
          },
        },
      },
    }),
    /repository validation failed/,
  );
  assert.equal(
    existsSync(resolveAutomodePaths(repository, home).runRecordFile),
    false,
  );
});

test("Main Session model changes do not rewrite or block the durable Automode Run", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-process-model-"));
  const repository = join(fixture, "repository");
  const home = join(fixture, "home");
  mkdirSync(join(repository, ".git"), { recursive: true });
  const configuration = confirmedConfiguration("half", ["auto-review"]);

  const first = await startForTest({
    repository,
    home,
    ...configuration,
    mainExecution: {
      harness: "pi",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoning: "high",
    },
    model: getBuiltinModel("openai-codex", "gpt-5.6-sol"),
  });
  const record = JSON.parse(readFileSync(first.runRecordFile, "utf8")) as Record<string, unknown>;
  await first.dispose();
  writeFileSync(first.runRecordFile, `${JSON.stringify({
    ...record,
    defaultReviewerExecution: {
      harness: "pi",
      provider: "anthropic",
      model: "claude-opus-4-8",
      reasoning: "high",
    },
  })}\n`);

  const restarted = await startForTest({
    repository,
    home,
    ...configuration,
    mainExecution: {
      harness: "pi",
      provider: "github-copilot",
      model: "claude-fable-5",
      reasoning: "high",
    },
    model: getBuiltinModel("github-copilot", "claude-fable-5"),
  });
  assert.deepEqual(JSON.parse(readFileSync(restarted.runRecordFile, "utf8")), record);
  await restarted.dispose();
});

test("a Main Session resolves the launching Pi model from the normal models catalog", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-custom-main-model-"));
  const repository = join(fixture, "repository");
  const home = join(fixture, "home");
  const normalAgentDir = join(fixture, "normal-agent");
  mkdirSync(join(repository, ".git"), { recursive: true });
  mkdirSync(normalAgentDir, { recursive: true });
  writeFileSync(join(normalAgentDir, "models.json"), JSON.stringify({
    providers: {
      "automode-custom": {
        baseUrl: "http://127.0.0.1:12345/v1",
        api: "openai-completions",
        apiKey: "test-only",
        models: [{ id: "main-custom", reasoning: true }],
      },
    },
  }));

  const main = await startForTest({
    repository,
    home,
    normalAgentDir,
    ...confirmedConfiguration("half", ["auto-review"]),
    mainExecution: {
      harness: "pi",
      provider: "automode-custom",
      model: "main-custom",
      reasoning: "high",
    },
  });
  await main.dispose();
});

test("an Automode Run rejects changed project executable additions on restart", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-fixed-capability-"));
  const repository = join(fixture, "repository");
  const home = join(fixture, "home");
  const projectSkill = join(repository, "trusted-skills", "project-proof");
  mkdirSync(join(repository, ".git"), { recursive: true });
  mkdirSync(projectSkill, { recursive: true });
  writeFileSync(
    join(projectSkill, "SKILL.md"),
    "---\nname: project-proof\ndescription: Explicit project proof.\n---\nproof\n",
  );
  const configuration = confirmedConfiguration("half", ["auto-triage"]);
  const first = await startForTest({
    repository,
    home,
    ...configuration,
    projectResources: { trusted: true, skillPaths: [projectSkill] },
  });
  first.dispose();
  const restarted = await startForTest({
    repository,
    home,
    ...configuration,
    projectResources: { trusted: true, skillPaths: [projectSkill] },
  });
  restarted.dispose();

  await assert.rejects(
    () => startForTest({ repository, home, ...configuration }),
    /Automode Run Record contains different fixed settings/,
  );
});

test("linked worktrees share the Coordinator identity and latest launch baseline", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-linked-run-"));
  const primary = join(fixture, "primary");
  const linked = join(fixture, "linked");
  const linkedGitDirectory = join(primary, ".git", "worktrees", "linked");
  mkdirSync(linkedGitDirectory, { recursive: true });
  mkdirSync(linked, { recursive: true });
  writeFileSync(join(linked, ".git"), `gitdir: ${linkedGitDirectory}\n`);
  writeFileSync(join(linkedGitDirectory, "commondir"), "../..\n");

  const configuration = confirmedConfiguration("half", ["auto-triage"]);
  const first = await startForTest({
    repository: primary,
    home: join(fixture, "first-home"),
    ...configuration,
  });
  const coordinatorId = first.coordinatorId;
  const runRecordFile = first.runRecordFile;
  first.dispose();

  const restarted = await startForTest({
    repository: linked,
    home: join(fixture, "second-home"),
    ...configuration,
  });
  assert.equal(restarted.coordinatorId, coordinatorId);
  assert.equal(restarted.runRecordFile, runRecordFile);
  assert.deepEqual(restarted.operatingState, {
    byStage: {
      "auto-triage": "ON",
      "auto-grilling": "OFF",
      "auto-implement": "OFF",
      "auto-review": "OFF",
    },
  });
  restarted.dispose();

  const reconfigured = await startForTest({
    repository: linked,
    home: join(fixture, "third-home"),
    ...confirmedConfiguration("half", ["auto-review"]),
  });
  assert.equal(reconfigured.coordinatorId, coordinatorId);
  assert.deepEqual(reconfigured.operatingState, {
    byStage: {
      "auto-triage": "OFF",
      "auto-grilling": "OFF",
      "auto-implement": "OFF",
      "auto-review": "ON",
    },
  });
  assert.deepEqual(JSON.parse(readFileSync(runRecordFile, "utf8")).stageConfiguration, {
    mode: "half",
    stages: ["auto-review"],
  });
  reconfigured.dispose();
});

test("a stopped Automode Run accepts a different launch configuration on restart", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-reconfigured-run-"));
  const repository = join(fixture, "repository");
  const home = join(fixture, "home");
  mkdirSync(join(repository, ".git"), { recursive: true });

  const full = confirmedConfiguration(
    "full",
    ["auto-triage", "auto-grilling", "auto-implement", "auto-review"],
  );
  const first = await startForTest({ repository, home, ...full });
  const coordinatorId = first.coordinatorId;
  await assert.rejects(
    () => startForTest({ repository, home, ...full }),
    /live Automode Coordinator/,
  );
  first.dispose();
  const restarted = await startForTest({ repository, home, ...full });
  assert.equal(restarted.coordinatorId, coordinatorId);
  restarted.dispose();

  const reconfigured = await startForTest({
    repository,
    home: join(fixture, "second-home"),
    ...confirmedConfiguration("half", ["auto-review"]),
  });
  assert.equal(reconfigured.coordinatorId, coordinatorId);
  assert.deepEqual(reconfigured.configuration, {
    mode: "half",
    stages: ["auto-review"],
  });
  assert.deepEqual(reconfigured.operatingState, {
    byStage: {
      "auto-triage": "OFF",
      "auto-grilling": "OFF",
      "auto-implement": "OFF",
      "auto-review": "ON",
    },
  });
  assert.deepEqual(JSON.parse(readFileSync(reconfigured.runRecordFile, "utf8")).stageConfiguration, {
    mode: "half",
    stages: ["auto-review"],
  });
  reconfigured.dispose();
});
