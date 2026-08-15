import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import {
  CliPanelProcessLauncher,
  type PanelCommandRunner,
} from "../src/panel-process.js";
import type { PanelSeatLaunchRequest } from "../src/panel-runtime.js";

const answer = { answers: [{ questionNumber: 1, proposedAnswer: "A" }] };

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
      if (command === "pi") {
        return {
          exitCode: 0,
          signal: null,
          stderr: "",
          stdout: `${JSON.stringify({
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(answer) }] },
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
  const launcher = new CliPanelProcessLauncher({
    cwd: "C:/repository",
    normalAgentDir: "C:/normal-agent",
    runner,
  });

  const pi = await launcher.launch(request("pi"));
  const claude = await launcher.launch(request("claude-code"));

  assert.deepEqual(JSON.parse(pi.stdout), answer);
  assert.deepEqual(JSON.parse(claude.stdout), answer);
  assert.deepEqual(calls[0]!.args.slice(0, 8), [
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
