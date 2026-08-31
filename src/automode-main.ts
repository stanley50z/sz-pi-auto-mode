import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  openLocalDashboard,
  type CoordinatorDashboard,
  type CoordinatorDashboardOptions,
  type DashboardProjection,
  type DashboardStatus,
} from "./dashboard.js";
import { createDashboardProjection } from "./dashboard-ui.js";
import { GitHubTracker } from "./github-tracker.js";
import { requestReturnToNormalPi } from "./handoff-protocol.js";
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
  mainExecution: PiExecutionProfile;
  home?: string;
  normalAgentDir?: string;
  model?: Model<any>;
  capabilityModel?: Model<any>;
  projectResources?: ProjectResourceAllowlist;
  startupValidation?: {
    runner?: StartupCommandRunner;
    attestExecutions?: ExecutionProfileAttestor;
  };
  coordinator?: AutomodeCoordinator;
  coordinatorClock?: CoordinatorClock;
  createDashboard?: (options: CoordinatorDashboardOptions) => CoordinatorDashboard;
  openDashboardInBrowser?: (localUrl: string) => Promise<void>;
  returnToNormal?: () => Promise<void>;
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

type CoordinatorShutdownPhase = "none" | "draining" | "forcing";
type MainSessionPhase =
  | "prepared"
  | "dashboard-starting"
  | "coordinator-starting"
  | "coordinator-running"
  | "coordinator-stopped"
  | "dashboard-stopped"
  | "disposed";

class MainSessionLifecycle {
  private phase: MainSessionPhase = "prepared";
  private shutdown: CoordinatorShutdownPhase = "none";

  beginDashboardStart(): void {
    if (this.phase !== "prepared") {
      throw new Error(`Cannot start the Automode Dashboard while the Main Session is ${this.phase}`);
    }
    this.phase = "dashboard-starting";
  }

  beginCoordinatorStart(): void {
    if (this.phase !== "dashboard-starting") {
      throw new Error(`Cannot start the Automode Coordinator while the Main Session is ${this.phase}`);
    }
    this.phase = "coordinator-starting";
  }

  markCoordinatorStarted(): void {
    if (this.phase !== "coordinator-starting") {
      throw new Error(`Cannot finish Automode Coordinator startup while the Main Session is ${this.phase}`);
    }
    this.phase = "coordinator-running";
  }

  hasStartedCoordinator(): boolean {
    return this.phase === "coordinator-running" || this.phase === "coordinator-stopped";
  }

  isWaitingForCoordinatorStart(): boolean {
    return this.phase === "dashboard-starting";
  }

  requestCoordinatorShutdown(): Exclude<CoordinatorShutdownPhase, "none"> {
    if (
      this.phase !== "dashboard-starting"
      && this.phase !== "coordinator-starting"
      && this.phase !== "coordinator-running"
      && this.phase !== "coordinator-stopped"
    ) {
      throw new Error(`Cannot stop the Automode Coordinator while the Main Session is ${this.phase}`);
    }
    this.shutdown = this.shutdown === "none" ? "draining" : "forcing";
    return this.shutdown;
  }

  shutdownPhase(): CoordinatorShutdownPhase {
    return this.shutdown;
  }

  needsCoordinatorStop(): boolean {
    return this.phase === "coordinator-starting" || this.phase === "coordinator-running";
  }

  markCoordinatorStopped(): void {
    if (!this.needsCoordinatorStop()) {
      throw new Error(`Cannot finish Automode Coordinator shutdown while the Main Session is ${this.phase}`);
    }
    this.phase = "coordinator-stopped";
  }

  needsDashboardStop(): boolean {
    return this.phase === "dashboard-starting"
      || this.phase === "coordinator-starting"
      || this.phase === "coordinator-running"
      || this.phase === "coordinator-stopped";
  }

  markDashboardStopped(): void {
    if (!this.needsDashboardStop()) {
      throw new Error(`Cannot finish Automode Dashboard shutdown while the Main Session is ${this.phase}`);
    }
    this.phase = "dashboard-stopped";
  }

  isDisposed(): boolean {
    return this.phase === "disposed";
  }

