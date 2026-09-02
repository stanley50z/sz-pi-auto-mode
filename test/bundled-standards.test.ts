import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

function bundled(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

test("bundled Matt Pocock setup guidance matches the current global suite", () => {
  const tracker = bundled("skills/native/setup-matt-pocock-skills/issue-tracker-github.md");
  const labels = bundled("skills/native/setup-matt-pocock-skills/triage-labels.md");
  assert.match(tracker, /Notes \/ Decisions-so-far \/ Fog body/);
  assert.match(labels, /Requires human implementation/);
});

test("bundled Ketch includes the installed skill's disclosed references", () => {
  assert.match(bundled("skills/native/ketch/SKILL.md"), /references\/surfaces\.md/);
  assert.equal(existsSync(resolve("skills/native/ketch/references/surfaces.md")), true);
  assert.equal(existsSync(resolve("skills/native/ketch/references/verbs/ketch-research.md")), true);
  assert.equal(existsSync(resolve("skills/native/ketch/references/verbs/setup.md")), true);
});

test("non-native and globally allowlisted skills are not duplicated in the native tree", () => {
  for (const name of ["browser-harness", "openwiki", "prototype", "tdd"]) {
    assert.equal(existsSync(resolve("skills/native", name)), false, name);
  }
});

test("bundled planning skills keep spec parents out of Auto-Implement", () => {
  const toSpec = bundled("skills/native/to-spec/SKILL.md");
  const toTickets = bundled("skills/native/to-tickets/SKILL.md");

  assert.match(toSpec, /spec parent is not an implementation ticket/);
  assert.doesNotMatch(toSpec, /Apply the `ready-for-agent` triage label/);
  assert.match(toTickets, /Create every implementation ticket without `ready-for-agent`/);
  assert.match(toTickets, /Wire the complete graph/);
  assert.match(toTickets, /Read the graph back/);
  assert.match(toTickets, /Apply `ready-for-agent`/);
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
  assert.match(stages[1]!, /When no Agent Brief exists, use an equivalently complete issue discussion/);
  assert.match(stages[2]!, /When no Agent Brief exists, use an equivalently complete issue discussion/);
  assert.match(stages[1]!, /Run every applicable proof step/);
  assert.match(stages[2]!, /Re-run every applicable proof step/);
});

test("Auto-Review publishes commit-pinned GitHub reviews with inline findings", () => {
  const review = bundled("skills/automode/code-review/SKILL.md");

  assert.match(review, /GitHub pull-request review/);
  assert.match(review, /Reviewed commit:/);
  assert.match(review, /POST \/repos\/\{owner\}\/\{repo\}\/pulls\/\{number\}\/reviews/);
  assert.match(review, /`commit_id`/);
  assert.match(review, /`event: "COMMENT"`/);
  assert.match(review, /`path`, `line`, `side: "RIGHT"`, and `body`/);
  assert.match(review, /Post every completed Reviewer report even when another seat failed/);
  assert.match(review, /round, head SHA, and seat/);
  assert.match(review, /`usageSummary`/);
  assert.match(review, /end of the review body/);
  assert.match(review, /`finalDisposition`/);
  assert.match(review, /after the full Review Session settles/);
});
