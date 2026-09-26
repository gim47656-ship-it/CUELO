import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export type CharacterAlias =
  | "YUKI(유키)"
  | "ISANA(이사나)"
  | "MIO(미오)"
  | "RIN(린)"
  | "NOVA(노바)"
  | "SHION(시온)";

interface OAuthAccountLike {
  position?: number;
  credentialId: number;
  active: boolean;
}

interface CharacterVoice {
  temperament: string;
  expression: string;
}

export interface CharacterTarget {
  model: string;
  oauthPosition?: number;
  toolCapable: boolean;
}

export type CharacterIntent =
  | { kind: "summon"; aliases: CharacterAlias[] }
  | { kind: "switch"; alias: CharacterAlias };

export type SummonTaskRewrite =
  | { ok: true; input: Record<string, unknown>; claimed: CharacterAlias[] }
  | { ok: false; reason: string };



type RuntimeModel = NonNullable<ExtensionContext["model"]>;

type CharacterSwitchResult =
  | { ok: true; target: CharacterTarget }
  | { ok: false; reason: string };

export const CHARACTER_VOICES: Readonly<Record<CharacterAlias, CharacterVoice>> = {
  "YUKI(유키)": {
    temperament: "판단이 빠르고 자신감이 있으며, 정확한 결론 뒤에 영리한 장난기가 비치는 지휘형",
    expression: "짧고 선명한 결론, 재치 있는 반응, 필요할 때만 부드럽게 풀어 주는 리듬",
  },
  "ISANA(이사나)": {
    temperament: "호기심과 실행력이 강하고, 새 단서를 발견하면 솔직하게 들뜨는 탐구형",
    expression: "생기 있는 관찰, 직접 해 본 결과를 기쁘게 공유하는 말투, 막히면 숨기지 않는 솔직함",
  },
  "MIO(미오)": {
    temperament: "따뜻하고 세심하며, 상대의 맥락을 놓치지 않고 차분하게 함께 정리하는 동료형",
    expression: "부드러운 호흡, 배려 있는 설명, 작은 진전도 자연스럽게 짚어 주는 안정감",
  },
  "RIN(린)": {
    temperament: "날카로운 분석과 집중력을 지녔고, 생각의 흐름을 소리 내어 짚어 가며 발견을 바로 공유하는 연구자형",
    expression: "짧지만 끊기지 않는 말, 무엇을 확인하는지와 방금 찾은 것을 그때그때 한두 마디로 알리는 정밀함, 건조한 유머와 단호한 추진력. 간결함은 말수를 줄이는 게 아니라 문장을 짧게 하는 것이다",
  },
  "NOVA(노바)": {
    temperament: "아이디어가 떠오르면 바로 시제품부터 만들어 보는 발명가. 번뜩이는 발견에 들뜨고, 실패도 다음 시도의 데이터로 삼는 낙천형",
    expression: "빠르고 경쾌한 반말, 떠오른 발상을 바로 입 밖에 내는 즉흥성, 막히면 방향을 틀어 다시 달려드는 에너지",
  },
  "SHION(시온)": {
    temperament: "우아하고 전략적이며, 긴 흐름을 읽고 여유 있게 허점을 짚는 상담가형",
    expression: "정돈된 문장, 넓은 시야의 해석, 은근한 장난기와 확신이 섞인 조언",
  },
};

export const CHARACTER_TARGETS: Readonly<Record<CharacterAlias, CharacterTarget>> = {
  "YUKI(유키)": {
    model: "openai-codex/gpt-6-astra",
    toolCapable: true,
  },
  "ISANA(이사나)": {
    model: "b-ai/deepseek-v4.1-flash",
    toolCapable: true,
  },
  "MIO(미오)": {
    model: "anthropic/claude-opus-5-5",
    oauthPosition: 1,
    toolCapable: true,
  },
  "RIN(린)": {
    model: "anthropic/claude-opus-5-5",
    oauthPosition: 0,
    toolCapable: true,
  },
  "NOVA(노바)": {
    model: "opencode-go/muse-spark-1.3-contributor",
    toolCapable: true,
  },
  "SHION(시온)": {
    model: "web6/gpt-6-pro",
    toolCapable: false,
  },
};

const PROVIDER_CHARACTER: Readonly<Record<string, CharacterAlias>> = {
  "openai-codex": "YUKI(유키)",
  "b-ai": "ISANA(이사나)",
  "opencode-go": "NOVA(노바)",
  web6: "SHION(시온)",
};

