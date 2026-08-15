import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

test("normal Pi publicly discovers only the package Bridge while retaining normal session boundaries", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-normal-discovery-"));
  const repository = join(fixture, "repository");
  const agentDir = join(fixture, "normal-agent");
  mkdirSync(join(repository, ".git"), { recursive: true });

  const services = await createAgentSessionServices({
    cwd: repository,
    agentDir,
    resourceLoaderOptions: { additionalExtensionPaths: [process.cwd()] },
  });
  const result = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.create(repository, join(agentDir, "sessions")),
    model: getBuiltinModel("openai-codex", "gpt-5.6-sol"),
  });

  try {
    const packageCommands = result.extensionsResult.runtime.getCommands().filter((command) =>
      relative(process.cwd(), command.sourceInfo.path).startsWith("..") === false
    );
    assert.deepEqual(packageCommands.map((command) => [command.name, command.source]), [
      ["automode", "extension"],
    ]);
    assert.deepEqual(result.session.getActiveToolNames(), ["read", "bash", "edit", "write"]);
    assert.equal(
      services.resourceLoader.getSkills().skills.some((skill) =>
        relative(process.cwd(), skill.filePath).startsWith("..") === false
      ),
      false,
    );
    assert.equal(
      services.resourceLoader.getPrompts().prompts.some((prompt) =>
        relative(process.cwd(), prompt.filePath).startsWith("..") === false
      ),
      false,
    );
    assert.equal(services.settingsManager.getDefaultThinkingLevel(), undefined);
    assert.ok(result.session.sessionFile?.startsWith(join(agentDir, "sessions")));
    assert.equal(services.agentDir, agentDir);
    assert.deepEqual(result.session.scopedModels, []);
  } finally {
    result.session.dispose();
  }
});
