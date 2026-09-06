import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

/** Loads normal Pi's global instructions without discovering executable resources or following Markdown references. */
export function loadGlobalGuidance(normalAgentDir: string): Array<{ path: string; content: string }> {
  for (const name of ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]) {
    const candidate = join(normalAgentDir, name);
    if (!existsSync(candidate)) continue;
    const path = realpathSync(candidate);
    return [{ path, content: readFileSync(path, "utf8") }];
  }
  return [];
}
