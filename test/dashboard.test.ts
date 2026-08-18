import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import test from "node:test";
import {
  createCoordinatorDashboard,
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

test("the Coordinator dashboard serves its initial projection on the fixed loopback URL", async () => {
  const dashboard = createCoordinatorDashboard({
    tailscale: unavailableTailscale,
    onCommand: async () => undefined,
  });

  try {
    const status = await dashboard.start({ repository: "owner/repository", candidates: 3 });
    assert.equal(status.localUrl, "http://127.0.0.1:41738");
    assert.equal(status.remoteUrl, undefined);
    assert.equal(status.exposureError, "tailscale executable was not found");

    const response = await fetch("http://127.0.0.1:41738/api/snapshot");
    assert.equal(response.status, 200);
    const snapshot = await response.json() as Record<string, unknown>;
    assert.equal(snapshot.revision, 1);
    assert.deepEqual(snapshot.projection, { repository: "owner/repository", candidates: 3 });
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
  await dashboard.start({});

  try {
    const page = await fetch("http://127.0.0.1:41738/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Automode Dashboard/);
    assert.equal((await fetch("http://127.0.0.1:41738/app.js")).status, 200);
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
    assert.deepEqual(await dashboard.start({ repository: "owner/repository" }), {
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
  await dashboard.start({ repository: "owner/repository", candidates: 1 });

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

    await readUntil('event: projection\ndata: {"revision":1,"projection":{"repository":"owner/repository","candidates":1}');
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    dashboard.publish({ repository: "owner/repository", candidates: 2 });
    await readUntil('event: projection\ndata: {"revision":2,"projection":{"repository":"owner/repository","candidates":2}');
    dashboard.appendActivity({
      itemKey: "issue:43",
      occurredAt: "2026-08-17T12:00:00.000Z",
      kind: "tool",
      message: "npm test",
      data: { exitCode: 0 },
    });
    await readUntil('event: activity\ndata: {"itemKey":"issue:43","occurredAt":"2026-08-17T12:00:00.000Z","kind":"tool","message":"npm test","data":{"exitCode":0}}');
    await reader.cancel();
  } finally {
    controller.abort();
    await dashboard.stop();
    await dashboard.stop();
  }
});

test("typed supervisory commands require same-origin, CSRF, and a current projection revision", async () => {
  const commands: unknown[] = [];
  const dashboard = createCoordinatorDashboard({
    tailscale: unavailableTailscale,
    onCommand: async (command) => { commands.push(command); },
  });
  await dashboard.start({ value: "first" });

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

    dashboard.publish({ value: "new" });
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

  const first = dashboard.start({ run: "one" });
  const second = dashboard.start({ run: "ignored" });
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
  await dashboard.start({});

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

  const starting = dashboard.start({});
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
      () => dashboard.start({}),
      (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE",
    );
    assert.equal(exposureCalls, 0);
    assert.equal(commandCalls, 0);
  } finally {
    await dashboard.stop();
    await new Promise<void>((resolve, reject) => occupant.close((error) => error ? reject(error) : resolve()));
  }
});
