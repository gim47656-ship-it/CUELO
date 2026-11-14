import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { onSessionLifecycle } from "./lib/session-identity";
import { DEFAULT_LEDGER_PATH } from "./lib/routing-ledger";
import { readFileSync } from "node:fs";

/**
 * 도움 모델 명단 확인. 전역 `AGENTS.md` 「사용자 보고」: child나 다른 모델을 쓴 턴의 완료 보고는 역할 → 실제 모델 명단을 적는다
 * (rule-enforcement A32). 2026-11-14 Main이 「코드 교차 검토: GPT 쪽 검토자」라고 적었는데 실제 필수 검토자는 GPT-6 Astra였고
 * 사용자가 「코드검토자는 아스트라인데 왜 지피티쪽검토자라고 보고한거지..」라고 지적했다. 같은 날 「장치로만들자」.
 *
 * 턴을 끝내는 Main 답(도구 호출 없는 assistant 메시지)이 역할 말(교차 검토·문구 점검·Maker)을 담으면, 이 세션에서 그 역할을
 * 실제로 맡아 답한 모델을 원장(routing-ledger.jsonl)과 세션 도구 결과에서 모아 본문과 대 본다. 제공사 계열만 적었거나("GPT 쪽"),
 * 역할에 맞는 실제 모델 이름이 하나도 없거나, 그 역할에서 답하지 않은 모델 이름을 적었으면 사용자 입력 하나에 한 번 일깨운다.
 * 알림은 차단이 아니다: 답은 이미 화면에 나갔으므로 틀린 이름이 있었으면 짧게 정정하게 한다.
 */

export const REMINDER_TYPE = "helper-model-report-guard";

export type Role = "review" | "slop" | "maker";

const ROLE_LABEL: Readonly<Record<Role, string>> = { review: "코드 교차 검토", slop: "문구 점검(slop_check)", maker: "구현 Maker" };

// 본문에서 역할을 말한 줄. 「검토」만으로는 넓어(「검토해 볼게요」) 검토자·교차 검토·코드 검토만 센다.
const ROLE_CUE: Readonly<Record<Role, RegExp>> = {
  review: /교차\s?검토|코드\s?검토|검토자|cross[_ -]?review|reviewer/i,
  slop: /문구\s?점검|슬롭|slop/i,
  maker: /\bMakers?\b|메이커|구현\s?(?:담당|모델)/i,
};

// 제공사·계열만 가리키는 말. 뒤에 쪽·계열·측이 붙어야 계열 표현이다(「GPT-6 Astra」「Claude Code」는 아니다).
const FAMILY_ONLY = /(?:GPT|OpenAI|오픈\s?AI|지피티|Anthropic|앤트로픽|Claude|클로드|Gemini|제미나이|Google|구글|DeepSeek|딥시크)\s?(?:쪽|계열|측)/gi;

// 모델 id 조각 중 이름이 아닌 것(계열·크기·버전 꼬리). 남는 조각이 모델의 이름이다(gpt-6-astra → astra).
const GENERIC_TOKENS: Readonly<Record<string, true>> = { gpt: true, claude: true, gemini: true, flash: true, pro: true, mini: true, ai: true, preview: true, latest: true, exp: true, instruct: true, chat: true };
// 사용자가 부르는 한글 이름과 캐릭터 별칭. 없으면 라틴 이름만 본다.
const KOREAN_NAMES: Readonly<Record<string, readonly string[]>> = {
  astra: ["아스트라", "유키"],
  luna: ["루나"],
  sol: ["솔"],
  terra: ["테라"],
  opus: ["오퍼스", "오푸스"],
  sonnet: ["소네트", "소넷"],
  haiku: ["하이쿠"],
  fable: ["페이블"],
  hydrogen: ["하이드로젠"],
  argon: ["아르곤"],
  carbon: ["카본"],
  deepseek: ["딥시크", "이사나"],
  glm: ["미츠"],
};

/** 모델 id에서 본문에 나올 수 있는 이름들(라틴 이름과 한글 이름). */
export function namesOf(modelId: string): string[] {
  const tail = modelId.split("/").pop() ?? modelId;
  const tokens = tail.toLowerCase().split(/[-_]/).filter((token) => /^[a-z]+$/.test(token));
  const named = tokens.filter((token) => !GENERIC_TOKENS[token]);
  const primary = named.length > 0 ? named : tokens.slice(0, 1);
  return primary.flatMap((token) => [token, ...(KOREAN_NAMES[token] ?? [])]);
}

