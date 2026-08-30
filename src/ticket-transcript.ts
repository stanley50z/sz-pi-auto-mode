export type TicketTranscriptActivity =
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

function boundedText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}… [truncated]` : value;
}

/** Converts one completed Pi assistant message into ultra-collapsed transcript activity. */
export function createAssistantTranscript(
  content: unknown,
  options: { readonly isError?: boolean; readonly maxMessageLength?: number } = {},
): readonly TicketTranscriptActivity[] {
  if (!Array.isArray(content)) return [];
  const maxLength = options.maxMessageLength ?? 2_000;
  const activities = content.flatMap((block): TicketTranscriptActivity[] => {
    if (!block || typeof block !== "object") return [];
    const candidate = block as { type?: unknown; text?: unknown; thinking?: unknown };
    if (candidate.type === "thinking" && typeof candidate.thinking === "string" && candidate.thinking.trim()) {
      return [{
        kind: "thinking",
        message: boundedText(candidate.thinking.trim(), maxLength),
      }];
    }
    if (candidate.type === "text" && typeof candidate.text === "string" && candidate.text.trim()) {
      return [{
        kind: options.isError ? "error" : "assistant",
        message: boundedText(candidate.text.trim(), maxLength),
      }];
    }
    return [];
  });
  const toolCount = content.filter((block) => (
    !!block && typeof block === "object" && (block as { type?: unknown }).type === "toolCall"
  )).length;
  if (toolCount === 0) return activities;
  if (activities.length === 1 && activities[0]!.kind !== "error") {
    return [{ ...activities[0]!, toolCount }];
  }
  return [...activities, {
    kind: "tools",
    message: `+ ${toolCount} tool ${toolCount === 1 ? "call" : "calls"}`,
    toolCount,
  }];
}
