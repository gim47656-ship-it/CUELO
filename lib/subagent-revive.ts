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
import { AgentRegistry, type AgentRef } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
  AgentLifecycleManager,
  type PersistedSubagentReviverFactory,
} from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";

type Revivers = Map<string, PersistedSubagentReviverFactory>;
/** root transcript → 그 root가 registry에서 쓰는 top-level agent id(`Main`, `Main#3`…). */
type RootAgentIds = Map<string, string>;

declare global {
  // Survives Next.js hot reload like the session registry itself.
  var __cueloRootRevivers: Revivers | undefined;
  var __cueloRootAgentIds: RootAgentIds | undefined;
  var __cueloOwnershipRepairs: WeakMap<AgentRegistry, () => void> | undefined;
}

function revivers(): Revivers {
  globalThis.__cueloRootRevivers ??= new Map();
  return globalThis.__cueloRootRevivers;
}

function rootAgentIds(): RootAgentIds {
  globalThis.__cueloRootAgentIds ??= new Map();
  return globalThis.__cueloRootAgentIds;
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

/**
 * core는 디스크에서 복원한 parked child의 `parentId`를 항상 `Main`으로 적는다. top-level이 둘 이상이면
 * `Main#3` 같은 root의 child가 `Main` 소유로 보여 자기 Main의 write는 거절되고 다른 Main이 통과한다.
 * root artifact 디렉터리 *직속* child만 그 root의 실제 agent id로 고친다. 더 깊은 child의 부모는
 * 이미 child id라 그대로 둔다. 열린 root가 아닌 child는 건드리지 않는다.
 */
export function adoptRestoredChild(ref: AgentRef, agentIds: ReadonlyMap<string, string>): boolean {
  if (!ref.sessionFile) return false;
  const root = owningRoot(ref.sessionFile, agentIds.keys());
  const agentId = root ? agentIds.get(root) : undefined;
  if (!root || !agentId || ref.parentId === agentId) return false;
  const rootDir = path.resolve(root).slice(0, -".jsonl".length);
  if (path.dirname(path.resolve(ref.sessionFile)) !== rootDir) return false;
  ref.parentId = agentId;
  return true;
}

/** Revive through the factory of the root that owns the child's transcript. */
export function createRootDispatchFactory(roots: Revivers): PersistedSubagentReviverFactory {
  return async (ref: AgentRef) => {
    if (!ref.sessionFile) return undefined;
    const root = owningRoot(ref.sessionFile, roots.keys());
    return root ? roots.get(root)!(ref) : undefined;
  };
}

/** registry에 child가 등록될 때마다 소유 root를 바로잡는다. registry당 한 번만 건다. */
function ensureOwnershipRepair(registry: AgentRegistry): void {
  const repairs = (globalThis.__cueloOwnershipRepairs ??= new WeakMap());
  if (repairs.has(registry)) return;
  const agentIds = rootAgentIds();
  repairs.set(registry, registry.onChange((event) => {
    if (event.type === "registered") adoptRestoredChild(event.ref, agentIds);
  }));
}

/**
 * Register a top-level session's reviver factory and (re)install the shared
 * dispatcher. Reinstalling on every registration keeps a replaced global
 * lifecycle manager covered. Returns the unregister function for teardown.
 * `agentId`는 이 root가 registry에서 쓰는 id이며, 이미 복원돼 있던 child도 이때 바로잡는다.
 */
export function registerRootReviver(
  rootSessionFile: string,
  agentId: string,
  factory: PersistedSubagentReviverFactory,
  idleTtlMs: () => number,
  scope: { registry?: AgentRegistry; lifecycle?: AgentLifecycleManager } = {},
): () => void {
  const map = revivers();
  const agentIds = rootAgentIds();
  const registry = scope.registry ?? AgentRegistry.global();
  map.set(rootSessionFile, factory);
  agentIds.set(rootSessionFile, agentId);
  ensureOwnershipRepair(registry);
  for (const ref of registry.list()) adoptRestoredChild(ref, agentIds);
  (scope.lifecycle ?? AgentLifecycleManager.global())
    .setPersistedSubagentReviverFactory(createRootDispatchFactory(map), idleTtlMs);
  return () => {
    if (map.get(rootSessionFile) !== factory) return;
    map.delete(rootSessionFile);
    agentIds.delete(rootSessionFile);
  };
}
