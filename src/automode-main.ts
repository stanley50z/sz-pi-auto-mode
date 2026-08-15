import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model } from "@earendil-works/pi-ai";
import { InteractiveMode, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { createCapabilitySession, type ProjectResourceAllowlist } from "./capability-session.js";
import { acquireRepositoryCoordinator } from "./coordinator-lock.js";
import { resolveAutomodePaths } from "./paths.js";
import { createMainSessionRuntime } from "./session.js";
import {
  validateAutomodeStartup,
  type ExecutionProfileAttestor,
  type StartupCommandRunner,
} from "./startup.js";
import {
  AUTOMODE_MODE_LABELS,
  parseConfirmedAutomationStageConfiguration,
  type AutomationStageConfiguration,
} from "./stage-configuration.js";

export interface StartAutomodeMainOptions {
  repository: string;
  serializedConfiguration: string;
  configurationConfirmation: string;
  home?: string;
  normalAgentDir?: string;
  model?: Model<any>;
  projectResources?: ProjectResourceAllowlist;
  startupValidation?: {
    runner?: StartupCommandRunner;
    attestExecutions?: ExecutionProfileAttestor;
  };
}

export interface StartedAutomodeMainSession {
  cwd: string;
  configuration: AutomationStageConfiguration;
  sessionName: string;
  sessionFile: string | undefined;
  runRecordFile: string;
  coordinatorId: string;
  coordinatorIdentityFile: string;
  coordinatorLockFile: string;
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
  const validated = await validateAutomodeStartup({
    repository: options.repository,
    configuration,
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
      configuration,
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
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    try {
      runtime.session.dispose();
    } finally {
      lease.release();
      disposed = true;
    }
  };
  return {
    cwd: runtime.cwd,
    configuration,
    sessionName,
    sessionFile: runtime.session.sessionFile,
    runRecordFile,
    coordinatorId: lease.coordinatorId,
    coordinatorIdentityFile: lease.identityFile,
    coordinatorLockFile: lease.lockFile,
    runInteractive: async () => {
      const interactiveMode = new InteractiveMode(runtime, {
        initialMessages: [],
        verbose: false,
      });
      try {
        await interactiveMode.run();
      } finally {
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
  if (!serializedConfiguration) throw new Error("Missing immutable Automation Stage Configuration");
  const configurationConfirmation = process.env.AUTOMODE_STAGE_CONFIGURATION_CONFIRMATION;
  if (!configurationConfirmation) throw new Error("Missing Automation Stage Configuration confirmation");
  const normalAgentDir = process.argv[3] || undefined;
  const mainSession = await startAutomodeMainSession({
    repository,
    serializedConfiguration,
    configurationConfirmation,
    normalAgentDir,
  });
  await mainSession.runInteractive();
}

const isEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isEntrypoint) await main();
