import type { AgentRuntime, EngineId } from "./types";
import { createOmpRuntime } from "./omp-adapter";

export type { AgentEvent, AgentRuntime, AgentRuntimeSession, EngineId, RuntimeSessionOptions } from "./types";

export async function getRuntime(engine: EngineId): Promise<AgentRuntime> {
  switch (engine) {
    case "omp":
      return createOmpRuntime();
    case "codex":
      // These adapters are owned by optional engine integrations and are intentionally loaded on selection.
      return (await import("./codex-adapter")).createCodexRuntime();
    case "claude":
      return (await import("./claude-adapter")).createClaudeRuntime();
  }
}

export function getConfiguredRuntimeEngine(): EngineId {
  const engine = process.env.CUELO_RUNTIME_ENGINE;
  if (engine === undefined || engine === "") return "omp";
  if (engine === "omp" || engine === "codex" || engine === "claude") return engine;
  throw new Error(`Unsupported CUELO_RUNTIME_ENGINE: ${engine}`);
}
