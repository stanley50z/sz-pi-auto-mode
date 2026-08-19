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

test("the Main Session status card reacts to projection changes and owns two-step Ctrl-C", async () => {
  let sessionStart: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
  const pi = {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void) {
      if (event === "session_start") sessionStart = handler;
    },
  } as unknown as ExtensionAPI;
  const interrupts: string[] = [];
  const card = createAutomodeStatusCard({
    initial: snapshot("loading"),
    onInterrupt() {
      const result = interrupts.length === 0 ? "draining" : "forcing";
      interrupts.push(result);
      return result;
    },
  });
  assert.equal(typeof card.extension, "object");
  if (typeof card.extension === "function") throw new Error("Expected the named status-card extension");
  await card.extension.factory(pi);
  assert.ok(sessionStart);

  let widgetFactory: ((tui: { requestRender(): void }, theme: unknown) => { render(width: number): string[] }) | undefined;
  let terminalInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let shutdowns = 0;
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      setWidget(_key: string, factory: typeof widgetFactory) { widgetFactory = factory; },
      onTerminalInput(handler: typeof terminalInput) { terminalInput = handler; return () => undefined; },
    },
    shutdown() { shutdowns += 1; },
  } as unknown as ExtensionContext;
  sessionStart!({}, ctx);
  assert.ok(widgetFactory);
  assert.ok(terminalInput);

  let renders = 0;
  const component = widgetFactory!({ requestRender() { renders += 1; } }, {
    fg(_color: string, text: string) { return text; },
    bold(text: string) { return text; },
  });
  const rendered = component.render(200).join("\n");
  assert.match(rendered, /\u001b]8;;http:\/\/127\.0\.0\.1:41738/);
  assert.match(rendered, /\u001b]8;;https:\/\/automode\.example\.ts\.net/);
  card.publish(snapshot("active"));
  assert.equal(renders, 1);

  assert.equal(terminalInput!("x"), undefined);
  assert.deepEqual(terminalInput!("\u0003"), { consume: true });
  assert.deepEqual(terminalInput!("\u0003"), { consume: true });
  assert.deepEqual(interrupts, ["draining", "forcing"]);

  card.shutdownWhen(Promise.resolve());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(shutdowns, 1);
});
