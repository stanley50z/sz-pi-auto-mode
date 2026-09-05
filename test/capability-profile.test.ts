import { TEST_MAIN_EXECUTION } from "./execution-fixture.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAutomodeCapabilityProfile, parsePiExecutionProfile } from "../src/capability-profile.js";

function writeSkill(root: string, name: string): void {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill.\n---\n`);
}

test("the capability profile preloads every Automode Stage Skill and fixed controlled surface", () => {
  const profile = createAutomodeCapabilityProfile({ mainExecution: TEST_MAIN_EXECUTION });

  assert.deepEqual(
    profile.skills.filter((skill) => skill.kind === "stage").map(({ name, owner }) => [name, owner]),
    [
      ["triage", "automode"],
      ["grilling", "automode"],
      ["prototype", "automode"],
      ["implement", "automode"],
      ["tdd", "automode"],
      ["code-review", "automode"],
    ],
  );
  assert.deepEqual(profile.tools, ["read", "bash", "edit", "write", "grep", "find", "ls"]);
  assert.deepEqual(profile.extensionCommands, ["fast"]);
  assert.deepEqual(profile.prompts, []);
  assert.deepEqual(profile.settings, {
    defaultThinkingLevel: "high",
    enableSkillCommands: true,
    defaultProjectTrust: "never",
  });
  assert.deepEqual(profile.ordinaryTicketExecution, {
    harness: "pi",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoning: "high",
  });
  assert.deepEqual(profile.panelExecutions, [
    { harness: "pi", provider: "openai-codex", model: "gpt-6-astra", reasoning: "high" },
    { harness: "pi", provider: "github-copilot", model: "claude-fable-5", reasoning: "high" },
    { harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "high" },
  ]);
});

test("workers and an additional Panel seat inherit a distinct Main Session execution", () => {
  const mainExecution = parsePiExecutionProfile(JSON.stringify({
    harness: "pi", provider: "custom", model: "other-model", reasoning: "max",
  }));
  const profile = createAutomodeCapabilityProfile({ mainExecution });
  assert.deepEqual(profile.ordinaryTicketExecution, {
    harness: "pi", provider: "custom", model: "other-model", reasoning: "max",
  });
  assert.deepEqual(profile.panelExecutions, [
    { harness: "pi", provider: "openai-codex", model: "gpt-6-astra", reasoning: "high" },
    { harness: "pi", provider: "github-copilot", model: "claude-fable-5", reasoning: "high" },
    { harness: "pi", provider: "custom", model: "other-model", reasoning: "max" },
  ]);
});

for (const [provider, model] of [
  ["openai-codex", "gpt-6-astra"],
  ["github-copilot", "claude-fable-5"],
] as const) {
  test(`the Panel does not duplicate ${provider}/${model} for different reasoning`, () => {
    const profile = createAutomodeCapabilityProfile({
      mainExecution: { harness: "pi", provider, model, reasoning: "low" },
    });
    assert.equal(profile.ordinaryTicketExecution.reasoning, "low");
    assert.deepEqual(profile.panelExecutions, [
      { harness: "pi", provider: "openai-codex", model: "gpt-6-astra", reasoning: "high" },
      { harness: "pi", provider: "github-copilot", model: "claude-fable-5", reasoning: "high" },
    ]);
  });
}

test("the same model ID on another provider is a distinct Panel execution", () => {
  const profile = createAutomodeCapabilityProfile({
    mainExecution: { harness: "pi", provider: "custom", model: "gpt-6-astra", reasoning: "off" },
  });
  assert.equal(profile.panelExecutions.length, 3);
  assert.deepEqual(profile.panelExecutions[2], {
    harness: "pi", provider: "custom", model: "gpt-6-astra", reasoning: "off",
  });
});

test("execution serialization preserves every Pi thinking level and rejects missing or invalid levels", () => {
  for (const reasoning of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    const execution = { harness: "pi", provider: "custom", model: "other", reasoning };
    assert.deepEqual(parsePiExecutionProfile(JSON.stringify(execution)), execution);
  }
  for (const reasoning of [undefined, null, "invalid", 1]) {
    assert.throws(() => parsePiExecutionProfile(JSON.stringify({
      harness: "pi", provider: "custom", model: "other", reasoning,
    })), /invalid/);
  }
});

test("the capability profile keeps Matt Pocock skills native and adds installed global allowlist entries", () => {
  const globalSkillRoot = mkdtempSync(join(tmpdir(), "automode-global-skills-"));
  writeSkill(globalSkillRoot, "browser-harness");
  writeSkill(globalSkillRoot, "unslop");
  writeSkill(globalSkillRoot, "ambient-global");
  const profile = createAutomodeCapabilityProfile({ mainExecution: TEST_MAIN_EXECUTION, globalSkillRoot });

  assert.deepEqual(
    profile.skills.filter((skill) => skill.kind === "shared").map((skill) => skill.name),
    [
      "wayfinder",
      "to-spec",
      "to-tickets",
      "domain-modeling",
      "research",
      "codebase-design",
      "commit",
      "resolving-merge-conflicts",
      "handoff",
      "setup-matt-pocock-skills",
    ],
  );
  assert.ok(profile.skills.filter((skill) => skill.kind === "shared").every((skill) => skill.owner === "native"));
  assert.deepEqual(
    profile.skills.filter((skill) => skill.kind === "support").map(({ name, owner }) => [name, owner]),
    [
      ["ketch", "native"],
      ["diagnosing-bugs", "native"],
      ["writing-for-agents", "native"],
      ["wizard", "native"],
      ["browser-harness", "global"],
      ["unslop", "global"],
    ],
  );
  assert.equal(profile.skills.some((skill) => skill.name === "ambient-global"), false);
  assert.equal(profile.skills.some((skill) => skill.name === "openwiki"), false);
});
