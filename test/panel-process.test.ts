import assert from "node:assert/strict";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CliPanelProcessLauncher,
  type PanelCommandRunner,
} from "../src/panel-process.js";
import type { PanelSeatLaunchRequest } from "../src/panel-runtime.js";

const answer = { answers: [{ questionNumber: 1, proposedAnswer: "A" }] };
const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function request(harness: "pi" | "claude-code"): PanelSeatLaunchRequest {
  return {
    kind: "grilling",
    attribution: {
      seat: harness === "pi" ? "seat-1" : "seat-3",
      harness,
      providerSlug: harness === "pi" ? "openai-codex" : "anthropic",
      modelSlug: harness === "pi" ? "gpt-5.6-sol" : "claude-fable-5",
      reasoningLevel: "high",
    },
    context: {
      userPrompts: ["Decide."],
      priorRounds: [],
      priorFinalAnswers: [],
      round: { number: 1, questions: [{ number: 1, question: "Proceed?" }] },
    },
    prompt: "return structured JSON",
    tools: ["read", "grep", "find", "ls"],
  };
}

test("the production launcher runs controlled Pi and Claude Code seats with exact profiles", async () => {
  const calls: Array<{ command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
  const runner: PanelCommandRunner = {
    async run(command, args, cwd, env) {
      calls.push({ command, args, cwd, env });
      if (args.includes("--mode")) {
        return {
          exitCode: 0,
          signal: null,
          stderr: "",
          stdout: `${JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: JSON.stringify(answer) }],
              usage: {
                input: 1_200,
                output: 80,
                cacheRead: 900,
                cacheWrite: 0,
                totalTokens: 2_180,
                cost: { input: 0.0012, output: 0.0008, cacheRead: 0.00009, cacheWrite: 0, total: 0.00209 },
              },
            },
          })}\n`,
        };
      }
      return {
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout: JSON.stringify({ result: JSON.stringify(answer), is_error: false }),
      };
    },
  };
  const piPackageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../node_modules/@earendil-works/pi-coding-agent");
  const launcher = new CliPanelProcessLauncher({
    cwd: "C:/repository",
    normalAgentDir: "C:/normal-agent",
    piPackageDir,
    runner,
  });

  const pi = await launcher.launch(request("pi"));
  const claude = await launcher.launch(request("claude-code"));

  assert.deepEqual(JSON.parse(pi.stdout), answer);
  assert.deepEqual(pi.usage, {
    input: 1_200,
    output: 80,
    cacheRead: 900,
    cacheWrite: 0,
    totalTokens: 2_180,
    cost: { input: 0.0012, output: 0.0008, cacheRead: 0.00009, cacheWrite: 0, total: 0.00209 },
  });
  assert.deepEqual(JSON.parse(claude.stdout), answer);
  assert.equal(calls[0]!.command, process.execPath);
  assert.equal(calls[0]!.args[0], resolve(piPackageDir, "dist/bundle/cli.js"));
  assert.deepEqual(calls[0]!.args.slice(1, 9), [
    "--mode", "json", "-p", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
  ]);
  assert.ok(calls[0]!.args.includes("openai-codex"));
  assert.ok(calls[0]!.args.includes("gpt-5.6-sol"));
  assert.equal(calls[0]!.env.PI_CODING_AGENT_DIR, resolve("C:/normal-agent"));
  assert.deepEqual(calls[1]!.args.slice(0, 7), [
    "--safe-mode", "--model", "claude-fable-5", "--effort", "high", "--print", "--output-format",
  ]);
  assert.ok(calls[1]!.args.includes("Read,Grep,Glob"));
});

test("the production launcher preserves Claude Code review usage and calculated cost", async () => {
  const report = "No actionable findings.";
  const runner: PanelCommandRunner = {
    async run() {
      return {
        exitCode: 0,
        signal: null,
        stderr: "",
        stdout: JSON.stringify({
          result: report,
          is_error: false,
          total_cost_usd: 0.1234,
          usage: {
            input_tokens: 1_000,
            output_tokens: 100,
            cache_read_input_tokens: 800,
            cache_creation_input_tokens: 50,
          },
        }),
      };
    },
  };
  const piPackageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../node_modules/@earendil-works/pi-coding-agent");
  const launcher = new CliPanelProcessLauncher({
    cwd: "C:/repository",
    normalAgentDir: "C:/normal-agent",
    piPackageDir,
    runner,
  });

  const result = await launcher.launch({
    kind: "review",
    attribution: {
      seat: "seat-2",
      harness: "claude-code",
      providerSlug: "anthropic",
      modelSlug: "claude-fable-5",
      reasoningLevel: "high",
    },
    context: {
      round: 1,
      headSha: "cf410a3438",
      brief: "Review the exact pull-request diff.",
    },
    prompt: "Return a Markdown review.",
    tools: ["read", "grep", "find", "ls"],
  });

  assert.equal(result.stdout, report);
  assert.deepEqual(result.usage, {
    input: 1_000,
    output: 100,
    cacheRead: 800,
    cacheWrite: 50,
    totalTokens: 1_950,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1234 },
  });
});

test("the production launcher preserves and streams a reviewer's Markdown activity", async () => {
  const report = [
    "## Findings",
    "",
    "**[P1] Reconcile after provider-registry changes**",
    "",
    "`src/usage/SubscriptionUsage.ts:476-479` publishes a stale snapshot.",
  ].join("\n");
  const streamed = [
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Inspecting the route" },
          { type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/route.ts" } },
          { type: "toolCall", id: "grep-1", name: "grep", arguments: { pattern: "mtime" } },
        ],
        usage: zeroUsage,
      },
    }),
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: report }], usage: zeroUsage },
    }),
  ].join("\n") + "\n";
  const runner: PanelCommandRunner = {
    async run(_command, _args, _cwd, _env, onStdout) {
      onStdout?.(streamed.slice(0, 80));
      onStdout?.(streamed.slice(80));
      return { exitCode: 0, signal: null, stderr: "", stdout: streamed };
    },
  };
  const piPackageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../node_modules/@earendil-works/pi-coding-agent");
  const launcher = new CliPanelProcessLauncher({
    cwd: "C:/repository",
    normalAgentDir: "C:/normal-agent",
    piPackageDir,
    runner,
  });

  const activity: unknown[] = [];
  const result = await launcher.launch({
    kind: "review",
    attribution: {
      seat: "seat-1",
      harness: "pi",
      providerSlug: "openai-codex",
      modelSlug: "gpt-5.6-sol",
      reasoningLevel: "high",
    },
    context: {
      round: 1,
      headSha: "cf410a3438",
      brief: "Review provider reconciliation against the requirement that registry changes appear immediately. Inspect the exact diff and test evidence; report only introduced defects.",
    },
    prompt: "Return a Markdown review.",
    tools: ["read", "grep", "find", "ls"],
    onActivity: (entry) => activity.push(entry),
  });

  assert.equal(result.stdout, report);
  assert.deepEqual(activity, [
    { kind: "thinking", message: "Inspecting the route", toolCount: 2 },
    { kind: "assistant", message: report },
  ]);
});
