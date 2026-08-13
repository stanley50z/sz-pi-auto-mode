import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  SessionManager,
  type AgentSessionServices,
  type CreateAgentSessionResult,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { attestCanonicalCommands, isPathInside } from "./attestation.js";
import {
  createAutomodeCapabilityProfile,
  type AutomodeCapabilityProfile,
} from "./capability-profile.js";
import { createControlledServices } from "./controlled-services.js";
import { repositoryRoot, resolveAutomodePaths } from "./paths.js";
import type { AutomationStageConfiguration } from "./stage-configuration.js";

export interface ProjectResourceAllowlist {
  readonly trusted: boolean;
  readonly skillPaths: readonly string[];
}

export interface CapabilitySessionOptions {
  cwd: string;
  configuration: AutomationStageConfiguration;
  model?: Model<any>;
  home?: string;
  normalAgentDir?: string;
  extensions?: readonly InlineExtension[];
  projectResources?: ProjectResourceAllowlist;
  sessionName?: string;
}

export interface CapabilitySession extends CreateAgentSessionResult {
  readonly services: AgentSessionServices;
  readonly profile: AutomodeCapabilityProfile;
}

function resolveProjectSkillPaths(
  projectResources: ProjectResourceAllowlist | undefined,
  repository: string,
): string[] {
  if (!projectResources) return [];
  if (projectResources.skillPaths.length > 0 && !projectResources.trusted) {
    throw new Error("Project executable resources must be explicitly trusted before allowlisting");
  }
  return projectResources.skillPaths.map((path) => {
    const absolute = realpathSync(resolve(path));
    if (!isPathInside(absolute, repository)) {
      throw new Error(`Allowlisted project skill is outside the repository: ${path}`);
    }
    realpathSync(join(absolute, "SKILL.md"));
    return absolute;
  });
}

function assertFixedModel(model: Model<any>, profile: AutomodeCapabilityProfile): void {
  const expected = profile.ordinaryTicketExecution;
  if (model.provider !== expected.provider || model.id !== expected.model) {
    throw new Error(
      `Ordinary Ticket Sessions require ${expected.provider}/${expected.model}; received ${model.provider}/${model.id}`,
    );
  }
}

async function resolveFixedModel(
  services: AgentSessionServices,
  profile: AutomodeCapabilityProfile,
  supplied: Model<any> | undefined,
): Promise<Model<any>> {
  if (supplied) {
    assertFixedModel(supplied, profile);
    return supplied;
  }
  const expected = profile.ordinaryTicketExecution;
  const available = await services.modelRuntime.getAvailable(
    expected.provider,
    { signal: AbortSignal.timeout(30_000) },
  );
  const model = available.find((candidate) =>
    candidate.provider === expected.provider && candidate.id === expected.model
  );
  if (!model) throw new Error(`Required execution profile is unavailable: ${expected.provider}/${expected.model}`);
  return model;
}

export async function createCapabilitySession(
  options: CapabilitySessionOptions,
): Promise<CapabilitySession> {
  const repository = repositoryRoot(options.cwd);
  const profile = createAutomodeCapabilityProfile(options.configuration);
  const paths = resolveAutomodePaths(repository, options.home, options.normalAgentDir);
  mkdirSync(paths.automodeDir, { recursive: true });
  mkdirSync(paths.sessionDir, { recursive: true });
  const projectSkillPaths = resolveProjectSkillPaths(options.projectResources, repository);
  const services = await createControlledServices({
    cwd: repository,
    paths,
    skillPaths: [...profile.skills.map((skill) => skill.sourceRoot), ...projectSkillPaths],
    extensions: options.extensions,
    systemPrompt: "You are an Automode Ticket Session. Execute only the deterministically invoked canonical stage skill.",
  });
  const model = await resolveFixedModel(services, profile, options.model);
  const result = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.create(repository, paths.sessionDir),
    model,
    thinkingLevel: profile.ordinaryTicketExecution.reasoning,
    scopedModels: [{ model, thinkingLevel: profile.ordinaryTicketExecution.reasoning }],
    tools: [...profile.tools],
  });
  try {
    const commands = result.extensionsResult.runtime.getCommands();
    attestCanonicalCommands(
      commands,
      profile.skills.map((skill) => ({ command: `skill:${skill.name}`, sourceRoot: skill.sourceRoot })),
      services.resourceLoader.getSkills().diagnostics,
    );
    const allowedSkillFiles = new Set(
      [...profile.skills.map((skill) => skill.sourceRoot), ...projectSkillPaths]
        .map((root) => realpathSync(join(root, "SKILL.md"))),
    );
    for (const command of commands) {
      if (command.source === "skill" && allowedSkillFiles.has(realpathSync(command.sourceInfo.path))) continue;
      if (
        command.source === "extension"
        && profile.extensionCommands.includes(command.name)
        && command.sourceInfo.path === "<inline:automode-openai-fast-mode>"
      ) continue;
      throw new Error(`Unexpected command in Automode Capability Profile: ${command.name}`);
    }
    if (commands.length !== allowedSkillFiles.size + profile.extensionCommands.length) {
      throw new Error("Automode Capability Profile did not expose exactly one command per allowlisted resource");
    }
    if (options.sessionName) result.session.setSessionName(options.sessionName);
    return { ...result, services, profile };
  } catch (error) {
    result.session.dispose();
    throw error;
  }
}
