import type { NestedSessionEvent } from "./nested-session.js";
import type {
  CoordinatorProjection,
  RecentStageCandidateProjection,
  StageCandidateProjection,
} from "./coordinator.js";
import {
  AUTOMATION_STAGES,
  AUTOMATION_STAGE_LABELS,
  AUTOMODE_MODE_LABELS,
  type AutomationStage,
  type AutomationStageOperatingStateValue,
  type AutomodeMode,
} from "./stage-configuration.js";
import { createCanonicalTicketSessionPrompt } from "./ticket-session-prompt.js";

export type DashboardStageOperatingState = AutomationStageOperatingStateValue;
export type DashboardCandidateStatus =
  | "queued"
  | "claimed"
  | "running"
  | "waiting"
  | "retrying"
  | "blocked"
  | "human-owned"
  | "exhausted"
  | "settled";

interface DashboardActivityEntryBase {
  readonly id: string;
  readonly timestamp: string;
  readonly message: string;
}

export type DashboardActivityEntry =
  | (DashboardActivityEntryBase & {
      readonly kind: "assistant" | "thinking";
      readonly toolCount?: number;
    })
  | (DashboardActivityEntryBase & {
      readonly kind: "tools";
      readonly toolCount: number;
    })
  | (DashboardActivityEntryBase & {
      readonly kind: "tool";
      readonly toolName: string;
      readonly toolCallId: string;
      readonly toolCount?: never;
    })
  | (DashboardActivityEntryBase & {
      readonly kind: "child";
      readonly toolName: string;
      readonly toolCallId: string;
      readonly child: NestedSessionEvent;
      readonly toolCount?: never;
    })
  | (DashboardActivityEntryBase & {
      readonly kind: "error" | "terminal" | "coordinator";
      readonly toolCount?: never;
    });

export interface DashboardSessionAttempt {
  readonly attempt: number;
  readonly state: "current" | "settled";
  readonly events: readonly DashboardActivityEntry[];
  readonly terminalResult?: string;
}

export interface DashboardTicketSessionActivity {
  readonly processId?: string;
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly workspace?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly initialPrompt: string;
  readonly attempts: readonly DashboardSessionAttempt[];
}

export interface DashboardStageCandidate {
  readonly key: string;
  readonly itemKey: string;
  readonly item: string;
  readonly title: string;
  readonly url: string;
  readonly stage: AutomationStage;
  readonly status: DashboardCandidateStatus;
  readonly reason: string;
  readonly activity?: string;
  readonly attempt: number;
  readonly session?: DashboardTicketSessionActivity;
}

export interface DashboardLaneProjection {
  readonly stage: AutomationStage;
  readonly operatingState: DashboardStageOperatingState;
  readonly candidates: readonly DashboardStageCandidate[];
  readonly totals: {
    readonly candidates: number;
    readonly active: number;
    readonly queued: number;
    readonly held: number;
    readonly retrying: number;
    readonly exhausted: number;
  };
}

export interface DashboardProjection {
  readonly version: 1;
  readonly repository: { readonly name: string; readonly url: string };
  readonly run: {
    readonly id: string;
    readonly mode: AutomodeMode;
    readonly lifecycle: "loading" | "active" | "draining" | "degraded" | "empty";
    readonly startedAt: string;
    readonly lastSuccessfulPoll?: string;
    readonly nextPoll?: string;
  };
  readonly totals: {
    readonly candidates: number;
    readonly active: number;
    readonly queued: number;
    readonly held: number;
    readonly retrying: number;
    readonly exhausted: number;
  };
  readonly lanes: readonly DashboardLaneProjection[];
  readonly recent: readonly DashboardStageCandidate[];
  readonly tailscaleError?: string;
  readonly stale?: boolean;
}

export interface DashboardProjectionContext {
  readonly repository: DashboardProjection["repository"];
  readonly run: Omit<DashboardProjection["run"], "lastSuccessfulPoll" | "nextPoll">;
}

export interface DashboardUiAsset {
  readonly contentType: string;
  readonly body: string;
}

export type DashboardUiAssets = Readonly<Record<"/" | "/styles.css" | "/app.js", DashboardUiAsset>>;

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="automode-snapshot" content="/api/snapshot">
  <meta name="automode-events" content="/api/events">
  <meta name="automode-commands" content="/api/commands">
  <title>Automode Dashboard</title>
  <link rel="stylesheet" href="/styles.css">
  <script src="/app.js" defer></script>
</head>
<body>
  <a class="skip-link" href="#stage-lanes">Skip to Stage Lanes</a>
  <main id="app" aria-live="off">
    <section class="loading-shell" aria-busy="true">
      <p class="eyebrow">AUTOMODE COORDINATOR</p>
      <h1>Loading Stage Candidates</h1>
      <p>Waiting for the Coordinator dashboard projection.</p>
    </section>
  </main>
  <div id="announcer" class="sr-only" aria-live="polite" aria-atomic="true"></div>
</body>
</html>`;

const DASHBOARD_CSS = String.raw`:root {
  color-scheme: dark;
  --background: #070c15;
  --surface: #0d1626;
  --surface-raised: #121f34;
  --surface-hover: #172844;
  --line: #2c405d;
  --line-strong: #4d6b91;
  --text: #f4f8ff;
  --muted: #9aabc1;
  --dim: #71839a;
  --accent: #69a9ff;
  --success: #52da89;
  --warning: #ffd166;
  --danger: #ff8297;
  --held: #c7adff;
  --info: #c5ddff;
  --focus: #b9d8ff;
  --shadow: 0 24px 80px rgb(0 0 0 / 45%);
  font-family: "Cascadia Code", "JetBrains Mono", ui-monospace, SFMono-Regular, Consolas, monospace;
}

* { box-sizing: border-box; }
html { min-width: 320px; background: var(--background); }
body {
  margin: 0;
  min-height: 100vh;
  overflow-x: clip;
  background:
    radial-gradient(circle at 82% -10%, rgb(43 75 119 / 48%), transparent 36rem),
    linear-gradient(180deg, #09111f 0, var(--background) 24rem);
  color: var(--text);
  font-size: 14px;
  line-height: 1.5;
}
button, a { font: inherit; }
button {
  color: inherit;
  transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease;
}
a { color: var(--accent); }
button:not(:disabled) { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .58; }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; }

.skip-link {
  position: fixed;
  top: 8px;
  left: 8px;
  z-index: 100;
  transform: translateY(-150%);
  border-radius: 6px;
  background: var(--text);
  color: var(--background);
  padding: 8px 12px;
}
.skip-link:focus { transform: translateY(0); }
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.dashboard { max-width: 1600px; margin: 0 auto; padding: 24px 24px 72px; }
.masthead {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 18px;
}
.eyebrow { margin: 0; color: var(--accent); font-size: 11px; font-weight: 800; letter-spacing: .14em; }
.masthead h1 { margin: 4px 0 0; font-size: clamp(24px, 3.2vw, 38px); line-height: 1.12; letter-spacing: -.045em; }
.connection { display: flex; align-items: center; gap: 9px; color: var(--muted); font-size: 12px; }
.connection-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--success); box-shadow: 0 0 0 4px rgb(82 218 137 / 12%); }
.connection.connecting { color: var(--muted); }
.connection.connecting .connection-dot { background: var(--accent); box-shadow: 0 0 0 4px rgb(105 169 255 / 12%); }
.connection.disconnected { color: var(--danger); }
.connection.disconnected .connection-dot { background: var(--danger); box-shadow: 0 0 0 4px rgb(255 130 151 / 12%); }

