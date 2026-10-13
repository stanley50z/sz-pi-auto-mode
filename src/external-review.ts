import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { ReviewRoundContext } from "./panel-runtime.js";

export interface ExternalReviewBot {
  readonly name: string;
  readonly comment: string;
  readonly author: string;
  readonly checkName?: string;
  readonly completionPattern?: string;
}

/** Validates review-bot settings before they cross the Ticket Session process boundary. */
export function parseExternalReviewBots(value: unknown): readonly ExternalReviewBot[] {
  if (!Array.isArray(value)) throw new Error("External review bots must be an array");
  const names = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Each external review bot must be an object");
    const bot = entry as Record<string, unknown>;
    if (Object.keys(bot).some((key) => !["name", "comment", "author", "checkName", "completionPattern"].includes(key))) {
      throw new Error("Unknown external review bot setting");
    }
    for (const key of ["name", "comment", "author"]) {
      if (typeof bot[key] !== "string" || !bot[key].trim()) throw new Error(`External review bot requires ${key}`);
    }
    const { name, comment, author } = bot as unknown as ExternalReviewBot;
    if (names.has(name.toLowerCase())) throw new Error(`Duplicate external review bot: ${name}`);
    names.add(name.toLowerCase());
    if (!/^[a-z0-9-]+(?:\[bot\])?$/i.test(author)) throw new Error(`Invalid external review author: ${author}`);
    for (const key of ["checkName", "completionPattern"]) {
      if (bot[key] !== undefined && (typeof bot[key] !== "string" || !bot[key].trim())) throw new Error(`Invalid external review ${key}`);
    }
    if (bot.checkName !== undefined && bot.completionPattern !== undefined) throw new Error("Choose checkName or completionPattern, not both");
    if (typeof bot.completionPattern === "string") new RegExp(bot.completionPattern);
    return Object.freeze({ name, comment, author, ...(typeof bot.checkName === "string" ? { checkName: bot.checkName } : {}), ...(typeof bot.completionPattern === "string" ? { completionPattern: bot.completionPattern } : {}) });
  });
}

/** Repository settings replace global defaults; an empty bot list explicitly disables them. */
export function loadExternalReviewBots(repository: string, normalAgentDir: string): readonly ExternalReviewBot[] {
  const local = join(repository, ".pi", "automode-review.json");
  const global = join(normalAgentDir, "automode-review.json");
  const file = existsSync(local) ? local : global;
  if (!existsSync(file)) return [];
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "bots")) {
    throw new Error(`Invalid external review configuration: ${file}`);
  }
  return parseExternalReviewBots((value as { bots?: unknown }).bots);
}

