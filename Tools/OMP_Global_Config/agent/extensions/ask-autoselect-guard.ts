import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// Match explicit decision topics, not incidental words such as "model", "cost" or "account" alone.
// Words that also name ordinary code concepts (비용·계정·권한·공개·account·permission) count only next to an action.
const HIGH_IMPACT = /삭제|배포|결제|과금|구독|게시|승인|유료|요금|구매|구입|비용.{0,8}(?:지불|발생|들|청구|나가|쓸)|계정.{0,8}(?:사용|쓸|바꿀|바꾸|변경|전환|생성|만들|삭제|연결|로그인|고를|고르|선택)|어느\s*계정|권한.{0,8}(?:허용|부여|변경|요청|올리|줄|상승|승인)|공개\s*(?:저장소|게시|배포|여부|범위|전환)|외부\s*공개|[$₩€]\s?\d|\d[\d,.]*\s*(?:천|만|억)?\s*(?:달러|원(?![가-힣]|어치)|원어치|(?:usd|krw|dollars?)\b)|\b(?:delet(?:e|ion|ing)|deploy(?:ment|ing)?|payments?|purchas(?:e|ing)|approv(?:al|e)|consent|billing|subscriptions?|publish(?:ing)?|provider safety|paid (?:plan|tier)|(?:costs?|spend) money)\b|\b(?:create|delete|switch|change|link|log ?in to|sign in to)\b.{0,12}\baccounts?\b|\b(?:which|whose|my|your) accounts?\b(?!\s+(?:lookup|cache|helper|field|table|model|id)\b)|\b(?:grant|elevat|allow|request)\w*\b.{0,12}\bpermissions?\b/i;
const USER_DECISION = /원하는\s*결과|원하시는\s*결과|기대하는\s*결과|UI\s*(?:동작|행동)|사용자\s*경험|데이터\s*(?:처리|취급|보관|보존)|판정\s*기준|판단\s*기준|기능.{0,16}(?:유지|보호|제거|보존)|\b(?:desired (?:result|outcome)|expected outcome|UI behavio[ur]|user experience|data (?:handling|processing|retention)|judg(?:ment|ement) criteria|preserv(?:e|ing) (?:the )?(?:existing|current) \w+|keep(?:ing)? (?:existing )?features?)\b/i;
const MODEL_CHOICE = /모델\s*(?:선택|라우팅|배치)|모델.{0,32}(?:정할|정하|고를|고르|선택|쓸까|사용할|따르|고정)|\b(?:model (?:selection|choice|routing)|(?:choose|select|route|which)\b.{0,32}\b(?<!(?:data|view|object|domain) )models?)\b/i;
const PROVIDER = /모델|프로바이더|제공자|\b(?:model|provider|gemini|luna|hikari|claude|openai|anthropic|gpt|hive)\b/i;
const FALLBACK = /폴백|\bfallback\b|\bfall\s+back\b/i;
// AI 제공자를 고르는 질문(코드의 DI provider·registry는 제외), 모델 이름(버전 포함) 둘 이상을 놓고 고르는 질문,
// 같은 계열의 버전 선택, 한 모델로 바꾸거나 쓰자는 질문. 구분이 안 되는 말은 막는 쪽으로 둔다(오차단은 다시 묻기로 끝난다).
const PROVIDER_CHOICE = /(?:프로바이더|제공자|공급자).{0,16}(?:쓸|고를|고르|선택|정할|사용)|\b(?:which|choose|select)\b.{0,24}\bproviders?\b(?![^.?!]*\b(?:registry|dependency|injection|DI|context|mock)\b)/i;
const FAMILY = "(?:opus|sonnet|haiku|fable|sol|astra|terra|luna|argon|gemini|deepseek|glm|gpt|claude|codex)";
const MODEL_NAMES = /\b(?:opus|sonnet|haiku|fable|sol|astra|terra|luna|argon|gemini|deepseek|glm|gpt|claude|codex|openai|anthropic|hive|vertex)(?:[-\s]?\d+(?:\.\d+)*)?\b/gi;
const CHOICE_WORD = /어느|어떤|쓸까|할까|갈까|고를|고르|선택|정할|사용할|진행할|\b(?:which|choose|select|use|or|vs)\b/i;
const SWITCH_TO_MODEL = new RegExp([
  `\\b${FAMILY}\\b\\S*?(?:로|으로|를|을)\\s*(?:바꿀|바꾸|갈|할|진행|돌릴|쓸|사용할)`,
  `\\b(?:switch|change|move|go|revert)\\s+(?:back\\s+)?to\\s+${FAMILY}\\b`,
  `\\buse\\s+${FAMILY}\\b[^.?!]{0,24}\\binstead\\b`,
  `\\b${FAMILY}[-\\s]?\\d+(?:\\.\\d+)*\\S*\\s*(?:or|vs\\.?|아니면|(?:로|으로)\\s*할까)\\s*\\d+(?:\\.\\d+)*`,
].join("|"), "i");

function namesBothSides(text: string): boolean {
  const names = new Set((text.match(MODEL_NAMES) ?? []).map(name => name.toLowerCase().replace(/[-\s]/g, "")));
  return (names.size >= 2 && CHOICE_WORD.test(text)) || SWITCH_TO_MODEL.test(text);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decisionText(question: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof question.question === "string") parts.push(question.question);
  if (Array.isArray(question.options)) {
    for (const option of question.options) {
      if (!record(option)) continue;
      for (const key of ["label", "description", "preview"]) {
        if (typeof option[key] === "string") parts.push(option[key]);
      }
    }
  }
  return parts.join(" ");
}

export default function askAutoSelectGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", event => {
    if (event.toolName !== "ask" || !record(event.input) || !Array.isArray(event.input.questions)) return;
    for (const question of event.input.questions) {
      if (!record(question) || question.autoSelectRecommended !== true) continue;
      const text = decisionText(question);
      if (HIGH_IMPACT.test(text) || USER_DECISION.test(text) || MODEL_CHOICE.test(text) ||
          PROVIDER_CHOICE.test(text) || namesBothSides(text) || (PROVIDER.test(text) && FALLBACK.test(text))) {
        return {
          block: true,
          reason: "ask-autoselect-guard: 사용자 결정·승인 질문은 자동선택할 수 없다. 해당 질문의 autoSelectRecommended를 빼거나 false로 바꿔 다시 호출하라.",
        };
      }
    }
  });
}
