import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createAutomodeStatusCard,
  type AutomodeStatusCardSnapshot,
} from "../src/main-status-card.js";

function snapshot(lifecycle: AutomodeStatusCardSnapshot["projection"]["run"]["lifecycle"]): AutomodeStatusCardSnapshot {
  const totals = { candidates: 2, active: 1, queued: 1, held: 0, retrying: 0, exhausted: 0 };
  return {
    projection: {
      version: 1,
      repository: { name: "owner/repository", url: "https://github.com/owner/repository" },
      run: {
        id: "run-50",
        mode: "full",
        lifecycle,
        lastSuccessfulPoll: "2026-08-18T12:00:00.000Z",
        nextPoll: "2026-08-18T12:00:30.000Z",
      },
      totals,
      lanes: [
        { stage: "auto-triage", operatingState: "ON", candidates: [], totals: { ...totals, candidates: 0, active: 0, queued: 0 } },
        { stage: "auto-grilling", operatingState: "OFF", candidates: [], totals: { ...totals, candidates: 0, active: 0, queued: 0 } },
        { stage: "auto-implement", operatingState: "ON", candidates: [], totals: { ...totals, candidates: 0, active: 0, queued: 0 } },
        { stage: "auto-review", operatingState: "DRAINING", candidates: [], totals: { ...totals, candidates: 0, active: 0, queued: 0 } },
      ],
      recent: [],
    },
    dashboard: {
      localUrl: "http://127.0.0.1:41738",
      remoteUrl: "https://automode.example.ts.net",
    },
  };
}

test("the Main Session status card reacts to projection changes and exposes /drain", async () => {
  let sessionStart: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => void | Promise<void>>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
      if (event === "session_start") sessionStart = handler;
    },
    registerCommand(name: string, options: { handler(args: string, ctx: ExtensionContext): void | Promise<void> }) {
      commands.set(name, options.handler);
    },
  } as unknown as ExtensionAPI;
  let drains = 0;
  const card = createAutomodeStatusCard({
    initial: snapshot("loading"),
    onDrain() { drains += 1; },
    onExit() {},
  });
  assert.equal(typeof card.extension, "object");
  if (typeof card.extension === "function") throw new Error("Expected the named status-card extension");
  await card.extension.factory(pi);
  assert.ok(sessionStart);

  let widgetFactory: ((tui: { requestRender(): void }, theme: unknown) => { render(width: number): string[] }) | undefined;
  let terminalCaptureCalls = 0;
  let shutdowns = 0;
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      setWidget(_key: string, factory: typeof widgetFactory) { widgetFactory = factory; },
      onTerminalInput() { terminalCaptureCalls += 1; return () => undefined; },
    },
    shutdown() { shutdowns += 1; },
  } as unknown as ExtensionContext;
  sessionStart!({}, ctx);
  assert.ok(widgetFactory);
  assert.equal(terminalCaptureCalls, 0, "Automode must leave Ctrl-C and all terminal input to Pi");

  let renders = 0;
  const component = widgetFactory!({ requestRender() { renders += 1; } }, {
    fg(_color: string, text: string) { return text; },
    bold(text: string) { return text; },
  });
  const rendered = component.render(200).join("\n");
  assert.match(rendered, /\u001b]8;;http:\/\/127\.0\.0\.1:41738/);
  assert.match(rendered, /\u001b]8;;https:\/\/automode\.example\.ts\.net/);
  assert.match(rendered, /\/drain: graceful drain/);
  assert.match(rendered, /\/exit: force-stop active Ticket Sessions, then exit/);
  card.publish(snapshot("active"));
  assert.equal(renders, 1);

  assert.ok(commands.has("drain"));
  await commands.get("drain")!("", ctx);
  assert.equal(drains, 1);

  card.shutdownWhen(Promise.resolve());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(shutdowns, 1);
});

test("/exit force-stops active Ticket Sessions before exiting the Main Session", async () => {
  let sessionStart: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => void | Promise<void>>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
      if (event === "session_start") sessionStart = handler;
    },
    registerCommand(name: string, options: { handler(args: string, ctx: ExtensionContext): void | Promise<void> }) {
      commands.set(name, options.handler);
    },
  } as unknown as ExtensionAPI;
  let forceStops = 0;
  let releaseCoordinator!: () => void;
  const coordinatorStopped = new Promise<void>((resolve) => { releaseCoordinator = resolve; });
  const card = createAutomodeStatusCard({
    initial: snapshot("active"),
    onDrain() {},
    onExit() { forceStops += 1; },
  });
  if (typeof card.extension === "function") throw new Error("Expected the named status-card extension");
  await card.extension.factory(pi);
  let shutdowns = 0;
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: { setWidget() {} },
    shutdown() { shutdowns += 1; },
  } as unknown as ExtensionContext;
  sessionStart!({}, ctx);
  card.shutdownWhen(coordinatorStopped);

  assert.ok(commands.has("exit"));
  await commands.get("exit")!("", ctx);
  assert.equal(forceStops, 1);
  assert.equal(shutdowns, 0);

  releaseCoordinator();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(shutdowns, 1);
});
