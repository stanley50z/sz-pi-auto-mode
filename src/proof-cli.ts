import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createAutomodeEnvironment } from "./environment.js";
import { handoffTerminal } from "./handoff.js";

const here = dirname(fileURLToPath(import.meta.url));
const child = join(here, "proof-child.js");
const automodeEnvironment = createAutomodeEnvironment(process.env);
await handoffTerminal({
  command: process.execPath,
  args: [child, process.cwd(), automodeEnvironment.normalAgentDir ?? ""],
  cwd: process.cwd(),
  env: { ...automodeEnvironment.environment, AUTOMODE_HANDOFF_PROOF: "1" },
});