function mentions(text: string, name: string): boolean {
  // 라틴 이름은 식별자 경계로(「sol」이 「solution」에, 「astra」가 「astra_backup」「astra2」에 걸리지 않게), 한글 이름은 앞이 한글이
  // 아닐 때만 센다(「솔」이 「콘솔」에 걸리지 않게). 모델 id 안의 이름(gpt-6-astra)은 하이픈 경계라 센다.
  if (/^[a-z]+$/.test(name)) return new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, "i").test(text);
  return new RegExp(`(?<![가-힣])${name}`).test(text);
}

export type HelperModels = Record<Role, Set<string>>;

type LedgerLine = {
  type?: string;
  sessionId?: string;
  reviewId?: string;
  chosenModel?: string;
  reviewers?: unknown;
  advisory?: unknown;
};

type Answer = { model?: unknown; status?: unknown };

/** 실제로 답한 자리의 모델. 모양이 다른 원장 줄(손으로 고친 줄, 옛 형식)은 조용히 건너뛴다. */
function answeredModel(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { model, status } = value as Answer;
  return status === "ok" && typeof model === "string" && model.length > 0 ? model : undefined;
}

/** 원장에서 이 세션의 발주 모델과, 이 세션 것이거나 세션 기록에 나온 검토 id의 실제 응답 검토자. */
export function helpersFromLedger(lines: readonly LedgerLine[], sessionId: string, reviewIds: ReadonlySet<string>, into: HelperModels): void {
  for (const line of lines) {
    if (!line || typeof line !== "object") continue;
    if (line.type === "dispatch" && line.sessionId === sessionId && typeof line.chosenModel === "string") into.maker.add(line.chosenModel);
    if (line.type !== "cross-review") continue;
    if (line.sessionId !== sessionId && !(typeof line.reviewId === "string" && reviewIds.has(line.reviewId))) continue;
    // 실제로 답한 자리만 센다. 늦거나 실패한 보조 검토자는 「답한 모델」이 아니다.
    for (const reviewer of Array.isArray(line.reviewers) ? line.reviewers : []) {
      const model = answeredModel(reviewer);
      if (model) into.review.add(model);
    }
    const advisory = answeredModel(line.advisory);
    if (advisory) into.review.add(advisory);
  }
}

export function readLedgerLines(path: string): LedgerLine[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: LedgerLine[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"type":"dispatch"') && !line.includes('"type":"cross-review"')) continue;
    try {
      out.push(JSON.parse(line) as LedgerLine);
    } catch {
      // 깨진 줄은 건너뛴다.
    }
  }
  return out;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

type ContentBlock = { type?: string; name?: string; arguments?: Record<string, unknown> };
type BranchEntry = {
  type?: string;
  customType?: string;
  message?: { role?: string; toolName?: string; customType?: string; content?: unknown; isError?: boolean };
  content?: unknown;
};

const REVIEW_ID = /\bxr-\d{14}-[0-9a-f]{6}\b/g;
// child가 Main에게 보내는 보고(완료 결과, 메시지). Maker는 자기 세션에서 cross_review를 돌려 그 검토 id를 여기에 적는다.
const CHILD_REPORT_TYPES: Readonly<Record<string, true>> = { "async-result": true, "irc:incoming": true };

/**
 * 세션 기록에서 Main의 slop_check 응답 모델과 검토 id. 검토 id는 Main이 부른 cross_review 인자와 child 보고에서만 줍는다.
 * 파일 읽기·검색 결과나 Main의 설명 글에 나온 id는 다른 날의 검토일 수 있다(2026-11-14 첫 실측: bash 결과의 10-11, 11-14 오전
 * 검토 id 5개가 Opus와 Fable을 이 세션의 검토자로 끌어들였다).
 */
export function scanBranch(entries: readonly BranchEntry[], into: HelperModels): Set<string> {
  const reviewIds = new Set<string>();
  for (const entry of entries) {
    const message = entry.message;
    const customType = message?.customType ?? entry.customType;
    if (customType && CHILD_REPORT_TYPES[customType]) {
      for (const id of textOf(message?.content ?? entry.content).match(REVIEW_ID) ?? []) reviewIds.add(id);
      continue;
    }
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content as ContentBlock[]) {
        if (block?.type !== "toolCall" || block.name !== "cross_review") continue;
        for (const key of ["reviewId", "previousReviewId"]) {
          const value = block.arguments?.[key];
          if (typeof value === "string") reviewIds.add(value);
        }
      }
      continue;
    }
    if (message?.role !== "toolResult" || message.toolName !== "slop_check" || message.isError) continue;
    // 결과 JSON의 reviewers[] 중 status ok인 자리의 model.
    try {
      const reviewers = (JSON.parse(textOf(message.content)) as { reviewers?: unknown } | null)?.reviewers;
      for (const reviewer of Array.isArray(reviewers) ? reviewers : []) {
        const model = answeredModel(reviewer);
        if (model) into.slop.add(model);
      }
    } catch {
      // JSON이 아닌 결과(오류 문장)는 건너뛴다.
    }
  }
  return reviewIds;
}

