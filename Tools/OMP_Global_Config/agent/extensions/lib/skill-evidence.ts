import { readFileSync, statSync } from "node:fs";

/**
 * 산출물별 필수 스킬 세트(정본 rule://frontend의 required-skills JSON)와 child가 실제로 읽은 skill:// 관측을 잇는 advisory.
 * 발주·완료를 막지 않는다. 읽기 관측은 읽었다는 사실만 뜻하며 절차 수행·품질 증거가 아니다.
 */

export interface RequiredSkillGroup { id: string; when: string; skills: string[] }
export interface RequiredSkillContract { version: 1; sets: RequiredSkillGroup[]; modifiers: RequiredSkillGroup[] }
export type RequiredSkillSource =
  | { state: "loaded"; locator: string; contract: RequiredSkillContract }
  | { state: "unavailable"; locator: string; reason: string };

const FRONTEND_RULE = new URL("../../rules/frontend.md", import.meta.url);
const START = "<!-- required-skills:start -->";
const END = "<!-- required-skills:end -->";
const SKILL_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

function group(value: unknown): RequiredSkillGroup | null {
  if (!value || typeof value !== "object") return null;
  const { id, when, skills } = value as Record<string, unknown>;
  if (typeof id !== "string" || !id.trim() || typeof when !== "string" || !when.trim()) return null;
  if (!Array.isArray(skills) || skills.length === 0 || !skills.every((skill) => typeof skill === "string" && SKILL_NAME.test(skill))) return null;
  return { id: id.trim(), when: when.trim(), skills: skills as string[] };
}

/** 정본 블록 하나를 읽는다. 없거나 깨졌으면 빈 성공이 아니라 unavailable과 이유를 돌려준다. */
export function parseRequiredSkillContract(markdown: string, locator = "rule://frontend"): RequiredSkillSource {
  const start = markdown.indexOf(START);
  const end = markdown.indexOf(END);
  if (start < 0 || end < start) return { state: "unavailable", locator, reason: "required-skills 블록이 없음" };
  if (markdown.indexOf(START, start + START.length) >= 0) return { state: "unavailable", locator, reason: "required-skills 블록이 둘 이상" };
  const fenced = /```json\s*([\s\S]*?)```/.exec(markdown.slice(start + START.length, end))?.[1];
  if (!fenced) return { state: "unavailable", locator, reason: "required-skills 블록에 json 코드 블록이 없음" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced);
  } catch (error) {
    return { state: "unavailable", locator, reason: `required-skills JSON 파싱 실패: ${error instanceof Error ? error.message : String(error)}` };
  }
  const record = parsed as Record<string, unknown> | null;
  if (!record || record.version !== 1 || !Array.isArray(record.sets) || !Array.isArray(record.modifiers)) {
    return { state: "unavailable", locator, reason: "required-skills JSON이 {version:1, sets[], modifiers[]} 형식이 아님" };
  }
  const sets = record.sets.map(group);
  const modifiers = record.modifiers.map(group);
  if (sets.length === 0 || sets.some((entry) => !entry) || modifiers.some((entry) => !entry)) {
    return { state: "unavailable", locator, reason: "required-skills 항목에 id·when·skills가 빠졌거나 스킬 이름이 잘못됨" };
  }
  const ids = [...sets, ...modifiers].map((entry) => entry!.id);
  if (new Set(ids).size !== ids.length) return { state: "unavailable", locator, reason: "required-skills id가 중복됨" };
  return { state: "loaded", locator, contract: { version: 1, sets: sets as RequiredSkillGroup[], modifiers: modifiers as RequiredSkillGroup[] } };
}

export function loadRequiredSkillContract(): RequiredSkillSource {
  try {
    return parseRequiredSkillContract(readFileSync(FRONTEND_RULE, "utf8"));
  } catch (error) {
    // 오류 메시지에는 절대 경로가 들어 있어 advisory·원장에 싣지 않고 오류 코드만 남긴다.
    return { state: "unavailable", locator: "rule://frontend", reason: `읽기 실패: ${(error as NodeJS.ErrnoException).code ?? "unknown"}` };
  }
}

// ── 발주 준비: 기존 Jev 판단 묶음에 붙는 분류 질문 ──

interface SkillQuestion { type: "choice" | "noul"; instructions: string; criteria?: Record<string, string | null> }
interface SkillAnswer { choice?: string; noul?: number }

const DELIVERABLE_KEY = "requiredSkillDeliverable";
const keyOf = (kind: "Set" | "Modifier", id: string) => `requiredSkill${kind}_${id.replace(/[^A-Za-z0-9]/g, "_")}`;
const FACTS_ONLY = "goal·acceptance·facts·paths·remainingJudgments에 적힌 실제 산출물만 근거로 한다. .tsx·.css 같은 파일 확장자나 경로 이름, 브리프·주석의 언어만으로 정하지 않는다. 다른 질문의 답을 가정하지 않는다.";

