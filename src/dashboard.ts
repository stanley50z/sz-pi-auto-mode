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

export class CliDashboardTailscaleExposure implements DashboardTailscaleExposure {
  private exposed = false;

  async expose(localUrl: string): Promise<{ readonly remoteUrl: string }> {
    const { stdout: serializedStatus } = await execFileAsync(
      "tailscale",
      ["serve", "status", "--json"],
      { encoding: "utf8", timeout: 10_000, windowsHide: true },
    );
    const currentStatus: unknown = JSON.parse(serializedStatus);
    if (
      !currentStatus
      || typeof currentStatus !== "object"
      || Array.isArray(currentStatus)
      || Object.keys(currentStatus).length > 0
    ) {
      throw new Error("an existing Tailscale Serve configuration prevents private dashboard exposure");
    }
    const { stdout, stderr } = await execFileAsync(
      "tailscale",
      ["serve", "--bg", "--yes", localUrl],
      { encoding: "utf8", timeout: 10_000, windowsHide: true },
    );
    this.exposed = true;
    const output = `${stdout}\n${stderr}`;
    const match = output.match(/https:\/\/[a-z0-9.-]+\.ts\.net(?::\d+)?/i);
    if (!match) throw new Error("tailscale serve did not report a private tailnet URL");
    return { remoteUrl: match[0] };
  }

  async stop(): Promise<void> {
    if (!this.exposed) return;
    await execFileAsync(
      "tailscale",
      ["serve", "reset"],
      { encoding: "utf8", timeout: 10_000, windowsHide: true },
    );
    this.exposed = false;
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
  private readonly allowedOrigins = new Map([
    [`127.0.0.1:${AUTOMODE_DASHBOARD_PORT}`, AUTOMODE_DASHBOARD_LOCAL_URL],
    [`localhost:${AUTOMODE_DASHBOARD_PORT}`, `http://localhost:${AUTOMODE_DASHBOARD_PORT}`],
  ]);

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
    await new Promise<void>((resolve, reject) => {
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
      server.listen(AUTOMODE_DASHBOARD_PORT, "127.0.0.1");
    });
    this.exposureNeedsStop = true;
    try {
      const { remoteUrl } = await this.tailscale.expose(AUTOMODE_DASHBOARD_LOCAL_URL);
      const parsedRemoteUrl = new URL(remoteUrl);
      if (parsedRemoteUrl.protocol !== "https:" || !parsedRemoteUrl.hostname.endsWith(".ts.net")) {
        throw new Error("tailscale serve returned an invalid private tailnet URL");
      }
      this.allowedOrigins.set(parsedRemoteUrl.host.toLowerCase(), parsedRemoteUrl.origin);
      this.status = { localUrl: AUTOMODE_DASHBOARD_LOCAL_URL, remoteUrl: parsedRemoteUrl.origin };
    } catch (error) {
      this.status = {
        localUrl: AUTOMODE_DASHBOARD_LOCAL_URL,
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
