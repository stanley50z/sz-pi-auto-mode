import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPathInside } from "./attestation.js";
import type {
  TicketSessionHandle as CoordinatorTicketSessionHandle,
  TicketSessionHost as CoordinatorTicketSessionHost,
  TicketSessionRequest as CoordinatorTicketSessionRequest,
} from "./coordinator.js";
import { resolveAutomodePaths } from "./paths.js";
import type { AutomationStageConfiguration } from "./stage-configuration.js";

export const TICKET_SESSION_PROTOCOL_VERSION = 1 as const;

export interface TicketSessionLaunchRequest {
  cwd: string;
  skillName: string;
  itemUrl: string;
  configuration: AutomationStageConfiguration;
  sessionName?: string;
  resumeSessionFile?: string;
  home?: string;
  normalAgentDir?: string;
}

export interface TicketSessionChildRequest extends TicketSessionLaunchRequest {
  prompt: string;
}

export interface TicketSessionProcessLaunchOptions {
  entrypoint: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface TicketSessionProcess {
  readonly pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  send(message: unknown, callback: (error: Error | null) => void): boolean;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

export type TicketSessionProcessLauncher = (
  options: TicketSessionProcessLaunchOptions,
) => TicketSessionProcess;

export type TicketSessionTerminalStatus = "clean" | "error" | "waiting";

export interface TicketSessionTerminalResult {
  status: TicketSessionTerminalStatus;
  sessionId?: string;
  sessionFile?: string;
  error?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export type TicketSessionLifecycleState =
  | "starting"
  | "ready"
  | "running"
  | "terminating";

export interface TicketSessionLifecycleEvent {
  type: "lifecycle";
  state: TicketSessionLifecycleState;
  timestamp: number;
  processId?: number;
  sessionId?: string;
  sessionFile?: string;
}

export interface TicketSessionActivityEvent {
  type: "activity";
  activity: string;
  timestamp: number;
  toolName?: string;
  isError?: boolean;
}

export type TicketSessionEvent =
  | TicketSessionLifecycleEvent
  | TicketSessionActivityEvent
  | { type: "terminal"; result: TicketSessionTerminalResult };

export interface TicketSessionReady {
  readonly sessionId: string;
  readonly sessionFile: string;
}

export interface TicketSessionRun {
  readonly processId: number | undefined;
  readonly ready: Promise<TicketSessionReady>;
  readonly completion: Promise<TicketSessionTerminalResult>;
  subscribe(listener: (event: TicketSessionEvent) => void): () => void;
  terminate(force?: boolean): Promise<TicketSessionTerminalResult>;
}

export interface TicketSessionHostOptions {
  childEntrypoint?: string;
  launcher?: TicketSessionProcessLauncher;
  env?: NodeJS.ProcessEnv;
  terminationGraceMs?: number;
}

interface ChildTerminalResult {
  status: TicketSessionTerminalStatus;
  sessionId?: string;
  sessionFile?: string;
  error?: string;
}

interface ChildEventMessage {
  type: "ticket-session:event";
  version: 1;
  event: TicketSessionLifecycleEvent | TicketSessionActivityEvent;
}

interface ChildTerminalMessage {
  type: "ticket-session:terminal";
  version: 1;
  result: ChildTerminalResult;
}

export interface TicketSessionStartMessage {
  type: "ticket-session:start";
  version: 1;
  request: TicketSessionChildRequest;
}

export interface TicketSessionTerminateMessage {
  type: "ticket-session:terminate";
  version: 1;
}

function defaultChildEntrypoint(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "ticket-session-main.js");
}

const defaultLauncher: TicketSessionProcessLauncher = ({ entrypoint, cwd, env }) =>
  spawn(process.execPath, [entrypoint], {
    cwd,
    env,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    windowsHide: true,
  }) as TicketSessionProcess;

export function createCanonicalTicketSessionPrompt(skillName: string, itemUrl: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) {
    throw new Error(`Invalid canonical skill name: ${skillName}`);
  }
  if (/\s/.test(itemUrl)) throw new Error("Ticket item URL must not contain whitespace");
  let parsed: URL;
  try {
    parsed = new URL(itemUrl);
  } catch (error) {
    throw new Error(`Invalid ticket item URL: ${itemUrl}`, { cause: error });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Ticket item URL must use HTTP or HTTPS: ${itemUrl}`);
  }
  return `/skill:${skillName} ${itemUrl}`;
}

function isChildEvent(message: unknown): message is ChildEventMessage {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Partial<ChildEventMessage>;
  if (
    candidate.type !== "ticket-session:event"
    || candidate.version !== TICKET_SESSION_PROTOCOL_VERSION
    || !candidate.event
    || typeof candidate.event !== "object"
  ) return false;
  if (candidate.event.type === "lifecycle") {
    if (
      !["starting", "ready", "running", "terminating"].includes(candidate.event.state)
      || typeof candidate.event.timestamp !== "number"
      || (candidate.event.processId !== undefined && typeof candidate.event.processId !== "number")
      || (candidate.event.sessionId !== undefined && typeof candidate.event.sessionId !== "string")
      || (candidate.event.sessionFile !== undefined && typeof candidate.event.sessionFile !== "string")
    ) return false;
    if (candidate.event.state === "ready" || candidate.event.state === "running") {
      return typeof candidate.event.sessionId === "string"
        && typeof candidate.event.sessionFile === "string";
    }
    return true;
  }
  return candidate.event.type === "activity"
    && typeof candidate.event.activity === "string"
    && typeof candidate.event.timestamp === "number"
    && (candidate.event.toolName === undefined || typeof candidate.event.toolName === "string")
    && (candidate.event.isError === undefined || typeof candidate.event.isError === "boolean");
}

function isChildTerminal(message: unknown): message is ChildTerminalMessage {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Partial<ChildTerminalMessage>;
  if (
    candidate.type !== "ticket-session:terminal"
    || candidate.version !== TICKET_SESSION_PROTOCOL_VERSION
    || !candidate.result
    || !["clean", "error", "waiting"].includes(candidate.result.status)
  ) return false;
  if (
    candidate.result.sessionId !== undefined
    && typeof candidate.result.sessionId !== "string"
  ) return false;
  if (
    candidate.result.sessionFile !== undefined
    && typeof candidate.result.sessionFile !== "string"
  ) return false;
  if (candidate.result.error !== undefined && typeof candidate.result.error !== "string") return false;
  if (candidate.result.status !== "error") {
    return typeof candidate.result.sessionId === "string"
      && typeof candidate.result.sessionFile === "string";
  }
  return typeof candidate.result.error === "string";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class TicketSessionHost {
  readonly #entrypoint: string;
  readonly #launcher: TicketSessionProcessLauncher;
  readonly #env: NodeJS.ProcessEnv;
  readonly #terminationGraceMs: number;

  constructor(options: TicketSessionHostOptions = {}) {
    this.#entrypoint = resolve(options.childEntrypoint ?? defaultChildEntrypoint());
    this.#launcher = options.launcher ?? defaultLauncher;
    this.#env = { ...(options.env ?? process.env) };
    this.#terminationGraceMs = options.terminationGraceMs ?? 5_000;
    if (!Number.isFinite(this.#terminationGraceMs) || this.#terminationGraceMs < 0) {
      throw new Error("Ticket Session termination grace period must be non-negative");
    }
  }

  launch(request: TicketSessionLaunchRequest): TicketSessionRun {
    const cwd = realpathSync(resolve(request.cwd));
    const childRequest: TicketSessionChildRequest = {
      cwd,
      skillName: request.skillName,
      itemUrl: request.itemUrl,
      prompt: createCanonicalTicketSessionPrompt(request.skillName, request.itemUrl),
      configuration: request.configuration,
      ...(request.sessionName === undefined ? {} : { sessionName: request.sessionName }),
      ...(request.resumeSessionFile === undefined
        ? {}
        : { resumeSessionFile: realpathSync(resolve(request.resumeSessionFile)) }),
      ...(request.home === undefined ? {} : { home: resolve(request.home) }),
      ...(request.normalAgentDir === undefined
        ? {}
        : { normalAgentDir: resolve(request.normalAgentDir) }),
    };
    const child = this.#launcher({
      entrypoint: this.#entrypoint,
      cwd,
      env: this.#env,
    });
    const listeners = new Set<(event: TicketSessionEvent) => void>();
    let pendingTerminal: ChildTerminalResult | undefined;
    let supervisionError: string | undefined;
    let settled = false;
    let terminationTimer: NodeJS.Timeout | undefined;
    let terminationPromise: Promise<TicketSessionTerminalResult> | undefined;
    let forced = false;
    let readySettled = false;
    let resolveReady!: (ready: TicketSessionReady) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<TicketSessionReady>((resolveResult, rejectResult) => {
      resolveReady = resolveResult;
      rejectReady = rejectResult;
    });
    void ready.catch(() => undefined);
    let resolveCompletion!: (result: TicketSessionTerminalResult) => void;
    const completion = new Promise<TicketSessionTerminalResult>((resolveResult) => {
      resolveCompletion = resolveResult;
    });
    const emit = (event: TicketSessionEvent): void => {
      if (event.type === "lifecycle" && event.state === "ready") {
        readySettled = true;
        resolveReady({ sessionId: event.sessionId!, sessionFile: event.sessionFile! });
      }
      for (const listener of listeners) listener(event);
    };
    const finish = (
      result: Omit<TicketSessionTerminalResult, "exitCode" | "signal">,
      exitCode: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settled) return;
      settled = true;
      if (terminationTimer) clearTimeout(terminationTimer);
      const terminal = { ...result, exitCode, signal };
      if (!readySettled) {
        readySettled = true;
        if (terminal.sessionId && terminal.sessionFile) {
          resolveReady({ sessionId: terminal.sessionId, sessionFile: terminal.sessionFile });
        } else {
          rejectReady(new Error(terminal.error ?? "Ticket Session ended before reporting persistent identity"));
        }
      }
      emit({ type: "terminal", result: terminal });
      resolveCompletion(terminal);
    };
    const failSupervision = (error: unknown): void => {
      if (supervisionError) return;
      supervisionError = errorText(error);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };

    child.on("message", (message) => {
      if (isChildEvent(message)) {
        emit(message.event);
        return;
      }
      if (isChildTerminal(message)) {
        if (pendingTerminal) {
          failSupervision(new Error("Ticket Session child emitted more than one terminal result"));
          return;
        }
        pendingTerminal = message.result;
        return;
      }
      failSupervision(new Error("Ticket Session child emitted an invalid protocol message"));
    });
    child.on("error", (error) => {
      supervisionError = `Ticket Session child process failed: ${error.message}`;
      finish({ status: "error", error: supervisionError }, child.exitCode, child.signalCode);
    });
    child.on("exit", (code, signal) => {
      if (supervisionError) {
        finish({ status: "error", error: supervisionError }, code, signal);
        return;
      }
      if (!pendingTerminal) {
        finish({ status: "error", error: "Ticket Session child exited without a terminal result" }, code, signal);
        return;
      }
      if (pendingTerminal.status !== "error" && (code !== 0 || signal !== null)) {
        finish({
          status: "error",
          sessionId: pendingTerminal.sessionId,
          sessionFile: pendingTerminal.sessionFile,
          error: `Ticket Session child exited abnormally after reporting ${pendingTerminal.status}`,
        }, code, signal);
        return;
      }
      finish(pendingTerminal, code, signal);
    });

    const startMessage: TicketSessionStartMessage = {
      type: "ticket-session:start",
      version: TICKET_SESSION_PROTOCOL_VERSION,
      request: childRequest,
    };
    child.send(startMessage, (error) => {
      if (error) failSupervision(new Error("Could not send Ticket Session start request", { cause: error }));
    });

    return {
      processId: child.pid,
      ready,
      completion,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      terminate: (force = false) => {
        if (force && !settled && !forced) {
          forced = true;
          if (!child.kill("SIGKILL")) {
            failSupervision(new Error("Could not force Ticket Session termination"));
          }
          terminationPromise = completion;
          return terminationPromise;
        }
        if (terminationPromise) return terminationPromise;
        if (settled) return completion;
        emit({ type: "lifecycle", state: "terminating", timestamp: Date.now(), processId: child.pid });
        const terminateMessage: TicketSessionTerminateMessage = {
          type: "ticket-session:terminate",
          version: TICKET_SESSION_PROTOCOL_VERSION,
        };
        child.send(terminateMessage, (error) => {
          if (error) failSupervision(new Error("Could not request graceful Ticket Session termination", { cause: error }));
        });
        terminationTimer = setTimeout(() => {
          if (settled || forced || child.exitCode !== null || child.signalCode !== null) return;
          forced = true;
          if (!child.kill("SIGKILL")) {
            failSupervision(new Error("Could not force Ticket Session termination"));
          }
        }, this.#terminationGraceMs);
        terminationTimer.unref();
        terminationPromise = completion;
        return terminationPromise;
      },
    };
  }
}

export interface AutomodeTicketSessionHostOptions {
  readonly repository: string;
  readonly configuration: AutomationStageConfiguration;
  readonly home?: string;
  readonly normalAgentDir?: string;
  readonly processHost?: TicketSessionHost;
}

/** Adapts the full-process host to the Coordinator's durable Ticket Session seam. */
export class AutomodeTicketSessionHost implements CoordinatorTicketSessionHost {
  readonly #repository: string;
  readonly #configuration: AutomationStageConfiguration;
  readonly #home: string | undefined;
  readonly #normalAgentDir: string | undefined;
  readonly #processHost: TicketSessionHost;

  constructor(options: AutomodeTicketSessionHostOptions) {
    this.#repository = realpathSync(resolve(options.repository));
    this.#configuration = options.configuration;
    this.#home = options.home;
    this.#normalAgentDir = options.normalAgentDir;
    this.#processHost = options.processHost ?? new TicketSessionHost();
  }

  async start(request: CoordinatorTicketSessionRequest): Promise<CoordinatorTicketSessionHandle> {
    const cwd = request.cwd ?? this.#repository;
    const controlledSessionDir = resolveAutomodePaths(cwd, this.#home, this.#normalAgentDir).sessionDir;
    const resumableSessionFile = request.resumeSessionFile && existsSync(request.resumeSessionFile)
      ? realpathSync(request.resumeSessionFile)
      : undefined;
    const run = this.#processHost.launch({
      cwd,
      skillName: request.skillName,
      itemUrl: request.item.url,
      configuration: this.#configuration,
      sessionName: `Automode ${request.stage} #${request.item.number}`,
      resumeSessionFile: resumableSessionFile && isPathInside(resumableSessionFile, controlledSessionDir)
        ? resumableSessionFile
        : undefined,
      home: this.#home,
      normalAgentDir: this.#normalAgentDir,
    });
    const ready = await run.ready;
    return {
      processId: run.processId === undefined ? "unknown" : String(run.processId),
      sessionId: ready.sessionId,
      sessionFile: ready.sessionFile,
      completion: run.completion.then((result) => ({
        status: result.status,
        ...(result.error === undefined ? {} : { error: result.error }),
      })),
      terminate: async (force) => { await run.terminate(force); },
    };
  }
}
