import type { PiExecutionProfile } from "../src/capability-profile.js";

// Explicit launch settings for fixtures that exercise behavior unrelated to model selection.
export const TEST_MAIN_EXECUTION: PiExecutionProfile = Object.freeze({
  harness: "pi",
  provider: "openai-codex",
  model: "gpt-5.6-sol",
  reasoning: "high",
});
