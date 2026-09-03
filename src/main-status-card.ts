import type { InlineExtension, Theme } from "@earendil-works/pi-coding-agent";
import { hyperlink, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { DashboardProjection, DashboardStatus } from "./dashboard.js";
import {
  AUTOMATION_STAGES,
  AUTOMATION_STAGE_LABELS,
} from "./stage-configuration.js";

export interface AutomodeStatusCardSnapshot {
  readonly projection: DashboardProjection;
  readonly dashboard: DashboardStatus;
}

export interface AutomodeStatusCard {
  readonly extension: InlineExtension;
  publish(snapshot: AutomodeStatusCardSnapshot): void;
  shutdownWhen(stopped: Promise<void>): void;
}

export interface CreateAutomodeStatusCardOptions {
  readonly initial: AutomodeStatusCardSnapshot;
  readonly onReturnToNormal: () => Promise<void>;
  readonly onDrain: () => void;
  readonly onExit: () => void;
}

function pollTime(value: string | undefined): string {
  if (value === undefined) return "pending";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid Automode poll timestamp: ${value}`);
  return `${date.toISOString().slice(11, 19)} UTC`;
}

function statusColor(theme: Theme, state: "ON" | "DRAINING" | "OFF"): string {
  if (state === "ON") return theme.fg("success", state);
  if (state === "DRAINING") return theme.fg("warning", state);
  return theme.fg("muted", state);
}

function renderStatusCard(
  snapshot: AutomodeStatusCardSnapshot,
  theme: Theme,
  width: number,
): string[] {
  if (width < 1) throw new Error("Automode status card requires a positive terminal width");
  const { projection, dashboard } = snapshot;
  const lanes = new Map(projection.lanes.map((lane) => [lane.stage, lane]));
  const stageSummary = AUTOMATION_STAGES.map((stage) => {
    const lane = lanes.get(stage);
    if (!lane) throw new Error(`Automode status projection is missing ${stage}`);
    return `${AUTOMATION_STAGE_LABELS[stage]} ${statusColor(theme, lane.operatingState)}`;
  }).join("  ·  ");
  const totals = projection.totals;
  const lines = [
    theme.fg("accent", theme.bold("AUTOMODE MAIN SESSION")),
    `${theme.fg("muted", "Repository")} ${projection.repository.name}  ·  ${theme.fg("muted", "Run")} ${projection.run.id}`,
    `${theme.fg("muted", "Local dashboard")} ${hyperlink(dashboard.localUrl, dashboard.localUrl)}`,
    dashboard.remoteUrl
      ? `${theme.fg("muted", "Tailscale dashboard")} ${hyperlink(dashboard.remoteUrl, dashboard.remoteUrl)}`
      : `${theme.fg("muted", "Tailscale dashboard")} unavailable`,
    `${theme.fg("muted", "Stages")} ${stageSummary}`,
    `${theme.fg("muted", "Candidates")} ${totals.candidates} open  ·  ${totals.active} active  ·  ${totals.queued} queued  ·  ${totals.held} held  ·  ${totals.retrying} retrying  ·  ${totals.exhausted} exhausted`,
    `${theme.fg("muted", "Poll")} last ${pollTime(projection.run.lastSuccessfulPoll)}  ·  next ${pollTime(projection.run.nextPoll)}`,
    theme.fg("warning", "/automode: graceful drain, then return to normal Pi"),
    theme.fg("warning", "/drain: graceful drain  ·  /exit: force-stop active Ticket Sessions, then exit"),
  ];
  if (projection.run.pollError) {
    lines.splice(-2, 0, theme.fg("error", `GITHUB POLL ERROR: ${projection.run.pollError}`));
  }
  if (dashboard.exposureError) {
    lines.splice(4, 0, theme.fg(
      "error",
      `TAILSCALE ERROR: ${dashboard.exposureError} Localhost access remains available.`,
    ));
  }
  return lines.flatMap((line) => wrapTextWithAnsi(line, width));
}

export function createAutomodeStatusCard(
  options: CreateAutomodeStatusCardOptions,
): AutomodeStatusCard {
  let current = options.initial;
  let requestRender: (() => void) | undefined;
  let requestShutdown: (() => void) | undefined;
  let stopped: Promise<void> | undefined;
  let shutdownAttached = false;
  let commandOwnsShutdown = false;

  const attachShutdown = () => {
    if (shutdownAttached || !requestShutdown || !stopped) return;
    shutdownAttached = true;
    void stopped.then(() => {
      if (!commandOwnsShutdown) requestShutdown?.();
    });
  };

  const extension = {
    name: "automode-main-status-card",
    factory: (pi) => {
      pi.registerCommand("automode", {
        description: "Gracefully drain Automode, then return to normal Pi",
        handler: async (_args, ctx) => {
          commandOwnsShutdown = true;
          await options.onReturnToNormal();
          options.onDrain();
          if (!stopped) throw new Error("Automode Coordinator shutdown is not ready");
          await stopped;
          ctx.shutdown();
        },
      });
      pi.registerCommand("drain", {
        description: "Gracefully drain Automode, then exit",
        handler: async () => { options.onDrain(); },
      });
      pi.registerCommand("exit", {
        description: "Force-stop active Automode Ticket Sessions, then exit",
        handler: async () => { options.onExit(); },
      });
      pi.on("session_start", (_event, ctx) => {
        if (ctx.mode !== "tui") return;
        requestShutdown = () => ctx.shutdown();
        attachShutdown();
        ctx.ui.setWidget("automode-main-status-card", (tui, theme) => {
          requestRender = () => tui.requestRender();
          return {
            render: (width: number) => renderStatusCard(current, theme, width),
            invalidate() {},
            dispose() {
              requestRender = undefined;
            },
          };
        });
      });
    },
  } satisfies InlineExtension;

  return {
    extension,
    publish(snapshot) {
      current = snapshot;
      requestRender?.();
    },
    shutdownWhen(coordinatorStopped) {
      stopped = coordinatorStopped;
      attachShutdown();
    },
  };
}
