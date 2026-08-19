import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchDashboardBlackBox } from "./dashboard-black-box-harness.js";

async function main(): Promise<void> {
  const launched = launchDashboardBlackBox({
    completionDelayMilliseconds: 4_000,
    drainCompletionDelayMilliseconds: 25_000,
    timeoutMilliseconds: 90_000,
  });
  let stopRequested = false;
  const requestStop = () => {
    if (stopRequested) return;
    stopRequested = true;
    void launched.stop();
  };
  const onInput = (chunk: Buffer | string) => {
    if (chunk.toString().trim().toUpperCase() === "STOP") requestStop();
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  process.stdin.on("data", onInput);
  process.stdin.resume();

  try {
    const ready = await launched.ready;
    process.stdout.write(`AUTOMODE_DASHBOARD_BLACK_BOX_READY ${JSON.stringify({
      dashboardUrl: ready.emittedDashboardUrl,
      processId: ready.processId,
      source: "Main Session TUI OSC-8 hyperlink",
    })}\n`);
    const result = await launched.exited;
    process.stdout.write(`AUTOMODE_DASHBOARD_BLACK_BOX_EXIT ${JSON.stringify({
      dashboardUrl: result.emittedDashboardUrl,
      processId: result.processId,
      exitCode: result.exitCode,
    })}\n`);
  } finally {
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
    process.stdin.off("data", onInput);
    process.stdin.pause();
    await launched.stop();
  }
}

const isEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isEntrypoint) await main();
