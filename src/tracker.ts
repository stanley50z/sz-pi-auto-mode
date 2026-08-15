import type {
  BookkeepingRecord,
  CoordinatorTracker,
  WorkflowItem,
  WorkflowSnapshot,
} from "./coordinator.js";

export type TrackerItemKind = "issue" | "pull-request";
export type TrackerItemState = "open" | "closed";

export interface TrackerItemReference {
  readonly kind: TrackerItemKind;
  readonly number: number;
}

export interface TrackerCommentSnapshot {
  readonly id: string;
  readonly nodeId: string;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type TrackerBookkeeping = BookkeepingRecord;

export interface TrackerBookkeepingSnapshot {
  readonly commentId: string;
  readonly updatedAt: string;
  readonly value: TrackerBookkeeping;
}

export interface TrackerItemSnapshot extends WorkflowItem {
  readonly id: string;
  readonly nodeId: string;
  readonly url: string;
  readonly state: TrackerItemState;
  readonly title: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly labels: string[];
  readonly assignees: string[];
  readonly comments: readonly TrackerCommentSnapshot[];
  readonly bookkeeping: TrackerBookkeepingSnapshot | null;
  readonly bookkeepingRevision: string | null;
}

export interface TrackerSnapshot extends WorkflowSnapshot {
  readonly items: readonly TrackerItemSnapshot[];
}

export interface Tracker extends CoordinatorTracker {
  snapshot(): Promise<TrackerSnapshot>;
  read(item: TrackerItemReference): Promise<TrackerItemSnapshot>;
  reread(item: TrackerItemReference): Promise<TrackerItemSnapshot>;
  claim(item: TrackerItemReference, actor: string): Promise<void>;
  release(item: TrackerItemReference, actor: string): Promise<void>;
  listBookkeeping(): Promise<readonly TrackerBookkeeping[]>;
  upsertBookkeeping(bookkeeping: TrackerBookkeeping): Promise<void>;
  updateBookkeeping(
    item: TrackerItemReference,
    bookkeeping: TrackerBookkeeping,
  ): Promise<TrackerItemSnapshot>;
}
