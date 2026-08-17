// PROTOTYPE ONLY — Issue #38 Coordinator UI exploration.
// Three structurally different variants share simulated run data and are never production code.

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type TUI,
} from "@earendil-works/pi-tui";

type Variant = "deck" | "lanes" | "pulse";
type Scenario = "loading" | "empty" | "active" | "degraded" | "draining" | "exhausted" | "recovered";
type Stage = "Auto-Triage" | "Auto-Grilling" | "Auto-Implement" | "Auto-Review";
type TicketState = "running" | "waiting" | "retrying" | "failed" | "settled";

interface Ticket {
  ref: string;
  title: string;
  stage: Stage;
  state: TicketState;
  attempt: number;
  activity: string;
  session: string;
  workspace: string;
}

const VARIANTS: Array<{ id: Variant; name: string; thesis: string }> = [
  {
    id: "deck",
    name: "Command Deck",
    thesis: "Persistent roster with a selected Ticket Session detail pane.",
  },
  {
    id: "lanes",
    name: "Stage Lanes",
    thesis: "Workflow-first board grouped by enabled Automation Stage.",
  },
  {
    id: "pulse",
    name: "Pulse + Exceptions",
    thesis: "Quiet event stream that expands only exceptions and intervention points.",
  },
];

const SCENARIOS: Scenario[] = [
  "loading",
  "empty",
  "active",
  "degraded",
  "draining",
  "exhausted",
  "recovered",
];

const BASE_TICKETS: Ticket[] = [
  {
    ref: "#52",
    title: "Clarify retention policy",
    stage: "Auto-Grilling",
    state: "waiting",
    attempt: 1,
    activity: "Panel round 2: 3/3 answers received",
    session: "grilling-52-a91f",
    workspace: "repository root (read-only)",
  },
  {
    ref: "#57",
    title: "Add recovery bookkeeping",
    stage: "Auto-Implement",
    state: "running",
    attempt: 2,
    activity: "Focused tests running (01:14)",
    session: "implement-57-b773",
    workspace: ".worktree/issue-57",
  },
  {
    ref: "PR #61",
    title: "Harden tracker snapshot parsing",
    stage: "Auto-Review",
    state: "running",
    attempt: 1,
    activity: "Review round 1: 2/3 reports",
    session: "review-61-c04e",
    workspace: ".worktree/pr-61",
  },
  {
    ref: "#63",
    title: "Document local setup gap",
    stage: "Auto-Triage",
    state: "settled",
    attempt: 1,
    activity: "Tracker verification succeeded",
    session: "triage-63-e811",
    workspace: "repository root (read-only)",
  },
];

const FAILURE_TICKET: Ticket = {
  ref: "#49",
  title: "Repair Windows PTY shutdown",
  stage: "Auto-Implement",
  state: "retrying",
  attempt: 4,
  activity: "Process exited 1; retry in 18s",
  session: "implement-49-77dd",
  workspace: ".worktree/issue-49",
};

const EXHAUSTED_TICKET: Ticket = {
  ...FAILURE_TICKET,
  state: "failed",
  attempt: 5,
  activity: "Attempt budget exhausted; evidence preserved",
};

function ticketsFor(scenario: Scenario): Ticket[] {
  if (scenario === "loading" || scenario === "empty") return [];
  if (scenario === "degraded") return [FAILURE_TICKET, ...BASE_TICKETS];
  if (scenario === "exhausted") return [EXHAUSTED_TICKET, ...BASE_TICKETS];
  if (scenario === "recovered") {
    return [
      {
        ...FAILURE_TICKET,
        state: "running",
        activity: "Resumed existing session after Coordinator restart",
      },
      ...BASE_TICKETS,
    ];
  }
  if (scenario === "draining") {
    return BASE_TICKETS.map((ticket) =>
      ticket.state === "settled" ? ticket : { ...ticket, activity: `${ticket.activity}; draining` },
    );
  }
  return BASE_TICKETS;
}

