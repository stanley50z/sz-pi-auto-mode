import type { AutomationStage, AutomationStageConfiguration } from "./stage-configuration.js";

export type WorkflowItemKind = "issue" | "pull-request";
export type TicketSkillName = "triage" | "grilling" | "prototype" | "implement" | "code-review";
export type TicketLifecycle = "running" | "awaiting-feedback" | "retrying" | "succeeded" | "exhausted" | "failed";

export interface WorkflowItem {
  kind: WorkflowItemKind;
  number: number;
  url: string;
  state: "open" | "closed";
  labels: string[];
  assignees: string[];
  blockedBy: number;
  updatedAt: string;
  materialVersion: string;
  draft?: boolean;
  headSha?: string;
  outputPullRequest?: string;
  headRepository?: string;
  headBranch?: string;
  merged?: boolean;
  workspace?: TicketWorkspaceIdentity;
}

export interface WorkflowSnapshot {
  readonly revision: string;
  readonly items: readonly WorkflowItem[];
}

export interface TicketItemReference {
  readonly kind: WorkflowItemKind;
  readonly number: number;
  readonly url: string;
}

export interface TicketWorkspaceIdentity {
  readonly branch: string;
  readonly worktree: string;
}

export interface BookkeepingRecord {
  readonly version: 1;
  readonly coordinatorId?: string;
  readonly item: TicketItemReference;
  readonly stage: AutomationStage;
  readonly skillName: TicketSkillName;
  readonly attempt: number;
  readonly lifecycle: TicketLifecycle;
  readonly materialVersion: string;
  readonly processId?: string;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly workspace?: TicketWorkspaceIdentity;
  readonly diagnostic?: string;
}

export interface CoordinatorTracker {
  listBookkeeping(): Promise<readonly BookkeepingRecord[]>;
  snapshot(): Promise<WorkflowSnapshot>;
  read(item: Pick<WorkflowItem, "kind" | "number">): Promise<WorkflowItem>;
  claim(item: WorkflowItem, actor: string): Promise<void>;
  upsertBookkeeping(record: BookkeepingRecord): Promise<void>;
}

export interface TicketSessionRequest {
  readonly item: TicketItemReference;
  readonly stage: AutomationStage;
  readonly skillName: TicketSkillName;
  readonly attempt: number;
  readonly cwd?: string;
  readonly resumeSessionFile?: string;
  readonly workspace?: TicketWorkspaceIdentity;
}

export interface TicketSessionTerminalResult {
  readonly status: "clean" | "error" | "waiting";
  readonly error?: string;
}

export interface TicketSessionHandle {
  readonly processId: string;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly completion: Promise<TicketSessionTerminalResult>;
  terminate(force: boolean): Promise<void>;
}

export interface TicketSessionHost {
  start(request: TicketSessionRequest): Promise<TicketSessionHandle>;
}

export interface TicketWorkspaceRequest {
  readonly item: WorkflowItem;
  readonly skillName: "prototype" | "implement" | "code-review";
  readonly existing?: TicketWorkspaceIdentity;
}

export interface TicketWorkspaceManager {
  prepare(request: TicketWorkspaceRequest): Promise<TicketWorkspaceIdentity>;
  completeReview(item: WorkflowItem, workspace: TicketWorkspaceIdentity): Promise<void>;
}

export interface CoordinatorClock {
  every(milliseconds: number, callback: () => void | Promise<void>): { dispose(): void };
}

export const processCoordinatorClock: CoordinatorClock = {
  every(milliseconds, callback) {
    const timer = setInterval(() => void callback(), milliseconds);
    return { dispose: () => clearInterval(timer) };
  },
};

