import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

export interface AutomodeRuntimeSnapshot {
  readonly moduleDirectory: string;
  dispose(): void;
}

export interface AutomodeRuntimeSnapshotOptions {
  readonly copyFile?: (source: string, destination: string) => void;
}

function packageDependencies(packageDirectory: string): string[] {
  const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(manifest.dependencies ?? {});
}

function resolveDependencyPackage(packageRoot: string, ownerDirectory: string, name: string): string {
  let current = ownerDirectory;
  while (true) {
    const candidate = join(current, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (current === packageRoot) break;
    const parent = dirname(current);
    if (relative(packageRoot, parent).startsWith("..")) break;
    current = parent;
  }
  throw new Error(`Automode runtime dependency ${name} is unavailable from ${ownerDirectory}`);
}

function runtimeDependencyDirectories(packageRoot: string): string[] {
  const pending = packageDependencies(packageRoot).map((name) => ({ owner: packageRoot, name }));
  const directories = new Set<string>();
  while (pending.length > 0) {
    const dependency = pending.shift()!;
    const directory = resolveDependencyPackage(packageRoot, dependency.owner, dependency.name);
    if (directories.has(directory)) continue;
    directories.add(directory);
    pending.push(...packageDependencies(directory).map((name) => ({ owner: directory, name })));
  }
  return [...directories].sort();
}

function filesUnder(root: string, directory: string): string[] {
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(relative(root, path));
      else throw new Error(`Automode runtime snapshots do not support symbolic links: ${path}`);
    }
  };
  visit(directory);
  return files;
}

function runtimeFiles(packageRoot: string): string[] {
  const files = ["package.json"];
  files.push(...filesUnder(packageRoot, join(packageRoot, "dist", "src")));
  files.push(...filesUnder(packageRoot, join(packageRoot, "skills")));
  for (const directory of runtimeDependencyDirectories(packageRoot)) {
    files.push(...filesUnder(packageRoot, directory));
  }
  return files.sort();
}

function fingerprint(root: string, files: readonly string[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(join(root, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Captures the code, skills, and dependencies used by one Coordinator process. */
export function createAutomodeRuntimeSnapshot(
  sourceModuleDirectory: string,
  options: AutomodeRuntimeSnapshotOptions = {},
): AutomodeRuntimeSnapshot {
  const packageRoot = resolve(sourceModuleDirectory, "..", "..");
  const copyFile = options.copyFile ?? copyFileSync;
  const snapshotRoot = mkdtempSync(join(tmpdir(), "sz-pi-auto-mode-runtime-"));
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    rmSync(snapshotRoot, { recursive: true, force: true });
  };

  try {
    const sourceFiles = runtimeFiles(packageRoot);
    const sourceFingerprint = fingerprint(packageRoot, sourceFiles);
    for (const file of sourceFiles) {
      const destination = join(snapshotRoot, file);
      mkdirSync(dirname(destination), { recursive: true });
      copyFile(join(packageRoot, file), destination);
    }
    const currentSourceFiles = runtimeFiles(packageRoot);
    if (
      sourceFiles.length !== currentSourceFiles.length
      || sourceFiles.some((file, index) => file !== currentSourceFiles[index])
      || fingerprint(packageRoot, currentSourceFiles) !== sourceFingerprint
      || fingerprint(snapshotRoot, sourceFiles) !== sourceFingerprint
    ) {
      throw new Error("The Automode runtime changed while its immutable snapshot was being created");
    }
    return {
      moduleDirectory: join(snapshotRoot, "dist", "src"),
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
