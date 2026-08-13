import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

interface RpcMessage {
  id?: string;
  type: string;
  command?: string;
  success?: boolean;
  error?: string;
  data?: { commands?: Array<{ name: string; source: string; sourceInfo?: { path?: string } }> };
}

test("real Pi registers /automode as an extension command and handles it before model input", async () => {
  const piArgs = ["--mode", "rpc", "--no-session", "--no-extensions", "-e", process.cwd()];
  const child = spawn("pi", piArgs, {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PI_OFFLINE: "1" },
    shell: process.platform === "win32",
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.setEncoding("utf8");
  let buffer = "";
  const messages: RpcMessage[] = [];
  const waiters: Array<() => void> = [];
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line) messages.push(JSON.parse(line) as RpcMessage);
      waiters.splice(0).forEach((resolve) => resolve());
    }
  });

  async function waitFor(predicate: (message: RpcMessage) => boolean): Promise<RpcMessage> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const found = messages.find(predicate);
      if (found) return found;
      await Promise.race([
        new Promise<void>((resolve) => waiters.push(resolve)),
        new Promise<void>((resolve) => setTimeout(resolve, 50)),
      ]);
    }
    throw new Error(`Timed out waiting for Pi RPC output. stderr: ${stderr}`);
  }

  child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
  const commands = await waitFor((message) => message.id === "commands");
  const automode = commands.data?.commands?.find((command) => command.name === "automode");
  assert.deepEqual(automode && { name: automode.name, source: automode.source }, {
    name: "automode",
    source: "extension",
  });

  child.stdin.write(`${JSON.stringify({ id: "invoke", type: "prompt", message: "/automode" })}\n`);
  const invoke = await waitFor((message) => message.id === "invoke");
  assert.equal(invoke.success, true);
  const handledError = await waitFor((message) => message.type === "extension_error");
  assert.match(handledError.error ?? "", /interactive TUI/);
  assert.equal(messages.some((message) => message.type === "agent_start"), false);

  child.kill();
  await once(child, "exit");
});
