import assert from "node:assert/strict";
import { spawn as spawnPty } from "@lydell/node-pty";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveAutomodePaths } from "../src/paths.js";

interface ProofResult {
  cwd: string;
  pid: number;
  sessionFile: string;
  commands: string[];
  commandPaths: string[];
  activeTools: string[];
  credentialProviders: string[];
  invocations: Array<{ name: string; arguments: string }>;
  terminalInput?: string;
  settingsDefaultThinkingLevel?: string;
  appendSystemPrompts: string[];
  contextFilePaths: string[];
  credentialEnvironmentPresent: boolean;
  inheritedNormalConfiguration: string[];
}

function runInTerminal(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdin: string,
): Promise<{ bridgePid: number; code: number; output: string }> {
  return new Promise((resolveRun) => {
    const terminal = spawnPty(command, args, {
      cwd,
      env,
      name: "xterm-color",
      cols: 1000,
      rows: 30,
    });
    let output = "";
    terminal.onData((chunk) => { output += chunk; });
    terminal.onExit(({ exitCode }) => {
      terminal.kill();
      resolveRun({ bridgePid: terminal.pid, code: exitCode, output });
    });
    terminal.write(stdin.replace(/\n/g, "\r"));
  });
}

function writeSkill(root: string, name: string, marker: string): void {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Proof fixture.\n---\n\n${marker}\n`);
}

test("fresh child owns the terminal and composes only isolated SDK state", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-proof-"));
  const repository = join(fixture, "repository");
  const home = join(fixture, "home");
  const sourceSkills = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills");
  mkdirSync(join(repository, ".git"), { recursive: true });
  writeFileSync(join(fixture, "AGENTS.md"), "AMBIENT_PARENT_GUIDANCE");
  writeFileSync(join(repository, "AGENTS.md"), "REPOSITORY_AUTOMODE_GUIDANCE");
  writeSkill(join(repository, "skills"), "canonical-one", "ATTACKER_CANONICAL_ONE");
  writeSkill(join(repository, "skills"), "canonical-two", "ATTACKER_CANONICAL_TWO");
  writeSkill(join(repository, ".pi", "skills"), "ambient-project", "AMBIENT_PROJECT_MARKER");
  writeFileSync(join(repository, ".pi", "settings.json"), JSON.stringify({ defaultThinkingLevel: "xhigh" }));
  writeFileSync(join(repository, ".pi", "APPEND_SYSTEM.md"), "LEAKED_PROJECT_PROMPT");
  writeSkill(join(home, ".agents", "skills"), "ambient-user", "AMBIENT_USER_MARKER");
  const automodePaths = resolveAutomodePaths(repository, home);
  mkdirSync(automodePaths.automodeDir, { recursive: true });
  writeFileSync(join(automodePaths.automodeDir, "settings.json"), JSON.stringify({ defaultThinkingLevel: "low" }));
  const configuredNormalAgentDir = join(home, "configured-normal-pi");
  mkdirSync(configuredNormalAgentDir, { recursive: true });
  writeFileSync(
    join(configuredNormalAgentDir, "auth.json"),
    JSON.stringify({ "proof-credential": { type: "api_key", key: "not-a-real-secret" } }),
  );

  const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../src/proof-cli.js");
  const result = await runInTerminal(process.execPath, [cli], repository, {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AUTOMODE_HANDOFF_INPUT: "1",
    ANTHROPIC_API_KEY: "not-a-real-environment-credential",
    PI_CODING_AGENT_DIR: configuredNormalAgentDir,
    PI_OFFLINE: "1",
    PI_PACKAGE_DIR: join(fixture, "normal-packages"),
    PI_EXPERIMENTAL: "1",
    PI_TUI_WRITE_LOG: join(fixture, "normal-tui.log"),
    HTTP_PROXY: "http://normal-proxy.invalid",
    NODE_OPTIONS: "--no-warnings",
  }, "terminal-owned\n");

  assert.equal(result.code, 0, result.output);
  const jsonStart = result.output.indexOf('{"cwd"');
  assert.notEqual(jsonStart, -1, result.output);
  const jsonEnd = result.output.indexOf("}\r\n", jsonStart);
  assert.notEqual(jsonEnd, -1, result.output);
  const proof = JSON.parse(result.output.slice(jsonStart, jsonEnd + 1)) as ProofResult;
  assert.equal(proof.cwd, repository);
  assert.notEqual(proof.pid, process.pid);
  assert.notEqual(proof.pid, result.bridgePid);
  assert.deepEqual(proof.commands, ["fast", "skill:canonical-one", "skill:canonical-two"]);
  assert.deepEqual(proof.commandPaths.slice(1).map((path) => resolve(path)), [
    resolve(sourceSkills, "canonical-one", "SKILL.md"),
    resolve(sourceSkills, "canonical-two", "SKILL.md"),
  ]);
  assert.deepEqual(proof.activeTools, []);
  assert.deepEqual(proof.credentialProviders, ["proof-credential"]);
  assert.equal(proof.settingsDefaultThinkingLevel, "high");
  assert.deepEqual(proof.appendSystemPrompts, []);
  assert.deepEqual(proof.contextFilePaths.map((path) => resolve(path)), [resolve(repository, "AGENTS.md")]);
  assert.equal(proof.credentialEnvironmentPresent, true);
  assert.deepEqual(proof.inheritedNormalConfiguration, []);
  assert.deepEqual(proof.invocations, [
    { name: "canonical-one", arguments: "first-stage-context" },
    { name: "canonical-two", arguments: "second-stage-context" },
  ]);
  assert.equal(proof.terminalInput, "terminal-owned");
  assert.ok(proof.sessionFile.startsWith(join(home, ".pi", "automode")));
  assert.match(readFileSync(proof.sessionFile, "utf8"), /"type":"session"/);
  assert.ok(!proof.sessionFile.startsWith(join(home, ".pi", "agent")));
});
