import { spawn } from "node:child_process";
import { once } from "node:events";

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
 * Gives a fresh process the inherited terminal, supervises signals, and exits.
 * This function never returns control to the caller's interactive experience.
 */
export async function handoffTerminal(options: HandoffOptions): Promise<never> {
  // Stop normal Pi's active TUI reader before the Automode child inherits the
  // same console. Otherwise both processes consume keystrokes on Windows.
  process.stdin.pause();
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: process.platform === "win32" ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
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

  let status: [number | null, NodeJS.Signals | null];
  try {
    status = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  } finally {
    for (const signal of signals) process.off(signal, forward);
  }
  process.exit(exitCode(...status));
  throw new Error("Process exit unexpectedly returned");
}
