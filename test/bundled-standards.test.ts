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

test("the Agent Brief is one verification contract shared by every delivery stage", () => {
  const contract = bundled("skills/native/triage/AGENT-BRIEF.md");
  const nativeTriage = bundled("skills/native/triage/SKILL.md");
  const stages = [
    bundled("skills/automode/triage/SKILL.md"),
    bundled("skills/automode/implement/SKILL.md"),
    bundled("skills/automode/code-review/SKILL.md"),
  ];

  assert.match(contract, /## Verification contract/);
  assert.match(contract, /\*\*Predicate:\*\*/);
  assert.match(contract, /\*\*Proof:\*\*/);
  assert.match(contract, /\*\*Evidence:\*\*/);
  assert.match(contract, /Every acceptance\s+criterion maps to at least one proof step/);
  assert.match(contract, /\*\*Dependencies:\*\*/);
  assert.match(contract, /\*\*Human gate:\*\*/);
  assert.match(contract, /\*\*Out of scope:\*\*/);
  assert.match(nativeTriage, /A direct state instruction does not waive the required brief/);
  for (const stage of stages) {
    assert.match(stage, /\.\.\/\.\.\/native\/triage\/AGENT-BRIEF\.md/);
  }
  assert.match(stages[1]!, /Run every applicable proof step/);
  assert.match(stages[2]!, /Re-run every applicable proof step/);
});
