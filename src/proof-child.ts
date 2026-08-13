import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { parseSkillBlock } from "@earendil-works/pi-coding-agent";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { attestCanonicalCommands } from "./attestation.js";
import { isNormalPiConfigurationKey } from "./environment.js";
import { createIsolatedAutomodeSession } from "./session.js";

interface Invocation {
  name: string;
  arguments: string;
}

let disposeSession: (() => void) | undefined;
process.on("SIGINT", () => {
  disposeSession?.();
  process.exit(130);
});
process.on("SIGTERM", () => {
  disposeSession?.();
  process.exit(143);
});
process.on("SIGHUP", () => {
  disposeSession?.();
  process.exit(1);
});
process.on("message", (message) => {
  if (!message || typeof message !== "object" || !("type" in message) || message.type !== "automode:terminate") return;
  disposeSession?.();
  if (process.connected) process.disconnect();
  const signal = "signal" in message ? message.signal : undefined;
  process.exit(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
});

function emptyAssistantMessage(model: Model<any>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function readInvocation(context: Context): Invocation {
  let message: Extract<Context["messages"][number], { role: "user" }> | undefined;
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const candidate = context.messages[index];
    if (candidate?.role === "user") {
      message = candidate;
      break;
    }
  }
  if (!message) throw new Error("Proof provider received no user message");
  const text = typeof message.content === "string"
    ? message.content
    : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  const skill = parseSkillBlock(text);
  if (!skill) throw new Error("Canonical skill was not expanded through Pi's native invocation path");
  return { name: skill.name, arguments: skill.userMessage ?? "" };
}

function waitForTerminalLine(): Promise<string> {
  const input = createInterface({ input: process.stdin });
  return new Promise((resolve) => {
    input.once("line", (line) => {
      input.close();
      resolve(line);
    });
  });
}

if (process.env.AUTOMODE_HANDOFF_PROOF !== "1") throw new Error("Proof child must be launched by the Automode Bridge");
const cwd = process.argv[2];
if (!cwd) throw new Error("Missing caller repository path");
const normalAgentDir = process.argv[3] || undefined;
const terminalInput = process.env.AUTOMODE_HANDOFF_INPUT === "1" ? await waitForTerminalLine() : undefined;
const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills");
const result = await createIsolatedAutomodeSession({
  cwd,
  skillPaths: [fixtureRoot],
  systemPrompt: "Automode process-handoff proof. Do not access an issue tracker.",
  model: getBuiltinModel("anthropic", "claude-sonnet-4-5"),
  normalAgentDir,
});
disposeSession = () => result.session.dispose();
const expected = ["canonical-one", "canonical-two"].map((name) => ({ command: `skill:${name}`, sourceRoot: join(fixtureRoot, name) }));
const commands = result.extensionsResult.runtime.getCommands();
attestCanonicalCommands(commands, expected, result.session.resourceLoader.getSkills().diagnostics);

const invocations: Invocation[] = [];
result.session.modelRuntime.registerProvider("automode-proof", {
  baseUrl: "http://127.0.0.1/automode-proof",
  api: "automode-proof",
  apiKey: "local-proof-key",
  models: [{
    id: "deterministic",
    name: "Deterministic Automode proof",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 128,
  }],
  streamSimple: (model: Model<any>, context: Context, _options?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    const output = emptyAssistantMessage(model);
    invocations.push(readInvocation(context));
    stream.push({ type: "start", partial: output });
    stream.push({ type: "done", reason: "stop", message: output });
    stream.end();
    return stream;
  },
});
const proofModel = result.session.modelRuntime.getModel("automode-proof", "deterministic");
if (!proofModel) throw new Error("Deterministic proof model was not registered");
await result.session.setModel(proofModel);
await result.session.prompt("/skill:canonical-one first-stage-context");
await result.session.prompt("/skill:canonical-two second-stage-context");

result.session.sessionManager.appendCustomEntry("automode.handoff-proof", { pid: process.pid });
console.log(JSON.stringify({
  cwd,
  pid: process.pid,
  sessionFile: result.session.sessionFile,
  commands: commands.map((command) => command.name),
  commandPaths: commands.map((command) => command.sourceInfo.path),
  activeTools: result.session.getActiveToolNames(),
  credentialProviders: (await result.session.modelRuntime.listCredentials()).map((credential) => credential.providerId).sort(),
  invocations,
  terminalInput,
  settingsDefaultThinkingLevel: result.session.settingsManager.getDefaultThinkingLevel(),
  appendSystemPrompts: result.session.resourceLoader.getAppendSystemPrompt(),
  credentialEnvironmentPresent: process.env.ANTHROPIC_API_KEY === "not-a-real-environment-credential",
  inheritedNormalConfiguration: Object.keys(process.env).filter(isNormalPiConfigurationKey),
}));
result.session.dispose();
if (process.connected) process.disconnect();