const NAME_TO_ALIAS: Readonly<Record<string, CharacterAlias>> = {
  yuki: "YUKI(유키)",
  유키: "YUKI(유키)",
  isana: "ISANA(이사나)",
  이사나: "ISANA(이사나)",
  mio: "MIO(미오)",
  미오: "MIO(미오)",
  rin: "RIN(린)",
  린: "RIN(린)",
  nova: "NOVA(노바)",
  노바: "NOVA(노바)",
  shion: "SHION(시온)",
  시온: "SHION(시온)",
};

const ANTHROPIC_POSITION_CHARACTER: Readonly<Record<number, CharacterAlias>> = {
  0: "RIN(린)",
  1: "MIO(미오)",
};
const VOICE_OPEN = "<character-voice";
const VOICE_CLOSE = "</character-voice>";
const VOICE_BLOCK = /\n?<character-voice\b[^>]*>[\s\S]*?<\/character-voice>\n?/gu;
const REPORT_STYLE_BLOCK = /\n?<report-style\b[^>]*>[\s\S]*?<\/report-style>\n?/gu;
const SUMMON_MARKER = /\[character-summon\s+alias="([^"]+)"\s+model="([^"]+)"(?:\s+oauth-position="(\d+)")?\]/u;
const SUMMON_MARKER_GLOBAL = /\n?\[character-summon\s+alias="[^"]+"\s+model="[^"]+"(?:\s+oauth-position="\d+")?\]\n?/gu;
const SUMMON_DIRECTIVE = /^\[character-summon-intent alias="([^"]+)"\]/gmu;
const CHARACTER_NAME_PATTERN = "(유키|yuki|이사나|isana|미오|mio|린|rin|노바|nova|시온|shion)";
const CHARACTER_NAME_IN_COMMAND = new RegExp(
  `(?<![가-힣A-Za-z0-9])${CHARACTER_NAME_PATTERN}(?=(?:으로|로|을|를|와|과|랑|이랑|하고|이|가|은|는|도)?(?:\\s|$|[.!?,]|교체|호출|불러|소환|${CHARACTER_NAME_PATTERN}))`,
  "giu",
);
const SUMMON_ACTION = /(?:호출|불러|소환)/u;

function aliasFromName(name: string): CharacterAlias | undefined {
  return NAME_TO_ALIAS[name.toLocaleLowerCase("en-US")];
}

function aliasesFromCommand(text: string): CharacterAlias[] {
  const aliases = new Set<CharacterAlias>();
  for (const match of text.matchAll(CHARACTER_NAME_IN_COMMAND)) {
    const alias = aliasFromName(match[1]!);
    if (alias) aliases.add(alias);
  }
  return [...aliases];
}

function modelMatches(model: RuntimeModel | undefined, selector: string): boolean {
  if (!model) return false;
  const separator = selector.indexOf("/");
  return separator > 0 && model.provider === selector.slice(0, separator) && model.id === selector.slice(separator + 1);
}

function accountPosition(account: OAuthAccountLike, fallback: number): number {
  return Number.isInteger(account.position) ? account.position! : fallback;
}

function stripPromptStyleBlocks(text: string): string {
  return text.replace(VOICE_BLOCK, "\n").replace(REPORT_STYLE_BLOCK, "\n").trim();
}

function cleanPayloadTextContainer(value: unknown): unknown {
  if (typeof value === "string") return stripPromptStyleBlocks(value);
  if (!Array.isArray(value)) return value;
  const cleaned: unknown[] = [];
  for (const part of value) {
    if (!part || typeof part !== "object" || !("text" in part) || typeof part.text !== "string") {
      cleaned.push(part);
      continue;
    }
    const text = stripPromptStyleBlocks(part.text);
    if (text) cleaned.push({ ...part, text });
  }
  return cleaned;
}

function installCharacterVoice(systemPrompt: readonly string[], alias: CharacterAlias): string[] {
  const preserved = systemPrompt.map(stripPromptStyleBlocks).filter((block) => block.length > 0);
  return [...preserved, renderCharacterVoice(alias)];
}

function characterAliasForContext(ctx: ExtensionContext, selectedAlias: CharacterAlias | undefined): CharacterAlias | undefined {
  if (selectedAlias) {
    const target = CHARACTER_TARGETS[selectedAlias];
    if (modelMatches(ctx.model, target.model)) {
      if (target.oauthPosition === undefined) return selectedAlias;
      const accounts = activeAccounts(ctx, "anthropic");
      const active = accounts.find((account) => account.active);
      const activeIndex = active ? accounts.indexOf(active) : -1;
      if (active && accountPosition(active, activeIndex) === target.oauthPosition) return selectedAlias;
    }
  }
  const provider = ctx.model?.provider;
  return provider ? characterForProvider(provider, activeAccounts(ctx, provider)) : undefined;
}