/** 정본을 읽지 못하면 질문을 만들지 않는다(그 사실은 selectRequiredSkills가 unavailable로 알린다). */
export function requiredSkillQuestions(source: RequiredSkillSource): Record<string, SkillQuestion> {
  if (source.state !== "loaded") return {};
  const questions: Record<string, SkillQuestion> = {
    [DELIVERABLE_KEY]: {
      type: "choice",
      criteria: {
        VISUAL: "사람이 보는 화면·목업·슬라이드의 제작·리디자인·시각 분석·문구 작성처럼 시각·상호작용·보이는 문구 판단이 산출물에 있다.",
        NONVISUAL: "시각 판단이 없는 로직·백엔드·순수 코드 수정, UI와 무관한 조사다. UI 파일 안의 로직 수정도 여기다.",
        UNKNOWN: "적힌 사실만으로 보이는 산출물이 있는지 정할 수 없다.",
      },
      instructions: `이 조각의 산출물에 보이는 화면·문구 판단이 있는지 고른다. ${FACTS_ONLY}`,
    },
  };
  for (const set of source.contract.sets) {
    questions[keyOf("Set", set.id)] = { type: "noul", instructions: `이 조각이 다음에 해당한다: ${set.when}. 여러 세트가 함께 해당할 수 있다. ${FACTS_ONLY}` };
  }
  for (const modifier of source.contract.modifiers) {
    questions[keyOf("Modifier", modifier.id)] = { type: "noul", instructions: `이 조각이 다음에 해당한다: ${modifier.when}. ${FACTS_ONLY}` };
  }
  return questions;
}

export const isRequiredSkillAnswerKey = (key: string) => key.startsWith("requiredSkill");

export interface RequiredSkillSelection {
  state: "selected" | "none" | "ambiguous" | "unavailable";
  reason: string | null;
  sets: string[];
  modifiers: string[];
  skills: string[];
  /** 넓은 분류 NONVISUAL과 모순되게 해당한다고 답한 세트(관측값 그대로). 필수로 요구하지 않고 분류 확인 안내에만 쓴다. */
  contradictedSets?: string[];
}

/** Jev 답을 정본 세트로 옮긴다. 답이 없거나 판단 불가이면 그렇다고 남기고 전부 요구하거나 누락 없음으로 단정하지 않는다. */
export function selectRequiredSkills(source: RequiredSkillSource, answers: Record<string, SkillAnswer> | null, jevError?: string): RequiredSkillSelection {
  const empty = { sets: [], modifiers: [], skills: [] };
  if (source.state !== "loaded") return { state: "unavailable", reason: `정본 ${source.locator}: ${source.reason}`, ...empty };
  if (!answers) return { state: "unavailable", reason: `Jev 분류 불가${jevError ? `: ${jevError}` : ""}`, ...empty };
  const deliverable = answers[DELIVERABLE_KEY]?.choice;
  if (deliverable !== "VISUAL" && deliverable !== "NONVISUAL" && deliverable !== "UNKNOWN") {
    return { state: "unavailable", reason: "Jev가 보이는 산출물 분류(requiredSkillDeliverable)에 답하지 않음", ...empty };
  }
  const missing: string[] = [];
  const pick = (groups: RequiredSkillGroup[], kind: "Set" | "Modifier") => groups.filter((entry) => {
    const raw = answers[keyOf(kind, entry.id)]?.noul;
    const value = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    if (value === null) missing.push(entry.id);
    return value !== null && value >= 0.5;
  });
  // 구체 세트 답은 넓은 분류와 따로 쓴다. UNKNOWN이면 맞은 세트를 그대로 요구하고, 명시적 NONVISUAL과 모순되면 요구하지 않고 관측값만 남긴다.
  const matched = pick(source.contract.sets, "Set");
  const contradicted = deliverable === "NONVISUAL" ? matched : [];
  const sets = deliverable === "NONVISUAL" ? [] : matched;
  const modifiers = pick(source.contract.modifiers, "Modifier");
  const skills = [...new Set([...sets, ...modifiers].flatMap((entry) => entry.skills))];
  const ids = { sets: sets.map((entry) => entry.id), modifiers: modifiers.map((entry) => entry.id), skills };
  if (missing.length > 0) return { state: "ambiguous", reason: `Jev가 ${missing.join(", ")} 해당 여부에 답하지 않음`, ...ids };
  if (deliverable === "UNKNOWN") return { state: "ambiguous", reason: "보이는 산출물 여부를 사실만으로 정하지 못함", ...ids };
  if (contradicted.length > 0) {
    const observed = contradicted.map((entry) => `${entry.id} ${answers[keyOf("Set", entry.id)]!.noul}`).join(", ");
    return { state: "ambiguous", reason: `넓은 분류는 NONVISUAL인데 세트 ${observed}로 답함(모순, 필수로 요구하지 않음)`, ...ids, contradictedSets: contradicted.map((entry) => entry.id) };
  }
  if (deliverable === "VISUAL" && sets.length === 0) return { state: "ambiguous", reason: "보이는 산출물이지만 맞는 세트를 고르지 못함", ...ids };
  return { state: skills.length > 0 ? "selected" : "none", reason: null, ...ids };
}

