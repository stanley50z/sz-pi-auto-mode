import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveAllowlistedGlobalSkills } from "../src/global-skills.js";
import type { HandoffOptions } from "../src/handoff.js";
import { launchAutomode } from "../src/launch.js";
import { createAutomodeRuntimeSnapshot } from "../src/runtime-snapshot.js";
import {
  createAutomationStageConfiguration,
  serializeAutomationStageConfiguration,
} from "../src/stage-configuration.js";

function launchRequest(cwd: string) {
  return {
    cwd,
    serializedConfiguration: serializeAutomationStageConfiguration(
      createAutomationStageConfiguration("half", ["auto-review"]),
    ),
    mainExecution: {
      harness: "pi" as const,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoning: "high" as const,
    },
    piPackageDir: resolve("node_modules/@earendil-works/pi-coding-agent"),
  };
}

function writeSkill(root: string, name: string, body: string): string {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill.\n---\n${body}\n`);
  return directory;
}

function writeRuntimeFixture(root: string): string {
  const moduleDirectory = join(root, "dist", "src");
  const skillDirectory = join(root, "skills", "automode", "implement");
  const dependencyDirectory = join(root, "node_modules", "runtime-dependency");
  const nestedDependencyDirectory = join(dependencyDirectory, "node_modules", "nested-dependency");
  mkdirSync(moduleDirectory, { recursive: true });
  mkdirSync(skillDirectory, { recursive: true });
  mkdirSync(nestedDependencyDirectory, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    type: "module",
    dependencies: { "runtime-dependency": "1.0.0" },
  }));
  writeFileSync(join(moduleDirectory, "automode-main.js"), "export const runtime = 'original';\n");
  writeFileSync(
    join(moduleDirectory, "ticket-session-main.js"),
    "import runtime from 'runtime-dependency'; console.log(runtime);\n",
  );
  writeFileSync(join(skillDirectory, "SKILL.md"), "original skill\n");
  writeFileSync(join(dependencyDirectory, "package.json"), JSON.stringify({
    name: "runtime-dependency",
    version: "1.0.0",
    dependencies: { "nested-dependency": "1.0.0" },
  }));
  writeFileSync(
    join(dependencyDirectory, "index.js"),
    "module.exports = require('nested-dependency') + ':original dependency';\n",
  );
  writeFileSync(join(nestedDependencyDirectory, "package.json"), JSON.stringify({
    name: "nested-dependency",
    version: "1.0.0",
  }));
  writeFileSync(join(nestedDependencyDirectory, "index.js"), "module.exports = 'nested dependency';\n");
  return moduleDirectory;
}

test("global skill discovery resolves only installed allowlist entries", () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-global-discovery-"));
  const normalAgentDir = join(fixture, "pi-agent");
  const browserHarness = writeSkill(join(normalAgentDir, "skills"), "browser-harness", "browser");
  const unslop = writeSkill(join(fixture, ".agents", "skills"), "unslop", "unslop");
  writeSkill(join(fixture, ".agents", "skills"), "ambient-global", "ambient");

  assert.deepEqual(resolveAllowlistedGlobalSkills({ home: fixture, normalAgentDir }), [
    { name: "browser-harness", sourceRoot: browserHarness },
    { name: "unslop", sourceRoot: unslop },
  ]);
});

test("/automode launches every process from one Bridge-owned runtime snapshot", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-runtime-launch-"));
  const snapshotModuleDirectory = join(fixture, "snapshot", "dist", "src");
  let launchPlan: HandoffOptions | undefined;
  let sourceModuleDirectory = "";
  let capturedGlobalSkillNames: string[] = [];
  let disposed = false;

  await launchAutomode(launchRequest(fixture), {
    resolveGlobalSkills() {
      return [{ name: "unslop", sourceRoot: join(fixture, "installed", "unslop") }];
    },
    createRuntimeSnapshot(sourceDirectory, options) {
      sourceModuleDirectory = sourceDirectory;
      capturedGlobalSkillNames = options.globalSkills?.map((skill) => skill.name) ?? [];
      return {
        moduleDirectory: snapshotModuleDirectory,
        globalSkillRoot: join(fixture, "snapshot", "skills", "global"),
        dispose() { disposed = true; },
      };
    },
    async handoff(plan) {
      assert.equal(disposed, false);
      launchPlan = plan;
    },
  });

  assert.match(sourceModuleDirectory.replaceAll("\\", "/"), /\/dist\/src$/);
  assert.deepEqual(capturedGlobalSkillNames, ["unslop"]);
  assert.equal(launchPlan?.args[1], pathToFileURL(join(snapshotModuleDirectory, "pi-runtime-loader.js")).href);
  assert.equal(launchPlan?.args[2], join(snapshotModuleDirectory, "automode-main.js"));
  assert.equal(
    launchPlan?.env?.AUTOMODE_GLOBAL_SKILL_ROOT,
    join(fixture, "snapshot", "skills", "global"),
  );
  assert.equal(disposed, true);
});

test("the Bridge disposes its runtime snapshot when handoff fails", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "automode-runtime-failed-handoff-"));
  let disposed = false;

  await assert.rejects(
    () => launchAutomode(launchRequest(fixture), {
      resolveGlobalSkills() { return []; },
      createRuntimeSnapshot() {
        return {
          moduleDirectory: join(fixture, "snapshot", "dist", "src"),
          globalSkillRoot: join(fixture, "snapshot", "skills", "global"),
          dispose() { disposed = true; },
        };
      },
      async handoff() { throw new Error("handoff failed"); },
    }),
    /handoff failed/,
  );
  assert.equal(disposed, true);
});

test("the captured production runtime can launch Ticket Session code independently", () => {
  const sourceModuleDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
  const snapshot = createAutomodeRuntimeSnapshot(sourceModuleDirectory);
  try {
    const child = spawnSync(process.execPath, [
      "--import",
      pathToFileURL(join(snapshot.moduleDirectory, "pi-runtime-loader.js")).href,
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(pathToFileURL(join(snapshot.moduleDirectory, "ticket-session.js")).href)})`,
    ], {
      env: {
        ...process.env,
        AUTOMODE_PI_PACKAGE_DIR: resolve("node_modules/@earendil-works/pi-coding-agent"),
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(
      existsSync(resolve(snapshot.moduleDirectory, "../../skills/automode/code-review/SKILL.md")),
      true,
    );
  } finally {
    snapshot.dispose();
  }
});

