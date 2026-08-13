const FORWARDED_PI_MARKERS = new Set(["AI_AGENT", "PI_CODING_AGENT"]);
const STRIPPED_NON_PI_KEYS = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_OPTIONS",
]);

export function isNormalPiConfigurationKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return (normalized.startsWith("PI_") && !FORWARDED_PI_MARKERS.has(normalized))
    || STRIPPED_NON_PI_KEYS.has(normalized);
}

export interface AutomodeEnvironment {
  environment: NodeJS.ProcessEnv;
  normalAgentDir?: string;
}

export function createAutomodeEnvironment(source: NodeJS.ProcessEnv): AutomodeEnvironment {
  const normalAgentDir = source.PI_CODING_AGENT_DIR;
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (isNormalPiConfigurationKey(key)) continue;
    environment[key] = value;
  }
  environment.AI_AGENT = "pi";
  environment.PI_CODING_AGENT = "true";
  return { environment, normalAgentDir };
}
