/**
 * 야간 자율 개선의 절차서(스킬) 후보 수집. 세션 기록에서 `learn` 도구 호출 가운데 `kind: "procedure"`이면서 스킬로
 * 만들지 않은(`skill` 객체가 없는) 것만 모은다. 야간 세션은 같은 요령이 두 세션 이상에서 보일 때만 절차서로 만든다.
 * 읽지 못하는 파일·줄은 건너뛴다.
 */
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { maskSecrets } from "./sessions";

export interface SkillCandidate {
  /** 비밀을 가리고 600자로 줄인 기억 본문 */
  memory: string;
  topic: string | null;
  sessionId: string;
  /** ISO 시각 */
  timestamp: string;
}

const MEMORY_LIMIT = 600;
const CANDIDATE_LIMIT = 40;
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
              topic: typeof args.topic === "string" && args.topic ? args.topic : null,
              sessionId,
              timestamp: new Date(at).toISOString(),
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
