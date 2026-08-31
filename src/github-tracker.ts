import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  Tracker,
  TrackerBookkeeping,
  TrackerBookkeepingSnapshot,
  TrackerCommentSnapshot,
  TrackerItemKind,
  TrackerItemReference,
  TrackerItemSnapshot,
  TrackerItemState,
  TrackerSnapshot,
} from "./tracker.js";

const execFileAsync = promisify(execFile);

export const AUTOMODE_BOOKKEEPING_MARKER = "<!-- sz-pi-automode:bookkeeping:v1 -->";
const AUTOMODE_BOOKKEEPING_DATA_PREFIX = "<!-- sz-pi-automode:data:";

export interface GitHubCommandRunner {
  run(command: string, args: readonly string[], cwd: string): Promise<string>;
}

export interface GitHubTrackerOptions {
  readonly cwd: string;
  readonly repository: string;
  readonly actor: string;
  readonly runner?: GitHubCommandRunner;
}

export const processGitHubCommandRunner: GitHubCommandRunner = {
  async run(command, args, cwd) {
    const result = await execFileAsync(command, [...args], {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    return result.stdout;
  },
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, context: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Malformed GitHub ${context}: expected an object`);
  }
  return value as UnknownRecord;
}

function stringField(value: unknown, context: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`Malformed GitHub ${context}: expected a string`);
  }
  return value;
}

function positiveInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Malformed GitHub ${context}: expected a positive integer`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Malformed GitHub ${context}: expected a non-negative integer`);
  }
  return value as number;
}

function timestamp(value: unknown, context: string): string {
  const source = stringField(value, context);
  const date = new Date(source);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Malformed GitHub ${context}: expected an ISO timestamp`);
  }
  return date.toISOString();
}

function parseJson(output: string, context: string): unknown {
  try {
    return JSON.parse(output) as unknown;
  } catch (error) {
    throw new Error(`Malformed GitHub ${context}: invalid JSON`, { cause: error });
  }
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function declaredBlockingIssueNumbers(body: string): number[] {
  const fallbackLine = /^Blocked by:[ \t]*([^\r\n]*)/iu.exec(body);
  const heading = /^##[ \t]+Blocked by[ \t]*$/imu.exec(body);
  if (!fallbackLine && !heading) return [];
  let section = fallbackLine?.[1];
  if (section === undefined) {
    const remainder = body.slice(heading!.index + heading![0].length);
    const nextHeading = /\r?\n##[ \t]+/u.exec(remainder);
    section = nextHeading ? remainder.slice(0, nextHeading.index) : remainder;
  }
  const numbers = new Set<number>();
  for (const match of section.matchAll(/#([1-9][0-9]*)\b/gu)) numbers.add(Number(match[1]));
  return [...numbers].sort((left, right) => left - right);
}

function closingIssueNumbers(body: string, repository: string): number[] {
  const numbers = new Set<number>();
  const escapedRepository = repository.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const closingReference = new RegExp(
    `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+(?:#([1-9][0-9]*)|https://github\\.com/${escapedRepository}/issues/([1-9][0-9]*))`,
    "giu",
  );
  for (const match of body.matchAll(closingReference)) numbers.add(Number(match[1] ?? match[2]));
  return [...numbers].sort((left, right) => left - right);
}

function uniqueSorted(values: readonly string[], context: string): string[] {
  const sorted = [...values].sort(compareText);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === sorted[index - 1]) {
      throw new Error(`Ambiguous GitHub ${context}: duplicate ${sorted[index]}`);
    }
  }
  return sorted;
}

function normalizeState(value: unknown, context: string): TrackerItemState {
  if (value !== "open" && value !== "closed") {
    throw new Error(`Malformed GitHub ${context}: expected open or closed state`);
  }
  return value;
}

function normalizeLabels(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Malformed GitHub ${context}: labels must be an array`);
  return uniqueSorted(value.map((entry, index) => {
    const label = record(entry, `${context} label ${index}`);
    return stringField(label.name, `${context} label ${index} name`);
  }), `${context} labels`);
}

function normalizeAssignees(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Malformed GitHub ${context}: assignees must be an array`);
  return uniqueSorted(value.map((entry, index) => {
    const assignee = record(entry, `${context} assignee ${index}`);
    return stringField(assignee.login, `${context} assignee ${index} login`);
  }), `${context} assignees`);
}

