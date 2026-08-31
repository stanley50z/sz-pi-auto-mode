import type { Usage } from "@earendil-works/pi-ai";

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function addUsage(left: Usage, right: Usage): Usage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}

function nonNegativeNumber(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${context} must be a non-negative number`);
  }
  return value;
}

export function usageFromSessionStats(stats: {
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
  readonly cost: number;
}): Usage {
  return {
    input: stats.tokens.input,
    output: stats.tokens.output,
    cacheRead: stats.tokens.cacheRead,
    cacheWrite: stats.tokens.cacheWrite,
    totalTokens: stats.tokens.total,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: stats.cost,
    },
  };
}

export function formatUsageSummary(usage: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "cost">): string {
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  return `Input: ${input.toLocaleString("en-US")} tokens; output: ${usage.output.toLocaleString("en-US")} tokens; cached input: ${usage.cacheRead.toLocaleString("en-US")} tokens; calculated cost: $${usage.cost.total.toFixed(4)}.`;
}

export function parseUsage(value: unknown, context: string): Usage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} is missing token usage`);
  }
  const usage = value as Record<string, unknown>;
  if (!usage.cost || typeof usage.cost !== "object" || Array.isArray(usage.cost)) {
    throw new Error(`${context} is missing calculated cost`);
  }
  const cost = usage.cost as Record<string, unknown>;
  return {
    input: nonNegativeNumber(usage.input, `${context} input`),
    output: nonNegativeNumber(usage.output, `${context} output`),
    cacheRead: nonNegativeNumber(usage.cacheRead, `${context} cacheRead`),
    cacheWrite: nonNegativeNumber(usage.cacheWrite, `${context} cacheWrite`),
    totalTokens: nonNegativeNumber(usage.totalTokens, `${context} totalTokens`),
    cost: {
      input: nonNegativeNumber(cost.input, `${context} input cost`),
      output: nonNegativeNumber(cost.output, `${context} output cost`),
      cacheRead: nonNegativeNumber(cost.cacheRead, `${context} cacheRead cost`),
      cacheWrite: nonNegativeNumber(cost.cacheWrite, `${context} cacheWrite cost`),
      total: nonNegativeNumber(cost.total, `${context} total cost`),
    },
  };
}
