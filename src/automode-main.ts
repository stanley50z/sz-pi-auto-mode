import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InteractiveMode, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { createMainSessionRuntime } from "./session.js";
import {
  parseAutomationStageConfiguration,
  type AutomationStage,
  type AutomationStageConfiguration,
} from "./stage-configuration.js";

export interface StartAutomodeMainOptions {
  repository: string;
  serializedConfiguration: string;
  home?: string;
  normalAgentDir?: string;
}

export interface StartedAutomodeMainSession {
  cwd: string;
  configuration: AutomationStageConfiguration;
  sessionName: string;
  sessionFile: string | undefined;
  tryNewSession(): Promise<{ cancelled: boolean }>;
  runInteractive(): Promise<void>;
  dispose(): void;
}

function immutableConfigurationExtension(configuration: AutomationStageConfiguration): InlineExtension {
  return {
    name: "automode-immutable-configuration",
    factory: (pi) => {
      pi.on("session_before_switch", () => ({ cancel: true }));
      pi.on("session_before_fork", () => ({ cancel: true }));
    },
  };
}

export async function startAutomodeMainSession(
  options: StartAutomodeMainOptions,
): Promise<StartedAutomodeMainSession> {
  const configuration = parseAutomationStageConfiguration(options.serializedConfiguration);
  const sessionName = `Automode Main — ${configuration.mode === "full" ? "Full-Auto" : "Half-Auto"}`;
  const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills");
  const runtime = await createMainSessionRuntime({
    cwd: options.repository,
    skillPaths: [skillRoot],
    systemPrompt: "You are the Automode Main Session. The Coordinator is not implemented in this launch ticket; remain idle.",
    home: options.home,
    normalAgentDir: options.normalAgentDir,
    extensionFactories: [immutableConfigurationExtension(configuration)],
  });
  runtime.session.setSessionName(sessionName);
  runtime.session.sessionManager.appendCustomEntry("automode.stage-configuration", configuration);
  runtime.session.sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Automode Main Session initialized with an immutable stage configuration. Queue discovery is not active yet." }],
    api: runtime.session.model?.api ?? "openai-completions",
    provider: runtime.session.model?.provider ?? "automode",
    model: runtime.session.model?.id ?? "main-session",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  return {
    cwd: runtime.cwd,
    configuration,
    sessionName,
    sessionFile: runtime.session.sessionFile,
    tryNewSession: () => runtime.newSession(),
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
  const normalAgentDir = process.argv[3] || undefined;
  const mainSession = await startAutomodeMainSession({ repository, serializedConfiguration, normalAgentDir });
  if (process.argv.includes("--launch-proof")) {
    let mutationRejected = false;
    try {
      (mainSession.configuration.stages as AutomationStageConfiguration["stages"] & AutomationStage[]).pop();
    } catch (error) {
      mutationRejected = error instanceof TypeError;
    }
    console.log(`AUTOMODE_MAIN_SESSION ${JSON.stringify({
      cwd: mainSession.cwd,
      configuration: mainSession.configuration,
      configurationFrozen: Object.isFrozen(mainSession.configuration) && Object.isFrozen(mainSession.configuration.stages),
      mutationRejected,
      sessionName: mainSession.sessionName,
      sessionFile: mainSession.sessionFile,
      pid: process.pid,
    })}`);
    mainSession.dispose();
    return;
  }
  await mainSession.runInteractive();
}

const isEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isEntrypoint) await main();