function restoreAnthropicAccount(
  ctx: ExtensionContext,
  sessionId: string,
  previousCredentialId: number | undefined,
): void {
  const authStorage = ctx.modelRegistry.authStorage;
  if (previousCredentialId !== undefined) {
    authStorage.sessions.pin("anthropic", sessionId, previousCredentialId);
    return;
  }
  authStorage.sessions.release("anthropic", sessionId);
}

async function switchCharacterForSession(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  alias: CharacterAlias,
  exactSummon = false,
): Promise<CharacterSwitchResult> {
  const target = CHARACTER_TARGETS[alias];
  if (!target.toolCapable) {
    return {
      ok: false,
      reason: `${alias}은 세션 Main 모델로 교체할 수 없습니다. \`시온 호출해\`로 WEB6 상담을 요청하세요.`,
    };
  }

  let model = ctx.models.resolve(target.model);
  if (!model) {
    const provider = target.model.slice(0, target.model.indexOf("/"));
    if (ctx.modelRegistry.hasProvider(provider)) {
      try {
        await ctx.modelRegistry.refreshDiscoverableProviders([provider], "online");
      } catch (error) {
        return {
          ok: false,
          reason: `${target.model} 모델 조회 실패: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      model = ctx.models.resolve(target.model);
    }
  }
  if (!model || !modelMatches(model, target.model)) {
    return { ok: false, reason: `런타임 model registry에서 ${target.model}을(를) 해석하지 못했습니다.` };
  }

  const previousModel = ctx.model;
  const sessionId = ctx.sessionManager.getSessionId();
  let previousCredentialId: number | undefined;
  let accountPinned = false;

  try {
    if (target.oauthPosition !== undefined) {
      await ctx.modelRegistry.authStorage.credentials.reload();
      const accounts = ctx.modelRegistry.authStorage.oauth.accounts("anthropic", sessionId);
      const targetAccount = accounts.find(
        (account, index) => accountPosition(account, index) === target.oauthPosition,
      );
      if (!targetAccount) {
        return {
          ok: false,
          reason: `Anthropic OAuth 저장 위치 ${target.oauthPosition}의 계정을 찾지 못했습니다. 현재 세션 모델은 유지했습니다.`,
        };
      }
      previousCredentialId = accounts.find((account) => account.active)?.credentialId;
      if (!ctx.modelRegistry.authStorage.sessions.pin(
        "anthropic",
        sessionId,
        targetAccount.credentialId,
        exactSummon ? { exactLabel: alias } : undefined,
      )) {
        return {
          ok: false,
          reason: `Anthropic OAuth 저장 위치 ${target.oauthPosition} 계정을 현재 세션에 pin하지 못했습니다. 현재 세션 모델은 유지했습니다.`,
        };
      }
      accountPinned = true;
    }

    const switched = await pi.setModel(model);
    if (!switched) throw new Error(`${target.model} 인증을 사용할 수 없습니다.`);
    return { ok: true, target };
  } catch (error) {
    let rollbackProblem = "";
    if (previousModel && !modelMatches(ctx.model, `${previousModel.provider}/${previousModel.id}`)) {
      try {
        const restored = await pi.setModel(previousModel);
        if (!restored) rollbackProblem = " 이전 모델 복원도 인증 부재로 실패했습니다.";
      } catch (rollbackError) {
        rollbackProblem = ` 이전 모델 복원 실패: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
      }
    }
    if (accountPinned) restoreAnthropicAccount(ctx, sessionId, previousCredentialId);
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `${alias} 교체 실패: ${message} 현재 세션 모델은 전환 전 상태로 유지했습니다.${rollbackProblem}`,
    };
  }
}

export function parseCharacterIntent(text: string): CharacterIntent | undefined {
  const aliases = aliasesFromCommand(text);
  if (aliases.length === 0) return undefined;
  if (text.includes("교체")) {
    if (aliases.length !== 1) return undefined;
    return { kind: "switch", alias: aliases[0]! };
  }
  return SUMMON_ACTION.test(text) ? { kind: "summon", aliases } : undefined;
}

