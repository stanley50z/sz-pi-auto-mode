import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createAutomodeCapabilityProfile,
  type ExecutionProfile,
} from "./capability-profile.js";
import { repositoryRoot, resolveAutomodePaths } from "./paths.js";
import type { AutomationStageConfiguration } from "./stage-configuration.js";

const execFileAsync = promisify(execFile);

export interface StartupCommandRunner {
  run(command: string, args: readonly string[], cwd: string): Promise<string>;
}

export type ExecutionProfileAttestor = (profiles: readonly ExecutionProfile[]) => Promise<void>;

export interface ValidateAutomodeStartupOptions {
  repository: string;
  configuration: AutomationStageConfiguration;
  home?: string;
  normalAgentDir?: string;
  runner?: StartupCommandRunner;
  attestExecutions?: ExecutionProfileAttestor;
}

export interface ValidatedAutomodeStartup {
  readonly repository: string;
  readonly repositoryId: string;
  readonly repositorySlug: string;
  readonly actor: string;
}

export const processStartupCommandRunner: StartupCommandRunner = {
  async run(command, args, cwd) {
    const result = await execFileAsync(command, [...args], {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    return result.stdout.trim();
  },
};

function requiredExecutionProfiles(
  configuration: AutomationStageConfiguration,
): readonly ExecutionProfile[] {
  const profile = createAutomodeCapabilityProfile(configuration);
  const needsPanel = configuration.stages.includes("auto-grilling")
    || configuration.stages.includes("auto-review");
  return needsPanel ? profile.panelExecutions : [profile.ordinaryTicketExecution];
}

export async function attestClaudeCodeExecutionProfile(
  profile: ExecutionProfile,
  runner: StartupCommandRunner,
  repository: string,
): Promise<void> {
  if (profile.harness !== "claude-code") {
    throw new Error(`Expected a Claude Code execution profile; received ${profile.harness}`);
  }
  const status = JSON.parse(await runner.run("claude", ["auth", "status", "--json"], repository)) as {
    loggedIn?: unknown;
  };
  if (status.loggedIn !== true) throw new Error("Claude Code is not authenticated");

  const output = await runner.run("claude", [
    "--safe-mode",
    "--model", profile.model,
    "--effort", profile.reasoning,
    "--print",
    "--output-format", "json",
    "--tools", "",
    "--no-session-persistence",
    "Reply exactly AUTOMODE_PROFILE_READY.",
  ], repository);
  const result = JSON.parse(output) as unknown;
  const records = Array.isArray(result) ? result : [result];
  if (records.some((record) =>
    typeof record === "object" && record !== null && "is_error" in record && record.is_error === true
  )) {
    throw new Error(`Claude Code model probe failed for ${profile.model}/${profile.reasoning}`);
  }
}

async function defaultExecutionAttestor(
  profiles: readonly ExecutionProfile[],
  options: ValidateAutomodeStartupOptions,
  runner: StartupCommandRunner,
): Promise<void> {
  const paths = resolveAutomodePaths(options.repository, options.home, options.normalAgentDir);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(paths.normalAgentDir, "auth.json"),
    modelsPath: null,
    signal: AbortSignal.timeout(30_000),
  });
  const piProfiles = profiles.filter((profile) => profile.harness === "pi");
  const available = piProfiles.length > 0
    ? await modelRuntime.getAvailable(undefined, { signal: AbortSignal.timeout(30_000) })
    : [];
  for (const profile of piProfiles) {
    const found = available.some((model) =>
      model.id === profile.model && (profile.provider === undefined || model.provider === profile.provider)
    );
    if (!found) {
      const identity = profile.provider ? `${profile.provider}/${profile.model}` : profile.model;
      throw new Error(`missing Pi model ${identity}`);
    }
  }

  for (const profile of profiles.filter((candidate) => candidate.harness === "claude-code")) {
    await attestClaudeCodeExecutionProfile(profile, runner, options.repository);
  }
}

function githubSlugFromRemote(remote: string): string | undefined {
  const value = remote.trim();
  const scp = value.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i)?.[1];
  if (scp) return scp.replace(/\.git$/i, "");
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "github.com") return undefined;
    const slug = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return /^[^/]+\/[^/]+$/.test(slug) ? slug : undefined;
  } catch {
    return undefined;
  }
}

