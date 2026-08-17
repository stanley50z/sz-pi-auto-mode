import assert from "node:assert/strict";
import { spawn as spawnPty } from "@lydell/node-pty";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

function submitThroughAutomodeEditor(repository: string, text: string): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const proofExtension = join(dirname(repository), `input-proof-${Date.now()}.mjs`);
    writeFileSync(proofExtension, `
import { getPackageDir, VERSION } from "@earendil-works/pi-coding-agent";
import automodeBridge, { selectAutomationStageConfiguration } from ${JSON.stringify(pathToFileURL(resolve(projectRoot, "dist/src/bridge.js")).href)};
import { createAutomodeLaunchPlan } from ${JSON.stringify(pathToFileURL(resolve(projectRoot, "dist/src/launch.js")).href)};
import { handoffTerminal } from ${JSON.stringify(pathToFileURL(resolve(projectRoot, "dist/src/handoff.js")).href)};
const proofEntrypoint = ${JSON.stringify(resolve(projectRoot, "dist/test/automode-input-main.js"))};
process.stdout.write("NORMAL_PI_RUNTIME " + JSON.stringify({ piPackageDir: getPackageDir(), piVersion: VERSION }) + "\\n");
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
`);
    const command = process.platform === "win32" ? `${process.env.APPDATA}/npm/pi.cmd` : "pi";
    const terminal = spawnPty(command, [
      "--no-session",
      "--no-extensions",
      "--offline",
      "--model", "openai-codex/gpt-5.6-sol",
      "-e", proofExtension,
    ], {
      cwd: repository,
      env: { ...process.env, PI_OFFLINE: "1" },
      name: "xterm-color",
      cols: 80,
      rows: 24,
    });
    let output = "";
    let invoked = false;
    let launched = false;
    let submitted = false;
    const timer = setTimeout(() => {
      terminal.kill();
      rejectRun(new Error(`Automode editor input proof timed out:\n${output}`));
    }, 20_000);
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
      if (!submitted && output.includes("<inline:automode-input-proof>")) {
        submitted = true;
        setTimeout(() => terminal.write(`${text}\r`), 100);
      }
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer);
      terminal.kill();
      if (exitCode !== 0) {
        rejectRun(new Error(`Automode editor input proof exited ${exitCode}:\n${output}`));
        return;
      }
      resolveRun(output);
    });
  });
}

test("the fresh Automode editor exclusively receives terminal input after /automode", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-editor-input-"));
  const repository = join(fixture, "repository");
  mkdirSync(join(repository, ".git"), { recursive: true });

  const output = await submitThroughAutomodeEditor(repository, "automode-owned-123");

  const normalMarker = output.match(/NORMAL_PI_RUNTIME ({[^\r\n]*})/);
  const automodeMarker = output.match(/AUTOMODE_INPUT ({[^\r\n]*})/);
  assert.ok(normalMarker, output);
  assert.ok(automodeMarker, output);
  const normalRuntime = JSON.parse(normalMarker[1]!) as { piPackageDir: string; piVersion: string };
  const automodeInput = JSON.parse(automodeMarker[1]!) as {
    text: string;
    piPackageDir: string;
    piVersion: string;
  };
  assert.equal(automodeInput.text, "automode-owned-123");
  assert.deepEqual({
    piPackageDir: automodeInput.piPackageDir,
    piVersion: automodeInput.piVersion,
  }, normalRuntime);
});
