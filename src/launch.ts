import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAutomodeEnvironment } from "./environment.js";
import { handoffTerminal } from "./handoff.js";
import type { AutomodeLaunchRequest } from "./bridge.js";

export async function launchAutomode(request: AutomodeLaunchRequest): Promise<never> {
  const { environment, normalAgentDir } = createAutomodeEnvironment(process.env);
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const childEntrypoint = resolve(moduleDirectory, "automode-main.js");
  environment.AUTOMODE_STAGE_CONFIGURATION = request.serializedConfiguration;
  return handoffTerminal({
    command: process.execPath,
    args: [
      childEntrypoint,
      request.cwd,
      normalAgentDir ?? "",
      ...(request.launchProof ? ["--launch-proof"] : []),
    ],
    cwd: request.cwd,
    env: environment,
  });
}