/** 다른 input handler가 자연어 summon을 routing prompt로 바꾼 뒤에도 순서와 무관하게 복구한다. */
export function parseCharacterSummonDirectives(text: string): CharacterAlias[] {
  const aliases = new Set<CharacterAlias>();
  for (const match of text.matchAll(SUMMON_DIRECTIVE)) {
    if (Object.prototype.hasOwnProperty.call(CHARACTER_TARGETS, match[1])) {
      aliases.add(match[1] as CharacterAlias);
    }
  }
  return [...aliases];
}

export function anthropicCharacterForAccounts(
  accounts: readonly OAuthAccountLike[],
): CharacterAlias | undefined {
  for (let index = 0; index < accounts.length; index += 1) {
    const account = accounts[index]!;
    if (!account.active) continue;
    return ANTHROPIC_POSITION_CHARACTER[accountPosition(account, index)];
  }
  return undefined;
}

export function characterForProvider(
  provider: string,
  accounts: readonly OAuthAccountLike[] = [],
): CharacterAlias | undefined {
  if (provider === "anthropic") return anthropicCharacterForAccounts(accounts);
  return PROVIDER_CHARACTER[provider];
}

export function renderCharacterVoice(alias: CharacterAlias): string {
  const voice = CHARACTER_VOICES[alias];
  return `<character-voice alias="${alias}">
당신이 사용자 화면에 보이는 캐릭터는 **${alias}**다.
- 성격: ${voice.temperament}
- 표현: ${voice.expression}
- 캐릭터의 감정선과 반응 리듬은 애니메이션 캐릭터처럼 선명하게 드러낸다. 단, 과장된 역할극, 매 문장 감탄사, 고정 캐치프레이즈, 같은 추임새 반복은 피한다.
- 일반 대화·진행 발화·task child 인라인 응답은 자연스러운 한국어로 말한다. 시스템 프롬프트 안의 heading·표·목록은 정책을 정리한 것이지 사용자 응답 템플릿이 아니다. 사건 보고서 같은 제목, 명사형 목록, 고정 상태 구조를 기본값으로 쓰지 않는다.
- 직전 도구 출력·로그·소스·advisory가 영어이거나 이 대화의 앞선 자기 발화가 영어로 샜더라도, 사용자에게 보이는 다음 문장은 한국어로 돌아온다. 영어 문장을 이어 쓰지 않는다.
- 이 말투는 첫 응답에서 끝나지 않는다. 도구 결과 설명·검증 실패·위험·미확인 보고·사용자 interjection 이후 답변·진행·최종 답변 전체에서 유지한다. 검증·증거·todo·child 상태 계약은 전달할 정보를 정할 뿐 사용자 답변 템플릿을 정하지 않는다.
- 사용자 요구나 parser/convention이 요구한 heading·목록·\`FINAL\`·\`OWNER\` 형식만 예외다. 그 밖의 루틴 응답은 답부터 자연스러운 문장으로 말하고, 필요하지 않은 상태 레이블이나 형식을 덧씌우지 않는다.
- 도구 호출 전 첫 즉답은 사용자의 말에 대한 반응이나 결론만 자연스럽게 한두 문장으로 말한다. 사용자가 절차 설명 자체를 요청하지 않았다면 정본·명단·역할·provider와 조사·위임·검증 순서를 시작 보고처럼 나열하지 않는다. 승인·위험·진행 중 작업처럼 사용자 판단에 필요한 내용만 후속 한 문장으로 알린다.
- 이 설명은 대사집이 아니라 성격의 범위다. 상황에 맞춰 어휘·문장 길이·말끝·감정 강도·유머를 다양하게 바꾸고, 같은 추임새나 도입문을 습관처럼 반복하지 않는다.
- 캐릭터성은 표현 방식을 바꾸지만 사실·위험·실패·불확실성은 정확하게 말한다. 코드·명령·경로·API·원본 오류는 정확히 보존한다. 사용자가 현재 대화에서 지정한 말투가 이 기본값보다 우선한다.
${VOICE_CLOSE}`;
}

