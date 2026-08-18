import {
  AUTOMATION_STAGES,
  AUTOMATION_STAGE_LABELS,
  type AutomationStage,
  type AutomationStageConfiguration,
} from "./stage-configuration.js";

export type WorkflowItemKind = "issue" | "pull-request";
export type TicketSkillName = "triage" | "grilling" | "prototype" | "implement" | "code-review";
export type TicketLifecycle = "running" | "awaiting-feedback" | "retrying" | "succeeded" | "exhausted" | "failed";

export interface WorkflowItem {
  kind: WorkflowItemKind;
  number: number;
  url: string;
  title?: string;
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
  now(): Date;
  every(milliseconds: number, callback: () => void | Promise<void>): { dispose(): void };
}

export const processCoordinatorClock: CoordinatorClock = {
  now: () => new Date(),
  every(milliseconds, callback) {
    const timer = setInterval(() => void callback(), milliseconds);
    return { dispose: () => clearInterval(timer) };
  },
};

interface DispatchChoice {
  readonly stage: AutomationStage;
  readonly skillName: TicketSkillName;
}

/** User-facing lifecycle and hold states for candidates in Stage Lanes. */
export type StageCandidateStatus =
  | "queued"
  | "claimed"
  | "running"
  | "waiting"
  | "retrying"
  | "blocked"
  | "human-owned"
  | "exhausted";

export type AutomationStageOperatingState = "ON" | "DRAINING" | "OFF";

export interface StageCandidateProjection {
  readonly item: TicketItemReference;
  readonly title?: string;
  readonly stage: AutomationStage;
  readonly skillName: TicketSkillName;
  readonly status: StageCandidateStatus;
  readonly reason: string;
  readonly attempt: number;
}

export interface StageCandidateTotals {
  readonly candidates: number;
  readonly active: number;
  readonly queued: number;
  readonly held: number;
  readonly retrying: number;
  readonly exhausted: number;
}

export interface StageLaneProjection {
  readonly stage: AutomationStage;
  readonly operatingState: AutomationStageOperatingState;
  readonly candidates: readonly StageCandidateProjection[];
  readonly totals: StageCandidateTotals;
}

export interface RecentStageCandidateProjection {
  readonly item: TicketItemReference;
  readonly title?: string;
  readonly stage: AutomationStage;
  readonly skillName: TicketSkillName;
  readonly status: "settled";
  readonly reason: string;
  readonly attempt: number;
  readonly settledAt: string;
}

/** Complete replacement snapshot consumed by Coordinator supervision surfaces. */
export interface CoordinatorProjection {
  readonly lanes: readonly StageLaneProjection[];
  readonly totals: StageCandidateTotals;
  readonly recent: readonly RecentStageCandidateProjection[];
}

