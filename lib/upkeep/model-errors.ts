/**
 * 야간 묶음에 싣는 날짜별 모델 오류 집계(비식별 정수만). HANDOFF의 Codex 말투 주입 항목(`Unsupported parameter: system`
 * 거절 0건)과 Codex 공백 스트림 복구 항목(실제 오류 뒤 다음 사람 요청 전 같은 모델 복구나 `model_change`)을 클라우드가
 * PC 기록으로 판정하려고 둔다(2026-11-21 야간: 두 항목이 PC 자료 없이 거듭 미측정으로 남음).
 *
 * 메트릭 리더(native/upkeep-reader)는 `errorMessage`와 `stopReason`을 넘기지 않으므로, 후보 파일의 바이트를 한 번 더 훑어
 * 오류 문구가 든 파일만 JSON 줄로 읽는다(192MB 합성 트리 115ms). 분모(날짜별 assistant 응답과 그중 Codex 응답)는
 * scanSessions가 같은 창으로 센다. 날짜는 UTC이고 창은 오늘을 포함한 UTC 14일이다.
 */

import { readFile } from "node:fs/promises";

export const MODEL_ERROR_DAYS = 14;
const DAY_MS = 86_400_000;
const CODEX = "openai-codex";

const SYSTEM_PARAM = ["Unsupported parameter: system"];
const WHITESPACE = ["whitespace-only tool-call argument delta events", "CodexWhitespaceToolCallLoopError"];
const NEEDLES = [...SYSTEM_PARAM, ...WHITESPACE].map((text) => Buffer.from(text));

/**
 * 하루치 집계. `whitespace`는 `whitespaceRecovered`(다음 사람 요청 전에 같은 공급자와 모델이 오류 없이 답했거나
 * `model_change`), `whitespaceUnrecovered`(사람 요청이 먼저 옴), `whitespacePending`(집계 시각까지 둘 다 없음)으로 나뉜다.
 */
export interface ModelErrorDay {
  day: string;
  assistant: number;
  codex: number;
  systemParam: number;
  whitespace: number;
  whitespaceRecovered: number;
  whitespaceUnrecovered: number;
  whitespacePending: number;
}

/** `from`(창 첫날 UTC 0시)~`to`(집계 시각) 집계. 날짜가 없는 날은 모두 0이다. `partial`이면 세션 기록 일부를 읽지 못했다. */
export interface ModelErrorExport {
  from: string;
  to: string;
  partial: boolean;
  days: ModelErrorDay[];
}

export type AssistantDays = Record<string, { assistant: number; codex: number }>;

export function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** 창 첫 순간: `now`가 속한 UTC 날짜를 포함해 14일 전 날의 0시. 그래서 날짜는 정확히 14개다. */
export function modelErrorFrom(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS - (MODEL_ERROR_DAYS - 1) * DAY_MS;
}

type RawEntry = {
  type?: string;
  id?: string;
  timestamp?: string;
  message?: { role?: string; attribution?: string; provider?: string; model?: string; stopReason?: string; errorMessage?: unknown };
};

type Outcome = "recovered" | "unrecovered" | "pending";
type ErrorCounts = Omit<ModelErrorDay, "day" | "assistant" | "codex">;

function emptyCounts(): ErrorCounts {
  return { systemParam: 0, whitespace: 0, whitespaceRecovered: 0, whitespaceUnrecovered: 0, whitespacePending: 0 };
}

/** 줄바꿈으로 끝나지 않은 마지막 조각은 쓰는 중일 수 있어 건너뛰고, 줄바꿈까지 쓰인 깨진 줄은 `malformed`로 알린다. */
function parseLines(text: string): { entries: RawEntry[]; malformed: boolean } {
  const lines = text.split("\n");
  const inProgress = lines.pop() ?? "";
  const entries: RawEntry[] = [];
  let malformed = false;
  const read = (line: string, complete: boolean) => {
    if (!line.trim()) return;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === "object" && !Array.isArray(entry)) return void entries.push(entry as RawEntry);
    } catch {
      // 아래에서 깨진 줄로 센다.
    }
    if (complete) malformed = true;
  };
  for (const line of lines) read(line, true);
  read(inProgress, false);
  return { entries, malformed };
}

/** Codex 응답의 오류 종류. Codex가 아니거나 두 오류가 아니면 null. */
function codexError(entry: RawEntry): { systemParam: boolean; whitespace: boolean } | null {
  const m = entry.message;
  if (entry.type !== "message" || m?.role !== "assistant" || m.provider !== CODEX || typeof m.errorMessage !== "string") return null;
  const error = m.errorMessage;
  const systemParam = SYSTEM_PARAM.some((needle) => error.includes(needle));
  const whitespace = WHITESPACE.some((needle) => error.includes(needle));
  return systemParam || whitespace ? { systemParam, whitespace } : null;
}

/**
 * 공백 스트림 오류마다 첫 결말을 한 번의 순회로 정한다. 하위 세션(`child`)의 사용자 메시지는 Main이 보낸 것이라 사람 요청으로
 * 보지 않는다. `now`보다 뒤의 기록은 보지 않는다. 모델 이름이 없는 오류는 같은 모델 응답으로 복구됐다고 볼 수 없어
 * `model_change`나 사람 요청으로만 끝난다.
 */
