import { StringEnum } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { ExecutionProfile } from "./capability-profile.js";
import { Type } from "typebox";
import {
  createPanelSeats,
  runGrillingPanel,
  runReviewPanel,
  type GrillingRoundContext,
  type PanelSeatLauncher,
  type ReviewRoundContext,
} from "./panel-runtime.js";

export function createTicketPanelExtension(
  launcher: PanelSeatLauncher,
  executions: readonly ExecutionProfile[],
): InlineExtension {
  const seats = createPanelSeats(executions);
  return {
    name: "automode-panel",
    factory(pi) {
      pi.registerTool({
        name: "automode_panel",
        label: "Automode Panel",
        description: "Run the exact controlled configured Automode grilling or review panel. Every seat receives the same immutable context and cannot see peers or mutate workflow state.",
        parameters: Type.Object({
          kind: StringEnum(["grilling", "review"] as const),
          context: Type.Unknown(),
        }),
        async execute(_toolCallId, params) {
          const result = params.kind === "grilling"
            ? await runGrillingPanel({ context: params.context as GrillingRoundContext }, launcher, seats)
            : await runReviewPanel({ context: params.context as ReviewRoundContext }, launcher, seats);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: result,
          };
        },
      });
    },
  };
}
