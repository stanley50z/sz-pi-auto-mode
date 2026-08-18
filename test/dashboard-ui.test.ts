import assert from "node:assert/strict";
import test from "node:test";
import {
  createDashboardProjection,
  createDashboardUiAssets,
} from "../src/dashboard-ui.js";

test("dashboard UI assets expose a loading Stage Lanes shell without inline executable code", () => {
  const assets = createDashboardUiAssets();

  assert.deepEqual(Object.keys(assets).sort(), ["/", "/app.js", "/styles.css"]);
  assert.equal(assets["/"].contentType, "text/html; charset=utf-8");
  assert.match(assets["/"].body, /<title>Automode Dashboard<\/title>/);
  assert.match(assets["/"].body, /Loading Stage Candidates/);
  assert.match(assets["/"].body, /<script src="\/app\.js" defer><\/script>/);
  assert.match(assets["/"].body, /name="automode-snapshot" content="\/api\/snapshot"/);
  assert.match(assets["/"].body, /name="automode-events" content="\/api\/events"/);
  assert.match(assets["/"].body, /name="automode-commands" content="\/api\/commands"/);
  assert.doesNotMatch(assets["/"].body, /<script(?! src=)/);
  assert.equal(assets["/styles.css"].contentType, "text/css; charset=utf-8");
  assert.equal(assets["/app.js"].contentType, "text/javascript; charset=utf-8");
});

test("Coordinator Stage Candidates map to the browser projection without tracker or session reads", () => {
  const projection = createDashboardProjection({
    repository: { name: "sz-pi-auto-mode", url: "https://github.com/stanley50z/sz-pi-auto-mode" },
    run: { id: "run-45", mode: "full", lifecycle: "active" },
  }, {
    lanes: [{
      stage: "auto-triage",
      operatingState: "ON",
      candidates: [{
        item: { kind: "issue", number: 68, url: "https://github.com/example/repository/issues/68" },
        title: "Crash after reopening a linked worktree",
        stage: "auto-triage",
        skillName: "triage",
        status: "queued",
        reason: "Eligible now; waiting for the Coordinator to claim it.",
        attempt: 0,
        session: {
          processId: "process-68",
          sessionId: "session-68",
          sessionFile: "/sessions/68.jsonl",
          workspace: "/worktrees/issue-68",
        },
      }],
      totals: { candidates: 1, active: 0, queued: 1, held: 0, retrying: 0, exhausted: 0 },
    }, {
      stage: "auto-grilling",
      operatingState: "OFF",
      candidates: [],
      totals: { candidates: 0, active: 0, queued: 0, held: 0, retrying: 0, exhausted: 0 },
    }, {
      stage: "auto-implement",
      operatingState: "OFF",
      candidates: [],
      totals: { candidates: 0, active: 0, queued: 0, held: 0, retrying: 0, exhausted: 0 },
    }, {
      stage: "auto-review",
      operatingState: "OFF",
      candidates: [],
      totals: { candidates: 0, active: 0, queued: 0, held: 0, retrying: 0, exhausted: 0 },
    }],
    totals: { candidates: 1, active: 0, queued: 1, held: 0, retrying: 0, exhausted: 0 },
    recent: [{
      item: { kind: "pull-request", number: 61, url: "https://github.com/example/repository/pull/61" },
      title: "Harden tracker snapshot parsing",
      stage: "auto-review",
      skillName: "code-review",
      status: "settled",
      reason: "Fresh tracker verification proved completion.",
      attempt: 1,
      settledAt: "2026-08-17T12:00:00.000Z",
    }, {
      item: { kind: "issue", number: 68, url: "https://github.com/example/repository/issues/68" },
      title: "Crash after reopening a linked worktree",
      stage: "auto-triage",
      skillName: "triage",
      status: "settled",
      reason: "The prior occurrence settled before the item re-entered the lane.",
      attempt: 1,
      settledAt: "2026-08-17T12:01:00.000Z",
    }],
  });

  assert.equal(projection.version, 1);
  assert.deepEqual(projection.lanes[0]?.candidates[0], {
    key: "issue:68:auto-triage",
    itemKey: "issue:68",
    item: "#68",
    title: "Crash after reopening a linked worktree",
    url: "https://github.com/example/repository/issues/68",
    stage: "auto-triage",
    status: "queued",
    reason: "Eligible now; waiting for the Coordinator to claim it.",
    attempt: 0,
    session: {
      processId: "process-68",
      sessionId: "session-68",
      sessionFile: "/sessions/68.jsonl",
      workspace: "/worktrees/issue-68",
      attempts: [],
    },
  });
  assert.deepEqual(projection.recent[0], {
    key: "pull-request:61:auto-review:recent:2026-08-17T12:00:00.000Z",
    itemKey: "pull-request:61",
    item: "PR #61",
    title: "Harden tracker snapshot parsing",
    url: "https://github.com/example/repository/pull/61",
    stage: "auto-review",
    status: "settled",
    reason: "Fresh tracker verification proved completion.",
    attempt: 1,
  });
  assert.notEqual(projection.lanes[0]?.candidates[0]?.key, projection.recent[1]?.key);
  assert.equal(projection.recent[1]?.itemKey, "issue:68");
});
