import { readFileSync, statSync } from "node:fs";
import { toolNonSuccess } from "./tool-outcome";

// Actual child skill reads; historical dispatch records may also carry expected skills.
const SKILL_NAME = /^[a-z0-9][a-z0-9._-]*$/i;
/** 발주 원장 dispatch 행의 requiredSkills. 완료 때 실제 읽기와 대조하는 기대값이다. */
export interface DispatchRequiredSkills {
  state: "selected" | "none" | "ambiguous" | "unavailable";
  reason: string | null;
  sets: string[];
  modifiers: string[];
  skills: string[];
  excluded: { skill: string; reason: string }[];
}

export interface SkillRead {
  skill: string;
  /** full = 루트 SKILL.md 전체, ranged = 줄 범위 선택, reference = 하위 문서, truncated = 출력이 잘림. */
  scope: "full" | "ranged" | "reference" | "truncated";
  target: string;
  at: string;
  atMs: number;
}
export type SkillReadObservation =
  | { state: "observed"; locator: string; reads: SkillRead[]; failed: number; refused: number; scriptError: number; unmatched: number; unparsed: number; lastEntryMs: number }
  | { state: "unobserved"; locator: string | null; reason: string };

/** 전송 한도. 이보다 큰 transcript는 읽지 않고 미관측으로 둔다. */
const TRANSCRIPT_LIMIT_BYTES = 64 * 1024 * 1024;

/** core structured-subagent: child session file = <부모 session file에서 .jsonl을 뗀 artifactsDir>/<agentId>.jsonl. */
export function childTranscriptPath(parentSessionFile: string | undefined | null, agentId: string): string | null {
  if (!parentSessionFile || !parentSessionFile.endsWith(".jsonl") || !/^[A-Za-z0-9._-]+$/.test(agentId) || agentId.startsWith(".")) return null;
  return `${parentSessionFile.slice(0, -".jsonl".length)}/${agentId}.jsonl`;
}

function classify(path: string): { skill: string; scope: SkillRead["scope"]; target: string } | null {
  const rest = path.slice("skill://".length);
  const name = /^[^/:]+/.exec(rest)?.[0] ?? "";
  if (!SKILL_NAME.test(name)) return null;
  const suffix = rest.slice(name.length);
  if (suffix.startsWith("/")) return { skill: name, scope: "reference", target: suffix.slice(1) };
  if (suffix && suffix !== ":raw") return { skill: name, scope: "ranged", target: suffix };
  return { skill: name, scope: "full", target: "" };
}

/**
 * 성공한 read tool_result만 읽기로 센다. 실패·거절·스크립트 예외·결과 없는 호출은 건수만 남긴다.
 * session header가 없는 파일은 child transcript로 보지 않는다(읽기 0건으로 단정하지 않는다).
 */
export function observeSkillReads(text: string, locator: string): SkillReadObservation {
  const lines = text.split("\n");
  if (!lines.slice(0, 3).some((line) => line.startsWith("{\"type\":\"session\""))) {
    return { state: "unobserved", locator, reason: "session header가 없어 child transcript로 확인할 수 없음" };
  }
  const calls = new Map<string, { path: string; extra: boolean }>();
  const reads: SkillRead[] = [];
  const excluded = { failed: 0, refused: 0, scriptError: 0 };
  let unparsed = 0;
  let lastEntryMs = Number.NEGATIVE_INFINITY;
  for (const line of lines) {
    const stamp = /"timestamp":"([^"]+)"/.exec(line.slice(0, 400))?.[1];
    const stampMs = stamp ? Date.parse(stamp) : Number.NaN;
    if (Number.isFinite(stampMs) && stampMs > lastEntryMs) lastEntryMs = stampMs;
    if (line.includes("\"skill://") && line.includes("\"toolCall\"")) {
      let entry: { message?: { role?: string; content?: unknown } };
      try { entry = JSON.parse(line); } catch { unparsed += 1; continue; }
      if (entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
      for (const part of entry.message.content as { type?: string; id?: string; name?: string; arguments?: Record<string, unknown> }[]) {
        const path = part?.arguments?.path;
        // skill:// 목록(이름 없는 루트)은 스킬 읽기가 아니므로 성공·실패 모두 세지 않는다.
        if (part?.type === "toolCall" && part.name === "read" && typeof part.id === "string" && typeof path === "string" && path.trim().startsWith("skill://") && classify(path.trim())) {
          // 현재 read schema는 path뿐이다. 다른 인자(옛 offset·limit 등)가 있으면 전체 읽기로 세지 않는다.
          const extra = Object.keys(part.arguments ?? {}).some((key) => key !== "path" && key !== "i" && key !== "intent");
          calls.set(part.id, { path: path.trim(), extra });
        }
      }
      continue;
    }
    if (calls.size === 0 || !line.includes("\"toolResult\"")) continue;
    let entry: { timestamp?: unknown; message?: { role?: string; toolCallId?: string; isError?: boolean; details?: { truncation?: { truncated?: boolean } } } };
    try { entry = JSON.parse(line); } catch { unparsed += 1; continue; }
    const message = entry.message;
    if (message?.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
    const pending = calls.get(message.toolCallId);
    if (!pending) continue;
    calls.delete(message.toolCallId);
    const outcome = toolNonSuccess(message);
    if (outcome) {
      excluded[outcome]++;
      continue;
    }
    const kind = classify(pending.path)!;
    const at = typeof entry.timestamp === "string" ? entry.timestamp : "";
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) { unparsed += 1; continue; }
    const truncated = message.details?.truncation !== undefined && message.details.truncation?.truncated !== false;
    const scope = kind.scope !== "full" ? kind.scope : pending.extra ? "ranged" : truncated ? "truncated" : "full";
    reads.push({ ...kind, scope, target: scope === "ranged" && !kind.target ? "인자 범위" : kind.target, at, atMs });
  }
  return { state: "observed", locator, reads, ...excluded, unmatched: calls.size, unparsed, lastEntryMs };
}

