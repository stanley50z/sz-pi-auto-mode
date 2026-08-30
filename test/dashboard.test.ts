import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import {
  CliDashboardTailscaleExposure,
  createCoordinatorDashboard,
  type DashboardProjection,
  type DashboardTailscaleExposure,
} from "../src/dashboard.js";
import {
  launchDashboardBlackBox,
  stripTerminalControl,
} from "./dashboard-black-box-harness.js";

interface DashboardHttpResponse {
  readonly status: number;
  readonly body: string;
}

function requestDashboard(
  baseUrl: string,
  path: string,
  host: string,
  options: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
  } = {},
): Promise<DashboardHttpResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(baseUrl);
    const outgoing = request({
      hostname: target.hostname,
      port: Number(target.port),
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

test("the Coordinator dashboard serves its initial projection on an available loopback URL", async () => {
  const dashboard = createCoordinatorDashboard({
    tailscale: unavailableTailscale,
    onCommand: async () => undefined,
  });

  try {
    const initialProjection = projection("initial");
    const status = await dashboard.start(initialProjection);
    assert.match(status.localUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(status.remoteUrl, undefined);
    assert.equal(status.exposureError, "tailscale executable was not found");

    const response = await fetch(`${status.localUrl}/api/snapshot`);
    assert.equal(response.status, 200);
    const snapshot = await response.json() as Record<string, unknown>;
    assert.equal(snapshot.revision, 1);
    assert.deepEqual(snapshot.projection, initialProjection);
    assert.deepEqual(snapshot.network, {
      localUrl: status.localUrl,
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
  const status = await dashboard.start(projection());

  try {
    const page = await fetch(status.localUrl);
    assert.equal(page.status, 200);
    const pageBody = await page.text();
    assert.match(pageBody, /Loading Stage Candidates/);
    assert.match(pageBody, /name="automode-snapshot" content="\/api\/snapshot"/);
    const application = await fetch(`${status.localUrl}/app.js`);
    assert.equal(application.status, 200);
    assert.match(await application.text(), /Live Coordinator connection/);
    assert.equal((await fetch(`${status.localUrl}/styles.css`)).status, 200);

    assert.equal((await requestDashboard(status.localUrl, "/api/snapshot", "attacker.example")).status, 421);
  } finally {
    await dashboard.stop();
  }
});

test("Tailscale exposure adopts an existing Automode route and removes only that route", async () => {
  const calls: string[][] = [];
  const tailscale = new CliDashboardTailscaleExposure(async (args) => {
    calls.push([...args]);
    if (args[1] === "status") {
      return {
        stdout: JSON.stringify({
          TCP: { "443": { HTTPS: true } },
          Web: {
            "automode.example.ts.net:443": {
              Handlers: { "/": { Proxy: "http://127.0.0.1:41738" } },
            },
          },
        }),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  });

  assert.deepEqual(await tailscale.expose("http://127.0.0.1:41738"), {
    remoteUrl: "https://automode.example.ts.net",
  });
  await tailscale.stop();
  assert.deepEqual(calls, [
    ["serve", "status", "--json"],
    ["serve", "status", "--json"],
    ["serve", "--https=443", "--set-path=/", "off"],
  ]);
});

test("Tailscale exposure preserves unrelated routes and owns a separate HTTPS port", async () => {
  const calls: string[][] = [];
  let configured = false;
  const tailscale = new CliDashboardTailscaleExposure(async (args) => {
    calls.push([...args]);
    if (args[1] === "status") {
      return {
        stdout: JSON.stringify({
          TCP: {
            "443": { HTTPS: true },
            ...(configured ? { "41738": { HTTPS: true } } : {}),
          },
          Web: {
            "other.example.ts.net:443": {
              Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } },
            },
            ...(configured
              ? {
                "automode.example.ts.net:41738": {
                  Handlers: { "/": { Proxy: "http://127.0.0.1:41738" } },
                },
              }
              : {}),
          },
        }),
        stderr: "",
      };
    }
    if (args.includes("--bg")) configured = true;
    return { stdout: "Available at https://automode.example.ts.net:41738", stderr: "" };
  });

  assert.deepEqual(await tailscale.expose("http://127.0.0.1:41738"), {
    remoteUrl: "https://automode.example.ts.net:41738",
  });
  await tailscale.stop();
  assert.deepEqual(calls, [
    ["serve", "status", "--json"],
    ["serve", "--bg", "--yes", "--https=41738", "http://127.0.0.1:41738"],
    ["serve", "status", "--json"],
    ["serve", "status", "--json"],
    ["serve", "--https=41738", "--set-path=/", "off"],
  ]);
});

test("Tailscale cleanup leaves a root handler that no longer belongs to this dashboard", async () => {
  const calls: string[][] = [];
  let statusCalls = 0;
  const tailscale = new CliDashboardTailscaleExposure(async (args) => {
    calls.push([...args]);
    if (args[1] !== "status") return { stdout: "", stderr: "" };
    statusCalls += 1;
    return {
      stdout: JSON.stringify({
        TCP: { "443": { HTTPS: true } },
        Web: {
          "automode.example.ts.net:443": {
            Handlers: {
              "/": {
                Proxy: statusCalls === 1
                  ? "http://127.0.0.1:41738"
                  : "http://127.0.0.1:3000",
              },
            },
          },
        },
      }),
      stderr: "",
    };
  });

  await tailscale.expose("http://127.0.0.1:41738");
  await tailscale.stop();
  assert.deepEqual(calls, [
    ["serve", "status", "--json"],
    ["serve", "status", "--json"],
  ]);
});

test("Tailscale verifies an installed handler instead of depending on command output", async () => {
  let configured = false;
  const tailscale = new CliDashboardTailscaleExposure(async (args) => {
    if (args[1] === "status") {
      return {
        stdout: JSON.stringify(configured
          ? {
            TCP: { "41738": { HTTPS: true } },
            Web: {
              "automode.example.ts.net:41738": {
                Handlers: { "/": { Proxy: "http://127.0.0.1:41738" } },
              },
            },
          }
          : {}),
        stderr: "",
      };
    }
    configured = true;
    return { stdout: "", stderr: "" };
  });

  assert.deepEqual(await tailscale.expose("http://127.0.0.1:41738"), {
    remoteUrl: "https://automode.example.ts.net:41738",
  });
});

test("Tailscale retains pending ownership when post-install verification fails", async () => {
  const calls: string[][] = [];
  let configured = false;
  let statusCalls = 0;
  const tailscale = new CliDashboardTailscaleExposure(async (args) => {
    calls.push([...args]);
    if (args[1] === "status") {
      statusCalls += 1;
      if (statusCalls === 2) throw new Error("status unavailable");
      return {
        stdout: JSON.stringify(configured
          ? {
            TCP: { "41738": { HTTPS: true } },
            Web: {
              "automode.example.ts.net:41738": {
                Handlers: { "/": { Proxy: "http://127.0.0.1:41738" } },
              },
            },
          }
          : {}),
        stderr: "",
      };
    }
    if (args.includes("--bg")) configured = true;
    return { stdout: "", stderr: "" };
  });

  await assert.rejects(
    () => tailscale.expose("http://127.0.0.1:41738"),
    /status unavailable/,
  );
  await tailscale.stop();
  assert.deepEqual(calls.at(-1), ["serve", "--https=41738", "--set-path=/", "off"]);
});

test("successful Tailscale exposure allows only its private host and same-origin mutations", async () => {
  const commands: unknown[] = [];
  let exposedLocalUrl = "";
  let stopCalls = 0;
  const dashboard = createCoordinatorDashboard({
    tailscale: {
      async expose(localUrl) {
        exposedLocalUrl = localUrl;
        return { remoteUrl: "https://automode.example.ts.net" };
      },
      async stop() { stopCalls += 1; },
    },
    onCommand: async (command) => { commands.push(command); },
  });

  try {
    const status = await dashboard.start(projection());
    assert.equal(status.localUrl, exposedLocalUrl);
    assert.equal(status.remoteUrl, "https://automode.example.ts.net");
    const snapshotResponse = await requestDashboard(
      status.localUrl,
      "/api/snapshot",
      "automode.example.ts.net",
    );
    assert.equal(snapshotResponse.status, 200);
    const snapshot = JSON.parse(snapshotResponse.body) as { revision: number; csrfToken: string };
    const commandResponse = await requestDashboard(
      status.localUrl,
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
  const status = await dashboard.start(projection("one"));

  const controller = new AbortController();
  try {
    const response = await fetch(`${status.localUrl}/api/events`, {
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
      kind: "assistant",
      message: "Focused tests passed.",
      data: { exitCode: 0 },
    } as const;
    dashboard.appendActivity(activity);
    await readUntil('event: activity\ndata: {"id":"activity-43","itemKey":"issue:43","occurredAt":"2026-08-17T12:00:00.000Z","kind":"assistant","message":"Focused tests passed.","data":{"exitCode":0}}');
    const snapshot = await (await fetch(`${status.localUrl}/api/snapshot`)).json() as {
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
  const status = await dashboard.start(projection());
  try {
    for (let index = 0; index < 505; index += 1) {
      dashboard.appendActivity({
        id: `activity-${index}`,
        itemKey: "issue:45",
        occurredAt: `2026-08-17T12:00:${String(index % 60).padStart(2, "0")}.000Z`,
        kind: "assistant",
        message: `activity ${index}`,
        data: { attempt: 1, sessionId: "session-45", source: "live" },
      });
    }
    const snapshot = await (await fetch(`${status.localUrl}/api/snapshot`)).json() as {
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
  const status = await dashboard.start(projection("first"));

  try {
    const snapshot = await (await fetch(`${status.localUrl}/api/snapshot`)).json() as {
      revision: number;
      csrfToken: string;
    };
    const headers = {
      "content-type": "application/json",
      origin: status.localUrl,
      "x-automode-csrf": snapshot.csrfToken,
      "if-match": `\"${snapshot.revision}\"`,
    };
    const refresh = await fetch(`${status.localUrl}/api/commands/refresh`, {
      method: "POST", headers, body: "{}",
    });
    assert.equal(refresh.status, 204);

    const drain = await fetch(`${status.localUrl}/api/commands/drain`, {
      method: "POST", headers, body: "{}",
    });
    assert.equal(drain.status, 204);

    const stage = await fetch(`${status.localUrl}/api/commands/stage-state`, {
      method: "POST", headers,
      body: JSON.stringify({ stage: "auto-review", state: "DRAINING" }),
    });
    assert.equal(stage.status, 204);
    assert.deepEqual(commands, [
      { type: "refresh" },
      { type: "drain" },
      { type: "set-stage-state", stage: "auto-review", state: "DRAINING" },
    ]);

    const crossOrigin = await fetch(`${status.localUrl}/api/commands/refresh`, {
      method: "POST",
      headers: { ...headers, origin: "https://attacker.example" },
      body: "{}",
    });
    assert.equal(crossOrigin.status, 403);
    const missingCsrf = await fetch(`${status.localUrl}/api/commands/refresh`, {
      method: "POST",
      headers: { ...headers, "x-automode-csrf": "wrong" },
      body: "{}",
    });
    assert.equal(missingCsrf.status, 403);

    dashboard.publish(projection("new"));
    const stale = await fetch(`${status.localUrl}/api/commands/refresh`, {
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
    const firstStatus = await first;
    assert.match(firstStatus.localUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(firstStatus.remoteUrl, "https://automode.example.ts.net");
    assert.deepEqual(await second, firstStatus);
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
  const status = await dashboard.start(projection());

  const firstStop = dashboard.stop();
  const secondStop = dashboard.stop();
  const results = await Promise.allSettled([firstStop, secondStop]);
  assert.deepEqual(results.map(({ status }) => status), ["rejected", "rejected"]);
  assert.equal(stopCalls, 1);

  await dashboard.stop();
  assert.equal(stopCalls, 2);
  await assert.rejects(() => fetch(`${status.localUrl}/api/snapshot`));
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
  const status = await starting;
  await stopping;
  assert.equal(stopObservedEstablishedExposure, true);
  await assert.rejects(() => fetch(`${status.localUrl}/api/snapshot`));
});

test("another dashboard uses an independent loopback port instead of blocking startup", async () => {
  const first = createCoordinatorDashboard({
    tailscale: unavailableTailscale,
    onCommand: async () => undefined,
  });
  const second = createCoordinatorDashboard({
    tailscale: unavailableTailscale,
    onCommand: async () => undefined,
  });

  try {
    const firstStatus = await first.start(projection("first"));
    const secondStatus = await second.start(projection("second"));
    assert.notEqual(firstStatus.localUrl, secondStatus.localUrl);
    assert.equal((await fetch(`${firstStatus.localUrl}/api/snapshot`)).status, 200);
    assert.equal((await fetch(`${secondStatus.localUrl}/api/snapshot`)).status, 200);
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});

test("black-box /exit force-stops active Ticket Sessions and exits", { timeout: 20_000 }, async () => {
  const launched = launchDashboardBlackBox({
    completionDelayMilliseconds: 60_000,
    timeoutMilliseconds: 15_000,
  });
  try {
    await launched.ready;
    launched.submitCommand("/exit");
    const result = await launched.exited;
    assert.equal(result.exitCode, 0);
    assert.match(result.visibleOutput, /\/exit: force-stop active Ticket Sessions, then exit/);
  } finally {
    await launched.stop();
  }
});

test("black-box /automode supervision reaches live activity and graceful drain", { timeout: 30_000 }, async () => {
  const launched = launchDashboardBlackBox();
  let dashboardUrl: URL | undefined;
  let visibleOutput = "";
  try {
    dashboardUrl = (await launched.ready).dashboardUrl;
    const supervise = async (renderedDashboardUrl: URL) => {
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
          snapshot = await (await fetch(new URL("/api/snapshot", renderedDashboardUrl))).json() as AcceptanceSnapshot;
          const candidate = dashboardCandidate(snapshot.projection, "issue:50");
          if (
            candidate?.status === "running"
            && snapshot.activities.some((activity) => activity.message?.includes("passes the full suite"))
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
      assert.ok(snapshot.activities.some((activity) => activity.message?.includes("passes the full suite")));
      assert.equal(snapshot.projection.run.lifecycle, "degraded");
      assert.ok(snapshot.projection.tailscaleError);
      assert.match(snapshot.projection.tailscaleError, /acceptance harness/);
      const page = await fetch(renderedDashboardUrl);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<main id="app"/);
      const drain = await fetch(new URL("/api/commands/drain", renderedDashboardUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: renderedDashboardUrl.origin,
          "x-automode-csrf": snapshot.csrfToken,
          "if-match": `"${snapshot.revision}"`,
        },
        body: "{}",
      });
      assert.equal(drain.status, 204);
    };
    await supervise(dashboardUrl);
    visibleOutput = (await launched.exited).visibleOutput;
  } finally {
    await launched.stop();
    if (!visibleOutput) visibleOutput = stripTerminalControl(launched.output());
  }

  assert.ok(dashboardUrl, "the TUI must render an OSC-8 localhost dashboard hyperlink");
  assert.match(visibleOutput, /AUTOMODE MAIN SESSION/);
  assert.match(visibleOutput, /owner\/repository/);
  assert.match(visibleOutput, new RegExp(dashboardUrl.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(visibleOutput, /TAILSCALE ERROR/);
  assert.match(visibleOutput, /Stages Auto-Triage (?:ON|DRAINING|OFF)/);
  assert.match(visibleOutput, /Auto-Grilling (?:ON|DRAINING|OFF)/);
  assert.match(visibleOutput, /Auto-Implement (?:ON|DRAINING|OFF)/);
  assert.match(visibleOutput, /Auto-Review (?:ON|DRAINING|OFF)/);
  assert.match(visibleOutput, /Candidates \d+ open\s+·\s+\d+ active\s+·\s+\d+ queued\s+·\s+\d+ held\s+·\s+\d+ retrying\s+·\s+\d+ exhausted/);
  assert.match(visibleOutput, /Poll last .*·\s+next/);
  assert.match(visibleOutput, /\/drain: graceful drain/);
  assert.match(visibleOutput, /\/exit: force-stop active Ticket Sessions, then exit/);
});
