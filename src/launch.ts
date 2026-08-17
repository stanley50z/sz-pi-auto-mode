import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAutomodeEnvironment } from "./environment.js";
import { handoffTerminal, type HandoffOptions } from "./handoff.js";
import type { AutomodeLaunchRequest } from "./bridge.js";
import { confirmSerializedAutomationStageConfiguration } from "./stage-configuration.js";

export interface AutomodeLaunchPlan extends HandoffOptions {
  env: NodeJS.ProcessEnv;
}

export function createAutomodeLaunchPlan(
  request: AutomodeLaunchRequest,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
): AutomodeLaunchPlan {
  const { environment, normalAgentDir } = createAutomodeEnvironment(sourceEnvironment);
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const runtimeLoader = resolve(moduleDirectory, "pi-runtime-loader.js");
  const childEntrypoint = resolve(moduleDirectory, "automode-main.js");
  const runtimeLoaderUrl = pathToFileURL(runtimeLoader).href;
  environment.AUTOMODE_PI_PACKAGE_DIR = request.piPackageDir;
  environment.AUTOMODE_PI_RUNTIME_LOADER = runtimeLoaderUrl;
  environment.AUTOMODE_STAGE_CONFIGURATION = request.serializedConfiguration;
  environment.AUTOMODE_STAGE_CONFIGURATION_CONFIRMATION = confirmSerializedAutomationStageConfiguration(
    request.serializedConfiguration,
  );
  environment.AUTOMODE_DEFAULT_REVIEWER_EXECUTION = JSON.stringify(request.defaultReviewerExecution);
  return {
    command: process.execPath,
    args: ["--import", runtimeLoaderUrl, childEntrypoint, request.cwd, normalAgentDir ?? ""],
    cwd: request.cwd,
    env: environment,
  };
}

export async function launchAutomode(request: AutomodeLaunchRequest): Promise<never> {
  return handoffTerminal(createAutomodeLaunchPlan(request));
}
