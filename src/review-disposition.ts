import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Usage } from "@earendil-works/pi-ai";
import { formatUsageSummary } from "./usage.js";

const execFileAsync = promisify(execFile);

export interface ReviewDispositionPublisher {
  publish(itemUrl: string, disposition: string, usage: Usage): Promise<void>;
}

export interface ReviewDispositionCommandRunner {
  run(command: string, args: readonly string[], cwd: string): Promise<void>;
}

const processReviewDispositionCommandRunner: ReviewDispositionCommandRunner = {
  async run(command, args, cwd) {
    await execFileAsync(command, [...args], {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
  },
};

export interface GitHubReviewDispositionPublisherOptions {
  readonly cwd: string;
  readonly runner?: ReviewDispositionCommandRunner;
}

/** Posts the final Review Session disposition only after complete session usage is known. */
export class GitHubReviewDispositionPublisher implements ReviewDispositionPublisher {
  readonly #cwd: string;
  readonly #runner: ReviewDispositionCommandRunner;

  constructor(options: GitHubReviewDispositionPublisherOptions) {
    this.#cwd = options.cwd;
    this.#runner = options.runner ?? processReviewDispositionCommandRunner;
  }

  async publish(itemUrl: string, disposition: string, usage: Usage): Promise<void> {
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)\/?$/u.exec(itemUrl);
    if (!match) throw new Error("Final Auto-Review disposition requires a GitHub pull-request URL");
    const body = disposition.trim();
    if (!body) throw new Error("Final Auto-Review disposition cannot be empty");
    const [, owner, repository, number] = match;
    const usageSection = [
      "### Automode usage",
      "",
      `Review Session plus all Reviewer sessions in every round. ${formatUsageSummary(usage)}`,
    ].join("\n");
    await this.#runner.run("gh", [
      "api",
      "--method", "POST",
      `repos/${owner}/${repository}/issues/${number}/comments`,
      "-f",
      `body=${body}\n\n${usageSection}`,
    ], this.#cwd);
  }
}
