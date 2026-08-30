import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAutomodeCapabilityProfile } from "../src/capability-profile.js";
import {
  attestClaudeCodeExecutionProfile,
  validateAutomodeStartup,
  type StartupCommandRunner,
} from "../src/startup.js";
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
    if (command === "gh" && args[0] === "auth") return "automation-user\n";
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
    runner,
    attestExecutions: async (profiles) => {
      attested.push(...profiles);
    },
  });

  assert.equal(result.repository, repository);
  assert.equal(result.repositoryId, "repository-id");
  assert.equal(result.repositorySlug, "owner/repository");
  assert.equal(result.actor, "automation-user");
  assert.deepEqual(runner.calls, [
    { command: "git", args: ["rev-parse", "--show-toplevel"], cwd: repository },
    { command: "git", args: ["remote", "get-url", "origin"], cwd: repository },
    {
      command: "gh",
      args: [
        "auth", "status", "--active", "--hostname", "github.com", "--json", "hosts",
        "--jq", '.hosts["github.com"][] | select(.active == true and .state == "success") | .login',
      ],
      cwd: repository,
    },
    { command: "gh", args: ["repo", "view", "--json", "id,nameWithOwner,url,viewerPermission"], cwd: repository },
  ]);
  assert.deepEqual(
    attested,
    createAutomodeCapabilityProfile().panelExecutions,
  );
});

test("startup does not depend on the intermittently unavailable REST user endpoint", async () => {
  const repository = repositoryFixture();
  const runner = new RecordedRunner();
  runner.run = async function (command, args, cwd) {
    if (command === "gh" && args[0] === "api") {
      throw new Error("gh: No server is currently available to service your request. (HTTP 503)");
    }
    return RecordedRunner.prototype.run.call(this, command, args, cwd);
  };

  const result = await validateAutomodeStartup({
    repository,
    runner,
    attestExecutions: async () => undefined,
  });

  assert.equal(result.actor, "automation-user");
  assert.equal(runner.calls.some(({ command, args }) => command === "gh" && args[0] === "api"), false);
});

test("Claude Code startup attestation executes the exact configured model and reasoning profile", async () => {
  const repository = repositoryFixture();
  const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
  const runner: StartupCommandRunner = {
    async run(command, args, cwd) {
      calls.push({ command, args, cwd });
      if (args[0] === "auth") return JSON.stringify({ loggedIn: true });
      return JSON.stringify({ is_error: false, result: "AUTOMODE_PROFILE_READY" });
    },
  };

  await attestClaudeCodeExecutionProfile(
    { harness: "claude-code", model: "claude-fable-5", reasoning: "high" },
    runner,
    repository,
  );

  assert.deepEqual(calls, [
    { command: "claude", args: ["auth", "status", "--json"], cwd: repository },
    {
      command: "claude",
      args: [
        "--safe-mode",
        "--model", "claude-fable-5",
        "--effort", "high",
        "--print",
        "--output-format", "json",
        "--tools", "",
        "--no-session-persistence",
        "Reply exactly AUTOMODE_PROFILE_READY.",
      ],
      cwd: repository,
    },
  ]);
});

test("Claude Code startup attestation fails closed when the exact model probe reports an error", async () => {
  const repository = repositoryFixture();
  const runner: StartupCommandRunner = {
    async run(_command, args) {
      if (args[0] === "auth") return JSON.stringify({ loggedIn: true });
      return JSON.stringify([{ type: "result", is_error: true }]);
    },
  };

  await assert.rejects(
    () => attestClaudeCodeExecutionProfile(
      { harness: "claude-code", model: "claude-fable-5", reasoning: "high" },
      runner,
      repository,
    ),
    /model probe failed for claude-fable-5\/high/,
  );
});

test("startup binds gh access to local origin and requires mutation permission", async () => {
  const repository = repositoryFixture();
  const mismatch = new RecordedRunner();
  mismatch.run = async function (command, args, cwd) {
    this.calls.push({ command, args, cwd });
    if (command === "git" && args[0] === "rev-parse") return cwd;
    if (command === "git") return "https://github.com/other/repository.git";
    if (args[0] === "auth") return "automation-user";
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
      runner: readOnly,
      attestExecutions: async () => undefined,
    }),
    /requires WRITE permission/,
  );
});

test("startup polls through consecutive transient GitHub service failures instead of aborting Automode", async () => {
  const repository = repositoryFixture();
  const runner = new RecordedRunner();
  let authenticationAttempts = 0;
  runner.run = async function (command, args, cwd) {
    if (command === "gh" && args[0] === "auth") {
      this.calls.push({ command, args, cwd });
      authenticationAttempts += 1;
      if (authenticationAttempts <= 3) {
        throw new Error("gh: No server is currently available to service your request. (HTTP 503)");
      }
      return "automation-user\n";
    }
    return RecordedRunner.prototype.run.call(this, command, args, cwd);
  };

  const result = await validateAutomodeStartup({
    repository,
    runner,
    attestExecutions: async () => undefined,
  });

  assert.equal(result.actor, "automation-user");
  assert.equal(authenticationAttempts, 4);
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
        if (args[0] === "auth") return "automation-user\n";
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
        runner,
        attestExecutions: async () => undefined,
      }),
      scenario.message,
    );
  }

  await assert.rejects(
    () => validateAutomodeStartup({
      repository: repositoryFixture(),
      runner: new RecordedRunner(),
      attestExecutions: async () => {
        throw new Error("missing model");
      },
    }),
    /Required execution profile is unavailable: missing model/,
  );
});
