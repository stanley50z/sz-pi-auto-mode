import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AutomationStage } from "./stage-configuration.js";

export type CapabilitySkillOwner = "native" | "automode";
export type CapabilitySkillKind = "shared" | "support" | "stage";

export interface CapabilitySkill {
  readonly name: string;
  readonly owner: CapabilitySkillOwner;
  readonly kind: CapabilitySkillKind;
  readonly sourceRoot: string;
}

export interface ExecutionProfile {
  readonly harness: "pi" | "claude-code";
  readonly provider?: string;
  readonly model: string;
  readonly reasoning: "high";
}

export interface PiExecutionProfile extends ExecutionProfile {
  readonly harness: "pi";
  readonly provider: string;
}

export interface AutomodeSettings {
  readonly defaultThinkingLevel: "high";
  readonly enableSkillCommands: true;
  readonly defaultProjectTrust: "never";
}

export interface AutomodeCapabilityProfile {
  readonly skills: readonly CapabilitySkill[];
  readonly tools: readonly string[];
  readonly extensionCommands: readonly string[];
  readonly prompts: readonly string[];
  readonly settings: AutomodeSettings;
  readonly ordinaryTicketExecution: PiExecutionProfile;
  readonly panelExecutions: readonly ExecutionProfile[];
}

const SHARED_SKILLS = [
  "wayfinder",
  "to-spec",
  "to-tickets",
  "domain-modeling",
  "research",
  "codebase-design",
  "commit",
  "resolving-merge-conflicts",
  "handoff",
  "setup-matt-pocock-skills",
] as const;

const SUPPORT_SKILLS = [
  "browser-harness",
  "ketch",
  "diagnosing-bugs",
  "openwiki",
  "writing-for-agents",
  "wizard",
] as const;

const STAGE_SKILLS: Readonly<Record<AutomationStage, readonly string[]>> = {
  "auto-triage": ["triage"],
  "auto-grilling": ["grilling"],
  "auto-implement": ["prototype", "implement", "tdd"],
  "auto-review": ["code-review"],
};

export const AUTOMODE_TOOLS = Object.freeze(["read", "bash", "edit", "write", "grep", "find", "ls"]);

export const AUTOMODE_SETTINGS: AutomodeSettings = Object.freeze({
  defaultThinkingLevel: "high",
  enableSkillCommands: true,
  defaultProjectTrust: "never",
});

export const ORDINARY_TICKET_EXECUTION: PiExecutionProfile = Object.freeze({
  harness: "pi",
  provider: "openai-codex",
  model: "gpt-5.6-sol",
  reasoning: "high",
});

export const PANEL_EXECUTIONS: readonly ExecutionProfile[] = Object.freeze([
  ORDINARY_TICKET_EXECUTION,
  Object.freeze({ harness: "pi", provider: "github-copilot", model: "claude-fable-5", reasoning: "high" }),
]);

export function parsePiExecutionProfile(serialized: string): PiExecutionProfile {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new Error("The Pi execution profile is not valid JSON", { cause: error });
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("The Pi execution profile must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.harness !== "pi"
    || typeof candidate.provider !== "string"
    || candidate.provider.length === 0
    || typeof candidate.model !== "string"
    || candidate.model.length === 0
    || candidate.reasoning !== "high"
  ) {
    throw new Error("The Pi execution profile is invalid");
  }
  return Object.freeze({
    harness: "pi",
    provider: candidate.provider,
    model: candidate.model,
    reasoning: "high",
  });
}

function packageSkillRoot(owner: CapabilitySkillOwner, name: string): string {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  return resolve(sourceDirectory, "../../skills", owner, name);
}

export function createAutomodeCapabilityProfile(): AutomodeCapabilityProfile {
  const skills: CapabilitySkill[] = SHARED_SKILLS.map((name) => Object.freeze({
    name,
    owner: "native" as const,
    kind: "shared" as const,
    sourceRoot: packageSkillRoot("native", name),
  }));

  for (const name of SUPPORT_SKILLS) {
    skills.push(Object.freeze({
      name,
      owner: "native" as const,
      kind: "support" as const,
      sourceRoot: packageSkillRoot("native", name),
    }));
  }

  for (const [stage, names] of Object.entries(STAGE_SKILLS) as Array<[AutomationStage, readonly string[]]>) {
    for (const name of names) {
      skills.push(Object.freeze({
        name,
        owner: "automode",
        kind: "stage" as const,
        sourceRoot: packageSkillRoot("automode", name),
      }));
    }
  }

  return Object.freeze({
    skills: Object.freeze(skills),
    tools: AUTOMODE_TOOLS,
    extensionCommands: Object.freeze(["fast"]),
    prompts: Object.freeze([]),
    settings: AUTOMODE_SETTINGS,
    ordinaryTicketExecution: ORDINARY_TICKET_EXECUTION,
    panelExecutions: PANEL_EXECUTIONS,
  });
}
