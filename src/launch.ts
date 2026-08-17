import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  const childEntrypoint = resolve(moduleDirectory, "automode-main.js");
  environment.AUTOMODE_STAGE_CONFIGURATION = request.serializedConfiguration;
  environment.AUTOMODE_STAGE_CONFIGURATION_CONFIRMATION = confirmSerializedAutomationStageConfiguration(
    request.serializedConfiguration,
  );
  environment.AUTOMODE_DEFAULT_REVIEWER_EXECUTION = JSON.stringify(request.defaultReviewerExecution);
  return {
    command: process.execPath,
    args: [childEntrypoint, request.cwd, normalAgentDir ?? ""],
    cwd: request.cwd,
    env: environment,
  };
}

export async function launchAutomode(request: AutomodeLaunchRequest): Promise<never> {
  return handoffTerminal(createAutomodeLaunchPlan(request));
}
