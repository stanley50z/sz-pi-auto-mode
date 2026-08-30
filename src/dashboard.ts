import { randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { promisify } from "node:util";
import {
  AUTOMATION_STAGES,
  type AutomationStage,
  type AutomationStageOperatingStateValue,
} from "./stage-configuration.js";
import {
  createDashboardUiAssets,
  type DashboardActivityEntry,
  type DashboardProjection as BrowserDashboardProjection,
} from "./dashboard-ui.js";

export const AUTOMODE_DASHBOARD_PORT = 41_738;
export const AUTOMODE_DASHBOARD_LOCAL_URL = `http://127.0.0.1:${AUTOMODE_DASHBOARD_PORT}`;

export type DashboardStageOperatingState = AutomationStageOperatingStateValue;
export type DashboardProjection = BrowserDashboardProjection;

export interface DashboardActivity {
  readonly id: string;
  readonly itemKey: string;
  readonly occurredAt: string;
  readonly kind: DashboardActivityEntry["kind"];
  readonly message?: string;
  readonly data?: unknown;
}

export type DashboardCommand =
  | { readonly type: "refresh" }
  | { readonly type: "drain" }
  | {
    readonly type: "set-stage-state";
    readonly stage: AutomationStage;
    readonly state: DashboardStageOperatingState;
  };

export interface DashboardStatus {
  readonly localUrl: string;
  readonly remoteUrl?: string;
  readonly exposureError?: string;
}

export interface DashboardTailscaleExposure {
  expose(localUrl: string): Promise<{ readonly remoteUrl: string }>;
  stop(): Promise<void>;
}

export interface CoordinatorDashboard {
  start(initialProjection: DashboardProjection): Promise<DashboardStatus>;
  publish(projection: DashboardProjection): void;
  appendActivity(activity: DashboardActivity): void;
  stop(): Promise<void>;
}

export interface CoordinatorDashboardOptions {
  readonly onCommand: (command: DashboardCommand) => void | Promise<void>;
  readonly tailscale?: DashboardTailscaleExposure;
}

const execFileAsync = promisify(execFile);
const MAX_DASHBOARD_ACTIVITY_MESSAGE = 4_000;
const MAX_DASHBOARD_ACTIVITY_BYTES = 16_384;
const MAX_DASHBOARD_ACTIVITIES_PER_ITEM = 500;
const MAX_DASHBOARD_ACTIVITIES_TOTAL = 10_000;

function boundedDashboardActivity(activity: DashboardActivity): DashboardActivity {
  const message = activity.message && activity.message.length > MAX_DASHBOARD_ACTIVITY_MESSAGE
    ? `${activity.message.slice(0, MAX_DASHBOARD_ACTIVITY_MESSAGE)}… [truncated]`
    : activity.message;
  const candidate = { ...activity, ...(message === undefined ? {} : { message }) };
  const serialized = JSON.stringify(candidate);
  if (Buffer.byteLength(serialized) > MAX_DASHBOARD_ACTIVITY_BYTES) {
    throw new Error("Dashboard activity exceeds the 16 KiB structured event limit");
  }
  return JSON.parse(serialized) as DashboardActivity;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface TailscaleCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

type TailscaleCommandRunner = (args: readonly string[]) => Promise<TailscaleCommandResult>;

const runTailscaleCommand: TailscaleCommandRunner = async (args) => {
  const result = await execFileAsync(
    "tailscale",
    [...args],
    { encoding: "utf8", timeout: 10_000, windowsHide: true },
  );
  return { stdout: result.stdout, stderr: result.stderr };
};

interface TailscaleWebRoute {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly proxy?: string;
}

function tailscaleWebRoutes(status: unknown): TailscaleWebRoute[] {
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    throw new Error("tailscale serve returned an invalid status");
  }
  const web = (status as { Web?: unknown }).Web;
  if (web === undefined) return [];
  if (!web || typeof web !== "object" || Array.isArray(web)) {
    throw new Error("tailscale serve returned an invalid Web status");
  }

  const routes: TailscaleWebRoute[] = [];
  for (const [hostAndPort, value] of Object.entries(web)) {
    const separator = hostAndPort.lastIndexOf(":");
    const port = Number(hostAndPort.slice(separator + 1));
    const host = hostAndPort.slice(0, separator);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("tailscale serve returned an invalid HTTPS endpoint");
    }
    const handlers = value && typeof value === "object" && !Array.isArray(value)
      ? (value as { Handlers?: unknown }).Handlers
      : undefined;
    if (!handlers || typeof handlers !== "object" || Array.isArray(handlers)) continue;
    for (const [path, handler] of Object.entries(handlers)) {
      const proxy = handler && typeof handler === "object" && !Array.isArray(handler)
        ? (handler as { Proxy?: unknown }).Proxy
        : undefined;
      routes.push({
        host,
        port,
        path,
        ...(typeof proxy === "string" ? { proxy } : {}),
      });
    }
  }
  return routes;
}

