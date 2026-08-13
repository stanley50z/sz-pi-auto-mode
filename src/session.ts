import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionRuntime,
  type CreateAgentSessionResult,
  type CreateAgentSessionRuntimeFactory,
  type InlineExtension,
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
  extensionFactories?: InlineExtension[];
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

export async function createMainSessionRuntime(
  options: MainSessionOptions,
): Promise<AgentSessionRuntime> {
  const paths = resolveAutomodePaths(options.cwd, options.home, options.normalAgentDir);
  const contextRoot = repositoryRoot(options.cwd);
  mkdirSync(paths.automodeDir, { recursive: true });
  mkdirSync(paths.sessionDir, { recursive: true });

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const modelRuntime = await ModelRuntime.create({
      authPath: join(paths.normalAgentDir, "auth.json"),
      modelsPath: join(paths.automodeDir, "models.json"),
      signal: AbortSignal.timeout(30_000),
    });
    const settingsManager = SettingsManager.create(paths.automodeDir, paths.automodeDir);
    const services = await createAgentSessionServices({
      cwd,
      agentDir: paths.automodeDir,
      modelRuntime,
      settingsManager,
      resourceLoaderOptions: {
        additionalSkillPaths: options.skillPaths,
        extensionFactories: options.extensionFactories,
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
      },
    });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        model: options.model,
        noTools: "all",
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };

  return createAgentSessionRuntime(createRuntime, {
    cwd: options.cwd,
    agentDir: paths.automodeDir,
    sessionManager: SessionManager.create(options.cwd, paths.sessionDir),
  });
}
