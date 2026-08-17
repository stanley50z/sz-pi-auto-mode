import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(path)) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

test("handoff forwards termination and cannot resume the bridge", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-signal-"));
  const readyFile = join(fixture, "ready");
  const signalFile = join(fixture, "signal");
  const resumeFile = join(fixture, "resumed");
  const childScript = join(fixture, "child.cjs");
  const bridgeScript = join(fixture, "bridge.mjs");
  const handoffModule = resolve(dirname(fileURLToPath(import.meta.url)), "../src/handoff.js");

  writeFileSync(childScript, `
const { appendFileSync, writeFileSync } = require("node:fs");
process.on("SIGINT", () => appendFileSync(${JSON.stringify(signalFile)}, "SIGINT,"));
process.on("SIGTERM", () => {
  appendFileSync(${JSON.stringify(signalFile)}, "SIGTERM");
  process.exit(0);
});
process.on("message", (message) => {
  if (message?.type !== "automode:terminate") return;
  appendFileSync(${JSON.stringify(signalFile)}, message.signal);
  process.exit(0);
});
writeFileSync(${JSON.stringify(readyFile)}, "ready");
setInterval(() => {}, 1000);
`);
  const trigger = process.platform === "win32"
    ? 'process.emit("SIGTERM", "SIGTERM")'
    : 'process.emit("SIGINT", "SIGINT"); setTimeout(() => process.emit("SIGTERM", "SIGTERM"), 25)';
  writeFileSync(bridgeScript, `
import { existsSync, writeFileSync } from "node:fs";
import { handoffTerminal } from ${JSON.stringify(pathToFileURL(handoffModule).href)};
const signalWhenReady = setInterval(() => {
  if (!existsSync(${JSON.stringify(readyFile)})) return;
  clearInterval(signalWhenReady);
  ${trigger};
}, 10);
await handoffTerminal({ command: process.execPath, args: [${JSON.stringify(childScript)}], cwd: ${JSON.stringify(fixture)} });
writeFileSync(${JSON.stringify(resumeFile)}, "resumed");
`);

  const bridge = spawn(process.execPath, [bridgeScript], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  bridge.stderr.on("data", (chunk) => { stderr += chunk; });
  await waitForFile(readyFile);
  const code = await new Promise<number | null>((resolveExit, reject) => {
    bridge.once("error", reject);
    bridge.once("exit", resolveExit);
  });

  if (process.platform === "win32") {
    assert.equal(code, 0, stderr);
    assert.equal(readFileSync(signalFile, "utf8"), "SIGTERM");
  } else {
    assert.equal(code, 0, stderr);
    assert.equal(readFileSync(signalFile, "utf8"), "SIGINT,SIGTERM");
  }
  assert.equal(existsSync(resumeFile), false);
});