test("runtime snapshots pin allowlisted global skill directories", () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), "automode-runtime-global-source-"));
  const sourceModuleDirectory = writeRuntimeFixture(sourceRoot);
  const installedRoot = mkdtempSync(join(tmpdir(), "automode-installed-global-"));
  const unslop = writeSkill(installedRoot, "unslop", "original global skill");
  mkdirSync(join(unslop, "references"), { recursive: true });
  writeFileSync(join(unslop, "references", "rules.md"), "original rules\n");

  const snapshot = createAutomodeRuntimeSnapshot(sourceModuleDirectory, {
    globalSkills: [{ name: "unslop", sourceRoot: unslop }],
  });
  try {
    writeFileSync(join(unslop, "SKILL.md"), "changed after launch\n");
    writeFileSync(join(unslop, "references", "rules.md"), "changed rules\n");

    assert.equal(
      readFileSync(join(snapshot.globalSkillRoot, "unslop", "SKILL.md"), "utf8").includes("original global skill"),
      true,
    );
    assert.equal(
      readFileSync(join(snapshot.globalSkillRoot, "unslop", "references", "rules.md"), "utf8"),
      "original rules\n",
    );
  } finally {
    snapshot.dispose();
  }
});

test("snapshot creation rejects runtime changes during global skill capture", () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), "automode-runtime-global-race-"));
  const sourceModuleDirectory = writeRuntimeFixture(sourceRoot);
  const installedRoot = mkdtempSync(join(tmpdir(), "automode-global-race-skill-"));
  const unslop = writeSkill(installedRoot, "unslop", "global skill");

  assert.throws(
    () => createAutomodeRuntimeSnapshot(sourceModuleDirectory, {
      globalSkills: [{ name: "unslop", sourceRoot: unslop }],
      copyFile(source, destination) {
        copyFileSync(source, destination);
        if (source === join(unslop, "SKILL.md")) {
          writeFileSync(join(sourceModuleDirectory, "automode-main.js"), "export const runtime = 'rebuilt';\n");
        }
      },
    }),
    /runtime changed while its immutable snapshot was being created/,
  );
});

