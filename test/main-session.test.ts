import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  automodeRunConfigurationGuard,
  startAutomodeMainSession,
  type StartAutomodeMainOptions,
} from "../src/automode-main.js";
import { resolveAutomodePaths } from "../src/paths.js";
import {
  confirmSerializedAutomationStageConfiguration,
  createAutomationStageConfiguration,
  serializeAutomationStageConfiguration,
} from "../src/stage-configuration.js";

function startForTest(options: StartAutomodeMainOptions) {
  return startAutomodeMainSession({
    ...options,
    model: getBuiltinModel("openai-codex", "gpt-5.6-sol"),
    startupValidation: {
      runner: {
        async run(command, args, cwd) {
          if (command === "git" && args[0] === "rev-parse") return cwd;
          if (command === "git" && args[0] === "remote") return "https://github.com/owner/repository.git";
          if (args[0] === "auth") return "github.com";
          if (args[0] === "api") return "automation-user";
          return JSON.stringify({
            id: "repository-id",
            nameWithOwner: "owner/repository",
            url: "https://github.com/owner/repository",
            viewerPermission: "ADMIN",
          });
        },
      },
      attestExecutions: async () => undefined,
    },
  });
}

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

  const main = await startForTest({
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
    assert.equal(existsSync(main.runRecordFile), true);
    assert.equal(existsSync(main.coordinatorIdentityFile), true);
    assert.equal(existsSync(main.coordinatorLockFile), true);
    assert.deepEqual(JSON.parse(readFileSync(main.coordinatorIdentityFile, "utf8")), {
      coordinatorId: main.coordinatorId,
    });
    assert.deepEqual(JSON.parse(readFileSync(main.runRecordFile, "utf8")), {
      version: 1,
      coordinatorId: main.coordinatorId,
      stageConfiguration: {
        mode: "half",
        stages: ["auto-triage", "auto-review"],
      },
      projectResources: { trusted: false, skillFiles: [] },
    });
  } finally {
    main.dispose();
  }
  assert.equal(existsSync(main.coordinatorLockFile), false);
});

test("failed startup validation does not persist an Automode Run Record", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-failed-start-"));
  const repository = join(fixture, "repository");
  const home = join(fixture, "home");
  mkdirSync(join(repository, ".git"), { recursive: true });
  const configuration = confirmedConfiguration("half", ["auto-triage"]);

  await assert.rejects(
    () => startAutomodeMainSession({
      repository,
      home,
      ...configuration,
      startupValidation: {
        runner: {
          async run() {
            throw new Error("GitHub unavailable");
          },
        },
      },
    }),
    /repository validation failed/,
  );
  assert.equal(
    existsSync(resolveAutomodePaths(repository, home).runRecordFile),
    false,
  );
});

test("an Automode Run rejects changed project executable additions on restart", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-fixed-capability-"));
  const repository = join(fixture, "repository");
  const home = join(fixture, "home");
  const projectSkill = join(repository, "trusted-skills", "project-proof");
  mkdirSync(join(repository, ".git"), { recursive: true });
  mkdirSync(projectSkill, { recursive: true });
  writeFileSync(
    join(projectSkill, "SKILL.md"),
    "---\nname: project-proof\ndescription: Explicit project proof.\n---\nproof\n",
  );
  const configuration = confirmedConfiguration("half", ["auto-triage"]);
  const first = await startForTest({
    repository,
    home,
    ...configuration,
    projectResources: { trusted: true, skillPaths: [projectSkill] },
  });
  first.dispose();
  const restarted = await startForTest({
    repository,
    home,
    ...configuration,
    projectResources: { trusted: true, skillPaths: [projectSkill] },
  });
  restarted.dispose();

  await assert.rejects(
    () => startForTest({ repository, home, ...configuration }),
    /Automode Run Record is fixed for this Automode Run/,
  );
});

test("linked worktrees share the Coordinator identity and fixed Automode Run Record", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-linked-run-"));
  const primary = join(fixture, "primary");
  const linked = join(fixture, "linked");
  const linkedGitDirectory = join(primary, ".git", "worktrees", "linked");
  mkdirSync(linkedGitDirectory, { recursive: true });
  mkdirSync(linked, { recursive: true });
  writeFileSync(join(linked, ".git"), `gitdir: ${linkedGitDirectory}\n`);
  writeFileSync(join(linkedGitDirectory, "commondir"), "../..\n");

  const configuration = confirmedConfiguration("half", ["auto-triage"]);
  const first = await startForTest({
    repository: primary,
    home: join(fixture, "first-home"),
    ...configuration,
  });
  const coordinatorId = first.coordinatorId;
  const runRecordFile = first.runRecordFile;
  first.dispose();

  const restarted = await startForTest({
    repository: linked,
    home: join(fixture, "second-home"),
    ...configuration,
  });
  assert.equal(restarted.coordinatorId, coordinatorId);
  assert.equal(restarted.runRecordFile, runRecordFile);
  restarted.dispose();

  await assert.rejects(
    () => startForTest({
      repository: linked,
      home: join(fixture, "third-home"),
      ...confirmedConfiguration("half", ["auto-review"]),
    }),
    /Automode Run Record is fixed for this Automode Run/,
  );
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
  const first = await startForTest({ repository, home, ...full });
  const coordinatorId = first.coordinatorId;
  await assert.rejects(
    () => startForTest({ repository, home, ...full }),
    /live Automode Coordinator/,
  );
  first.dispose();
  const restarted = await startForTest({ repository, home, ...full });
  assert.equal(restarted.coordinatorId, coordinatorId);
  restarted.dispose();

  await assert.rejects(
    () => startForTest({
      repository,
      home: join(fixture, "second-home"),
      ...confirmedConfiguration("half", ["auto-review"]),
    }),
    /Automode Run Record is fixed for this Automode Run/,
  );
});