function whitespaceOutcomes(entries: readonly RawEntry[], child: boolean, now: number): Map<number, Outcome> {
  const outcomes = new Map<number, Outcome>();
  const byModel = new Map<string, number[]>();
  const open = new Set<number>();
  const settle = (indexes: Iterable<number>, outcome: Outcome) => {
    for (const index of indexes) {
      outcomes.set(index, outcome);
      open.delete(index);
    }
  };
  const settleAll = (outcome: Outcome) => {
    settle([...open], outcome);
    byModel.clear();
  };
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const time = Date.parse(entry.timestamp ?? "");
    // 시각이 없는 기록은 결말 근거가 될 수 없고, 집계 시각 뒤 기록은 아직 일어나지 않은 것으로 본다.
    if (!Number.isFinite(time)) continue;
    if (time > now) break;
    const m = entry.message;
    if (entry.type === "message" && m?.role === "user" && !child && (m.attribution === undefined || m.attribution === "user")) settleAll("unrecovered");
    else if (entry.type === "model_change") settleAll("recovered");
    else if (entry.type === "message" && m?.role === "assistant") {
      const key = typeof m.model === "string" && m.model ? `${m.provider ?? ""}\u0000${m.model}` : null;
      if (codexError(entry)?.whitespace) {
        open.add(index);
        if (key) {
          let waiting = byModel.get(key);
          if (!waiting) byModel.set(key, (waiting = []));
          waiting.push(index);
        }
      } else if (key && m.errorMessage === undefined && m.stopReason !== "error" && m.stopReason !== "aborted" && byModel.has(key)) {
        settle(byModel.get(key)!, "recovered");
        byModel.delete(key);
      }
    }
  }
  for (const index of open) outcomes.set(index, "pending");
  return outcomes;
}

const RANK: Record<Outcome, number> = { pending: 0, recovered: 1, unrecovered: 1 };

/**
 * `files`는 원본이 먼저 오도록 정렬된 세션 파일이다. fork나 하위 세션 사본에 같은 entry(id와 시각)가 있으면 한 번만 세고,
 * 앞 파일에서 결말이 없던 오류는 사본에서 이어진 결말을 쓴다. 읽지 못한 파일이나 깨진 줄이 있으면 `partial`이다.
 */
export async function collectModelErrorCounts(files: readonly { path: string; child: boolean }[], now: number): Promise<{ byDay: Map<string, ErrorCounts>; partial: boolean }> {
  const from = modelErrorFrom(now);
  const errors = new Map<string, { day: string; systemParam: boolean; whitespace: boolean; outcome: Outcome }>();
  let partial = false;
  for (const { path, child } of files) {
    let raw: Buffer;
    try {
      raw = await readFile(path);
    } catch {
      partial = true;
      continue;
    }
    if (!NEEDLES.some((needle) => raw.includes(needle))) continue;
    const { entries, malformed } = parseLines(raw.toString("utf8"));
    partial ||= malformed;
    let outcomes: Map<number, Outcome> | null = null;
    entries.forEach((entry, index) => {
      const kind = codexError(entry);
      if (!kind) return;
      const time = Date.parse(entry.timestamp ?? "");
      if (!Number.isFinite(time) || time < from || time > now) return;
      const outcome = kind.whitespace ? (outcomes ??= whitespaceOutcomes(entries, child, now)).get(index) ?? "pending" : "pending";
      // id가 없으면 사본인지 가릴 수 없으므로 합치지 않고 그 파일의 그 줄로 센다.
      const key = entry.id ? `${entry.id}:${entry.timestamp}` : `${path}#${index}`;
      const seen = errors.get(key);
      if (!seen) errors.set(key, { day: utcDay(time), ...kind, outcome });
      else if (RANK[outcome] > RANK[seen.outcome]) seen.outcome = outcome;
    });
  }
  const byDay = new Map<string, ErrorCounts>();
  for (const error of errors.values()) {
    let counts = byDay.get(error.day);
    if (!counts) byDay.set(error.day, (counts = emptyCounts()));
    if (error.systemParam) counts.systemParam++;
    if (!error.whitespace) continue;
    counts.whitespace++;
    if (error.outcome === "recovered") counts.whitespaceRecovered++;
    else if (error.outcome === "unrecovered") counts.whitespaceUnrecovered++;
    else counts.whitespacePending++;
  }
  return { byDay, partial };
}

/** 분모와 오류 건수를 날짜순으로 합친다. 창 밖 날짜는 버리고, 모두 0인 날은 싣지 않는다. */
export function buildModelErrors(now: number, assistantDays: AssistantDays, errors: Map<string, ErrorCounts>, partial: boolean): ModelErrorExport {
  const from = modelErrorFrom(now);
  const first = utcDay(from), last = utcDay(now);
  const days = [...new Set([...Object.keys(assistantDays), ...errors.keys()])].filter((day) => day >= first && day <= last).sort().map((day) => ({
    day,
    assistant: assistantDays[day]?.assistant ?? 0,
    codex: assistantDays[day]?.codex ?? 0,
    ...(errors.get(day) ?? emptyCounts()),
  }));
  return { from: new Date(from).toISOString(), to: new Date(now).toISOString(), partial, days };
}