export type Finding =
  | { kind: "family-only"; phrase: string }
  | { kind: "missing"; role: Role }
  | { kind: "other-model"; role: Role; name: string };

// 본문에 나올 수 있는 모델 이름 전체(오답 판정용). 실제 명단에 없는 이 이름이 역할 줄에 나오면 다른 모델을 적은 것이다.
const KNOWN_NAMES = Object.entries(KOREAN_NAMES).map(([latin, korean]) => [latin, ...korean]);

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
const INDENTED = /^\s+\S/;
// 명단 줄로 보는 길이. 이보다 긴 들여쓰지 않은 문단은 설명 글이라 이름이 여러 맥락으로 섞인다.
export const ROSTER_LINE_MAX = 80;
// 인용한 말은 보고한 명단이 아니다(「"GPT 쪽"처럼 계열만 적은 경우」 같은 예시). 작은따옴표는 영어 축약과 겹쳐 빼지 않는다.
const QUOTED = /「[^」\n]*」|"[^"\n]*"|“[^”\n]*”|`[^`\n]*`/g;

/**
 * 줄마다 그 줄이 판정 대상으로 말하는 역할과, 명단으로 판정할 글. 역할 말이 있는 줄은 그 역할이다. 역할 말이 없는 목록 항목과
 * 들여쓴 줄은 앞 역할을 물려받고(「reviewer:」 아래 「- Astra」, 교차검토 R2-OAI-1·R3-OAI-2), 제목과 목록 사이의 빈 줄은 건너뛴다.
 * 들여쓰지 않은 일반 문장에서 끊긴다. 실제 모델을 모르는 역할(Maker 기록이 없을 때의 「- Maker: …」)의 줄도 거기서 끊어, 그 줄과
 * 아래 항목을 판정하지 않는다(R3-OAI-1).
 * 판정할 글은 인용을 뺀 줄이며, 목록 항목도 들여쓴 줄도 아닌 긴 문단은 비운다. 2026-11-14 배포 직후 이 장치를 설명한 Main의
 * 완료 보고(따옴표 안 예시 「"GPT 쪽"」, 실제 명단과 오염 사례를 늘어놓은 문단)에 계열만 적음과 다른 모델 다섯 건을 잘못 냈다.
 */
function lineRoles(text: string, roles: readonly Role[]): { line: string; roles: Role[] }[] {
  let inherited: Role[] = [];
  return text.split("\n").map((raw) => {
    const cued = (Object.keys(ROLE_CUE) as Role[]).filter((role) => ROLE_CUE[role].test(raw));
    const listed = LIST_ITEM.test(raw) || INDENTED.test(raw);
    if (cued.length > 0) inherited = cued.filter((role) => roles.includes(role));
    else if (raw.trim() !== "" && !listed) inherited = [];
    const line = listed || raw.trim().length <= ROSTER_LINE_MAX ? raw.replace(QUOTED, " ") : "";
    return { line, roles: inherited };
  });
}

/** 보고 본문과 실제 명단을 대 본다. 역할 말이 없거나 그 역할의 실제 모델을 모르면 그 역할은 판정하지 않는다. */
export function findings(text: string, helpers: HelperModels): Finding[] {
  const out: Finding[] = [];
  const roles = (Object.keys(ROLE_CUE) as Role[]).filter((role) => ROLE_CUE[role].test(text) && helpers[role].size > 0);
  if (roles.length === 0) return out;
  const lines = lineRoles(text, roles);
  const allNames = [...roles.flatMap((role) => [...helpers[role]])].flatMap(namesOf);
  // 판정하는 역할을 말한 줄(과 그 아래 목록 항목)의 계열 표현만 센다. 실제 모델을 모르는 역할의 줄이나 역할과 무관한 설명
  // (「Anthropic 작성이면 GPT 쪽으로 간다」)은 판정하지 않는다. 같은 줄에 실제 이름이 함께 있으면(「GPT 계열 아스트라」) 계열 설명일 뿐이다.
  for (const { line, roles: lineRole } of lines) {
    if (lineRole.length === 0 || allNames.some((name) => mentions(line, name))) continue;
    for (const match of line.matchAll(FAMILY_ONLY)) out.push({ kind: "family-only", phrase: match[0] });
  }
  for (const role of roles) {
    const names = [...helpers[role]].flatMap(namesOf);
    if (!names.some((name) => mentions(text, name))) out.push({ kind: "missing", role });
    // 그 역할을 말한 줄에 그 역할에서 답하지 않은 모델 이름이 있으면 다른 모델을 적은 것이다.
    for (const { line } of lines.filter((candidate) => candidate.roles.includes(role))) {
      for (const group of KNOWN_NAMES) {
        if (group.some((name) => names.includes(name))) continue;
        const hit = group.find((name) => mentions(line, name));
        if (hit && !out.some((finding) => finding.kind === "other-model" && finding.role === role && finding.name === hit)) out.push({ kind: "other-model", role, name: hit });
      }
    }
  }
  return out;
}