export interface ExternalReviewCommandRunner {
  run(command: string, args: readonly string[], cwd: string, signal?: AbortSignal): Promise<string>;
}
const execFileAsync = promisify(execFile);
const processRunner: ExternalReviewCommandRunner = {
  async run(command, args, cwd, signal) {
    const result = await execFileAsync(command, [...args], { cwd, signal, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    return result.stdout;
  },
};

interface Review {
  id: number;
  user: { login: string };
  body: string | null;
  commit_id: string;
  submitted_at: string | null;
  state: string;
  html_url?: string;
}
interface Comment {
  id: number;
  user: { login: string };
  body: string;
  created_at: string;
  updated_at: string;
  commit_id?: string;
  path?: string;
  line?: number | null;
  html_url?: string;
}
interface Check {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  started_at?: string;
  completed_at?: string | null;
  output?: { title: string | null; summary: string | null; text?: string | null };
  html_url?: string;
}
interface Snapshot {
  reviews: Review[];
  comments: Comment[];
  checks: Check[];
}
interface BotRound {
  bot: ExternalReviewBot;
  baseline: Snapshot;
  status: "posting" | "triggered";
  trigger?: { id: number; created_at: string };
}
interface RoundState {
  round: number;
  headSha: string;
  configuration: readonly ExternalReviewBot[];
  bots: BotRound[];
}
export interface ExternalReviewReport {
  readonly bot: string;
  readonly author: string;
  readonly round: number;
  readonly headSha: string;
  readonly reviews: readonly Review[];
  readonly comments: readonly Comment[];
  readonly checks: readonly Check[];
}
export interface GitHubExternalReviewsOptions {
  readonly cwd: string;
  readonly itemUrl: string;
  readonly bots: readonly ExternalReviewBot[];
  readonly stateDirectory: string;
  readonly runner?: ExternalReviewCommandRunner;
  readonly wait?: (signal?: AbortSignal) => Promise<void>;
}

/** Posts exact trigger comments once per recorded round, then waits for fresh, head-pinned bot results. */
export class GitHubExternalReviews {
  readonly #options: GitHubExternalReviewsOptions;
  readonly #base: string;
  readonly #number: string;
  readonly #runner: ExternalReviewCommandRunner;

  constructor(options: GitHubExternalReviewsOptions) {
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)\/?$/u.exec(options.itemUrl);
    if (!match) throw new Error("External reviews require a GitHub pull-request URL");
    this.#base = `repos/${match[1]}/${match[2]}`;
    this.#number = match[3]!;
    this.#options = { ...options, bots: parseExternalReviewBots(options.bots) };
    this.#runner = options.runner ?? processRunner;
    mkdirSync(options.stateDirectory, { recursive: true });
  }

  async #api<T>(endpoint: string, signal?: AbortSignal, body?: string): Promise<T> {
    signal?.throwIfAborted();
    const args = body === undefined
      ? ["api", "--paginate", "--slurp", endpoint]
      : ["api", "--method", "POST", endpoint, "-f", `body=${body}`];
    const parsed: unknown = JSON.parse(await this.#runner.run("gh", args, this.#options.cwd, signal));
    // Paginated endpoints return pages. POST returns one object.
    if (body !== undefined) return parsed as T;
    if (!Array.isArray(parsed)) throw new Error(`Expected paginated GitHub response: ${endpoint}`);
    return parsed as T;
  }

  async #assertHead(context: ReviewRoundContext, signal?: AbortSignal): Promise<void> {
    const pages = await this.#api<Array<{ state: string; head: { sha: string } }>>(`${this.#base}/pulls/${this.#number}`, signal);
    const pr = pages[0];
    if (pr?.state !== "open" || pr.head.sha !== context.headSha) throw new Error("External review pull request closed or changed from the pinned head");
  }

  async #snapshot(headSha: string, signal?: AbortSignal): Promise<Snapshot> {
    const [reviews, topLevel, inline, checks] = await Promise.all([
      this.#api<Review[][]>(`${this.#base}/pulls/${this.#number}/reviews?per_page=100`, signal),
      this.#api<Comment[][]>(`${this.#base}/issues/${this.#number}/comments?per_page=100`, signal),
      this.#api<Comment[][]>(`${this.#base}/pulls/${this.#number}/comments?per_page=100`, signal),
      this.#api<Array<{ check_runs: Check[] }>>(`${this.#base}/commits/${headSha}/check-runs?per_page=100&filter=all`, signal),
    ]);
    return { reviews: reviews.flat(), comments: [...topLevel.flat(), ...inline.flat()], checks: checks.flatMap((page) => page.check_runs) };
  }

  #file(context: ReviewRoundContext): string {
    const key = createHash("sha256").update(JSON.stringify([this.#options.itemUrl, context.round, context.headSha])).digest("hex");
    return join(this.#options.stateDirectory, `${key}.json`);
  }

  #save(context: ReviewRoundContext, state: RoundState): void {
    const file = this.#file(context);
    writeFileSync(`${file}.tmp`, `${JSON.stringify(state)}\n`, "utf8");
    renameSync(`${file}.tmp`, file);
  }

  #log(message: string): void {
    appendFileSync(join(this.#options.stateDirectory, "activity.log"), `${new Date().toISOString()} ${this.#options.itemUrl} ${message}\n`, "utf8");
  }

  #diagnose(error: unknown): void {
    const report = error instanceof Error ? error.stack ?? error.message : String(error);
    this.#log(report);
    writeFileSync(join(this.#options.stateDirectory, "crash-report.txt"), `${report}\n`, "utf8");
  }

  async begin(context: ReviewRoundContext, signal?: AbortSignal): Promise<void> {
    try {
      if (!Number.isInteger(context.round) || context.round < 1 || context.round > 3 || !/^[a-f0-9]{40,64}$/i.test(context.headSha) || !context.brief?.trim()) {
        throw new Error("External review requires a substantive round, exact head SHA, and brief");
      }
      await this.#assertHead(context, signal);
      const file = this.#file(context);
      const state: RoundState = existsSync(file)
        ? JSON.parse(readFileSync(file, "utf8")) as RoundState
        : { round: context.round, headSha: context.headSha, configuration: this.#options.bots, bots: [] };
      if (state.round !== context.round || state.headSha !== context.headSha) throw new Error("External review journal does not match the round");
      if (JSON.stringify(state.configuration) !== JSON.stringify(this.#options.bots)) throw new Error("External review configuration changed during round");
      for (const bot of this.#options.bots) {
        const previous = state.bots.find((entry) => entry.bot.name === bot.name);
        if (previous) {
          if (JSON.stringify(previous.bot) !== JSON.stringify(bot)) throw new Error(`External review configuration changed during round: ${bot.name}`);
          if (previous.status !== "triggered" || !previous.trigger) throw new Error(`External review trigger delivery is uncertain for ${bot.name}; inspect ${file} before retrying`);
          continue;
        }
        const entry: BotRound = { bot, baseline: await this.#snapshot(context.headSha, signal), status: "posting" };
        state.bots.push(entry);
        this.#save(context, state);
        await this.#assertHead(context, signal);
        entry.trigger = await this.#api<{ id: number; created_at: string }>(`${this.#base}/issues/${this.#number}/comments`, signal, bot.comment);
        if (!Number.isSafeInteger(entry.trigger.id) || !entry.trigger.created_at) throw new Error("GitHub did not return trigger comment identity");
        entry.status = "triggered";
        this.#save(context, state);
        this.#log(`Round ${context.round} ${bot.name}: triggered comment ${entry.trigger.id} on ${context.headSha}`);
      }
    } catch (error) {
      this.#diagnose(error);
      throw error;
    }
  }

  async wait(context: ReviewRoundContext, signal?: AbortSignal): Promise<readonly ExternalReviewReport[]> {
    try {
      const state = JSON.parse(readFileSync(this.#file(context), "utf8")) as RoundState;
      if (state.round !== context.round || state.headSha !== context.headSha || JSON.stringify(state.configuration) !== JSON.stringify(this.#options.bots)
        || state.bots.length !== this.#options.bots.length) throw new Error("External review journal does not match the configured round");
      let completionObserved = false;
      for (;;) {
        await this.#assertHead(context, signal);
        const snapshot = await this.#snapshot(context.headSha, signal);
        const reports: ExternalReviewReport[] = [];
        for (const entry of state.bots) {
          if (!entry.trigger || entry.status !== "triggered") throw new Error("External review trigger is not confirmed");
          const { bot, baseline, trigger } = entry;
          const reviews = snapshot.reviews.filter((review) => review.user.login.toLowerCase() === bot.author.toLowerCase()
            && review.commit_id === context.headSha && review.submitted_at && review.submitted_at >= trigger.created_at
            && !["PENDING", "DISMISSED"].includes(review.state) && !baseline.reviews.some((old) => old.id === review.id && old.submitted_at === review.submitted_at));
          const comments = snapshot.comments.filter((comment) => comment.user.login.toLowerCase() === bot.author.toLowerCase()
            && (comment.commit_id === undefined || comment.commit_id === context.headSha) && comment.updated_at >= trigger.created_at
            && !baseline.comments.some((old) => old.id === comment.id && old.updated_at === comment.updated_at && old.body === comment.body));
          const checks = snapshot.checks.filter((check) => check.name === bot.checkName && check.head_sha === context.headSha
            && check.status === "completed" && check.started_at !== undefined && check.started_at >= trigger.created_at
            && !baseline.checks.some((old) => old.id === check.id && old.started_at === check.started_at));
          if (checks.some((check) => ["cancelled", "timed_out", "action_required", "stale", "skipped"].includes(check.conclusion ?? ""))) {
            throw new Error(`${bot.name} review check did not complete successfully`);
          }
          const completionPattern = bot.completionPattern && new RegExp(bot.completionPattern);
          const completed = bot.checkName ? checks.length > 0
            : completionPattern ? comments.some((comment) => completionPattern.test(comment.body))
              : reviews.length > 0;
          if (completed) reports.push({ bot: bot.name, author: bot.author, round: context.round, headSha: context.headSha, reviews, comments, checks });
        }
        if (reports.length === this.#options.bots.length) {
          // Fetch evidence again after completion is known: parallel reads are not an atomic snapshot.
          if (!completionObserved) {
            completionObserved = true;
            continue;
          }
          await this.#assertHead(context, signal);
          this.#log(`Round ${context.round}: all external reviews arrived (${reports.map((report) => report.bot).join(", ")})`);
          return reports;
        }
        completionObserved = false;
        this.#log(`Round ${context.round}: waiting for ${state.bots.filter((entry) => !reports.some((report) => report.bot === entry.bot.name)).map((entry) => entry.bot.name).join(", ")}`);
        await (this.#options.wait ? this.#options.wait(signal) : delay(30_000, undefined, { signal }));
      }
    } catch (error) {
      this.#diagnose(error);
      throw error;
    }
  }
}