interface DispatchChoice {
  readonly stage: AutomationStage;
  readonly skillName: TicketSkillName;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

export interface AutomodeCoordinatorOptions {
  readonly configuration: AutomationStageConfiguration;
  readonly actor: string;
  readonly tracker: CoordinatorTracker;
  readonly sessions: TicketSessionHost;
  readonly workspaces?: TicketWorkspaceManager;
  readonly clock?: CoordinatorClock;
  readonly coordinatorId?: string;
}

const STATE_LABELS = new Set(["needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix"]);
const MAX_ATTEMPTS = 5;

function hasConflictingTriageState(item: WorkflowItem): boolean {
  return item.labels.some((label) => STATE_LABELS.has(label) && label !== "needs-triage");
}

function isEligibleForChoice(
  item: WorkflowItem,
  choice: DispatchChoice,
  actor: string,
  allowClaimed = false,
): boolean {
  if (item.state !== "open") return false;
  const unassigned = item.assignees.length === 0;
  const unassignedOrOurs = unassigned || item.assignees.every((assignee) => assignee === actor);
  switch (choice.skillName) {
    case "triage":
      return item.kind === "issue" && (unassigned || (allowClaimed && unassignedOrOurs))
        && item.labels.includes("needs-triage")
        && !hasConflictingTriageState(item);
    case "grilling":
      return item.kind === "issue" && (unassigned || (allowClaimed && unassignedOrOurs)) && item.blockedBy === 0
        && item.labels.includes("wayfinder:grilling");
    case "prototype":
      return item.kind === "issue" && (unassigned || (allowClaimed && unassignedOrOurs)) && item.blockedBy === 0
        && item.labels.includes("wayfinder:prototype");
    case "implement":
      return item.kind === "issue" && unassignedOrOurs && item.blockedBy === 0
        && item.labels.includes("ready-for-agent") && item.outputPullRequest === undefined;
    case "code-review":
      return item.kind === "pull-request" && item.draft === false;
  }
}

function chooseDispatch(
  item: WorkflowItem,
  configuration: AutomationStageConfiguration,
  actor: string,
  allowClaimed = false,
): DispatchChoice | undefined {
  const choices: readonly DispatchChoice[] = [
    { stage: "auto-triage", skillName: "triage" },
    { stage: "auto-grilling", skillName: "grilling" },
    { stage: "auto-implement", skillName: item.labels.includes("wayfinder:prototype") ? "prototype" : "implement" },
    { stage: "auto-review", skillName: "code-review" },
  ];
  return choices.find((choice) =>
    configuration.stages.includes(choice.stage) && isEligibleForChoice(item, choice, actor, allowClaimed)
  );
}

function itemKey(item: Pick<WorkflowItem, "kind" | "number">): string {
  return `${item.kind}:${item.number}`;
}

function itemReference(item: WorkflowItem): TicketItemReference {
  return { kind: item.kind, number: item.number, url: item.url };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AutomodeCoordinator {
  private readonly clock: CoordinatorClock;
  private readonly active = new Map<string, {
    promise: Promise<void>;
    handle?: TicketSessionHandle;
    forceRequested?: boolean;
  }>();
  private readonly exhausted = new Map<string, string>();
  private readonly awaitingFeedback = new Map<string, BookkeepingRecord>();
  private readonly stopped = deferred<void>();
  private poller: { dispose(): void } | undefined;
  private lastSnapshotRevision: string | undefined;
  private started = false;
  private draining = false;
  private forcing = false;

  constructor(private readonly options: AutomodeCoordinatorOptions) {
    this.clock = options.clock ?? processCoordinatorClock;
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("Automode Coordinator has already started");
    this.started = true;
    await this.reconcile();
    await this.scan(true);
    if (!this.draining) {
      this.poller = this.clock.every(30_000, async () => {
        try {
          await this.scan(false);
        } catch (error) {
          await this.recordCoordinatorFailure(error);
        }
      });
    }
  }

  private async reconcile(): Promise<void> {
    const records = await this.options.tracker.listBookkeeping();
    for (const record of records) {
      const key = itemKey(record.item);
      if (record.lifecycle === "exhausted") {
        this.exhausted.set(key, record.materialVersion);
        continue;
      }
      if (record.lifecycle === "awaiting-feedback") {
        this.awaitingFeedback.set(key, record);
        continue;
      }
      if (!(["running", "retrying", "failed"] as TicketLifecycle[]).includes(record.lifecycle)) continue;
      if (record.attempt >= MAX_ATTEMPTS) {
        const exhausted: BookkeepingRecord = {
          ...record,
          lifecycle: "exhausted",
          diagnostic: record.diagnostic ?? "Coordinator restarted after the fifth total attempt",
        };
        this.exhausted.set(key, record.materialVersion);
        await this.options.tracker.upsertBookkeeping(exhausted);
        continue;
      }
      const item = await this.options.tracker.read(record.item);
      const choice = chooseDispatch(item, this.options.configuration, this.options.actor, true);
      if (!choice || choice.stage !== record.stage || choice.skillName !== record.skillName) {
        let diagnostic = record.diagnostic;
        const trackerProvesCompletion = record.skillName === "code-review"
          ? item.merged === true
          : !choice;
        if (record.skillName === "code-review" && item.merged === true) {
          if (record.workspace) {
            try {
              await this.options.workspaces!.completeReview(item, record.workspace);
            } catch (error) {
              diagnostic = `Merge succeeded but cleanup failed during recovery: ${errorMessage(error)}`;
            }
          } else {
            diagnostic = "Merge succeeded but no recorded workspace was available for recovery cleanup";
          }
        }
        await this.options.tracker.upsertBookkeeping({
          ...record,
          item: itemReference(item),
          lifecycle: trackerProvesCompletion ? "succeeded" : "failed",
          materialVersion: item.materialVersion,
          diagnostic: trackerProvesCompletion
            ? diagnostic
            : `Recovered tracker state no longer matches ${record.stage}/${record.skillName}`,
        });
        continue;
      }
      this.launch(item, choice, record.attempt, record.sessionFile, record.workspace);
    }
  }

  private async scan(initial: boolean): Promise<void> {
    if (this.draining) return;
    const snapshot = await this.options.tracker.snapshot();
    if (!initial && snapshot.revision === this.lastSnapshotRevision) return;
    this.lastSnapshotRevision = snapshot.revision;
    for (const item of snapshot.items) {
      const key = itemKey(item);
      if (this.active.has(key)) continue;
      const waiting = this.awaitingFeedback.get(key);
      if (waiting) {
        if (waiting.materialVersion === item.materialVersion) continue;
        const choice = chooseDispatch(item, this.options.configuration, this.options.actor, true);
        if (choice && choice.stage === waiting.stage && choice.skillName === waiting.skillName) {
          this.awaitingFeedback.delete(key);
          this.launch(
            item,
            choice,
            Math.max(0, waiting.attempt - 1),
            waiting.sessionFile,
            waiting.workspace,
          );
        }
        continue;
      }
      const exhaustedVersion = this.exhausted.get(key);
      if (exhaustedVersion === item.materialVersion) continue;
      if (exhaustedVersion !== undefined) this.exhausted.delete(key);
      const choice = chooseDispatch(item, this.options.configuration, this.options.actor);
      if (choice) this.launch(item, choice, 0, undefined, item.workspace);
    }
  }

  private launch(
    item: WorkflowItem,
    choice: DispatchChoice,
    previousAttempts: number,
    resumeSessionFile?: string,
    workspace?: TicketWorkspaceIdentity,
  ): void {
    const key = itemKey(item);
    let task!: Promise<void>;
    task = this.runAttempts(item, choice, previousAttempts, resumeSessionFile, workspace)
      .catch(async (error) => {
        await this.options.tracker.upsertBookkeeping({
          version: 1,
          coordinatorId: this.options.coordinatorId,
          item: itemReference(item),
          stage: choice.stage,
          skillName: choice.skillName,
          attempt: Math.min(MAX_ATTEMPTS, previousAttempts + 1),
          lifecycle: "failed",
          materialVersion: item.materialVersion,
          diagnostic: errorMessage(error),
          workspace,
        });
      })
      .finally(() => {
        if (this.active.get(key)?.promise === task) this.active.delete(key);
        this.finishDrainIfIdle();
      });
    this.active.set(key, { promise: task });
  }

  private async runAttempts(
    initialItem: WorkflowItem,
    choice: DispatchChoice,
    previousAttempts: number,
    resumeSessionFile?: string,
    workspace?: TicketWorkspaceIdentity,
  ): Promise<void> {
    let item = initialItem;
    let sessionFile = resumeSessionFile;
    let preparedWorkspace = workspace;
    for (let attempt = previousAttempts + 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (this.draining) return;
      if (item.kind === "issue" && item.assignees.length === 0) {
        await this.options.tracker.claim(item, this.options.actor);
        item = await this.options.tracker.read(item);
        if (!isEligibleForChoice(item, choice, this.options.actor, true)) {
          throw new Error(`Claimed item #${item.number} is no longer eligible for ${choice.stage}`);
        }
      }

      const needsWorkspace = choice.skillName === "prototype"
        || choice.skillName === "implement"
        || choice.skillName === "code-review";
      if (needsWorkspace && !this.options.workspaces) {
        throw new Error(`No controlled workspace manager is available for ${choice.skillName}`);
      }
      let handle: TicketSessionHandle;
      try {
        if (needsWorkspace) {
          preparedWorkspace = await this.options.workspaces!.prepare({
            item,
            skillName: choice.skillName as "prototype" | "implement" | "code-review",
            existing: preparedWorkspace,
          });
        }
        handle = await this.options.sessions.start({
          item: itemReference(item),
          stage: choice.stage,
          skillName: choice.skillName,
          attempt,
          cwd: preparedWorkspace?.worktree,
          resumeSessionFile: sessionFile,
          workspace: preparedWorkspace,
        });
      } catch (error) {
        const finalAttempt = attempt === MAX_ATTEMPTS;
        if (finalAttempt) this.exhausted.set(itemKey(item), item.materialVersion);
        await this.options.tracker.upsertBookkeeping({
          version: 1,
          coordinatorId: this.options.coordinatorId,
          item: itemReference(item),
          stage: choice.stage,
          skillName: choice.skillName,
          attempt,
          lifecycle: finalAttempt ? "exhausted" : "retrying",
          materialVersion: item.materialVersion,
          diagnostic: errorMessage(error),
          workspace: preparedWorkspace,
        });
        continue;
      }
      const active = this.active.get(itemKey(item));
      if (active) {
        active.handle = handle;
        if (active.forceRequested || this.forcing) await handle.terminate(true);
      }
      sessionFile = handle.sessionFile;
      await this.options.tracker.upsertBookkeeping({
        version: 1,
        coordinatorId: this.options.coordinatorId,
        item: itemReference(item),
        stage: choice.stage,
        skillName: choice.skillName,
        attempt,
        lifecycle: attempt === 1 ? "running" : "retrying",
        materialVersion: item.materialVersion,
        processId: handle.processId,
        sessionId: handle.sessionId,
        sessionFile: handle.sessionFile,
        workspace: preparedWorkspace,
      });

      const terminal = await handle.completion;
      const fresh = await this.options.tracker.read(item);
      if (choice.skillName === "prototype" && terminal.status === "waiting") {
        const waiting: BookkeepingRecord = {
          version: 1,
          coordinatorId: this.options.coordinatorId,
          item: itemReference(fresh),
          stage: choice.stage,
          skillName: choice.skillName,
          attempt,
          lifecycle: "awaiting-feedback",
          materialVersion: fresh.materialVersion,
          processId: handle.processId,
          sessionId: handle.sessionId,
          sessionFile: handle.sessionFile,
          workspace: preparedWorkspace,
        };
        this.awaitingFeedback.set(itemKey(fresh), waiting);
        await this.options.tracker.upsertBookkeeping(waiting);
        return;
      }
      const trackerProvesSuccess = choice.skillName === "code-review"
        ? fresh.merged === true
        : !isEligibleForChoice(fresh, choice, this.options.actor, true);
      if (terminal.status === "clean" && trackerProvesSuccess) {
        this.awaitingFeedback.delete(itemKey(fresh));
        let cleanupDiagnostic: string | undefined;
        if (choice.skillName === "code-review") {
          try {
            await this.options.workspaces!.completeReview(fresh, preparedWorkspace!);
          } catch (error) {
            cleanupDiagnostic = `Merge succeeded but cleanup failed: ${errorMessage(error)}`;
          }
        }
        await this.options.tracker.upsertBookkeeping({
          version: 1,
          coordinatorId: this.options.coordinatorId,
          item: itemReference(fresh),
          stage: choice.stage,
          skillName: choice.skillName,
          attempt,
          lifecycle: "succeeded",
          materialVersion: fresh.materialVersion,
          processId: handle.processId,
          sessionId: handle.sessionId,
          sessionFile: handle.sessionFile,
          workspace: preparedWorkspace,
          diagnostic: cleanupDiagnostic,
        });
        return;
      }
      item = fresh;
      if (attempt === MAX_ATTEMPTS) {
        const diagnostic = terminal.status === "error"
          ? terminal.error ?? "Ticket Session failed without diagnostics"
          : `Fresh tracker state remains eligible for ${choice.stage}`;
        this.exhausted.set(itemKey(item), item.materialVersion);
        await this.options.tracker.upsertBookkeeping({
          version: 1,
          coordinatorId: this.options.coordinatorId,
          item: itemReference(item),
          stage: choice.stage,
          skillName: choice.skillName,
          attempt,
          lifecycle: "exhausted",
          materialVersion: item.materialVersion,
          processId: handle.processId,
          sessionId: handle.sessionId,
          sessionFile: handle.sessionFile,
          diagnostic,
          workspace: preparedWorkspace,
        });
      }
    }
  }

  private async recordCoordinatorFailure(error: unknown): Promise<void> {
    if (this.draining) return;
    throw new Error(`Automode Coordinator polling failed: ${errorMessage(error)}`, { cause: error });
  }

  async waitForIdle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active.values()].map(({ promise }) => promise));
    }
  }

  interrupt(): "draining" | "forcing" {
    if (!this.draining) {
      this.draining = true;
      this.poller?.dispose();
      this.poller = undefined;
      this.finishDrainIfIdle();
      return "draining";
    }
    this.forcing = true;
    const terminations = [...this.active.values()].map((active) => {
      active.forceRequested = true;
      return active.handle?.terminate(true) ?? Promise.resolve();
    });
    void Promise.allSettled(terminations).then(() => this.finishDrainIfIdle());
    return "forcing";
  }

  private finishDrainIfIdle(): void {
    if (this.draining && this.active.size === 0) this.stopped.resolve(undefined);
  }

  whenStopped(): Promise<void> {
    if (!this.started) throw new Error("Automode Coordinator has not started");
    return this.stopped.promise;
  }
}
