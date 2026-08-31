import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSessionFromServices,
  SessionManager,
  type AgentSessionEvent,
  type CustomEntry,
} from "@earendil-works/pi-coding-agent";
import { attestCanonicalCommands, isPathInside } from "./attestation.js";
import { createAutomodeCapabilityProfile } from "./capability-profile.js";
import { createControlledServices } from "./controlled-services.js";
import { resolvePiExecutionModel } from "./model-execution.js";
import { nestedSessionEventMessage, type NestedSessionEvent } from "./nested-session.js";
import { CliPanelProcessLauncher } from "./panel-process.js";
import { createProductionPanelSeatLauncher } from "./panel-runtime.js";
import { repositoryRoot, resolveAutomodePaths } from "./paths.js";
import { createTicketPanelExtension } from "./ticket-panel-extension.js";
import { createTicketSessionResultExtension } from "./ticket-session-result.js";
import {
  createCanonicalTicketSessionPrompt,
  TICKET_SESSION_PROTOCOL_VERSION,
  type TicketSessionActivityEvent,
  type TicketSessionChildRequest,
  type TicketSessionLifecycleEvent,
  type TicketSessionStartMessage,
  type TicketSessionTerminateMessage,
  type TicketSessionTerminalStatus,
} from "./ticket-session.js";
import { createAutomationStageConfiguration } from "./stage-configuration.js";
import { createAssistantTranscript } from "./ticket-transcript.js";

export type TicketSessionChildActivity =
  | { activity: string; kind: "assistant" | "thinking"; toolCount?: number }
  | { activity: string; kind: "tools"; toolCount: number }
  | { activity: string; kind: "tool"; toolName: string; toolCallId: string; toolCount?: never }
  | {
      activity: string;
      kind: "child";
      toolName: string;
      toolCallId: string;
      child: NestedSessionEvent;
      toolCount?: never;
    }
  | { activity: string; kind: "error"; toolCount?: never };

export interface TicketSessionChildPromptResult {
  readonly status: Exclude<TicketSessionTerminalStatus, "error">;
  readonly summary: string;
}

export interface TicketSessionChildSession {
  readonly sessionId: string;
  readonly sessionFile: string;
  subscribe(listener: (activity: TicketSessionChildActivity) => void): () => void;
  prompt(prompt: string): Promise<TicketSessionChildPromptResult>;
  abort(): Promise<void>;
  dispose(): void;
}

export type TicketSessionChildSessionFactory = (
  request: TicketSessionChildRequest,
) => Promise<TicketSessionChildSession>;

export interface TicketSessionChildTerminalResult {
  status: TicketSessionTerminalStatus;
  sessionId?: string;
  sessionFile?: string;
  summary?: string;
  error?: string;
}

export type TicketSessionChildEvent = TicketSessionLifecycleEvent | TicketSessionActivityEvent;

export interface TicketSessionChildRuntime {
  cwd?: string;
  signal?: AbortSignal;
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ? `${error.message}\n${error.stack}` : error.message;
  }
  return String(error);
}

