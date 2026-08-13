import type { ResourceDiagnostic, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface CanonicalSkill {
  command: string;
  sourceRoot: string;
}

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function attestCanonicalCommands(
  commands: readonly SlashCommandInfo[],
  expected: readonly CanonicalSkill[],
  diagnostics: readonly ResourceDiagnostic[] = [],
): Map<string, SlashCommandInfo> {
  const expectedSkillNames = new Set(expected.map((skill) => skill.command.replace(/^skill:/, "")));
  for (const diagnostic of diagnostics) {
    const collision = diagnostic.collision;
    if (
      diagnostic.type === "collision"
      && collision?.resourceType === "skill"
      && expectedSkillNames.has(collision.name)
    ) {
      throw new Error(`Colliding canonical command: skill:${collision.name}`);
    }
  }

  const byName = new Map<string, SlashCommandInfo[]>();
  for (const command of commands) {
    const entries = byName.get(command.name) ?? [];
    entries.push(command);
    byName.set(command.name, entries);
  }

  const attested = new Map<string, SlashCommandInfo>();
  for (const skill of expected) {
    const matches = byName.get(skill.command) ?? [];
    if (matches.length === 0) throw new Error(`Missing canonical command: ${skill.command}`);
    if (matches.length !== 1) throw new Error(`Colliding canonical command: ${skill.command}`);
    const command = matches[0]!;
    if (command.source !== "skill") {
      throw new Error(`Unexpected source for ${skill.command}: ${command.source}`);
    }
    const sourcePath = realpathSync(command.sourceInfo.path);
    const sourceRoot = realpathSync(resolve(skill.sourceRoot));
    if (!inside(sourcePath, sourceRoot)) {
      throw new Error(`Unexpected provenance for ${skill.command}: ${sourcePath}`);
    }
    attested.set(skill.command, command);
  }
  return attested;
}
