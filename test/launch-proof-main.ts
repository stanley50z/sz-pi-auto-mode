import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { startAutomodeMainSession } from "../src/automode-main.js";
import type { AutomationStage, AutomationStageConfiguration } from "../src/stage-configuration.js";

async function main(): Promise<void> {
  const repository = process.argv[2];
  if (!repository) throw new Error("Missing caller repository path");
  const serializedConfiguration = process.env.AUTOMODE_STAGE_CONFIGURATION;
  if (!serializedConfiguration) throw new Error("Missing immutable Automation Stage Configuration");
  const configurationConfirmation = process.env.AUTOMODE_STAGE_CONFIGURATION_CONFIRMATION;
  if (!configurationConfirmation) throw new Error("Missing Automation Stage Configuration confirmation");
  const normalAgentDir = process.argv[3] || undefined;
  const mainSession = await startAutomodeMainSession({
    repository,
    serializedConfiguration,
    configurationConfirmation,
    normalAgentDir,
    model: getBuiltinModel("openai-codex", "gpt-5.6-sol"),
    startupValidation: {
      runner: {
        async run(command, args, cwd) {
          if (command === "git" && args[0] === "rev-parse") return cwd;
          if (command === "git" && args[0] === "remote") return "https://github.com/owner/repository.git";
          if (args[0] === "auth") return "github.com";
          return JSON.stringify({
            id: "repository-id",
            nameWithOwner: "owner/repository",
            url: "https://github.com/owner/repository",
            viewerPermission: "ADMIN",
          });
        },
      },
      attestExecutions: async () => undefined,
    },
  });
  let mutationRejected = false;
  try {
    (mainSession.configuration.stages as AutomationStageConfiguration["stages"] & AutomationStage[]).pop();
  } catch (error) {
    mutationRejected = error instanceof TypeError;
  }
  console.log(`AUTOMODE_MAIN_SESSION ${JSON.stringify({
    cwd: mainSession.cwd,
    configuration: mainSession.configuration,
    configurationFrozen: Object.isFrozen(mainSession.configuration) && Object.isFrozen(mainSession.configuration.stages),
    mutationRejected,
    sessionName: mainSession.sessionName,
    sessionFile: mainSession.sessionFile,
    pid: process.pid,
  })}`);
  mainSession.dispose();
}

const isEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isEntrypoint) await main();
