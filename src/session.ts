import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionResult,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { isPathInside } from "./attestation.js";
import { repositoryRoot, resolveAutomodePaths } from "./paths.js";

export interface MainSessionOptions {
  cwd: string;
  skillPaths: string[];
  systemPrompt: string;
  model?: Model<any>;
  home?: string;
  normalAgentDir?: string;
}

export async function createMainSession(
  options: MainSessionOptions,
): Promise<CreateAgentSessionResult> {
  const paths = resolveAutomodePaths(options.cwd, options.home, options.normalAgentDir);
  const contextRoot = repositoryRoot(options.cwd);
  mkdirSync(paths.automodeDir, { recursive: true });
  mkdirSync(paths.sessionDir, { recursive: true });

  // Credentials deliberately come from normal Pi. Everything capable of loading
  // configuration or persisting context deliberately comes from the Automode root.
  const modelRuntime = await ModelRuntime.create({
    authPath: join(paths.normalAgentDir, "auth.json"),
    modelsPath: join(paths.automodeDir, "models.json"),
    signal: AbortSignal.timeout(30_000),
  });
  const settingsManager = SettingsManager.create(paths.automodeDir, paths.automodeDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: paths.automodeDir,
    settingsManager,
    additionalSkillPaths: options.skillPaths,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: false,
    agentsFilesOverride: ({ agentsFiles }) => ({
      agentsFiles: agentsFiles.filter((file) => isPathInside(realpathSync(file.path), contextRoot)),
    }),
    systemPrompt: options.systemPrompt,
    appendSystemPrompt: [],
  });
  await resourceLoader.reload();

  return createAgentSession({
    cwd: options.cwd,
    agentDir: paths.automodeDir,
    modelRuntime,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.create(options.cwd, paths.sessionDir),
    model: options.model,
    noTools: "all",
  });
}
