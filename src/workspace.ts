import { execFile } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  TicketWorkspaceIdentity,
  TicketWorkspaceManager,
  TicketWorkspaceRequest,
} from "./coordinator.js";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 30_000;

export type WorkspaceIdentity = TicketWorkspaceIdentity;

export interface WorkspaceCommandRunner {
  run(command: string, args: readonly string[], cwd: string): Promise<string>;
}

export interface WorkspaceFileSystem {
  exists(path: string): Promise<boolean>;
  removeDirectory(path: string): Promise<void>;
}

export interface WorkspaceManagerOptions {
  readonly repositoryRoot: string;
  readonly repositorySlug?: string;
  readonly runner?: WorkspaceCommandRunner;
  readonly fileSystem?: WorkspaceFileSystem;
}

export interface ReviewWorkspaceRequest {
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly headBranch: string;
  readonly pushRemote: string;
  readonly existingWorkspace?: WorkspaceIdentity;
}

export interface MergedWorkspaceCleanupRequest {
  readonly mergeSucceeded: boolean;
  readonly workspace: WorkspaceIdentity;
  readonly headRemote: string;
  readonly headBranch: string;
  readonly sameRepository: boolean;
}

export const processWorkspaceCommandRunner: WorkspaceCommandRunner = {
  async run(command, args, cwd) {
    const result = await execFileAsync(command, [...args], {
      cwd,
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    return result.stdout;
  },
};

export const processWorkspaceFileSystem: WorkspaceFileSystem = {
  async exists(path) {
    try {
      await access(path);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return false;
      throw error;
    }
  },
  async removeDirectory(path) {
    await rm(path, { recursive: true, force: true });
  },
};

interface OriginDefault {
  readonly branch: string;
  readonly sha: string;
}

interface WorktreeRecord {
  readonly path: string;
  readonly branch?: string;
}

function positiveInteger(value: number, context: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${context} must be a positive integer`);
  }
  return value;
}

function isSafeGitBranch(branch: string): boolean {
  if (branch.length === 0 || branch.startsWith("-") || branch.startsWith("/") || branch.endsWith("/")) return false;
  if (branch.endsWith(".") || branch.includes("..") || branch.includes("//") || branch.includes("@{")) return false;
  if (/[\u0000-\u0020\u007f~^:?*\\[\\\\]/u.test(branch)) return false;
  return branch.split("/").every((part) =>
    part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock")
  );
}

function assertSafeGitBranch(branch: string, context: string): void {
  if (!isSafeGitBranch(branch)) throw new Error(`${context} is not a safe Git branch name: ${branch}`);
}

function normalizedSha(value: string, context: string): string {
  if (!/^[0-9a-fA-F]{40,64}$/u.test(value)) throw new Error(`${context} must be a full Git revision`);
  return value.toLowerCase();
}

function assertSafeRemote(remote: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(remote) || remote.includes("..") || remote.includes("//")) {
    throw new Error(`Review push remote is not a safe configured remote name: ${remote}`);
  }
}

function parseOriginDefault(output: string): OriginDefault {
  const lines = output.split(/\r?\n/u).filter((line) => line.length > 0);
  const symbolic = lines.filter((line) => line.startsWith("ref:"));
  const heads = lines.filter((line) => !line.startsWith("ref:"));
  if (symbolic.length !== 1 || heads.length !== 1) {
    throw new Error("Unable to determine one current origin default branch and revision");
  }
  const symbolicMatch = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/u.exec(symbolic[0]!);
  const headMatch = /^([0-9a-fA-F]{40,64})\s+HEAD$/u.exec(heads[0]!);
  if (!symbolicMatch || !headMatch) {
    throw new Error("Malformed origin default branch response");
  }
  const branch = symbolicMatch[1]!;
  assertSafeGitBranch(branch, "Origin default branch");
  return { branch, sha: headMatch[1]!.toLowerCase() };
}

function parseWorktrees(output: string): WorktreeRecord[] {
  if (output.length === 0) return [];
  const records: WorktreeRecord[] = [];
  let current: { path?: string; branch?: string } = {};
  for (const field of output.split("\0")) {
    if (field === "") {
      if (current.path !== undefined) records.push(current as WorktreeRecord);
      current = {};
    } else if (field.startsWith("worktree ")) {
      current.path = field.slice("worktree ".length);
    } else if (field.startsWith("branch refs/heads/")) {
      current.branch = field.slice("branch refs/heads/".length);
    }
  }
  if (current.path !== undefined) records.push(current as WorktreeRecord);
  return records;
}

function comparablePath(path: string): string {
  const normalized = normalize(resolve(path));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export class WorkspaceManager implements TicketWorkspaceManager {
  readonly #repositoryRoot: string;
  readonly #worktreeRoot: string;
  readonly #repositorySlug: string | undefined;
  readonly #runner: WorkspaceCommandRunner;
  readonly #fileSystem: WorkspaceFileSystem;

  constructor(options: WorkspaceManagerOptions) {
    if (!isAbsolute(options.repositoryRoot)) {
      throw new Error("Workspace repository root must be absolute");
    }
    this.#repositoryRoot = resolve(options.repositoryRoot);
    this.#worktreeRoot = join(this.#repositoryRoot, ".worktree");
    this.#repositorySlug = options.repositorySlug;
    this.#runner = options.runner ?? processWorkspaceCommandRunner;
    this.#fileSystem = options.fileSystem ?? processWorkspaceFileSystem;
  }

  async prepare(request: TicketWorkspaceRequest): Promise<TicketWorkspaceIdentity> {
    switch (request.skillName) {
      case "prototype":
        return this.preparePrototypeIssue(request.item.number);
      case "implement":
        return this.prepareProductionIssue(request.item.number);
      case "code-review": {
        if (!request.item.headSha || !request.item.headBranch || !request.item.headRepository) {
          throw new Error(`Pull request #${request.item.number} lacks exact writable head identity`);
        }
        if (!this.#repositorySlug) {
          throw new Error("Review workspace preparation requires the base repository identity");
        }
        if (request.item.headRepository.toLowerCase() !== this.#repositorySlug.toLowerCase()) {
          throw new Error(
            `Pull request #${request.item.number} uses fork head ${request.item.headRepository}; no writable head remote is configured`,
          );
        }
        return this.prepareReview({
          pullRequestNumber: request.item.number,
          headSha: request.item.headSha,
          headBranch: request.item.headBranch,
          pushRemote: "origin",
          existingWorkspace: request.existing,
        });
      }
    }
  }

  async completeReview(item: TicketWorkspaceRequest["item"], workspace: TicketWorkspaceIdentity): Promise<void> {
    if (item.kind !== "pull-request" || item.merged !== true) {
      throw new Error("Review workspace cleanup requires fresh merged pull-request proof");
    }
    if (!this.#repositorySlug || !item.headRepository || !item.headBranch) {
      throw new Error("Review workspace cleanup requires repository and head identity");
    }
    await this.cleanupAfterSuccessfulMerge({
      mergeSucceeded: true,
      workspace,
      headRemote: "origin",
      headBranch: item.headBranch,
      sameRepository: item.headRepository.toLowerCase() === this.#repositorySlug.toLowerCase(),
    });
  }

  async prepareProductionIssue(issueNumber: number): Promise<WorkspaceIdentity> {
    positiveInteger(issueNumber, "Production issue number");
    return this.#prepareIssue(`automode/issue-${issueNumber}`, `issue-${issueNumber}`);
  }

  async preparePrototypeIssue(issueNumber: number): Promise<WorkspaceIdentity> {
    positiveInteger(issueNumber, "Prototype issue number");
    return this.#prepareIssue(`automode/prototype-${issueNumber}`, `prototype-${issueNumber}`);
  }

  async prepareReview(request: ReviewWorkspaceRequest): Promise<WorkspaceIdentity> {
    const pullRequestNumber = positiveInteger(request.pullRequestNumber, "Pull request number");
    const expectedHead = normalizedSha(request.headSha, "Pull request head revision");
    assertSafeGitBranch(request.headBranch, "Pull request head branch");
    assertSafeRemote(request.pushRemote);
    const fetchedRef = `refs/automode/pull/${pullRequestNumber}/head`;
    await this.#runner.run(
      "git",
      ["fetch", "--force", "origin", `+refs/pull/${pullRequestNumber}/head:${fetchedRef}`],
      this.#repositoryRoot,
    );
    const fetchedHead = normalizedSha((await this.#runner.run(
      "git",
      ["rev-parse", "--verify", `${fetchedRef}^{commit}`],
      this.#repositoryRoot,
    )).trim(), "Fetched pull request head revision");
    if (fetchedHead !== expectedHead) {
      throw new Error(
        `Fetched pull request #${pullRequestNumber} head ${fetchedHead} did not match expected ${expectedHead}`,
      );
    }

    const identity = request.existingWorkspace === undefined
      ? this.#identity(`automode/review-pr-${pullRequestNumber}`, `review-pr-${pullRequestNumber}`)
      : this.#assertProductionIdentity(request.existingWorkspace);
    await this.#prepareIdentity(identity, fetchedRef, expectedHead);
    try {
      await this.#runner.run(
        "git",
        ["push", "--dry-run", "--porcelain", request.pushRemote, `HEAD:refs/heads/${request.headBranch}`],
        identity.worktree,
      );
    } catch (error) {
      throw new Error(
        `Review workspace for pull request #${pullRequestNumber} cannot push fixes to ${request.pushRemote}/${request.headBranch}`,
        { cause: error },
      );
    }
    return identity;
  }

  async cleanupAfterSuccessfulMerge(request: MergedWorkspaceCleanupRequest): Promise<void> {
    if (!request.mergeSucceeded) {
      throw new Error("Workspace cleanup requires a successful merge");
    }
    const workspace = this.#assertCleanupIdentity(request.workspace);
    assertSafeRemote(request.headRemote);
    assertSafeGitBranch(request.headBranch, "Merged pull request head branch");
    const records = await this.#worktrees();
    const branchRecord = records.find((record) => record.branch === workspace.branch);
    const pathRecord = records.find((record) => comparablePath(record.path) === comparablePath(workspace.worktree));
    if (branchRecord && comparablePath(branchRecord.path) !== comparablePath(workspace.worktree)) {
      throw new Error(`Cleanup branch ${workspace.branch} is checked out in unexpected worktree ${branchRecord.path}`);
    }
    if (pathRecord && pathRecord.branch !== workspace.branch) {
      throw new Error(
        `Cleanup path ${workspace.worktree} is registered to ${pathRecord.branch ?? "a detached revision"}`,
      );
    }

    const directoryExists = await this.#fileSystem.exists(workspace.worktree);
    if (branchRecord && pathRecord) {
      await this.#runner.run(
        "git",
        ["worktree", "remove", ...(directoryExists ? [] : ["--force"]), workspace.worktree],
        this.#repositoryRoot,
      );
    } else if (directoryExists) {
      await this.#fileSystem.removeDirectory(workspace.worktree);
    }
    if (await this.#fileSystem.exists(workspace.worktree)) {
      throw new Error(`Merged workspace directory still exists after cleanup: ${workspace.worktree}`);
    }

    if (await this.#branchExists(workspace.branch)) {
      await this.#runner.run("git", ["branch", "-D", workspace.branch], this.#repositoryRoot);
    }
    if (request.sameRepository && await this.#remoteBranchExists(request.headRemote, request.headBranch)) {
      await this.#runner.run(
        "git",
        ["push", request.headRemote, "--delete", request.headBranch],
        this.#repositoryRoot,
      );
    }
  }

  async #prepareIssue(branch: string, directory: string): Promise<WorkspaceIdentity> {
    const identity = this.#identity(branch, directory);
    const originDefault = await this.#refreshOriginDefault();
    await this.#prepareIdentity(identity, `refs/remotes/origin/${originDefault.branch}`);
    return identity;
  }

  async #prepareIdentity(identity: WorkspaceIdentity, startRef: string, expectedHead?: string): Promise<void> {
    const { branch } = identity;
    const branchExists = await this.#branchExists(branch);
    const records = await this.#worktrees();
    const branchRecord = records.find((record) => record.branch === branch);
    const pathRecord = records.find((record) => comparablePath(record.path) === comparablePath(identity.worktree));
    const directoryExists = await this.#fileSystem.exists(identity.worktree);

    if (branchRecord && comparablePath(branchRecord.path) !== comparablePath(identity.worktree)) {
      throw new Error(`Branch ${branch} is checked out in unexpected worktree ${branchRecord.path}`);
    }
    if (pathRecord && pathRecord.branch !== branch) {
      throw new Error(`Workspace path ${identity.worktree} is registered to ${pathRecord.branch ?? "a detached revision"}`);
    }
    if ((branchRecord || pathRecord) && !branchExists) {
      throw new Error(`Workspace ${branch} is registered without its local branch`);
    }
    if (branchExists && expectedHead !== undefined) {
      const branchHead = normalizedSha((await this.#runner.run(
        "git",
        ["rev-parse", "--verify", `${branch}^{commit}`],
        this.#repositoryRoot,
      )).trim(), `Workspace branch ${branch} revision`);
      if (branchHead !== expectedHead) {
        throw new Error(`Workspace branch ${branch} is at ${branchHead}, expected ${expectedHead}`);
      }
    }
    if (branchRecord && pathRecord) {
      if (!directoryExists) {
        await this.#runner.run(
          "git",
          ["worktree", "remove", "--force", identity.worktree],
          this.#repositoryRoot,
        );
        await this.#runner.run(
          "git",
          ["worktree", "add", identity.worktree, branch],
          this.#repositoryRoot,
        );
        return;
      }
      return;
    }
    if (directoryExists) {
      throw new Error(`Unregistered workspace path already exists: ${identity.worktree}`);
    }
    if (branchExists) {
      await this.#runner.run(
        "git",
        ["worktree", "add", identity.worktree, branch],
        this.#repositoryRoot,
      );
      return;
    }

    await this.#runner.run(
      "git",
      ["worktree", "add", "-b", branch, identity.worktree, startRef],
      this.#repositoryRoot,
    );
  }

  async #refreshOriginDefault(): Promise<OriginDefault> {
    const remote = parseOriginDefault(await this.#runner.run(
      "git",
      ["ls-remote", "--symref", "origin", "HEAD"],
      this.#repositoryRoot,
    ));
    await this.#runner.run(
      "git",
      [
        "fetch",
        "--prune",
        "origin",
        `+refs/heads/${remote.branch}:refs/remotes/origin/${remote.branch}`,
      ],
      this.#repositoryRoot,
    );
    const fetched = (await this.#runner.run(
      "git",
      ["rev-parse", "--verify", `refs/remotes/origin/${remote.branch}^{commit}`],
      this.#repositoryRoot,
    )).trim().toLowerCase();
    if (fetched !== remote.sha) {
      throw new Error(`Fetched origin default revision ${fetched} did not match advertised revision ${remote.sha}`);
    }
    return remote;
  }

  async #branchExists(branch: string): Promise<boolean> {
    const output = (await this.#runner.run(
      "git",
      ["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`],
      this.#repositoryRoot,
    )).trim();
    if (output === "") return false;
    if (output !== `refs/heads/${branch}`) {
      throw new Error(`Ambiguous local branch lookup for ${branch}`);
    }
    return true;
  }

  async #worktrees(): Promise<WorktreeRecord[]> {
    return parseWorktrees(await this.#runner.run(
      "git",
      ["worktree", "list", "--porcelain", "-z"],
      this.#repositoryRoot,
    ));
  }

  async #remoteBranchExists(remote: string, branch: string): Promise<boolean> {
    const ref = `refs/heads/${branch}`;
    const output = (await this.#runner.run(
      "git",
      ["ls-remote", "--heads", remote, ref],
      this.#repositoryRoot,
    )).trim();
    if (output === "") return false;
    const lines = output.split(/\r?\n/u);
    if (lines.length !== 1 || !new RegExp(`^[0-9a-fA-F]{40,64}\\s+${ref.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u").test(lines[0]!)) {
      throw new Error(`Ambiguous remote branch lookup for ${remote}/${branch}`);
    }
    return true;
  }

  #identity(branch: string, directory: string): WorkspaceIdentity {
    assertSafeGitBranch(branch, "Workspace branch");
    const worktree = resolve(this.#worktreeRoot, directory);
    const withinRoot = relative(this.#worktreeRoot, worktree);
    if (withinRoot === "" || withinRoot === ".." || withinRoot.startsWith(`..${sep}`) || isAbsolute(withinRoot)) {
      throw new Error(`Unsafe workspace path: ${worktree}`);
    }
    return { branch, worktree };
  }

  #assertProductionIdentity(identity: WorkspaceIdentity): WorkspaceIdentity {
    const match = /^automode\/issue-([1-9][0-9]*)$/u.exec(identity.branch);
    if (!match) throw new Error(`Review cannot reuse non-production workspace branch ${identity.branch}`);
    const expected = this.#identity(identity.branch, `issue-${match[1]}`);
    if (comparablePath(identity.worktree) !== comparablePath(expected.worktree)) {
      throw new Error(`Review production workspace path does not match ${identity.branch}`);
    }
    return expected;
  }

  #assertCleanupIdentity(identity: WorkspaceIdentity): WorkspaceIdentity {
    const match = /^automode\/(issue-([1-9][0-9]*)|review-pr-([1-9][0-9]*))$/u.exec(identity.branch);
    if (!match) throw new Error(`Refusing to clean unmanaged workspace branch ${identity.branch}`);
    const directory = match[1]!;
    const expected = this.#identity(identity.branch, directory);
    if (comparablePath(identity.worktree) !== comparablePath(expected.worktree)) {
      throw new Error(`Cleanup workspace path does not match ${identity.branch}`);
    }
    return expected;
  }
}