function usedTailscalePorts(status: unknown, routes: readonly TailscaleWebRoute[]): Set<number> {
  const used = new Set(routes.map(({ port }) => port));
  if (!status || typeof status !== "object" || Array.isArray(status)) return used;
  const tcp = (status as { TCP?: unknown }).TCP;
  if (!tcp || typeof tcp !== "object" || Array.isArray(tcp)) return used;
  for (const port of Object.keys(tcp).map(Number)) {
    if (Number.isInteger(port) && port >= 1 && port <= 65_535) used.add(port);
  }
  return used;
}

function availableTailscalePort(preferred: number, used: ReadonlySet<number>): number {
  for (let offset = 0; offset < 64_512; offset += 1) {
    const port = 1_024 + ((preferred - 1_024 + offset) % 64_512);
    if (!used.has(port)) return port;
  }
  throw new Error("No Tailscale HTTPS port is available for the Automode dashboard");
}

/** Owns one Tailscale Serve handler without replacing handlers owned by other processes. */
export class CliDashboardTailscaleExposure implements DashboardTailscaleExposure {
  private ownedRoute: { readonly httpsPort: number; readonly localUrl: string } | undefined;

  constructor(private readonly run: TailscaleCommandRunner = runTailscaleCommand) {}

  private async status(): Promise<{ readonly value: unknown; readonly routes: TailscaleWebRoute[] }> {
    const { stdout } = await this.run(["serve", "status", "--json"]);
    const value: unknown = JSON.parse(stdout);
    return { value, routes: tailscaleWebRoutes(value) };
  }

  private matchingRoute(
    routes: readonly TailscaleWebRoute[],
    localUrl: string,
    httpsPort?: number,
  ): TailscaleWebRoute | undefined {
    return routes.find((route) =>
      route.path === "/"
      && route.proxy === localUrl
      && (httpsPort === undefined || route.port === httpsPort)
    );
  }

  private remoteUrl(route: TailscaleWebRoute): string {
    const remote = new URL(`https://${route.host}:${route.port}`);
    if (!remote.hostname.endsWith(".ts.net")) {
      throw new Error("tailscale serve returned an invalid private tailnet URL");
    }
    return remote.origin;
  }

  async expose(localUrl: string): Promise<{ readonly remoteUrl: string }> {
    const local = new URL(localUrl);
    const preferredPort = Number(local.port);
    if (local.protocol !== "http:" || !Number.isInteger(preferredPort) || preferredPort < 1) {
      throw new Error(`Automode dashboard has an invalid loopback URL: ${localUrl}`);
    }

    const current = await this.status();
    const existing = this.matchingRoute(current.routes, localUrl);
    if (existing) {
      const remoteUrl = this.remoteUrl(existing);
      this.ownedRoute = { httpsPort: existing.port, localUrl };
      return { remoteUrl };
    }

    const httpsPort = availableTailscalePort(
      preferredPort,
      usedTailscalePorts(current.value, current.routes),
    );
    this.ownedRoute = { httpsPort, localUrl };
    let setupError: unknown;
    try {
      await this.run([
        "serve",
        "--bg",
        "--yes",
        `--https=${httpsPort}`,
        localUrl,
      ]);
    } catch (error) {
      setupError = error;
    }

    const installed = this.matchingRoute((await this.status()).routes, localUrl, httpsPort);
    if (!installed) {
      this.ownedRoute = undefined;
      if (setupError) throw setupError;
      throw new Error("tailscale serve did not install the Automode dashboard handler");
    }
    try {
      return { remoteUrl: this.remoteUrl(installed) };
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.ownedRoute) return;
    const owned = this.ownedRoute;
    const current = await this.status();
    if (!this.matchingRoute(current.routes, owned.localUrl, owned.httpsPort)) {
      this.ownedRoute = undefined;
      return;
    }
    await this.run(["serve", `--https=${owned.httpsPort}`, "--set-path=/", "off"]);
    this.ownedRoute = undefined;
  }
}

const DASHBOARD_UI = createDashboardUiAssets();

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

function sendText(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  sendText(response, status, "application/json; charset=utf-8", JSON.stringify(value));
}

function serializeProjection(projection: DashboardProjection): DashboardProjection {
  const serialized = JSON.stringify(projection);
  if (serialized === undefined) throw new Error("Dashboard projection must be JSON serializable");
  return JSON.parse(serialized) as DashboardProjection;
}

function secureEqual(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 16_384) throw new Error("Dashboard command body exceeds 16 KiB");
    chunks.push(bytes);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Dashboard command body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

