import type { NestedSessionEvent } from "./nested-session.js";

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
      readonly kind: "tool";
      readonly message: string;
      readonly toolName: string;
      readonly toolCallId: string;
      readonly toolCount?: never;
    }
  | {
      readonly kind: "child";
      readonly message: string;
      readonly toolName: string;
      readonly toolCallId: string;
      readonly child: NestedSessionEvent;
      readonly toolCount?: never;
    }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly toolCount?: never;
    };

function boundedText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}… [truncated]` : value;
}

interface ToolCallBlock {
  readonly type: "toolCall";
  readonly id: string;
  readonly name: string;
  readonly arguments?: unknown;
}

function toolCallBlock(value: unknown): value is ToolCallBlock {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ToolCallBlock>;
  return candidate.type === "toolCall"
    && typeof candidate.id === "string"
    && typeof candidate.name === "string";
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function visibleToolMessage(tool: ToolCallBlock): string {
  const input = record(tool.arguments);
  if (tool.name === "automode_panel") {
    const context = record(input.context);
    const kind = typeof input.kind === "string" ? input.kind : "panel";
    const round = Number.isInteger(context.round) ? ` · round ${String(context.round)}` : "";
    return `${tool.name} · ${kind}${round}`;
  }
  const label = typeof input.name === "string" && input.name.trim()
    ? input.name.trim()
    : typeof input.id === "string" && input.id.trim()
      ? input.id.trim()
      : "child session";
  return `${tool.name} · ${label}`;
}

function visibleTool(tool: ToolCallBlock): boolean {
  return tool.name === "automode_panel" || tool.name.startsWith("subagent_");
}

function nativeSubagentStarted(tool: ToolCallBlock): TicketTranscriptActivity | undefined {
  if (tool.name !== "subagent_spawn") return undefined;
  const input = record(tool.arguments);
  const label = typeof input.name === "string" && input.name.trim()
    ? input.name.trim()
    : "Subagent";
  const initialPrompt = typeof input.prompt === "string" ? boundedText(input.prompt, 8_000) : "Prompt unavailable";
  return {
    kind: "child",
    message: `${label} started`,
    toolCallId: tool.id,
    toolName: tool.name,
    child: {
      type: "started",
      id: tool.id,
      source: "subagent",
      label,
      ...(typeof input.harness === "string" ? { harness: input.harness } : {}),
      ...(typeof input.model === "string" ? { model: input.model } : {}),
      initialPrompt,
    },
  };
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
  const toolCalls = content.filter(toolCallBlock);
  const visibleTools = toolCalls.filter(visibleTool);
  const ordinaryToolCount = toolCalls.length - visibleTools.length;
  const collapsedActivities = ordinaryToolCount === 0
    ? activities
    : activities.length === 1 && (activities[0]!.kind === "assistant" || activities[0]!.kind === "thinking")
      ? [{ ...activities[0]!, toolCount: ordinaryToolCount }]
      : [...activities, {
          kind: "tools" as const,
          message: `+ ${ordinaryToolCount} tool ${ordinaryToolCount === 1 ? "call" : "calls"}`,
          toolCount: ordinaryToolCount,
        }];
  const visibleActivities: TicketTranscriptActivity[] = visibleTools.map((tool) => ({
    kind: "tool",
    message: visibleToolMessage(tool),
    toolCallId: tool.id,
    toolName: tool.name,
  }));
  const nativeChildren = visibleTools.flatMap((tool) => {
    const child = nativeSubagentStarted(tool);
    return child ? [child] : [];
  });
  return [...collapsedActivities, ...visibleActivities, ...nativeChildren];
}
