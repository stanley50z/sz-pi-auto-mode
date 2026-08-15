import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { resolveAutomodePaths } from "../src/paths.js";

test("shares the configured normal credential root while isolating repository state", () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "automode-roots-")));
  const firstRepository = join(fixture, "one");
  const secondRepository = join(fixture, "two");
  mkdirSync(join(firstRepository, ".git"), { recursive: true });
  mkdirSync(join(secondRepository, ".git"), { recursive: true });
  const normalAgentDir = join(fixture, "normal-pi");
  const one = resolveAutomodePaths(firstRepository, fixture, normalAgentDir);
  const two = resolveAutomodePaths(secondRepository, fixture, normalAgentDir);
  assert.equal(one.normalAgentDir, normalAgentDir);
  assert.notEqual(one.automodeDir, one.normalAgentDir);
  assert.notEqual(one.automodeDir, two.automodeDir);
  assert.notEqual(one.coordinatorDir, two.coordinatorDir);
  assert.ok(one.sessionDir.startsWith(one.automodeDir));
});

test("keys one repository consistently from root, subdirectories, and symlink paths", () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "automode-repository-")));
  const repository = join(fixture, "repository");
  const nested = join(repository, "src", "feature");
  mkdirSync(join(repository, ".git"), { recursive: true });
  mkdirSync(nested, { recursive: true });

  const rootPaths = resolveAutomodePaths(repository, fixture);
  const nestedPaths = resolveAutomodePaths(nested, fixture);
  assert.equal(nestedPaths.automodeDir, rootPaths.automodeDir);
  assert.equal(dirname(rootPaths.normalAgentDir), join(fixture, ".pi"));
});

test("Coordinator ownership is repository-scoped even when processes use different homes", () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "automode-coordinator-root-")));
  const repository = join(fixture, "repository");
  mkdirSync(join(repository, ".git"), { recursive: true });

  const first = resolveAutomodePaths(repository, join(fixture, "home-one"));
  const second = resolveAutomodePaths(repository, join(fixture, "home-two"));
  assert.notEqual(first.automodeDir, second.automodeDir);
  assert.equal(first.coordinatorDir, second.coordinatorDir);
  assert.equal(first.runRecordFile, second.runRecordFile);
  assert.ok(first.runRecordFile.startsWith(first.coordinatorDir));
});
