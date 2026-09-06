import { TEST_MAIN_EXECUTION } from "./execution-fixture.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { createCapabilitySession } from "../src/capability-session.js";
import { resolveAutomodePaths } from "../src/paths.js";

const repository = realpathSync(process.cwd());
test("a controlled capability session exposes every pre-attested Stage capability", async () => {
  const home = mkdtempSync(join(tmpdir(), "automode-capability-"));
  const controlled = await createCapabilitySession({
    mainExecution: TEST_MAIN_EXECUTION,
    cwd: repository,
    home,
    model: getBuiltinModel("openai-codex", "gpt-5.6-sol"),
  });

  try {
    const commands = controlled.extensionsResult.runtime.getCommands();
    assert.deepEqual(
      commands.map((command) => command.name),
      [...controlled.profile.extensionCommands, ...controlled.profile.skills.map((skill) => `skill:${skill.name}`)],
    );
    assert.deepEqual(
      commands.filter((command) => command.source === "extension").map((command) => ({
        name: command.name,
        path: command.sourceInfo.path,
      })),
      [{ name: "fast", path: "<inline:automode-openai-fast-mode>" }],
    );
    for (const skill of controlled.profile.skills) {
      const command = commands.find((entry) => entry.name === `skill:${skill.name}`);
      assert.ok(command);
      assert.equal(command.source, "skill");
      assert.equal(relative(skill.sourceRoot, command.sourceInfo.path).startsWith(".."), false);
      assert.equal(command.sourceInfo.scope, "temporary");
    }

    assert.deepEqual(controlled.session.getActiveToolNames(), controlled.profile.tools);
    assert.deepEqual(controlled.services.resourceLoader.getPrompts().prompts, []);
    assert.deepEqual(controlled.services.resourceLoader.getThemes().themes, []);
    assert.equal(controlled.services.settingsManager.getDefaultThinkingLevel(), "high");
    assert.equal(controlled.services.settingsManager.getEnableSkillCommands(), true);
    assert.equal(controlled.services.settingsManager.getDefaultProjectTrust(), "never");
    assert.equal(controlled.session.model?.provider, "openai-codex");
    assert.equal(controlled.session.model?.id, "gpt-5.6-sol");
    assert.equal(controlled.session.thinkingLevel, "high");
    const sessionIdentity = controlled.session.agent.state.systemPrompt.split("\n", 1)[0]!;
    assert.match(sessionIdentity, /Automode Capability Attestation Session/);
    assert.doesNotMatch(sessionIdentity, /Ticket Session/);
    assert.deepEqual(controlled.session.scopedModels.map(({ model, thinkingLevel }) => ({
      provider: model.provider,
      model: model.id,
      thinkingLevel,
    })), [{ provider: "openai-codex", model: "gpt-5.6-sol", thinkingLevel: "high" }]);

    const contextPaths = controlled.services.resourceLoader.getAgentsFiles().agentsFiles.map((file) =>
      relative(repository, file.path).replaceAll("\\", "/")
    );
    assert.deepEqual(contextPaths, [
      "AGENTS.md",
      "CONTEXT.md",
      "docs/agents/issue-tracker.md",
      "docs/agents/triage-labels.md",
      "docs/agents/domain.md",
      "openwiki/quickstart.md",
    ]);
    assert.ok(controlled.session.sessionFile?.startsWith(join(home, ".pi", "automode")));
    assert.equal(controlled.services.agentDir.startsWith(join(home, ".pi", "automode")), true);
  } finally {
    controlled.session.dispose();
  }
});

test("a controlled capability session exposes snapshotted allowlisted global skills", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-global-capability-"));
  const globalSkillRoot = join(fixture, "global-skills");
  for (const name of ["browser-harness", "unslop", "ambient-global"]) {
    const skillRoot = join(globalSkillRoot, name);
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      `---\nname: ${name}\ndescription: Test global skill.\n---\n`,
    );
  }

  const controlled = await createCapabilitySession({
    mainExecution: TEST_MAIN_EXECUTION,
    cwd: repository,
    home: fixture,
    globalSkillRoot,
    model: getBuiltinModel("openai-codex", "gpt-5.6-sol"),
  });
  try {
    const commands = controlled.extensionsResult.runtime.getCommands();
    assert.equal(commands.some((command) => command.name === "skill:browser-harness"), true);
    assert.equal(commands.some((command) => command.name === "skill:unslop"), true);
    assert.equal(commands.some((command) => command.name === "skill:ambient-global"), false);
  } finally {
    controlled.session.dispose();
  }
});

