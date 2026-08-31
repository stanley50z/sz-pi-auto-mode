import { spawn } from "node:child_process";
import { once } from "node:events";
import { isAutomodeReturnToNormalMessage } from "./handoff-protocol.js";

export interface HandoffOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  return signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1;
}

/**
 * Gives Automode the inherited terminal and resumes normal Pi only when the
 * child explicitly requests a return before exiting successfully.
 */
export async function handoffTerminal(options: HandoffOptions): Promise<void> {
  // Stop normal Pi's active TUI reader before the Automode child inherits the
  // same console. Otherwise both processes consume keystrokes on Windows.
  process.stdin.pause();
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    // A separate POSIX process group prevents terminal-generated signals from
    // reaching both processes. The waiting bridge receives them and forwards
    // each one to the Automode process. Windows detached mode opens a new console,
    // so inherited-console ownership is used there instead.
    detached: process.platform !== "win32",
  });

  const forward = (signal: NodeJS.Signals): void => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform !== "win32") {
      child.kill(signal);
      return;
    }
    // Console Ctrl-C already reaches every process attached to the Windows
    // console. Forwarding it with child.kill() would force-kill the child a
    // second time and bypass its cleanup. Other bridge termination requests use
    // IPC because Windows emulates child.kill() with forced termination.
    if (signal === "SIGINT") return;
    if (child.connected) child.send({ type: "automode:terminate", signal });
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.on(signal, forward);
  let returnToNormal = false;
  const receiveMessage = (message: unknown) => {
    if (isAutomodeReturnToNormalMessage(message)) returnToNormal = true;
  };
  child.on("message", receiveMessage);

  let status: [number | null, NodeJS.Signals | null];
  try {
    status = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  } finally {
    for (const signal of signals) process.off(signal, forward);
    child.off("message", receiveMessage);
  }
  const code = exitCode(...status);
  if (returnToNormal) {
    process.stdin.resume();
    if (code !== 0) throw new Error(`Automode exited with code ${code} while returning to normal Pi`);
    return;
  }
  process.exit(code);
}
