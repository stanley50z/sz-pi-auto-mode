import { StringEnum } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  runGrillingPanel,
  runReviewPanel,
  type GrillingRoundContext,
  type PanelSeatLauncher,
  type ReviewRoundContext,
} from "./panel-runtime.js";

export function createTicketPanelExtension(launcher: PanelSeatLauncher): InlineExtension {
  return {
    name: "automode-panel",
    factory(pi) {
      pi.registerTool({
        name: "automode_panel",
        label: "Automode Panel",
        description: "Run the exact controlled three-seat Automode grilling or review panel. Every seat receives the same immutable context and cannot see peers or mutate workflow state.",
        parameters: Type.Object({
          kind: StringEnum(["grilling", "review"] as const),
          context: Type.Unknown(),
        }),
        async execute(_toolCallId, params) {
          const result = params.kind === "grilling"
            ? await runGrillingPanel({ context: params.context as GrillingRoundContext }, launcher)
            : await runReviewPanel({ context: params.context as ReviewRoundContext }, launcher);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: result,
          };
        },
      });
    },
  };
}
