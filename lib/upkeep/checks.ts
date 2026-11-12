/**
 * 보수 대시보드 「점검함 표시」 저장소(2026-11-02 사용자 결정). 원인을 확인했지만 고친 것이 아닌 행(사용자 결정에 따른
 * 사용량 등)에 남긴다. 고침 표시와 달리 판정을 다시 내지 않고, 판정은 그대로 둔 채 행에 시각·사유를 붙이고 같은 섹션의
 * 점검하지 않은 문제·주의 행 아래로 내린다. 지표 id마다 agent 디렉터리의 `cuelo-upkeep-checks.json`에
 * `{ [metricId]: { at: ISO 시각, note: 사유 | null } }`로 두고, 7일이 지난 표시는 읽을 때 지운다.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { criterionIdForMetric } from "./criteria";
import type { UpkeepPrecision, UpkeepVerdict } from "./types";

export const CHECK_MARKS_FILE = "cuelo-upkeep-checks.json";
const MAX_ID_LENGTH = 200;
export const MAX_CHECK_NOTE_LENGTH = 300;
export const CHECK_MARK_NOTE_ERROR = `note must be a string of at most ${MAX_CHECK_NOTE_LENGTH} characters`;
/** 점검은 그때의 7일 창을 본 것이라, 창이 한 바퀴 돌면 표시도 뜻을 잃는다. */
const CHECK_TTL_MS = 7 * 86_400_000;

export interface CheckMark {
  at: string;
  note: string | null;
  verdict?: UpkeepVerdict;
  criterionId?: string;
}

/**
 * 요청 본문의 `metricId`가 쓸 수 있는 지표 id면 그 값, 아니면 null. 점검 표시는 판정을 바꾸지 않으므로 고침 표시와 달리
 * 운영 행을 포함한 모든 지표에 남길 수 있다. 보고서에 없는 id는 아무 행에도 붙지 않고 7일 뒤 지워진다.
 */
export function checkMetricIdFrom(body: unknown): string | null {
  const id = typeof body === "object" && body !== null && "metricId" in body ? body.metricId : undefined;
  return typeof id === "string" && id.trim() === id && id.length > 0 && id.length <= MAX_ID_LENGTH ? id : null;
}

/** 요청 본문의 선택 `note`(원인 한 줄). 없거나 빈 문자열이면 null, 문자열이 아니거나 너무 길면 undefined(거절). */
export function checkNoteFrom(body: unknown): string | null | undefined {
  const note = typeof body === "object" && body !== null && "note" in body ? body.note : undefined;
  if (note === undefined || note === null) return null;
  if (typeof note !== "string") return undefined;
  const trimmed = note.replace(/\s+/g, " ").trim();
  if (trimmed.length > MAX_CHECK_NOTE_LENGTH) return undefined;
  return trimmed || null;
}

export function checkVerdictFrom(body: unknown): UpkeepVerdict | null | undefined {
  const verdict = typeof body === "object" && body !== null && "verdict" in body ? body.verdict : undefined;
  if (verdict === undefined || verdict === null) return null;
  return verdict === "real" || verdict === "false-positive" ? verdict : undefined;
}

/** Legacy marks are not classified; only explicit verdicts enter the denominator. */
export function precisionByRule(marks: Record<string, CheckMark>): Record<string, UpkeepPrecision> {
  const result: Record<string, UpkeepPrecision> = Object.create(null);
  for (const mark of Object.values(marks)) {
    if (!mark.criterionId || !mark.verdict) continue;
    const row = result[mark.criterionId] ??= { real: 0, falsePositive: 0, precision: null };
    if (mark.verdict === "real") row.real++;
    else row.falsePositive++;
    row.precision = row.real / (row.real + row.falsePositive);
  }
  return result;
}

/**
 * 저장된 표시. 파일이 없으면 빈 표시다. 파일이 있는데 읽거나 해석할 수 없으면 던져서, 남기기·지우기가 다른 표시를
 * 덮어쓰거나 지우지 않은 채 성공한 것처럼 보이지 않게 한다. 모양이 맞지 않는 항목은 버린다.
 */
export function readCheckMarks(agentDir: string): Record<string, CheckMark> {
  let text: string;
  try {
    text = readFileSync(join(agentDir, CHECK_MARKS_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${CHECK_MARKS_FILE} is not a JSON object`);
  const marks: Record<string, CheckMark> = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object") continue;
    const { at, note, verdict, criterionId } = value as Partial<CheckMark>;
    if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) continue;
    const classified = (verdict === "real" || verdict === "false-positive") && typeof criterionId === "string" && criterionId.length > 0;
    marks[id] = { at, note: typeof note === "string" && note ? note : null, ...(classified ? { verdict, criterionId } : {}) };
  }
  return marks;
}

function writeCheckMarks(agentDir: string, marks: Record<string, CheckMark>) {
  mkdirSync(agentDir, { recursive: true });
  writePrivateFileAtomicSync(join(agentDir, CHECK_MARKS_FILE), `${JSON.stringify(marks, null, 2)}\n`);
}

export function setCheckMark(agentDir: string, metricId: string, at: Date, note: string | null, verdict?: UpkeepVerdict | null) {
  const classification = verdict ? { verdict, criterionId: criterionIdForMetric(metricId) } : {};
  writeCheckMarks(agentDir, { ...readCheckMarks(agentDir), [metricId]: { at: at.toISOString(), note, ...classification } });
}

/** Editing a live check's classification does not restart its review window. */
export function updateCheckMark(agentDir: string, metricId: string, now: Date, note: string | null | undefined, verdict: UpkeepVerdict | null | undefined) {
  const marks = readCheckMarks(agentDir);
  const previous = Object.hasOwn(marks, metricId) ? marks[metricId] : undefined;
  const active = previous && Date.parse(previous.at) >= now.getTime() - CHECK_TTL_MS && Date.parse(previous.at) <= now.getTime() ? previous : undefined;
  const mark: CheckMark = { ...(active ?? { at: now.toISOString(), note: null }), ...(note === undefined ? {} : { note }) };
  if (verdict !== undefined) {
    delete mark.verdict;
    delete mark.criterionId;
    if (verdict) {
      mark.verdict = verdict;
      mark.criterionId = criterionIdForMetric(metricId);
    }
  }
  writeCheckMarks(agentDir, { ...marks, [metricId]: mark });
}

export function clearCheckMark(agentDir: string, metricId: string) {
  const marks = readCheckMarks(agentDir);
  if (!(metricId in marks)) return;
  delete marks[metricId];
  writeCheckMarks(agentDir, marks);
}

/**
 * 7일 안의 표시만 돌려준다. 그보다 오래된 표시는 파일에서 지운다(지우지 못해도 보고서는 계속 만든다). 파일을 읽을 수
 * 없으면 표시 없이 보고서를 만들고 파일은 건드리지 않는다.
 */
export function activeCheckMarks(agentDir: string, now: number): Record<string, CheckMark> {
  let marks: Record<string, CheckMark>;
  try {
    marks = readCheckMarks(agentDir);
  } catch {
    return {};
  }
  const kept: Record<string, CheckMark> = {};
  for (const [id, mark] of Object.entries(marks)) {
    if (Date.parse(mark.at) >= now - CHECK_TTL_MS) kept[id] = mark;
  }
  if (Object.keys(kept).length !== Object.keys(marks).length) {
    try {
      writeCheckMarks(agentDir, kept);
    } catch {
      // 정리는 다음 보고서에서 다시 시도한다.
    }
  }
  return kept;
}
