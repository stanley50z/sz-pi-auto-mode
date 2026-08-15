import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  createAgentSessionServices,
  ModelRuntime,
  SettingsManager,
  type AgentSessionServices,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { isPathInside } from "./attestation.js";
import { AUTOMODE_SETTINGS } from "./capability-profile.js";
import { createAutomodeFastModeExtension } from "./fast-mode.js";
import { repositoryRoot, type AutomodePaths } from "./paths.js";

export interface ControlledServicesOptions {
  cwd: string;
  paths: AutomodePaths;
  skillPaths: readonly string[];
  systemPrompt: string;
  extensions?: readonly InlineExtension[];
}

function directMarkdownReferences(markdownPath: string, repository: string): string[] {
  const markdown = readFileSync(markdownPath, "utf8");
  const references: string[] = [];
  const targets = [
    ...[...markdown.matchAll(/\[[^\]]*\]\(([^)]+\.md)(?:#[^)]+)?\)/g)].map((match) => ({
      index: match.index,
      target: match[1]!,
    })),
    ...[...markdown.matchAll(/`([^`\r\n]+\.md)`/g)].map((match) => ({
      index: match.index,
      target: match[1]!,
    })),
  ].sort((left, right) => left.index - right.index);
  for (const { target } of targets) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || isAbsolute(target)) continue;
    const absolute = realpathSync(resolve(dirname(markdownPath), target));
    if (!isPathInside(absolute, repository)) {
      throw new Error(`Repository guidance reference leaves the repository: ${target}`);
    }
    references.push(absolute);
  }
  return references;
}

export function controlledGuidanceFiles(
  discovered: Array<{ path: string; content: string }>,
  repository: string,
): Array<{ path: string; content: string }> {
  const guidance = discovered.filter((file) => {
    const path = realpathSync(file.path);
    return isPathInside(path, repository);
  });
  const paths = new Set(guidance.map((file) => realpathSync(file.path)));
  const contextPath = resolve(repository, "CONTEXT.md");
  if (existsSync(contextPath)) paths.add(realpathSync(contextPath));
  for (const file of guidance) {
    for (const reference of directMarkdownReferences(file.path, repository)) paths.add(reference);
  }
  return [...paths].map((path) => ({ path, content: readFileSync(path, "utf8") }));
}

export async function createControlledServices(
  options: ControlledServicesOptions,
): Promise<AgentSessionServices> {
  const repository = repositoryRoot(options.cwd);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(options.paths.normalAgentDir, "auth.json"),
    modelsPath: null,
    signal: AbortSignal.timeout(30_000),
  });
  const settingsManager = SettingsManager.inMemory(AUTOMODE_SETTINGS);
  return createAgentSessionServices({
    cwd: repository,
    agentDir: options.paths.automodeDir,
    settingsManager,
    modelRuntime,
    resourceLoaderOptions: {
      additionalSkillPaths: [...options.skillPaths],
      extensionFactories: [
        createAutomodeFastModeExtension(options.paths.normalAgentDir),
        ...(options.extensions ?? []),
      ],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: false,
      agentsFilesOverride: ({ agentsFiles }) => ({
        agentsFiles: controlledGuidanceFiles(agentsFiles, repository),
      }),
      systemPrompt: options.systemPrompt,
      appendSystemPrompt: [],
    },
  });
}
