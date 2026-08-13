import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { attestCanonicalCommands } from "../src/attestation.js";

function command(name: string, source: SlashCommandInfo["source"], path: string): SlashCommandInfo {
  return { name, source, sourceInfo: { source: "path", path, scope: "temporary", origin: "top-level" } };
}

test("attests a unique skill from its canonical root", () => {
  const root = mkdtempSync(join(tmpdir(), "automode-attest-"));
  const file = join(root, "SKILL.md");
  writeFileSync(file, "proof");
  const result = attestCanonicalCommands([command("proof", "skill", file)], [{ command: "proof", sourceRoot: root }]);
  assert.equal(result.get("proof")?.sourceInfo.path, file);
});

test("fails closed for missing, collisions, source type, and provenance", () => {
  const root = mkdtempSync(join(tmpdir(), "automode-attest-"));
  const other = mkdtempSync(join(tmpdir(), "automode-other-"));
  const canonical = join(root, "SKILL.md");
  const foreign = join(other, "SKILL.md");
  writeFileSync(canonical, "proof");
  writeFileSync(foreign, "foreign");
  const expected = [{ command: "proof", sourceRoot: root }];

  assert.throws(() => attestCanonicalCommands([], expected), /Missing canonical/);
  assert.throws(() => attestCanonicalCommands([command("proof", "skill", canonical), command("proof", "skill", canonical)], expected), /Colliding canonical/);
  assert.throws(() => attestCanonicalCommands([command("proof", "prompt", canonical)], expected), /Unexpected source/);
  assert.throws(() => attestCanonicalCommands([command("proof", "skill", foreign)], expected), /Unexpected provenance/);
});

test("rejects a collision reported by Pi even after the command registry deduplicates it", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-sdk-collision-"));
  const first = join(fixture, "first");
  const second = join(fixture, "second");
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  writeFileSync(join(first, "SKILL.md"), "---\nname: proof\ndescription: First.\n---\nfirst\n");
  writeFileSync(join(second, "SKILL.md"), "---\nname: proof\ndescription: Second.\n---\nsecond\n");
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: fixture,
    agentDir: join(fixture, "agent"),
    settingsManager,
    additionalSkillPaths: [first, second],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const result = await createAgentSession({
    cwd: fixture,
    agentDir: join(fixture, "agent"),
    model: getBuiltinModel("anthropic", "claude-sonnet-4-5"),
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(fixture),
    noTools: "all",
  });

  try {
    const commands = result.extensionsResult.runtime.getCommands();
    assert.equal(commands.filter((entry) => entry.name === "skill:proof").length, 1);
    assert.throws(
      () => attestCanonicalCommands(commands, [{ command: "skill:proof", sourceRoot: first }], loader.getSkills().diagnostics),
      /Colliding canonical command/,
    );
  } finally {
    result.session.dispose();
  }
});