function isBookkeepingBody(body: string): boolean {
  return body.split(/\r?\n/, 1)[0] === AUTOMODE_BOOKKEEPING_MARKER;
}

function normalizeBookkeeping(value: unknown, context: string): TrackerBookkeeping {
  const source = record(value, context);
  const required = [
    "attempt",
    "item",
    "lifecycle",
    "materialVersion",
    "skillName",
    "stage",
    "version",
  ];
  const optional = [
    "coordinatorId",
    "diagnostic",
    "endedAt",
    "processId",
    "sessionFile",
    "sessionId",
    "startedAt",
    "workspace",
  ];
  const keys = Object.keys(source);
  if (
    required.some((key) => !(key in source))
    || keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    throw new Error(`Malformed GitHub ${context}: unexpected bookkeeping fields`);
  }
  if (source.version !== 1) throw new Error(`Malformed GitHub ${context}: invalid version`);
  const stage = source.stage;
  if (
    stage !== "auto-triage"
    && stage !== "auto-grilling"
    && stage !== "auto-implement"
    && stage !== "auto-review"
  ) {
    throw new Error(`Malformed GitHub ${context}: invalid Automation Stage`);
  }
  const skillName = source.skillName;
  if (
    skillName !== "triage"
    && skillName !== "grilling"
    && skillName !== "prototype"
    && skillName !== "implement"
    && skillName !== "code-review"
  ) throw new Error(`Malformed GitHub ${context}: invalid skill name`);
  const lifecycle = source.lifecycle;
  if (
    lifecycle !== "running"
    && lifecycle !== "awaiting-feedback"
    && lifecycle !== "retrying"
    && lifecycle !== "succeeded"
    && lifecycle !== "exhausted"
    && lifecycle !== "failed"
  ) throw new Error(`Malformed GitHub ${context}: invalid lifecycle`);
  const item = record(source.item, `${context} item`);
  const itemKeys = Object.keys(item).sort(compareText);
  if (JSON.stringify(itemKeys) !== JSON.stringify(["kind", "number", "url"])) {
    throw new Error(`Malformed GitHub ${context}: invalid item reference fields`);
  }
  if (item.kind !== "issue" && item.kind !== "pull-request") {
    throw new Error(`Malformed GitHub ${context}: invalid item kind`);
  }
  let workspace: { branch: string; worktree: string } | undefined;
  if (source.workspace !== undefined) {
    const rawWorkspace = record(source.workspace, `${context} workspace`);
    const workspaceKeys = Object.keys(rawWorkspace).sort(compareText);
    if (JSON.stringify(workspaceKeys) !== JSON.stringify(["branch", "worktree"])) {
      throw new Error(`Malformed GitHub ${context}: invalid workspace fields`);
    }
    workspace = {
      branch: stringField(rawWorkspace.branch, `${context} workspace branch`),
      worktree: stringField(rawWorkspace.worktree, `${context} workspace worktree`),
    };
  }
  const optionalString = (field: "coordinatorId" | "diagnostic" | "processId" | "sessionFile" | "sessionId") =>
    source[field] === undefined ? undefined : stringField(source[field], `${context} ${field}`);
  const startedAt = source.startedAt === undefined
    ? undefined
    : timestamp(source.startedAt, `${context} startedAt`);
  const endedAt = source.endedAt === undefined
    ? undefined
    : timestamp(source.endedAt, `${context} endedAt`);
  if (endedAt !== undefined && startedAt === undefined) {
    throw new Error(`Malformed GitHub ${context}: endedAt requires startedAt`);
  }
  return {
    version: 1,
    ...(optionalString("coordinatorId") === undefined
      ? {}
      : { coordinatorId: optionalString("coordinatorId") }),
    item: {
      kind: item.kind,
      number: positiveInteger(item.number, `${context} item number`),
      url: stringField(item.url, `${context} item URL`),
    },
    stage,
    skillName,
    attempt: positiveInteger(source.attempt, `${context} attempt`),
    lifecycle,
    materialVersion: stringField(source.materialVersion, `${context} material version`),
    ...(optionalString("processId") === undefined ? {} : { processId: optionalString("processId") }),
    ...(optionalString("sessionId") === undefined ? {} : { sessionId: optionalString("sessionId") }),
    ...(optionalString("sessionFile") === undefined ? {} : { sessionFile: optionalString("sessionFile") }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(optionalString("diagnostic") === undefined ? {} : { diagnostic: optionalString("diagnostic") }),
  };
}

function parseBookkeepingBody(body: string, context: string): TrackerBookkeeping {
  const prefix = `${AUTOMODE_BOOKKEEPING_MARKER}\n`;
  if (!body.startsWith(prefix)) {
    throw new Error(`Malformed GitHub ${context}: invalid bookkeeping marker framing`);
  }
  const remainder = body.slice(prefix.length);
  let serialized = remainder;
  if (remainder.startsWith(AUTOMODE_BOOKKEEPING_DATA_PREFIX)) {
    const end = remainder.indexOf(" -->");
    const encoded = end < 0 ? "" : remainder.slice(AUTOMODE_BOOKKEEPING_DATA_PREFIX.length, end);
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
      throw new Error(`Malformed GitHub ${context}: invalid hidden bookkeeping data`);
    }
    serialized = Buffer.from(encoded, "base64").toString("utf8");
  }
  const envelope = record(parseJson(serialized, `${context} bookkeeping JSON`), `${context} bookkeeping`);
  if (envelope.version !== 1 || Object.keys(envelope).some((key) => key !== "version" && key !== "value")) {
    throw new Error(`Malformed GitHub ${context}: invalid bookkeeping envelope`);
  }
  return normalizeBookkeeping(envelope.value, `${context} bookkeeping value`);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>]/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
  })[character]!);
}

