import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  processWorkspaceCommandRunner,
  WorkspaceManager,
  type WorkspaceCommandRunner,
} from "../src/workspace.js";

import { AutomodeCoordinator } from "../src/coordinator.js";
import { createAutomationStageConfiguration } from "../src/stage-configuration.js";

const COMMAND_TIMEOUT_MS = 10_000;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
  }).trim();
}

interface RepositoryFixture {
  readonly root: string;
  readonly seed: string;
  readonly repository: string;
  commitAndPush(contents: string): string;
  dispose(): void;
}

function createRepositoryFixture(): RepositoryFixture {
  const root = mkdtempSync(join(tmpdir(), "automode-workspace-"));
  const remote = join(root, "origin.git");
  const seed = join(root, "seed");
  const repository = join(root, "repository");
  git(root, "init", "--bare", remote);
  git(root, "init", "-b", "main", seed);
  git(seed, "config", "user.name", "Workspace Test");
  git(seed, "config", "user.email", "workspace@example.test");
  writeFileSync(join(seed, "fixture.txt"), "initial\n", "utf8");
  git(seed, "add", "fixture.txt");
  git(seed, "commit", "-m", "initial");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "clone", remote, repository);
  git(repository, "config", "user.name", "Workspace Test");
  git(repository, "config", "user.email", "workspace@example.test");

  return {
    root,
    seed,
    repository,
    commitAndPush(contents) {
      writeFileSync(join(seed, "fixture.txt"), contents, "utf8");
      git(seed, "add", "fixture.txt");
      git(seed, "commit", "-m", `fixture ${contents.trim()}`);
      git(seed, "push", "origin", "main");
      return git(seed, "rev-parse", "HEAD");
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("Coordinator reports root branch changes even when the tracker snapshot is unchanged", async () => {
  const fixture = createRepositoryFixture();
  const coordinator = new AutomodeCoordinator({
    configuration: createAutomationStageConfiguration("half", ["auto-review"]),
    actor: "automation-user",
    tracker: {
      async snapshot() { return { revision: "unchanged", items: [] }; },
      async listBookkeeping() { return []; },
      async read() { throw new Error("No tracker items"); },
      async claim() { throw new Error("No tracker items"); },
      async upsertBookkeeping() { throw new Error("No tracker items"); },
    },
    sessions: { async start() { throw new Error("No sessions expected"); } },
    workspaces: new WorkspaceManager({ repositoryRoot: fixture.repository }),
  });
  try {
    await coordinator.start();
    assert.equal(coordinator.getProjection().rootCheckout?.branch, "main");
    git(fixture.repository, "switch", "-c", "feature/interactive");
    await coordinator.refresh();
    assert.equal(coordinator.getProjection().rootCheckout?.branch, "feature/interactive");
    git(fixture.repository, "checkout", "--detach");
    await coordinator.refresh();
    assert.equal(coordinator.getProjection().rootCheckout?.branch, "detached HEAD");
  } finally {
    coordinator.interrupt();
    await coordinator.whenStopped();
    fixture.dispose();
  }
});

test("a production issue gets a deterministic isolated worktree from the freshly fetched origin default", async () => {
  const fixture = createRepositoryFixture();
  try {
    const expectedHead = fixture.commitAndPush("fresh default\n");
    const manager = new WorkspaceManager({ repositoryRoot: fixture.repository });

    const workspace = await manager.prepareProductionIssue(40);

    assert.deepEqual(workspace, {
      branch: "automode/issue-40",
      worktree: join(fixture.repository, ".worktree", "issue-40"),
    });
    assert.equal(existsSync(workspace.worktree), true);
    assert.equal(git(workspace.worktree, "rev-parse", "HEAD"), expectedHead);
    assert.equal(git(workspace.worktree, "branch", "--show-current"), "automode/issue-40");
  } finally {
    fixture.dispose();
  }
});

test("preparing an existing issue resumes its branch and worktree without resetting progress", async () => {
  const fixture = createRepositoryFixture();
  try {
    const manager = new WorkspaceManager({ repositoryRoot: fixture.repository });
    const first = await manager.prepareProductionIssue(41);
    writeFileSync(join(first.worktree, "progress.txt"), "preserve me\n", "utf8");
    git(first.worktree, "add", "progress.txt");
    git(first.worktree, "commit", "-m", "work in progress");
    const progressHead = git(first.worktree, "rev-parse", "HEAD");
    fixture.commitAndPush("newer default\n");

    const resumed = await manager.prepareProductionIssue(41);

    assert.deepEqual(resumed, first);
    assert.equal(git(resumed.worktree, "rev-parse", "HEAD"), progressHead);
    assert.equal(existsSync(join(resumed.worktree, "progress.txt")), true);
  } finally {
    fixture.dispose();
  }
});

test("a missing worktree is recreated from its surviving issue branch", async () => {
  const fixture = createRepositoryFixture();
  try {
    const manager = new WorkspaceManager({ repositoryRoot: fixture.repository });
    const first = await manager.prepareProductionIssue(42);
    writeFileSync(join(first.worktree, "surviving.txt"), "branch evidence\n", "utf8");
    git(first.worktree, "add", "surviving.txt");
    git(first.worktree, "commit", "-m", "surviving branch");
    const survivingHead = git(first.worktree, "rev-parse", "HEAD");
    rmSync(first.worktree, { recursive: true, force: true });

    const recreated = await manager.prepareProductionIssue(42);

    assert.deepEqual(recreated, first);
    assert.equal(git(recreated.worktree, "rev-parse", "HEAD"), survivingHead);
    assert.equal(existsSync(join(recreated.worktree, "surviving.txt")), true);
  } finally {
    fixture.dispose();
  }
});

test("prototype and production work for one issue use permanently distinct deterministic identities", async () => {
  const fixture = createRepositoryFixture();
  try {
    const manager = new WorkspaceManager({ repositoryRoot: fixture.repository });

    const prototype = await manager.preparePrototypeIssue(43);
    const production = await manager.prepareProductionIssue(43);

    assert.deepEqual(prototype, {
      branch: "automode/prototype-43",
      worktree: join(fixture.repository, ".worktree", "prototype-43"),
    });
    assert.deepEqual(production, {
      branch: "automode/issue-43",
      worktree: join(fixture.repository, ".worktree", "issue-43"),
    });
    assert.notEqual(prototype.branch, production.branch);
    assert.notEqual(prototype.worktree, production.worktree);
  } finally {
    fixture.dispose();
  }
});

test("Coordinator review preparation fails fast for a fork head without a writable remote", async () => {
  const manager = new WorkspaceManager({
    repositoryRoot: resolve(tmpdir()),
    repositorySlug: "owner/repository",
    runner: { async run() { throw new Error("must not execute Git"); } },
  });

  await assert.rejects(
    () => manager.prepare({
      item: {
        kind: "pull-request",
        number: 440,
        url: "https://github.com/owner/repository/pull/440",
        state: "open",
        labels: [],
        assignees: [],
        blockedBy: 0,
        draft: false,
        merged: false,
        headSha: "0123456789abcdef0123456789abcdef01234567",
        headBranch: "feature",
        headRepository: "fork-owner/repository",
        updatedAt: "2026-01-01T00:00:00Z",
        materialVersion: "fork-pr",
      },
      skillName: "code-review",
    }),
    /fork head.*no writable head remote/i,
  );
});

test("review preparation creates a writable isolated worktree at the exact advertised pull-request head", async () => {
  const fixture = createRepositoryFixture();
  try {
    const headSha = fixture.commitAndPush("pull request head\n");
    git(fixture.seed, "push", "origin", `HEAD:refs/heads/contributor/pr-44`);
    git(fixture.seed, "push", "origin", `HEAD:refs/pull/44/head`);
    const manager = new WorkspaceManager({ repositoryRoot: fixture.repository });

    const workspace = await manager.prepareReview({
      pullRequestNumber: 44,
      headSha,
      headBranch: "contributor/pr-44",
      pushRemote: "origin",
    });

    assert.deepEqual(workspace, {
      branch: "automode/review-pr-44",
      worktree: join(fixture.repository, ".worktree", "review-pr-44"),
    });
    assert.equal(git(workspace.worktree, "rev-parse", "HEAD"), headSha);
    assert.equal(git(workspace.worktree, "branch", "--show-current"), "automode/review-pr-44");
  } finally {
    fixture.dispose();
  }
});

test("review preparation fails before checkout when the fetched pull-request head is not exact", async () => {
  const fixture = createRepositoryFixture();
  try {
    fixture.commitAndPush("actual pull request head\n");
    git(fixture.seed, "push", "origin", `HEAD:refs/pull/45/head`);
    const manager = new WorkspaceManager({ repositoryRoot: fixture.repository });

    await assert.rejects(
      () => manager.prepareReview({
        pullRequestNumber: 45,
        headSha: "0000000000000000000000000000000000000000",
        headBranch: "contributor/pr-45",
        pushRemote: "origin",
      }),
      /did not match expected/,
    );
    assert.equal(existsSync(join(fixture.repository, ".worktree", "review-pr-45")), false);
  } finally {
    fixture.dispose();
  }
});

test("review preparation fails explicitly and preserves evidence when fixes cannot be pushed", async () => {
  const fixture = createRepositoryFixture();
  try {
    const headSha = fixture.commitAndPush("unwritable pull request head\n");
    git(fixture.seed, "push", "origin", `HEAD:refs/heads/contributor/pr-46`);
    git(fixture.seed, "push", "origin", `HEAD:refs/pull/46/head`);
    const runner: WorkspaceCommandRunner = {
      run(command, args, cwd) {
        if (command === "git" && args[0] === "push" && args.includes("--dry-run")) {
          throw new Error("remote rejected write access");
        }
        return processWorkspaceCommandRunner.run(command, args, cwd);
      },
    };
    const manager = new WorkspaceManager({ repositoryRoot: fixture.repository, runner });

    await assert.rejects(
      () => manager.prepareReview({
        pullRequestNumber: 46,
        headSha,
        headBranch: "contributor/pr-46",
        pushRemote: "origin",
      }),
      /cannot push fixes/,
    );
    assert.equal(existsSync(join(fixture.repository, ".worktree", "review-pr-46")), true);
  } finally {
    fixture.dispose();
  }
});

test("review preparation reuses the exact recorded production worktree", async () => {
  const fixture = createRepositoryFixture();
  try {
    const manager = new WorkspaceManager({ repositoryRoot: fixture.repository });
    const production = await manager.prepareProductionIssue(47);
    const headSha = git(production.worktree, "rev-parse", "HEAD");
    git(production.worktree, "push", "origin", `HEAD:refs/heads/contributor/pr-47`);
    git(production.worktree, "push", "origin", `HEAD:refs/pull/47/head`);

    const review = await manager.prepareReview({
      pullRequestNumber: 47,
      headSha,
      headBranch: "contributor/pr-47",
      pushRemote: "origin",
      existingWorkspace: production,
    });

    assert.deepEqual(review, production);
    assert.equal(existsSync(join(fixture.repository, ".worktree", "review-pr-47")), false);
  } finally {
    fixture.dispose();
  }
});

test("cleanup is rejected before a successful merge and preserves every artifact", async () => {
  const fixture = createRepositoryFixture();
  try {
    const manager = new WorkspaceManager({ repositoryRoot: fixture.repository });
    const workspace = await manager.prepareProductionIssue(48);

    await assert.rejects(
      () => manager.cleanupAfterSuccessfulMerge({
        mergeSucceeded: false,
        workspace,
        headRemote: "origin",
        headBranch: "automode/issue-48",
        sameRepository: true,
      }),
      /successful merge/,
    );
    assert.equal(existsSync(workspace.worktree), true);
    assert.equal(git(fixture.repository, "show-ref", "--verify", "refs/heads/automode/issue-48").length > 0, true);
  } finally {
    fixture.dispose();
  }
});

test("completing a merged review fast-forwards the project root to the remote default branch", async () => {
  const fixture = createRepositoryFixture();
  try {
    const manager = new WorkspaceManager({
      repositoryRoot: fixture.repository,
      repositorySlug: "owner/repository",
    });
    const workspace = await manager.prepareProductionIssue(49);
    writeFileSync(join(workspace.worktree, "merged.txt"), "merged delivery\n", "utf8");
    git(workspace.worktree, "add", "merged.txt");
    git(workspace.worktree, "commit", "-m", "merged delivery");
    const mergedHead = git(workspace.worktree, "rev-parse", "HEAD");
    git(workspace.worktree, "push", "origin", `HEAD:refs/heads/${workspace.branch}`);
    git(fixture.seed, "fetch", "origin", workspace.branch);
    git(fixture.seed, "merge", "--ff-only", "FETCH_HEAD");
    git(fixture.seed, "push", "origin", "main");

    await manager.completeReview({
      kind: "pull-request",
      number: 49,
      url: "https://github.com/owner/repository/pull/49",
      state: "closed",
      labels: [],
      assignees: [],
      blockedBy: 0,
      draft: false,
      merged: true,
      headSha: mergedHead,
      headBranch: workspace.branch,
      headRepository: "owner/repository",
      updatedAt: "2026-01-01T00:00:00Z",
      materialVersion: "merged-pr-49",
    }, workspace);

    assert.equal(git(fixture.repository, "branch", "--show-current"), "main");
    assert.equal(git(fixture.repository, "rev-parse", "HEAD"), mergedHead);
  } finally {
    fixture.dispose();
  }
});

test("a cleanup failure still updates the root and restarts the project, while reporting the failure", async () => {
  const fixture = createRepositoryFixture();
  try {
    const manager = new WorkspaceManager({
      repositoryRoot: fixture.repository,
      repositorySlug: "owner/repository",
      runner: {
        run(command, args, cwd) {
          if (command === "git" && args[0] === "worktree" && args[1] === "remove") {
            throw new Error("worktree remove: Permission denied");
          }
          return processWorkspaceCommandRunner.run(command, args, cwd);
        },
      },
    });
    const workspace = await manager.prepareProductionIssue(53);
    writeFileSync(join(fixture.seed, "start.py"), "from pathlib import Path\nPath('restarted.txt').write_text('started', encoding='utf-8')\n", "utf8");
    git(fixture.seed, "add", "start.py");
    const mergedHead = fixture.commitAndPush("merged despite cleanup failure\n");

    await assert.rejects(manager.completeReview({
      kind: "pull-request", number: 53, url: "https://github.com/owner/repository/pull/53",
      state: "closed", labels: [], assignees: [], blockedBy: 0, merged: true,
      headRepository: "owner/repository", headBranch: workspace.branch,
      updatedAt: "2026-01-01T00:00:00Z", materialVersion: "merged-53",
    }, workspace), /Permission denied/u);

    assert.equal(git(fixture.repository, "rev-parse", "HEAD"), mergedHead);
    assert.equal(readFileSync(join(fixture.repository, "restarted.txt"), "utf8"), "started");
    assert.equal(existsSync(workspace.worktree), true);
  } finally {
    fixture.dispose();
  }
});

for (const rootState of ["feature branch", "detached HEAD", "diverged main"] as const) {
  test(`cleanup failure preserves ${rootState}, reports both failures, and does not restart`, async () => {
    const fixture = createRepositoryFixture();
    try {
      const manager = new WorkspaceManager({
        repositoryRoot: fixture.repository, repositorySlug: "owner/repository",
        runner: {
          run(command, args, cwd) {
            if (args[0] === "worktree" && args[1] === "remove") throw new Error("Permission denied");
            return processWorkspaceCommandRunner.run(command, args, cwd);
          },
        },
      });
      const workspace = await manager.prepareProductionIssue(54);
      if (rootState === "feature branch") git(fixture.repository, "switch", "-c", "feature/interactive");
      if (rootState === "detached HEAD") git(fixture.repository, "checkout", "--detach");
      if (rootState === "diverged main") {
        writeFileSync(join(fixture.repository, "local.txt"), "local work\n", "utf8");
        git(fixture.repository, "add", "local.txt");
        git(fixture.repository, "commit", "-m", "local work");
      }
      const originalHead = git(fixture.repository, "rev-parse", "HEAD");
      const originalBranch = git(fixture.repository, "branch", "--show-current");
      writeFileSync(join(fixture.repository, "start.py"), "from pathlib import Path\nPath('unexpected-restart').touch()\n", "utf8");
      fixture.commitAndPush("remote delivery\n");
      await assert.rejects(manager.completeReview({
        kind: "pull-request", number: 54, url: "https://github.com/owner/repository/pull/54",
        state: "closed", labels: [], assignees: [], blockedBy: 0, merged: true,
        headRepository: "owner/repository", headBranch: workspace.branch,
        updatedAt: "2026-01-01T00:00:00Z", materialVersion: "merged-54",
      }, workspace), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Cleanup failed: Permission denied/u);
        assert.match(error.message, /Project sync\/restart failed:/u);
        if (rootState !== "diverged main") assert.match(error.message, /expected branch main, found (feature\/interactive|detached HEAD)/u);
        return true;
      });
      assert.equal(git(fixture.repository, "rev-parse", "HEAD"), originalHead);
      assert.equal(git(fixture.repository, "branch", "--show-current"), originalBranch);
      assert.equal(existsSync(join(fixture.repository, "unexpected-restart")), false);
    } finally {
      fixture.dispose();
    }
  });
}

