/**
 * 야간 자율 개선의 절차서(스킬) 후보 수집. 두 갈래다.
 * - `learned`: 세션 기록에서 `learn` 도구 호출 가운데 `kind: "procedure"`이면서 스킬로 만들지 않은(`skill` 객체가 없는) 것.
 *   야간 세션은 같은 요령이 두 세션 이상에서 보일 때만 절차서로 만든다.
 * - `observed`: 같은 실패 뒤 같은 모양의 호출로 넘긴 흔적(`scanSessions`의 `recoveries`)이 서로 다른 세션 두 곳 이상에 있는 것.
 *   두 세션 기준은 여기서 코드로 지킨다.
 * 읽지 못하는 파일·줄은 건너뛴다.
 */
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { clipMasked, maskSecrets, type Recovery } from "./sessions";

export interface SkillCandidate {
  /** 비밀을 가리고 600자로 줄인 기억 본문(관찰 후보는 실패와 넘긴 방법을 적은 한 줄) */
  memory: string;
  topic: string | null;
  /** 관찰 후보는 가장 최근에 넘긴 세션 */
  sessionId: string;
  /** ISO 시각. 관찰 후보는 가장 최근에 넘긴 시각 */
  timestamp: string;
  kind: "learned" | "observed";
  /** 관찰 후보만: 넘긴 흔적이 있는 서로 다른 세션 수(2 이상) */
  sessionCount?: number;
  /** 관찰 후보만: 실패 묶음 키(`도구: 정규화한 오류`). 실패 발췌와 짝을 맞출 때 쓴다. */
  signature?: string;
}

const MEMORY_LIMIT = 600;
const CANDIDATE_LIMIT = 40;
/** 관찰 후보가 되려면 넘긴 흔적이 이만큼 서로 다른 세션에 있어야 한다. */
export const OBSERVED_MIN_SESSIONS = 2;
export const OBSERVED_LIMIT = 20;

const SESSION_HEADER = /"type"\s*:\s*"session"/;

/** 먼저 만들어진 파일부터 돌려준다. fork·fixture 사본보다 원본이 중복 제거에서 이긴다(sessions.ts와 같은 순서). */
async function jsonlFiles(dir: string, modifiedSince: number): Promise<string[]> {
  const files: { path: string; created: number; modified: number }[] = [];
  const walk = async (d: string) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".jsonl")) {
        try {
          const info = await stat(path);
          if (info.mtimeMs >= modifiedSince) files.push({ path, created: info.birthtimeMs, modified: info.mtimeMs });
        } catch {
          continue;
        }
      }
    }
  };
  await walk(dir);
  return files.sort((a, b) => a.created - b.created || a.modified - b.modified || a.path.localeCompare(b.path)).map((f) => f.path);
}

/** 호출 인자. 객체거나 JSON 문자열로 남은 경우만 읽는다. */
function argumentsOf(block: { arguments?: unknown }): Record<string, unknown> | null {
  let args = block.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  return args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : null;
}

/** `since` 뒤(초과)·`now` 이하에 남긴 절차 후보. 새것부터 최대 40개. fork 사본의 같은 호출은 한 번만 센다. */
export async function collectSkillCandidates(sessionsDir: string, since: number, now: number): Promise<SkillCandidate[]> {
  const found: { at: number; candidate: SkillCandidate }[] = [];
  const seen = new Set<string>();
  for (const path of await jsonlFiles(sessionsDir, since)) {
    let sessionId = "";
    try {
      for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
        // 대부분의 줄은 learn 호출도 세션 머리줄도 아니라 해석하지 않고 넘긴다(세션 머리줄이 첫 줄이 아닐 수 있다).
        if (!line.includes("\"learn\"") && !SESSION_HEADER.test(line)) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (!entry || typeof entry !== "object") continue;
        if (entry.type === "session") {
          sessionId = String(entry.id ?? "");
          continue;
        }
        const at = Date.parse(entry.timestamp);
        const content = entry.type === "message" && entry.message?.role === "assistant" ? entry.message.content : null;
        if (!Number.isFinite(at) || at <= since || at > now || !Array.isArray(content)) continue;
        for (const [index, block] of content.entries()) {
          if (block?.type !== "toolCall" || block.name !== "learn") continue;
          const args = argumentsOf(block);
          if (!args || args.kind !== "procedure" || typeof args.memory !== "string") continue;
          if (args.skill && typeof args.skill === "object") continue;
          // fork 사본은 entry id·시각·메시지 안 호출 순서·본문까지 그대로 복사한다. id가 없는 원본 호출도 순서나 본문으로 갈린다.
          const key = `${entry.id ?? ""}|${entry.timestamp}|${block.id ?? `#${index}`}|${args.memory}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const memory = maskSecrets(args.memory).trim();
          found.push({
            at,
            candidate: {
              memory: memory.length > MEMORY_LIMIT ? `${memory.slice(0, MEMORY_LIMIT)}…` : memory,
              topic: typeof args.topic === "string" && args.topic ? maskSecrets(args.topic).slice(0, 120) : null,
              sessionId,
              timestamp: new Date(at).toISOString(),
              kind: "learned",
            },
          });
        }
      }
    } catch {
      continue;
    }
  }
  return found.sort((a, b) => b.at - a.at).slice(0, CANDIDATE_LIMIT).map((row) => row.candidate);
}

/**
 * 관찰 후보: 같은 실패 묶음 뒤 같은 모양의 호출로 넘긴 흔적을 묶어, 서로 다른 세션이 OBSERVED_MIN_SESSIONS 이상인 것만
 * 후보로 낸다. `since` 뒤(초과) 흔적만 센다. 세션이 많은 순, 같으면 최근 순으로 최대 20개.
 */
export function observedCandidates(recoveries: readonly Recovery[], since: number): SkillCandidate[] {
  const groups = new Map<string, { signature: string; shape: string; sessions: Set<string>; count: number; latest: Recovery }>();
  for (const r of recoveries) {
    if (!(r.at > since)) continue;
    const key = `${r.signature}\n${r.shape}`;
    const group = groups.get(key) ?? { signature: r.signature, shape: r.shape, sessions: new Set<string>(), count: 0, latest: r };
    groups.set(key, group);
    group.sessions.add(r.sessionPath);
    group.count++;
    if (r.at >= group.latest.at) group.latest = r;
  }
  return [...groups.values()]
    .filter((g) => g.sessions.size >= OBSERVED_MIN_SESSIONS)
    .sort((a, b) => b.sessions.size - a.sessions.size || b.latest.at - a.latest.at)
    .slice(0, OBSERVED_LIMIT)
    .map((g) => ({
      memory: clipMasked(`\`${g.signature}\` 실패 뒤 같은 턴에서 \`${g.shape}\` 호출로 넘어갔습니다(서로 다른 세션 ${g.sessions.size}곳, ${g.count}번).`, MEMORY_LIMIT),
      topic: clipMasked(g.signature.split(": ")[0], 120),
      sessionId: g.latest.sessionId,
      timestamp: new Date(g.latest.at).toISOString(),
      kind: "observed",
      sessionCount: g.sessions.size,
      // `normalizeError`가 이미 가린 묶음 키 그대로 둔다. 내보낼 때 같은 키로 실패 발췌를 찾고, 묶음 해석이 다시 자른다.
      signature: g.signature,
    }));
}
