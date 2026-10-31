/**
 * 보수 대시보드 「고침 표시」 저장소(2026-10-31 사용자 결정). 지표 id마다 고친 시각을 agent 디렉터리의
 * `cuelo-upkeep-fixes.json`에 `{ [metricId]: ISO 시각 }`으로 둔다. 보고서는 표시가 최근 7일 안에 있으면 그 지표를
 * 표시 뒤 기록만으로 다시 판정한다. 같은 프로세스 안의 읽기·쓰기가 섞이지 않도록 동기 입출력만 쓴다.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomicSync } from "../atomic-file";

export const FIX_MARKS_FILE = "cuelo-upkeep-fixes.json";
const MAX_ID_LENGTH = 200;

/**
 * 사건 시각으로 나눠 다시 셀 수 있는 지표. 세션 기록·Maker 결과에서 나오는 값만 해당한다. 기한·배포 리비전·CI는
 * 한 시점의 상태라 나눌 수 없고, 참고용 행(`recall-calls`, `cost-other`)은 판정하지 않아 뺀다.
 */
const FIXABLE_IDS: Record<string, true> = {
  "tool-error-rate": true, "dispatch-rejects": true, "slow-gaps": true, compactions: true, "todo-nudges": true,
  "maker-early-exits": true, "maker-verdicts": true, "recall-per-turn": true, "gated-ratio": true, "memory-export-failures": true,
  "cost-per-turn": true, "session-cache-rewrite": true, "billed-api-key": true, "repeat-complaints": true,
};
/** 비용 섹션의 목적·모델별 행(금액과 캐시 쓰기 비율을 한 행에서 판정) */
export const COST_ROW_PREFIXES = ["purpose:", "model:"] as const;

export function isFixableMetricId(id: string): boolean {
  return Object.hasOwn(FIXABLE_IDS, id) || COST_ROW_PREFIXES.some((prefix) => id.startsWith(prefix) && id.length > prefix.length);
}

/** 요청 본문의 `metricId`가 표시할 수 있는 지표 id면 그 값, 아니면 null. */
export function fixMetricIdFrom(body: unknown): string | null {
  const id = typeof body === "object" && body !== null && "metricId" in body ? body.metricId : undefined;
  return typeof id === "string" && id.length <= MAX_ID_LENGTH && isFixableMetricId(id) ? id : null;
}

/** 보고서의 최근 7일 창. 그보다 오래된 표시는 `activeFixMarks`가 버리므로 남길 수 없다. */
const FIX_WINDOW_MS = 7 * 86_400_000;

/**
 * 요청 본문의 선택 `at`: 고친 동작이 live에 들어간 시각(ISO). 없으면 `now`. 미래이거나 최근 7일 창보다 오래됐거나
 * 해석할 수 없으면 null이다. 배포 시각으로 표시해야 배포와 표시 사이의 기록이 고침 뒤 표본에 들어간다.
 */
export function fixMarkTimeFrom(body: unknown, now: Date): Date | null {
  const at = typeof body === "object" && body !== null && "at" in body ? body.at : undefined;
  if (at === undefined) return now;
  const time = typeof at === "string" ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(time) || time > now.getTime() || time < now.getTime() - FIX_WINDOW_MS) return null;
  return new Date(time);
}

/**
 * 저장된 표시. 파일이 없으면 빈 표시다. 파일이 있는데 읽거나 해석할 수 없으면 던져서, 남기기·지우기가 다른 표시를
 * 덮어쓰거나 지우지 않은 채 성공한 것처럼 보이지 않게 한다. 시각을 읽을 수 없거나 표시할 수 없는 id는 버린다.
 */
export function readFixMarks(agentDir: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(join(agentDir, FIX_MARKS_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${FIX_MARKS_FILE} is not a JSON object`);
  const marks: Record<string, string> = {};
  for (const [id, at] of Object.entries(parsed)) {
    if (typeof at === "string" && Number.isFinite(Date.parse(at)) && isFixableMetricId(id)) marks[id] = at;
  }
  return marks;
}

function writeFixMarks(agentDir: string, marks: Record<string, string>) {
  mkdirSync(agentDir, { recursive: true });
  writePrivateFileAtomicSync(join(agentDir, FIX_MARKS_FILE), `${JSON.stringify(marks, null, 2)}\n`);
}

export function setFixMark(agentDir: string, metricId: string, at: Date) {
  writeFixMarks(agentDir, { ...readFixMarks(agentDir), [metricId]: at.toISOString() });
}

export function clearFixMark(agentDir: string, metricId: string) {
  const marks = readFixMarks(agentDir);
  if (!(metricId in marks)) return;
  delete marks[metricId];
  writeFixMarks(agentDir, marks);
}

/**
 * 최근 7일 창 안의 표시만 돌려준다. 창 시작보다 오래된 표시는 그 사건이 이미 창 밖이라 쓸모가 없으므로 파일에서
 * 지운다(지우지 못해도 보고서는 계속 만든다). 파일을 읽을 수 없으면 표시 없이 보고서를 만들고 파일은 건드리지 않는다.
 */
export function activeFixMarks(agentDir: string, windowStart: number): Record<string, number> {
  let marks: Record<string, string>;
  try {
    marks = readFixMarks(agentDir);
  } catch {
    return {};
  }
  const active: Record<string, number> = {};
  const kept: Record<string, string> = {};
  for (const [id, at] of Object.entries(marks)) {
    const time = Date.parse(at);
    if (time < windowStart) continue;
    active[id] = time;
    kept[id] = at;
  }
  if (Object.keys(kept).length !== Object.keys(marks).length) {
    try {
      writeFixMarks(agentDir, kept);
    } catch {
      // 정리는 다음 보고서에서 다시 시도한다.
    }
  }
  return active;
}