function scenarioDescription(scenario: Scenario): string {
  switch (scenario) {
    case "loading":
      return "Taking the startup eligibility snapshot; no claims permitted yet.";
    case "empty":
      return "No eligible work. Polling continues every 30 seconds.";
    case "active":
      return "Discovery is live and unrelated Ticket Sessions run independently.";
    case "degraded":
      return "One item is retrying; unrelated work continues.";
    case "draining":
      return "Discovery stopped after first Ctrl-C; active sessions may settle.";
    case "exhausted":
      return "One item reached five attempts and retains diagnostics.";
    case "recovered":
      return "Coordinator restarted and reconstructed active work best-effort.";
  }
}

export default function coordinatorUiPrototype(pi: ExtensionAPI): void {
  pi.registerCommand("coordinator-ui-prototype", {
    description: "Open the throwaway Issue #38 Coordinator UI prototype",
    handler: async (_args, ctx) => openPrototype(ctx),
  });
}

async function openPrototype(ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.mode !== "tui") {
    throw new Error("The Coordinator UI prototype requires Pi TUI mode");
  }

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => new CoordinatorPrototype(tui, theme, done),
    {
      overlay: true,
      overlayOptions: () => ({
        anchor: "center",
        width: "100%",
        maxHeight: "100%",
        margin: 1,
      }),
    },
  );
}

