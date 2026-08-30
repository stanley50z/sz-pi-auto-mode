import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, realpathSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPathInside } from "./attestation.js";
import type {
  TicketSessionHandle as CoordinatorTicketSessionHandle,
  TicketSessionHost as CoordinatorTicketSessionHost,
  TicketSessionRequest as CoordinatorTicketSessionRequest,
  TicketSessionObservedActivity,
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

const defaultLauncher: TicketSessionProcessLauncher = ({ entrypoint, cwd, env }) => {
  const runtimeLoader = env.AUTOMODE_PI_RUNTIME_LOADER;
  if (!runtimeLoader) throw new Error("Ticket Session is missing the launching Pi runtime loader");
  return spawn(process.execPath, ["--import", runtimeLoader, entrypoint], {
    cwd,
    env,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    windowsHide: true,
  }) as TicketSessionProcess;
};

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

function readSessionHeaderId(sessionFile: string): string {
  const descriptor = openSync(sessionFile, "r");
  try {
    const buffer = Buffer.alloc(65_536);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, length).toString("utf8").split(/\r?\n/, 1)[0];
    if (!firstLine) throw new Error("Ticket Session history header is missing");
    const header: unknown = JSON.parse(firstLine);
    if (!header || typeof header !== "object" || (header as { type?: unknown }).type !== "session" || typeof (header as { id?: unknown }).id !== "string") {
      throw new Error("Ticket Session history header is invalid");
    }
    return (header as { id: string }).id;
  } finally {
    closeSync(descriptor);
  }
}

const MAX_TICKET_ACTIVITY_TEXT = 2_000;
const MAX_PERSISTED_HISTORY_EVENTS = 500;

function boundedTicketActivityText(value: string): string {
  return value.length > MAX_TICKET_ACTIVITY_TEXT
    ? `${value.slice(0, MAX_TICKET_ACTIVITY_TEXT)}… [truncated]`
    : value;
}

