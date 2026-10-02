import { createClaudeRuntime } from "./claude-adapter";
import type { ExternalMakerRuntime } from "./types";

export type * from "./types";

/** core patch의 외부 Maker 분기가 부르는 진입점. */
export async function getRuntime(engine: string): Promise<ExternalMakerRuntime> {
  if (engine === "claude") return createClaudeRuntime();
  throw new Error(`Unsupported CUELO maker engine: ${engine}`);
}