export function readChildSkillReads(parentSessionFile: string | undefined | null, agentId: string | undefined): SkillReadObservation {
  if (!agentId) return { state: "unobserved", locator: null, reason: "child id 미관측" };
  const path = childTranscriptPath(parentSessionFile, agentId);
  if (!path) return { state: "unobserved", locator: null, reason: "Main session file 또는 child id로 transcript 위치를 정할 수 없음(임시 세션 포함)" };
  // 출력에는 절대 경로 대신 Main session artifacts 안의 파일 이름만 싣는다.
  const locator = `${agentId}.jsonl`;
  try {
    const size = statSync(path).size;
    if (size > TRANSCRIPT_LIMIT_BYTES) return { state: "unobserved", locator, reason: `transcript가 ${TRANSCRIPT_LIMIT_BYTES}B 한도를 넘음` };
    return observeSkillReads(readFileSync(path, "utf8"), locator);
  } catch (error) {
    return { state: "unobserved", locator, reason: `transcript 읽기 실패: ${(error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error))}` };
  }
}

const READ_LIST_LIMIT = 24;
const SCOPE_LABEL: Record<SkillRead["scope"], string> = { full: "전체", ranged: "범위", reference: "참고문서", truncated: "잘림" };

function listReads(reads: SkillRead[]): string {
  const grouped = new Map<string, { read: SkillRead; count: number }>();
  for (const read of reads) {
    const key = `${read.skill}\u0000${read.scope}\u0000${read.target}`;
    const current = grouped.get(key);
    grouped.set(key, { read: current && current.read.atMs > read.atMs ? current.read : read, count: (current?.count ?? 0) + 1 });
  }
  const items = [...grouped.values()].sort((left, right) => left.read.atMs - right.read.atMs).map(({ read, count }) =>
    `${read.skill}[${SCOPE_LABEL[read.scope]}${read.target ? ` ${read.target}` : ""}]@${read.at}${count > 1 ? `×${count}` : ""}`);
  return items.length > READ_LIST_LIMIT ? `${items.slice(0, READ_LIST_LIMIT).join(", ")} 외 ${items.length - READ_LIST_LIMIT}개` : items.join(", ") || "없음";
}

export const SKILL_EVIDENCE_LIMITS = "한계: read 도구의 skill:// 성공 결과만 관측(eval·bash로 연 스킬 파일, 하위 child의 읽기는 미관측). 읽기 관측은 절차 수행·품질 증거가 아니며 slop_check 통과도 humanizer·kill-ai-slop 절차 증거가 아니다. 제외 신고는 읽기로 세지 않는다.";

/** 이 attempt의 읽기 구간. whole = transcript 전체가 이 attempt(첫 attempt), from = 시작 시각 이후, unknown = attempt를 가를 수 없음. */
export type SkillReadWindow = { kind: "whole"; reason: string } | { kind: "from"; ms: number } | { kind: "unknown"; reason: string };

/**
 * pre-review advisory의 child별 한 줄. 이 attempt 밖(이전 attempt·구분 불가)의 읽기는 따로 보이고 필수 대조에서 이번 근거로 세지 않는다.
 */