async function promptUntilSettled(
  session: TicketSessionChildSession,
  prompt: string,
  signal: AbortSignal | undefined,
): Promise<TicketSessionChildPromptResult> {
  if (!signal) return session.prompt(prompt);
  if (signal.aborted) {
    try {
      await session.abort();
    } catch (error) {
      throw new Error("Ticket Session termination failed", { cause: error });
    }
    throw new Error("Ticket Session was terminated before prompting");
  }
  let rejectTermination!: (error: Error) => void;
  const terminated = new Promise<never>((_resolve, reject) => {
    rejectTermination = reject;
  });
  const abort = (): void => {
    void session.abort().then(
      () => rejectTermination(new Error("Ticket Session was terminated")),
      (error) => rejectTermination(new Error("Ticket Session termination failed", { cause: error })),
    );
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) abort();
    return await Promise.race([session.prompt(prompt), terminated]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function runTicketSessionChild(
  request: TicketSessionChildRequest,
  createSession: TicketSessionChildSessionFactory,
  emit: (event: TicketSessionChildEvent) => void,
  runtime: TicketSessionChildRuntime = {},
): Promise<TicketSessionChildTerminalResult> {
  const actualCwd = runtime.cwd ?? process.cwd();
  const signal = runtime.signal;
  emit({ type: "lifecycle", state: "starting", timestamp: Date.now() });
  let session: TicketSessionChildSession | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    const expectedPrompt = createCanonicalTicketSessionPrompt(request.skillName, request.itemUrl);
    if (request.prompt !== expectedPrompt) {
      throw new Error("Ticket Session request contains a non-canonical skill prompt");
    }
    if (realpathSync(resolve(request.cwd)) !== realpathSync(resolve(actualCwd))) {
      throw new Error(`Ticket Session child cwd mismatch: expected ${request.cwd}, received ${actualCwd}`);
    }
    if (signal?.aborted) throw new Error("Ticket Session was terminated before startup");
    session = await createSession(request);
    if (!session.sessionId) throw new Error("Controlled Ticket Session did not provide a persistent session ID");
    if (!session.sessionFile) throw new Error("Controlled Ticket Session did not provide a persistent session file");
    unsubscribe = session.subscribe((activity) => {
      emit({ type: "activity", timestamp: Date.now(), ...activity });
    });
    emit({
      type: "lifecycle",
      state: "ready",
      timestamp: Date.now(),
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
    });
    emit({
      type: "lifecycle",
      state: "running",
      timestamp: Date.now(),
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
    });

    const outcome = await promptUntilSettled(session, request.prompt, signal);
    if (
      !outcome
      || typeof outcome !== "object"
      || (outcome.status !== "clean" && outcome.status !== "waiting")
      || typeof outcome.summary !== "string"
      || outcome.summary.length === 0
    ) {
      throw new Error("Controlled Ticket Session returned an invalid terminal result");
    }
    return {
      status: outcome.status,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      summary: outcome.summary,
    };
  } catch (error) {
    return {
      status: "error",
      ...(session ? { sessionId: session.sessionId, sessionFile: session.sessionFile } : {}),
      error: errorText(error),
    };
  } finally {
    unsubscribe?.();
    session?.dispose();
  }
}

/** Converts native retry and completed assistant events into ultra-collapsed transcript rows. */
export function ticketSessionActivityFromAgentEvent(
  event: AgentSessionEvent,
): readonly TicketSessionChildActivity[] {
  if (event.type === "auto_retry_start") {
    return [{
      activity: `Retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`,
      kind: "error",
    }];
  }
  if (event.type !== "message_end") return [];
  const message = event.message;
  if (message.role !== "assistant") return [];
  return createAssistantTranscript(message.content, {
    isError: message.stopReason === "error",
  }).map(({ message: activity, ...transcript }) => ({ activity, ...transcript }));
}

/**
 * Production adapter: assembles a Ticket Session only from the existing
 * fail-closed Automode capability profile and controlled SDK services.
 */
export const createControlledTicketSession: TicketSessionChildSessionFactory = async (request) => {
  const cwd = realpathSync(resolve(request.cwd));
  repositoryRoot(cwd);
  createAutomationStageConfiguration(request.configuration.mode, request.configuration.stages);
  const profile = createAutomodeCapabilityProfile();
  const requestedSkill = profile.skills.find((skill) => skill.name === request.skillName);
  if (!requestedSkill || requestedSkill.kind !== "stage" || requestedSkill.owner !== "automode") {
    throw new Error(`Skill is not an Automode Stage Skill: ${request.skillName}`);
  }
  const paths = resolveAutomodePaths(cwd, request.home, request.normalAgentDir);
  mkdirSync(paths.automodeDir, { recursive: true });
  mkdirSync(paths.sessionDir, { recursive: true });
  const resultReporter = createTicketSessionResultExtension();
  const nestedActivityListeners = new Set<(activity: TicketSessionChildActivity) => void>();
  const extensions = [resultReporter.extension];
  const tools = [...profile.tools, "automode_ticket_result"];
  if (request.skillName === "grilling" || request.skillName === "code-review") {
    const piPackageDir = process.env.AUTOMODE_PI_PACKAGE_DIR;
    if (!piPackageDir) throw new Error("Ticket Session is missing the launching Pi package directory");
    const panelLauncher = createProductionPanelSeatLauncher(new CliPanelProcessLauncher({
      cwd,
      normalAgentDir: paths.normalAgentDir,
      piPackageDir,
    }));
    extensions.push(createTicketPanelExtension(panelLauncher, profile.panelExecutions, ({
      toolName,
      toolCallId,
      child,
    }) => {
      for (const listener of nestedActivityListeners) listener({
        kind: "child",
        activity: nestedSessionEventMessage(child),
        toolName,
        toolCallId,
        child,
      });
    }));
    tools.push("automode_panel");
  }
  const services = await createControlledServices({
    cwd,
    paths,
    skillPaths: profile.skills.map((skill) => skill.sourceRoot),
    extensions,
    systemPrompt: "You are an authoritative Automode Ticket Session. Perform only the one canonically dispatched item workflow in this persistent session. You must finish by calling automode_ticket_result exactly once; never merely describe completion in prose.",
  });
  const expectedExecution = profile.ordinaryTicketExecution;
  const model = await resolvePiExecutionModel(services, expectedExecution);

  const assignment = {
    itemUrl: request.itemUrl,
    skillName: request.skillName,
  };
  let sessionManager: SessionManager;
  let resumedFile: string | undefined;
  if (request.resumeSessionFile) {
    resumedFile = realpathSync(resolve(request.resumeSessionFile));
    if (!isPathInside(resumedFile, realpathSync(paths.sessionDir))) {
      throw new Error("Ticket Session resume file is outside controlled Automode session storage");
    }
    sessionManager = SessionManager.open(resumedFile, paths.sessionDir);
    if (realpathSync(sessionManager.getCwd()) !== cwd) {
      throw new Error("Ticket Session resume file belongs to a different working directory");
    }
    const assignments = sessionManager.getEntries().filter((entry): entry is CustomEntry =>
      entry.type === "custom" && entry.customType === "automode.ticket-assignment"
    );
    if (assignments.length !== 1 || JSON.stringify(assignments[0]!.data) !== JSON.stringify(assignment)) {
      throw new Error("Ticket Session resume file belongs to a different tracker item or Automation Stage Skill");
    }
  } else {
    sessionManager = SessionManager.create(cwd, paths.sessionDir);
    sessionManager.appendCustomEntry("automode.ticket-assignment", assignment);
  }

  const result = await createAgentSessionFromServices({
    services,
    sessionManager,
    model,
    thinkingLevel: expectedExecution.reasoning,
    scopedModels: [{ model, thinkingLevel: expectedExecution.reasoning }],
    tools,
  });
  try {
    const commands = result.extensionsResult.runtime.getCommands();
    attestCanonicalCommands(
      commands,
      profile.skills.map((skill) => ({
        command: `skill:${skill.name}`,
        sourceRoot: skill.sourceRoot,
      })),
      services.resourceLoader.getSkills().diagnostics,
    );
    const allowedSkillFiles = new Set(
      profile.skills.map((skill) => realpathSync(join(skill.sourceRoot, "SKILL.md"))),
    );
    for (const command of commands) {
      if (
        command.source === "skill"
        && allowedSkillFiles.has(realpathSync(command.sourceInfo.path))
      ) continue;
      if (
        command.source === "extension"
        && profile.extensionCommands.includes(command.name)
        && command.sourceInfo.path === "<inline:automode-openai-fast-mode>"
      ) continue;
      throw new Error(`Unexpected command in controlled Ticket Session: ${command.name}`);
    }
    if (commands.length !== allowedSkillFiles.size + profile.extensionCommands.length) {
      throw new Error("Controlled Ticket Session did not expose exactly one command per allowlisted resource");
    }
    result.session.setSessionName(
      request.sessionName ?? `Automode Ticket — ${request.skillName} — ${request.itemUrl}`,
    );
    const sessionFile = result.session.sessionFile;
    if (!sessionFile) throw new Error("Controlled Ticket Session did not create a persistent session file");
    if (resumedFile && realpathSync(sessionFile) !== resumedFile) {
      throw new Error("Controlled Ticket Session did not resume the exact requested session file");
    }
    return {
      sessionId: result.session.sessionId,
      sessionFile,
      subscribe(listener) {
        nestedActivityListeners.add(listener);
        const unsubscribeSession = result.session.subscribe((event) => {
          for (const activity of ticketSessionActivityFromAgentEvent(event)) listener(activity);
        });
        return () => {
          nestedActivityListeners.delete(listener);
          unsubscribeSession();
        };
      },
      async prompt(prompt) {
        await result.session.prompt(prompt);
        const error = result.session.state.errorMessage;
        if (error) throw new Error(`Ticket Session agent failed: ${error}`);
        const reported = resultReporter.read();
        if (!reported) throw new Error("Ticket Session settled without reporting a structured result");
        return {
          status: reported.status === "waiting" ? "waiting" : "clean",
          summary: reported.summary,
        };
      },
      abort: () => result.session.abort(),
      dispose: () => result.session.dispose(),
    };
  } catch (error) {
    result.session.dispose();
    throw error;
  }
};

function isStartMessage(message: unknown): message is TicketSessionStartMessage {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Partial<TicketSessionStartMessage>;
  return candidate.type === "ticket-session:start"
    && candidate.version === TICKET_SESSION_PROTOCOL_VERSION
    && !!candidate.request
    && typeof candidate.request === "object";
}

function isTerminateMessage(message: unknown): message is TicketSessionTerminateMessage {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Partial<TicketSessionTerminateMessage>;
  return candidate.type === "ticket-session:terminate"
    && candidate.version === TICKET_SESSION_PROTOCOL_VERSION;
}

function sendToParent(message: unknown): Promise<void> {
  if (!process.send || !process.connected) {
    return Promise.reject(new Error("Ticket Session child has no connected parent IPC channel"));
  }
  return new Promise((resolveSend, rejectSend) => {
    process.send!(message, (error: Error | null) => {
      if (error) rejectSend(error);
      else resolveSend();
    });
  });
}

async function receiveStart(controller: AbortController): Promise<TicketSessionChildRequest> {
  return new Promise((resolveRequest, rejectRequest) => {
    const onAbort = () => rejectRequest(new Error("Ticket Session was terminated before receiving work"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const onMessage = (message: unknown): void => {
      if (isTerminateMessage(message)) {
        controller.abort();
        return;
      }
      if (!isStartMessage(message)) {
        process.off("message", onMessage);
        controller.signal.removeEventListener("abort", onAbort);
        rejectRequest(new Error("Ticket Session child received an invalid start message"));
        return;
      }
      process.off("message", onMessage);
      controller.signal.removeEventListener("abort", onAbort);
      resolveRequest(message.request);
    };
    process.on("message", onMessage);
  });
}

async function main(): Promise<void> {
  if (!process.send) throw new Error("Ticket Session child requires a parent IPC channel");
  const controller = new AbortController();
  const terminate = (): void => controller.abort();
  process.on("SIGINT", terminate);
  process.on("SIGTERM", terminate);
  process.on("SIGHUP", terminate);
  process.on("disconnect", terminate);
  const onControl = (message: unknown): void => {
    if (isTerminateMessage(message)) controller.abort();
  };
  process.on("message", onControl);
  try {
    const request = await receiveStart(controller);
    let sends = Promise.resolve();
    const result = await runTicketSessionChild(
      request,
      createControlledTicketSession,
      (event) => {
        sends = sends.then(() => sendToParent({
          type: "ticket-session:event",
          version: TICKET_SESSION_PROTOCOL_VERSION,
          event,
        }));
      },
      { signal: controller.signal },
    );
    await sends;
    await sendToParent({
      type: "ticket-session:terminal",
      version: TICKET_SESSION_PROTOCOL_VERSION,
      result,
    });
    process.exitCode = result.status === "error" ? 1 : 0;
  } finally {
    process.off("SIGINT", terminate);
    process.off("SIGTERM", terminate);
    process.off("SIGHUP", terminate);
    process.off("disconnect", terminate);
    process.off("message", onControl);
    if (process.connected) process.disconnect();
  }
}

const isEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isEntrypoint) {
  await main();
}