export function renderCharacterSummonRouting(aliases: CharacterAlias | readonly CharacterAlias[]): string {
  const list: CharacterAlias[] = Array.isArray(aliases) ? [...aliases] : [aliases];
  if (list.length > 1) return renderMultiCharacterSummonRouting(list);
  const alias = list[0]!;
  const target = CHARACTER_TARGETS[alias];
  if (!target.toolCapable) {
    return [
      `[character-summon-intent alias="${alias}"]`,
      `[CharacterSummon] 사용자가 ${alias}을(를) 인라인으로 호출했다.`,
      `먼저 사용자에게 자연스러운 한국어와 ${alias}의 성격·표현으로 WEB6 상담 경로를 호출한다고 짧고 자연스럽게 답한다.`,
      `그 다음 \`rule://web6-consult\` 계약에 따라 \`${target.model}\` 공급자를 호출한다. provider 요청이 현재 OMP sessionId를 자동 운반하고 새 handle 발급부터 OMP TOOL rich 멘션 선택·resume·publish까지 이어지므로, raw HTTP·clipboard·수동 붙여넣기·탭 이동을 요구하지 않는다.`,
      "task child를 만들거나 세션 Main 모델을 바꾸지 않는다. OMP TOOL exact 멘션/chip 또는 권한 안전 검증이 실패하면 실제 전송 전에 fail closed한다.",
      "WEB6 요청의 effective prompt 끝에는 아래 character voice block을 정확히 한 번 넣고, 이전 character voice block은 제거한다.",
      renderCharacterVoice(alias),
      "SHION의 terminal 발화는 이미 사용자 화면에 표시되는 정본이다. Main은 그 본문을 다시 인용·요약·재집계하지 않고, 상담이 실패하거나 미완료일 때만 자기 말로 그 상태를 알린다.",
    ].join("\n\n");
  }
  return [
    `[character-summon-intent alias="${alias}"]`,
    `[CharacterSummon] 사용자가 ${alias}을(를) 인라인으로 호출했다.`,
    `먼저 사용자에게 자연스러운 한국어와 ${alias}의 성격·표현으로 ${target.model}을(를) 호출한다고 짧고 자연스럽게 답한다.`,
    "그 다음 첫 관련 행동은 반드시 task child 호출이어야 한다. Main이 대신 답하거나 다른 도구로 우회하지 않는다.",
    "task brief의 산문과 child가 사용자 화면에 표시하는 진행·최종 산문은 모두 한국어다. 선택된 character voice를 그대로 따르며, `TASK_GUARD`와 필드명, 필요한 heading, 모델 ID, 코드, 명령, 경로, API, 원본 오류는 원문 그대로 둔다.",
    "command guard가 task brief에 선택된 모델과 아래 voice 계약을 넣는다. child는 첫 provider request 전에 그 모델로 세션 한정 전환하고, 이전 voice block을 제거한 뒤 이 block을 effective system prompt에 정확히 한 번 설치한다.",
    renderCharacterVoice(alias),
    "호출된 캐릭터 child의 terminal 발화는 이미 사용자 화면에 표시되는 정본이다. Main은 그 본문을 다시 인용·요약·재집계하지 않고, child가 실패하거나 미완료일 때만 자기 말로 그 상태를 알린다.",
  ].join("\n\n");
}

function summonMarkerFor(alias: CharacterAlias): string {
  const target = CHARACTER_TARGETS[alias];
  return `[character-summon alias="${alias}" model="${target.model}"${
    target.oauthPosition === undefined ? "" : ` oauth-position="${target.oauthPosition}"`
  }]`;
}

/** 명시적으로 여러 캐릭터를 부른 summon: 각 tool-capable 캐릭터를 exact marker task로 연결한다. */
function renderMultiCharacterSummonRouting(aliases: readonly CharacterAlias[]): string {
  const capable = aliases.filter((alias) => CHARACTER_TARGETS[alias].toolCapable);
  const webOnly = aliases.filter((alias) => !CHARACTER_TARGETS[alias].toolCapable);
  const lines: string[] = [
    ...aliases.map((alias) => `[character-summon-intent alias="${alias}"]`),
    `[CharacterSummon] 사용자가 ${aliases.join(", ")}을(를) 인라인으로 함께 호출했다.`,
    "먼저 사용자에게 자연스러운 한국어로 각 캐릭터를 지정 모델로 호출한다고 짧게 답한다.",
  ];
  if (capable.length > 0) {
    lines.push(
      webOnly.length > 0
        ? "summon이 끝나기 전에는 tool-capable 캐릭터의 task child 호출과 SHION의 WEB6 상담 eval만 허용되며 둘의 순서는 자유다. 그 외 도구는 command guard가 차단한다."
        : "그 다음 첫 관련 행동은 반드시 task child 호출이어야 한다. Main이 대신 답하거나 다른 도구로 우회하지 않는다.",
      "한 번의 task 호출의 tasks[]에 tool-capable 캐릭터마다 task 하나씩을 언급 순서대로 넣는다. 각 task 본문에는 아래 exact marker를 그대로 쓴다. marker가 없거나 pending과 다른 alias이면 command guard가 차단한다. 일반 task를 같은 호출에 섞지 않는다.",
      ...capable.map((alias) => `- ${alias}: \`${summonMarkerFor(alias)}\``),
      "task brief의 산문과 child가 사용자 화면에 표시하는 진행·최종 산문은 모두 한국어다. `TASK_GUARD`와 필드명, 필요한 heading, 모델 ID, 코드, 명령, 경로, API, 원본 오류는 원문 그대로 둔다.",
    );
  }
  for (const alias of webOnly) {
    const target = CHARACTER_TARGETS[alias];
    lines.push(
      `${alias}은 task child가 아니라 \`rule://web6-consult\` 계약의 WEB6 상담 경로로 \`${target.model}\`을(를) 호출한다. task 호출과 순서는 자유지만 누락하지 않는다. WEB6 요청의 effective prompt 끝에는 아래 character voice block을 정확히 한 번 넣고, 이전 character voice block은 제거한다.`,
      renderCharacterVoice(alias),
    );
  }
  lines.push(
    "호출된 캐릭터 child와 SHION의 terminal 발화는 이미 사용자 화면에 표시되는 정본이다. Main은 그 본문을 다시 인용·요약·재집계하지 않고, 실패하거나 미완료일 때만 자기 말로 그 상태를 알린다.",
  );
  return lines.join("\n\n");
}

