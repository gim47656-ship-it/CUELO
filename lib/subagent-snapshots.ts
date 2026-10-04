import type { SubagentSnapshot } from "./types";

// State refreshes contain only live SDK entries; merge terminal frames into a bounded history.
export const MAX_SUBAGENT_HISTORY = 128;

/**
 * Same ownership rule as the SDK's RPC subagent registry (`hasSameOwner`): the dispatch tool call
 * when both sides carry it, otherwise the transcript file.
 */
function sameDispatch(previous: SubagentSnapshot, incoming: SubagentSnapshot): boolean {
  if (previous.parentToolCallId !== undefined && incoming.parentToolCallId !== undefined) {
    return previous.parentToolCallId === incoming.parentToolCallId;
  }
  if (previous.sessionFile !== undefined && incoming.sessionFile !== undefined) {
    return previous.sessionFile === incoming.sessionFile;
  }
  return true;
}

/**
 * A follow-up or revived turn of the same dispatch keeps the card's identity from its first run;
 * only status, timing and progress come from the newer frame. A wake turn after a park — above all a
 * cold revive after a restart — reports index 0, its id as agent, no dispatch tool call and the waking
 * message as task, which would otherwise unlink the card from its dispatch and drop its title.
 */
export function mergeSubagentSnapshot(previous: SubagentSnapshot | undefined, incoming: SubagentSnapshot): SubagentSnapshot {
  if (!previous || !sameDispatch(previous, incoming)) return incoming;
  return {
    ...incoming,
    index: previous.index,
    agent: previous.agent,
    agentSource: previous.agentSource,
    description: previous.description ?? incoming.description,
    task: previous.task ?? incoming.task,
    assignment: previous.assignment ?? incoming.assignment,
    sessionFile: incoming.sessionFile ?? previous.sessionFile,
    parentToolCallId: incoming.parentToolCallId ?? previous.parentToolCallId,
  };
}

export function mergeSubagentSnapshots(current: readonly SubagentSnapshot[], incoming: readonly SubagentSnapshot[]): SubagentSnapshot[] {
  const byId = new Map(current.map((subagent) => [subagent.id, subagent]));
  for (const subagent of incoming) byId.set(subagent.id, mergeSubagentSnapshot(byId.get(subagent.id), subagent));
  const snapshots = [...byId.values()];
  const active = snapshots
    .filter((subagent) => subagent.status === "pending" || subagent.status === "running")
    .sort((left, right) => left.index - right.index || left.id.localeCompare(right.id));
  const finished = snapshots
    .filter((subagent) => subagent.status !== "pending" && subagent.status !== "running")
    .sort((left, right) => right.lastUpdate - left.lastUpdate || left.id.localeCompare(right.id));
  return [...active, ...finished].slice(0, MAX_SUBAGENT_HISTORY);
}
