/**
 * 작업당 비용: Maker 시도(attempt)마다 그 하위 세션이 쓴 추정 비용을 모아, 모델별로 「수용된 시도 하나당 비용」을 낸다.
 * 시도 → 세션 연결은 원장 발주 행의 sessionId(부모 세션)와 agentId다. 하위 세션 파일은
 * `<세션 디렉터리>/<cwd>/<날짜>_<부모 sessionId>/<agentId>.jsonl`이다. 같은 agentId를 다시 발주(rework)하면 같은 파일에
 * 이어 쓰이므로, 시도의 비용은 그 발주 시각부터 같은 파일의 다음 발주 시각 직전까지의 응답으로 가른다.
 * 하위 세션 파일이 없거나 응답에 비용이 없으면 그 모델·기간의 비용은 0원이 아니라 미기록이다.
 * 수용 여부는 시도마다 마지막 원장 판정이 accepted인지로 본다(기간과 무관하게 지금까지 남은 판정).
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { readSessionEntries } from "./upkeep-reader";

const DAY_MS = 86_400_000;

export type TaskCostCounts = {
  attempts: number;
  accepted: number;
  rework: number;
  held: number;
  cost: number;
  /** 비용이 기록되지 않은 응답이 있었는지 */
  missingCost: boolean;
};

export type TaskCostModel = {
  /** 발주 때 고른 모델(selector 그대로) */
  model: string;
  /** [최근 7일, 직전 7일] */
  windows: [TaskCostCounts, TaskCostCounts];
};

export type TaskCostResult = {
  models: TaskCostModel[];
  /** 하위 세션 파일을 찾지 못한 시도 수(시도·판정 건수에는 들어가고 비용은 미기록으로 둔다) [최근 7일, 직전 7일] */
  unlinked: [number, number];
  warning?: string;
};

type Dispatch = { attemptId: string; sessionId: string; agentId: string; time: number; model: string };
type Usage = { time: number; cost: number | null };

const empty = (): TaskCostCounts => ({ attempts: 0, accepted: 0, rework: 0, held: 0, cost: 0, missingCost: false });

/** 부모 sessionId → 하위 세션 디렉터리 */
async function childDirs(sessionsDir: string, wanted: ReadonlySet<string>): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let cwds: string[];
  try {
    cwds = (await readdir(sessionsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return found;
  }
  for (const cwd of cwds) {
    try {
      for (const entry of await readdir(join(sessionsDir, cwd), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const id = entry.name.slice(entry.name.lastIndexOf("_") + 1);
        if (wanted.has(id)) found.set(id, join(sessionsDir, cwd, entry.name));
      }
    } catch {
      continue;
    }
  }
  return found;
}

async function readUsages(path: string): Promise<Usage[] | null> {
  const out: Usage[] = [];
  try {
    for await (const entry of readSessionEntries<{ type?: string; timestamp?: string; message?: { role?: string; usage?: { cost?: { total?: unknown } } } }>(path)) {
      const usage = entry.message?.usage;
      const time = Date.parse(entry.timestamp ?? "");
      if (entry.type !== "message" || entry.message?.role !== "assistant" || !Number.isFinite(time)) continue;
      // usage가 없는 응답도 0원이 아니라 비용 미기록이다.
      out.push({ time, cost: typeof usage?.cost?.total === "number" ? usage.cost.total : null });
    }
  } catch {
    return null;
  }
  return out;
}

export async function collectTaskCost(agentDir: string, sessionsDir: string, now: number): Promise<TaskCostResult> {
  let text: string;
  try {
    text = await readFile(join(agentDir, "routing-ledger.jsonl"), "utf8");
  } catch {
    return { models: [], unlinked: [0, 0], warning: "Maker 원장을 읽을 수 없어 작업당 비용을 셀 수 없습니다." };
  }
  const dispatches: Dispatch[] = [];
  const latestVerdict = new Map<string, { time: number; verdict: string }>();
  for (const line of text.split("\n")) {
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!r || typeof r !== "object" || typeof r.ts !== "string") continue;
    const time = Date.parse(r.ts);
    if (!Number.isFinite(time)) continue;
    const attemptId = r.attemptId ?? r.assignmentId;
    if (r.type === "dispatch" && typeof attemptId === "string" && typeof r.sessionId === "string" && typeof r.agentId === "string" && r.agentId && typeof r.chosenModel === "string") {
      dispatches.push({ attemptId, sessionId: r.sessionId, agentId: r.agentId, time, model: r.chosenModel });
    } else if (r.type === "verdict" && typeof attemptId === "string" && typeof r.verdict === "string" && time >= (latestVerdict.get(attemptId)?.time ?? -Infinity)) {
      latestVerdict.set(attemptId, { time, verdict: r.verdict });
    }
  }

  // 같은 하위 세션 파일에 이어 쓴 발주들은 시각순으로 두고, 시도의 구간 끝은 다음 발주 시각이다.
  const byFile = new Map<string, Dispatch[]>();
  for (const d of dispatches) {
    const key = `${d.sessionId}\u0000${d.agentId}`;
    byFile.set(key, [...(byFile.get(key) ?? []), d].sort((a, b) => a.time - b.time));
  }
  const inWindow = (time: number): 0 | 1 | null => (time > now || time < now - 14 * DAY_MS ? null : time >= now - 7 * DAY_MS ? 0 : 1);
  const wanted = new Set<string>();
  for (const d of dispatches) if (inWindow(d.time) !== null) wanted.add(d.sessionId);
  const dirs = await childDirs(sessionsDir, wanted);

  const byModel = new Map<string, [TaskCostCounts, TaskCostCounts]>();
  const unlinked: [number, number] = [0, 0];
  for (const list of byFile.values()) {
    if (!list.some((d) => inWindow(d.time) !== null)) continue;
    const dir = dirs.get(list[0].sessionId);
    const usages = dir ? await readUsages(join(dir, `${list[0].agentId}.jsonl`)) : null;
    for (const [i, d] of list.entries()) {
      const window = inWindow(d.time);
      if (window === null) continue;
      const row = (byModel.get(d.model) ?? byModel.set(d.model, [empty(), empty()]).get(d.model)!)[window];
      // 하위 세션 파일이 없으면 그 시도의 비용을 알 수 없다. 0원으로 세지 않고 그 모델·기간을 비용 미기록으로 표시한다.
      if (!usages) {
        unlinked[window]++;
        row.missingCost = true;
      }
      const end = list[i + 1]?.time ?? Infinity;
      row.attempts++;
      const verdict = latestVerdict.get(d.attemptId)?.verdict;
      if (verdict === "accepted") row.accepted++;
      else if (verdict === "rework") row.rework++;
      else if (verdict === "held") row.held++;
      for (const u of usages ?? []) {
        if (u.time < d.time || u.time >= end) continue;
        if (u.cost === null) row.missingCost = true;
        else row.cost += u.cost;
      }
    }
  }
  return { models: [...byModel].map(([model, windows]) => ({ model, windows })), unlinked };
}
