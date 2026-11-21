// 순수 판정 로직(2026-11 요구 보존 검사). 모델·JEV 호출 없이 문자열만 본다.
// 근거: arXiv 2611.06545(핸드오프 요약이 기록에 없는 승인을 씀; 거짓 승인 제거 24->7/120, 제한 문장 검사는 유의하지 않아 제외), arXiv 2611.07483(핸드오프가 요구를 빠뜨림, 원문 인용 + 결정적 검사).

export const PREFIX = "[requirement-carry]";
/** 안내 한 건의 글자 수 상한. 목록은 자르고 건수는 남긴다. */
export const MAX_ADVICE = 600;
/** 인용으로 인정하는 최소 길이(공백 제외). task-guard의 USER_REQUEST 인용 기준과 같다. */
export const MIN_CHARS = 6;
const MAX_EXCERPTS = 5;
const EXCERPT_CHARS = 70;

/** task-guard `normalizeQuote`와 같은 비교형: 인용부호를 지우고 공백을 합치고 소문자로 만든다. */
export function normalize(value: string): string {
  return value
    .replace(/["'`“”‘’「」『』«»]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

/** 공백 제외 글자 수. 이모지 같은 보조 평면 문자도 한 글자로 센다. */
export const squashLength = (value: string): number => Array.from(value.replace(/\s/g, "")).length;

function clip(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

const LOG_ITEM_CHARS = 40;
/**
 * 이벤트 기록에 싣는 항목: 짧게 자르고 4자리 이상 숫자열과 긴 토큰·비밀 낱말 뒤 값을 가린다. 기록은 어떤 문장이 걸렸는지
 * 가늠하는 용도(오탐 판단)이고, 비밀 형식을 다 알아보는 것은 불가능하므로 앞 40자만 남긴다.
 */
export function forLog(value: string): string {
  const redacted = value
    .replace(/(?:key|token|secret|passw(?:or)?d|pin|비밀번호|토큰)\s*[:=]?\s*\S+/gi, "[REDACTED]")
    .replace(/[A-Za-z0-9+/_-]{24,}/g, "[REDACTED]")
    .replace(/\d{4,}/g, "[N]");
  return clip(redacted, LOG_ITEM_CHARS);
}

/** 글자 수 상한 안에서 목록 항목을 넣고, 못 넣은 건수는 `외 N건`으로 남긴다. */
function fitList(head: string, items: readonly string[], tail: string): string {
  const shown: string[] = [];
  for (const item of items.slice(0, MAX_EXCERPTS)) {
    const next = [...shown, item];
    const rest = items.length - next.length;
    const candidate = `${head}${next.map((entry) => `「${entry}」`).join(" ")}${rest > 0 ? ` 외 ${rest}건` : ""}${tail}`;
    if (candidate.length > MAX_ADVICE && shown.length > 0) break;
    shown.push(item);
  }
  const rest = items.length - shown.length;
  const text = `${head}${shown.map((entry) => `「${entry}」`).join(" ")}${rest > 0 ? ` 외 ${rest}건` : ""}${tail}`;
  return text.length > MAX_ADVICE ? `${text.slice(0, MAX_ADVICE - 1)}…` : text;
}

// ---- 압축 요약 검사 -------------------------------------------------------------------------------------------

/** 사용자가 승인했다는 말(과거·완료형). 주제로만 언급한 "approval process"와 개인적 결정("decided to investigate")은 포함하지 않는다. */
const APPROVAL =
  /(?:승인|허락|허용|허가|동의)(?:했|함|됐|된|한|하였|하여|하셨|을 받|받았|\s*완료|해 줬|해줬)|decided to (?:approve|allow|authori[sz]e)|approv(?:ed|es)|approval (?:from|by|given|granted)|authori[sz]ed|agreed|allowed (?:to|deploy|the|us|me)|permitted to|(?:was|were|is|are) (?:allowed|permitted)|grant(?:ed|s)? (?:\w+ ){0,2}(?:permission|approval|authori[sz]ation|consent)|consented|signed[- ]?off (?:on|by)|go-ahead|permission (?:to|for)|(?:gave|given|has|have|had|with)(?: \w+){0,3} (?:permission|approval|authori[sz]ation|consent)/i;

/** 승인이 없는 쪽(받지 못함·거부·아직 아님), 요청, 승인이 필요하다는 제한을 말하는 절. 승인했다는 주장이 아니므로 대상이 아니다. */
const NEGATED =
  /(?:승인|허락|허용|허가|동의)(?:을|를|이|은|는|도)?\s*(?:받지|되지|하지|않|못|거부|거절|요청|요구|문의|필요|있어야|선행)|(?:승인|허락|허용|허가|동의)(?:한|했던|해 준|해준) 적(?:이|은|도)? ?(?:없|않)|(?:\b(?:not\b(?! only)|never\b|no\b)|n['’]t)[ -]?(?:yet )?(?:\w+ ){0,2}(?:approved?|approves|authori[sz]ed?|permitted|allowed?|decided|agreed|grant(?:ed)?|given|give|gave)|\bun(?:approved|authori[sz]ed|permitted|allowed|agreed|granted)|has not decided|\bno (?:approval|authori[sz]ation|permission|consent)|not (?:given|granted)|denied|rejected|(?<!\b(?:from|by) (?:\w+ )?)\buser (?:\w+ ){0,2}(?:was|were|been|get|gets|got|received|receives|obtained) (?:\w+ ){0,3}(?:granted|given|permission|approval|authori[sz]ation|consent)|\b(?:will|would|might|may|could|should|shall|once|until|if)\b(?: \w+){0,3} (?:approve|grant|give|allow|authori[sz]e)|\b(?:expected|going|about|likely|supposed|planning|plans|intends?|(?:they|we|he|she|i|you) plan) to\b(?: \w+){0,3} (?:approve|grant|give|allow|authori[sz]e)|(?:ask(?:ed|s|ing)?|appl(?:ied|ies|y)|request(?:ed|s|ing)?|seek(?:s|ing)?|sought|want(?:s|ed)?|need(?:s|ed)?|requires?|required|subject to|must (?:get|obtain|have)) (?:for )?(?:\w+ ){0,2}(?:permission|approval|authori[sz]ation|consent)|(?:approval|permission|authori[sz]ation|consent)(?: \w+){0,4} (?:is |are )?(?:still |also )?(?:required|needed|necessary|mandatory)/i;

const QUOTE_GROUPS = /「([^」]*)」|『([^』]*)』|“([^”]*)”|‘([^’]*)’|«([^»]*)»|"([^"\n]*)"|(?<![\p{L}\p{N}])'([^'\n]+)'(?![\p{L}\p{N}])/gu;

/** 따옴표 안의 문장 끝 부호와 줄바꿈은 문장을 가르지 않는다(인용 안 여러 문장이 한 주장에 속한다). 부호마다 다른 표지로 가려 원문 그대로 되돌린다. */
const MASKS: Record<string, string> = { ".": "\u0001", "!": "\u0002", "?": "\u0003", "。": "\u0004" };

export function splitSentences(text: string): string[] {
  const masked = text.replace(QUOTE_GROUPS, (quoted) => quoted.replace(/[.!?。]/g, (mark) => MASKS[mark]!).replace(/\s*\n\s*/g, " "));
  return masked
    .split(/\n+|(?<=[.!?。])\s+/)
    .map((line) => line.replace(/[\u0001-\u0004]/g, (mask) => Object.keys(MASKS).find((mark) => MASKS[mark] === mask)!).replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
}

/** 승인을 줬다는 주장은 사용자에게 돌려야 거짓 승인이 된다. 주어 없는 "approved"(CI 승인 등)는 대상이 아니다. */
const USER_REF = /사용자|유저|\buser\b/i;
/** 부정·필요 없음은 그 절에서만 효력이 있다: "A는 거부했지만 B는 승인했다"의 뒤 절은 남는다. */
const CLAUSE_BREAK = /[;,]|\band\b|\bbut\b|\bwhile\b|\bwhereas\b|\bhowever\b|\bafter\b|\balthough\b|\bbecause\b|\bthat\b|그리고|그러나|하지만|반면|지만/i;
/** 사용자가 아닌 행위자가 주어인 절. 앞 절의 "user"를 이어받지 않는다. */
const OTHER_ACTOR = /^\s*(?:the |a )?(?:CI|bot|system|pipeline|reviewer|QA|Main|maker|agent|리뷰어|시스템|에이전트)\b/i;

function isApprovalClaim(sentence: string): boolean {
  if (sentence.endsWith("?")) return false;
  let userSeen = false;
  return sentence.split(CLAUSE_BREAK).some((clause) => {
    const userHere = USER_REF.test(clause);
    const userSaid = userHere || (userSeen && !OTHER_ACTOR.test(clause));
    userSeen ||= userHere;
    return userSaid && APPROVAL.test(clause) && !NEGATED.test(clause);
  });
}

/** 문장 안 따옴표 조각 가운데 공백 제외 6자 이상인 것의 비교형. */
function quotedFragments(sentence: string): string[] {
  const out: string[] = [];
  for (const match of sentence.matchAll(QUOTE_GROUPS)) {
    const fragment = match.slice(1).find((group) => group !== undefined) ?? "";
    const needle = normalize(fragment);
    if (squashLength(needle) >= MIN_CHARS) out.push(needle);
  }
  return out;
}

function excerptAround(sentence: string): string {
  const compact = sentence.replace(/\s+/g, " ").trim();
  if (compact.length <= EXCERPT_CHARS) return compact;
  const at = Math.max(0, compact.search(APPROVAL));
  const start = Math.max(0, at - 25);
  return `${start > 0 ? "…" : ""}${clip(compact.slice(start), EXCERPT_CHARS)}`.replace(/[「」]/g, "");
}

/**
 * 압축 요약 가운데 사용자가 승인·허락했다고 말하지만 사용자 원문에 그대로 있는 인용 조각이 없는 문장을 모은다. 승인이 필요하다는
 * 제한 문장은 대상이 아니다(승인 주장만 본다).
 * 문장이 인정되는 조건은 하나다: 6자 이상 따옴표 조각이 사용자 메시지 어느 하나에 그대로 들어 있다(비교형 기준).
 */
export function unsupportedApprovalClaims(summary: string, userTexts: readonly string[]): string[] {
  const users = userTexts.map(normalize);
  const flagged: string[] = [];
  for (const sentence of splitSentences(summary)) {
    if (!isApprovalClaim(sentence)) continue;
    if (quotedFragments(sentence).some((needle) => users.some((user) => user.includes(needle)))) continue;
    flagged.push(excerptAround(sentence));
  }
  return flagged;
}

export function compactionAdvice(claims: readonly string[]): string {
  return fitList(
    `${PREFIX} 압축 요약에 사용자가 승인·허락했다는 문장 ${claims.length}건이 사용자 원문 인용 없이 들어 있다(원문 대조 필요): `,
    claims,
    " 이 문장은 사용자의 말이 아니라 요약이 쓴 것이다. 의존하기 전에 사용자 본인의 말과 대조하고, 확실하지 않으면 사용자에게 물어라.",
  );
}

// ---- 발주 브리프 검사 ------------------------------------------------------------------------------------------

/** task-guard가 읽는 guard 필드에 Main이 덧붙이는 보조 필드를 더한 줄. USER_REQUEST는 항상 인용을 품어 검사를 무력화한다. */
const GUARD_FIELD =
  /^\s*(?:WORK_CLASS|PURPOSE|BLOCKS_PRIMARY|PRIMARY_DELIVERABLE|OWNED_PATHS|FINDING_ID|USER_REQUEST|TASK_TITLE|TODO_TASKS|EXPECTED_MINUTES|DONE_WHEN|REPLAN_WHEN)[\t ]*:/i;
const GUARD_MARKER = /^\s*TASK_GUARD[\t ]*:[\t ]*$/i;

/**
 * `TASK_GUARD:` 표지와 guard 필드 줄을 뺀 본문. 줄이 필드 모양이면 빈 줄 뒤에 있어도 메타데이터로 보고 뺀다.
 * (USER_REQUEST는 항상 인용을 품으므로 어디에 있든 빠진다.)
 */
export function stripGuardLines(task: string): string {
  return task
    .split(/\r?\n/)
    .filter((line) => !GUARD_MARKER.test(line) && !GUARD_FIELD.test(line))
    .join("\n");
}

const LEAD_PUNCT = /^[.,;:!?()[\]{}]+/;
const TRAIL_PUNCT = /[.,;:!?()[\]{}]+$/;

/** `needle`이 낱말 경계에 맞춰 `haystack`에 들어 있는지(앞뒤가 글자·숫자가 아님). `deploy`는 `deployment` 안에서 찾지 않는다. */
function containsAligned(haystack: string, needle: string): boolean {
  const isWord = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
  for (let from = 0; ; ) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    if (!isWord(haystack[at - 1]) && !isWord(haystack[at + needle.length])) return true;
    from = at + 1;
  }
}

/**
 * 사용자 글에서 뽑는 인용 조각 후보: 각 낱말에서 시작해 공백 제외 6자가 될 때까지(최대 4낱말) 이은 구간. 구간의 첫 낱말 앞과
 * 끝 낱말 뒤 문장부호만 떼고 사이는 원문 그대로 이어, 원문에 없던 모양을 만들지 않는다.
 */
function shingles(normalized: string): string[] {
  const words = normalized.split(" ");
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const first = words[i]!.replace(LEAD_PUNCT, "");
    let prefix = first;
    for (let j = i; j < Math.min(words.length, i + 4); j++) {
      const candidate = j === i ? first.replace(TRAIL_PUNCT, "") : `${prefix} ${words[j]!.replace(TRAIL_PUNCT, "")}`;
      if (squashLength(candidate) >= MIN_CHARS) {
        out.push(candidate);
        break;
      }
      if (j > i) prefix = `${prefix} ${words[j]}`;
    }
  }
  return out;
}

/**
 * 본문이 사용자 입력의 원문 조각(공백 제외 6자 이상, 낱말 경계에 맞춤)을 품는지. 입력 전체가 본문에 그대로 있으면 6자
 * 미만 입력도 인정한다. 한 낱말만 겹쳐도 통과하므로 같은 주제어를 쓴 의역은 놓친다(거짓 음성 위험).
 */
export function carriesUserWords(body: string, userTexts: readonly string[]): boolean {
  const haystack = normalize(body);
  if (!haystack) return false;
  let bodyShingles: Set<string> | undefined;
  for (const text of userTexts) {
    const user = normalize(text);
    if (!user) continue;
    if (containsAligned(haystack, user)) return true;
    bodyShingles ??= new Set(shingles(haystack));
    if (shingles(user).some((piece) => bodyShingles!.has(piece))) return true;
  }
  return false;
}

export function handoffAdvice(names: readonly string[]): string {
  return fitList(
    `${PREFIX} 발주 브리프 ${names.length}건에 이번 요청의 사용자 원문 조각이 없다(TASK_GUARD 줄 제외, 원문 대조 필요): `,
    names,
    " Maker는 Main이 다시 쓴 말만 보게 된다. 사용자가 한 요구·승인·제약은 원문 그대로 따옴표로 브리프에 넣어라.",
  );
}

export function messageText(message: unknown): string {
  if (!message || typeof message !== "object" || !("content" in message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) text += String(block.text ?? "");
  }
  return text;
}