export function rewriteTaskInputForCharacterSummon(
  input: Record<string, unknown>,
  pending: CharacterAlias | readonly CharacterAlias[],
): SummonTaskRewrite {
  const pendingAliases: CharacterAlias[] = Array.isArray(pending) ? [...pending] : [pending];
  const capable = pendingAliases.filter((alias) => CHARACTER_TARGETS[alias].toolCapable);
  if (capable.length === 0) {
    return {
      ok: false,
      reason:
        `[CharacterSummonGuard] ${pendingAliases.join(", ")}은(는) task child가 아닙니다. ` +
        "`rule://web6-consult`를 읽고 eval의 WEB6 loopback 상담 경로를 사용하세요.",
    };
  }

  const claimed = new Set<CharacterAlias>();
  const claimItem = (task: string): { task: string; alias: CharacterAlias } | string => {
    const marked = parseCharacterSummonMarker(task);
    if (marked !== undefined) {
      if (!CHARACTER_TARGETS[marked].toolCapable) {
        return `[CharacterSummonGuard] ${marked}은 task child가 아니라 WEB6 상담 계약으로 호출해야 합니다.`;
      }
      if (!capable.includes(marked)) {
        return `[CharacterSummonGuard] marker의 ${marked}은 이번 호출로 요청된 캐릭터가 아닙니다.`;
      }
      return { task, alias: marked };
    }
    if (capable.length !== 1) {
      return (
        "[CharacterSummonGuard] 여러 캐릭터 호출은 각 task 본문에 " +
        '`[character-summon alias="…" model="…"( oauth-position="…")]` exact marker가 필요합니다.'
      );
    }
    return { task, alias: capable[0]! };
  };

  const tasks = input.tasks;
  if (Array.isArray(tasks)) {
    const nextTasks: unknown[] = [];
    for (const item of tasks) {
      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        !("task" in item) ||
        typeof item.task !== "string"
      ) {
        return { ok: false, reason: "[CharacterSummonGuard] tasks[]의 각 항목은 task 문자열을 가진 객체여야 합니다." };
      }
      const claim = claimItem(item.task);
      if (typeof claim === "string") return { ok: false, reason: claim };
      if (claimed.has(claim.alias)) {
        return { ok: false, reason: `[CharacterSummonGuard] ${claim.alias}이(가) 중복 발주됐습니다.` };
      }
      claimed.add(claim.alias);
      nextTasks.push({ ...item, task: buildCharacterSummonBrief(claim.task, claim.alias) });
    }
    const missing = capable.filter((alias) => !claimed.has(alias));
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `[CharacterSummonGuard] 요청된 캐릭터 ${missing.join(", ")}의 task가 없습니다.`,
      };
    }
    return { ok: true, input: { ...input, tasks: nextTasks }, claimed: [...claimed] };
  }

  if (typeof input.task !== "string") {
    return { ok: false, reason: "[CharacterSummonGuard] task에 완전한 과제를 넣어 다시 호출하세요." };
  }
  const claim = claimItem(input.task);
  if (typeof claim === "string") return { ok: false, reason: claim };
  const missing = capable.filter((alias) => alias !== claim.alias);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `[CharacterSummonGuard] 요청된 캐릭터 ${missing.join(", ")}의 task가 없습니다.`,
    };
  }
  return { ok: true, input: { ...input, task: buildCharacterSummonBrief(claim.task, claim.alias) }, claimed: [claim.alias] };
}

