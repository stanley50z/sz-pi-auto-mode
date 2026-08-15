import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function bundled(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

test("bundled Wayfinder guidance uses the canonical map sections", () => {
  const tracker = bundled("skills/native/setup-matt-pocock-skills/issue-tracker-github.md");
  assert.match(
    tracker,
    /Destination \/ Notes \/ Decisions-so-far \/ Not-yet-specified \/ Out-of-scope sections/,
  );
  assert.doesNotMatch(tracker, /Notes \/ Decisions-so-far \/ Fog body/);
});

test("bundled triage guidance routes human judgment and action to ready-for-human", () => {
  const labels = bundled("skills/native/setup-matt-pocock-skills/triage-labels.md");
  const triage = bundled("skills/native/triage/SKILL.md");
  assert.match(labels, /Requires human implementation, judgment, or action/);
  assert.match(triage, /needs human implementation, judgment, or action/);
});
