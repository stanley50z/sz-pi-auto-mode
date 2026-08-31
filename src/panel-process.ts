import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type {
  PanelProcessResult,
  PanelSeatLaunchRequest,
  ProductionPanelProcessLauncher,
} from "./panel-runtime.js";
import { createAssistantTranscript } from "./ticket-transcript.js";
import { addUsage, emptyUsage, parseUsage } from "./usage.js";

const MAX_PANEL_OUTPUT_BYTES = 10 * 1024 * 1024;
const ALLOWED_PI_TOOLS = new Set(["read", "grep", "find", "ls"]);

export interface PanelCommandRunner {
  run(
    command: string,
    args: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    onStdout?: (chunk: string) => void,
  ): Promise<PanelProcessResult>;
}

export const processPanelCommandRunner: PanelCommandRunner = {
  run(command, args, cwd, env, onStdout) {
    return new Promise((resolveResult, rejectResult) => {
      const child = spawn(command, [...args], {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      const collect = (target: Buffer[], chunk: Buffer): void => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_PANEL_OUTPUT_BYTES) {
          child.kill("SIGKILL");
          rejectResult(new Error(`Panel seat output exceeded ${MAX_PANEL_OUTPUT_BYTES} bytes`));
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        collect(stdout, chunk);
        onStdout?.(chunk.toString("utf8"));
      });
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.on("error", rejectResult);
      child.on("exit", (exitCode, signal) => resolveResult({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }));
    });
  },
};

export interface CliPanelProcessLauncherOptions {
  readonly cwd: string;
  readonly normalAgentDir: string;
  readonly piPackageDir: string;
  readonly runner?: PanelCommandRunner;
  readonly env?: NodeJS.ProcessEnv;
}

