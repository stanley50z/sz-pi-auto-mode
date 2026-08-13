import type { ResourceDiagnostic, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface CanonicalSkill {
  command: string;
  sourceRoot: string;
}

export function isPathInside(path: string, root: string): boolean {
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
    if (diagnostic.type === "collision" && collision?.resourceType === "skill") {
      const qualifier = expectedSkillNames.has(collision.name) ? "canonical " : "";
      throw new Error(`Colliding ${qualifier}command: skill:${collision.name}`);
    }
    if (diagnostic.type === "error") {
      throw new Error(`Resource attestation failed: ${diagnostic.message}`);
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
    const expectedPath = realpathSync(join(sourceRoot, "SKILL.md"));
    if (sourcePath !== expectedPath) {
      throw new Error(`Unexpected provenance for ${skill.command}: ${sourcePath}`);
    }
    if (command.sourceInfo.scope !== "temporary" || command.sourceInfo.origin !== "top-level") {
      throw new Error(`Unexpected provenance metadata for ${skill.command}`);
    }
    attested.set(skill.command, command);
  }
  return attested;
}