// ── 브리프 대조 ──

export interface BriefSkillCoverage {
  missing: string[];
  /** 필수 스킬 둘 이상을 선택형으로 묶은 줄의 발췌. */
  alternatives: string[];
  excluded: { skill: string; reason: string }[];
  exclusionProblems: string[];
}

const mentions = (text: string, skill: string) =>
  new RegExp(`(?<![A-Za-z0-9_-])${skill.replace(/[.]/g, "\\.")}(?![A-Za-z0-9_-])`, "i").exec(text);
const ALTERNATION = /(?:또는|혹은|이나|\bor\b|\/|\||,?\s*아니면)/i;
const CHOOSE_ONE = /(?:둘\s*중|중\s*하나|택일|하나만|either|one of|pick one)/i;

/** SKILL_EXCLUSIONS 항목과 그 메타데이터가 차지한 범위(줄바꿈한 JSON 포함). 범위 안 글은 스킬 인계 언급으로 세지 않는다. */
function parseExclusions(task: string, problems: string[]): { entries: { skill: string; reason: string }[]; span: [number, number] | null } {
  const line = /^[^\S\r\n]*SKILL_EXCLUSIONS:[^\S\r\n]*(.*)$/m.exec(task);
  if (!line) return { entries: [], span: null };
  const raw = line[1]!.trim();
  // 한 줄 JSON이 기본이다. 줄바꿈한 객체도 문자열 안 중괄호·escape를 건너뛰며 짝이 맞는 닫는 중괄호까지 읽는다.
  const start = line.index + line[0].indexOf(raw);
  let end = raw.startsWith("{") ? -1 : start + raw.length;
  for (let index = start, depth = 0, quoted = false; end < 0 && index < task.length; index++) {
    const char = task[index];
    if (quoted) {
      if (char === "\\") index++;
      else if (char === "\"") quoted = false;
    } else if (char === "\"") quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) end = index + 1;
  }
  // 닫히지 않은 객체는 끝까지를 메타데이터로 보고 언급으로 세지 않는다.
  if (end < 0) end = task.length;
  const candidate = task.slice(start, end);
  const span: [number, number] = [line.index, Math.max(line.index + line[0].length, end)];
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    problems.push("SKILL_EXCLUSIONS를 {\"스킬명\":\"이유\"} JSON으로 읽지 못함");
    return { entries: [], span };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    problems.push("SKILL_EXCLUSIONS가 {\"스킬명\":\"이유\"} 객체가 아님");
    return { entries: [], span };
  }
  return { entries: Object.entries(parsed as Record<string, unknown>).map(([skill, reason]) => ({ skill: skill.trim(), reason: typeof reason === "string" ? reason.trim() : "" })), span };
}

