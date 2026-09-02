import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAutomodeEnvironment } from "./environment.js";
import { resolveAllowlistedGlobalSkills, type GlobalSkillSource } from "./global-skills.js";
import { handoffTerminal, type HandoffOptions } from "./handoff.js";
import type { AutomodeLaunchRequest } from "./bridge.js";
import {
  createAutomodeRuntimeSnapshot,
  type AutomodeRuntimeSnapshot,
  type AutomodeRuntimeSnapshotOptions,
} from "./runtime-snapshot.js";
import { confirmSerializedAutomationStageConfiguration } from "./stage-configuration.js";

export interface AutomodeLaunchPlan extends HandoffOptions {
  env: NodeJS.ProcessEnv;
}

export function createAutomodeLaunchPlan(
  request: AutomodeLaunchRequest,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
  moduleDirectory = dirname(fileURLToPath(import.meta.url)),
  globalSkillRoot?: string,
): AutomodeLaunchPlan {
  const { environment, normalAgentDir } = createAutomodeEnvironment(sourceEnvironment);
  const runtimeLoader = resolve(moduleDirectory, "pi-runtime-loader.js");
  const childEntrypoint = resolve(moduleDirectory, "automode-main.js");
  const runtimeLoaderUrl = pathToFileURL(runtimeLoader).href;
  environment.AUTOMODE_PI_PACKAGE_DIR = request.piPackageDir;
  environment.AUTOMODE_PI_RUNTIME_LOADER = runtimeLoaderUrl;
  environment.AUTOMODE_STAGE_CONFIGURATION = request.serializedConfiguration;
  environment.AUTOMODE_STAGE_CONFIGURATION_CONFIRMATION = confirmSerializedAutomationStageConfiguration(
    request.serializedConfiguration,
  );
  environment.AUTOMODE_MAIN_EXECUTION = JSON.stringify(request.mainExecution);
  if (globalSkillRoot) environment.AUTOMODE_GLOBAL_SKILL_ROOT = globalSkillRoot;
  return {
    command: process.execPath,
    args: ["--import", runtimeLoaderUrl, childEntrypoint, request.cwd, normalAgentDir ?? ""],
    cwd: request.cwd,
    env: environment,
  };
}

export interface AutomodeLaunchDependencies {
  readonly resolveGlobalSkills: () => readonly GlobalSkillSource[];
  readonly createRuntimeSnapshot: (
    sourceModuleDirectory: string,
    options: AutomodeRuntimeSnapshotOptions,
  ) => AutomodeRuntimeSnapshot;
  readonly handoff: (options: HandoffOptions) => Promise<void>;
}

const defaultDependencies: AutomodeLaunchDependencies = {
  resolveGlobalSkills: resolveAllowlistedGlobalSkills,
  createRuntimeSnapshot: createAutomodeRuntimeSnapshot,
  handoff: handoffTerminal,
};

export async function launchAutomode(
  request: AutomodeLaunchRequest,
  dependencies: AutomodeLaunchDependencies = defaultDependencies,
): Promise<void> {
  const sourceModuleDirectory = dirname(fileURLToPath(import.meta.url));
  const globalSkills = dependencies.resolveGlobalSkills();
  const snapshot = dependencies.createRuntimeSnapshot(sourceModuleDirectory, { globalSkills });
  try {
    await dependencies.handoff({
      ...createAutomodeLaunchPlan(
        request,
        process.env,
        snapshot.moduleDirectory,
        snapshot.globalSkillRoot,
      ),
      onChildExit: () => snapshot.dispose(),
    });
  } finally {
    snapshot.dispose();
  }
}
