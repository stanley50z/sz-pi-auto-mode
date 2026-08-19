import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface AutomodeCommandModule {
  runAutomodeCommand(args: string, ctx: ExtensionCommandContext): Promise<void>;
}

export type AutomodeCommandLoader = () => Promise<AutomodeCommandModule>;

const loadAutomodeCommand: AutomodeCommandLoader = () => import("./bridge.js");

export default function automodeBridgeEntry(
  pi: ExtensionAPI,
  load: AutomodeCommandLoader = loadAutomodeCommand,
): void {
  pi.registerCommand("automode", {
    description: "Leave normal Pi and launch Automode in this repository",
    handler: async (args, ctx) => {
      const { runAutomodeCommand } = await load();
      await runAutomodeCommand(args, ctx);
    },
  });
}
