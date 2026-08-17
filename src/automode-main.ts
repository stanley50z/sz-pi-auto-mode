import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import { InteractiveMode, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { createCapabilitySession, type ProjectResourceAllowlist } from "./capability-session.js";
import { parsePiExecutionProfile, type PiExecutionProfile } from "./capability-profile.js";
import { AutomodeCoordinator, type CoordinatorClock } from "./coordinator.js";
import { acquireRepositoryCoordinator } from "./coordinator-lock.js";
import { GitHubTracker } from "./github-tracker.js";
import { resolveAutomodePaths } from "./paths.js";
import { createMainSessionRuntime } from "./session.js";
import { AutomodeTicketSessionHost } from "./ticket-session.js";
import { WorkspaceManager } from "./workspace.js";
import {
  validateAutomodeStartup,
  type ExecutionProfileAttestor,
  type StartupCommandRunner,
} from "./startup.js";
import {
  AUTOMODE_MODE_LABELS,
  parseConfirmedAutomationStageConfiguration,
  restoreAutomationStageOperatingState,
  type AutomationStageConfiguration,
  type AutomationStageOperatingState,
} from "./stage-configuration.js";

export interface StartAutomodeMainOptions {
  repository: string;
  serializedConfiguration: string;
  configurationConfirmation: string;
  defaultReviewerExecution: PiExecutionProfile;
  home?: string;
  normalAgentDir?: string;
  model?: Model<any>;
  projectResources?: ProjectResourceAllowlist;
  startupValidation?: {
    runner?: StartupCommandRunner;
    attestExecutions?: ExecutionProfileAttestor;
  };
  coordinator?: AutomodeCoordinator;
  coordinatorClock?: CoordinatorClock;
}

export interface StartedAutomodeMainSession {
  cwd: string;
  configuration: AutomationStageConfiguration;
  operatingState: AutomationStageOperatingState;
  sessionName: string;
  sessionFile: string | undefined;
  runRecordFile: string;
  coordinatorId: string;
  coordinatorIdentityFile: string;
  coordinatorLockFile: string;
  startCoordinator(): Promise<void>;
  interruptCoordinator(): "draining" | "forcing";
  runInteractive(): Promise<void>;
  dispose(): void;
}

export const automodeRunConfigurationGuard = {
  name: "automode-immutable-configuration",
  factory: (pi) => {
    pi.on("session_before_switch", () => ({ cancel: true }));
    pi.on("session_before_fork", () => ({ cancel: true }));
  },
} satisfies InlineExtension;

function persistAutomodeRunRecord(
  runRecordFile: string,
  coordinatorId: string,
  configuration: AutomationStageConfiguration,
  defaultReviewerExecution: PiExecutionProfile,
  projectResources: ProjectResourceAllowlist | undefined,
): string {
  const serialized = JSON.stringify({
    version: 1,
    coordinatorId,
    stageConfiguration: configuration,
    defaultReviewerExecution,
    projectResources: {
      trusted: projectResources?.trusted ?? false,
      skillFiles: [...(projectResources?.skillPaths ?? [])]
        .map((path) => realpathSync(join(resolve(path), "SKILL.md")))
        .sort(),
    },
  });
  try {
    writeFileSync(runRecordFile, `${serialized}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let persisted: string;
    try {
      persisted = JSON.stringify(JSON.parse(readFileSync(runRecordFile, "utf8")));
    } catch (parseError) {
      throw new Error("The durable Automode Run Record is invalid", { cause: parseError });
    }
    if (persisted !== serialized) {
      throw new Error("The Automode Run Record is fixed for this Automode Run");
    }
  }
  return runRecordFile;
}

export async function startAutomodeMainSession(
  options: StartAutomodeMainOptions,
): Promise<StartedAutomodeMainSession> {
  const configuration = parseConfirmedAutomationStageConfiguration(
    options.serializedConfiguration,
    options.configurationConfirmation,
  );
  const operatingState = restoreAutomationStageOperatingState(configuration);
  const validated = await validateAutomodeStartup({
    repository: options.repository,
    defaultReviewerExecution: options.defaultReviewerExecution,
    home: options.home,
    normalAgentDir: options.normalAgentDir,
    runner: options.startupValidation?.runner,
    attestExecutions: options.startupValidation?.attestExecutions,
  });
  const paths = resolveAutomodePaths(
    validated.repository,
    options.home,
    options.normalAgentDir,
  );
  const lease = acquireRepositoryCoordinator(paths.coordinatorDir);
  let runtime;
  let runRecordFile!: string;
  try {
    const attestationSession = await createCapabilitySession({
      cwd: validated.repository,
      defaultReviewerExecution: options.defaultReviewerExecution,
      model: options.model,
      home: options.home,
      normalAgentDir: options.normalAgentDir,
      projectResources: options.projectResources,
      sessionName: `Automode Capability Attestation — ${lease.coordinatorId}`,
    });
    attestationSession.session.dispose();

    runtime = await createMainSessionRuntime({
      cwd: validated.repository,
      skillPaths: [],
      systemPrompt: "You are the Automode Main Session. Host the repository Coordinator and never perform Ticket Session work.",
      model: options.model,
      home: options.home,
      normalAgentDir: options.normalAgentDir,
      extensions: [automodeRunConfigurationGuard],
    });
    runRecordFile = persistAutomodeRunRecord(
      paths.runRecordFile,
      lease.coordinatorId,
      configuration,
      options.defaultReviewerExecution,
      options.projectResources,
    );
  } catch (error) {
    runtime?.session.dispose();
    lease.release();
    throw error;
  }

  const coordinator = options.coordinator ?? new AutomodeCoordinator({
    configuration,
    actor: validated.actor,
    coordinatorId: lease.coordinatorId,
    tracker: new GitHubTracker({
      cwd: validated.repository,
      repository: validated.repositorySlug,
      actor: validated.actor,
    }),
    sessions: new AutomodeTicketSessionHost({
      repository: validated.repository,
      configuration,
      defaultReviewerExecution: options.defaultReviewerExecution,
      home: options.home,
      normalAgentDir: options.normalAgentDir,
    }),
    workspaces: new WorkspaceManager({
      repositoryRoot: validated.repository,
      repositorySlug: validated.repositorySlug,
    }),
    clock: options.coordinatorClock,
  });

  const sessionName = `Automode Main — ${AUTOMODE_MODE_LABELS[configuration.mode]}`;
  runtime.session.setSessionName(sessionName);
  runtime.session.sessionManager.appendCustomEntry("automode.stage-configuration", configuration);
  runtime.session.sessionManager.appendCustomEntry("automode.coordinator", {
    coordinatorId: lease.coordinatorId,
  });
  let disposed = false;
  let disposeRequested = false;
  let coordinatorStarted = false;
  let coordinatorStopped = false;
  let coordinatorInterrupts = 0;
  const startCoordinator = async () => {
    if (coordinatorStarted) return;
    coordinatorStarted = true;
    await coordinator.start();
  };
  const interruptCoordinator = () => {
    if (!coordinatorStarted) throw new Error("Automode Coordinator has not started");
    coordinatorInterrupts += 1;
    return coordinator.interrupt();
  };
  const finalizeDispose = () => {
    if (disposed) return;
    try {
      runtime.session.dispose();
    } finally {
      lease.release();
      disposed = true;
    }
  };
  const dispose = () => {
    if (disposed || disposeRequested) return;
    disposeRequested = true;
    if (!coordinatorStarted || coordinatorStopped) {
      finalizeDispose();
      return;
    }
    while (coordinatorInterrupts < 2) interruptCoordinator();
    void coordinator.whenStopped().then(() => {
      coordinatorStopped = true;
      finalizeDispose();
    });
  };
  return {
    cwd: runtime.cwd,
    configuration,
    operatingState,
    sessionName,
    sessionFile: runtime.session.sessionFile,
    runRecordFile,
    coordinatorId: lease.coordinatorId,
    coordinatorIdentityFile: lease.identityFile,
    coordinatorLockFile: lease.lockFile,
    startCoordinator,
    interruptCoordinator,
    runInteractive: async () => {
      const interactiveMode = new InteractiveMode(runtime, {
        initialMessages: [],
        verbose: false,
      });
      const onInterrupt = () => { interruptCoordinator(); };
      process.on("SIGINT", onInterrupt);
      try {
        await startCoordinator();
        await interactiveMode.run();
        if (coordinatorInterrupts === 0) interruptCoordinator();
        await coordinator.whenStopped();
        coordinatorStopped = true;
      } finally {
        process.off("SIGINT", onInterrupt);
        dispose();
      }
    },
    dispose,
  };
}

async function main(): Promise<void> {
  const repository = process.argv[2];
  if (!repository) throw new Error("Missing caller repository path");
  const serializedConfiguration = process.env.AUTOMODE_STAGE_CONFIGURATION;
  if (!serializedConfiguration) throw new Error("Missing launch-baseline Automation Stage Configuration");
  const configurationConfirmation = process.env.AUTOMODE_STAGE_CONFIGURATION_CONFIRMATION;
  if (!configurationConfirmation) throw new Error("Missing Automation Stage Configuration confirmation");
  const serializedDefaultReviewer = process.env.AUTOMODE_DEFAULT_REVIEWER_EXECUTION;
  if (!serializedDefaultReviewer) throw new Error("Missing default Reviewer execution profile");
  const defaultReviewerExecution = parsePiExecutionProfile(serializedDefaultReviewer);
  const normalAgentDir = process.argv[3] || undefined;
  const mainSession = await startAutomodeMainSession({
    repository,
    serializedConfiguration,
    configurationConfirmation,
    defaultReviewerExecution,
    normalAgentDir,
  });
  await mainSession.runInteractive();
}

const isEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isEntrypoint) await main();
