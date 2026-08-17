import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getPackageDir,
  InteractiveMode,
  type InlineExtension,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { createMainSessionRuntime } from "../src/session.js";

const captureInputExtension = {
  name: "automode-input-proof",
  factory: (pi) => {
    pi.on("input", (event, ctx) => {
      process.stdout.write(`AUTOMODE_INPUT ${JSON.stringify({
        text: event.text,
        piPackageDir: getPackageDir(),
        piVersion: VERSION,
      })}\n`);
      ctx.shutdown();
      return { action: "handled" };
    });
  },
} satisfies InlineExtension;

async function main(): Promise<void> {
  const repository = process.argv[2];
  if (!repository) throw new Error("Missing caller repository path");
  const normalAgentDir = process.argv[3] || undefined;
  const runtime = await createMainSessionRuntime({
    cwd: repository,
    skillPaths: [],
    systemPrompt: "Capture one Automode editor submission.",
    normalAgentDir,
    extensions: [captureInputExtension],
  });
  const interactiveMode = new InteractiveMode(runtime, {
    initialMessages: [],
    verbose: false,
  });
  try {
    await interactiveMode.run();
  } finally {
    runtime.session.dispose();
  }
}

const isEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isEntrypoint) await main();