class CoordinatorPrototype {
  private variantIndex = 0;
  private scenarioIndex = 2;
  private selectedIndex = 0;
  private showHelp = false;
  private showDetails = true;
  private notice = "";
  private ctrlCCount = 0;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.done();
      return;
    }
    if (matchesKey(data, Key.ctrl("c"))) {
      this.handleInterrupt();
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.variantIndex = (this.variantIndex - 1 + VARIANTS.length) % VARIANTS.length;
      this.notice = "";
    } else if (matchesKey(data, Key.right)) {
      this.variantIndex = (this.variantIndex + 1) % VARIANTS.length;
      this.notice = "";
    } else if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    } else if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.tickets.length - 1, this.selectedIndex + 1);
    } else if (data === "[") {
      this.setScenario(this.scenarioIndex - 1);
    } else if (data === "]") {
      this.setScenario(this.scenarioIndex + 1);
    } else if (data === "?" || data === "h") {
      this.showHelp = !this.showHelp;
    } else if (data === "d" || matchesKey(data, Key.enter)) {
      this.showDetails = !this.showDetails;
    } else if (data === "r") {
      this.scenarioIndex = SCENARIOS.indexOf("loading");
      this.notice = "Refresh requested: claims remain blocked until the fresh snapshot completes.";
    } else if (data === "g") {
      this.scenarioIndex = SCENARIOS.indexOf("draining");
      this.notice = "Graceful drain requested: discovery is stopped; Ticket Sessions keep authority.";
    } else if (data === "o") {
      const ticket = this.tickets[this.selectedIndex];
      this.notice = ticket
        ? `Inspect separately: pi --session ${ticket.session}  (prototype does not switch context)`
        : "No Ticket Session is available to inspect.";
    }
    this.clampSelection();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const height = this.tui.terminal.rows;
    if (width < 60 || height < 18) return this.renderTooSmall(width, height);

    const variant = VARIANTS[this.variantIndex]!;
    const contentWidth = Math.max(1, width - 2);
    const body = this.showHelp
      ? this.renderHelp(contentWidth)
      : variant.id === "deck"
        ? this.renderDeck(contentWidth)
        : variant.id === "lanes"
          ? this.renderLanes(contentWidth)
          : this.renderPulse(contentWidth);

    const maxBodyLines = Math.max(6, height - 8);
    const clippedBody = body.slice(0, maxBodyLines);
    const lines = [
      this.topBorder(width, ` Issue #38 prototype · ${variant.name} `),
      this.line(width, this.variantSwitcher(variant, contentWidth)),
      this.separator(width),
      ...clippedBody.map((line) => this.line(width, line)),
    ];

    while (lines.length < Math.min(height - 3, maxBodyLines + 3)) lines.push(this.line(width, ""));
    if (this.notice) {
      lines.push(this.separator(width));
      lines.push(this.line(width, ` ${this.theme.fg("warning", this.notice)}`));
    }
    lines.push(this.separator(width));
    lines.push(
      this.line(
        width,
        ` ${this.theme.fg("dim", "←/→ variant  ↑/↓ ticket  [/ ] state  Enter details  o inspect  r refresh  g drain  ? help  Esc close")}`,
      ),
    );
    lines.push(this.bottomBorder(width));
    return lines.slice(0, Math.max(1, height - 2));
  }

  invalidate(): void {}

  private get scenario(): Scenario {
    return SCENARIOS[this.scenarioIndex]!;
  }

  private get tickets(): Ticket[] {
    return ticketsFor(this.scenario);
  }

  private setScenario(index: number): void {
    this.scenarioIndex = (index + SCENARIOS.length) % SCENARIOS.length;
    this.ctrlCCount = this.scenario === "draining" ? 1 : 0;
    this.notice = "";
    this.clampSelection();
  }

  private clampSelection(): void {
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, this.tickets.length - 1)));
  }

  private handleInterrupt(): void {
    this.ctrlCCount += 1;
    if (this.ctrlCCount === 1) {
      this.scenarioIndex = SCENARIOS.indexOf("draining");
      this.notice = "First Ctrl-C: discovery stopped; draining active Ticket Sessions.";
    } else {
      this.notice = "Second Ctrl-C: force-stop requested; session/workspace evidence remains preserved.";
    }
    this.tui.requestRender();
  }

  private renderDeck(width: number): string[] {
    const lines = [...this.runSummary(width), ""];
    const tickets = this.tickets;
    if (tickets.length === 0) return [...lines, ...this.emptyState(width)];

    if (width >= 104) {
      const leftWidth = Math.floor(width * 0.58);
      const rightWidth = width - leftWidth - 3;
      const roster = this.rosterLines(leftWidth);
      const details = this.detailLines(rightWidth);
      lines.push(
        `${this.theme.fg("accent", " TICKET SESSIONS")}${" ".repeat(Math.max(1, leftWidth - 16))} ${this.theme.fg("accent", "SELECTED SESSION")}`,
      );
      lines.push(...this.columns(roster, details, leftWidth, rightWidth));
      return lines;
    }

    lines.push(this.theme.fg("accent", " TICKET SESSIONS"));
    lines.push(...this.rosterLines(width));
    if (this.showDetails) {
      lines.push("", this.theme.fg("accent", " SELECTED SESSION"), ...this.detailLines(width));
    }
    return lines;
  }

  private renderLanes(width: number): string[] {
    const lines = [...this.runSummary(width), ""];
    if (this.tickets.length === 0) return [...lines, ...this.emptyState(width)];

    const stages: Stage[] = ["Auto-Triage", "Auto-Grilling", "Auto-Implement", "Auto-Review"];
    lines.push(this.theme.fg("accent", " WORKFLOW LANES"));
    if (width >= 112) {
      const columnWidth = Math.floor((width - 3) / 2);
      for (let index = 0; index < stages.length; index += 2) {
        const left = this.stageLane(stages[index]!, columnWidth);
        const right = this.stageLane(stages[index + 1]!, width - columnWidth - 3);
        lines.push(...this.columns(left, right, columnWidth, width - columnWidth - 3), "");
      }
    } else {
      for (const stage of stages) lines.push(...this.stageLane(stage, width), "");
    }
    return lines;
  }

  private renderPulse(width: number): string[] {
    const lines = [...this.runSummary(width), ""];
    const failures = this.tickets.filter((ticket) => ticket.state === "failed" || ticket.state === "retrying");
    lines.push(this.theme.fg("accent", " EXCEPTIONS"));
    if (failures.length === 0) {
      lines.push(` ${this.theme.fg("success", "CLEAR")}  No item requires attention.`);
    } else {
      for (const failure of failures) {
        lines.push(
          ` ${this.stateLabel(failure.state)}  ${failure.ref} ${failure.title} · attempt ${failure.attempt}/5`,
          `    ${this.theme.fg("muted", failure.activity)}`,
        );
      }
    }
    lines.push("", this.theme.fg("accent", " RECENT COORDINATOR EVENTS"));
    const events = this.eventsForScenario();
    for (const event of events) {
      lines.push(` ${this.theme.fg("dim", event.time)}  ${this.eventLabel(event.kind)}  ${event.text}`);
    }
    if (this.showDetails && this.tickets.length > 0) {
      lines.push("", this.theme.fg("accent", " INSPECTED EVENT OWNER"), ...this.detailLines(width));
    }
    return lines;
  }

  private runSummary(width: number): string[] {
    const active = this.tickets.filter((ticket) => ticket.state === "running" || ticket.state === "waiting").length;
    const retrying = this.tickets.filter((ticket) => ticket.state === "retrying").length;
    const failed = this.tickets.filter((ticket) => ticket.state === "failed").length;
    const poll = this.scenario === "draining" ? "stopped" : this.scenario === "loading" ? "snapshotting" : "next in 12s";
    const lineOne = ` ${this.theme.bold("sz-pi-auto-mode")}  ${this.theme.fg("dim", "github.com/stanley50z/sz-pi-auto-mode")}`;
    const lineTwo = ` Run ${this.theme.fg("accent", "amr-2026-04-19-7f31")}  ·  Full-Auto [T G I R]  ·  Poll ${poll}`;
    const lineThree = ` State ${this.scenarioLabel(this.scenario)}  ·  ${active} active  ·  ${retrying} retrying  ·  ${failed} exhausted  ·  ${this.tickets.length} tracked`;
    const lineFour = ` ${this.theme.fg("muted", scenarioDescription(this.scenario))}`;
    return [
      truncateToWidth(lineOne, width, "…"),
      truncateToWidth(lineTwo, width, "…"),
      truncateToWidth(lineThree, width, "…"),
      truncateToWidth(lineFour, width, "…"),
    ];
  }

  private rosterLines(width: number): string[] {
    return this.tickets.map((ticket, index) => {
      const selected = index === this.selectedIndex;
      const prefix = selected ? this.theme.fg("accent", ">") : " ";
      const row = `${prefix} ${ticket.ref.padEnd(7)} ${this.stateLabel(ticket.state)} ${ticket.stage.replace("Auto-", "").padEnd(9)} ${ticket.title}`;
      return selected ? this.theme.bg("selectedBg", truncateToWidth(row, width, "…")) : truncateToWidth(row, width, "…");
    });
  }

  private detailLines(width: number): string[] {
    const ticket = this.tickets[this.selectedIndex];
    if (!ticket) return [this.theme.fg("dim", " No Ticket Session selected")];
    if (!this.showDetails) return [this.theme.fg("dim", " Details collapsed; press Enter")];
    return [
      truncateToWidth(` ${ticket.ref} · ${ticket.title}`, width, "…"),
      truncateToWidth(` Stage      ${ticket.stage}`, width, "…"),
      truncateToWidth(` Lifecycle  ${ticket.state} · attempt ${ticket.attempt}/5`, width, "…"),
      truncateToWidth(` Activity   ${ticket.activity}`, width, "…"),
      truncateToWidth(` Session    ${ticket.session}`, width, "…"),
      truncateToWidth(` Workspace  ${ticket.workspace}`, width, "…"),
      this.theme.fg("dim", truncateToWidth(" o opens the durable Ticket Session separately; Main Session context stays isolated.", width, "…")),
    ];
  }

  private stageLane(stage: Stage, width: number): string[] {
    const stageTickets = this.tickets.filter((ticket) => ticket.stage === stage);
    const title = ` ${stage.toUpperCase()}  ${this.theme.fg("dim", `${stageTickets.length} tracked`)}`;
    if (stageTickets.length === 0) return [truncateToWidth(title, width, "…"), this.theme.fg("dim", "   No eligible work")];
    return [
      truncateToWidth(title, width, "…"),
      ...stageTickets.flatMap((ticket) => [
        truncateToWidth(`   ${this.stateLabel(ticket.state)} ${ticket.ref} ${ticket.title}`, width, "…"),
        truncateToWidth(`      ${this.theme.fg("muted", ticket.activity)}`, width, "…"),
      ]),
    ];
  }

  private emptyState(width: number): string[] {
    const title = this.scenario === "loading" ? "DISCOVERING WORK" : "QUEUE CLEAR";
    const detail = this.scenario === "loading"
      ? "Comparing issue, dependency, assignee, pull-request, and updated-at snapshots."
      : "Automode is healthy. New tracker changes trigger a full enabled-stage scan.";
    return [
      "",
      this.center(this.theme.fg(this.scenario === "loading" ? "warning" : "success", title), width),
      this.center(this.theme.fg("muted", detail), width),
    ];
  }

  private renderHelp(width: number): string[] {
    return [
      this.theme.fg("accent", " PROTOTYPE QUESTION"),
      " Which information architecture lets a developer supervise Automode without turning the Main Session into a Ticket Session?",
      "",
      this.theme.fg("accent", " VARIANTS"),
      ...VARIANTS.flatMap((variant, index) => [
        ` ${index === this.variantIndex ? this.theme.fg("accent", ">") : " "} ${index + 1}. ${variant.name}`,
        `    ${this.theme.fg("muted", variant.thesis)}`,
      ]),
      "",
      this.theme.fg("accent", " SETTLED CONSTRAINTS REPRESENTED HERE"),
      " - Always visible: repository, run ID, fixed stage configuration, discovery state, active/retrying/exhausted counts.",
      " - Ticket work remains in durable, isolated Ticket Sessions; inspection never injects their transcript into Main Session context.",
      " - Main controls are supervisory only: inspect, refresh snapshot, graceful drain, and second-interrupt force stop.",
      " - State can be understood without color alone; every symbol has a text label.",
      " - Supported baseline target: 80×24. Wide layouts enhance at 104-112 columns; below 60×18 is unsupported.",
      "",
      this.theme.fg("dim", truncateToWidth(" Press ? to return. Use [ and ] to review loading, empty, active, degraded, draining, exhausted, and recovered states.", width, "…")),
    ];
  }

  private renderTooSmall(width: number, height: number): string[] {
    const safeWidth = Math.max(1, width);
    return [
      truncateToWidth("Automode Coordinator UI prototype", safeWidth, ""),
      truncateToWidth(`Terminal ${width}×${height} is below the supported 60×18 floor.`, safeWidth, ""),
      truncateToWidth("Resize to 80×24 or larger. Esc closes.", safeWidth, ""),
    ];
  }

  private variantSwitcher(variant: (typeof VARIANTS)[number], width: number): string {
    const tabs = VARIANTS.map((candidate, index) => {
      const label = `${index + 1} ${candidate.name}`;
      return candidate.id === variant.id
        ? this.theme.bg("selectedBg", this.theme.fg("accent", ` ${label} `))
        : this.theme.fg("dim", ` ${label} `);
    }).join("  ");
    return truncateToWidth(` ${tabs}  ${this.theme.fg("muted", variant.thesis)}`, width, "…");
  }

  private scenarioLabel(scenario: Scenario): string {
    const color = scenario === "active" || scenario === "empty" || scenario === "recovered"
      ? "success"
      : scenario === "exhausted"
        ? "error"
        : "warning";
    return this.theme.fg(color, scenario.toUpperCase());
  }

  private stateLabel(state: TicketState): string {
    const color = state === "running" || state === "settled"
      ? "success"
      : state === "failed"
        ? "error"
        : "warning";
    return this.theme.fg(color, state.toUpperCase().padEnd(8));
  }

  private eventLabel(kind: "info" | "success" | "warning" | "error"): string {
    const labels = { info: "INFO", success: "DONE", warning: "WARN", error: "FAIL" } as const;
    const colors = { info: "muted", success: "success", warning: "warning", error: "error" } as const;
    return this.theme.fg(colors[kind], labels[kind].padEnd(4));
  }

  private eventsForScenario(): Array<{ time: string; kind: "info" | "success" | "warning" | "error"; text: string }> {
    const events: Array<{ time: string; kind: "info" | "success" | "warning" | "error"; text: string }> = [
      { time: "14:32:11", kind: "success", text: "#63 left Auto-Triage after fresh tracker verification" },
      { time: "14:31:47", kind: "info", text: "PR #61 received Review Panel report 2 of 3" },
      { time: "14:31:04", kind: "info", text: "#57 focused validation started in isolated worktree" },
      { time: "14:30:30", kind: "info", text: "Tracker snapshot unchanged; next poll scheduled" },
    ];
    if (this.scenario === "degraded") {
      events.unshift({ time: "14:32:26", kind: "warning", text: "#49 attempt 4 exited; retry retains session and workspace" });
    } else if (this.scenario === "exhausted") {
      events.unshift({ time: "14:32:26", kind: "error", text: "#49 exhausted five attempts; unrelated work continues" });
    } else if (this.scenario === "draining") {
      events.unshift({ time: "14:32:26", kind: "warning", text: "Discovery stopped; waiting for three active sessions" });
    } else if (this.scenario === "recovered") {
      events.unshift({ time: "14:32:26", kind: "success", text: "Recovered #49 from tracker, branch, worktree, and Pi session evidence" });
    } else if (this.scenario === "loading") {
      return [{ time: "14:32:26", kind: "info", text: "Building startup eligibility snapshot; claiming is blocked" }];
    } else if (this.scenario === "empty") {
      return [{ time: "14:32:26", kind: "success", text: "Full scan complete; no eligible work" }];
    }
    return events;
  }

  private columns(left: string[], right: string[], leftWidth: number, rightWidth: number): string[] {
    const rows = Math.max(left.length, right.length);
    const output: string[] = [];
    for (let index = 0; index < rows; index += 1) {
      const leftLine = this.pad(left[index] ?? "", leftWidth);
      const rightLine = truncateToWidth(right[index] ?? "", rightWidth, "…");
      output.push(`${leftLine} ${this.theme.fg("borderMuted", "│")} ${rightLine}`);
    }
    return output;
  }

  private center(text: string, width: number): string {
    const remaining = Math.max(0, width - visibleWidth(text));
    return `${" ".repeat(Math.floor(remaining / 2))}${truncateToWidth(text, width, "…")}`;
  }

  private pad(text: string, width: number): string {
    const clipped = truncateToWidth(text, width, "…");
    return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
  }

  private topBorder(width: number, title: string): string {
    const inner = Math.max(0, width - 2);
    const clipped = truncateToWidth(title, inner, "");
    const remainder = Math.max(0, inner - visibleWidth(clipped));
    return this.theme.fg("borderAccent", `╭${clipped}${"─".repeat(remainder)}╮`);
  }

  private separator(width: number): string {
    return this.theme.fg("borderMuted", `├${"─".repeat(Math.max(0, width - 2))}┤`);
  }

  private bottomBorder(width: number): string {
    return this.theme.fg("borderAccent", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
  }

  private line(width: number, content: string): string {
    const inner = Math.max(0, width - 2);
    return `${this.theme.fg("borderMuted", "│")}${this.pad(content, inner)}${this.theme.fg("borderMuted", "│")}`;
  }
}