export function briefSkillCoverage(task: string, selection: RequiredSkillSelection): BriefSkillCoverage {
  const exclusionProblems: string[] = [];
  const { entries: excluded, span } = parseExclusions(task, exclusionProblems);
  for (const entry of excluded) {
    if (!entry.reason) exclusionProblems.push(`SKILL_EXCLUSIONS의 ${entry.skill}에 이유가 없음`);
  }
  // 제외 메타데이터(이유 문장 포함)는 언급으로 세지 않는다.
  const body = span ? `${task.slice(0, span[0])}${task.slice(span[1])}` : task;
  const excludedNames = new Set(excluded.map((entry) => entry.skill));
  const missing = selection.skills.filter((skill) => !excludedNames.has(skill) && !mentions(body, skill));
  const alternatives: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const hits = selection.skills
      .map((skill) => ({ skill, index: mentions(line, skill)?.index ?? -1 }))
      .filter((hit) => hit.index >= 0)
      .sort((left, right) => left.index - right.index);
    if (hits.length < 2) continue;
    const between = hits.slice(1).some((hit, offset) => {
      const previous = hits[offset]!;
      // skill:// scheme의 '/'와 앞 skill:// 언급에 이어진 참고문서 파일 경로(…/x.md)는 URI의 일부라 선택형 구분자로 세지 않는다.
      const raw = line.slice(previous.index + previous.skill.length, hit.index);
      const tail = /skill:\/\/$/i.test(line.slice(0, previous.index)) ? raw.replace(/^(?:\/[^\s/]+)*\/[^\s/]+\.[A-Za-z0-9]+(?=\s|,|$)/, "") : raw;
      return ALTERNATION.test(tail.replace(/skill:\/\//gi, ""));
    });
    if (between || CHOOSE_ONE.test(line)) alternatives.push(line.trim().length > 100 ? `${line.trim().slice(0, 100)}…` : line.trim());
  }
  return { missing, alternatives, excluded, exclusionProblems };
}

/** maker_route briefGaps에 싣는 문장. 발주를 막지 않는다. */
export function requiredSkillGaps(selection: RequiredSkillSelection, coverage: BriefSkillCoverage | null): string[] {
  if (selection.state === "unavailable") return [`필수 스킬 세트 advisory 불가(${selection.reason}): 산출물 종류별 필수 스킬은 Main이 rule://frontend로 직접 확인하세요.`];
  const label = [...selection.sets, ...selection.modifiers].join("+");
  const gaps: string[] = [];
  if (selection.state === "ambiguous") {
    gaps.push(`필수 스킬 세트 분류 미확인(${selection.reason})${label ? `; 확인된 조건 ${label}` : ""}: 보이는 산출물이면 rule://frontend의 세트를 골라 브리프에 인계하세요.`);
  }
  if (!coverage) return gaps;
  if (coverage.missing.length > 0) gaps.push(`필수 스킬 누락(${label}): ${coverage.missing.map((skill) => `skill://${skill}`).join(", ")}. 브리프에 필수로 인계하거나 SKILL_EXCLUSIONS에 이유와 함께 적으세요.`);
  for (const line of coverage.alternatives) gaps.push(`필수 스킬을 선택형으로 줄임: '${line}'. 세트의 스킬은 모두 필수입니다.`);
  gaps.push(...coverage.exclusionProblems.map((problem) => `${problem}. 제외는 승인·읽기 증거가 아니며 이유를 적어야 합니다.`));
  return gaps;
}

/** 발주 원장 dispatch 행의 requiredSkills. 완료 때 실제 읽기와 대조하는 기대값이다. */
export interface DispatchRequiredSkills {
  state: RequiredSkillSelection["state"];
  reason: string | null;
  sets: string[];
  modifiers: string[];
  skills: string[];
  excluded: { skill: string; reason: string }[];
}
export function dispatchRequiredSkills(selection: RequiredSkillSelection, task: string): DispatchRequiredSkills {
  const coverage = briefSkillCoverage(task, selection);
  return { state: selection.state, reason: selection.reason, sets: selection.sets, modifiers: selection.modifiers, skills: selection.skills, excluded: coverage.excluded };
}

// ── 완료: child transcript의 실제 skill:// 읽기 ──

export interface SkillRead {
  skill: string;
  /** full = 루트 SKILL.md 전체, ranged = 줄 범위 선택, reference = 하위 문서, truncated = 출력이 잘림. */
  scope: "full" | "ranged" | "reference" | "truncated";
  target: string;
  at: string;
  atMs: number;
}
export type SkillReadObservation =
  | { state: "observed"; locator: string; reads: SkillRead[]; failed: number; unmatched: number; unparsed: number; lastEntryMs: number }
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
 * 성공한 read tool_result만 읽기로 센다. 실패·결과 없는 호출은 세지 않고 건수만 남긴다.
 * session header가 없는 파일은 child transcript로 보지 않는다(읽기 0건으로 단정하지 않는다).
 */
export function observeSkillReads(text: string, locator: string): SkillReadObservation {
  const lines = text.split("\n");
  if (!lines.slice(0, 3).some((line) => line.startsWith("{\"type\":\"session\""))) {
    return { state: "unobserved", locator, reason: "session header가 없어 child transcript로 확인할 수 없음" };
  }
  const calls = new Map<string, { path: string; extra: boolean }>();
  const reads: SkillRead[] = [];
  let failed = 0;
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
    if (message.isError === true) { failed += 1; continue; }
    const kind = classify(pending.path)!;
    const at = typeof entry.timestamp === "string" ? entry.timestamp : "";
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) { unparsed += 1; continue; }
    const truncated = message.details?.truncation !== undefined && message.details.truncation?.truncated !== false;
    const scope = kind.scope !== "full" ? kind.scope : pending.extra ? "ranged" : truncated ? "truncated" : "full";
    reads.push({ ...kind, scope, target: scope === "ranged" && !kind.target ? "인자 범위" : kind.target, at, atMs });
  }
  return { state: "observed", locator, reads, failed, unmatched: calls.size, unparsed, lastEntryMs };
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
