import assert from "node:assert/strict";
import { spawn as spawnPty } from "@lydell/node-pty";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createCoordinatorDashboard,
  type DashboardProjection,
  type DashboardTailscaleExposure,
} from "../src/dashboard.js";

interface DashboardHttpResponse {
  readonly status: number;
  readonly body: string;
}

function requestDashboard(
  path: string,
  host: string,
  options: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
  } = {},
): Promise<DashboardHttpResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      hostname: "127.0.0.1",
      port: 41_738,
      path,
      method: options.method,
      agent: false,
      headers: { host, ...options.headers },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    outgoing.once("error", reject);
    outgoing.end(options.body);
  });
}

const unavailableTailscale: DashboardTailscaleExposure = {
  async expose() {
    throw new Error("tailscale executable was not found");
  },
  async stop() {},
};

function dashboardCandidate(projection: DashboardProjection, itemKey: string) {
  return projection.lanes
    .flatMap((lane) => lane.candidates)
    .find((candidate) => candidate.itemKey === itemKey);
}

function projection(id = "run-1"): DashboardProjection {
  const totals = { candidates: 0, active: 0, queued: 0, held: 0, retrying: 0, exhausted: 0 };
  return {
    version: 1,
    repository: { name: "repository", url: "https://github.com/owner/repository" },
    run: { id, mode: "full", lifecycle: "active" },
    totals,
    lanes: ["auto-triage", "auto-grilling", "auto-implement", "auto-review"].map((stage) => ({
      stage: stage as "auto-triage" | "auto-grilling" | "auto-implement" | "auto-review",
      operatingState: "ON" as const,
      candidates: [],
      totals,
    })),
    recent: [],
  };
}

test("the Coordinator dashboard serves its initial projection on the fixed loopback URL", async () => {
  const dashboard = createCoordinatorDashboard({
    tailscale: unavailableTailscale,
    onCommand: async () => undefined,
  });

  try {
    const initialProjection = projection("initial");
    const status = await dashboard.start(initialProjection);
    assert.equal(status.localUrl, "http://127.0.0.1:41738");
    assert.equal(status.remoteUrl, undefined);
    assert.equal(status.exposureError, "tailscale executable was not found");

    const response = await fetch("http://127.0.0.1:41738/api/snapshot");
    assert.equal(response.status, 200);
    const snapshot = await response.json() as Record<string, unknown>;
    assert.equal(snapshot.revision, 1);
    assert.deepEqual(snapshot.projection, initialProjection);
    assert.deepEqual(snapshot.network, {
      localUrl: "http://127.0.0.1:41738",
      exposureError: "tailscale executable was not found",
    });
    assert.equal(typeof snapshot.csrfToken, "string");
  } finally {
    await dashboard.stop();
  }
});

test("the dashboard serves static assets and rejects untrusted Host headers", async () => {
  const dashboard = createCoordinatorDashboard({
    tailscale: unavailableTailscale,
    onCommand: async () => undefined,
  });
  await dashboard.start(projection());

  try {
    const page = await fetch("http://127.0.0.1:41738/");
    assert.equal(page.status, 200);
    const pageBody = await page.text();
    assert.match(pageBody, /Loading Stage Candidates/);
    assert.match(pageBody, /name="automode-snapshot" content="\/api\/snapshot"/);
    const application = await fetch("http://127.0.0.1:41738/app.js");
    assert.equal(application.status, 200);
    assert.match(await application.text(), /Live Coordinator connection/);
    assert.equal((await fetch("http://127.0.0.1:41738/styles.css")).status, 200);

    assert.equal((await requestDashboard("/api/snapshot", "attacker.example")).status, 421);
  } finally {
    await dashboard.stop();
  }
});

