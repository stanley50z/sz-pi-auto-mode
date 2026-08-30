import type { Model } from "@earendil-works/pi-ai";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import type { PiExecutionProfile } from "./capability-profile.js";

/** Resolves one process-local Pi execution profile against the shared credential store. */
export async function resolvePiExecutionModel(
  services: AgentSessionServices,
  execution: PiExecutionProfile,
  supplied?: Model<any>,
): Promise<Model<any>> {
  if (supplied) {
    if (supplied.provider !== execution.provider || supplied.id !== execution.model) {
      throw new Error(
        `Execution profile requires ${execution.provider}/${execution.model}; received ${supplied.provider}/${supplied.id}`,
      );
    }
    return supplied;
  }

  const available = await services.modelRuntime.getAvailable(
    execution.provider,
    { signal: AbortSignal.timeout(30_000) },
  );
  const model = available.find((candidate) =>
    candidate.provider === execution.provider && candidate.id === execution.model
  );
  if (!model) {
    throw new Error(`Required execution profile is unavailable: ${execution.provider}/${execution.model}`);
  }
  return model;
}
