import { StringEnum } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { ExecutionProfile } from "./capability-profile.js";
import type { NestedSessionEvent } from "./nested-session.js";
import { Type } from "typebox";
import {
  createPanelSeats,
  runGrillingPanel,
  runReviewPanel,
  type GrillingRoundContext,
  type PanelSeatLauncher,
  type ReviewRoundContext,
} from "./panel-runtime.js";
import { addUsage, emptyUsage } from "./usage.js";

export interface TicketPanelNestedActivity {
  readonly toolName: "automode_panel";
  readonly toolCallId: string;
  readonly child: NestedSessionEvent;
}

export function createTicketPanelExtension(
  launcher: PanelSeatLauncher,
  executions: readonly ExecutionProfile[],
  onNestedActivity?: (activity: TicketPanelNestedActivity) => void,
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
        async execute(toolCallId, params) {
          const nestedSessions: NestedSessionEvent[] = [];
          const emit = (child: NestedSessionEvent): void => {
            nestedSessions.push(child);
            onNestedActivity?.({ toolName: "automode_panel", toolCallId, child });
          };
          if (params.kind === "grilling") {
            const result = await runGrillingPanel(
              { context: params.context as GrillingRoundContext },
              launcher,
              seats,
              emit,
            );
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
              details: { ...result, nestedSessions } as unknown,
            };
          }
          const result = await runReviewPanel(
            { context: params.context as ReviewRoundContext },
            launcher,
            seats,
            emit,
          );
          const usage = result.reports.reduce(
            (total, report) => addUsage(total, report.usage),
            emptyUsage(),
          );
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: { ...result, nestedSessions } as unknown,
            usage,
          };
        },
      });
    },
  };
}
