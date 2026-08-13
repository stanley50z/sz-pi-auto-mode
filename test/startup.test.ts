import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAutomodeCapabilityProfile } from "../src/capability-profile.js";
import { validateAutomodeStartup, type StartupCommandRunner } from "../src/startup.js";
import { createAutomationStageConfiguration } from "../src/stage-configuration.js";

function repositoryFixture(): string {
  const repository = join(mkdtempSync(join(tmpdir(), "automode-startup-")), "repository");
  mkdirSync(join(repository, ".git"), { recursive: true });
  return realpathSync(repository);
}

const half = createAutomationStageConfiguration("half", ["auto-triage"]);

class RecordedRunner implements StartupCommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];

  async run(command: string, args: readonly string[], cwd: string): Promise<string> {
    this.calls.push({ command, args, cwd });
    if (command === "git" && args[0] === "rev-parse") return `${cwd}\n`;
    if (command === "git" && args[0] === "remote") return "https://github.com/owner/repository.git\n";
    if (command === "gh" && args[0] === "auth") return "github.com\n";
    if (command === "gh" && args[0] === "repo") {
      return JSON.stringify({
        id: "repository-id",
        nameWithOwner: "owner/repository",
        url: "https://github.com/owner/repository",
        viewerPermission: "ADMIN",
      });
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  }
}

test("startup verifies the GitHub repository and every required execution profile before work discovery", async () => {
  const repository = repositoryFixture();
  const runner = new RecordedRunner();
  const attested: unknown[] = [];

  const result = await validateAutomodeStartup({
    repository,
    configuration: half,
    runner,
    attestExecutions: async (profiles) => {
      attested.push(...profiles);
    },
  });

  assert.equal(result.repository, repository);
  assert.equal(result.repositoryId, "repository-id");
  assert.equal(result.repositorySlug, "owner/repository");
  assert.deepEqual(runner.calls, [
    { command: "git", args: ["rev-parse", "--show-toplevel"], cwd: repository },
    { command: "git", args: ["remote", "get-url", "origin"], cwd: repository },
    { command: "gh", args: ["auth", "status", "--hostname", "github.com"], cwd: repository },
    { command: "gh", args: ["repo", "view", "--json", "id,nameWithOwner,url,viewerPermission"], cwd: repository },
  ]);
  assert.deepEqual(attested, [createAutomodeCapabilityProfile(half).ordinaryTicketExecution]);
});

test("panel execution profiles are startup requirements only when a panel stage is enabled", async () => {
  const repository = repositoryFixture();
  const runner = new RecordedRunner();
  const profiles: unknown[] = [];
  const configuration = createAutomationStageConfiguration("half", ["auto-review"]);

  await validateAutomodeStartup({
    repository,
    configuration,
    runner,
    attestExecutions: async (required) => {
      profiles.push(...required);
    },
  });

  const profile = createAutomodeCapabilityProfile(configuration);
  assert.deepEqual(profiles, profile.panelExecutions);
});

test("startup binds gh access to local origin and requires mutation permission", async () => {
  const repository = repositoryFixture();
  const mismatch = new RecordedRunner();
  mismatch.run = async function (command, args, cwd) {
    this.calls.push({ command, args, cwd });
    if (command === "git" && args[0] === "rev-parse") return cwd;
    if (command === "git") return "https://github.com/other/repository.git";
    if (args[0] === "auth") return "github.com";
    return JSON.stringify({
      id: "repository-id",
      nameWithOwner: "owner/repository",
      url: "https://github.com/owner/repository",
      viewerPermission: "ADMIN",
    });
  };
  await assert.rejects(
    () => validateAutomodeStartup({
      repository,
      configuration: half,
      runner: mismatch,
      attestExecutions: async () => undefined,
    }),
    /identity do not match/,
  );

  const readOnly = new RecordedRunner();
  readOnly.run = async function (command, args, cwd) {
    const output = await RecordedRunner.prototype.run.call(this, command, args, cwd);
    if (command === "gh" && args[0] === "repo") {
      return JSON.stringify({
        id: "repository-id",
        nameWithOwner: "owner/repository",
        url: "https://github.com/owner/repository",
        viewerPermission: "READ",
      });
    }
    return output;
  };
  await assert.rejects(
    () => validateAutomodeStartup({
      repository,
      configuration: half,
      runner: readOnly,
      attestExecutions: async () => undefined,
    }),
    /requires TRIAGE permission/,
  );
});

test("repository, GitHub authentication/access, and execution failures abort startup", async () => {
  const cases = [
    { failAt: "git", message: /repository validation failed/ },
    { failAt: "auth", message: /GitHub authentication failed/ },
    { failAt: "repo", message: /GitHub repository access failed/ },
  ] as const;

  for (const scenario of cases) {
    const repository = repositoryFixture();
    const runner: StartupCommandRunner = {
      async run(command, args, cwd) {
        const step = command === "git" ? "git" : args[0];
        if (step === scenario.failAt) throw new Error("unavailable");
        if (command === "git" && args[0] === "rev-parse") return `${cwd}\n`;
        if (command === "git" && args[0] === "remote") return "https://github.com/owner/repository.git\n";
        if (args[0] === "auth") return "github.com\n";
        return JSON.stringify({
          id: "repository-id",
          nameWithOwner: "owner/repository",
          url: "https://github.com/owner/repository",
          viewerPermission: "ADMIN",
        });
      },
    };
    await assert.rejects(
      () => validateAutomodeStartup({
        repository,
        configuration: half,
        runner,
        attestExecutions: async () => undefined,
      }),
      scenario.message,
    );
  }

  await assert.rejects(
    () => validateAutomodeStartup({
      repository: repositoryFixture(),
      configuration: half,
      runner: new RecordedRunner(),
      attestExecutions: async () => {
        throw new Error("missing model");
      },
    }),
    /Required execution profile is unavailable: missing model/,
  );
});
