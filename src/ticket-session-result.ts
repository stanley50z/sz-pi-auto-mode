import { StringEnum } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface ReportedTicketSessionResult {
  readonly status: "complete" | "waiting";
  readonly summary: string;
  readonly finalDisposition?: string;
}

export interface TicketSessionResultExtension {
  readonly extension: InlineExtension;
  read(): ReportedTicketSessionResult | undefined;
}

export function createTicketSessionResultExtension(options: {
  readonly requireFinalDisposition?: boolean;
} = {}): TicketSessionResultExtension {
  let reported: ReportedTicketSessionResult | undefined;
  const extension: InlineExtension = {
    name: "automode-ticket-result",
    factory(pi) {
      pi.registerTool({
        name: "automode_ticket_result",
        label: "Automode Ticket Result",
        description: "Report the final result exactly once after tracker and repository work is complete, or report waiting after recording a substantive blocker that requires a material tracker update.",
        parameters: Type.Object({
          status: StringEnum(["complete", "waiting"] as const),
          summary: Type.String({ minLength: 1 }),
          finalDisposition: Type.Optional(Type.String({ minLength: 1 })),
        }),
        async execute(_toolCallId, params) {
          if (reported) throw new Error("Ticket Session result was already reported");
          if (params.status === "waiting" && params.finalDisposition !== undefined) {
            throw new Error("A waiting Ticket Session cannot publish a final disposition");
          }
          if (
            options.requireFinalDisposition === true
            && params.status === "complete"
            && !params.finalDisposition?.trim()
          ) throw new Error("A completed Review Session requires its final disposition");
          reported = Object.freeze({
            status: params.status,
            summary: params.summary,
            ...(params.finalDisposition === undefined
              ? {}
              : { finalDisposition: params.finalDisposition.trim() }),
          });
          return {
            content: [{ type: "text", text: `Ticket Session reported ${params.status}.` }],
            details: reported,
            terminate: true,
          };
        },
      });
    },
  };
  return { extension, read: () => reported };
}