test("completing a merged review runs stop.py before start.py from the updated project root", async () => {
  const fixture = createRepositoryFixture();
  try {
    const manager = new WorkspaceManager({
      repositoryRoot: fixture.repository,
      repositorySlug: "owner/repository",
    });
    const workspace = await manager.prepareProductionIssue(50);
    writeFileSync(join(workspace.worktree, "stop.py"), [
      "from pathlib import Path",
      "import subprocess",
      "head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()",
      "Path('restart-order.txt').write_text(f'stop {head}\\n', encoding='utf-8')",
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(workspace.worktree, "start.py"), [
      "from pathlib import Path",
      "import subprocess",
      "head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()",
      "path = Path('restart-order.txt')",
      "path.write_text(path.read_text(encoding='utf-8') + f'start {head}\\n', encoding='utf-8')",
      "",
    ].join("\n"), "utf8");
    git(workspace.worktree, "add", "stop.py", "start.py");
    git(workspace.worktree, "commit", "-m", "add project restart scripts");
    const mergedHead = git(workspace.worktree, "rev-parse", "HEAD");
    git(workspace.worktree, "push", "origin", `HEAD:refs/heads/${workspace.branch}`);
    git(fixture.seed, "fetch", "origin", workspace.branch);
    git(fixture.seed, "merge", "--ff-only", "FETCH_HEAD");
    git(fixture.seed, "push", "origin", "main");

    await manager.completeReview({
      kind: "pull-request",
      number: 50,
      url: "https://github.com/owner/repository/pull/50",
      state: "closed",
      labels: [],
      assignees: [],
      blockedBy: 0,
      draft: false,
      merged: true,
      headSha: mergedHead,
      headBranch: workspace.branch,
      headRepository: "owner/repository",
      updatedAt: "2026-01-01T00:00:00Z",
      materialVersion: "merged-pr-50",
    }, workspace);

    assert.deepEqual(
      readFileSync(join(fixture.repository, "restart-order.txt"), "utf8").trim().split(/\r?\n/u),
      [`stop ${mergedHead}`, `start ${mergedHead}`],
    );
  } finally {
    fixture.dispose();
  }
});

test("successful-merge cleanup removes same-repository artifacts and is idempotent", async () => {
  const fixture = createRepositoryFixture();
  try {
    const manager = new WorkspaceManager({ repositoryRoot: fixture.repository });
    const workspace = await manager.prepareProductionIssue(51);
    git(workspace.worktree, "push", "origin", `HEAD:refs/heads/${workspace.branch}`);
    const cleanup = {
      mergeSucceeded: true,
      workspace,
      headRemote: "origin",
      headBranch: workspace.branch,
      sameRepository: true,
    } as const;

    await manager.cleanupAfterSuccessfulMerge(cleanup);
    await manager.cleanupAfterSuccessfulMerge(cleanup);

    assert.equal(existsSync(workspace.worktree), false);
    assert.equal(git(fixture.repository, "for-each-ref", "--format=%(refname)", `refs/heads/${workspace.branch}`), "");
    assert.equal(git(fixture.repository, "ls-remote", "--heads", "origin", `refs/heads/${workspace.branch}`), "");
  } finally {
    fixture.dispose();
  }
});

test("successful-merge cleanup never deletes a fork head branch", async () => {
  const fixture = createRepositoryFixture();
  try {
    const manager = new WorkspaceManager({ repositoryRoot: fixture.repository });
    const workspace = await manager.prepareProductionIssue(52);
    git(workspace.worktree, "push", "origin", "HEAD:refs/heads/fork-owner/pr-52");

    await manager.cleanupAfterSuccessfulMerge({
      mergeSucceeded: true,
      workspace,
      headRemote: "origin",
      headBranch: "fork-owner/pr-52",
      sameRepository: false,
    });

    assert.equal(existsSync(workspace.worktree), false);
    assert.notEqual(git(fixture.repository, "ls-remote", "--heads", "origin", "refs/heads/fork-owner/pr-52"), "");
  } finally {
    fixture.dispose();
  }
});
