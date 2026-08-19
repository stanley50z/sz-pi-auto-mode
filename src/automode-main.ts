import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import { InteractiveMode, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { createCapabilitySession, type ProjectResourceAllowlist } from "./capability-session.js";
import { parsePiExecutionProfile, type PiExecutionProfile } from "./capability-profile.js";
import { AutomodeCoordinator, type CoordinatorClock } from "./coordinator.js";
import { acquireRepositoryCoordinator } from "./coordinator-lock.js";
import {
  AUTOMODE_DASHBOARD_LOCAL_URL,
  createCoordinatorDashboard,
  type CoordinatorDashboard,
  type CoordinatorDashboardOptions,
  type DashboardProjection,
  type DashboardStatus,
} from "./dashboard.js";
import { createDashboardProjection } from "./dashboard-ui.js";
import { GitHubTracker } from "./github-tracker.js";
import { createAutomodeStatusCard } from "./main-status-card.js";
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
  createDashboard?: (options: CoordinatorDashboardOptions) => CoordinatorDashboard;
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
  dispose(): Promise<void>;
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
  const repositoryDashboardIdentity = {
    name: validated.repositorySlug,
    url: `https://github.com/${validated.repositorySlug}`,
  } as const;
  let interruptCoordinator!: () => "draining" | "forcing";
  let dashboardStatus: DashboardStatus = { localUrl: AUTOMODE_DASHBOARD_LOCAL_URL };
  const initialDashboardProjection = createDashboardProjection({
    repository: repositoryDashboardIdentity,
    run: {
      id: lease.coordinatorId,
      mode: configuration.mode,
      lifecycle: "loading",
    },
  }, coordinator.getProjection());
  const statusCard = createAutomodeStatusCard({
    initial: {
      projection: initialDashboardProjection,
      dashboard: dashboardStatus,
    },
    onInterrupt: () => interruptCoordinator(),
  });
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
      extensions: [automodeRunConfigurationGuard, statusCard.extension],
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

  const sessionName = `Automode Main — ${AUTOMODE_MODE_LABELS[configuration.mode]}`;
  runtime.session.setSessionName(sessionName);
  runtime.session.sessionManager.appendCustomEntry("automode.stage-configuration", configuration);
  runtime.session.sessionManager.appendCustomEntry("automode.coordinator", {
    coordinatorId: lease.coordinatorId,
  });

  let runLifecycle: DashboardProjection["run"]["lifecycle"] = "loading";
  const dashboardProjection = (): DashboardProjection => {
    const coordinatorProjection = coordinator.getProjection();
    const projection = createDashboardProjection({
      repository: repositoryDashboardIdentity,
      run: {
        id: lease.coordinatorId,
        mode: configuration.mode,
        lifecycle: runLifecycle,
      },
    }, coordinatorProjection);
    return dashboardStatus.exposureError === undefined
      ? projection
      : { ...projection, tailscaleError: dashboardStatus.exposureError };
  };

  let coordinatorStartInitiated = false;
  let coordinatorStarted = false;
  let coordinatorStopped = false;
  let coordinatorInterrupts = 0;
  let coordinatorStartPromise: Promise<void> | undefined;
  let dashboardStartAttempted = false;
  let unsubscribeDashboard: (() => void) | undefined;
  const dashboardFactory = options.createDashboard
    ? options.createDashboard
    : createCoordinatorDashboard;
  const dashboard = dashboardFactory({
    onCommand: async (command) => {
      if (command.type === "drain") {
        if (coordinatorInterrupts === 0) interruptCoordinator();
        return;
      }
      if (!coordinatorStarted) throw new Error("Automode Coordinator has not started");
      if (command.type === "refresh") {
        await coordinator.refresh();
        return;
      }
      await coordinator.setStageOperatingState(command.stage, command.state);
    },
  });
  const publishDashboard = () => {
    const projection = dashboardProjection();
    dashboard.publish(projection);
    statusCard.publish({ projection, dashboard: dashboardStatus });
  };
  const activeLifecycle = (): DashboardProjection["run"]["lifecycle"] => {
    if (dashboardStatus.exposureError) return "degraded";
    return coordinator.getProjection().totals.candidates === 0 ? "empty" : "active";
  };

  const startCoordinator = async () => {
    if (coordinatorStartPromise) return coordinatorStartPromise;
    coordinatorStartPromise = (async () => {
      dashboardStartAttempted = true;
      dashboardStatus = await dashboard.start(dashboardProjection());
      unsubscribeDashboard = coordinator.subscribe((event) => {
        if (event.type === "projection") {
          if (runLifecycle !== "loading" && runLifecycle !== "draining") {
            runLifecycle = activeLifecycle();
          }
          publishDashboard();
        } else dashboard.appendActivity({
          id: event.activity.id,
          itemKey: event.activity.itemKey,
          occurredAt: event.activity.occurredAt,
          kind: event.activity.kind,
          message: event.activity.message,
          data: event.activity.data,
        });
      });
      publishDashboard();
      const pendingInterrupts = coordinatorInterrupts;
      const coordinatorStarting = coordinator.start();
      coordinatorStartInitiated = true;
      for (let index = 0; index < pendingInterrupts; index += 1) {
        coordinator.interrupt();
      }
      if (pendingInterrupts > 0) {
        runLifecycle = "draining";
        publishDashboard();
      }
      statusCard.shutdownWhen(coordinator.whenStopped());
      await coordinatorStarting;
      coordinatorStarted = true;
      if (pendingInterrupts === 0) runLifecycle = activeLifecycle();
      publishDashboard();
    })();
    return coordinatorStartPromise;
  };
  interruptCoordinator = () => {
    if (!coordinatorStartPromise) throw new Error("Automode Coordinator has not started");
    coordinatorInterrupts += 1;
    if (!coordinatorStartInitiated) {
      if (coordinatorInterrupts === 1) runLifecycle = "draining";
      return coordinatorInterrupts === 1 ? "draining" : "forcing";
    }
    const result = coordinator.interrupt();
    if (result === "draining") {
      runLifecycle = "draining";
      publishDashboard();
    }
    return result;
  };

  let dashboardStopped = false;
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  const finalizeDispose = async () => {
    try {
      if (dashboardStartAttempted && !dashboardStopped) {
        await dashboard.stop();
        dashboardStopped = true;
      }
    } finally {
      if (!disposed) {
        unsubscribeDashboard?.();
        try {
          runtime.session.dispose();
        } finally {
          lease.release();
          disposed = true;
        }
      }
    }
  };
  const disposeOnce = async () => {
    let startupError: unknown;
    if (coordinatorStartPromise && !coordinatorStartInitiated) {
      while (coordinatorInterrupts < 2) interruptCoordinator();
    }
    if (coordinatorStartPromise) {
      try {
        await coordinatorStartPromise;
      } catch (error) {
        startupError = error;
      }
    }
    if (coordinatorStartInitiated && !coordinatorStopped) {
      while (coordinatorInterrupts < 2) interruptCoordinator();
      await coordinator.whenStopped();
      coordinatorStopped = true;
    }
    let cleanupError: unknown;
    try {
      await finalizeDispose();
    } catch (error) {
      cleanupError = error;
    }
    if (startupError && cleanupError) {
      throw new AggregateError([startupError, cleanupError], "Automode startup and disposal both failed");
    }
    if (startupError) throw startupError;
    if (cleanupError) throw cleanupError;
  };
  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    const pending = disposeOnce().catch((error) => {
      if (disposePromise === pending) disposePromise = undefined;
      throw error;
    });
    disposePromise = pending;
    return pending;
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
        await dispose();
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
