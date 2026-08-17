import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTOMATION_STAGES,
  confirmSerializedAutomationStageConfiguration,
  createAutomationStageConfiguration,
  parseAutomationStageConfiguration,
  parseConfirmedAutomationStageConfiguration,
  serializeAutomationStageConfiguration,
} from "../src/stage-configuration.js";

test("Full-Auto serializes all four stages into an immutable launch configuration", () => {
  const configuration = createAutomationStageConfiguration("full", AUTOMATION_STAGES);
  const serialized = serializeAutomationStageConfiguration(configuration);
  const launched = parseAutomationStageConfiguration(serialized);

  assert.deepEqual(launched, {
    mode: "full",
    stages: ["auto-triage", "auto-grilling", "auto-implement", "auto-review"],
  });
  assert.equal(Object.isFrozen(launched), true);
  assert.equal(Object.isFrozen(launched.stages), true);
  assert.throws(() => launched.stages.pop(), TypeError);
});

test("Half-Auto permits any non-empty Automation Stage selection, including all four", () => {
  assert.deepEqual(createAutomationStageConfiguration("half", ["auto-implement"]), {
    mode: "half",
    stages: ["auto-implement"],
  });
  assert.deepEqual(createAutomationStageConfiguration("half", ["auto-review", "auto-triage", "auto-grilling"]), {
    mode: "half",
    stages: ["auto-triage", "auto-grilling", "auto-review"],
  });
  assert.deepEqual(createAutomationStageConfiguration("half", AUTOMATION_STAGES), {
    mode: "half",
    stages: ["auto-triage", "auto-grilling", "auto-implement", "auto-review"],
  });
  assert.throws(() => createAutomationStageConfiguration("half", []), /at least one/);
  assert.throws(() => createAutomationStageConfiguration("full", ["auto-triage"]), /all four/);
});

test("the child rejects a serialized configuration changed after confirmation", () => {
  const full = serializeAutomationStageConfiguration(createAutomationStageConfiguration("full", AUTOMATION_STAGES));
  const confirmation = confirmSerializedAutomationStageConfiguration(full);
  assert.equal(confirmation, "1f7e6c2c6fc1a8cab6e05155bc4c25595c58afd16cf3dc969f1d96017d64439a");

  const changed = serializeAutomationStageConfiguration(createAutomationStageConfiguration("half", ["auto-review"]));
  assert.throws(
    () => parseConfirmedAutomationStageConfiguration(changed, confirmation),
    /changed after confirmation/,
  );
});

test("serialized configurations are validated rather than trusted", () => {
  assert.throws(
    () => parseAutomationStageConfiguration('{"mode":"half","stages":[]}'),
    /at least one/,
  );
  assert.throws(
    () => parseAutomationStageConfiguration('{"mode":"full","stages":["auto-triage"]}'),
    /all four/,
  );
});
