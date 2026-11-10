import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decideAutoEffort, parseAutoEffortConfig, type AutoEffortConfig, type AutoEffortInput } from "./lib/auto-effort-policy";

const POLICY_KEY = Symbol.for("cuelo.autoThinkingPolicy");
let cache: { key: string; config: AutoEffortConfig } | undefined;

function readConfig(): AutoEffortConfig {
  const path = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent"), "config.yml");
  try {
    const stat = statSync(path);
    const key = `${path}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    if (cache?.key === key) return cache.config;
    const config = parseAutoEffortConfig(readFileSync(path, "utf8"));
    cache = { key, config };
    return config;
  } catch {
    cache = undefined;
    return parseAutoEffortConfig(undefined);
  }
}

/** Replace one process slot on reload rather than stacking session listeners. */
export default function autoEffort(_pi: ExtensionAPI): void {
  Reflect.set(globalThis, POLICY_KEY, (input: AutoEffortInput) => decideAutoEffort(input, readConfig()));
}