  markDisposed(): void {
    if (this.phase !== "prepared" && this.phase !== "dashboard-stopped") {
      throw new Error(`Cannot release the Main Session while it is ${this.phase}`);
    }
    this.phase = "disposed";
  }
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
  projectResources: ProjectResourceAllowlist | undefined,
): string {
  const serialized = JSON.stringify({
    version: 1,
    coordinatorId,
    stageConfiguration: configuration,
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
    let legacyReviewerField = false;
    try {
      const parsed: unknown = JSON.parse(readFileSync(runRecordFile, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "defaultReviewerExecution" in parsed) {
        const { defaultReviewerExecution: _, ...durable } = parsed as Record<string, unknown>;
        persisted = JSON.stringify(durable);
        legacyReviewerField = true;
      } else {
        persisted = JSON.stringify(parsed);
      }
    } catch (parseError) {
      throw new Error("The durable Automode Run Record is invalid", { cause: parseError });
    }
    if (persisted !== serialized) {
      throw new Error("The Automode Run Record is fixed for this Automode Run");
    }
    if (legacyReviewerField) {
      const migrationFile = `${runRecordFile}.${process.pid}.tmp`;
      try {
        writeFileSync(migrationFile, `${serialized}\n`, { encoding: "utf8", flag: "wx" });
        renameSync(migrationFile, runRecordFile);
      } finally {
        rmSync(migrationFile, { force: true });
      }
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
  let requestDrain!: () => void;
  let requestForceStop!: () => void;
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
    onReturnToNormal: options.returnToNormal ?? requestReturnToNormalPi,
    onDrain: () => requestDrain(),
    onExit: () => requestForceStop(),
  });
  let runtime;
  let runRecordFile!: string;
  try {
    const attestationSession = await createCapabilitySession({
      cwd: validated.repository,
      model: options.capabilityModel,
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
      execution: options.mainExecution,
      model: options.model,
      home: options.home,
      normalAgentDir: options.normalAgentDir,
      extensions: [automodeRunConfigurationGuard, statusCard.extension],
    });
    runRecordFile = persistAutomodeRunRecord(
      paths.runRecordFile,
      lease.coordinatorId,
      configuration,
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

  const lifecycle = new MainSessionLifecycle();
  let coordinatorStartPromise: Promise<void> | undefined;
  let unsubscribeDashboard: (() => void) | undefined;
  const dashboardFactory = options.createDashboard
    ? options.createDashboard
    : createCoordinatorDashboard;
  const dashboard = dashboardFactory({
    onCommand: async (command) => {
      if (command.type === "drain") {
        if (lifecycle.shutdownPhase() === "none") interruptCoordinator();
        return;
      }
      if (!lifecycle.hasStartedCoordinator()) throw new Error("Automode Coordinator has not started");
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
      lifecycle.beginDashboardStart();
      dashboardStatus = await dashboard.start(dashboardProjection());
      await (options.openDashboardInBrowser ?? openLocalDashboard)(dashboardStatus.localUrl);
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
      const pendingShutdown = lifecycle.shutdownPhase();
      const coordinatorStarting = coordinator.start();
      lifecycle.beginCoordinatorStart();
      if (pendingShutdown !== "none") coordinator.interrupt();
      if (pendingShutdown === "forcing") coordinator.interrupt();
      if (pendingShutdown !== "none") {
        runLifecycle = "draining";
        publishDashboard();
      }
      statusCard.shutdownWhen(coordinator.whenStopped());
      await coordinatorStarting;
      lifecycle.markCoordinatorStarted();
      if (pendingShutdown === "none") runLifecycle = activeLifecycle();
      publishDashboard();
    })();
    return coordinatorStartPromise;
  };
  interruptCoordinator = () => {
    if (!coordinatorStartPromise) throw new Error("Automode Coordinator has not started");
    const shutdown = lifecycle.requestCoordinatorShutdown();
    if (lifecycle.isWaitingForCoordinatorStart()) {
      if (shutdown === "draining") runLifecycle = "draining";
      return shutdown;
    }
    const result = coordinator.interrupt();
    if (result === "draining") {
      runLifecycle = "draining";
      publishDashboard();
    }
    return result;
  };
  requestDrain = () => {
    if (lifecycle.shutdownPhase() === "none") interruptCoordinator();
  };
  requestForceStop = () => {
    requestDrain();
    if (lifecycle.shutdownPhase() !== "forcing") interruptCoordinator();
  };

  let disposePromise: Promise<void> | undefined;
  const finalizeDispose = async () => {
    if (lifecycle.needsDashboardStop()) {
      await dashboard.stop();
      lifecycle.markDashboardStopped();
    }
    if (!lifecycle.isDisposed()) {
      unsubscribeDashboard?.();
      try {
        runtime.session.dispose();
      } finally {
        lease.release();
        lifecycle.markDisposed();
      }
    }
  };
  const disposeOnce = async () => {
    let startupError: unknown;
    if (coordinatorStartPromise && lifecycle.isWaitingForCoordinatorStart()) {
      while (lifecycle.shutdownPhase() !== "forcing") interruptCoordinator();
    }
    if (coordinatorStartPromise) {
      try {
        await coordinatorStartPromise;
      } catch (error) {
        startupError = error;
      }
    }
    if (lifecycle.needsCoordinatorStop()) {
      while (lifecycle.shutdownPhase() !== "forcing") interruptCoordinator();
      await coordinator.whenStopped();
      lifecycle.markCoordinatorStopped();
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
      try {
        await startCoordinator();
        await interactiveMode.run();
        requestForceStop();
        await coordinator.whenStopped();
        lifecycle.markCoordinatorStopped();
      } finally {
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
  const serializedMainExecution = process.env.AUTOMODE_MAIN_EXECUTION;
  if (!serializedMainExecution) throw new Error("Missing Main Session execution profile");
  const mainExecution = parsePiExecutionProfile(serializedMainExecution);
  const normalAgentDir = process.argv[3] || undefined;
  const mainSession = await startAutomodeMainSession({
    repository,
    serializedConfiguration,
    configurationConfirmation,
    mainExecution,
    normalAgentDir,
  });
  await mainSession.runInteractive();
}

const isEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isEntrypoint) await main();
