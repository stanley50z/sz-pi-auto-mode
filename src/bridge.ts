import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createAutomodeSelector, type SelectorTheme } from "./selector.js";
import type { PiExecutionProfile } from "./capability-profile.js";
import { launchAutomode } from "./launch.js";
import { repositoryRoot } from "./paths.js";
import { serializeAutomationStageConfiguration, type AutomationStageConfiguration } from "./stage-configuration.js";

export interface AutomodeLaunchRequest {
  cwd: string;
  serializedConfiguration: string;
  defaultReviewerExecution: PiExecutionProfile;
}

export interface AutomodeBridgeDependencies {
  selectConfiguration(ctx: ExtensionCommandContext): Promise<AutomationStageConfiguration | null>;
  launch(request: AutomodeLaunchRequest): Promise<never>;
}

function selectorTheme(theme: ExtensionCommandContext["ui"]["theme"]): SelectorTheme {
  return {
    accent: (text) => theme.fg("accent", text),
    selected: (text) => theme.bg("selectedBg", theme.fg("text", ` ${text} `)),
    text: (text) => theme.fg("text", text),
    muted: (text) => theme.fg("muted", text),
    dim: (text) => theme.fg("dim", text),
    success: (text) => theme.fg("success", text),
    warning: (text) => theme.fg("warning", text),
    bold: (text) => theme.bold(text),
  };
}

export async function selectAutomationStageConfiguration(
  ctx: ExtensionCommandContext,
): Promise<AutomationStageConfiguration | null> {
  if (ctx.mode !== "tui") {
    throw new Error("/automode requires Pi's interactive TUI");
  }
  const result = await ctx.ui.custom<AutomationStageConfiguration | null>((tui, theme, _keybindings, done) => {
    const selector = createAutomodeSelector({
      theme: selectorTheme(theme),
      onChange: () => tui.requestRender(),
      onDone: done,
    });
    return selector;
  });
  return result ?? null;
}

const defaultDependencies: AutomodeBridgeDependencies = {
  selectConfiguration: selectAutomationStageConfiguration,
  launch: launchAutomode,
};

export default function automodeBridge(
  pi: ExtensionAPI,
  dependencies: AutomodeBridgeDependencies = defaultDependencies,
): void {
  pi.registerCommand("automode", {
    description: "Leave normal Pi and launch Automode in this repository",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const configuration = await dependencies.selectConfiguration(ctx);
      if (configuration === null) return;
      if (!ctx.model) throw new Error("/automode requires an active Pi model for the default Reviewer seat");
      await dependencies.launch({
        cwd: repositoryRoot(ctx.cwd),
        serializedConfiguration: serializeAutomationStageConfiguration(configuration),
        defaultReviewerExecution: {
          harness: "pi",
          provider: ctx.model.provider,
          model: ctx.model.id,
          reasoning: "high",
        },
      });
    },
  });
}