function persistedContentText(content: unknown): string {
  if (typeof content === "string") return boundedTicketActivityText(content);
  if (!Array.isArray(content)) return "";
  const combined = content.flatMap((block): string[] => {
    if (!block || typeof block !== "object") return [];
    const candidate = block as { type?: unknown; text?: unknown; name?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") return [candidate.text];
    if (candidate.type === "toolCall" && typeof candidate.name === "string") return [`Requested tool: ${candidate.name}`];
    return [];
  }).join("\n");
  return boundedTicketActivityText(combined);
}

function readPersistedTicketSessionHistory(sessionFile: string): {
  readonly sessionId: string;
  readonly history: readonly TicketSessionObservedActivity[];
} {
  const session = SessionManager.open(sessionFile);
  let historyAttempt = 0;
  const history = session.buildContextEntries().flatMap((entry): TicketSessionObservedActivity[] => {
    if (entry.type === "compaction") {
      return [{ attempt: Math.max(1, historyAttempt), occurredAt: entry.timestamp, kind: "pi", message: `Compaction summary: ${boundedTicketActivityText(entry.summary)}` }];
    }
    if (entry.type === "branch_summary") {
      return [{ attempt: Math.max(1, historyAttempt), occurredAt: entry.timestamp, kind: "pi", message: `Branch summary: ${boundedTicketActivityText(entry.summary)}` }];
    }
    if (entry.type === "custom_message" && entry.display) {
      const message = persistedContentText(entry.content);
      return message ? [{ attempt: Math.max(1, historyAttempt), occurredAt: entry.timestamp, kind: "pi", message: `Session context: ${message}` }] : [];
    }
    if (entry.type !== "message") return [];
    const message = entry.message;
    if (message.role === "user") {
      const text = persistedContentText(message.content);
      if (/^\/skill:[^\s]+\s+https?:\/\//.test(text.trim())) historyAttempt += 1;
      return text ? [{ attempt: Math.max(1, historyAttempt), occurredAt: entry.timestamp, kind: "pi", message: `User: ${text}` }] : [];
    }
    if (message.role === "assistant") {
      const text = persistedContentText(message.content);
      if (!text) return [];
      return [{
        attempt: Math.max(1, historyAttempt),
        occurredAt: entry.timestamp,
        kind: message.stopReason === "error" ? "error" : "pi",
        message: `Assistant: ${text}`,
      }];
    }
    if (message.role === "toolResult") {
      const text = persistedContentText(message.content);
      return [{
        attempt: Math.max(1, historyAttempt),
        occurredAt: entry.timestamp,
        kind: message.isError ? "error" : "tool",
        message: text || `${message.toolName} completed without text output.`,
        toolName: message.toolName,
      }];
    }
    if (message.role === "bashExecution") {
      return [{
        attempt: Math.max(1, historyAttempt),
        occurredAt: entry.timestamp,
        kind: message.exitCode && message.exitCode !== 0 ? "error" : "tool",
        message: boundedTicketActivityText(message.output || message.command),
        toolName: "bash",
      }];
    }
    return [];
  });
  if (history.length <= MAX_PERSISTED_HISTORY_EVENTS) {
    return { sessionId: session.getSessionId(), history };
  }
  const retained = history.slice(-(MAX_PERSISTED_HISTORY_EVENTS - 1));
  return {
    sessionId: session.getSessionId(),
    history: [{
      attempt: retained[0]?.attempt ?? 1,
      occurredAt: retained[0]?.occurredAt ?? new Date(0).toISOString(),
      kind: "coordinator",
      message: "Earlier persisted Pi history was truncated to keep the Activity View responsive.",
    }, ...retained],
  };
}

function resolveControlledSessionDir(controlledSessionDir: string): string {
  return existsSync(controlledSessionDir) ? realpathSync(controlledSessionDir) : resolve(controlledSessionDir);
}

function validateReservedTicketSessionPath(reportedSessionFile: string, controlledSessionDir: string): string {
  const sessionFile = resolve(reportedSessionFile);
  const resolvedSessionDir = resolveControlledSessionDir(controlledSessionDir);
  const resolvedParent = realpathSync(dirname(sessionFile));
  if (!isPathInside(resolvedParent, resolvedSessionDir)) {
    throw new Error("Ticket Session reported history outside the controlled session directory");
  }
  return sessionFile;
}

function validatePersistedTicketSessionHistory(
  reportedSessionFile: string,
  controlledSessionDir: string,
  readySessionId: string,
  expectedSessionId?: string,
): {
  readonly sessionFile: string;
  readonly persisted: ReturnType<typeof readPersistedTicketSessionHistory>;
} {
  const sessionFile = realpathSync(reportedSessionFile);
  const resolvedSessionDir = resolveControlledSessionDir(controlledSessionDir);
  if (!isPathInside(sessionFile, resolvedSessionDir)) {
    throw new Error("Ticket Session reported history outside the controlled session directory");
  }
  const persisted = readPersistedTicketSessionHistory(sessionFile);
  if (persisted.sessionId !== readySessionId || (expectedSessionId !== undefined && readySessionId !== expectedSessionId)) {
    throw new Error("Ticket Session history identity does not match the ready event");
  }
  return { sessionFile, persisted };
}

function persistedHistoryValidationError(cause: unknown): Error {
  return new Error(`Ticket Session persisted history could not be validated: ${errorText(cause)}`, { cause });
}

function observedActivity(event: TicketSessionEvent): TicketSessionObservedActivity | undefined {
  if (event.type !== "activity") return undefined;
  return {
    occurredAt: new Date(event.timestamp).toISOString(),
    kind: event.isError ? "error" : event.toolName ? "tool" : "pi",
    message: boundedTicketActivityText(event.activity),
    ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
  };
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
  readonly #startingRuns = new Map<string, TicketSessionRun>();

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
    const candidateResumeFile = request.resumeSessionFile && existsSync(request.resumeSessionFile)
      ? realpathSync(request.resumeSessionFile)
      : undefined;
    const resumableSessionFile = candidateResumeFile
      && request.resumeSessionId
      && isPathInside(candidateResumeFile, controlledSessionDir)
      && readSessionHeaderId(candidateResumeFile) === request.resumeSessionId
      ? candidateResumeFile
      : undefined;
    const expectedSessionId = resumableSessionFile === undefined ? undefined : request.resumeSessionId;
    const run = this.#processHost.launch({
      cwd,
      skillName: request.skillName,
      itemUrl: request.item.url,
      configuration: this.#configuration,
      sessionName: `Automode ${request.stage} #${request.item.number}`,
      resumeSessionFile: resumableSessionFile,
      home: this.#home,
      normalAgentDir: this.#normalAgentDir,
    });
    const key = `${request.item.kind}:${request.item.number}`;
    this.#startingRuns.set(key, run);
    const listeners = new Set<(activity: TicketSessionObservedActivity) => void>();
    const buffered: TicketSessionObservedActivity[] = [];
    const stopObserving = run.subscribe((event) => {
      const activity = observedActivity(event);
      if (!activity) return;
      if (listeners.size === 0) buffered.push(activity);
      else for (const listener of listeners) listener(activity);
    });
    let ready;
    try {
      ready = await run.ready;
    } catch (error) {
      this.#startingRuns.delete(key);
      throw error;
    }
    let persisted: ReturnType<typeof readPersistedTicketSessionHistory>;
    let sessionFile: string;
    let validateHistoryAtCompletion = false;
    try {
      if (existsSync(ready.sessionFile)) {
        const validated = validatePersistedTicketSessionHistory(
          ready.sessionFile,
          controlledSessionDir,
          ready.sessionId,
          expectedSessionId,
        );
        sessionFile = validated.sessionFile;
        persisted = validated.persisted;
      } else {
        if (expectedSessionId !== undefined) {
          throw new Error("Ticket Session resume history disappeared during startup");
        }
        sessionFile = validateReservedTicketSessionPath(ready.sessionFile, controlledSessionDir);
        persisted = { sessionId: ready.sessionId, history: [] };
        validateHistoryAtCompletion = true;
      }
    } catch (error) {
      this.#startingRuns.delete(key);
      void run.terminate(true).catch(() => undefined);
      throw persistedHistoryValidationError(error);
    }
    const completion = run.completion.then((result) => {
      if (validateHistoryAtCompletion) {
        try {
          validatePersistedTicketSessionHistory(sessionFile, controlledSessionDir, ready.sessionId);
        } catch (error) {
          const validationError = persistedHistoryValidationError(error).message;
          return {
            status: "error" as const,
            error: result.error === undefined ? validationError : `${result.error}; ${validationError}`,
          };
        }
      }
      return {
        status: result.status,
        ...(result.error === undefined ? {} : { error: result.error }),
      };
    }).finally(stopObserving);
    this.#startingRuns.delete(key);
    return {
      processId: run.processId === undefined ? "unknown" : String(run.processId),
      sessionId: ready.sessionId,
      sessionFile,
      history: persisted.history,
      completion,
      subscribe(listener) {
        listeners.add(listener);
        for (const activity of buffered.splice(0)) listener(activity);
        return () => listeners.delete(listener);
      },
      terminate: async (force) => { await run.terminate(force); },
    };
  }

  async terminateStarting(itemKey: string, force: boolean): Promise<void> {
    const run = this.#startingRuns.get(itemKey);
    if (!run) return;
    await run.terminate(force);
  }
}