test("global guidance enters the controlled session without ambient user or project executable resources", async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-ambient-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const isolatedRepository = join(fixture, "repository");
  const home = join(fixture, "home");
  mkdirSync(join(isolatedRepository, ".git"), { recursive: true });
  writeFileSync(join(isolatedRepository, "AGENTS.md"), "# Controlled repository guidance\n");
  const normalAgentDir = join(home, "configured-normal-pi");
  mkdirSync(normalAgentDir, { recursive: true });
  writeFileSync(join(normalAgentDir, "AGENTS.md"), "Close every browser tab opened for the task.\nRead `optional-not-loaded.md` when relevant.\n", "utf8");
  writeFileSync(join(normalAgentDir, "CLAUDE.md"), "SHADOWED_GLOBAL_GUIDANCE", "utf8");
  writeFileSync(join(fixture, "AGENTS.md"), "AMBIENT_PARENT_GUIDANCE", "utf8");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "AGENTS.md"), "WRONG_GLOBAL_ROOT", "utf8");
  writeFileSync(join(normalAgentDir, "auth.json"), JSON.stringify({
    "proof-credential": { type: "api_key", key: "not-a-real-secret" },
  }));
  const automodePaths = resolveAutomodePaths(isolatedRepository, home, normalAgentDir);
  mkdirSync(automodePaths.automodeDir, { recursive: true });
  writeFileSync(join(automodePaths.automodeDir, "models.json"), JSON.stringify({
    providers: {
      attacker: {
        baseUrl: "http://attacker.invalid",
        api: "openai-completions",
        apiKey: "attacker",
        models: [{ id: "ambient-model" }],
      },
    },
  }));
  for (const root of [
    join(home, ".agents", "skills", "ambient-user"),
    join(isolatedRepository, ".agents", "skills", "ambient-project"),
    join(isolatedRepository, ".pi", "skills", "ambient-pi"),
  ]) {
    mkdirSync(root, { recursive: true });
    const name = root.split(/[\\/]/).at(-1)!;
    writeFileSync(join(root, "SKILL.md"), `---\nname: ${name}\ndescription: Must not load.\n---\nambient\n`);
  }
  mkdirSync(join(isolatedRepository, ".pi", "prompts"), { recursive: true });
  writeFileSync(join(isolatedRepository, ".pi", "prompts", "ambient.md"), "ambient prompt");
  mkdirSync(join(isolatedRepository, ".pi", "extensions"), { recursive: true });
  writeFileSync(
    join(isolatedRepository, ".pi", "extensions", "ambient.js"),
    "export default (pi) => pi.registerCommand('ambient-extension', { handler() {} });\n",
  );

  for (const root of [normalAgentDir, join(isolatedRepository, ".pi")]) {
    mkdirSync(join(root, "extensions"), { recursive: true });
    writeFileSync(join(root, "extensions", "ambient.js"), "throw new Error('Ambient extension executed');\n", "utf8");
    writeFileSync(join(root, "SYSTEM.md"), "AMBIENT_SYSTEM_PROMPT", "utf8");
    writeFileSync(join(root, "APPEND_SYSTEM.md"), "AMBIENT_APPEND_PROMPT", "utf8");
  }

  const controlled = await createCapabilitySession({
    mainExecution: TEST_MAIN_EXECUTION,
    cwd: isolatedRepository,
    home,
    normalAgentDir,
    model: getBuiltinModel("openai-codex", "gpt-5.6-sol"),
  });
  try {
    const prompt = controlled.session.agent.state.systemPrompt;
    assert.match(prompt, /Close every browser tab opened for the task\./);
    assert.match(prompt, /Controlled repository guidance/);
    assert.doesNotMatch(prompt, /SHADOWED_GLOBAL_GUIDANCE|AMBIENT_PARENT_GUIDANCE|WRONG_GLOBAL_ROOT|AMBIENT_SYSTEM_PROMPT|AMBIENT_APPEND_PROMPT/);
    assert.deepEqual(controlled.services.resourceLoader.getAgentsFiles().agentsFiles.map((file) => file.path), [
      realpathSync(join(normalAgentDir, "AGENTS.md")),
      realpathSync(join(isolatedRepository, "AGENTS.md")),
    ]);
    const commandNames = controlled.extensionsResult.runtime.getCommands().map((command) => command.name);
    assert.equal(commandNames.some((name) => name.includes("ambient")), false);
    assert.deepEqual(controlled.services.resourceLoader.getPrompts().prompts, []);
    assert.deepEqual(
      (await controlled.services.modelRuntime.listCredentials()).map((credential) => credential.providerId),
      ["proof-credential"],
    );
    assert.equal(controlled.services.modelRuntime.getModel("attacker", "ambient-model"), undefined);
  } finally {
    controlled.session.dispose();
  }
});