/** 같은 이름(같은 모델의 다른 경로)은 한 번만 적고 id를 묶는다: 하이드로젠(aistudio/…, google-vertex/…). */
function rosterLine(modelIds: Iterable<string>): string {
  const byName = new Map<string, string[]>();
  for (const id of modelIds) {
    const [latin, ...korean] = namesOf(id);
    const name = korean[0] ?? latin;
    byName.set(name, [...(byName.get(name) ?? []), id]);
  }
  return [...byName].map(([name, ids]) => `${name}(${ids.join(", ")})`).join(", ");
}

export function reminderText(found: readonly Finding[], helpers: HelperModels): string {
  const problems = found.map((finding) =>
    finding.kind === "family-only" ? `「${finding.phrase}」처럼 제공사 계열만 적었다`
      : finding.kind === "missing" ? `${ROLE_LABEL[finding.role]}의 실제 모델 이름이 없다`
        : `${ROLE_LABEL[finding.role]} 줄에 이 세션에서 그 역할로 답하지 않은 「${finding.name}」이 있다`);
  const roster = (Object.keys(helpers) as Role[])
    .filter((role) => helpers[role].size > 0)
    .map((role) => `- ${ROLE_LABEL[role]}: ${rosterLine(helpers[role])}`)
    .join("\n");
  return `직전 보고의 도움 모델 명단이 기록과 다르다: ${problems.join("; ")}. 원장과 도구 결과에 남은, 이 세션에서 실제로 답한 모델은 다음과 같다(보조 검토자는 제때 답한 경우만):\n${roster}\n`
    + "보고한 역할에 해당하는 모델을 이 이름으로 바로잡아 한두 문장으로 정정한다. 이 세션 밖(다른 세션, 이전 작업)의 검토나 Maker를 말한 것이라 이 명단과 다른 게 맞다면 아무 문장도 덧붙이지 말고 끝낸다. 어느 경우든 이 알림을 사용자에게 언급하지 않는다.";
}

export interface HelperModelReportGuardDeps {
  readLedger?: () => readonly LedgerLine[];
}

type Message = { role?: string; content?: unknown; synthetic?: boolean; attribution?: string };

export function createHelperModelReportGuard(deps: HelperModelReportGuardDeps = {}) {
  const readLedger = deps.readLedger ?? (() => readLedgerLines(process.env.OMP_CROSS_REVIEW_LEDGER || DEFAULT_LEDGER_PATH));
  return function helperModelReportGuard(pi: ExtensionAPI): void {
    let reminded = false;
    const reset = () => { reminded = false; };
    onSessionLifecycle(pi, { start: reset });
    pi.on("session_shutdown", reset);
    // 사용자 직접 입력 하나에 한 번만 알린다. 알림이 만든 정정 답이 다시 걸려도 반복하지 않는다.
    pi.on("message_start", (event) => {
      const message = event.message as Message;
      if (message.role === "user" && message.synthetic !== true && message.attribution !== "agent") reset();
    });
    pi.on("message_end", (event, ctx: ExtensionContext) => {
      const message = event.message as Message;
      if (reminded || message.role !== "assistant" || ctx.agent.kind !== "main") return;
      // 턴을 끝내는 답만 본다. 도구 사이 진행 문장은 완료 보고가 아니다.
      if (Array.isArray(message.content) && message.content.some((block) => block?.type === "toolCall")) return;
      const text = textOf(message.content);
      if (!(Object.values(ROLE_CUE) as RegExp[]).some((cue) => cue.test(text))) return;
      const helpers: HelperModels = { review: new Set(), slop: new Set(), maker: new Set() };
      const reviewIds = scanBranch(ctx.sessionManager.getBranch() as readonly BranchEntry[], helpers);
      helpersFromLedger(readLedger(), ctx.sessionManager.getSessionId(), reviewIds, helpers);
      const found = findings(text, helpers);
      if (found.length === 0) return;
      reminded = true;
      pi.sendMessage(
        { customType: REMINDER_TYPE, content: reminderText(found, helpers), display: false, attribution: "agent" },
        { deliverAs: "nextTurn", triggerTurn: true },
      );
    });
  };
}

export default createHelperModelReportGuard();