function renderBookkeeping(value: TrackerBookkeeping): string {
  const rows = [
    ["Stage", `\`${value.stage}\``],
    ["Skill", `\`${value.skillName}\``],
    ["Lifecycle", `\`${value.lifecycle}\``],
    ["Attempt", String(value.attempt)],
    ...(value.sessionId === undefined ? [] : [["Session", `<code>${escapeHtml(value.sessionId)}</code>`]]),
    ...(value.processId === undefined ? [] : [["Process", `<code>${escapeHtml(value.processId)}</code>`]]),
    ...(value.workspace === undefined
      ? []
      : [["Workspace branch", `<code>${escapeHtml(value.workspace.branch)}</code>`]]),
  ];
  const table = rows.map(([field, fieldValue]) => `| ${field} | ${fieldValue} |`).join("\n");
  const diagnostic = value.diagnostic === undefined
    ? ""
    : `\n\n**Diagnostic**\n\n<pre>${escapeHtml(value.diagnostic)}</pre>`;
  return `### Automode status\n\n| Field | Value |\n| --- | --- |\n${table}${diagnostic}`;
}

function serializeBookkeeping(value: TrackerBookkeeping): string {
  const normalized = normalizeBookkeeping(value, "bookkeeping update");
  const envelope = JSON.stringify({ version: 1, value: normalized });
  const hidden = Buffer.from(envelope, "utf8").toString("base64");
  return `${AUTOMODE_BOOKKEEPING_MARKER}\n${AUTOMODE_BOOKKEEPING_DATA_PREFIX}${hidden} -->\n\n${renderBookkeeping(normalized)}`;
}

interface NormalizedComments {
  readonly comments: readonly TrackerCommentSnapshot[];
  readonly bookkeeping: TrackerBookkeepingSnapshot | null;
  readonly bookkeepingRevision: string | null;
}

