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
import type { GitHubExternalReviews } from "./external-review.js";

export interface TicketPanelNestedActivity {
  readonly toolName: "automode_panel";
  readonly toolCallId: string;
  readonly child: NestedSessionEvent;
}

/** Exposes controlled Panel rounds, optionally joining external bot reviews before disposition. */
export function createTicketPanelExtension(
  launcher: PanelSeatLauncher,
  executions: readonly ExecutionProfile[],
  onNestedActivity?: (activity: TicketPanelNestedActivity) => void,
  externalReviews?: GitHubExternalReviews,
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
        async execute(toolCallId, params, signal) {
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
          const context = params.context as ReviewRoundContext;
          await externalReviews?.begin(context, signal);
          const externalAbort = new AbortController();
          const externalSignal = signal ? AbortSignal.any([signal, externalAbort.signal]) : externalAbort.signal;
          const panelRun = runReviewPanel({ context }, launcher, seats, emit).then((result) => {
            if (result.failures.length > 0) externalAbort.abort(new Error("External wait cancelled because the built-in Review Panel failed"));
            return result;
          }, (error: unknown) => {
            externalAbort.abort(error);
            throw error;
          });
          const [panel, external] = await Promise.allSettled([
            panelRun,
            externalReviews?.wait(context, externalSignal),
          ]);
          const externalError: unknown = externalAbort.signal.aborted ? externalAbort.signal.reason
            : external.status === "rejected" ? external.reason : undefined;
          if (panel.status === "rejected") throw panel.reason;
          const result = {
            ...panel.value,
            ...(externalReviews ? {
              externalReports: external.status === "fulfilled" ? external.value : [],
              externalFailures: external.status === "rejected"
                ? [externalError instanceof Error ? externalError.message : String(externalError)]
                : [],
            } : {}),
          };
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
