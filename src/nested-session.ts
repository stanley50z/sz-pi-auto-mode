export type NestedSessionSource = "panel" | "subagent";

export interface NestedSessionIdentity {
  readonly id: string;
  readonly source: NestedSessionSource;
  readonly label: string;
  readonly harness?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly reasoning?: string;
  readonly headSha?: string;
}

export type NestedSessionTranscriptActivity =
  | {
      readonly kind: "assistant" | "thinking";
      readonly message: string;
      readonly toolCount?: number;
    }
  | {
      readonly kind: "tools";
      readonly message: string;
      readonly toolCount: number;
    }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly toolCount?: never;
    };

export type NestedSessionEvent =
  | (NestedSessionIdentity & {
      readonly type: "started";
      readonly initialPrompt: string;
    })
  | (NestedSessionIdentity & {
      readonly type: "activity";
      readonly activity: NestedSessionTranscriptActivity;
    })
  | (NestedSessionIdentity & {
      readonly type: "settled";
      readonly status: "completed" | "failed";
      readonly message?: string;
    });

export function nestedSessionEventMessage(event: NestedSessionEvent): string {
  if (event.type === "activity") return event.activity.message;
  if (event.type === "started") return `${event.label} started`;
  return `${event.label} ${event.status}${event.message ? `: ${event.message}` : ""}`;
}
