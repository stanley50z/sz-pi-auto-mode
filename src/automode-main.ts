import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InteractiveMode, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { resolveAutomodePaths } from "./paths.js";
import { createMainSessionRuntime } from "./session.js";
import {
  AUTOMODE_MODE_LABELS,
  parseAutomationStageConfiguration,
  parseConfirmedAutomationStageConfiguration,
  serializeAutomationStageConfiguration,
  type AutomationStageConfiguration,
} from "./stage-configuration.js";

export interface StartAutomodeMainOptions {
  repository: string;
  serializedConfiguration: string;
  configurationConfirmation: string;
  home?: string;
  normalAgentDir?: string;
}

export interface StartedAutomodeMainSession {
  cwd: string;
  configuration: AutomationStageConfiguration;
  sessionName: string;
  sessionFile: string | undefined;
  configurationFile: string;
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

function persistAutomationStageConfiguration(
  repository: string,
  configuration: AutomationStageConfiguration,
  home?: string,
  normalAgentDir?: string,
): string {
  const { automodeDir } = resolveAutomodePaths(repository, home, normalAgentDir);
  mkdirSync(automodeDir, { recursive: true });
  const configurationFile = join(automodeDir, "stage-configuration.json");
  const serialized = serializeAutomationStageConfiguration(configuration);
  try {
    writeFileSync(configurationFile, `${serialized}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const persisted = serializeAutomationStageConfiguration(
      parseAutomationStageConfiguration(readFileSync(configurationFile, "utf8")),
    );
    if (persisted !== serialized) {
      throw new Error("Automation Stage Configuration is fixed for this Automode Run");
    }
  }
  return configurationFile;
}

export async function startAutomodeMainSession(
  options: StartAutomodeMainOptions,
): Promise<StartedAutomodeMainSession> {
  const configuration = parseConfirmedAutomationStageConfiguration(
    options.serializedConfiguration,
    options.configurationConfirmation,
  );
  const configurationFile = persistAutomationStageConfiguration(
    options.repository,
    configuration,
    options.home,
    options.normalAgentDir,
  );
  const sessionName = `Automode Main — ${AUTOMODE_MODE_LABELS[configuration.mode]}`;
  const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills");
  const runtime = await createMainSessionRuntime({
    cwd: options.repository,
    skillPaths: [skillRoot],
    systemPrompt: "You are the Automode Main Session. The Coordinator is not implemented in this launch ticket; remain idle.",
    home: options.home,
    normalAgentDir: options.normalAgentDir,
    extensions: [automodeRunConfigurationGuard],
  });
  runtime.session.setSessionName(sessionName);
  runtime.session.sessionManager.appendCustomEntry("automode.stage-configuration", configuration);
  return {
    cwd: runtime.cwd,
    configuration,
    sessionName,
    sessionFile: runtime.session.sessionFile,
    configurationFile,
    runInteractive: async () => {
      const interactiveMode = new InteractiveMode(runtime, {
        initialMessages: [],
        verbose: false,
      });
      await interactiveMode.run();
    },
    dispose: () => runtime.session.dispose(),
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
