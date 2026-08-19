import { spawn as spawnPty } from "@lydell/node-pty";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parsePositiveIntegerMilliseconds } from "./positive-integer-milliseconds.js";

export interface DashboardBlackBoxLaunchIdentity {
  readonly dashboardUrl: URL;
  readonly emittedDashboardUrl: string;
  readonly processId: number;
}

export type DashboardBlackBoxReady = DashboardBlackBoxLaunchIdentity;

export interface DashboardBlackBoxExit extends DashboardBlackBoxLaunchIdentity {
  readonly exitCode: number;
  readonly output: string;
  readonly visibleOutput: string;
}

export interface DashboardBlackBoxRun {
  readonly ready: Promise<DashboardBlackBoxReady>;
  readonly exited: Promise<DashboardBlackBoxExit>;
  output(): string;
  stop(): Promise<void>;
}

export interface DashboardBlackBoxOptions {
  readonly completionDelayMilliseconds?: number;
  readonly drainCompletionDelayMilliseconds?: number;
  readonly timeoutMilliseconds?: number;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

export function stripTerminalControl(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
}

export function renderedLocalDashboardHyperlink(value: string): URL | undefined {
  const target = renderedLocalDashboardTarget(value);
  return target ? new URL(target) : undefined;
}

function renderedLocalDashboardTarget(value: string): string | undefined {
  const hyperlinks = value.matchAll(/\x1b\]8;[^;]*;([^\x07\x1b]+)(?:\x07|\x1b\\)/g);
  for (const hyperlink of hyperlinks) {
    const target = hyperlink[1];
    if (!target) continue;
    const url = new URL(target);
    if (url.protocol === "http:" && url.hostname === "127.0.0.1") return target;
  }
  return undefined;
}