test("successful Tailscale exposure allows only its private host and same-origin mutations", async () => {
  const commands: unknown[] = [];
  let stopCalls = 0;
  const dashboard = createCoordinatorDashboard({
    tailscale: {
      async expose(localUrl) {
        assert.equal(localUrl, "http://127.0.0.1:41738");
        return { remoteUrl: "https://automode.example.ts.net" };
      },
      async stop() { stopCalls += 1; },
    },
    onCommand: async (command) => { commands.push(command); },
  });

  try {
    assert.deepEqual(await dashboard.start(projection()), {
      localUrl: "http://127.0.0.1:41738",
      remoteUrl: "https://automode.example.ts.net",
    });
    const snapshotResponse = await requestDashboard(
      "/api/snapshot",
      "automode.example.ts.net",
    );
    assert.equal(snapshotResponse.status, 200);
    const snapshot = JSON.parse(snapshotResponse.body) as { revision: number; csrfToken: string };
    const commandResponse = await requestDashboard(
      "/api/commands/refresh",
      "automode.example.ts.net",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://automode.example.ts.net",
          "x-automode-csrf": snapshot.csrfToken,
          "if-match": `\"${snapshot.revision}\"`,
        },
        body: "{}",
      },
    );
    assert.equal(commandResponse.status, 204);
    assert.deepEqual(commands, [{ type: "refresh" }]);
  } finally {
    await dashboard.stop();
    await dashboard.stop();
  }
  assert.equal(stopCalls, 1);
});