function parseStructuredText(text: string, context: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error(`${context} returned no structured answer`);
  let value: unknown;
  try {
    value = JSON.parse(trimmed) as unknown;
  } catch (error) {
    throw new Error(`${context} returned invalid JSON`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} structured answer must be an object`);
  }
  return JSON.stringify(value);
}

function normalizePiOutput(output: string, structured: boolean): { stdout: string; usage: ReturnType<typeof emptyUsage> } {
  let finalText: string | undefined;
  let usage = emptyUsage();
  let assistantMessages = 0;
  for (const line of output.split("\n")) {
    if (line.trim().length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error("Pi Panel seat emitted invalid JSONL", { cause: error });
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const record = event as { type?: unknown; message?: unknown };
    if (record.type !== "message_end" || !record.message || typeof record.message !== "object") continue;
    const message = record.message as { role?: unknown; content?: unknown; usage?: unknown };
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    assistantMessages += 1;
    usage = addUsage(usage, parseUsage(message.usage, "Pi Panel seat assistant message"));
    const text = message.content
      .filter((part): part is { type: "text"; text: string } => (
        !!part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        && typeof (part as { text?: unknown }).text === "string"
      ))
      .map((part) => part.text)
      .join("");
    if (text.length > 0) finalText = text;
  }
  if (assistantMessages === 0 || finalText === undefined) {
    throw new Error("Pi Panel seat did not emit a final assistant answer");
  }
  return {
    stdout: structured ? parseStructuredText(finalText, "Pi Panel seat") : finalText,
    usage,
  };
}

function normalizeClaudeOutput(
  output: string,
  structured: boolean,
): { stdout: string; usage?: ReturnType<typeof emptyUsage> } {
  let envelope: unknown;
  try {
    envelope = JSON.parse(output.trim()) as unknown;
  } catch (error) {
    throw new Error("Claude Code Panel seat emitted invalid JSON", { cause: error });
  }
  const records = Array.isArray(envelope) ? envelope : [envelope];
  const result = [...records].reverse().find((entry) => (
    !!entry && typeof entry === "object" && typeof (entry as { result?: unknown }).result === "string"
  )) as Record<string, unknown> | undefined;
  if (!result || typeof result.result !== "string") {
    throw new Error("Claude Code Panel seat did not emit a final assistant answer");
  }
  if (result.is_error === true) throw new Error("Claude Code Panel seat reported an error");
  let usage: ReturnType<typeof emptyUsage> | undefined;
  if (result.usage && typeof result.usage === "object" && !Array.isArray(result.usage)) {
    const raw = result.usage as Record<string, unknown>;
    const number = (value: unknown, field: string): number => {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`Claude Code Panel seat ${field} must be a non-negative number`);
      }
      return value;
    };
    const input = number(raw.input_tokens, "input_tokens");
    const outputTokens = number(raw.output_tokens, "output_tokens");
    const cacheRead = number(raw.cache_read_input_tokens ?? 0, "cache_read_input_tokens");
    const cacheWrite = number(raw.cache_creation_input_tokens ?? 0, "cache_creation_input_tokens");
    const totalCost = number(result.total_cost_usd, "total_cost_usd");
    usage = {
      input,
      output: outputTokens,
      cacheRead,
      cacheWrite,
      totalTokens: input + outputTokens + cacheRead + cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totalCost },
    };
  }
  return {
    stdout: structured ? parseStructuredText(result.result, "Claude Code Panel seat") : result.result,
    ...(usage === undefined ? {} : { usage }),
  };
}

function createPiActivityStream(request: PanelSeatLaunchRequest): {
  push(chunk: string): void;
  finish(): void;
} {
  let buffered = "";
  const emitLine = (line: string): void => {
    if (!line.trim() || !request.onActivity) return;
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) return;
    const record = event as { type?: unknown; message?: unknown };
    if (record.type !== "message_end" || !record.message || typeof record.message !== "object") return;
    const message = record.message as { role?: unknown; content?: unknown; stopReason?: unknown };
    if (message.role !== "assistant") return;
    for (const activity of createAssistantTranscript(message.content, {
      isError: message.stopReason === "error",
    })) {
      if (
        activity.kind === "assistant"
        || activity.kind === "thinking"
        || activity.kind === "tools"
        || activity.kind === "error"
      ) request.onActivity(activity);
    }
  };
  return {
    push(chunk) {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        emitLine(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
      }
    },
    finish() {
      if (buffered.trim()) emitLine(buffered);
      buffered = "";
    },
  };
}

function assertTools(tools: readonly string[]): void {
  if (tools.length === 0 || tools.some((tool) => !ALLOWED_PI_TOOLS.has(tool))) {
    throw new Error("Panel seat requested capabilities outside the controlled advisory tool set");
  }
}

export class CliPanelProcessLauncher implements ProductionPanelProcessLauncher {
  readonly #cwd: string;
  readonly #normalAgentDir: string;
  readonly #piCliEntrypoint: string;
  readonly #runner: PanelCommandRunner;
  readonly #env: NodeJS.ProcessEnv;

  constructor(options: CliPanelProcessLauncherOptions) {
    this.#cwd = resolve(options.cwd);
    this.#normalAgentDir = resolve(options.normalAgentDir);
    this.#piCliEntrypoint = resolve(options.piPackageDir, "dist", "bundle", "cli.js");
    this.#runner = options.runner ?? processPanelCommandRunner;
    this.#env = { ...(options.env ?? process.env), PI_CODING_AGENT_DIR: this.#normalAgentDir };
  }

  async launch(request: PanelSeatLaunchRequest): Promise<PanelProcessResult> {
    assertTools(request.tools);
    if (request.attribution.harness === "pi") {
      const activityStream = createPiActivityStream(request);
      const result = await this.#runner.run(process.execPath, [
        this.#piCliEntrypoint,
        "--mode", "json",
        "-p",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--provider", request.attribution.providerSlug,
        "--model", request.attribution.modelSlug,
        "--thinking", request.attribution.reasoningLevel,
        "--tools", request.tools.join(","),
        request.prompt,
      ], this.#cwd, this.#env, (chunk) => activityStream.push(chunk));
      activityStream.finish();
      if (result.exitCode !== 0 || result.signal !== null) return result;
      return { ...result, ...normalizePiOutput(result.stdout, request.kind === "grilling") };
    }

    const claudeTools = [...new Set(request.tools.map((tool) => {
      if (tool === "read") return "Read";
      if (tool === "grep") return "Grep";
      return "Glob";
    }))];
    const result = await this.#runner.run("claude", [
      "--safe-mode",
      "--model", request.attribution.modelSlug,
      "--effort", request.attribution.reasoningLevel,
      "--print",
      "--output-format", "json",
      "--tools", claudeTools.join(","),
      "--no-session-persistence",
      request.prompt,
    ], this.#cwd, this.#env);
    if (result.exitCode !== 0 || result.signal !== null) return result;
    const normalized = normalizeClaudeOutput(result.stdout, request.kind === "grilling");
    if (request.kind === "review" && !normalized.usage) {
      throw new Error("Claude Code Panel seat did not report token usage and calculated cost");
    }
    if (request.onActivity) {
      request.onActivity({
        kind: "assistant",
        message: normalized.stdout.length > 2_000
          ? `${normalized.stdout.slice(0, 2_000)}… [truncated]`
          : normalized.stdout,
      });
    }
    return { ...result, ...normalized };
  }
}
