import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startAutomodeMainSession } from "../src/automode-main.js";
import { serializeAutomationStageConfiguration, createAutomationStageConfiguration } from "../src/stage-configuration.js";

test("a fresh Main Session starts in the caller repository and durably records the fixed configuration", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-main-"));
  const repository = join(fixture, "repository");
  const home = join(fixture, "home");
  mkdirSync(join(repository, ".git"), { recursive: true });
  const serializedConfiguration = serializeAutomationStageConfiguration(createAutomationStageConfiguration("half", ["auto-triage", "auto-review"]));

  const main = await startAutomodeMainSession({ repository, home, serializedConfiguration });
  try {
    assert.equal(main.cwd, repository);
    assert.equal(main.sessionName, "Automode Main — Half-Auto");
    assert.deepEqual(main.configuration, {
      mode: "half",
      stages: ["auto-triage", "auto-review"],
    });
    assert.ok(main.sessionFile);
    assert.equal(existsSync(main.sessionFile!), true);
    assert.match(readFileSync(main.sessionFile!, "utf8"), /automode\.stage-configuration/);
    assert.match(readFileSync(main.sessionFile!, "utf8"), /auto-review/);
    assert.deepEqual(await main.tryNewSession(), { cancelled: true });
  } finally {
    main.dispose();
  }
});