test("the live event stream publishes replacement projections and structured activity", async () => {
  const dashboard = createCoordinatorDashboard({
    tailscale: unavailableTailscale,
    onCommand: async () => undefined,
  });
  await dashboard.start(projection("one"));

  const controller = new AbortController();
  try {
    const response = await fetch("http://127.0.0.1:41738/api/events", {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const readUntil = async (expected: string) => {
      while (!received.includes(expected)) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        received += decoder.decode(chunk.value, { stream: true });
      }
    };

    await readUntil('event: projection\ndata: {"revision":1,"projection":{"version":1');
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    dashboard.publish(projection("two"));
    await readUntil('"id":"two"');
    const activity = {
      id: "activity-43",
      itemKey: "issue:43",
      occurredAt: "2026-08-17T12:00:00.000Z",
      kind: "tool",
      message: "npm test",
      data: { exitCode: 0 },
    } as const;
    dashboard.appendActivity(activity);
    await readUntil('event: activity\ndata: {"id":"activity-43","itemKey":"issue:43","occurredAt":"2026-08-17T12:00:00.000Z","kind":"tool","message":"npm test","data":{"exitCode":0}}');
    const snapshot = await (await fetch("http://127.0.0.1:41738/api/snapshot")).json() as {
      activities: unknown[];
    };
    assert.deepEqual(snapshot.activities, [activity]);
    await reader.cancel();
  } finally {
    controller.abort();
    await dashboard.stop();
    await dashboard.stop();
  }
});

test("activity retention is bounded per item with an explicit truncation marker", async () => {
  const dashboard = createCoordinatorDashboard({
    tailscale: unavailableTailscale,
    onCommand: async () => undefined,
  });
  await dashboard.start(projection());
  try {
    for (let index = 0; index < 505; index += 1) {
      dashboard.appendActivity({
        id: `activity-${index}`,
        itemKey: "issue:45",
        occurredAt: `2026-08-17T12:00:${String(index % 60).padStart(2, "0")}.000Z`,
        kind: "pi",
        message: `activity ${index}`,
        data: { attempt: 1, sessionId: "session-45", source: "live" },
      });
    }
    const snapshot = await (await fetch("http://127.0.0.1:41738/api/snapshot")).json() as {
      activities: Array<{ id: string; message?: string }>;
    };
    assert.equal(snapshot.activities.length, 500);
    assert.equal(snapshot.activities[0]?.id, "issue:45:activity-truncated");
    assert.match(snapshot.activities[0]?.message ?? "", /truncated/);
    assert.equal(snapshot.activities.at(-1)?.id, "activity-504");
  } finally {
    await dashboard.stop();
  }
});

test("typed supervisory commands require same-origin, CSRF, and a current projection revision", async () => {
  const commands: unknown[] = [];
  const dashboard = createCoordinatorDashboard({
    tailscale: unavailableTailscale,
    onCommand: async (command) => { commands.push(command); },
  });
  await dashboard.start(projection("first"));

  try {
    const snapshot = await (await fetch("http://127.0.0.1:41738/api/snapshot")).json() as {
      revision: number;
      csrfToken: string;
    };
    const headers = {
      "content-type": "application/json",
      origin: "http://127.0.0.1:41738",
      "x-automode-csrf": snapshot.csrfToken,
      "if-match": `\"${snapshot.revision}\"`,
    };
    const refresh = await fetch("http://127.0.0.1:41738/api/commands/refresh", {
      method: "POST", headers, body: "{}",
    });
    assert.equal(refresh.status, 204);

    const drain = await fetch("http://127.0.0.1:41738/api/commands/drain", {
      method: "POST", headers, body: "{}",
    });
    assert.equal(drain.status, 204);

    const stage = await fetch("http://127.0.0.1:41738/api/commands/stage-state", {
      method: "POST", headers,
      body: JSON.stringify({ stage: "auto-review", state: "DRAINING" }),
    });
    assert.equal(stage.status, 204);
    assert.deepEqual(commands, [
      { type: "refresh" },
      { type: "drain" },
      { type: "set-stage-state", stage: "auto-review", state: "DRAINING" },
    ]);

    const crossOrigin = await fetch("http://127.0.0.1:41738/api/commands/refresh", {
      method: "POST",
      headers: { ...headers, origin: "https://attacker.example" },
      body: "{}",
    });
    assert.equal(crossOrigin.status, 403);
    const missingCsrf = await fetch("http://127.0.0.1:41738/api/commands/refresh", {
      method: "POST",
      headers: { ...headers, "x-automode-csrf": "wrong" },
      body: "{}",
    });
    assert.equal(missingCsrf.status, 403);

    dashboard.publish(projection("new"));
    const stale = await fetch("http://127.0.0.1:41738/api/commands/refresh", {
      method: "POST", headers, body: "{}",
    });
    assert.equal(stale.status, 409);
    assert.equal(commands.length, 3);
  } finally {
    await dashboard.stop();
  }
});

test("concurrent startup is idempotent and waits for the same Tailscale result", async () => {
  let releaseExposure!: () => void;
  const exposureReady = new Promise<void>((resolve) => { releaseExposure = resolve; });
  let exposureCalls = 0;
  const tailscale: DashboardTailscaleExposure = {
    async expose() {
      exposureCalls += 1;
      await exposureReady;
      return { remoteUrl: "https://automode.example.ts.net" };
    },
    async stop() {},
  };
  const dashboard = createCoordinatorDashboard({
    tailscale,
    onCommand: async () => undefined,
  });

  const first = dashboard.start(projection("one"));
  const second = dashboard.start(projection("ignored"));
  const secondBeforeExposure = await Promise.race([
    second.then(() => "settled" as const),
    new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
  ]);
  assert.equal(secondBeforeExposure, "pending");

  releaseExposure();
  try {
    assert.deepEqual(await first, {
      localUrl: "http://127.0.0.1:41738",
      remoteUrl: "https://automode.example.ts.net",
    });
    assert.deepEqual(await second, await first);
    assert.equal(exposureCalls, 1);
  } finally {
    await dashboard.stop();
  }
});

test("concurrent shutdown shares failures and can retry Tailscale cleanup", async () => {
  let stopCalls = 0;
  const dashboard = createCoordinatorDashboard({
    tailscale: {
      async expose() { return { remoteUrl: "https://automode.example.ts.net" }; },
      async stop() {
        stopCalls += 1;
        if (stopCalls === 1) throw new Error("tailscale cleanup failed");
      },
    },
    onCommand: async () => undefined,
  });
  await dashboard.start(projection());

  const firstStop = dashboard.stop();
  const secondStop = dashboard.stop();
  const results = await Promise.allSettled([firstStop, secondStop]);
  assert.deepEqual(results.map(({ status }) => status), ["rejected", "rejected"]);
  assert.equal(stopCalls, 1);

  await dashboard.stop();
  assert.equal(stopCalls, 2);
  const replacement = createServer();
  await new Promise<void>((resolve, reject) => {
    replacement.once("error", reject);
    replacement.listen(41_738, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => {
    replacement.close((error) => error ? reject(error) : resolve());
  });
});

test("shutdown waits for in-flight startup and removes the resulting exposure", async () => {
  let releaseExposure!: () => void;
  const exposureReady = new Promise<void>((resolve) => { releaseExposure = resolve; });
  let exposureEstablished = false;
  let stopObservedEstablishedExposure = false;
  const dashboard = createCoordinatorDashboard({
    tailscale: {
      async expose() {
        await exposureReady;
        exposureEstablished = true;
        return { remoteUrl: "https://automode.example.ts.net" };
      },
      async stop() { stopObservedEstablishedExposure = exposureEstablished; },
    },
    onCommand: async () => undefined,
  });

  const starting = dashboard.start(projection());
  const stopping = dashboard.stop();
  const stopBeforeExposure = await Promise.race([
    stopping.then(() => "settled" as const),
    new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
  ]);
  assert.equal(stopBeforeExposure, "pending");

  releaseExposure();
  await starting;
  await stopping;
  assert.equal(stopObservedEstablishedExposure, true);
  const replacement = createServer();
  await new Promise<void>((resolve, reject) => {
    replacement.once("error", reject);
    replacement.listen(41_738, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => {
    replacement.close((error) => error ? reject(error) : resolve());
  });
});

test("dashboard startup fails when the fixed port is occupied", async () => {
  const occupant = createServer();
  await new Promise<void>((resolve, reject) => {
    occupant.once("error", reject);
    occupant.listen(41_738, "127.0.0.1", resolve);
  });
  let exposureCalls = 0;
  let commandCalls = 0;
  const dashboard = createCoordinatorDashboard({
    tailscale: {
      async expose() {
        exposureCalls += 1;
        return { remoteUrl: "https://automode.example.ts.net" };
      },
      async stop() {},
    },
    onCommand: async () => { commandCalls += 1; },
  });

  try {
    await assert.rejects(
      () => dashboard.start(projection()),
      (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE",
    );
    assert.equal(exposureCalls, 0);
    assert.equal(commandCalls, 0);
  } finally {
    await dashboard.stop();
    await new Promise<void>((resolve, reject) => occupant.close((error) => error ? reject(error) : resolve()));
  }
});

function stripTerminalControl(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
}

test("black-box /automode supervision reaches live activity and graceful drain", { timeout: 30_000 }, async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-dashboard-acceptance-"));
  const repository = join(fixture, "repository");
  mkdirSync(join(repository, ".git"), { recursive: true });
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const proofExtension = join(fixture, "dashboard-acceptance-extension.mjs");
  writeFileSync(proofExtension, `
import automodeBridge, { selectAutomationStageConfiguration } from ${JSON.stringify(pathToFileURL(resolve(projectRoot, "dist/src/bridge.js")).href)};
import { createAutomodeLaunchPlan } from ${JSON.stringify(pathToFileURL(resolve(projectRoot, "dist/src/launch.js")).href)};
import { handoffTerminal } from ${JSON.stringify(pathToFileURL(resolve(projectRoot, "dist/src/handoff.js")).href)};
const proofEntrypoint = ${JSON.stringify(resolve(projectRoot, "dist/test/dashboard-acceptance-main.js"))};
export default function (pi) {
  automodeBridge(pi, {
    selectConfiguration: selectAutomationStageConfiguration,
    launch: async (request) => {
      const plan = createAutomodeLaunchPlan(request);
      return handoffTerminal({
        ...plan,
        args: [...plan.args.slice(0, 2), proofEntrypoint, ...plan.args.slice(3)],
      });
    },
  });
}
`);
  const command = process.platform === "win32" ? `${process.env.APPDATA}/npm/pi.cmd` : "pi";
  const terminal = spawnPty(command, [
    "--no-session",
    "--no-extensions",
    "--offline",
    "--model", "openai-codex/gpt-5.6-sol",
    "-e", proofExtension,
  ], {
    cwd: repository,
    env: { ...process.env, PI_OFFLINE: "1" },
    name: "xterm-color",
    cols: 100,
    rows: 32,
  });

  let output = "";
  let invoked = false;
  let launched = false;
  let supervisionStarted = false;
  let supervisionComplete = false;
  let exitCode: number | undefined;
  await new Promise<void>((resolveRun, rejectRun) => {
    const timer = setTimeout(() => {
      terminal.kill();
      rejectRun(new Error(`Dashboard acceptance timed out:\n${stripTerminalControl(output)}`));
    }, 25_000);
    const finish = () => {
      if (!supervisionComplete || exitCode === undefined) return;
      clearTimeout(timer);
      if (exitCode !== 0) {
        rejectRun(new Error(`Dashboard acceptance exited ${exitCode}:\n${stripTerminalControl(output)}`));
      } else {
        resolveRun();
      }
    };
    const supervise = async () => {
      const deadline = Date.now() + 8_000;
      type AcceptanceSnapshot = {
        revision: number;
        csrfToken: string;
        projection: DashboardProjection;
        activities: Array<{ message?: string }>;
      };
      let snapshot: AcceptanceSnapshot | undefined;
      let lastSnapshotError: unknown;
      while (Date.now() < deadline) {
        try {
          snapshot = await (await fetch("http://127.0.0.1:41738/api/snapshot")).json() as AcceptanceSnapshot;
          const candidate = dashboardCandidate(snapshot.projection, "issue:50");
          if (
            candidate?.status === "running"
            && snapshot.activities.some((activity) => activity.message?.includes("live activity proof"))
          ) break;
        } catch (error) {
          lastSnapshotError = error;
        }
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 75));
      }
      if (!snapshot) {
        throw new Error("Dashboard never returned an acceptance snapshot", { cause: lastSnapshotError });
      }
      const candidate = dashboardCandidate(snapshot.projection, "issue:50");
      assert.equal(candidate?.status, "running");
      assert.ok(snapshot.activities.some((activity) => activity.message?.includes("live activity proof")));
      assert.equal(snapshot.projection.run.lifecycle, "degraded");
      assert.ok(snapshot.projection.tailscaleError);
      assert.match(snapshot.projection.tailscaleError, /acceptance harness/);
      const application = await (await fetch("http://127.0.0.1:41738/app.js")).text();
      assert.match(application, /Stage Lanes/);
      assert.doesNotMatch(application, /data-command=["']force/);
      const drain = await fetch("http://127.0.0.1:41738/api/commands/drain", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://127.0.0.1:41738",
          "x-automode-csrf": snapshot.csrfToken,
          "if-match": `"${snapshot.revision}"`,
        },
        body: "{}",
      });
      assert.equal(drain.status, 204);
    };
    terminal.onData((chunk) => {
      output += chunk;
      if (!invoked && output.includes(">")) {
        invoked = true;
        terminal.write("/automode\r");
      }
      if (!launched && output.includes("Launch Automode")) {
        launched = true;
        terminal.write("\r");
      }
      if (!supervisionStarted && output.includes("http://127.0.0.1:41738")) {
        supervisionStarted = true;
        void supervise().then(() => {
          supervisionComplete = true;
          finish();
        }, (error) => {
          terminal.kill();
          clearTimeout(timer);
          rejectRun(error);
        });
      }
    });
    terminal.onExit(({ exitCode: code }) => {
      exitCode = code;
      terminal.kill();
      if (!supervisionStarted) {
        clearTimeout(timer);
        rejectRun(new Error(`Dashboard link never appeared:\n${stripTerminalControl(output)}`));
        return;
      }
      finish();
    });
  });

  const visibleOutput = stripTerminalControl(output);
  assert.match(visibleOutput, /AUTOMODE MAIN SESSION/);
  assert.match(visibleOutput, /owner\/repository/);
  assert.match(visibleOutput, /http:\/\/127\.0\.0\.1:41738/);
  assert.match(visibleOutput, /TAILSCALE ERROR/);
  assert.match(visibleOutput, /Stages Auto-Triage (?:ON|DRAINING|OFF)/);
  assert.match(visibleOutput, /Auto-Grilling (?:ON|DRAINING|OFF)/);
  assert.match(visibleOutput, /Auto-Implement (?:ON|DRAINING|OFF)/);
  assert.match(visibleOutput, /Auto-Review (?:ON|DRAINING|OFF)/);
  assert.match(visibleOutput, /Candidates \d+ open\s+·\s+\d+ active\s+·\s+\d+ queued\s+·\s+\d+ held\s+·\s+\d+ retrying\s+·\s+\d+ exhausted/);
  assert.match(visibleOutput, /Poll last .*·\s+next/);
  assert.match(visibleOutput, /Ctrl-C: graceful drain/);
});