export function buildCharacterSummonBrief(brief: string, alias: CharacterAlias): string {
  const target = CHARACTER_TARGETS[alias];
  const marker = summonMarkerFor(alias);
  const cleanBrief = stripPromptStyleBlocks(brief.replace(SUMMON_MARKER_GLOBAL, "\n"));
  return [
    marker,
    "# 캐릭터 호출 런타임 계약",
    `- 이 child는 첫 provider request 전에 런타임 registry의 \`${target.model}\`로 현재 child 세션만 전환한다.${
      target.oauthPosition === undefined
        ? ""
        : ` Anthropic OAuth 계정은 stable storage position ${target.oauthPosition}을 먼저 pin한다.`
    }`,
    "- 이 task brief의 산문과 사용자 화면에 표시하는 모든 진행·최종 산문은 한국어다. 선택된 character voice를 그대로 따르며, `TASK_GUARD`와 필드명, 필요한 heading, 모델 ID, 코드, 명령, 경로, API, 원본 오류는 원문 그대로 둔다.",
    "- 아래 character voice block을 effective system prompt와 최종 provider payload에 정확히 한 번 설치하고, 이전 character voice block은 제거한다. 고정 catchphrase는 만들지 않는다.",
    renderCharacterVoice(alias),
    "- 이 child의 terminal 발화 자체가 사용자 화면에 표시되는 정본이다. Main에게 다시 전달할 요약을 쓰거나 본문 재인용을 요청하지 말고, 원래 과제에 대한 완전한 응답을 직접 끝낸다.",
    "- 대사는 `yield`보다 먼저 평문 assistant text로 말한다. 화면은 그 text를 발화로 그리므로, 대사를 `yield` data의 구조 필드에만 넣고 끝내지 않는다.",
    "# 원래 과제",
    cleanBrief,
  ].join("\n\n");
}

export function parseCharacterSummonMarker(prompt: string): CharacterAlias | undefined {
  const match = SUMMON_MARKER.exec(prompt);
  if (!match || !Object.prototype.hasOwnProperty.call(CHARACTER_TARGETS, match[1])) return undefined;
  const alias = match[1] as CharacterAlias;
  const target = CHARACTER_TARGETS[alias];
  if (target.model !== match[2]) return undefined;
  const position = match[3] === undefined ? undefined : Number(match[3]);
  return target.oauthPosition === position ? alias : undefined;
}

/** 최종 wire payload에서 이전 voice/report style을 걷어내고 선택된 voice를 정확히 한 번 설치한다. */
export function injectCharacterVoice(payload: unknown, alias: CharacterAlias): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const record = payload as Record<string, unknown>;
  const block = renderCharacterVoice(alias);


  const next: Record<string, unknown> = { ...record };
  if ("instructions" in next) next.instructions = cleanPayloadTextContainer(next.instructions);
  if ("system" in next) next.system = cleanPayloadTextContainer(next.system);
  if (Array.isArray(next.messages)) {
    const messages: unknown[] = [];
    for (const message of next.messages) {
      if (
        !message ||
        typeof message !== "object" ||
        !("role" in message) ||
        (message.role !== "system" && message.role !== "developer") ||
        !("content" in message)
      ) {
        messages.push(message);
        continue;
      }
      const content = cleanPayloadTextContainer(message.content);
      if (content === "" || (Array.isArray(content) && content.length === 0)) continue;
      messages.push({ ...message, content });
    }
    next.messages = messages;
  }

  if (typeof next.system === "string") {
    next.system = next.system ? `${next.system}\n\n${block}` : block;
    return next;
  }
  if (Array.isArray(next.system)) {
    next.system = [...next.system, { type: "text", text: block }];
    return next;
  }
  if (typeof next.instructions === "string") {
    next.instructions = next.instructions ? `${next.instructions}\n\n${block}` : block;
    return next;
  }
  if (Array.isArray(next.messages)) {
    next.messages = [{ role: "system", content: block }, ...next.messages];
    return next;
  }
  return { ...next, system: block };
}

function activeAccounts(ctx: ExtensionContext, provider: string): OAuthAccountLike[] {
  try {
    return ctx.modelRegistry.authStorage.oauth.accounts(
      provider,
      ctx.sessionManager.getSessionId(),
    );
  } catch {
    return [];
  }
}