/** Launches the real Pi `/automode` bridge and exposes only its public TUI/process seams. */
export function launchDashboardBlackBox(
  options: DashboardBlackBoxOptions = {},
): DashboardBlackBoxRun {
  const completionDelayMilliseconds = parsePositiveIntegerMilliseconds(
    options.completionDelayMilliseconds ?? 4_000,
    "Dashboard black-box completion delay",
  );
  const drainCompletionDelayMilliseconds = options.drainCompletionDelayMilliseconds === undefined
    ? undefined
    : parsePositiveIntegerMilliseconds(
        options.drainCompletionDelayMilliseconds,
        "Dashboard black-box drain completion delay",
      );
  const timeoutMilliseconds = parsePositiveIntegerMilliseconds(
    options.timeoutMilliseconds ?? 25_000,
    "Dashboard black-box timeout",
  );

  const fixture = mkdtempSync(join(tmpdir(), "automode-dashboard-acceptance-"));
  const repository = join(fixture, "repository");
  mkdirSync(join(repository, ".git"), { recursive: true });
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const proofExtension = join(fixture, "dashboard-acceptance-extension.mjs");
  writeFileSync(proofExtension, `
import automodeBridge, { selectAutomationStageConfiguration } from ${JSON.stringify(pathToFileURL(resolve(projectRoot, "dist/src/bridge.js")).href)};
import { createAutomodeLaunchPlan } from ${JSON.stringify(pathToFileURL(resolve(projectRoot, "dist/src/launch.js")).href)};
import { handoffTerminal } from ${JSON.stringify(pathToFileURL(resolve(projectRoot, "dist/src/handoff.js")).href)};
const proofEntrypoint = ${JSON.stringify(resolve(projectRoot, "dist/test/dashboard-acceptance-main.js"))};
export default function (pi) {
  automodeBridge(pi, {
    selectConfiguration: selectAutomationStageConfiguration,
    launch: async (request) => {
      const plan = createAutomodeLaunchPlan(request);
      return handoffTerminal({
        ...plan,
        args: [...plan.args.slice(0, 2), proofEntrypoint, ...plan.args.slice(3)],
      });
    },
  });
}
`, "utf8");

  const command = process.platform === "win32" ? `${process.env.APPDATA}/npm/pi.cmd` : "pi";
  const terminal = spawnPty(command, [
    "--no-session",
    "--no-extensions",
    "--offline",
    "--model", "openai-codex/gpt-5.6-sol",
    "-e", proofExtension,
  ], {
    cwd: repository,
    env: {
      ...process.env,
      PI_OFFLINE: "1",
      AUTOMODE_DASHBOARD_ACCEPTANCE_DELAY_MS: String(completionDelayMilliseconds),
      ...(drainCompletionDelayMilliseconds === undefined ? {} : {
        AUTOMODE_DASHBOARD_ACCEPTANCE_DRAIN_DELAY_MS: String(drainCompletionDelayMilliseconds),
      }),
    },
    name: "xterm-color",
    cols: 100,
    rows: 32,
  });

  const ready = deferred<DashboardBlackBoxReady>();
  const exited = deferred<DashboardBlackBoxExit>();
  let output = "";
  let invoked = false;
  let launched = false;
  let launchIdentity: DashboardBlackBoxLaunchIdentity | undefined;
  let readySettled = false;
  let exitSettled = false;
  let fixtureRemoved = false;

  const removeFixture = () => {
    if (fixtureRemoved) return;
    if (resolve(dirname(fixture)) !== resolve(tmpdir())) {
      throw new Error(`Refusing to remove unexpected dashboard fixture path: ${fixture}`);
    }
    fixtureRemoved = true;
    rmSync(fixture, { recursive: true, force: true });
  };
  const failure = (message: string) => new Error(`${message}:\n${stripTerminalControl(output)}`);
  const timer = setTimeout(() => {
    const error = failure("Dashboard acceptance timed out");
    if (!readySettled) {
      readySettled = true;
      ready.reject(error);
    }
    if (!exitSettled) {
      exitSettled = true;
      exited.reject(error);
    }
    try { terminal.kill(); } catch {}
  }, timeoutMilliseconds);

  terminal.onData((chunk) => {
    output += chunk;
    if (!invoked && output.includes(">")) {
      invoked = true;
      terminal.write("/automode\r");
    }
    if (!launched && output.includes("Launch Automode")) {
      launched = true;
      terminal.write("\r");
    }
    const renderedDashboardTarget = renderedLocalDashboardTarget(output);
    if (!readySettled && renderedDashboardTarget) {
      launchIdentity = {
        dashboardUrl: new URL(renderedDashboardTarget),
        emittedDashboardUrl: renderedDashboardTarget,
        processId: terminal.pid,
      };
      readySettled = true;
      ready.resolve(launchIdentity);
    }
  });
  terminal.onExit(({ exitCode }) => {
    clearTimeout(timer);
    // node-pty keeps its ConPTY transport handle alive until kill() releases it,
    // even after the hosted process reports exit.
    try { terminal.kill(); } catch {
      // The transport may already have been released by an explicit stop.
    }
    if (!readySettled) {
      readySettled = true;
      ready.reject(failure("Dashboard link never appeared"));
    }
    if (!exitSettled) {
      exitSettled = true;
      if (!launchIdentity) {
        exited.reject(failure("Dashboard acceptance exited before rendering its link"));
      } else if (exitCode !== 0) {
        exited.reject(failure(`Dashboard acceptance exited ${exitCode}`));
      } else {
        exited.resolve({
          ...launchIdentity,
          exitCode,
          output,
          visibleOutput: stripTerminalControl(output),
        });
      }
    }
    removeFixture();
  });

  // Callers may await readiness before attaching their exit assertion.
  void exited.promise.catch(() => undefined);
  return {
    ready: ready.promise,
    exited: exited.promise,
    output: () => output,
    async stop() {
      if (!exitSettled) {
        try { terminal.kill(); } catch {}
      }
      try {
        await exited.promise;
      } catch {
        // The public result retains the failure; stop is best-effort cleanup.
      }
      removeFixture();
    },
  };
}