test("global guidance uses Pi file precedence and permits an absent global file", async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-guidance-precedence-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const cwd = join(fixture, "repository");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  writeFileSync(join(cwd, "AGENTS.md"), "PROJECT_INSTRUCTIONS", "utf8");
  const normalAgentDir = join(fixture, "normal-pi");
  mkdirSync(normalAgentDir);
  for (const name of [undefined, "CLAUDE.MD", "CLAUDE.md", "AGENTS.MD", "AGENTS.md", "AGENTS.override.md"]) {
    if (name) writeFileSync(join(normalAgentDir, name), `GLOBAL_SELECTED_${name}`, "utf8");
    const controlled = await createCapabilitySession({
      cwd, home: fixture, normalAgentDir,
      mainExecution: TEST_MAIN_EXECUTION,
      model: getBuiltinModel("openai-codex", "gpt-5.6-sol"),
    });
    try {
      const prompt = controlled.session.agent.state.systemPrompt;
      assert.match(prompt, /PROJECT_INSTRUCTIONS/);
      assert.equal(prompt.match(/GLOBAL_SELECTED_/g)?.length ?? 0, name ? 1 : 0);
      if (name) assert.ok(prompt.includes(`GLOBAL_SELECTED_${name}`));
    } finally {
      controlled.session.dispose();
    }
  }
});

test("an unreadable selected global guidance file fails session creation", async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-guidance-unreadable-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const cwd = join(fixture, "repository");
  const normalAgentDir = join(fixture, "normal-pi");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  mkdirSync(join(normalAgentDir, "AGENTS.md"), { recursive: true });
  writeFileSync(join(normalAgentDir, "CLAUDE.md"), "Must not mask the broken AGENTS.md", "utf8");
  await assert.rejects(() => createCapabilitySession({
    cwd, home: fixture, normalAgentDir,
    mainExecution: TEST_MAIN_EXECUTION,
    model: getBuiltinModel("openai-codex", "gpt-5.6-sol"),
  }), /EISDIR/);
});

test("project executable resources require both explicit trust and an allowlist", async () => {
  const model = getBuiltinModel("openai-codex", "gpt-5.6-sol");
  await assert.rejects(
    () => createCapabilitySession({
      mainExecution: TEST_MAIN_EXECUTION,
      cwd: repository,
      home: mkdtempSync(join(tmpdir(), "automode-untrusted-")),
      model,
      projectResources: {
        trusted: false,
        skillPaths: [join(repository, "skills", "canonical-one")],
      },
    }),
    /explicitly trusted/,
  );
  await assert.rejects(
    () => createCapabilitySession({
      mainExecution: TEST_MAIN_EXECUTION,
      cwd: repository,
      home: mkdtempSync(join(tmpdir(), "automode-shadowed-")),
      model,
      projectResources: {
        trusted: true,
        skillPaths: [join(repository, "skills", "native", "triage")],
      },
    }),
    /Colliding canonical command/,
  );

  const controlled = await createCapabilitySession({
    mainExecution: TEST_MAIN_EXECUTION,
    cwd: repository,
    home: mkdtempSync(join(tmpdir(), "automode-allowlist-")),
    model,
    projectResources: {
      trusted: true,
      skillPaths: [join(repository, "skills", "canonical-one")],
    },
  });
  try {
    assert.ok(controlled.extensionsResult.runtime.getCommands().some((command) => command.name === "skill:canonical-one"));
    assert.equal(controlled.extensionsResult.runtime.getCommands().some((command) => command.name === "skill:canonical-two"), false);
  } finally {
    controlled.session.dispose();
  }
});
