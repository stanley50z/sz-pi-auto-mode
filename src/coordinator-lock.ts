import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";

interface CoordinatorIdentityRecord {
  coordinatorId: string;
}

export interface RepositoryCoordinatorLease {
  readonly coordinatorId: string;
  readonly identityFile: string;
  readonly lockFile: string;
  release(): void;
}

function parseIdentity(path: string): CoordinatorIdentityRecord {
  let record: Partial<CoordinatorIdentityRecord>;
  try {
    record = JSON.parse(readFileSync(path, "utf8")) as Partial<CoordinatorIdentityRecord>;
  } catch (error) {
    throw new Error(`Invalid durable Coordinator identity: ${path}`, { cause: error });
  }
  if (typeof record.coordinatorId !== "string" || record.coordinatorId.length === 0) {
    throw new Error(`Invalid durable Coordinator identity: ${path}`);
  }
  return { coordinatorId: record.coordinatorId };
}

function durableIdentity(automodeDir: string): { identityFile: string; record: CoordinatorIdentityRecord } {
  const identityFile = join(automodeDir, "coordinator-identity.json");
  const candidate: CoordinatorIdentityRecord = { coordinatorId: randomUUID() };
  try {
    writeFileSync(identityFile, `${JSON.stringify(candidate)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return { identityFile, record: candidate };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return { identityFile, record: parseIdentity(identityFile) };
  }
}

export function acquireRepositoryCoordinator(automodeDir: string): RepositoryCoordinatorLease {
  mkdirSync(automodeDir, { recursive: true });
  const { identityFile, record: identity } = durableIdentity(automodeDir);
  const lockFile = join(automodeDir, "coordinator.lock");
  if (existsSync(lockFile) && !statSync(lockFile).isDirectory()) {
    throw new Error(`Cannot verify existing Coordinator lock: ${lockFile}`);
  }
  let unlock: () => void;
  try {
    unlock = lockfile.lockSync(automodeDir, {
      lockfilePath: lockFile,
      realpath: false,
      retries: 0,
      stale: 30_000,
      update: 10_000,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOCKED") {
      throw new Error(
        `Repository already has a live Automode Coordinator (identity ${identity.coordinatorId})`,
        { cause: error },
      );
    }
    throw new Error(`Cannot verify existing Coordinator lock: ${lockFile}`, { cause: error });
  }

  let released = false;
  return {
    coordinatorId: identity.coordinatorId,
    identityFile,
    lockFile,
    release() {
      if (released) return;
      unlock();
      released = true;
    },
  };
}
