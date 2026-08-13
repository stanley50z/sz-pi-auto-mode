import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
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
import { repositoryRoot, resolveAutomodePaths, type AutomodePaths } from "./paths.js";

export interface MainSessionOptions {
  cwd: string;
  skillPaths: string[];
  systemPrompt: string;
  model?: Model<any>;
  home?: string;
  normalAgentDir?: string;
  extensions?: InlineExtension[];
}

function prepareAutomodePaths(options: MainSessionOptions, cwd: string): AutomodePaths {
  const paths = resolveAutomodePaths(cwd, options.home, options.normalAgentDir);
  mkdirSync(paths.automodeDir, { recursive: true });
  mkdirSync(paths.sessionDir, { recursive: true });
  return paths;
}

async function createMainSessionServices(options: MainSessionOptions, cwd: string) {
  const paths = prepareAutomodePaths(options, cwd);
  const contextRoot = repositoryRoot(cwd);

  // Credentials deliberately come from normal Pi. Everything capable of loading
  // configuration or persisting context deliberately comes from the Automode root.
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
      extensionFactories: options.extensions,
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
  return { paths, services };
}

export async function createMainSession(
  options: MainSessionOptions,
): Promise<CreateAgentSessionResult> {
  const { paths, services } = await createMainSessionServices(options, options.cwd);
  return createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.create(options.cwd, paths.sessionDir),
    model: options.model,
    noTools: "all",
  });
}

export async function createMainSessionRuntime(
  options: MainSessionOptions,
): Promise<AgentSessionRuntime> {
  const initialPaths = prepareAutomodePaths(options, options.cwd);
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const { services } = await createMainSessionServices(options, cwd);
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
    agentDir: initialPaths.automodeDir,
    sessionManager: SessionManager.create(options.cwd, initialPaths.sessionDir),
  });
}
