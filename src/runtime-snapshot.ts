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
import type { GlobalSkillSource } from "./global-skills.js";

export interface AutomodeRuntimeSnapshot {
  readonly moduleDirectory: string;
  readonly globalSkillRoot: string;
  dispose(): void;
}

export interface AutomodeRuntimeSnapshotOptions {
  readonly copyFile?: (source: string, destination: string) => void;
  readonly globalSkills?: readonly GlobalSkillSource[];
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
    const globalSkillRoot = join(snapshotRoot, "skills", "global");
    const copiedNames = new Set<string>();
    const globalCaptures = (options.globalSkills ?? []).map((skill) => {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) || copiedNames.has(skill.name)) {
        throw new Error(`Invalid or duplicate global skill snapshot entry: ${skill.name}`);
      }
      copiedNames.add(skill.name);
      const sourceRoot = resolve(skill.sourceRoot);
      const files = filesUnder(sourceRoot, sourceRoot).sort();
      return {
        sourceRoot,
        destinationRoot: join(globalSkillRoot, skill.name),
        files,
        sourceFingerprint: fingerprint(sourceRoot, files),
      };
    });

    for (const file of sourceFiles) {
      const destination = join(snapshotRoot, file);
      mkdirSync(dirname(destination), { recursive: true });
      copyFile(join(packageRoot, file), destination);
    }
    for (const capture of globalCaptures) {
      for (const file of capture.files) {
        const destination = join(capture.destinationRoot, file);
        mkdirSync(dirname(destination), { recursive: true });
        copyFile(join(capture.sourceRoot, file), destination);
      }
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
    for (const capture of globalCaptures) {
      const currentFiles = filesUnder(capture.sourceRoot, capture.sourceRoot).sort();
      if (
        capture.files.length !== currentFiles.length
        || capture.files.some((file, index) => file !== currentFiles[index])
        || fingerprint(capture.sourceRoot, currentFiles) !== capture.sourceFingerprint
        || fingerprint(capture.destinationRoot, capture.files) !== capture.sourceFingerprint
      ) {
        throw new Error("An allowlisted global skill changed while its immutable snapshot was being created");
      }
    }

    return {
      moduleDirectory: join(snapshotRoot, "dist", "src"),
      globalSkillRoot,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