function normalizeComments(
  values: readonly unknown[],
  itemNumber: number,
  actor: string,
): NormalizedComments {
  const comments: TrackerCommentSnapshot[] = [];
  const bookkeeping: TrackerBookkeepingSnapshot[] = [];
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    const source = record(value, `comment ${index} on item #${itemNumber}`);
    const id = String(positiveInteger(source.id, `comment ${index} id on item #${itemNumber}`));
    if (seen.has(id)) throw new Error(`Ambiguous GitHub comments on item #${itemNumber}: duplicate id ${id}`);
    seen.add(id);
    const body = stringField(source.body, `comment ${id} body`, true);
    const user = record(source.user, `comment ${id} user`);
    const normalized: TrackerCommentSnapshot = {
      id,
      nodeId: stringField(source.node_id, `comment ${id} node id`),
      author: stringField(user.login, `comment ${id} author`),
      body,
      createdAt: timestamp(source.created_at, `comment ${id} created_at`),
      updatedAt: timestamp(source.updated_at, `comment ${id} updated_at`),
    };
    if (isBookkeepingBody(body)) {
      if (normalized.author !== actor) {
        throw new Error(`GitHub bookkeeping comment ${id} is not owned by ${actor}`);
      }
      bookkeeping.push({
        commentId: id,
        updatedAt: normalized.updatedAt,
        value: parseBookkeepingBody(body, `comment ${id}`),
      });
    } else {
      comments.push(normalized);
    }
  }
  if (bookkeeping.length > 1) {
    throw new Error(`Ambiguous GitHub bookkeeping on item #${itemNumber}: found ${bookkeeping.length} comments`);
  }
  comments.sort((left, right) => compareText(left.createdAt, right.createdAt) || compareText(left.id, right.id));
  const found = bookkeeping[0] ?? null;
  return {
    comments,
    bookkeeping: found,
    bookkeepingRevision: found ? sha256(found) : null,
  };
}

function flattenPages(value: unknown, context: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`Malformed GitHub ${context}: expected paginated arrays`);
  const flattened: unknown[] = [];
  for (const [index, page] of value.entries()) {
    if (!Array.isArray(page)) throw new Error(`Malformed GitHub ${context}: page ${index + 1} is not an array`);
    flattened.push(...page);
  }
  return flattened;
}

