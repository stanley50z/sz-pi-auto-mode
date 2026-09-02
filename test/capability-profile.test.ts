import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAutomodeCapabilityProfile } from "../src/capability-profile.js";

function writeSkill(root: string, name: string): void {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill.\n---\n`);
}

test("the capability profile preloads every Automode Stage Skill and fixed controlled surface", () => {
  const profile = createAutomodeCapabilityProfile();

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
    { harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "high" },
    { harness: "pi", provider: "github-copilot", model: "claude-fable-5", reasoning: "high" },
  ]);
});

test("the capability profile keeps Matt Pocock skills native and adds installed global allowlist entries", () => {
  const globalSkillRoot = mkdtempSync(join(tmpdir(), "automode-global-skills-"));
  writeSkill(globalSkillRoot, "browser-harness");
  writeSkill(globalSkillRoot, "unslop");
  writeSkill(globalSkillRoot, "ambient-global");
  const profile = createAutomodeCapabilityProfile({ globalSkillRoot });

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