test("snapshot creation rejects earlier global skill changes during later skill capture", () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), "automode-global-cross-race-"));
  const sourceModuleDirectory = writeRuntimeFixture(sourceRoot);
  const installedRoot = mkdtempSync(join(tmpdir(), "automode-global-cross-skill-"));
  const browserHarness = writeSkill(installedRoot, "browser-harness", "browser");
  const unslop = writeSkill(installedRoot, "unslop", "unslop");

  assert.throws(
    () => createAutomodeRuntimeSnapshot(sourceModuleDirectory, {
      globalSkills: [
        { name: "browser-harness", sourceRoot: browserHarness },
        { name: "unslop", sourceRoot: unslop },
      ],
      copyFile(source, destination) {
        copyFileSync(source, destination);
        if (source === join(unslop, "SKILL.md")) {
          writeFileSync(join(browserHarness, "SKILL.md"), "changed after its copy\n");
        }
      },
    }),
    /global skill changed while its immutable snapshot was being created/,
  );
});

test("snapshot creation rejects a checkout rebuild during capture", () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), "automode-runtime-race-"));
  const sourceModuleDirectory = writeRuntimeFixture(sourceRoot);
  let copyCount = 0;

  assert.throws(
    () => createAutomodeRuntimeSnapshot(sourceModuleDirectory, {
      copyFile(source, destination) {
        copyFileSync(source, destination);
        copyCount += 1;
        if (copyCount === 1) {
          writeFileSync(join(sourceModuleDirectory, "automode-main.js"), "export const runtime = 'rebuilt';\n");
        }
      },
    }),
    /runtime changed while its immutable snapshot was being created/,
  );
});

test("a running Automode snapshot is unchanged by later checkout rebuilds", () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), "automode-runtime-source-"));
  const sourceModuleDirectory = writeRuntimeFixture(sourceRoot);
  const snapshot = createAutomodeRuntimeSnapshot(sourceModuleDirectory);
  const snapshotRoot = resolve(snapshot.moduleDirectory, "..", "..");

  writeFileSync(join(sourceModuleDirectory, "automode-main.js"), "export const runtime = 'rebuilt';\n");
  writeFileSync(join(sourceRoot, "skills", "automode", "implement", "SKILL.md"), "rebuilt skill\n");
  writeFileSync(
    join(sourceRoot, "node_modules", "runtime-dependency", "index.js"),
    "module.exports = 'rebuilt dependency';\n",
  );

  assert.equal(
    readFileSync(join(snapshot.moduleDirectory, "automode-main.js"), "utf8"),
    "export const runtime = 'original';\n",
  );
  assert.equal(
    readFileSync(join(snapshotRoot, "skills", "automode", "implement", "SKILL.md"), "utf8"),
    "original skill\n",
  );
  assert.equal(
    readFileSync(join(snapshotRoot, "node_modules", "runtime-dependency", "index.js"), "utf8"),
    "module.exports = require('nested-dependency') + ':original dependency';\n",
  );
  const ticketSession = spawnSync(process.execPath, [join(snapshot.moduleDirectory, "ticket-session-main.js")], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(ticketSession.status, 0, ticketSession.stderr);
  assert.equal(ticketSession.stdout.trim(), "nested dependency:original dependency");
  assert.equal(
    readFileSync(
      join(snapshotRoot, "node_modules", "runtime-dependency", "node_modules", "nested-dependency", "index.js"),
      "utf8",
    ),
    "module.exports = 'nested dependency';\n",
  );

  snapshot.dispose();
  assert.equal(existsSync(snapshotRoot), false);
});
