import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { AutomodeTicketSessionHost } from "../src/ticket-session.js";
import { createMainSessionRuntime } from "../src/session.js";
import { createAutomodeCapabilityProfile } from "../src/capability-profile.js";
import { CliPanelProcessLauncher } from "../src/panel-process.js";
import { createPanelSeats } from "../src/panel-runtime.js";
import { createAutomationStageConfiguration } from "../src/stage-configuration.js";

// Exercises real SDK construction, worker IPC/resume, and reviewer CLI against a deterministic provider.
test("workers inherit live Main Session settings across dispatch and resume; the extra reviewer uses them too", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-inherited-execution-"));
  const repository = join(fixture, "repository");
  const normalAgentDir = join(fixture, "normal-agent");
  mkdirSync(join(repository, ".git"), { recursive: true });
  mkdirSync(normalAgentDir);
  const requests: Array<{
    model: string;
    reasoning_effort?: string;
    messages: unknown[];
    tools?: Array<{ function: { name: string } }>;
  }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body: typeof requests[number] = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    const worker = body.tools?.some((tool) => tool.function.name === "automode_ticket_result");
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const delta = worker ? {
      role: "assistant",
      tool_calls: [{ index: 0, id: `result-${requests.length}`, type: "function", function: {
        name: "automode_ticket_result",
        arguments: JSON.stringify({ status: "waiting", summary: "Deterministic execution proof." }),
      } }],
    } : { role: "assistant", content: "No actionable findings." };
    response.end(`data: ${JSON.stringify({
      id: `response-${requests.length}`, object: "chat.completion.chunk", model: body.model,
      choices: [{ index: 0, delta, finish_reason: worker ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}\n\ndata: [DONE]\n\n`);
  });
  // OS-assigned loopback port, not a new fixed project port.
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  writeFileSync(join(normalAgentDir, "models.json"), JSON.stringify({ providers: {
    "inheritance-proof": {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "test-only",
      models: [{ id: "first", reasoning: true }, { id: "second", reasoning: true }],
    },
  } }));
  const runtime = await createMainSessionRuntime({
    cwd: repository, home: fixture, normalAgentDir, skillPaths: [], systemPrompt: "Main Session proof.",
    execution: { harness: "pi", provider: "inheritance-proof", model: "first", reasoning: "low" },
  });
  const oldPackage = process.env.AUTOMODE_PI_PACKAGE_DIR;
  const oldLoader = process.env.AUTOMODE_PI_RUNTIME_LOADER;
  process.env.AUTOMODE_PI_PACKAGE_DIR = getPackageDir();
  process.env.AUTOMODE_PI_RUNTIME_LOADER = pathToFileURL(resolve("dist/src/pi-runtime-loader.js")).href;
  let active: Awaited<ReturnType<AutomodeTicketSessionHost["start"]>> | undefined;
  try {
    assert.equal(runtime.session.model?.id, "first");
    assert.equal(runtime.session.thinkingLevel, "low");
    const getMainExecution = () => {
      const model = runtime.session.model!;
      return { harness: "pi" as const, provider: model.provider, model: model.id, reasoning: runtime.session.thinkingLevel };
    };
    const host = new AutomodeTicketSessionHost({
      repository, home: fixture, normalAgentDir, getMainExecution,
      configuration: createAutomationStageConfiguration("half", ["auto-triage"]),
    });
    const item = {
      kind: "issue" as const, number: 17, url: "https://github.com/owner/repository/issues/17",
      title: "Execution proof", state: "open" as const, labels: ["needs-triage"],
      assignees: [], blockedBy: [], materialVersion: "1",
    };
    active = await host.start({ item, stage: "auto-triage", skillName: "triage", attempt: 1 });
    assert.deepEqual(await active.completion, { status: "waiting", summary: "Deterministic execution proof." });
    const first = active;
    const secondModel = runtime.services.modelRuntime.getModel("inheritance-proof", "second");
    assert.ok(secondModel);
    await runtime.session.setModel(secondModel);
    runtime.session.setThinkingLevel("medium");
    active = await host.start({
      item, stage: "auto-triage", skillName: "triage", attempt: 2,
      resumeSessionFile: first.sessionFile, resumeSessionId: first.sessionId,
    });
    assert.equal(active.sessionId, first.sessionId);
    assert.deepEqual(await active.completion, { status: "waiting", summary: "Deterministic execution proof." });
    const profile = createAutomodeCapabilityProfile({ mainExecution: getMainExecution() });
    const seats = createPanelSeats(profile.panelExecutions);
    assert.equal(seats.length, 3);
    assert.deepEqual(seats[2], {
      seat: "seat-3", harness: "pi", providerSlug: "inheritance-proof", modelSlug: "second", reasoningLevel: "medium",
    });
    const reviewer = new CliPanelProcessLauncher({ cwd: repository, normalAgentDir, piPackageDir: getPackageDir() });
    const review = await reviewer.launch({
      kind: "review", attribution: seats[2]!, tools: ["read"], prompt: "Review this deterministic fixture. Return a short Markdown report.",
      context: { round: 1, headSha: "abcdef1234567890", brief: "Deterministic execution proof." },
    });
    assert.equal(review.exitCode, 0, review.stderr);
    assert.equal(review.stdout, "No actionable findings.");
    assert.deepEqual(requests.map(({ model, reasoning_effort }) => ({ model, reasoning_effort })), [
      { model: "first", reasoning_effort: "low" },
      { model: "second", reasoning_effort: "medium" },
      { model: "second", reasoning_effort: "medium" },
    ]);
    assert.ok(requests[1]!.messages.length > requests[0]!.messages.length, "resumed worker retains its prior context");
  } finally {
    await active?.terminate(true);
    runtime.session.dispose();
    if (oldPackage === undefined) delete process.env.AUTOMODE_PI_PACKAGE_DIR;
    else process.env.AUTOMODE_PI_PACKAGE_DIR = oldPackage;
    if (oldLoader === undefined) delete process.env.AUTOMODE_PI_RUNTIME_LOADER;
    else process.env.AUTOMODE_PI_RUNTIME_LOADER = oldLoader;
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    rmSync(fixture, { recursive: true, force: true });
  }
});