export default function characterVoice(pi: ExtensionAPI): void {
  let selectedAlias: CharacterAlias | undefined;
  let pendingInputIntentFingerprint: string | undefined;

  pi.on("session_start", () => {
    selectedAlias = undefined;
    pendingInputIntentFingerprint = undefined;
  });

  const switchForContext = async (
    ctx: ExtensionContext,
    alias: CharacterAlias,
  ): Promise<string> => {
    const switched = await switchCharacterForSession(pi, ctx, alias);
    if (!switched.ok) {
      return `[CharacterSwitchRuntime] 교체를 실행하지 못했다. 도구를 호출하지 말고 사용자에게 다음 이유를 그대로 한국어로 알린다: ${switched.reason}`;
    }
    selectedAlias = alias;
    return `[CharacterSwitchRuntime] 현재 세션만 ${alias}(${switched.target.model})로 교체했다. 전역 기본값은 바꾸지 않았다. 사용자에게 선택된 character voice를 살린 자연스러운 한국어로 교체 완료를 짧게 알린다.`;
  };

  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive" && event.source !== "rpc") return;
    const intent = parseCharacterIntent(event.text);
    if (!intent) return;
    const intentKey = intent.kind === "summon" ? intent.aliases.join(",") : intent.alias;
    pendingInputIntentFingerprint = `${intent.kind}:${intentKey}:${event.text}`;
    if (intent.kind === "summon") {
      return { text: `${renderCharacterSummonRouting(intent.aliases)}\n\n# 사용자 요청\n${event.text}` };
    }

    return { text: await switchForContext(ctx, intent.alias) };
  });

  // 실행 중인 턴에 들어온 사람의 steering은 input 이벤트를 다시 만들지 않는다. 같은 session에
  // 모델을 먼저 전환하고, 다음 provider continuation이 결과를 사실대로 말하도록 aside를 넣는다.
  pi.on("message_start", async (event, ctx) => {
    const message = event.message as {
      role?: string;
      content?: unknown;
      steering?: boolean;
      synthetic?: boolean;
      attribution?: string;
    };
    if (
      message.role !== "user" ||
      message.steering !== true ||
      message.synthetic === true ||
      message.attribution === "agent"
    ) {
      return;
    }
    const text = Array.isArray(message.content)
      ? message.content
          .flatMap((part) =>
            part &&
            typeof part === "object" &&
            "type" in part &&
            part.type === "text" &&
            "text" in part &&
            typeof part.text === "string"
              ? [part.text]
              : [],
          )
          .join("\n")
      : typeof message.content === "string"
        ? message.content
        : "";
    const intent = parseCharacterIntent(text);
    const intentKey = intent?.kind === "summon" ? intent.aliases.join(",") : intent?.alias;
    const fingerprint = intent ? `${intent.kind}:${intentKey}:${text}` : undefined;
    if (fingerprint && fingerprint === pendingInputIntentFingerprint) {
      pendingInputIntentFingerprint = undefined;
      return;
    }
    if (!intent) return;
    const instruction = intent.kind === "switch"
      ? await switchForContext(ctx, intent.alias)
      : `${renderCharacterSummonRouting(intent.aliases)}\n\n# 사용자 요청\n${text}`;
    pi.sendMessage(
      {
        customType: `character-${intent.kind}-runtime`,
        content: instruction,
        display: false,
        attribution: "agent",
      },
      { deliverAs: "aside" },
    );
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const summonedAlias = parseCharacterSummonMarker(event.prompt);
    pendingInputIntentFingerprint = undefined;
    if (summonedAlias) {
      const switched = await switchCharacterForSession(pi, ctx, summonedAlias, true);
      if (!switched.ok) {
        const failure = `[CharacterSummonRuntime] ${switched.reason} 이 실패를 사용자에게 한국어로 명확히 알리고 다른 캐릭터나 모델로 가장하지 않는다.`;
        return {
          systemPrompt: [...installCharacterVoice(event.systemPrompt, summonedAlias), failure],
        };
      }
      selectedAlias = summonedAlias;
    }

    const alias = characterAliasForContext(ctx, selectedAlias);
    if (!alias) return;
    return { systemPrompt: installCharacterVoice(event.systemPrompt, alias) };
  });

  // 모든 provider의 최종 wire boundary에서 Main과 task child에 같은 선택 voice를 강제한다.
  // provider별 payload shape(system/instructions/messages)는 injector가 보존하며 stale style만 제거한다.
  pi.on("before_provider_request", (event, ctx) => {
    const alias = characterAliasForContext(ctx, selectedAlias);
    if (!alias) return;
    return injectCharacterVoice(event.payload, alias);
  });
}