class HttpCoordinatorDashboard implements CoordinatorDashboard {
  private readonly tailscale: DashboardTailscaleExposure;
  private readonly csrfToken = randomBytes(32).toString("base64url");
  private server: Server | undefined;
  private startPromise: Promise<DashboardStatus> | undefined;
  private stopPromise: Promise<void> | undefined;
  private exposureNeedsStop = false;
  private projection!: DashboardProjection;
  private readonly activitiesByItem = new Map<string, DashboardActivity[]>();
  private activityRetentionTruncated = false;
  private revision = 0;
  private eventSequence = 0;
  private readonly eventStreams = new Set<ServerResponse>();
  private status: DashboardStatus = { localUrl: AUTOMODE_DASHBOARD_LOCAL_URL };
  private readonly allowedOrigins = new Map<string, string>();

  constructor(private readonly options: CoordinatorDashboardOptions) {
    this.tailscale = options.tailscale ?? new CliDashboardTailscaleExposure();
  }

  start(initialProjection: DashboardProjection): Promise<DashboardStatus> {
    if (this.startPromise) return this.startPromise;
    const pending = this.startOnce(initialProjection).catch((error) => {
      if (this.startPromise === pending) {
        this.startPromise = undefined;
        this.server = undefined;
      }
      throw error;
    });
    this.startPromise = pending;
    return pending;
  }

