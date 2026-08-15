import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireRepositoryCoordinator } from "../src/coordinator-lock.js";

test("one live Coordinator owns a repository and restarts reuse its durable identity", () => {
  const automodeDir = join(mkdtempSync(join(tmpdir(), "automode-lock-")), "run");
  mkdirSync(automodeDir, { recursive: true });

  const first = acquireRepositoryCoordinator(automodeDir);
  assert.match(first.coordinatorId, /^[0-9a-f-]{36}$/);
  assert.throws(() => acquireRepositoryCoordinator(automodeDir), /already has a live Automode Coordinator/);

  first.release();
  first.release();
  const restarted = acquireRepositoryCoordinator(automodeDir);
  try {
    assert.equal(restarted.coordinatorId, first.coordinatorId);
    assert.deepEqual(JSON.parse(readFileSync(restarted.identityFile, "utf8")), {
      coordinatorId: first.coordinatorId,
    });
  } finally {
    restarted.release();
  }
});

test("a dead process lock is recovered but malformed lock evidence fails closed", () => {
  const staleDirectory = join(mkdtempSync(join(tmpdir(), "automode-stale-lock-")), "run");
  mkdirSync(staleDirectory, { recursive: true });
  writeFileSync(join(staleDirectory, "coordinator-identity.json"), JSON.stringify({ coordinatorId: "identity" }));
  const staleLock = join(staleDirectory, "coordinator.lock");
  mkdirSync(staleLock);
  const staleTime = new Date(Date.now() - 60_000);
  utimesSync(staleLock, staleTime, staleTime);

  const recovered = acquireRepositoryCoordinator(staleDirectory);
  recovered.release();

  const malformedDirectory = join(mkdtempSync(join(tmpdir(), "automode-bad-lock-")), "run");
  mkdirSync(malformedDirectory, { recursive: true });
  writeFileSync(join(malformedDirectory, "coordinator.lock"), "not json");
  assert.throws(() => acquireRepositoryCoordinator(malformedDirectory), /Cannot verify existing Coordinator lock/);
});
