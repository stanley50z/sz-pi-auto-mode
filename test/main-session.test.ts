import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { automodeRunConfigurationGuard, startAutomodeMainSession } from "../src/automode-main.js";
import {
  confirmSerializedAutomationStageConfiguration,
  createAutomationStageConfiguration,
  serializeAutomationStageConfiguration,
} from "../src/stage-configuration.js";

function confirmedConfiguration(
  mode: "full" | "half",
  stages: Parameters<typeof createAutomationStageConfiguration>[1],
) {
  const serializedConfiguration = serializeAutomationStageConfiguration(
    createAutomationStageConfiguration(mode, stages),
  );
  return {
    serializedConfiguration,
    configurationConfirmation: confirmSerializedAutomationStageConfiguration(serializedConfiguration),
  };
}

test("the Automode Run guard cancels Main Session replacement and forking", async () => {
  const handlers = new Map<string, () => unknown>();
  const pi = {
    on(event: string, handler: () => unknown) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  await automodeRunConfigurationGuard.factory(pi);

  assert.deepEqual(await handlers.get("session_before_switch")!(), { cancel: true });
  assert.deepEqual(await handlers.get("session_before_fork")!(), { cancel: true });
});

test("a fresh Main Session starts in the caller repository and durably records the fixed configuration", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-main-"));
  const repository = join(fixture, "repository");
  const home = join(fixture, "home");
  mkdirSync(join(repository, ".git"), { recursive: true });

  const main = await startAutomodeMainSession({
    repository,
    home,
    ...confirmedConfiguration("half", ["auto-triage", "auto-review"]),
  });
  try {
    assert.equal(main.cwd, repository);
    assert.equal(main.sessionName, "Automode Main — Half-Auto");
    assert.deepEqual(main.configuration, {
      mode: "half",
      stages: ["auto-triage", "auto-review"],
    });
    assert.ok(main.sessionFile);
    assert.equal(existsSync(main.sessionFile!), false);
    assert.equal(existsSync(main.configurationFile), true);
    assert.deepEqual(JSON.parse(readFileSync(main.configurationFile, "utf8")), {
      mode: "half",
      stages: ["auto-triage", "auto-review"],
    });
  } finally {
    main.dispose();
  }
});

test("an Automode Run rejects a different configuration on restart", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-fixed-run-"));
  const repository = join(fixture, "repository");
  const home = join(fixture, "home");
  mkdirSync(join(repository, ".git"), { recursive: true });

  const full = confirmedConfiguration(
    "full",
    ["auto-triage", "auto-grilling", "auto-implement", "auto-review"],
  );
  const first = await startAutomodeMainSession({ repository, home, ...full });
  first.dispose();
  const restarted = await startAutomodeMainSession({ repository, home, ...full });
  restarted.dispose();

  await assert.rejects(
    () => startAutomodeMainSession({
      repository,
      home,
      ...confirmedConfiguration("half", ["auto-review"]),
    }),
    /fixed for this Automode Run/,
  );
});
