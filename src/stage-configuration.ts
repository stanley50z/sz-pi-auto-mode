import { createHash, timingSafeEqual } from "node:crypto";

export const AUTOMATION_STAGES = [
  "auto-triage",
  "auto-grilling",
  "auto-implement",
  "auto-review",
] as const;

export type AutomationStage = (typeof AUTOMATION_STAGES)[number];
export type AutomodeMode = "full" | "half";

export const AUTOMATION_STAGE_OPERATING_STATES = ["ON", "DRAINING", "OFF"] as const;
export type AutomationStageOperatingStateValue = (typeof AUTOMATION_STAGE_OPERATING_STATES)[number];

export interface AutomationStageOperatingState {
  readonly byStage: Readonly<Record<AutomationStage, AutomationStageOperatingStateValue>>;
}

export const AUTOMATION_STAGE_LABELS: Readonly<Record<AutomationStage, string>> = Object.freeze({
  "auto-triage": "Auto-Triage",
  "auto-grilling": "Auto-Grilling",
  "auto-implement": "Auto-Implement",
  "auto-review": "Auto-Review",
});

export const AUTOMODE_MODE_LABELS: Readonly<Record<AutomodeMode, string>> = Object.freeze({
  full: "Full-Auto",
  half: "Half-Auto",
});

export const HALF_AUTO_SELECTION_REQUIREMENT = "Half-Auto requires at least one Automation Stage.";

export interface AutomationStageConfiguration {
  readonly mode: AutomodeMode;
  readonly stages: readonly AutomationStage[];
}

function isAutomationStage(value: unknown): value is AutomationStage {
  return typeof value === "string" && (AUTOMATION_STAGES as readonly string[]).includes(value);
}

export function isValidHalfAutoSelection(stages: ReadonlySet<AutomationStage> | readonly AutomationStage[]): boolean {
  const count = "size" in stages ? stages.size : stages.length;
  return count >= 1 && count <= AUTOMATION_STAGES.length;
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
    throw new Error(HALF_AUTO_SELECTION_REQUIREMENT);
  }
  const orderedStages = AUTOMATION_STAGES.filter((stage) => uniqueStages.includes(stage));
  return Object.freeze({ mode, stages: Object.freeze(orderedStages) });
}

export function createAutomationStageOperatingState(
  byStage: Readonly<Record<AutomationStage, AutomationStageOperatingStateValue>>,
): AutomationStageOperatingState {
  const keys = Object.keys(byStage);
  if (
    keys.length !== AUTOMATION_STAGES.length
    || keys.some((stage) => !isAutomationStage(stage))
    || AUTOMATION_STAGES.some((stage) => !AUTOMATION_STAGE_OPERATING_STATES.includes(byStage[stage]))
  ) {
    throw new Error("Invalid Automation Stage Operating State");
  }
  return Object.freeze({ byStage: Object.freeze({ ...byStage }) });
}

export function restoreAutomationStageOperatingState(
  baseline: AutomationStageConfiguration,
): AutomationStageOperatingState {
  return createAutomationStageOperatingState(Object.fromEntries(
    AUTOMATION_STAGES.map((stage) => [stage, baseline.stages.includes(stage) ? "ON" : "OFF"]),
  ) as Record<AutomationStage, AutomationStageOperatingStateValue>);
}

export function serializeAutomationStageConfiguration(configuration: AutomationStageConfiguration): string {
  return JSON.stringify(createAutomationStageConfiguration(configuration.mode, configuration.stages));
}

export function confirmSerializedAutomationStageConfiguration(serialized: string): string {
  parseAutomationStageConfiguration(serialized);
  return createHash("sha256").update(serialized).digest("hex");
}

export function parseConfirmedAutomationStageConfiguration(
  serialized: string,
  confirmation: string,
): AutomationStageConfiguration {
  const actual = Buffer.from(confirmSerializedAutomationStageConfiguration(serialized), "hex");
  const expected = Buffer.from(confirmation, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Automation Stage Configuration changed after confirmation");
  }
  return parseAutomationStageConfiguration(serialized);
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
