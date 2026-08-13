import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

export interface AutomodePaths {
  normalAgentDir: string;
  automodeDir: string;
  sessionDir: string;
}

export function repositoryRoot(cwd: string): string {
  let current = realpathSync(resolve(cwd));
  const filesystemRoot = parse(current).root;
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    if (current === filesystemRoot) {
      throw new Error(`Automode must be launched inside a Git repository: ${cwd}`);
    }
    current = dirname(current);
  }
}

export function repositoryKey(cwd: string): string {
  return createHash("sha256").update(repositoryRoot(cwd)).digest("hex").slice(0, 16);
}

export function resolveAutomodePaths(
  cwd: string,
  home = homedir(),
  normalAgentDir = join(home, ".pi", "agent"),
): AutomodePaths {
  const automodeDir = join(home, ".pi", "automode", repositoryKey(cwd));
  return {
    normalAgentDir: resolve(normalAgentDir),
    automodeDir,
    sessionDir: join(automodeDir, "sessions"),
  };
}
