/**
 * Cold revive of subagents after a CUELO restart.
 *
 * omp persists every subagent transcript under its root session's artifact
 * directory (`<root>.jsonl` → `<root>/…/<child>.jsonl`). After a restart, a
 * Main `write agent://<child>` restores that child as a `parked` ref and asks
 * `AgentLifecycleManager.ensureLive` to revive it, which needs a persisted
 * reviver factory. The omp CLI installs one bound to its single top-level
 * session (`main.ts`); CUELO runs many top-level sessions in one process, so a
 * factory bound to one of them would revive another session's child inside the
 * wrong cwd, artifacts and extension policy. The dispatcher below picks the
 * owning root from the child's transcript path — the same containment rule
 * omp's roster uses — and delegates to that root's own factory. A child whose
 * root is not open in this process is left transcript-only (`history://`).
 */
import path from "node:path";
import type { AgentRef } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
  AgentLifecycleManager,
  type PersistedSubagentReviverFactory,
} from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";

type Revivers = Map<string, PersistedSubagentReviverFactory>;

declare global {
  // Survives Next.js hot reload like the session registry itself.
  var __cueloRootRevivers: Revivers | undefined;
}

function revivers(): Revivers {
  globalThis.__cueloRootRevivers ??= new Map();
  return globalThis.__cueloRootRevivers;
}

/** The open root session whose artifact directory holds `sessionFile`, if any. */
export function owningRoot(sessionFile: string, roots: Iterable<string>): string | undefined {
  const file = path.resolve(sessionFile);
  for (const root of roots) {
    const resolved = path.resolve(root);
    if (!resolved.endsWith(".jsonl")) continue;
    if (file.startsWith(`${resolved.slice(0, -".jsonl".length)}${path.sep}`)) return root;
  }
  return undefined;
}

/** Revive through the factory of the root that owns the child's transcript. */
export function createRootDispatchFactory(roots: Revivers): PersistedSubagentReviverFactory {
  return async (ref: AgentRef) => {
    if (!ref.sessionFile) return undefined;
    const root = owningRoot(ref.sessionFile, roots.keys());
    return root ? roots.get(root)!(ref) : undefined;
  };
}

/**
 * Register a top-level session's reviver factory and (re)install the shared
 * dispatcher. Reinstalling on every registration keeps a replaced global
 * lifecycle manager covered. Returns the unregister function for teardown.
 */
export function registerRootReviver(
  rootSessionFile: string,
  factory: PersistedSubagentReviverFactory,
  idleTtlMs: () => number,
): () => void {
  const map = revivers();
  map.set(rootSessionFile, factory);
  AgentLifecycleManager.global().setPersistedSubagentReviverFactory(createRootDispatchFactory(map), idleTtlMs);
  return () => {
    if (map.get(rootSessionFile) === factory) map.delete(rootSessionFile);
  };
}
