export const AUTOMATION_STAGES = [
  "auto-triage",
  "auto-grilling",
  "auto-implement",
  "auto-review",
] as const;

export type AutomationStage = (typeof AUTOMATION_STAGES)[number];
export type AutomodeMode = "full" | "half";

export interface AutomationStageConfiguration {
  readonly mode: AutomodeMode;
  readonly stages: readonly AutomationStage[];
}

function isAutomationStage(value: unknown): value is AutomationStage {
  return typeof value === "string" && (AUTOMATION_STAGES as readonly string[]).includes(value);
}

export function isValidHalfAutoSelection(stages: ReadonlySet<AutomationStage> | readonly AutomationStage[]): boolean {
  const count = "size" in stages ? stages.size : stages.length;
  return count >= 1 && count <= 3;
}

export function createAutomationStageConfiguration(
  mode: AutomodeMode,
  stages: readonly AutomationStage[],
): AutomationStageConfiguration {
  const uniqueStages = [...new Set(stages)];
  if (uniqueStages.length !== stages.length || uniqueStages.some((stage) => !isAutomationStage(stage))) {
    throw new Error("Automode stage configuration contains an unknown or duplicate stage");
  }
  if (mode === "full" && (
    uniqueStages.length !== AUTOMATION_STAGES.length
    || AUTOMATION_STAGES.some((stage) => !uniqueStages.includes(stage))
  )) {
    throw new Error("Full-Auto requires all four Automation Stages");
  }
  if (mode === "half" && !isValidHalfAutoSelection(uniqueStages)) {
    throw new Error("Half-Auto requires one to three Automation Stages");
  }
  const orderedStages = AUTOMATION_STAGES.filter((stage) => uniqueStages.includes(stage));
  return Object.freeze({ mode, stages: Object.freeze(orderedStages) });
}

export function serializeAutomationStageConfiguration(configuration: AutomationStageConfiguration): string {
  return JSON.stringify(createAutomationStageConfiguration(configuration.mode, configuration.stages));
}

export function parseAutomationStageConfiguration(serialized: string): AutomationStageConfiguration {
  const value: unknown = JSON.parse(serialized);
  if (!value || typeof value !== "object" || !("mode" in value) || !("stages" in value)) {
    throw new Error("Invalid serialized Automode stage configuration");
  }
  const { mode, stages } = value as { mode: unknown; stages: unknown };
  if ((mode !== "full" && mode !== "half") || !Array.isArray(stages) || !stages.every(isAutomationStage)) {
    throw new Error("Invalid serialized Automode stage configuration");
  }
  return createAutomationStageConfiguration(mode, stages);
}
