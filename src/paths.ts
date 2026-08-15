import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

export interface AutomodePaths {
  normalAgentDir: string;
  automodeDir: string;
  sessionDir: string;
  coordinatorDir: string;
  runRecordFile: string;
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

export function gitCommonDirectory(cwd: string): string {
  const repository = repositoryRoot(cwd);
  const dotGit = join(repository, ".git");
  let gitDirectory: string;
  if (!existsSync(dotGit)) throw new Error(`Git metadata is unavailable: ${dotGit}`);
  if (statSync(dotGit).isDirectory()) {
    gitDirectory = realpathSync(dotGit);
  } else {
    const pointer = readFileSync(dotGit, "utf8").trim().match(/^gitdir:\s*(.+)$/i)?.[1];
    if (!pointer) throw new Error(`Invalid Git metadata pointer: ${dotGit}`);
    gitDirectory = realpathSync(resolve(repository, pointer));
  }
  const commonPointer = join(gitDirectory, "commondir");
  if (!existsSync(commonPointer)) return gitDirectory;
  const common = readFileSync(commonPointer, "utf8").trim();
  if (!common) throw new Error(`Invalid Git common-directory pointer: ${commonPointer}`);
  return realpathSync(resolve(gitDirectory, common));
}

export function resolveAutomodePaths(
  cwd: string,
  home = homedir(),
  normalAgentDir = join(home, ".pi", "agent"),
): AutomodePaths {
  const automodeDir = join(home, ".pi", "automode", repositoryKey(cwd));
  const coordinatorDir = join(gitCommonDirectory(cwd), "automode");
  return {
    normalAgentDir: resolve(normalAgentDir),
    automodeDir,
    sessionDir: join(automodeDir, "sessions"),
    coordinatorDir,
    runRecordFile: join(coordinatorDir, "automode-run.json"),
  };
}
