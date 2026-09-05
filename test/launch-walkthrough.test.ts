import assert from "node:assert/strict";
import { spawn as spawnPty } from "@lydell/node-pty";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAutomodeLaunchPlan } from "../src/launch.js";
import {
  createAutomationStageConfiguration,
  serializeAutomationStageConfiguration,
} from "../src/stage-configuration.js";

interface MainProof {
  cwd: string;
  configuration: { mode: "full" | "half"; stages: string[] };
  configurationFrozen: boolean;
  mutationRejected: boolean;
  panelExecutions: Array<{
    harness: "pi";
    provider: string;
    model: string;
    reasoning: string;
  }>;
  sessionName: string;
  sessionFile: string;
  pid: number;
}

function runBridge(repository: string, keys: string): Promise<{ output: string; proof: MainProof; bridgePid: number }> {
  return new Promise((resolveRun, rejectRun) => {
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const proofExtension = join(dirname(repository), `launch-proof-${Date.now()}.mjs`);
    writeFileSync(proofExtension, `
import automodeBridge, { selectAutomationStageConfiguration } from ${JSON.stringify(pathToFileURL(resolve(projectRoot, "dist/src/bridge.js")).href)};
import { createAutomodeLaunchPlan } from ${JSON.stringify(pathToFileURL(resolve(projectRoot, "dist/src/launch.js")).href)};
import { handoffTerminal } from ${JSON.stringify(pathToFileURL(resolve(projectRoot, "dist/src/handoff.js")).href)};
const proofEntrypoint = ${JSON.stringify(resolve(projectRoot, "dist/test/launch-proof-main.js"))};
export default function (pi) {
  pi.on("agent_start", () => console.log("UNEXPECTED_AGENT_START"));
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
    const piArgs = [
      "--no-session",
      "--no-extensions",
      "--offline",
      "--model", "openai-codex/gpt-5.6-sol",
      "--thinking", "low",
      "-e", proofExtension,
    ];
    const terminal = spawnPty(command, piArgs, {
      cwd: repository,
      env: { ...process.env, PI_OFFLINE: "1" },
      name: "xterm-color",
      // Pi disables autowrap; keep the JSON proof on one untruncated terminal row.
      cols: 4096,
      rows: 24,
    });
    let output = "";
    let invoked = false;
    let droveSelector = false;
    const timer = setTimeout(() => {
      terminal.kill();
      rejectRun(new Error(`Automode PTY walkthrough timed out:\n${output}`));
    }, 20_000);
    terminal.onData((chunk) => {
      output += chunk;
      if (!invoked && output.includes(">")) {
        invoked = true;
        terminal.write("/automode\r");
      }
      if (!droveSelector && output.includes("Launch Automode")) {
        droveSelector = true;
        terminal.write(keys);
      }
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer);
      terminal.kill();
      if (exitCode !== 0) {
        rejectRun(new Error(`Bridge exited ${exitCode}:\n${output}`));
        return;
      }
      const marker = "AUTOMODE_MAIN_SESSION ";
      const start = output.indexOf(marker);
      if (start === -1) {
        rejectRun(new Error(`Main Session proof missing:\n${output}`));
        return;
      }
      const line = output.slice(start + marker.length).split(/\r?\n/, 1)[0]!;
      const jsonEnd = line.lastIndexOf("}");
      resolveRun({ output, proof: JSON.parse(line.slice(0, jsonEnd + 1)) as MainProof, bridgePid: terminal.pid });
    });
  });
}

test("the Main Session rejects environment tampering between confirmation and child start", () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-tamper-"));
  const repository = join(fixture, "repository");
  mkdirSync(join(repository, ".git"), { recursive: true });
  const confirmed = serializeAutomationStageConfiguration(
    createAutomationStageConfiguration("full", ["auto-triage", "auto-grilling", "auto-implement", "auto-review"]),
  );
  const plan = createAutomodeLaunchPlan({
    cwd: repository,
    serializedConfiguration: confirmed,
    piPackageDir: resolve(dirname(fileURLToPath(import.meta.url)), "../../node_modules/@earendil-works/pi-coding-agent"),
    mainExecution: {
      harness: "pi",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoning: "high",
    },
  }, {
    ...process.env,
    HOME: join(fixture, "home"),
    USERPROFILE: join(fixture, "home"),
  });
  assert.equal(
    plan.env!.AUTOMODE_MAIN_EXECUTION,
    '{"harness":"pi","provider":"openai-codex","model":"gpt-5.6-sol","reasoning":"high"}',
  );
  plan.env!.AUTOMODE_STAGE_CONFIGURATION = serializeAutomationStageConfiguration(
    createAutomationStageConfiguration("half", ["auto-review"]),
  );

  const child = spawnSync(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /changed after confirmation/);
});

test("PTY walkthrough relaunches a stopped Full-Auto repository as Half-Auto", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-launch-"));
  const fullRepository = join(fixture, "full-repository");
  const fullNestedDirectory = join(fullRepository, "src", "feature");
  const halfAllRepository = join(fixture, "half-all-repository");
  const halfAllNestedDirectory = join(halfAllRepository, "src", "feature");
  mkdirSync(join(fullRepository, ".git"), { recursive: true });
  mkdirSync(fullNestedDirectory, { recursive: true });
  mkdirSync(join(halfAllRepository, ".git"), { recursive: true });
  mkdirSync(halfAllNestedDirectory, { recursive: true });

  const full = await runBridge(fullNestedDirectory, "\r");
  assert.deepEqual(full.proof.configuration, {
    mode: "full",
    stages: ["auto-triage", "auto-grilling", "auto-implement", "auto-review"],
  });
  assert.equal(full.proof.cwd, fullRepository);
  assert.doesNotMatch(full.output, /UNEXPECTED_AGENT_START/);
  assert.equal(full.proof.configurationFrozen, true);
  assert.equal(full.proof.mutationRejected, true);
  assert.deepEqual(full.proof.panelExecutions, [
    { harness: "pi", provider: "openai-codex", model: "gpt-6-astra", reasoning: "high" },
    { harness: "pi", provider: "github-copilot", model: "claude-fable-5", reasoning: "high" },
    { harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "low" },
  ]);
  assert.notEqual(full.proof.pid, full.bridgePid);
  assert.equal(full.proof.sessionName, "Automode Main — Full-Auto");

  const half = await runBridge(fullNestedDirectory, "\t\r");
  assert.deepEqual(half.proof.configuration, {
    mode: "half",
    stages: ["auto-implement", "auto-review"],
  });
  assert.equal(half.proof.cwd, fullRepository);
  assert.doesNotMatch(half.output, /UNEXPECTED_AGENT_START/);
  assert.equal(half.proof.configurationFrozen, true);
  assert.equal(half.proof.mutationRejected, true);
  assert.notEqual(half.proof.pid, half.bridgePid);
  assert.equal(half.proof.sessionName, "Automode Main — Half-Auto");

  const halfAll = await runBridge(halfAllNestedDirectory, "\t \x1b[B \r");
  assert.deepEqual(halfAll.proof.configuration, {
    mode: "half",
    stages: ["auto-triage", "auto-grilling", "auto-implement", "auto-review"],
  });
  assert.equal(halfAll.proof.cwd, halfAllRepository);
  assert.doesNotMatch(halfAll.output, /UNEXPECTED_AGENT_START/);
  assert.equal(halfAll.proof.configurationFrozen, true);
  assert.equal(halfAll.proof.mutationRejected, true);
  assert.notEqual(halfAll.proof.pid, halfAll.bridgePid);
  assert.equal(halfAll.proof.sessionName, "Automode Main — Half-Auto");
});