const PULL_REQUEST_COMMENTS_QUERY = `
  query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        comments(first: 100, after: $endCursor) {
          nodes {
            id
            databaseId
            body
            createdAt
            updatedAt
            author { login }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

function flattenPullRequestCommentPages(value: unknown, context: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`Malformed GitHub ${context}: expected paginated GraphQL results`);
  const flattened: unknown[] = [];
  for (const [index, valuePage] of value.entries()) {
    const page = record(valuePage, `${context} page ${index + 1}`);
    const data = record(page.data, `${context} page ${index + 1} data`);
    const repository = record(data.repository, `${context} page ${index + 1} repository`);
    const pullRequest = record(repository.pullRequest, `${context} page ${index + 1} pull request`);
    const comments = record(pullRequest.comments, `${context} page ${index + 1} comments`);
    if (!Array.isArray(comments.nodes)) {
      throw new Error(`Malformed GitHub ${context}: page ${index + 1} nodes must be an array`);
    }
    for (const [commentIndex, commentValue] of comments.nodes.entries()) {
      const comment = record(commentValue, `${context} page ${index + 1} comment ${commentIndex}`);
      const author = record(comment.author, `${context} page ${index + 1} comment ${commentIndex} author`);
      flattened.push({
        id: comment.databaseId,
        node_id: comment.id,
        body: comment.body,
        user: { login: author.login },
        created_at: comment.createdAt,
        updated_at: comment.updatedAt,
      });
    }
  }
  return flattened;
}

export class GitHubTracker implements Tracker {
  readonly #cwd: string;
  readonly #repository: string;
  readonly #actor: string;
  readonly #runner: GitHubCommandRunner;

  constructor(options: GitHubTrackerOptions) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(options.repository)) {
      throw new Error("GitHub tracker repository must be owner/name");
    }
    if (options.cwd.length === 0) throw new Error("GitHub tracker cwd is required");
    if (options.actor.length === 0) throw new Error("GitHub tracker actor is required");
    this.#cwd = options.cwd;
    this.#repository = options.repository;
    this.#actor = options.actor;
    this.#runner = options.runner ?? processGitHubCommandRunner;
  }

  async #paginated(endpoint: string, context: string): Promise<readonly unknown[]> {
    const output = await this.#runner.run(
      "gh",
      ["api", "--paginate", "--slurp", endpoint],
      this.#cwd,
    );
    return flattenPages(parseJson(output, context), context);
  }

  async #comments(number: number, kind: TrackerItemKind): Promise<NormalizedComments> {
    if (kind === "pull-request") {
      const [owner, name] = this.#repository.split("/") as [string, string];
      const context = `comments for pull request #${number}`;
      const output = await this.#runner.run(
        "gh",
        [
          "api",
          "graphql",
          "--paginate",
          "--slurp",
          "-F", `owner=${owner}`,
          "-F", `name=${name}`,
          "-F", `number=${number}`,
          "-f", `query=${PULL_REQUEST_COMMENTS_QUERY}`,
        ],
        this.#cwd,
      );
      return normalizeComments(
        flattenPullRequestCommentPages(parseJson(output, context), context),
        number,
        this.#actor,
      );
    }
    const endpoint = `repos/${this.#repository}/issues/${number}/comments?per_page=100`;
    return normalizeComments(
      await this.#paginated(endpoint, `comments for item #${number}`),
      number,
      this.#actor,
    );
  }

  #normalizeItem(
    issueValue: unknown,
    pullValue: unknown | undefined,
    normalizedComments: NormalizedComments,
  ): TrackerItemSnapshot {
    const issue = record(issueValue, "issue");
    const number = positiveInteger(issue.number, "issue number");
    const kind: TrackerItemKind = "pull_request" in issue ? "pull-request" : "issue";
    let headSha: string | undefined;
    let headBranch: string | undefined;
    let headRepository: string | undefined;
    let draft: boolean | undefined;
    let merged: boolean | undefined;
    if (kind === "pull-request") {
      if (pullValue === undefined) throw new Error(`Incomplete GitHub snapshot: pull request #${number} is missing`);
      const pull = record(pullValue, `pull request #${number}`);
      if (positiveInteger(pull.number, `pull request #${number} number`) !== number) {
        throw new Error(`Ambiguous GitHub pull request identity for #${number}`);
      }
      const head = record(pull.head, `pull request #${number} head`);
      headSha = stringField(head.sha, `pull request #${number} head revision`);
      headBranch = stringField(head.ref, `pull request #${number} head branch`);
      const headRepo = record(head.repo, `pull request #${number} head repository`);
      headRepository = stringField(headRepo.full_name, `pull request #${number} head repository name`);
      if (typeof pull.draft !== "boolean") {
        throw new Error(`Malformed GitHub pull request #${number}: draft must be boolean`);
      }
      draft = pull.draft;
      if (pull.merged_at !== null && typeof pull.merged_at !== "string") {
        throw new Error(`Malformed GitHub pull request #${number}: merged_at must be a timestamp or null`);
      }
      if (typeof pull.merged_at === "string") timestamp(pull.merged_at, `pull request #${number} merged_at`);
      merged = pull.merged_at !== null;
    } else if (pullValue !== undefined) {
      throw new Error(`Ambiguous GitHub item #${number}: issue also appeared as a pull request`);
    }
    const dependencySummary = issue.issue_dependencies_summary === undefined
      ? null
      : record(
        issue.issue_dependencies_summary,
        `issue #${number} dependency summary`,
      );
    const body = issue.body === null ? "" : stringField(issue.body, `issue #${number} body`, true);
    if (kind === "issue" && dependencySummary?.total_blocked_by !== undefined) {
      const declaredBlockers = declaredBlockingIssueNumbers(body);
      const nativeRelationships = nonNegativeInteger(
        dependencySummary.total_blocked_by,
        `issue #${number} total_blocked_by count`,
      );
      if (declaredBlockers.length > nativeRelationships) {
        throw new Error(
          `GitHub issue #${number} declares ${declaredBlockers.length} blockers but GitHub has ${nativeRelationships} native dependency relationships`,
        );
      }
    }
    const base = {
      id: `${this.#repository}#${number}`,
      nodeId: stringField(issue.node_id, `issue #${number} node id`),
      kind,
      number,
      url: stringField(issue.html_url, `issue #${number} URL`),
      state: normalizeState(issue.state, `issue #${number}`),
      title: stringField(issue.title, `issue #${number} title`),
      body,
      createdAt: timestamp(issue.created_at, `issue #${number} created_at`),
      updatedAt: timestamp(issue.updated_at, `issue #${number} updated_at`),
      labels: normalizeLabels(issue.labels, `issue #${number}`),
      assignees: normalizeAssignees(issue.assignees, `issue #${number}`),
      blockedBy: dependencySummary === null
        ? 0
        : nonNegativeInteger(
          dependencySummary.blocked_by,
          `issue #${number} blocked_by count`,
        ),
      ...(headSha === undefined ? {} : { headSha }),
      ...(headBranch === undefined ? {} : { headBranch }),
      ...(headRepository === undefined ? {} : { headRepository }),
      ...(draft === undefined ? {} : { draft }),
      ...(merged === undefined ? {} : { merged }),
      comments: normalizedComments.comments,
      bookkeeping: normalizedComments.bookkeeping,
      bookkeepingRevision: normalizedComments.bookkeepingRevision,
    };
    const materialVersion = sha256({
      id: base.id,
      nodeId: base.nodeId,
      kind: base.kind,
      state: base.state,
      title: base.title,
      body: base.body,
      createdAt: base.createdAt,
      labels: base.labels,
      assignees: base.assignees,
      blockedBy: base.blockedBy,
      headSha: base.headSha,
      headBranch: base.headBranch,
      headRepository: base.headRepository,
      draft: base.draft,
      merged: base.merged,
      comments: base.comments,
    });
    return {
      ...base,
      materialVersion,
    };
  }

  #decorateOutputPullRequests(
    items: TrackerItemSnapshot[],
    pullValues: readonly unknown[],
  ): void {
    const issues = new Map(
      items.filter((item) => item.kind === "issue").map((item) => [item.number, item]),
    );
    const pullRequests = new Map(
      items.filter((item) => item.kind === "pull-request").map((item) => [item.number, item]),
    );
    for (const value of pullValues) {
      const pull = record(value, "pull request output link");
      const pullNumber = positiveInteger(pull.number, "pull request output link number");
      const pullRequest = pullRequests.get(pullNumber);
      if (pullRequest?.state === "closed" && pullRequest.merged !== true) continue;
      const body = pull.body === null ? "" : stringField(pull.body, `pull request #${pullNumber} body`, true);
      const url = stringField(pull.html_url, `pull request #${pullNumber} URL`);
      for (const issueNumber of closingIssueNumbers(body, this.#repository)) {
        const issue = issues.get(issueNumber);
        if (!issue) continue;
        if (issue.outputPullRequest && issue.outputPullRequest !== url) {
          throw new Error(`Ambiguous GitHub output pull requests for issue #${issueNumber}`);
        }
        issue.outputPullRequest = url;
        issue.materialVersion = sha256({ base: issue.materialVersion, outputPullRequest: url });
        const implementationWorkspace = issue.bookkeeping?.value.skillName === "implement"
          ? issue.bookkeeping.value.workspace
          : undefined;
        if (pullRequest && implementationWorkspace) {
          pullRequest.workspace = implementationWorkspace;
          pullRequest.materialVersion = sha256({
            base: pullRequest.materialVersion,
            implementationWorkspace,
          });
        }
      }
    }
  }

  async #workflowSnapshot(state: "open" | "all"): Promise<TrackerSnapshot> {
    const issuesEndpoint = `repos/${this.#repository}/issues?state=${state}&per_page=100`;
    const pullsEndpoint = `repos/${this.#repository}/pulls?state=${state}&per_page=100`;
    const [issues, pulls] = await Promise.all([
      this.#paginated(issuesEndpoint, "open issues"),
      this.#paginated(pullsEndpoint, "open pull requests"),
    ]);
    const pullsByNumber = new Map<number, unknown>();
    for (const value of pulls) {
      const pull = record(value, "pull request");
      const number = positiveInteger(pull.number, "pull request number");
      if (pullsByNumber.has(number)) {
        throw new Error(`Ambiguous GitHub pull requests: duplicate #${number}`);
      }
      pullsByNumber.set(number, value);
    }
    const seen = new Set<number>();
    const items = await Promise.all(issues.map(async (value) => {
      const issue = record(value, "issue");
      const number = positiveInteger(issue.number, "issue number");
      if (seen.has(number)) throw new Error(`Ambiguous GitHub issues: duplicate #${number}`);
      seen.add(number);
      const pull = pullsByNumber.get(number);
      if ("pull_request" in issue) pullsByNumber.delete(number);
      const kind: TrackerItemKind = "pull_request" in issue ? "pull-request" : "issue";
      return this.#normalizeItem(value, pull, await this.#comments(number, kind));
    }));
    if (pullsByNumber.size > 0) {
      throw new Error(
        `Incomplete GitHub snapshot: pull request(s) missing from issues response: ${[
          ...pullsByNumber.keys(),
        ].sort((left, right) => left - right).map((number) => `#${number}`).join(", ")}`,
      );
    }
    items.sort((left, right) => left.number - right.number);
    this.#decorateOutputPullRequests(items, pulls);
    const revision = sha256(items.map((item) => ({
      id: item.id,
      materialVersion: item.materialVersion,
      updatedAt: item.bookkeeping !== null
        && item.bookkeeping.updatedAt === item.updatedAt
        && item.bookkeeping.value.materialVersion === item.materialVersion
        ? undefined
        : item.updatedAt,
    })));
    return { items, revision };
  }

  snapshot(): Promise<TrackerSnapshot> {
    return this.#workflowSnapshot("open");
  }

  async listBookkeeping(): Promise<readonly TrackerBookkeeping[]> {
    const snapshot = await this.#workflowSnapshot("all");
    return snapshot.items.flatMap((item) => item.bookkeeping === null ? [] : [item.bookkeeping.value]);
  }

  read(item: TrackerItemReference): Promise<TrackerItemSnapshot> {
    return this.reread(item);
  }

  async reread(item: TrackerItemReference): Promise<TrackerItemSnapshot> {
    this.#assertReference(item);
    const issueEndpoint = `repos/${this.#repository}/issues/${item.number}`;
    const issueOutput = await this.#runner.run("gh", ["api", issueEndpoint], this.#cwd);
    const issue = parseJson(issueOutput, `item #${item.number}`);
    const issueRecord = record(issue, `item #${item.number}`);
    const actualKind: TrackerItemKind = "pull_request" in issueRecord ? "pull-request" : "issue";
    if (actualKind !== item.kind) {
      throw new Error(`GitHub item #${item.number} is ${actualKind}, not ${item.kind}`);
    }
    let pull: unknown;
    if (actualKind === "pull-request") {
      const pullEndpoint = `repos/${this.#repository}/pulls/${item.number}`;
      pull = parseJson(
        await this.#runner.run("gh", ["api", pullEndpoint], this.#cwd),
        `pull request #${item.number}`,
      );
    }
    const normalized = this.#normalizeItem(issue, pull, await this.#comments(item.number, actualKind));
    if (actualKind === "issue") {
      const openPulls = await this.#paginated(
        `repos/${this.#repository}/pulls?state=open&per_page=100`,
        "open pull requests for output proof",
      );
      this.#decorateOutputPullRequests([normalized], openPulls);
    }
    return normalized;
  }

  async claim(item: TrackerItemReference, actor: string): Promise<void> {
    this.#assertIssue(item, "claim");
    this.#assertActor(actor);
    const before = await this.reread(item);
    if (before.assignees.length > 0) {
      throw new Error(`Cannot claim GitHub issue #${item.number}: it is already assigned`);
    }
    await this.#runner.run(
      "gh",
      [
        "api",
        "--method",
        "POST",
        `repos/${this.#repository}/issues/${item.number}/assignees`,
        "--raw-field",
        `assignees[]=${this.#actor}`,
      ],
      this.#cwd,
    );
    const claimed = await this.reread(item);
    if (claimed.assignees.length !== 1 || claimed.assignees[0] !== this.#actor) {
      throw new Error(`GitHub issue #${item.number} claim could not be verified`);
    }
  }

  async release(item: TrackerItemReference, actor: string): Promise<void> {
    this.#assertIssue(item, "release");
    this.#assertActor(actor);
    const before = await this.reread(item);
    if (before.assignees.length !== 1 || before.assignees[0] !== this.#actor) {
      throw new Error(`Cannot release GitHub issue #${item.number}: claim ownership is ambiguous`);
    }
    await this.#runner.run(
      "gh",
      [
        "api",
        "--method",
        "DELETE",
        `repos/${this.#repository}/issues/${item.number}/assignees`,
        "--raw-field",
        `assignees[]=${this.#actor}`,
      ],
      this.#cwd,
    );
    const released = await this.reread(item);
    if (released.assignees.length !== 0) {
      throw new Error(`GitHub issue #${item.number} release could not be verified`);
    }
  }

  async upsertBookkeeping(bookkeeping: TrackerBookkeeping): Promise<void> {
    await this.updateBookkeeping(bookkeeping.item, bookkeeping);
  }

  async updateBookkeeping(
    item: TrackerItemReference,
    bookkeeping: TrackerBookkeeping,
  ): Promise<TrackerItemSnapshot> {
    this.#assertReference(item);
    const before = await this.reread(item);
    const normalizedBookkeeping = normalizeBookkeeping(bookkeeping, "bookkeeping update");
    if (
      normalizedBookkeeping.item.kind !== before.kind
      || normalizedBookkeeping.item.number !== before.number
      || normalizedBookkeeping.item.url !== before.url
    ) {
      throw new Error(`GitHub bookkeeping identity does not match GitHub item #${item.number}`);
    }
    const body = serializeBookkeeping(normalizedBookkeeping);
    if (before.bookkeeping === null) {
      await this.#runner.run(
        "gh",
        [
          "api",
          "--method",
          "POST",
          `repos/${this.#repository}/issues/${item.number}/comments`,
          "--raw-field",
          `body=${body}`,
        ],
        this.#cwd,
      );
    } else {
      await this.#runner.run(
        "gh",
        [
          "api",
          "--method",
          "PATCH",
          `repos/${this.#repository}/issues/comments/${before.bookkeeping.commentId}`,
          "--raw-field",
          `body=${body}`,
        ],
        this.#cwd,
      );
    }
    const updated = await this.reread(item);
    if (updated.bookkeeping === null) {
      throw new Error(`GitHub item #${item.number} bookkeeping update could not be verified`);
    }
    if (JSON.stringify(updated.bookkeeping.value) !== JSON.stringify(normalizedBookkeeping)) {
      throw new Error(`GitHub item #${item.number} bookkeeping update did not match`);
    }
    return updated;
  }

  #assertReference(item: TrackerItemReference): void {
    positiveInteger(item.number, "item reference number");
    if (item.kind !== "issue" && item.kind !== "pull-request") {
      throw new Error("Malformed tracker item reference kind");
    }
  }

  #assertIssue(item: TrackerItemReference, action: string): void {
    this.#assertReference(item);
    if (item.kind !== "issue") throw new Error(`Cannot ${action} a pull request`);
  }

  #assertActor(actor: string): void {
    if (actor !== this.#actor) {
      throw new Error(`GitHub tracker actor mismatch: expected ${this.#actor}, received ${actor}`);
    }
  }
}