export function renderSkillEvidence(input: {
  label: string;
  observation: SkillReadObservation;
  window: SkillReadWindow;
  expected: DispatchRequiredSkills | null | undefined;
  expectedSource: string;
}): string {
  const { label, observation, window, expected } = input;
  // 이 attempt 시작 뒤 기록이 하나도 없는 transcript는 이 실행의 것이라고 볼 수 없다.
  const stale = observation.state === "observed" && window.kind === "from" && observation.lastEntryMs < window.ms;
  if (observation.state !== "observed" || stale) {
    const reason = observation.state === "observed" ? "transcript에 이 attempt 시작 뒤 기록이 없음" : observation.reason;
    return `[skill-read] ${label}: 읽기 증거 없음(미관측: ${reason}${observation.locator ? `; transcript=${observation.locator}` : ""}). ${requiredText(expected, input.expectedSource, null)} ${SKILL_EVIDENCE_LIMITS}`;
  }
  const inWindow = (read: SkillRead) => window.kind === "whole" || (window.kind === "from" && read.atMs >= window.ms);
  const current = observation.reads.filter(inWindow);
  const earlier = observation.reads.filter((read) => !inWindow(read));
  const heading = window.kind === "whole" ? `이 attempt(${window.reason}: transcript 전체)`
    : window.kind === "from" ? `이 attempt(${new Date(window.ms).toISOString()} 이후)`
      : `이 attempt 구분 불가(${window.reason})`;
  const extras = [
    earlier.length > 0 ? `${window.kind === "unknown" ? "attempt를 가르지 못한 읽기" : "이전 attempt 읽기"}(이번 attempt 근거·절차 완료 아님): ${listReads(earlier)}` : "",
    observation.failed > 0 ? `실패한 skill 읽기 ${observation.failed}건 제외` : "",
    observation.refused > 0 ? `거절된 skill 읽기 ${observation.refused}건 제외` : "",
    observation.scriptError > 0 ? `스크립트 예외가 난 skill 읽기 ${observation.scriptError}건 제외` : "",
    observation.unmatched > 0 ? `결과 없는 skill 읽기 호출 ${observation.unmatched}건 제외` : "",
    observation.unparsed > 0 ? `해석하지 못한 transcript 줄 ${observation.unparsed}건(그 안의 읽기는 미관측)` : "",
  ].filter(Boolean).join("; ");
  return `[skill-read] ${label}: ${heading} 관측 읽기 ${listReads(current)}${extras ? `; ${extras}` : ""}. ${requiredText(expected, input.expectedSource, { current, earlier })} transcript=${observation.locator}. ${SKILL_EVIDENCE_LIMITS}`;
}

function requiredText(expected: DispatchRequiredSkills | null | undefined, source: string, reads: { current: SkillRead[]; earlier: SkillRead[] } | null): string {
  if (!expected) return `필수 세트 미관측(${source}).`;
  if (expected.state === "unavailable" || expected.state === "none") {
    return expected.state === "none" ? "필수 세트 없음(비시각 분류)." : `필수 세트 미확인(${expected.reason ?? "분류 불가"}).`;
  }
  const label = [...expected.sets, ...expected.modifiers].join("+") || "조건 미확인";
  const excludedNames = new Set(expected.excluded.map((entry) => entry.skill));
  const parts: string[] = [];
  if (expected.state === "ambiguous") parts.push(`분류 미확인(${expected.reason ?? ""})`);
  if (reads) {
    const fullNow = new Set(reads.current.filter((read) => read.scope === "full").map((read) => read.skill));
    const anyNow = new Set(reads.current.map((read) => read.skill));
    const anyEarlier = new Set(reads.earlier.map((read) => read.skill));
    const open = expected.skills.filter((skill) => !excludedNames.has(skill) && !fullNow.has(skill));
    const partial = open.filter((skill) => anyNow.has(skill));
    const earlierOnly = open.filter((skill) => !anyNow.has(skill) && anyEarlier.has(skill));
    const missing = open.filter((skill) => !anyNow.has(skill) && !anyEarlier.has(skill));
    parts.push(`전체 읽기 관측 ${expected.skills.filter((skill) => fullNow.has(skill)).join(", ") || "없음"}`);
    if (partial.length > 0) parts.push(`부분 읽기만 ${partial.join(", ")}`);
    if (earlierOnly.length > 0) parts.push(`이번 attempt 밖에서만 읽음 ${earlierOnly.join(", ")}`);
    if (missing.length > 0) parts.push(`읽기 관측 없음 ${missing.join(", ")}`);
  }
  if (expected.excluded.length > 0) parts.push(`브리프 제외 신고 ${expected.excluded.map((entry) => `${entry.skill}(${entry.reason ? "이유 있음" : "이유 없음"})`).join(", ")}`);
  return `필수(${label}): ${parts.join("; ")}.`;
}
