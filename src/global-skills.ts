import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const GLOBAL_SKILL_ALLOWLIST = Object.freeze([
  "browser-harness",
  "unslop",
] as const);

export type GlobalSkillName = typeof GLOBAL_SKILL_ALLOWLIST[number];

export interface GlobalSkillSource {
  readonly name: GlobalSkillName;
  readonly sourceRoot: string;
}

export interface GlobalSkillDiscoveryOptions {
  readonly home?: string;
  readonly normalAgentDir?: string;
}

/** Resolves installed global skills that Automode explicitly permits. */
export function resolveAllowlistedGlobalSkills(
  options: GlobalSkillDiscoveryOptions = {},
): readonly GlobalSkillSource[] {
  const home = resolve(options.home ?? homedir());
  const normalAgentDir = resolve(
    options.normalAgentDir
      ?? process.env.PI_CODING_AGENT_DIR
      ?? join(home, ".pi", "agent"),
  );

  return GLOBAL_SKILL_ALLOWLIST.flatMap((name) => {
    const matches = [
      join(normalAgentDir, "skills", name),
      join(home, ".agents", "skills", name),
    ]
      .filter((candidate) => existsSync(join(candidate, "SKILL.md")))
      .map((candidate) => realpathSync(candidate))
      .filter((candidate, index, all) => all.indexOf(candidate) === index);

    if (matches.length > 1) {
      throw new Error(`Allowlisted global skill has multiple installed sources: ${name}`);
    }
    return matches.length === 1 ? [{ name, sourceRoot: matches[0]! }] : [];
  });
}
