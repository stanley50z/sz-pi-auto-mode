import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPathInside } from "./attestation.js";
import { parsePiExecutionProfile, type PiExecutionProfile } from "./capability-profile.js";
import type {
  TicketSessionHandle as CoordinatorTicketSessionHandle,
  TicketSessionHost as CoordinatorTicketSessionHost,
  TicketSessionRequest as CoordinatorTicketSessionRequest,
  TicketSessionObservedActivity,
} from "./coordinator.js";
import { nestedSessionEventMessage, type NestedSessionEvent } from "./nested-session.js";
import { resolveAutomodePaths } from "./paths.js";
import { AutomodeRestartRequiredError } from "./restart-required.js";
import type { AutomationStageConfiguration } from "./stage-configuration.js";
import { createCanonicalTicketSessionPrompt } from "./ticket-session-prompt.js";
import { createAssistantTranscript } from "./ticket-transcript.js";

export { createCanonicalTicketSessionPrompt } from "./ticket-session-prompt.js";

export const TICKET_SESSION_PROTOCOL_VERSION = 4 as const;

export interface TicketSessionLaunchRequest {
  cwd: string;
  skillName: string;
  itemUrl: string;
  configuration: AutomationStageConfiguration;
  mainExecution: PiExecutionProfile;
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
  summary?: string;
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

interface TicketSessionActivityEventBase {
  type: "activity";
  activity: string;
  timestamp: number;
}

export type TicketSessionActivityEvent =
  | (TicketSessionActivityEventBase & {
      kind: "assistant" | "thinking";
      toolCount?: number;
    })
  | (TicketSessionActivityEventBase & {
      kind: "tools";
      toolCount: number;
    })
  | (TicketSessionActivityEventBase & {
      kind: "tool";
      toolName: string;
      toolCallId: string;
      toolCount?: never;
    })
  | (TicketSessionActivityEventBase & {
      kind: "child";
      toolName: string;
      toolCallId: string;
      child: NestedSessionEvent;
      toolCount?: never;
    })
  | (TicketSessionActivityEventBase & {
      kind: "error";
      toolCount?: never;
    });

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
  summary?: string;
  error?: string;
}

interface ChildEventMessage {
  type: "ticket-session:event";
  version: typeof TICKET_SESSION_PROTOCOL_VERSION;
  event: TicketSessionLifecycleEvent | TicketSessionActivityEvent;
}

interface ChildTerminalMessage {
  type: "ticket-session:terminal";
  version: typeof TICKET_SESSION_PROTOCOL_VERSION;
  result: ChildTerminalResult;
}

export interface TicketSessionStartMessage {
  type: "ticket-session:start";
  version: typeof TICKET_SESSION_PROTOCOL_VERSION;
  request: TicketSessionChildRequest;
}

export interface TicketSessionTerminateMessage {
  type: "ticket-session:terminate";
  version: typeof TICKET_SESSION_PROTOCOL_VERSION;
}

function defaultChildEntrypoint(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "ticket-session-main.js");
}