interface ActiveStageCandidate {
  promise: Promise<void>;
  stage: AutomationStage;
  skillName: TicketSkillName;
  status: "queued" | "claimed" | "running" | "retrying";
  reason: string;
  attempt: number;
  handle?: TicketSessionHandle;
  forceRequested?: boolean;
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

function recognizedChoice(item: WorkflowItem): DispatchChoice | undefined {
  if (item.state !== "open") return undefined;
  if (item.kind === "issue" && item.labels.includes("needs-triage")) {
    return { stage: "auto-triage", skillName: "triage" };
  }
  if (item.kind === "issue" && item.labels.includes("wayfinder:grilling")) {
    return { stage: "auto-grilling", skillName: "grilling" };
  }
  if (
    item.kind === "issue"
    && (item.labels.includes("wayfinder:prototype") || item.labels.includes("ready-for-agent"))
  ) {
    return {
      stage: "auto-implement",
      skillName: item.labels.includes("wayfinder:prototype") ? "prototype" : "implement",
    };
  }
  if (item.kind === "pull-request" && item.draft === false) {
    return { stage: "auto-review", skillName: "code-review" };
  }
  return undefined;
}

function chooseEligible(
  item: WorkflowItem,
  actor: string,
  allowClaimed = false,
): DispatchChoice | undefined {
  const choice = recognizedChoice(item);
  return choice && isEligibleForChoice(item, choice, actor, allowClaimed) ? choice : undefined;
}

function chooseDispatch(
  item: WorkflowItem,
  operatingStates: Readonly<Record<AutomationStage, AutomationStageOperatingState>>,
  actor: string,
  allowClaimed = false,
): DispatchChoice | undefined {
  const choice = chooseEligible(item, actor, allowClaimed);
  return choice && operatingStates[choice.stage] === "ON" ? choice : undefined;
}

function emptyTotals(): StageCandidateTotals {
  return { candidates: 0, active: 0, queued: 0, held: 0, retrying: 0, exhausted: 0 };
}

function addCandidateToTotals(totals: StageCandidateTotals, status: StageCandidateStatus): StageCandidateTotals {
  return {
    candidates: totals.candidates + 1,
    active: totals.active + (status === "claimed" || status === "running" ? 1 : 0),
    queued: totals.queued + (status === "queued" ? 1 : 0),
    held: totals.held + (status === "waiting" || status === "blocked" || status === "human-owned" ? 1 : 0),
    retrying: totals.retrying + (status === "retrying" ? 1 : 0),
    exhausted: totals.exhausted + (status === "exhausted" ? 1 : 0),
  };
}

function candidateTotals(candidates: readonly StageCandidateProjection[]): StageCandidateTotals {
  return candidates.reduce(
    (totals, candidate) => addCandidateToTotals(totals, candidate.status),
    emptyTotals(),
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
  private readonly active = new Map<string, ActiveStageCandidate>();
  private readonly exhausted = new Map<string, BookkeepingRecord>();
  private readonly awaitingFeedback = new Map<string, BookkeepingRecord>();
  private readonly pendingRecovery = new Map<string, BookkeepingRecord>();
  private readonly stopped = deferred<void>();
  private readonly currentItems = new Map<string, WorkflowItem>();
  private readonly settledThisProcess = new Map<string, RecentStageCandidateProjection>();
  private readonly operatingStates: Record<AutomationStage, AutomationStageOperatingState>;
  private projection: CoordinatorProjection;
  private poller: { dispose(): void } | undefined;
  private lastSnapshotRevision: string | undefined;
  private started = false;
  private draining = false;
  private forcing = false;

  constructor(private readonly options: AutomodeCoordinatorOptions) {
    this.clock = options.clock ?? processCoordinatorClock;
    this.operatingStates = Object.fromEntries(AUTOMATION_STAGES.map((stage) => [
      stage,
      options.configuration.stages.includes(stage) ? "ON" : "OFF",
    ])) as Record<AutomationStage, AutomationStageOperatingState>;
    this.projection = this.buildProjection();
  }

  /** Returns the latest projection built from tracker and process-local Coordinator state. */
  getProjection(): CoordinatorProjection {
    return this.projection;
  }

  /** Applies one process-local Stage control and fully rescans when a Stage is enabled. */
  async setStageOperatingState(
    stage: AutomationStage,
    target: "ON" | "OFF",
  ): Promise<AutomationStageOperatingState> {
    if (!(AUTOMATION_STAGES as readonly string[]).includes(stage)) {
      throw new Error(`Unknown Automation Stage: ${stage}`);
    }
    if (this.draining) throw new Error("Cannot change Stage Operating State while the Coordinator is draining");
    if (target === "ON") {
      this.operatingStates[stage] = "ON";
      this.refreshProjection();
      await this.scan(true);
      return "ON";
    }
    const hasActiveSession = [...this.active.values()].some((active) => active.stage === stage);
    this.operatingStates[stage] = hasActiveSession ? "DRAINING" : "OFF";
    this.refreshProjection();
    return this.operatingStates[stage];
  }

  private buildProjection(): CoordinatorProjection {
    const candidatesByStage = new Map<AutomationStage, StageCandidateProjection[]>(
      AUTOMATION_STAGES.map((stage) => [stage, []]),
    );
    for (const item of this.currentItems.values()) {
      const choice = recognizedChoice(item);
      if (!choice) continue;
      const key = itemKey(item);
      const active = this.active.get(key);
      const exhausted = this.exhausted.get(key);
      let status: StageCandidateStatus;
      let reason: string;
      let attempt = 0;
      const waiting = this.awaitingFeedback.get(key);
      if (active && active.stage === choice.stage && active.skillName === choice.skillName) {
        status = active.status;
        reason = active.reason;
        attempt = active.attempt;
      } else if (
        waiting
        && waiting.stage === choice.stage
        && waiting.skillName === choice.skillName
        && waiting.materialVersion === item.materialVersion
      ) {
        status = "waiting";
        reason = "The durable Ticket Session is waiting for external feedback or a material tracker change.";
        attempt = waiting.attempt;
      } else if (
        exhausted
        && exhausted.stage === choice.stage
        && exhausted.skillName === choice.skillName
        && exhausted.materialVersion === item.materialVersion
      ) {
        status = "exhausted";
        reason = exhausted.diagnostic
          ? `Five attempts were exhausted; evidence is preserved. ${exhausted.diagnostic}`
          : "Five attempts were exhausted; evidence is preserved for diagnosis.";
        attempt = exhausted.attempt;
      } else if (item.blockedBy > 0 && item.kind === "issue") {
        status = "blocked";
        reason = `Blocked by ${item.blockedBy} open native ${item.blockedBy === 1 ? "dependency" : "dependencies"}.`;
      } else if (choice.skillName === "triage" && hasConflictingTriageState(item)) {
        status = "human-owned";
        reason = "A conflicting triage state prevents Auto-Triage dispatch.";
      } else if (choice.skillName === "implement" && item.outputPullRequest !== undefined) {
        status = "human-owned";
        reason = `Output pull request ${item.outputPullRequest} already exists; Auto-Implement will not dispatch.`;
      } else if (
        item.assignees.some((assignee) => assignee !== this.options.actor)
        || (
          item.assignees.length > 0
          && (choice.skillName === "triage" || choice.skillName === "grilling" || choice.skillName === "prototype")
        )
      ) {
        status = "human-owned";
        reason = `Assigned to ${item.assignees.join(", ")}; no active Automode claim owns this candidate.`;
      } else if (this.operatingStates[choice.stage] !== "ON") {
        status = "human-owned";
        reason = this.operatingStates[choice.stage] === "OFF"
          ? `${AUTOMATION_STAGE_LABELS[choice.stage]} is OFF for this Coordinator process; work is human-controlled until re-enabled.`
          : `${AUTOMATION_STAGE_LABELS[choice.stage]} is DRAINING; no new Ticket Session will start.`;
      } else {
        status = "queued";
        reason = "Eligible now; waiting for the Coordinator to claim it.";
      }
      candidatesByStage.get(choice.stage)!.push({
        item: itemReference(item),
        ...(item.title === undefined ? {} : { title: item.title }),
        stage: choice.stage,
        skillName: choice.skillName,
        status,
        reason,
        attempt,
      });
    }
    const lanes = AUTOMATION_STAGES.map((stage): StageLaneProjection => {
      const candidates = candidatesByStage.get(stage)!;
      return {
        stage,
        operatingState: this.operatingStates[stage],
        candidates,
        totals: candidateTotals(candidates),
      };
    });
    return {
      lanes,
      totals: candidateTotals(lanes.flatMap((lane) => lane.candidates)),
      recent: [...this.settledThisProcess.values()],
    };
  }

  private candidateFromProjection(key: string): StageCandidateProjection | undefined {
    return this.projection.lanes
      .flatMap((lane) => lane.candidates)
      .find((candidate) => itemKey(candidate.item) === key);
  }

  private retainSettledCandidate(
    item: WorkflowItem,
    choice: DispatchChoice,
    reason: string,
  ): void {
    const candidate = this.candidateFromProjection(itemKey(item));
    this.settledThisProcess.set(`${itemKey(item)}:${choice.stage}:${choice.skillName}`, {
      item: itemReference(item),
      ...(item.title === undefined ? {} : { title: item.title }),
      stage: choice.stage,
      skillName: choice.skillName,
      status: "settled",
      reason,
      attempt: candidate?.attempt ?? 0,
      settledAt: this.clock.now().toISOString(),
    });
  }

  private observeItem(item: WorkflowItem, settlementReason: string): void {
    const key = itemKey(item);
    const previous = this.currentItems.get(key);
    const previousChoice = previous && recognizedChoice(previous);
    const nextChoice = recognizedChoice(item);
    if (
      previous
      && previousChoice
      && (nextChoice?.stage !== previousChoice.stage || nextChoice.skillName !== previousChoice.skillName)
    ) {
      this.retainSettledCandidate(previous, previousChoice, settlementReason);
    }
    this.currentItems.set(key, item);
  }

  private replaceSnapshot(items: readonly WorkflowItem[]): void {
    const nextKeys = new Set(items.map((item) => itemKey(item)));
    for (const [key, previous] of this.currentItems) {
      if (nextKeys.has(key)) continue;
      const choice = recognizedChoice(previous);
      if (choice) {
        this.retainSettledCandidate(
          previous,
          choice,
          "The item no longer appears in the open tracker snapshot.",
        );
      }
    }
    for (const item of items) {
      this.observeItem(item, "The item no longer matches this Stage after a material tracker change.");
    }
    for (const key of [...this.currentItems.keys()]) {
      if (!nextKeys.has(key)) this.currentItems.delete(key);
    }
  }

  private refreshProjection(): void {
    this.projection = this.buildProjection();
  }

  private updateActive(
    item: Pick<WorkflowItem, "kind" | "number">,
    update: Partial<Pick<ActiveStageCandidate, "status" | "reason" | "attempt" | "handle">>,
  ): void {
    const active = this.active.get(itemKey(item));
    if (!active) return;
    Object.assign(active, update);
    this.refreshProjection();
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
        this.exhausted.set(key, record);
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
        this.exhausted.set(key, exhausted);
        await this.options.tracker.upsertBookkeeping(exhausted);
        continue;
      }
      const item = await this.options.tracker.read(record.item);
      const eligible = chooseEligible(item, this.options.actor, true);
      if (!eligible || eligible.stage !== record.stage || eligible.skillName !== record.skillName) {
        let diagnostic = record.diagnostic;
        const trackerProvesCompletion = record.skillName === "code-review"
          ? item.merged === true
          : !eligible;
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
      if (this.operatingStates[eligible.stage] === "ON") {
        this.launch(item, eligible, record.attempt, record.sessionFile, record.workspace);
      } else {
        this.pendingRecovery.set(key, record);
      }
    }
  }

  private async scan(initial: boolean): Promise<void> {
    if (this.draining) return;
    const snapshot = await this.options.tracker.snapshot();
    if (!initial && snapshot.revision === this.lastSnapshotRevision) return;
    this.lastSnapshotRevision = snapshot.revision;
    this.replaceSnapshot(snapshot.items);
    this.refreshProjection();
    for (const item of snapshot.items) {
      const key = itemKey(item);
      if (this.active.has(key)) continue;
      const waiting = this.awaitingFeedback.get(key);
      if (waiting) {
        if (waiting.materialVersion === item.materialVersion) continue;
        const recognized = recognizedChoice(item);
        if (recognized?.stage === waiting.stage && recognized.skillName === waiting.skillName) {
          const choice = chooseDispatch(item, this.operatingStates, this.options.actor, true);
          if (choice) {
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
        this.awaitingFeedback.delete(key);
      }
      const exhausted = this.exhausted.get(key);
      if (exhausted?.materialVersion === item.materialVersion) continue;
      if (exhausted !== undefined) this.exhausted.delete(key);
      const recovery = this.pendingRecovery.get(key);
      if (recovery) {
        const eligible = chooseEligible(item, this.options.actor, true);
        if (eligible?.stage === recovery.stage && eligible.skillName === recovery.skillName) {
          if (this.operatingStates[eligible.stage] === "ON") {
            this.pendingRecovery.delete(key);
            this.launch(item, eligible, recovery.attempt, recovery.sessionFile, recovery.workspace);
          }
          continue;
        }
        this.pendingRecovery.delete(key);
      }
      const choice = chooseDispatch(item, this.operatingStates, this.options.actor);
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
    const active = {
      promise: Promise.resolve(),
      stage: choice.stage,
      skillName: choice.skillName,
      status: "queued" as const,
      reason: "Eligible now; waiting for the Coordinator to claim it.",
      attempt: Math.min(MAX_ATTEMPTS, previousAttempts + 1),
    };
    this.active.set(key, active);
    task = Promise.resolve()
      .then(() => this.runAttempts(item, choice, previousAttempts, resumeSessionFile, workspace))
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
        if (
          this.operatingStates[choice.stage] === "DRAINING"
          && ![...this.active.values()].some((candidate) => candidate.stage === choice.stage)
        ) {
          this.operatingStates[choice.stage] = "OFF";
        }
        this.refreshProjection();
        this.finishDrainIfIdle();
      });
    active.promise = task;
    this.refreshProjection();
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
      if (this.draining || this.operatingStates[choice.stage] !== "ON") return;
      this.updateActive(item, {
        status: attempt === 1 ? "queued" : "retrying",
        reason: attempt === 1
          ? "Eligible now; waiting for the Coordinator to claim it."
          : `Retry attempt ${attempt} is starting within the five-attempt budget.`,
        attempt,
      });
      if (item.kind === "issue" && item.assignees.length === 0) {
        await this.options.tracker.claim(item, this.options.actor);
        item = await this.options.tracker.read(item);
        if (!isEligibleForChoice(item, choice, this.options.actor, true)) {
          throw new Error(`Claimed item #${item.number} is no longer eligible for ${choice.stage}`);
        }
      }
      this.updateActive(item, {
        status: attempt === 1 ? "claimed" : "retrying",
        reason: attempt === 1
          ? "Claimed by Automode; Ticket Session and workspace startup are in progress."
          : `Retry attempt ${attempt} is preparing its Ticket Session and workspace.`,
        attempt,
      });

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
        const record: BookkeepingRecord = {
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
        };
        if (finalAttempt) {
          this.exhausted.set(itemKey(item), record);
        } else {
          this.updateActive(item, {
            status: "retrying",
            reason: `Attempt ${attempt} could not start: ${errorMessage(error)} Retrying within the five-attempt budget.`,
            attempt,
          });
        }
        await this.options.tracker.upsertBookkeeping(record);
        continue;
      }
      const active = this.active.get(itemKey(item));
      if (active) {
        active.handle = handle;
        if (active.forceRequested || this.forcing) await handle.terminate(true);
      }
      this.updateActive(item, {
        status: "running",
        reason: attempt === 1
          ? "A live Ticket Session owns this item."
          : `A live Ticket Session owns retry attempt ${attempt}.`,
        attempt,
        handle,
      });
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
      this.observeItem(
        fresh,
        terminal.status === "clean"
          ? "The Ticket Session settled this Stage and fresh tracker state proves completion."
          : `The Ticket Session settled after reporting ${terminal.status}.`,
      );
      this.refreshProjection();
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
      if (
        attempt < MAX_ATTEMPTS
        && (this.draining || this.operatingStates[choice.stage] !== "ON")
      ) {
        const retrying: BookkeepingRecord = {
          version: 1,
          coordinatorId: this.options.coordinatorId,
          item: itemReference(item),
          stage: choice.stage,
          skillName: choice.skillName,
          attempt,
          lifecycle: "retrying",
          materialVersion: item.materialVersion,
          processId: handle.processId,
          sessionId: handle.sessionId,
          sessionFile: handle.sessionFile,
          workspace: preparedWorkspace,
          diagnostic: terminal.status === "error"
            ? terminal.error ?? "Ticket Session failed without diagnostics"
            : `Fresh tracker state remains eligible for ${choice.stage}`,
        };
        this.pendingRecovery.set(itemKey(item), retrying);
        this.updateActive(item, {
          status: "retrying",
          reason: `Attempt ${attempt} settled without success; retry is held while the Stage is not ON.`,
          attempt,
        });
        await this.options.tracker.upsertBookkeeping(retrying);
        return;
      }
      if (attempt === MAX_ATTEMPTS) {
        const diagnostic = terminal.status === "error"
          ? terminal.error ?? "Ticket Session failed without diagnostics"
          : `Fresh tracker state remains eligible for ${choice.stage}`;
        const record: BookkeepingRecord = {
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
        };
        this.exhausted.set(itemKey(item), record);
        await this.options.tracker.upsertBookkeeping(record);
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