function requiredGitHubPermission(configuration: AutomationStageConfiguration): "TRIAGE" | "WRITE" {
  return configuration.stages.includes("auto-implement") || configuration.stages.includes("auto-review")
    ? "WRITE"
    : "TRIAGE";
}

function hasGitHubPermission(actual: string, required: "TRIAGE" | "WRITE"): boolean {
  const rank: Readonly<Record<string, number>> = {
    READ: 0,
    TRIAGE: 1,
    WRITE: 2,
    MAINTAIN: 3,
    ADMIN: 4,
  };
  return (rank[actual] ?? -1) >= rank[required]!;
}

async function withStartupErrorContext(
  label: string,
  operation: () => Promise<string>,
): Promise<string> {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${message}`, { cause: error });
  }
}

export async function validateAutomodeStartup(
  options: ValidateAutomodeStartupOptions,
): Promise<ValidatedAutomodeStartup> {
  const repository = repositoryRoot(options.repository);
  const runner = options.runner ?? processStartupCommandRunner;
  const gitRootOutput = await withStartupErrorContext(
    "Automode repository validation failed",
    () => runner.run("git", ["rev-parse", "--show-toplevel"], repository),
  );
  let gitRoot: string;
  try {
    gitRoot = realpathSync(gitRootOutput.trim());
  } catch (error) {
    throw new Error("Automode repository validation failed: git returned an invalid repository root", { cause: error });
  }
  if (gitRoot !== repository) {
    throw new Error(`Automode repository validation failed: expected ${repository}, received ${gitRoot}`);
  }

  const remote = await withStartupErrorContext(
    "GitHub repository access failed",
    () => runner.run("git", ["remote", "get-url", "origin"], repository),
  );
  const remoteSlug = githubSlugFromRemote(remote);
  if (!remoteSlug) {
    throw new Error("GitHub repository access failed: origin is not a github.com repository");
  }

  await withStartupErrorContext(
    "GitHub authentication failed",
    () => runner.run("gh", ["auth", "status", "--hostname", "github.com"], repository),
  );
  const repositoryJson = await withStartupErrorContext(
    "GitHub repository access failed",
    () => runner.run("gh", ["repo", "view", "--json", "id,nameWithOwner,url,viewerPermission"], repository),
  );
  let viewed: { id?: unknown; nameWithOwner?: unknown; url?: unknown; viewerPermission?: unknown };
  try {
    viewed = JSON.parse(repositoryJson) as {
      id?: unknown;
      nameWithOwner?: unknown;
      url?: unknown;
      viewerPermission?: unknown;
    };
  } catch (error) {
    throw new Error("GitHub repository access failed: gh returned invalid JSON", { cause: error });
  }
  let githubHosted = false;
  if (typeof viewed.url === "string") {
    try {
      githubHosted = new URL(viewed.url).hostname.toLowerCase() === "github.com";
    } catch {
      githubHosted = false;
    }
  }
  if (
    typeof viewed.id !== "string"
    || viewed.id.length === 0
    || typeof viewed.nameWithOwner !== "string"
    || viewed.nameWithOwner.length === 0
    || viewed.nameWithOwner.toLowerCase() !== remoteSlug.toLowerCase()
    || !githubHosted
  ) {
    throw new Error("GitHub repository access failed: local origin and gh repository identity do not match");
  }
  const permission = requiredGitHubPermission(options.configuration);
  if (typeof viewed.viewerPermission !== "string" || !hasGitHubPermission(viewed.viewerPermission, permission)) {
    throw new Error(`GitHub repository access failed: Automode requires ${permission} permission`);
  }
  const actor = (await withStartupErrorContext(
    "GitHub authenticated identity failed",
    () => runner.run("gh", ["api", "user", "--jq", ".login"], repository),
  )).trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(actor)) {
    throw new Error("GitHub authenticated identity failed: gh returned an invalid login");
  }

  const profiles = requiredExecutionProfiles(options.configuration);
  try {
    if (options.attestExecutions) await options.attestExecutions(profiles);
    else await defaultExecutionAttestor(profiles, options, runner);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Required execution profile is unavailable: ${message}`, { cause: error });
  }

  return {
    repository,
    repositoryId: viewed.id,
    repositorySlug: viewed.nameWithOwner,
    actor,
  };
}
