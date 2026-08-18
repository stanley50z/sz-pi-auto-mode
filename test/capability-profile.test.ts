import assert from "node:assert/strict";
import test from "node:test";
import { createAutomodeCapabilityProfile } from "../src/capability-profile.js";
const defaultReviewerExecution = {
  harness: "pi",
  provider: "anthropic",
  model: "claude-opus-4-8",
  reasoning: "high",
} as const;

test("the capability profile preloads every Automode Stage Skill and fixed controlled surface", () => {
  const profile = createAutomodeCapabilityProfile(defaultReviewerExecution);

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
    { harness: "pi", provider: "anthropic", model: "claude-opus-4-8", reasoning: "high" },
    { harness: "pi", provider: "github-copilot", model: "claude-fable-5", reasoning: "high" },
    { harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "high" },
  ]);
});

test("the capability profile keeps shared and support skills native", () => {
  const profile = createAutomodeCapabilityProfile(defaultReviewerExecution);

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
    profile.skills.filter((skill) => skill.kind === "support").map((skill) => skill.name),
    ["browser-harness", "ketch", "diagnosing-bugs", "openwiki", "writing-for-agents", "wizard"],
  );
});