  private async startOnce(initialProjection: DashboardProjection): Promise<DashboardStatus> {
    this.projection = serializeProjection(initialProjection);
    this.activitiesByItem.clear();
    this.activityRetentionTruncated = false;
    this.revision += 1;
    this.eventSequence += 1;
    const server = createServer((request, response) => {
      void this.handleRequest(request, response).catch((error) => {
        if (!response.headersSent) sendJson(response, 500, { error: errorMessage(error) });
        else response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
    this.server = server;
    const listen = (port: number) => new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
    try {
      await listen(AUTOMODE_DASHBOARD_PORT);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      await listen(0);
    }
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Automode dashboard did not receive a TCP port");
    const localUrl = `http://127.0.0.1:${address.port}`;
    this.allowedOrigins.clear();
    this.allowedOrigins.set(`127.0.0.1:${address.port}`, localUrl);
    this.allowedOrigins.set(`localhost:${address.port}`, `http://localhost:${address.port}`);
    this.exposureNeedsStop = true;
    try {
      const { remoteUrl } = await this.tailscale.expose(localUrl);
      const parsedRemoteUrl = new URL(remoteUrl);
      if (parsedRemoteUrl.protocol !== "https:" || !parsedRemoteUrl.hostname.endsWith(".ts.net")) {
        throw new Error("tailscale serve returned an invalid private tailnet URL");
      }
      this.allowedOrigins.set(parsedRemoteUrl.host.toLowerCase(), parsedRemoteUrl.origin);
      this.status = { localUrl, remoteUrl: parsedRemoteUrl.origin };
    } catch (error) {
      this.status = {
        localUrl,
        exposureError: errorMessage(error),
      };
    }
    return this.status;
  }

  private retainedActivities(): DashboardActivity[] {
    return [...this.activitiesByItem.values()].flat();
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = request.headers.host?.toLowerCase();
    const allowedOrigin = host ? this.allowedOrigins.get(host) : undefined;
    if (!allowedOrigin) {
      sendJson(response, 421, { error: "Unrecognized dashboard host" });
      return;
    }
    if (request.method === "GET" && request.url === "/api/events") {
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        "content-type": "text/event-stream; charset=utf-8",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      this.eventStreams.add(response);
      response.once("close", () => this.eventStreams.delete(response));
      this.writeEvent(response, this.eventSequence, "projection", {
        revision: this.revision,
        projection: this.projection,
        network: this.status,
        activities: this.retainedActivities(),
        activitiesTruncated: this.activityRetentionTruncated,
      });
      return;
    }
    if (request.method === "GET" && request.url === "/api/snapshot") {
      sendJson(response, 200, {
        revision: this.revision,
        projection: this.projection,
        network: this.status,
        activities: this.retainedActivities(),
        activitiesTruncated: this.activityRetentionTruncated,
        csrfToken: this.csrfToken,
      });
      return;
    }
    if (request.method === "GET" && request.url && request.url in DASHBOARD_UI) {
      const asset = DASHBOARD_UI[request.url as keyof typeof DASHBOARD_UI];
      sendText(response, 200, asset.contentType, asset.body);
      return;
    }
    if (request.method !== "POST" || !request.url?.startsWith("/api/commands/")) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    if (request.headers.origin !== allowedOrigin) {
      sendJson(response, 403, { error: "Dashboard command origin is not allowed" });
      return;
    }
    if (!secureEqual(request.headers["x-automode-csrf"] as string | undefined, this.csrfToken)) {
      sendJson(response, 403, { error: "Dashboard command CSRF token is invalid" });
      return;
    }
    if (request.headers["content-type"]?.toLowerCase() !== "application/json") {
      sendJson(response, 415, { error: "Dashboard commands require application/json" });
      return;
    }
    const currentTag = `\"${this.revision}\"`;
    if (request.headers["if-match"] === undefined) {
      sendJson(response, 428, { error: "Dashboard command requires the current projection revision" });
      return;
    }
    if (request.headers["if-match"] !== currentTag) {
      sendJson(response, 409, { error: "Dashboard projection is stale", revision: this.revision });
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(request);
    } catch (error) {
      sendJson(response, 400, { error: errorMessage(error) });
      return;
    }
    let command: DashboardCommand;
    if (request.url === "/api/commands/refresh" && hasExactlyKeys(body, [])) {
      command = { type: "refresh" };
    } else if (request.url === "/api/commands/drain" && hasExactlyKeys(body, [])) {
      command = { type: "drain" };
    } else if (
      request.url === "/api/commands/stage-state"
      && hasExactlyKeys(body, ["stage", "state"])
      && typeof body.stage === "string"
      && (AUTOMATION_STAGES as readonly string[]).includes(body.stage)
      && (body.state === "ON" || body.state === "DRAINING" || body.state === "OFF")
    ) {
      command = {
        type: "set-stage-state",
        stage: body.stage as AutomationStage,
        state: body.state,
      };
    } else {
      sendJson(response, 400, { error: "Invalid dashboard command" });
      return;
    }
    await this.options.onCommand(command);
    response.writeHead(204, SECURITY_HEADERS);
    response.end();
  }

  private writeEvent(
    response: ServerResponse,
    sequence: number,
    event: "projection" | "activity",
    data: unknown,
  ): void {
    response.write(`id: ${sequence}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private broadcast(event: "projection" | "activity", data: unknown): void {
    this.eventSequence += 1;
    for (const response of this.eventStreams) {
      this.writeEvent(response, this.eventSequence, event, data);
    }
  }

  publish(projection: DashboardProjection): void {
    this.projection = serializeProjection(projection);
    this.revision += 1;
    this.broadcast("projection", {
      revision: this.revision,
      projection: this.projection,
      network: this.status,
      activities: this.retainedActivities(),
      activitiesTruncated: this.activityRetentionTruncated,
    });
  }

  appendActivity(activity: DashboardActivity): void {
    const parsed = boundedDashboardActivity(activity);
    let retained = this.activitiesByItem.get(parsed.itemKey);
    if (!retained) {
      retained = [];
      this.activitiesByItem.set(parsed.itemKey, retained);
    }
    if (retained.length >= MAX_DASHBOARD_ACTIVITIES_PER_ITEM) {
      const markerId = `${parsed.itemKey}:activity-truncated`;
      if (retained[0]?.id === markerId) retained.splice(1, 1);
      else {
        retained.splice(0, 2);
        retained.unshift({
          id: markerId,
          itemKey: parsed.itemKey,
          occurredAt: parsed.occurredAt,
          kind: "coordinator",
          message: "Earlier process-local activity was truncated to keep this dashboard responsive.",
          data: parsed.data,
        });
      }
    }
    retained.push(parsed);
    while (this.retainedActivities().length > MAX_DASHBOARD_ACTIVITIES_TOTAL) {
      const oldestItem = this.activitiesByItem.keys().next().value as string | undefined;
      if (oldestItem === undefined) break;
      this.activitiesByItem.delete(oldestItem);
      this.activityRetentionTruncated = true;
    }
    this.broadcast("activity", parsed);
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const pending = this.stopOnce().finally(() => {
      if (this.stopPromise === pending) this.stopPromise = undefined;
    });
    this.stopPromise = pending;
    return pending;
  }

  private async stopOnce(): Promise<void> {
    const starting = this.startPromise;
    if (starting) await starting.catch(() => undefined);
    const server = this.server;
    if (!server && !this.exposureNeedsStop) return;
    this.server = undefined;
    this.startPromise = undefined;
    let exposureError: unknown;
    if (this.exposureNeedsStop) {
      try {
        await this.tailscale.stop();
        this.exposureNeedsStop = false;
      } catch (error) {
        exposureError = error;
      }
    }
    for (const response of this.eventStreams) response.end();
    this.eventStreams.clear();
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
    if (exposureError) throw exposureError;
  }
}

export function createCoordinatorDashboard(options: CoordinatorDashboardOptions): CoordinatorDashboard {
  return new HttpCoordinatorDashboard(options);
}
