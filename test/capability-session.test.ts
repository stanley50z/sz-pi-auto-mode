import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { createCapabilitySession } from "../src/capability-session.js";
import { resolveAutomodePaths } from "../src/paths.js";
import { createAutomationStageConfiguration } from "../src/stage-configuration.js";

const repository = realpathSync(process.cwd());

const half = createAutomationStageConfiguration("half", ["auto-triage", "auto-review"]);
const full = createAutomationStageConfiguration("full", [
  "auto-triage",
  "auto-grilling",
  "auto-implement",
  "auto-review",
]);

test("a controlled Half-Auto session exposes only the attested capability surface", async () => {
  const home = mkdtempSync(join(tmpdir(), "automode-capability-"));
  const controlled = await createCapabilitySession({
    cwd: repository,
    home,
    configuration: half,
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

test("a controlled Full-Auto session exposes the complete attested capability surface", async () => {
  const home = mkdtempSync(join(tmpdir(), "automode-full-capability-"));
  const controlled = await createCapabilitySession({
    cwd: repository,
    home,
    configuration: full,
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
      if (skill.kind === "stage") assert.equal(skill.owner, "automode");
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

test("ambient user and project executable resources never enter the controlled session", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-ambient-"));
  const isolatedRepository = join(fixture, "repository");
  const home = join(fixture, "home");
  mkdirSync(join(isolatedRepository, ".git"), { recursive: true });
  writeFileSync(join(isolatedRepository, "AGENTS.md"), "# Controlled repository guidance\n");
  const normalAgentDir = join(home, ".pi", "agent");
  mkdirSync(normalAgentDir, { recursive: true });
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

  const controlled = await createCapabilitySession({
    cwd: isolatedRepository,
    home,
    configuration: half,
    model: getBuiltinModel("openai-codex", "gpt-5.6-sol"),
  });
  try {
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

test("project executable resources require both explicit trust and an allowlist", async () => {
  const model = getBuiltinModel("openai-codex", "gpt-5.6-sol");
  await assert.rejects(
    () => createCapabilitySession({
      cwd: repository,
      home: mkdtempSync(join(tmpdir(), "automode-untrusted-")),
      configuration: half,
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
      cwd: repository,
      home: mkdtempSync(join(tmpdir(), "automode-shadowed-")),
      configuration: half,
      model,
      projectResources: {
        trusted: true,
        skillPaths: [join(repository, "skills", "native", "triage")],
      },
    }),
    /Colliding canonical command/,
  );

  const controlled = await createCapabilitySession({
    cwd: repository,
    home: mkdtempSync(join(tmpdir(), "automode-allowlist-")),
    configuration: half,
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