.run-panel {
  display: grid;
  grid-template-columns: minmax(260px, 1.5fr) repeat(5, minmax(105px, .55fr));
  gap: 16px;
  align-items: center;
  border: 1px solid var(--line);
  border-radius: 13px;
  background: rgb(13 22 38 / 88%);
  box-shadow: var(--shadow);
  padding: 16px 18px;
}
.repo-name { display: block; overflow-wrap: anywhere; font-size: 16px; }
.repo-url { display: block; overflow: hidden; color: var(--muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.metric-label { display: block; color: var(--muted); font-size: 11px; }
.metric-value { display: block; margin-top: 2px; font-weight: 800; overflow-wrap: anywhere; }
.lifecycle { color: var(--success); }
.lifecycle.draining, .lifecycle.degraded, .lifecycle.loading { color: var(--warning); }

.banner {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 12px;
  overflow-wrap: anywhere;
  border: 1px solid #714152;
  border-radius: 8px;
  background: #26141c;
  color: #ffd4dc;
  padding: 11px 13px;
}
.banner.warning { border-color: #705b28; background: #231d0e; color: #ffe5a0; }
.banner strong { flex: 0 0 auto; }

.supervision-bar {
  position: sticky;
  top: 0;
  z-index: 8;
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 16px 0;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: rgb(8 14 25 / 93%);
  backdrop-filter: blur(14px);
  padding: 10px;
}
.action {
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--surface-raised);
  padding: 7px 11px;
}
.action:hover:not(:disabled) { border-color: var(--accent); background: var(--surface-hover); }
.action.drain { border-color: #7b5360; color: #ffd4dc; }
.supervision-note { margin-left: auto; color: var(--muted); font-size: 11px; text-align: right; }

.board-heading { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin: 22px 0 10px; }
.board-heading h2 { margin: 0; font-size: 13px; letter-spacing: .12em; }
.board-heading p { margin: 0; color: var(--muted); font-size: 11px; }
.lanes { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; align-items: start; }
.lane { min-width: 0; min-height: 370px; overflow: hidden; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
.lane[data-state="off"] { border-style: dashed; }
.lane-header { border-bottom: 1px solid var(--line); padding: 12px; }
.lane-title-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.lane-title { margin: 0; font-size: 12px; letter-spacing: .04em; }
.stage-control {
  flex: 0 0 auto;
  min-width: 78px;
  border: 1px solid var(--success);
  border-radius: 999px;
  background: #0d281b;
  color: var(--success);
  padding: 4px 8px;
  font-size: 10px;
  font-weight: 900;
}
.stage-control[data-state="draining"] { border-color: var(--warning); background: #2b220d; color: var(--warning); }
.stage-control[data-state="off"] { border-color: var(--dim); background: #172132; color: var(--muted); }
.lane-totals { display: flex; flex-wrap: wrap; gap: 7px 10px; margin-top: 8px; color: var(--muted); font-size: 10px; }
.lane-totals b { color: var(--text); }
.cards { padding: 1px 0 8px; }
.card {
  display: block;
  width: calc(100% - 18px);
  margin: 9px;
  border: 1px solid #2b4160;
  border-radius: 8px;
  background: var(--surface-raised);
  color: var(--text);
  padding: 11px;
  text-align: left;
}
.card:hover { border-color: #6187b8; background: var(--surface-hover); }
.card[aria-current="true"] { border-color: var(--accent); box-shadow: inset 3px 0 var(--accent); }
.status {
  display: inline-block;
  min-width: 78px;
  border: 1px solid currentColor;
  border-radius: 5px;
  padding: 2px 6px;
  color: var(--accent);
  font-size: 10px;
  font-weight: 900;
  letter-spacing: .025em;
  text-align: center;
}
.status.running, .status.settled { color: var(--success); }
.status.claimed, .status.waiting, .status.retrying { color: var(--warning); }
.status.blocked, .status.human-owned { color: var(--held); }
.status.exhausted { color: var(--danger); }
.card-title { display: block; margin-top: 8px; font-size: 13px; line-height: 1.35; overflow-wrap: anywhere; }
.card-activity { display: block; margin-top: 5px; color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
.card-elapsed { display: block; margin-top: 5px; color: var(--info); font-size: 10px; font-variant-numeric: tabular-nums; }
.card-reason { display: block; margin-top: 9px; border-top: 1px solid #263a56; padding-top: 8px; color: var(--info); font-size: 10px; overflow-wrap: anywhere; }
.empty-lane { display: grid; min-height: 130px; place-items: center; color: var(--muted); font-size: 11px; text-align: center; }

.recent { margin-top: 18px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface); }
.recent > summary { cursor: pointer; padding: 12px 14px; font-weight: 800; }
.recent-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; border-top: 1px solid var(--line); padding: 10px; }
.recent .card { width: 100%; margin: 0; }

.drawer-backdrop { position: fixed; inset: 0; z-index: 30; background: rgb(2 6 15 / 74%); backdrop-filter: blur(4px); }
.drawer {
  position: absolute;
  inset: 12px 12px 12px auto;
  display: flex;
  width: min(1220px, calc(100% - 24px));
  flex-direction: column;
  overflow: hidden;
  border: 1px solid #58749a;
  border-radius: 13px;
  background: #0a1220;
  box-shadow: var(--shadow);
}
.drawer-header { display: flex; flex: 0 0 auto; align-items: flex-start; justify-content: space-between; gap: 20px; border-bottom: 1px solid var(--line); padding: 16px 18px; }
.drawer-header h2 { margin: 4px 0 0; font-size: 20px; line-height: 1.25; overflow-wrap: anywhere; }
.close { border: 1px solid var(--line-strong); border-radius: 6px; background: var(--surface-raised); padding: 7px 10px; }
.drawer-meta { display: grid; flex: 0 0 auto; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; border-bottom: 1px solid var(--line); padding: 12px 18px; }
.drawer-meta span { display: block; color: var(--muted); font-size: 10px; }
.drawer-meta strong { display: block; margin-top: 3px; overflow-wrap: anywhere; }
.initial-prompt { flex: 0 0 auto; border-bottom: 1px solid var(--line); background: #0f1a2d; padding: 10px 18px 12px; }
.initial-prompt span { display: block; margin-bottom: 4px; color: var(--accent); font-size: 10px; font-weight: 800; letter-spacing: .08em; }
.initial-prompt code { display: block; overflow-wrap: anywhere; color: #d9e8ff; font: inherit; font-size: 12px; white-space: pre-wrap; }
.activity-split { display: grid; min-height: 0; flex: 1; grid-template-columns: minmax(0, 1.45fr) minmax(340px, .8fr); }
.feed { min-height: 0; overflow: auto; padding: 16px 18px 30px; }
.activity-split > .feed { border-right: 1px solid var(--line); }
.child-inspector { display: flex; min-width: 0; min-height: 0; flex-direction: column; }
.child-inspector-header { flex: 0 0 auto; border-bottom: 1px solid var(--line); padding: 11px 14px; color: var(--muted); font-size: 10px; font-weight: 800; letter-spacing: .08em; }
.child-list { display: grid; flex: 0 0 auto; gap: 4px; border-bottom: 1px solid var(--line); padding: 8px; }
.child-select { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 9px; align-items: center; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--text); padding: 9px 10px; text-align: left; }
.child-select:hover { border-color: var(--line); background: var(--surface-hover); }
.child-select.active { border-color: #486f9e; background: #11243d; }
.child-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--success); }
.child-dot.failed { background: var(--danger); }
.child-select strong, .child-select small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.child-select small { margin-top: 2px; color: var(--muted); font-size: 10px; }
.child-status { color: var(--muted); font-size: 10px; }
.child-detail { min-height: 0; flex: 1; overflow: auto; padding: 12px; }
.child-prompt { border: 1px solid var(--line); border-radius: 7px; background: #0f1a2d; padding: 10px 11px; }
.child-prompt span { display: block; margin-bottom: 5px; color: var(--accent); font-size: 10px; font-weight: 800; letter-spacing: .08em; }
.child-prompt code { display: block; overflow-wrap: anywhere; color: #d9e8ff; font: inherit; font-size: 11px; white-space: pre-wrap; }
.child-transcript { margin-top: 10px; overflow: hidden; border: 1px solid var(--line); border-radius: 7px; }
.tool-launch { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 9px; align-items: center; border: 1px solid #3b6089; border-radius: 6px; background: #0d2038; padding: 9px 10px; color: #d7e9ff; }
.tool-source { border-radius: 4px; background: #1d4e7e; padding: 3px 6px; color: #dceeff; font-size: 9px; font-weight: 900; letter-spacing: .06em; }
.tool-source.subagent { background: #4b3770; color: #eadcff; }
.attempt { margin-bottom: 18px; overflow: hidden; border: 1px solid var(--line); border-radius: 8px; }
.attempt-header { display: flex; justify-content: space-between; gap: 12px; background: var(--surface-raised); color: var(--muted); padding: 9px 11px; font-size: 11px; }
.transcript { padding: 16px 14px 18px; }
.transcript-row { color: var(--text); font-size: 13px; line-height: 1.55; overflow-wrap: anywhere; white-space: pre-wrap; }
.transcript-row + .transcript-row { margin-top: 18px; }
.transcript-thinking { color: #8992a2; font-style: italic; font-weight: 650; }
.transcript-thinking strong { font-weight: 750; }
.transcript-assistant { color: #e6e9ef; }
.transcript-tools { color: #8a919f; font-style: italic; }
.transcript-tool-count { margin-left: 7px; color: #8a919f; font-style: italic; font-weight: 500; white-space: nowrap; }
.transcript-row code { border-radius: 3px; background: #172132; color: #8fd0c7; padding: 1px 4px; font: inherit; }
.transcript-bullet { display: block; padding-left: 18px; text-indent: -14px; }
.transcript-system { border-left: 2px solid var(--line-strong); padding-left: 10px; color: var(--muted); font-size: 11px; }
.transcript-system.error, .transcript-system.terminal { border-left-color: var(--danger); color: #ffb6bd; }
.transcript-system-label { margin-right: 7px; font-weight: 900; text-transform: uppercase; }
.terminal-result { border-top: 1px solid var(--line); color: var(--muted); padding: 9px 11px; font-size: 11px; }
.no-session { display: grid; min-height: 300px; place-items: center; padding: 28px; text-align: center; }
.no-session h3 { margin-bottom: 6px; }
.no-session p { max-width: 520px; margin: 6px auto; color: var(--muted); }

.loading-shell, .fatal {
  display: grid;
  min-height: 100vh;
  place-content: center;
  padding: 24px;
  text-align: center;
}
.loading-shell h1, .fatal h1 { margin: 5px 0; }
.loading-shell p:last-child, .fatal p { color: var(--muted); }

@media (max-width: 1180px) {
  .run-panel { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .repository { grid-column: 1 / -1; }
  .lanes { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .recent-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 680px) {
  body { font-size: 13px; }
  .dashboard { padding: 16px 12px 48px; }
  .masthead { align-items: flex-start; flex-direction: column; gap: 10px; }
  .run-panel { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; padding: 14px; }
  .repository { grid-column: 1 / -1; }
  .run-panel .metric:last-child { grid-column: 1 / -1; }
  .banner { flex-direction: column; gap: 3px; }
  .stage-control, .action, .close { min-height: 44px; }
  .supervision-bar { align-items: stretch; flex-direction: column; }
  .supervision-note { margin: 2px 0 0; text-align: left; }
  .board-heading { align-items: flex-start; flex-direction: column; }
  .lanes, .recent-list { grid-template-columns: 1fr; }
  .lane { min-height: 0; }
  .drawer { inset: 0; width: 100%; border: 0; border-radius: 0; }
  .drawer-meta { grid-template-columns: 1fr 1fr; }
  .activity-split { display: block; overflow: auto; }
  .activity-split > .feed { max-height: 48%; border-right: 0; border-bottom: 1px solid var(--line); }
  .child-inspector { min-height: 52%; }
  .event { grid-template-columns: 70px 68px minmax(0, 1fr); gap: 7px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; }
}`;

const DASHBOARD_SCRIPT = String.raw`(() => {
  "use strict";

  const STAGES = ${JSON.stringify(AUTOMATION_STAGES)};
  const STAGE_LABELS = ${JSON.stringify(AUTOMATION_STAGE_LABELS)};
  const MODE_LABELS = ${JSON.stringify(AUTOMODE_MODE_LABELS)};
  const app = document.querySelector("#app");
  const announcer = document.querySelector("#announcer");
  const meta = (name) => document.querySelector('meta[name="' + name + '"]').content;
  const endpoints = {
    snapshot: meta("automode-snapshot"),
    events: meta("automode-events"),
    commands: meta("automode-commands")
  };
  const state = {
    projection: null,
    csrfToken: "",
    connection: "connecting",
    operationError: "",
    revision: null,
    network: {},
    selectedKey: null,
    selectedChildKey: null,
    returnFocusKey: null,
    recentOpen: false,
    pendingCommand: false,
    eventSource: null,
    activityLog: new Map(),
    activityRetentionTruncated: false,
    clockOffsetMilliseconds: 0
  };

  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
  })[character]);
  const status = (value) => '<span class="status ' + escapeHtml(value) + '">' + escapeHtml(String(value).toUpperCase()) + "</span>";
  const modeLabel = (mode) => MODE_LABELS[mode];
  const formatTime = (value) => {
    if (!value) return "Not scheduled";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };
  // Renders live run and Ticket Session durations from the Coordinator server's clock.
  const formatElapsed = (startedAt, endedAt) => {
    const start = new Date(startedAt).getTime();
    const end = endedAt ? new Date(endedAt).getTime() : Date.now() + state.clockOffsetMilliseconds;
    const totalSeconds = Math.max(0, Math.floor((end - start) / 1000));
    const seconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const minutes = totalMinutes % 60;
    const totalHours = Math.floor(totalMinutes / 60);
    const hours = totalHours % 24;
    const days = Math.floor(totalHours / 24);
    const clock = [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
    return days ? days + "d " + clock : clock;
  };
  const elapsedMarkup = (startedAt, endedAt) => '<span class="elapsed-value" data-elapsed-start="' + escapeHtml(startedAt) + '"' + (endedAt ? ' data-elapsed-end="' + escapeHtml(endedAt) + '"' : "") + '>' + formatElapsed(startedAt, endedAt) + "</span>";
  const updateElapsed = () => {
    document.querySelectorAll("[data-elapsed-start]").forEach((element) => {
      element.textContent = formatElapsed(element.dataset.elapsedStart, element.dataset.elapsedEnd);
    });
  };
  const announce = (message) => {
    announcer.textContent = "";
    window.setTimeout(() => { announcer.textContent = message; }, 20);
  };
  const CANDIDATE_STATUSES = new Set(["queued", "claimed", "running", "waiting", "retrying", "blocked", "human-owned", "exhausted", "settled"]);
  const ACTIVITY_KINDS = new Set(["assistant", "thinking", "tools", "tool", "child", "error", "terminal", "coordinator"]);
  const RUN_LIFECYCLES = new Set(["loading", "active", "draining", "degraded", "empty"]);
  const STAGE_STATES = new Set(["ON", "DRAINING", "OFF"]);
  const MAX_ACTIVITY_EVENTS_PER_ATTEMPT = 500;
  const MAX_ACTIVITY_EVENTS_TOTAL = 10000;
  const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const isCount = (value) => Number.isInteger(value) && value >= 0;
  const optionalString = (value) => value === undefined || typeof value === "string";
  const isTimestamp = (value) => typeof value === "string" && !Number.isNaN(new Date(value).getTime());
  const optionalTimestamp = (value) => value === undefined || isTimestamp(value);
  const isWebUrl = (value) => {
    if (typeof value !== "string") return false;
    try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
  };
  const contractError = (path) => { throw new Error("Invalid dashboard projection at " + path); };

  function validateTotals(value, path, includeTerminal = false) {
    if (!isRecord(value)) contractError(path);
    const fields = includeTerminal
      ? ["candidates", "active", "queued", "held", "retrying", "exhausted"]
      : ["candidates", "active", "queued", "held"];
    if (!fields.every((field) => isCount(value[field]))) contractError(path);
  }

  function validateNestedSession(value, path) {
    if (!isRecord(value) || typeof value.type !== "string" || typeof value.id !== "string" || !["panel", "subagent"].includes(value.source) || typeof value.label !== "string") contractError(path);
    if (![value.harness, value.provider, value.model, value.reasoning, value.headSha].every(optionalString)) contractError(path);
    if (value.type === "started") {
      if (typeof value.initialPrompt !== "string") contractError(path + ".initialPrompt");
      return;
    }
    if (value.type === "settled") {
      if (!["completed", "failed"].includes(value.status) || !optionalString(value.message)) contractError(path + ".status");
      return;
    }
    if (value.type !== "activity" || !isRecord(value.activity) || !["assistant", "thinking", "tools", "error"].includes(value.activity.kind) || typeof value.activity.message !== "string") contractError(path + ".activity");
    const validToolCount = Number.isInteger(value.activity.toolCount) && value.activity.toolCount > 0;
    if (value.activity.kind === "tools" && !validToolCount) contractError(path + ".activity.toolCount");
    if (value.activity.kind === "error" && value.activity.toolCount !== undefined) contractError(path + ".activity.toolCount");
  }

  function validateActivityEntry(value, path) {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.timestamp !== "string" || !ACTIVITY_KINDS.has(value.kind) || typeof value.message !== "string") contractError(path);
    const validToolCount = Number.isInteger(value.toolCount) && value.toolCount > 0;
    if (value.kind === "tools" && !validToolCount) contractError(path + ".toolCount");
    if ((value.kind === "error" || value.kind === "terminal" || value.kind === "coordinator" || value.kind === "tool" || value.kind === "child") && value.toolCount !== undefined) contractError(path + ".toolCount");
    if ((value.kind === "assistant" || value.kind === "thinking") && value.toolCount !== undefined && !validToolCount) contractError(path + ".toolCount");
    if (value.kind === "tool" || value.kind === "child") {
      if (typeof value.toolName !== "string" || typeof value.toolCallId !== "string") contractError(path + ".tool");
    }
    if (value.kind === "child") validateNestedSession(value.child, path + ".child");
  }

  function validateSession(value, path) {
    if (!isRecord(value) || !optionalString(value.processId) || typeof value.sessionId !== "string" || !optionalString(value.sessionFile) || !optionalString(value.workspace) || !optionalTimestamp(value.startedAt) || !optionalTimestamp(value.endedAt) || (value.endedAt !== undefined && value.startedAt === undefined) || typeof value.initialPrompt !== "string" || !Array.isArray(value.attempts)) contractError(path);
    value.attempts.forEach((attempt, index) => {
      const attemptPath = path + ".attempts[" + index + "]";
      if (!isRecord(attempt) || !isCount(attempt.attempt) || (attempt.state !== "current" && attempt.state !== "settled") || !Array.isArray(attempt.events) || !optionalString(attempt.terminalResult)) contractError(attemptPath);
      attempt.events.forEach((event, eventIndex) => validateActivityEntry(event, attemptPath + ".events[" + eventIndex + "]"));
    });
  }

  function validateCandidate(value, path) {
    if (!isRecord(value) || typeof value.key !== "string" || typeof value.itemKey !== "string" || typeof value.item !== "string" || typeof value.title !== "string" || !isWebUrl(value.url) || !STAGES.includes(value.stage) || !CANDIDATE_STATUSES.has(value.status) || typeof value.reason !== "string" || !optionalString(value.activity) || !isCount(value.attempt)) contractError(path);
    if (value.session !== undefined) validateSession(value.session, path + ".session");
  }

  function validateProjection(value) {
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.repository) || typeof value.repository.name !== "string" || !isWebUrl(value.repository.url) || !isRecord(value.run) || typeof value.run.id !== "string" || !MODE_LABELS[value.run.mode] || !RUN_LIFECYCLES.has(value.run.lifecycle) || !isTimestamp(value.run.startedAt) || !optionalString(value.run.lastSuccessfulPoll) || !optionalString(value.run.nextPoll) || !Array.isArray(value.lanes) || !Array.isArray(value.recent) || (value.stale !== undefined && typeof value.stale !== "boolean") || !optionalString(value.tailscaleError)) contractError("root");
    validateTotals(value.totals, "totals", true);
    const seenStages = new Set();
    const seenCandidates = new Set();
    value.lanes.forEach((lane, laneIndex) => {
      const path = "lanes[" + laneIndex + "]";
      if (!isRecord(lane) || !STAGES.includes(lane.stage) || seenStages.has(lane.stage) || !STAGE_STATES.has(lane.operatingState) || !Array.isArray(lane.candidates)) contractError(path);
      seenStages.add(lane.stage);
      validateTotals(lane.totals, path + ".totals", true);
      if (lane.totals.candidates !== lane.candidates.length) contractError(path + ".totals.candidates");
      lane.candidates.forEach((candidate, candidateIndex) => {
        validateCandidate(candidate, path + ".candidates[" + candidateIndex + "]");
        if (candidate.stage !== lane.stage || seenCandidates.has(candidate.key)) contractError(path + ".candidates[" + candidateIndex + "]");
        seenCandidates.add(candidate.key);
      });
    });
    if (seenStages.size !== STAGES.length) contractError("lanes");
    value.recent.forEach((candidate, index) => {
      validateCandidate(candidate, "recent[" + index + "]");
      if (seenCandidates.has(candidate.key)) contractError("recent[" + index + "]");
      seenCandidates.add(candidate.key);
    });
    const candidateTotal = value.lanes.reduce((total, lane) => total + lane.candidates.length, 0);
    if (value.totals.candidates !== candidateTotal) contractError("totals.candidates");
    return value;
  }

  function validateEnvelope(payload) {
    if (!isRecord(payload) || !Number.isInteger(payload.revision) || payload.revision < 0 || !isRecord(payload.network) || !optionalString(payload.network.localUrl) || !optionalString(payload.network.remoteUrl) || !optionalString(payload.network.exposureError) || !isTimestamp(payload.serverTime) || (payload.activities !== undefined && !Array.isArray(payload.activities)) || (payload.activitiesTruncated !== undefined && typeof payload.activitiesTruncated !== "boolean")) contractError("envelope");
    const activities = payload.activities || [];
    activities.forEach((activity, index) => {
      if (!isRecord(activity) || typeof activity.id !== "string" || typeof activity.itemKey !== "string" || typeof activity.occurredAt !== "string" || typeof activity.kind !== "string" || !optionalString(activity.message)) contractError("envelope.activities[" + index + "]");
    });
    return { revision: payload.revision, network: payload.network, projection: validateProjection(payload.projection), activities, activitiesTruncated: payload.activitiesTruncated === true, serverTime: payload.serverTime };
  }

  function allCandidates() {
    if (!state.projection) return [];
    return [...state.projection.lanes.flatMap((lane) => lane.candidates), ...state.projection.recent];
  }

  function supervisionDisabled(projection) {
    return state.pendingCommand || state.connection !== "live" || projection.stale || projection.run.lifecycle === "loading" || projection.run.lifecycle === "draining";
  }

  function candidateByKey(key) {
    return allCandidates().find((candidate) => candidate.key === key);
  }

  function focusIdentity() {
    const active = document.activeElement;
    return active && active.dataset ? active.dataset.focusId : undefined;
  }

  function restoreFocus(identity) {
    if (!identity) return;
    const target = [...document.querySelectorAll("[data-focus-id]")].find((element) => element.dataset.focusId === identity);
    if (target) target.focus({ preventScroll: true });
  }

  function card(candidate, recent = false) {
    const selected = state.selectedKey === candidate.key;
    const activity = candidate.activity || (candidate.session ? "Ticket Session activity available" : "No Ticket Session exists yet");
    const sessionElapsed = candidate.session?.startedAt
      ? '<span class="card-elapsed">Elapsed ' + elapsedMarkup(candidate.session.startedAt, candidate.session.endedAt) + "</span>"
      : "";
    return '<button class="card" type="button" data-candidate-key="' + escapeHtml(candidate.key) + '" data-focus-id="candidate:' + escapeHtml(candidate.key) + '" aria-current="' + selected + '" aria-label="Inspect ' + escapeHtml(candidate.item + " " + candidate.title) + '">' +
      status(candidate.status) +
      '<strong class="card-title">' + escapeHtml(candidate.item) + " · " + escapeHtml(candidate.title) + "</strong>" +
      '<span class="card-activity">' + escapeHtml(activity) + "</span>" +
      sessionElapsed +
      '<span class="card-reason">' + escapeHtml(recent ? "Settled during this Coordinator process. " + candidate.reason : candidate.reason) + "</span>" +
      "</button>";
  }

  function lane(stage) {
    const projection = state.projection;
    const laneProjection = projection.lanes.find((candidateLane) => candidateLane.stage === stage) || {
      stage, operatingState: "OFF", candidates: [], totals: { candidates: 0, active: 0, queued: 0, held: 0, retrying: 0, exhausted: 0 }
    };
    const operatingState = String(laneProjection.operatingState).toLowerCase();
    const commandLabel = operatingState === "on" ? "Turn off" : operatingState === "draining" ? "Re-enable" : "Turn on";
    const disabled = supervisionDisabled(projection);
    return '<section class="lane" data-state="' + operatingState + '" aria-labelledby="lane-' + stage + '">' +
      '<header class="lane-header"><div class="lane-title-row">' +
      '<h3 class="lane-title" id="lane-' + stage + '">' + STAGE_LABELS[stage] + "</h3>" +
      '<button class="stage-control" type="button" data-stage="' + stage + '" data-state="' + operatingState + '" data-active="' + laneProjection.totals.active + '" data-focus-id="stage:' + stage + '" aria-label="' + commandLabel + " " + STAGE_LABELS[stage] + '" ' + (disabled ? "disabled" : "") + '>' + operatingState.toUpperCase() + "</button>" +
      '</div><div class="lane-totals"><span><b>' + laneProjection.totals.candidates + "</b> candidates</span><span><b>" + laneProjection.totals.active + "</b> active</span><span><b>" + laneProjection.totals.queued + "</b> queued</span><span><b>" + laneProjection.totals.held + "</b> held</span></div></header>" +
      '<div class="cards">' + (laneProjection.candidates.length
        ? laneProjection.candidates.map((candidate) => card(candidate)).join("")
        : '<div class="empty-lane">No Stage Candidates</div>') + "</div></section>";
  }

  function toolCountText(count) {
    return "+ " + count + " tool " + (count === 1 ? "call" : "calls");
  }

  function inlineTranscriptMarkdown(value) {
    return escapeHtml(value)
      .replace(/\x60([^\x60\n]+)\x60/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  }

  function transcriptMessage(value) {
    return value.split(/\r?\n/).map((line) => {
      const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
      return bullet
        ? '<span class="transcript-bullet">• ' + inlineTranscriptMarkdown(bullet[1]) + "</span>"
        : inlineTranscriptMarkdown(line);
    }).join("<br>");
  }

  function eventRow(event) {
    const suffix = event.toolCount
      ? '<span class="transcript-tool-count">' + toolCountText(event.toolCount) + "</span>"
      : "";
    if (event.kind === "assistant" || event.kind === "thinking") {
      return '<div class="transcript-row transcript-' + event.kind + '"><span>' + transcriptMessage(event.message) + "</span>" + suffix + "</div>";
    }
    if (event.kind === "tools") {
      return '<div class="transcript-row transcript-tools">' + toolCountText(event.toolCount || 1) + "</div>";
    }
    if (event.kind === "tool") {
      const source = event.toolName === "automode_panel" ? "PANEL" : "SUBAGENT";
      const sourceClass = source === "SUBAGENT" ? " subagent" : "";
      return '<div class="transcript-row"><div class="tool-launch"><span class="tool-source' + sourceClass + '">' + source + '</span><strong>' + escapeHtml(event.message) + "</strong></div></div>";
    }
    if (event.kind === "child") return "";
    return '<div class="transcript-row transcript-system ' + escapeHtml(event.kind) + '"><span class="transcript-system-label">' + escapeHtml(event.kind) + "</span>" + transcriptMessage(event.message) + "</div>";
  }

  function transcript(events) {
    return '<div class="transcript">' + events.map(eventRow).join("") + "</div>";
  }

  function nestedSessions(session) {
    const sessions = new Map();
    for (const attempt of session.attempts) {
      for (const event of attempt.events) {
        if (event.kind !== "child") continue;
        const child = event.child;
        const key = attempt.attempt + ":" + event.toolCallId + ":" + child.id;
        let nested = sessions.get(key);
        if (!nested) {
          nested = {
            key,
            attempt: attempt.attempt,
            toolCallId: event.toolCallId,
            id: child.id,
            source: child.source,
            label: child.label,
            harness: child.harness,
            provider: child.provider,
            model: child.model,
            reasoning: child.reasoning,
            headSha: child.headSha,
            initialPrompt: "Prompt unavailable",
            status: "running",
            events: []
          };
          sessions.set(key, nested);
        }
        Object.assign(nested, {
          label: child.label,
          harness: child.harness,
          provider: child.provider,
          model: child.model,
          reasoning: child.reasoning,
          headSha: child.headSha
        });
        if (child.type === "started") nested.initialPrompt = child.initialPrompt;
        else if (child.type === "activity") nested.events.push({
          id: event.id + ":nested",
          timestamp: event.timestamp,
          ...child.activity
        });
        else {
          nested.status = child.status;
          nested.terminalMessage = child.message;
        }
      }
    }
    return [...sessions.values()];
  }

  function childSessionButton(child) {
    const selected = state.selectedChildKey === child.key;
    const identity = [child.source.toUpperCase(), child.harness, child.provider, child.model, child.reasoning].filter(Boolean).join(" · ");
    const count = child.events.reduce((total, event) => total + (event.toolCount || 0), 0);
    return '<button class="child-select ' + (selected ? "active" : "") + '" type="button" data-child-key="' + escapeHtml(child.key) + '" aria-pressed="' + selected + '"><span class="child-dot ' + (child.status === "failed" ? "failed" : "") + '"></span><span><strong>' + escapeHtml(child.label) + '</strong><small>' + escapeHtml(identity) + '</small></span><span class="child-status">' + (child.status === "running" && count ? count + " calls" : escapeHtml(child.status.toUpperCase())) + "</span></button>";
  }

  function childInspector(children) {
    if (!children.length) return "";
    if (!children.some((child) => child.key === state.selectedChildKey)) state.selectedChildKey = children[0].key;
    const selected = children.find((child) => child.key === state.selectedChildKey) || children[0];
    const detail = selected
      ? '<div class="child-detail"><div class="child-prompt"><span>INITIAL PROMPT</span><code>' + escapeHtml(selected.initialPrompt) + '</code></div><div class="child-transcript">' + (selected.events.length ? transcript(selected.events) : '<p class="terminal-result">No nested transcript activity received yet.</p>') + (selected.terminalMessage ? '<div class="terminal-result"><strong>Terminal result:</strong> ' + escapeHtml(selected.terminalMessage) + "</div>" : "") + "</div></div>"
      : "";
    return '<aside class="child-inspector" aria-label="Child sessions"><div class="child-inspector-header">CHILD SESSIONS · ' + children.length + '</div><div class="child-list">' + children.map(childSessionButton).join("") + "</div>" + detail + "</aside>";
  }

  function parentFeed(session) {
    return '<div class="feed">' + session.attempts.map((attempt) =>
      '<section class="attempt" aria-label="Attempt ' + attempt.attempt + '"><header class="attempt-header"><span>Attempt ' + attempt.attempt + " · " + (attempt.state === "current" ? "current" : "prior history") + "</span><span>" + (attempt.state === "current" ? "● LIVE" : "SETTLED") + "</span></header>" +
      (attempt.events.length ? transcript(attempt.events) : '<p class="terminal-result">No transcript activity received yet.</p>') +
      (attempt.terminalResult ? '<div class="terminal-result"><strong>Terminal result:</strong> ' + escapeHtml(attempt.terminalResult) + "</div>" : "") + "</section>"
    ).join("") + "</div>";
  }

  function drawer(candidate) {
    if (!candidate) return "";
    const session = candidate.session;
    const workspace = session && session.workspace ? session.workspace : "Not created";
    const children = session ? nestedSessions(session) : [];
    const pinnedHead = children.find((child) => child.headSha)?.headSha;
    const parent = session ? parentFeed(session) : "";
    const content = session
      ? children.length ? '<div class="activity-split">' + parent + childInspector(children) + "</div>" : parent
      : '<div class="no-session"><div><h3>No Ticket Session exists yet</h3><p>' + escapeHtml(candidate.reason) + "</p><p>Inspecting this candidate is read-only. Activity will appear only after the Coordinator dispatches it.</p></div></div>";
    return '<div class="drawer-backdrop"><section class="drawer" role="dialog" aria-modal="true" aria-labelledby="activity-title">' +
      '<header class="drawer-header"><div><p class="eyebrow">' + escapeHtml(STAGE_LABELS[candidate.stage]) + ' · READ-ONLY ACTIVITY</p><h2 id="activity-title">' + escapeHtml(candidate.item) + " · " + escapeHtml(candidate.title) + '</h2></div><button class="close" type="button" data-close-drawer data-focus-id="drawer-close">Close</button></header>' +
      '<div class="drawer-meta"><div><span>Lifecycle</span><strong>' + status(candidate.status) + "</strong></div><div><span>Attempt</span><strong>" + candidate.attempt + "/5</strong></div><div><span>Elapsed</span><strong>" + (session?.startedAt ? elapsedMarkup(session.startedAt, session.endedAt) : "Not available") + "</strong></div><div><span>Process</span><strong>" + escapeHtml(session?.processId ?? "Not started") + "</strong></div><div><span>Session</span><strong>" + escapeHtml(session ? session.sessionId : "Not created") + "</strong></div><div><span>Workspace</span><strong>" + escapeHtml(workspace) + "</strong></div>" + (pinnedHead ? '<div><span>Pinned review head</span><strong>' + escapeHtml(pinnedHead.slice(0, 12)) + "</strong></div>" : "") + "</div>" +
      (session ? '<div class="initial-prompt"><span>DISPATCH COMMAND</span><code>' + escapeHtml(session.initialPrompt) + "</code></div>" : "") + content + "</section></div>";
  }

  function render() {
    if (!state.projection) return;
    const identity = focusIdentity();
    const currentRecent = document.querySelector(".recent");
    if (currentRecent) state.recentOpen = currentRecent.open;
    const currentFeed = document.querySelector(".feed");
    const feedScrollTop = currentFeed ? currentFeed.scrollTop : undefined;
    const feedWasAtEnd = currentFeed ? currentFeed.scrollHeight - currentFeed.scrollTop - currentFeed.clientHeight < 40 : false;
    const projection = state.projection;
    const disconnected = state.connection === "disconnected" || projection.stale;
    const connecting = state.connection === "connecting";
    const selected = state.selectedKey ? candidateByKey(state.selectedKey) : undefined;
    if (state.selectedKey && !selected) state.selectedKey = null;
    const disabled = supervisionDisabled(projection);
    const exposureError = state.network.exposureError || projection.tailscaleError;
    const exposureSeparator = exposureError && /[.!?]$/.test(exposureError.trim()) ? " " : ". ";
    const banners = [
      exposureError ? '<div class="banner warning" role="status"><strong>Tailscale unavailable</strong><span>' + escapeHtml(exposureError) + exposureSeparator + "Localhost access remains available.</span></div>" : "",
      disconnected ? '<div class="banner" role="alert"><strong>Disconnected</strong><span>This view is stale. Supervisory controls are disabled until the live connection returns.</span></div>' : "",
      state.activityRetentionTruncated ? '<div class="banner warning" role="status"><strong>Activity history limited</strong><span>Earlier activity was truncated to keep this dashboard responsive.</span></div>' : "",
      state.operationError ? '<div class="banner" role="alert"><strong>Command failed</strong><span>' + escapeHtml(state.operationError) + "</span></div>" : ""
    ].join("");
    const connectionClass = disconnected ? "disconnected" : connecting ? "connecting" : "";
    const connectionLabel = disconnected ? "Disconnected · stale snapshot" : connecting ? "Connecting to live Coordinator stream" : "Live Coordinator connection";
    app.innerHTML = '<div class="dashboard"><header class="masthead"><div><p class="eyebrow">AUTOMODE COORDINATOR</p><h1>Stage Lanes</h1></div><div class="connection ' + connectionClass + '"><span class="connection-dot" aria-hidden="true"></span><span>' + connectionLabel + "</span></div></header>" +
      '<section class="run-panel" aria-label="Automode Run summary"><div class="repository"><strong class="repo-name">' + escapeHtml(projection.repository.name) + '</strong><a class="repo-url" href="' + escapeHtml(projection.repository.url) + '" target="_blank" rel="noreferrer">' + escapeHtml(projection.repository.url) + "</a></div>" +
      '<div class="metric"><span class="metric-label">Run identity</span><strong class="metric-value">' + escapeHtml(projection.run.id) + "</strong></div>" +
      '<div class="metric"><span class="metric-label">Launch mode</span><strong class="metric-value">' + modeLabel(projection.run.mode) + "</strong></div>" +
      '<div class="metric"><span class="metric-label">Lifecycle</span><strong class="metric-value lifecycle ' + projection.run.lifecycle + '">' + projection.run.lifecycle.toUpperCase() + "</strong></div>" +
      '<div class="metric"><span class="metric-label">Elapsed</span><strong class="metric-value">' + elapsedMarkup(projection.run.startedAt) + "</strong></div>" +
      '<div class="metric"><span class="metric-label">Stage Candidates</span><strong class="metric-value">' + projection.totals.candidates + " open · " + projection.totals.active + " active · " + projection.totals.queued + " queued · " + projection.totals.held + " held · " + projection.totals.retrying + " retrying · " + projection.totals.exhausted + " exhausted</strong></div></section>" + banners +
      '<nav class="supervision-bar" aria-label="Coordinator supervision"><button class="action" type="button" data-command="refresh" data-focus-id="command:refresh" ' + (disabled ? "disabled" : "") + '>Refresh snapshot</button><button class="action drain" type="button" data-command="drain" data-focus-id="command:drain" ' + (disabled ? "disabled" : "") + '>Graceful drain</button><span class="supervision-note">Last poll ' + escapeHtml(formatTime(projection.run.lastSuccessfulPoll)) + " · Next " + escapeHtml(formatTime(projection.run.nextPoll)) + "</span></nav>" +
      '<div class="board-heading"><h2 id="stage-lanes">OPEN STAGE CANDIDATES</h2><p>Every non-running card explains why Automode has not dispatched it.</p></div><div class="lanes">' + STAGES.map(lane).join("") + "</div>" +
      '<details class="recent" ' + (state.recentOpen ? "open" : "") + '><summary data-focus-id="recent">Recent · ' + projection.recent.length + ' settled during this Coordinator process</summary><div class="recent-list">' + (projection.recent.length ? projection.recent.map((candidate) => card(candidate, true)).join("") : '<div class="empty-lane">No recent items</div>') + "</div></details></div>" + drawer(selected);
    bindInteractions();
    restoreFocus(identity);
    const nextFeed = document.querySelector(".feed");
    if (nextFeed && feedScrollTop !== undefined) {
      nextFeed.scrollTop = feedWasAtEnd ? nextFeed.scrollHeight : feedScrollTop;
    }
  }

  function mergeActivityIntoProjection() {
    for (const candidate of allCandidates()) {
      if (!candidate.session) continue;
      const activityKey = candidate.itemKey + ":" + candidate.session.sessionId;
      const attempts = state.activityLog.get(activityKey);
      if (!attempts) continue;
      for (const [attemptNumber, activityAttempt] of attempts) {
        let attempt = candidate.session.attempts.find((candidateAttempt) => candidateAttempt.attempt === attemptNumber);
        if (!attempt) {
          attempt = { attempt: attemptNumber, state: activityAttempt.state, events: [] };
          candidate.session.attempts.push(attempt);
        } else {
          attempt.state = activityAttempt.state;
        }
        for (const event of activityAttempt.events) {
          if (!attempt.events.some((candidateEvent) => candidateEvent.id === event.id)) attempt.events.push(event);
        }
      }
      candidate.session.attempts.sort((left, right) => left.attempt - right.attempt);
    }
  }

  function applyEnvelope(payload) {
    const envelope = validateEnvelope(payload);
    state.projection = envelope.projection;
    state.revision = envelope.revision;
    state.clockOffsetMilliseconds = new Date(envelope.serverTime).getTime() - Date.now();
    state.network = envelope.network;
    state.activityRetentionTruncated = state.activityRetentionTruncated || envelope.activitiesTruncated;
    for (const activity of envelope.activities) recordActivity(activity);
    mergeActivityIntoProjection();
  }

  async function sendCommand(command) {
    if (state.pendingCommand || state.connection !== "live" || state.projection.stale || !Number.isInteger(state.revision)) return;
    state.pendingCommand = true;
    state.operationError = "";
    render();
    const commandName = command.type === "set-stage-state" ? "stage-state" : command.type;
    const body = command.type === "set-stage-state" ? { stage: command.stage, state: command.state } : {};
    try {
      const response = await fetch(endpoints.commands + "/" + commandName, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-automode-csrf": state.csrfToken,
          "if-match": '"' + state.revision + '"'
        },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        let detail = "Coordinator rejected the command with HTTP " + response.status;
        try {
          const failure = await response.json();
          if (failure && failure.error) detail = failure.error;
        } catch {}
        if (response.status === 409) state.connection = "disconnected";
        throw new Error(detail);
      }
      if (response.status !== 204 && response.headers.get("content-type")?.includes("application/json")) {
        applyEnvelope(await response.json());
      }
      announce(command.type === "refresh" ? "Fresh tracker scan requested" : command.type === "drain" ? "Graceful drain requested" : "Automation Stage state change requested");
    } catch (error) {
      state.operationError = error instanceof Error ? error.message : String(error);
    } finally {
      state.pendingCommand = false;
      render();
    }
  }

  function closeDrawer() {
    const focusKey = state.returnFocusKey;
    state.selectedKey = null;
    state.selectedChildKey = null;
    render();
    if (focusKey) restoreFocus("candidate:" + focusKey);
  }

  function trapDialogFocus(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDrawer();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return;
    const controls = [...dialog.querySelectorAll('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')];
    if (!controls.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  }

  function bindInteractions() {
    document.querySelectorAll("[data-candidate-key]").forEach((element) => element.addEventListener("click", () => {
      state.selectedKey = element.dataset.candidateKey;
      state.selectedChildKey = null;
      state.returnFocusKey = state.selectedKey;
      render();
      document.querySelector("[data-close-drawer]").focus();
    }));
    document.querySelectorAll("[data-child-key]").forEach((element) => element.addEventListener("click", () => {
      state.selectedChildKey = element.dataset.childKey;
      render();
    }));
    document.querySelectorAll("[data-stage]").forEach((element) => element.addEventListener("click", () => {
      const targetState = element.dataset.state === "on"
        ? Number(element.dataset.active) > 0 ? "DRAINING" : "OFF"
        : "ON";
      sendCommand({ type: "set-stage-state", stage: element.dataset.stage, state: targetState });
    }));
    document.querySelector('[data-command="refresh"]')?.addEventListener("click", () => sendCommand({ type: "refresh" }));
    document.querySelector('[data-command="drain"]')?.addEventListener("click", () => sendCommand({ type: "drain" }));
    document.querySelector(".recent")?.addEventListener("toggle", (event) => { state.recentOpen = event.currentTarget.open; });
    document.querySelector("[data-close-drawer]")?.addEventListener("click", closeDrawer);
    document.querySelector(".drawer-backdrop")?.addEventListener("click", (event) => {
      if (event.target === event.currentTarget) closeDrawer();
    });
  }

  function pruneActivityLog() {
    const count = () => [...state.activityLog.values()].reduce(
      (total, attempts) => total + [...attempts.values()].reduce((attemptTotal, attempt) => attemptTotal + attempt.events.length, 0),
      0
    );
    while (count() > MAX_ACTIVITY_EVENTS_TOTAL) {
      const oldestKey = state.activityLog.keys().next().value;
      if (oldestKey === undefined) break;
      state.activityLog.delete(oldestKey);
      state.activityRetentionTruncated = true;
    }
  }

  function recordActivity(message, eventId) {
    if (!isRecord(message) || (typeof message.itemKey !== "string" && typeof message.candidateKey !== "string")) contractError("activity");
    const itemKey = message.candidateKey || message.itemKey;
    const details = isRecord(message.data) ? message.data : {};
    const candidate = allCandidates().find((candidate) => candidate.itemKey === itemKey && (typeof details.sessionId !== "string" || candidate.session?.sessionId === details.sessionId));
    const sessionId = typeof details.sessionId === "string" ? details.sessionId : candidate?.session?.sessionId ?? "";
    const activityKey = itemKey + ":" + sessionId;
    const attemptNumber = Number.isInteger(message.attempt) ? message.attempt : Number.isInteger(details.attempt) ? details.attempt : Math.max(1, candidate ? candidate.attempt : 1);
    const event = message.event || {
      id: message.id || eventId || message.occurredAt + ":" + message.kind,
      timestamp: message.occurredAt,
      kind: ACTIVITY_KINDS.has(message.kind) ? message.kind : "coordinator",
      message: message.message || (message.data === undefined ? message.kind : JSON.stringify(message.data)),
      ...(Number.isInteger(details.toolCount) ? { toolCount: details.toolCount } : {}),
      ...(typeof details.toolName === "string" ? { toolName: details.toolName } : {}),
      ...(typeof details.toolCallId === "string" ? { toolCallId: details.toolCallId } : {}),
      ...(isRecord(details.child) ? { child: details.child } : {})
    };
    validateActivityEntry(event, "activity.event");
    if (candidate) candidate.activity = event.message;
    let attempts = state.activityLog.get(activityKey);
    if (!attempts) {
      attempts = new Map();
      state.activityLog.set(activityKey, attempts);
    }
    let activityAttempt = attempts.get(attemptNumber);
    const attemptState = details.source === "persisted" || details.source === "terminal" ? "settled" : "current";
    if (!activityAttempt) {
      activityAttempt = { state: attemptState, events: [] };
      attempts.set(attemptNumber, activityAttempt);
    } else if (attemptState === "settled" || activityAttempt.state !== "settled") {
      activityAttempt.state = attemptState;
    }
    if (activityAttempt.events.some((candidateEvent) => candidateEvent.id === event.id)) return;
    if (activityAttempt.events.length >= MAX_ACTIVITY_EVENTS_PER_ATTEMPT) {
      const markerId = activityKey + ":" + attemptNumber + ":truncated";
      if (activityAttempt.events[0]?.id === markerId) activityAttempt.events.splice(1, 1);
      else {
        activityAttempt.events.splice(0, 2);
        activityAttempt.events.unshift({
          id: markerId,
          timestamp: event.timestamp,
          kind: "coordinator",
          message: "Earlier activity in this attempt was truncated to keep the view responsive."
        });
      }
    }
    activityAttempt.events.push(event);
    pruneActivityLog();
  }

  function appendActivity(message, eventId) {
    recordActivity(message, eventId);
    mergeActivityIntoProjection();
    render();
  }

  function connectEvents() {
    const events = new EventSource(endpoints.events, { withCredentials: true });
    state.eventSource = events;
    events.addEventListener("open", () => {
      state.connection = "live";
      state.operationError = "";
      if (state.projection) render();
    });
    events.addEventListener("projection", (event) => {
      try {
        applyEnvelope(JSON.parse(event.data));
        state.connection = "live";
        render();
      } catch (error) {
        state.connection = "disconnected";
        state.operationError = "Live projection rejected: " + (error instanceof Error ? error.message : String(error));
        events.close();
        render();
      }
    });
    events.addEventListener("activity", (event) => {
      try {
        appendActivity(JSON.parse(event.data), event.lastEventId);
      } catch (error) {
        state.operationError = "Live activity rejected: " + (error instanceof Error ? error.message : String(error));
        render();
      }
    });
    events.addEventListener("error", () => {
      state.connection = "disconnected";
      if (state.projection) render();
    });
  }

  async function start() {
    try {
      const response = await fetch(endpoints.snapshot, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("Snapshot request failed with HTTP " + response.status);
      const payload = await response.json();
      if (!isRecord(payload) || typeof payload.csrfToken !== "string") throw new Error("Snapshot response did not contain the dashboard contract");
      applyEnvelope(payload);
      state.csrfToken = payload.csrfToken;
      render();
      connectEvents();
    } catch (error) {
      app.innerHTML = '<section class="fatal" role="alert"><div><p class="eyebrow">AUTOMODE COORDINATOR</p><h1>Dashboard unavailable</h1><p>' + escapeHtml(error instanceof Error ? error.message : String(error)) + "</p></div></section>";
    }
  }

  document.addEventListener("keydown", trapDialogFocus);
  window.setInterval(updateElapsed, 1000);
  start();
})();`;

function dashboardItemKey(
  candidate: Pick<StageCandidateProjection | RecentStageCandidateProjection, "item">,
): string {
  return `${candidate.item.kind}:${candidate.item.number}`;
}

function dashboardCandidateKey(
  candidate: StageCandidateProjection | RecentStageCandidateProjection,
): string {
  const base = `${dashboardItemKey(candidate)}:${candidate.stage}`;
  return "settledAt" in candidate ? `${base}:recent:${candidate.settledAt}` : base;
}

function dashboardItemLabel(
  candidate: Pick<StageCandidateProjection | RecentStageCandidateProjection, "item">,
): string {
  return candidate.item.kind === "pull-request" ? `PR #${candidate.item.number}` : `#${candidate.item.number}`;
}

function mapDashboardCandidate(
  candidate: StageCandidateProjection | RecentStageCandidateProjection,
): DashboardStageCandidate {
  return {
    key: dashboardCandidateKey(candidate),
    itemKey: dashboardItemKey(candidate),
    item: dashboardItemLabel(candidate),
    title: candidate.title ?? "Untitled tracker item",
    url: candidate.item.url,
    stage: candidate.stage,
    status: candidate.status,
    reason: candidate.reason,
    ...(candidate.status === "waiting" ? { activity: candidate.reason } : {}),
    attempt: candidate.attempt,
    ...(candidate.session === undefined ? {} : {
      session: {
        ...(candidate.session.processId === undefined ? {} : { processId: candidate.session.processId }),
        sessionId: candidate.session.sessionId,
        sessionFile: candidate.session.sessionFile,
        ...(candidate.session.workspace === undefined ? {} : { workspace: candidate.session.workspace }),
        ...(candidate.session.startedAt === undefined ? {} : { startedAt: candidate.session.startedAt }),
        ...(candidate.session.endedAt === undefined ? {} : { endedAt: candidate.session.endedAt }),
        initialPrompt: createCanonicalTicketSessionPrompt(candidate.skillName, candidate.item.url),
        attempts: [],
      },
    }),
  };
}

/** Maps the Coordinator-owned projection into the browser-only presentation contract. */
export function createDashboardProjection(
  context: DashboardProjectionContext,
  coordinator: CoordinatorProjection,
): DashboardProjection {
  return {
    version: 1,
    repository: { ...context.repository },
    run: {
      ...context.run,
      ...(coordinator.poll.lastSuccessfulPoll === undefined
        ? {}
        : { lastSuccessfulPoll: coordinator.poll.lastSuccessfulPoll }),
      ...(coordinator.poll.nextScheduledPoll === undefined
        ? {}
        : { nextPoll: coordinator.poll.nextScheduledPoll }),
    },
    totals: { ...coordinator.totals },
    lanes: coordinator.lanes.map((lane) => ({
      stage: lane.stage,
      operatingState: lane.operatingState,
      candidates: lane.candidates.map(mapDashboardCandidate),
      totals: { ...lane.totals },
    })),
    recent: coordinator.recent.map(mapDashboardCandidate),
  };
}

const ASSETS: DashboardUiAssets = Object.freeze({
  "/": Object.freeze({ contentType: "text/html; charset=utf-8", body: DASHBOARD_HTML }),
  "/styles.css": Object.freeze({ contentType: "text/css; charset=utf-8", body: DASHBOARD_CSS }),
  "/app.js": Object.freeze({ contentType: "text/javascript; charset=utf-8", body: DASHBOARD_SCRIPT }),
});

/** Static browser assets consumed by the Coordinator-owned dashboard server. */
export function createDashboardUiAssets(): DashboardUiAssets {
  return ASSETS;
}