function ticketSessionRuntimeFingerprint(entrypoint: string): string {
  const directory = dirname(entrypoint);
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => entry.name)
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(resolve(directory, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
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

function isNestedSessionEvent(value: unknown): value is NestedSessionEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<NestedSessionEvent> & Record<string, unknown>;
  if (
    typeof event.id !== "string"
    || (event.source !== "panel" && event.source !== "subagent")
    || typeof event.label !== "string"
    || [event.harness, event.provider, event.model, event.reasoning, event.headSha]
      .some((field) => field !== undefined && typeof field !== "string")
  ) return false;
  if (event.type === "started") return typeof event.initialPrompt === "string";
  if (event.type === "settled") {
    return (event.status === "completed" || event.status === "failed")
      && (event.message === undefined || typeof event.message === "string");
  }
  if (event.type !== "activity" || !event.activity || typeof event.activity !== "object") return false;
  const activity = event.activity as { kind?: unknown; message?: unknown; toolCount?: unknown };
  if (
    !["assistant", "thinking", "tools", "error"].includes(String(activity.kind))
    || typeof activity.message !== "string"
  ) return false;
  const validToolCount = typeof activity.toolCount === "number"
    && Number.isSafeInteger(activity.toolCount)
    && activity.toolCount > 0;
  if (activity.kind === "tools") return validToolCount;
  if (activity.kind === "error") return activity.toolCount === undefined;
  return activity.toolCount === undefined || validToolCount;
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
  if (
    candidate.event.type !== "activity"
    || typeof candidate.event.activity !== "string"
    || typeof candidate.event.timestamp !== "number"
    || !["assistant", "thinking", "tools", "tool", "child", "error"].includes(candidate.event.kind)
  ) return false;
  const toolCount = candidate.event.toolCount;
  const validToolCount = typeof toolCount === "number" && Number.isSafeInteger(toolCount) && toolCount > 0;
  if (candidate.event.kind === "tools") return validToolCount;
  if (candidate.event.kind === "tool") {
    return typeof candidate.event.toolName === "string"
      && typeof candidate.event.toolCallId === "string"
      && candidate.event.toolCount === undefined;
  }
  if (candidate.event.kind === "child") {
    return typeof candidate.event.toolName === "string"
      && typeof candidate.event.toolCallId === "string"
      && isNestedSessionEvent(candidate.event.child)
      && candidate.event.toolCount === undefined;
  }
  if (candidate.event.kind === "error") return candidate.event.toolCount === undefined;
  return candidate.event.toolCount === undefined || validToolCount;
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
  if (candidate.result.summary !== undefined && typeof candidate.result.summary !== "string") return false;
  if (candidate.result.status !== "error") {
    return typeof candidate.result.sessionId === "string"
      && typeof candidate.result.sessionFile === "string"
      && typeof candidate.result.summary === "string"
      && candidate.result.summary.length > 0;
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
  readonly #runtimeFingerprint: string | undefined;

  constructor(options: TicketSessionHostOptions = {}) {
    this.#entrypoint = resolve(options.childEntrypoint ?? defaultChildEntrypoint());
    this.#launcher = options.launcher ?? defaultLauncher;
    this.#env = { ...(options.env ?? process.env) };
    this.#runtimeFingerprint = options.launcher === undefined
      ? ticketSessionRuntimeFingerprint(this.#entrypoint)
      : undefined;
    this.#terminationGraceMs = options.terminationGraceMs ?? 5_000;
    if (!Number.isFinite(this.#terminationGraceMs) || this.#terminationGraceMs < 0) {
      throw new Error("Ticket Session termination grace period must be non-negative");
    }
  }

  launch(request: TicketSessionLaunchRequest): TicketSessionRun {
    if (
      this.#runtimeFingerprint !== undefined
      && ticketSessionRuntimeFingerprint(this.#entrypoint) !== this.#runtimeFingerprint
    ) {
      throw new AutomodeRestartRequiredError(
        "The Ticket Session runtime changed while this Coordinator was running; restart Automode before dispatching more work",
      );
    }
    const cwd = realpathSync(resolve(request.cwd));
    const childRequest: TicketSessionChildRequest = {
      cwd,
      skillName: request.skillName,
      itemUrl: request.itemUrl,
      prompt: createCanonicalTicketSessionPrompt(request.skillName, request.itemUrl),
      configuration: request.configuration,
      mainExecution: parsePiExecutionProfile(JSON.stringify(request.mainExecution)),
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
  return boundedTicketActivityText(content.flatMap((block): string[] => {
    if (!block || typeof block !== "object") return [];
    const candidate = block as { type?: unknown; text?: unknown };
    return candidate.type === "text" && typeof candidate.text === "string" ? [candidate.text] : [];
  }).join("\n"));
}

function readPersistedTicketSessionHistory(sessionFile: string): {
  readonly sessionId: string;
  readonly history: readonly TicketSessionObservedActivity[];
} {
  const session = SessionManager.open(sessionFile);
  let historyAttempt = 0;
  const history = session.buildContextEntries().flatMap((entry): TicketSessionObservedActivity[] => {
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      return [{
        attempt: Math.max(1, historyAttempt),
        occurredAt: entry.timestamp,
        kind: "thinking",
        message: boundedTicketActivityText(entry.summary),
      }];
    }
    if (entry.type !== "message") return [];
    const message = entry.message;
    if (message.role === "user") {
      const text = persistedContentText(message.content);
      if (/^\/skill:[^\s]+\s+https?:\/\//.test(text.trim())) historyAttempt += 1;
      return [];
    }
    if (message.role === "toolResult") {
      const result = message as unknown as {
        toolName?: unknown;
        toolCallId?: unknown;
        details?: { nestedSessions?: unknown };
      };
      if (
        result.toolName !== "automode_panel"
        || typeof result.toolCallId !== "string"
        || !Array.isArray(result.details?.nestedSessions)
      ) return [];
      return result.details.nestedSessions.flatMap((child): TicketSessionObservedActivity[] => {
        if (!isNestedSessionEvent(child)) return [];
        return [{
          attempt: Math.max(1, historyAttempt),
          occurredAt: entry.timestamp,
          kind: "child",
          message: boundedTicketActivityText(nestedSessionEventMessage(child)),
          toolName: "automode_panel",
          toolCallId: result.toolCallId as string,
          child,
        }];
      });
    }
    if (message.role !== "assistant") return [];
    const attempt = Math.max(1, historyAttempt);
    return createAssistantTranscript(message.content, {
      isError: message.stopReason === "error",
      maxMessageLength: MAX_TICKET_ACTIVITY_TEXT,
    }).map((activity) => ({ ...activity, attempt, occurredAt: entry.timestamp }));
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
  const base = {
    occurredAt: new Date(event.timestamp).toISOString(),
    message: boundedTicketActivityText(event.activity),
  };
  if (event.kind === "tools") return { ...base, kind: event.kind, toolCount: event.toolCount };
  if (event.kind === "tool") {
    return {
      ...base,
      kind: event.kind,
      toolName: event.toolName,
      toolCallId: event.toolCallId,
    };
  }
  if (event.kind === "child") {
    return {
      ...base,
      kind: event.kind,
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      child: event.child,
    };
  }
  if (event.kind === "assistant" || event.kind === "thinking") {
    return {
      ...base,
      kind: event.kind,
      ...(event.toolCount === undefined ? {} : { toolCount: event.toolCount }),
    };
  }
  return { ...base, kind: event.kind };
}

export interface AutomodeTicketSessionHostOptions {
  readonly repository: string;
  readonly configuration: AutomationStageConfiguration;
  readonly getMainExecution: () => PiExecutionProfile;
  readonly home?: string;
  readonly normalAgentDir?: string;
  readonly processHost?: TicketSessionHost;
}

/** Adapts the full-process host to the Coordinator's durable Ticket Session seam. */
export class AutomodeTicketSessionHost implements CoordinatorTicketSessionHost {
  readonly #repository: string;
  readonly #configuration: AutomationStageConfiguration;
  readonly #getMainExecution: () => PiExecutionProfile;
  readonly #home: string | undefined;
  readonly #normalAgentDir: string | undefined;
  readonly #processHost: TicketSessionHost;
  readonly #startingRuns = new Map<string, TicketSessionRun>();

  constructor(options: AutomodeTicketSessionHostOptions) {
    this.#repository = realpathSync(resolve(options.repository));
    this.#configuration = options.configuration;
    this.#getMainExecution = options.getMainExecution;
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
      mainExecution: this.#getMainExecution(),
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
      if (result.status === "error") {
        return { status: "error" as const, ...(result.error === undefined ? {} : { error: result.error }) };
      }
      if (!result.summary) {
        return { status: "error" as const, error: "Ticket Session completed without a structured summary" };
      }
      return { status: result.status, summary: result.summary };
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
