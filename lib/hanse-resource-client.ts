export const HANSE_RESOURCE_ORIGIN = "/api/sidecars/resource";
export const USAGE_POLL_INTERVAL_MS = 60_000;
export const MODEL_REQUEST_TIMEOUT_MS = 120_000;
export const CREDENTIAL_ACTION_TIMEOUT_MS = 20_000;
export const ACCOUNT_STATE_POLL_INTERVAL_MS = 2_500;

export type ResourceLoadState<T> =
  | { status: "fresh"; data: T; error: null }
  | { status: "stale"; data: T; error: ResourceClientError }
  | { status: "error"; data: null; error: ResourceClientError };

/**
 * 리셋 시각에서 24시간씩 거꾸로 센 구간의 실측. 사이드카가 남긴 표본에서 나오며, 표본이
 * 없으면 숫자를 지어내지 않고 `unknown` 으로 온다. 하루 이하 창은 창 자체가 구간이라
 * 이 값이 아예 오지 않는다.
 */
export interface UsageDaySlot {
  slotStart: number;
  slotEnd: number;
  slotIndex: number;
  slotCount: number;
  slotsLeft: number;
  /** 구간 시작 시점의 누적 사용률(%). 기록이 없으면 null. */
  baselinePct: number | null;
  /** 이 구간에서 실제로 쓴 양(%). 기록이 없으면 null. */
  usedPct: number | null;
  /** 창을 구간 수로 나눈 균등 배분 기준(%). 실측이 아니라 계산값이다. */
  quotaPct: number | null;
  quality: "exact" | "approx" | "unknown";
  /** 구간 시작과 실제로 쓴 표본 사이의 거리(ms). */
  gapMs: number | null;
}

/**
 * 한도가 무엇에 걸린 창인지. `shared: true` 는 계정 전체가 함께 쓰는 창이라 소진되면 그 계정이
 * 통째로 막히고, `tier`·`modelId` 가 붙은 창은 그 티어·모델만 막는다. 코어도 같은 기준으로
 * 계정 단위 차단을 판단한다(`@oh-my-pi/pi-ai` 의 UsageScope).
 */
export interface UsageScope {
  provider?: string;
  accountId?: string;
  modelId?: string;
  tier?: string;
  windowId?: string;
  shared?: boolean;
  [key: string]: unknown;
}

/** 브로커가 매긴 한도 판정. `warning` 은 한도에 가까운 것이지 소진이 아니다. */
export type UsageStatus = "ok" | "warning" | "exhausted" | "unknown";

export interface UsageLimit {
  id: string;
  label?: string;
  status?: UsageStatus;
  scope?: UsageScope;
  amount?: { usedFraction?: number; [key: string]: unknown };
  window?: { resetsAt?: number; durationMs?: number; [key: string]: unknown };
  daySlot?: UsageDaySlot;
  [key: string]: unknown;
}

export interface SavedResetCredit {
  id: string;
  expiresAt: string | null;
  program?: string;
  remainingCount?: number;
  usable?: boolean;
  requiresLimit?: boolean;
  clears?: string[];
  blocking?: string[];
  usedFractions?: Record<string, number>;
  status?: string;
}

export interface SavedReset {
  state: "available" | "empty" | "unavailable";
  availableCount: number | null;
  checkedAt: number;
  credits: SavedResetCredit[];
  redeemableCount?: number;
  nextCreditId?: string;
  eligible?: boolean;
  reason?: string;
  cooldownUntil?: string;
  error?: string;
}

export interface UsageReport {
  provider: string;
  metadata?: {
    email?: string;
    accountId?: string;
    orgId?: string;
    projectId?: string;
    planType?: string;
    [key: string]: unknown;
  };
  limits?: UsageLimit[];
  accountRole?: "usage-only" | "control-only";
  credentialId?: number;
  disabled?: boolean;
  autoBlockedUntilMs?: number;
  savedReset?: SavedReset;
  [key: string]: unknown;
}

export interface ResetRecommendation {
  credentialId: number;
  reason: "blocked-account" | "expiring-credit";
  naturalResetAt?: number;
  expiresAt?: string;
  usedFraction?: number;
  window?: "5h" | "weekly";
  scope?: string;
}

export interface SessionAccountState {
  sessionId: string;
  observedAt: number;
  state: "resolved" | "unresolved" | "not-running" | "unsupported";
  provider?: string;
  modelId?: string;
  credentialId?: number;
  source?: "session-pin";
  resetRecommendations: ResetRecommendation[];
}

export interface UsageSnapshot {
  generatedAt?: number;
  reports: UsageReport[];
  brokerOk?: boolean;
  brokerError?: string;
  [key: string]: unknown;
}

/**
 * 화면에 얼굴 하나를 그리는 데 필요한 최소 정보. 별칭과 그림이 같은 자리에서 나오므로
 * 자리를 가리키는 값 하나와 이름이면 충분하다.
 */
export interface AccountFace {
  /** 별칭과 아바타를 함께 결정하는 값. */
  seed: number;
  alias: string;
}

/**
 * 계정 표시 identity.
 *
 * 계정을 구별하는 일과 계정 주소를 띄워 두는 일은 다르다. 화면에 상시 필요한 것은 앞의
 * 것뿐이라 표시를 세 겹으로 나눈다: 아바타 + 별칭이 앞이고, 가려진 식별자가 보조이며,
 * 원문은 사용자가 「이메일 보기」를 눌렀을 때만 나온다. 별칭과 아바타는 같은 해시에서
 * 나오므로 항상 함께 움직이고, 같은 계정은 새로고침해도 같은 얼굴과 같은 이름을 갖는다.
 */
export interface AccountIdentity extends AccountFace {
  /** 가려진 식별자. 원문이 없으면 빈 문자열. */
  masked: string;
  /** 원문 식별자. 명시적으로 펼쳤을 때만 화면에 넣는다. */
  raw: string;
}

/**
 * 얼굴과 이름의 목록. 별칭을 따로 짓지 않고 번들 자산이 곧 목록이다 — 파일 하나에 이름
 * 하나가 붙고, 순서도 자산 순서 그대로다. `public/avatars/` 아래 정적 자산이라 외부
 * 아바타 서비스로 계정 식별자가 나가는 일이 없고 새 의존성도 없다.
 *
 * `provider` 없는 RIN·MIO는 계정이 여럿인 provider가 **계정 순서**대로 나눠 쓰는 자리다 —
 * 목록에서 그 provider의 몇 번째 계정인지가 곧 자리이고, 그 순서는 OAuth 계정 순서다.
 * `provider` 가 붙은 항목은 그 provider 전용 얼굴이라 순서 배정에서 빠진다. 예약 얼굴은
 * 반드시 목록 뒤에 모아 둔다 — 자리를 앞에서부터 세기 때문이고, 그래야 얼굴을 더 늘려도
 * 이미 배정된 계정의 얼굴이 밀리지 않는다.
 */
export const ACCOUNT_FACES = [
  { alias: "RIN(린)", file: "rin.webp" },
  { alias: "MIO(미오)", file: "mio.webp" },
  // Codex 모델은 계정·모델과 무관하게 YUKI, OpenCode Go는 NOVA로 표시한다. b-ai는 API 키
  // 하나를 AuthStorage에 넣는 custom provider이고 web6는 `auth: none`이라 credential 개념이
  // 없다. 반면 Anthropic은 실제 계정이 여럿이므로 provider 예약 없이 RIN/MIO 순서 자리를 쓴다.
  { alias: "NOVA(노바)", file: "nova.webp", provider: "opencode-go" },
  { alias: "YUKI(유키)", file: "yuki.webp", provider: "openai-codex" },
  { alias: "ISANA(이사나)", file: "isana.webp", provider: "b-ai" },
  { alias: "SHION(시온)", file: "shion.webp", provider: "web6" },
] as const;

export interface CharacterRosterEntry {
  seed: number;
  alias: (typeof ACCOUNT_FACES)[number]["alias"];
  provider: string;
  model: string;
  oauthPosition?: 0 | 1;
  voice: string;
  summonExample: string;
  switchExample: string | null;
  summonNote?: string;
  switchNote?: string;
}

/**
 * 사용자가 실제로 부를 수 있는 캐릭터 목록. 모델·말투·호출 문구는 이 표 한 벌만 고치면
 * 화면 전체가 함께 바뀐다. `seed` 와 `alias` 는 위 얼굴 목록의 같은 자리를 그대로 가리킨다.
 */
export const CHARACTER_ROSTER: readonly CharacterRosterEntry[] = [
  {
    seed: 3,
    alias: ACCOUNT_FACES[3].alias,
    provider: "openai-codex",
    model: "gpt-6-astra",
    voice: "빠른 판단·선명한 결론·영리한 장난기",
    summonExample: "유키 불러와",
    switchExample: "유키로 교체해",
  },
  {
    seed: 4,
    alias: ACCOUNT_FACES[4].alias,
    provider: "b-ai",
    model: "deepseek-v4.1-flash",
    voice: "호기심과 실행력·생기 있는 관찰·솔직함",
    summonExample: "이사나 불러와",
    switchExample: "이사나로 교체해",
  },
  {
    seed: 0,
    alias: ACCOUNT_FACES[0].alias,
    provider: "anthropic",
    model: "claude-opus-5-5",
    oauthPosition: 0,
    voice: "조용한 집중·날카로운 분석·건조한 유머",
    summonExample: "린 불러와",
    switchExample: "린으로 교체해",
  },
  {
    seed: 1,
    alias: ACCOUNT_FACES[1].alias,
    provider: "anthropic",
    model: "claude-opus-5-5",
    oauthPosition: 1,
    voice: "따뜻하고 세심함·부드럽고 안정적인 설명",
    summonExample: "미오 불러와",
    switchExample: "미오로 교체해",
  },
  {
    seed: 2,
    alias: ACCOUNT_FACES[2].alias,
    provider: "opencode-go",
    model: "muse-spark-1.3-contributor",
    voice: "번뜩이는 발상·즉흥적 시제품·낙천적 재도전",
    summonExample: "노바 불러와",
    switchExample: "노바로 교체해",
  },
  {
    seed: 5,
    alias: ACCOUNT_FACES[5].alias,
    provider: "web6",
    model: "gpt-6-pro",
    voice: "우아한 전략·넓은 시야·은근한 장난기",
    summonExample: "시온 불러와",
    switchExample: null,
    summonNote: "WEB6 상담으로 호출합니다.",
    switchNote: "SHION은 WEB6 상담 전용이라 Main으로 교체할 수 없습니다.",
  },
];

/**
 * Main 프리셋 후보. 이 대화의 Main을 바꿀 수 있는 자리 중에서 상담 전용 얼굴(SHION,
 * `switchExample` 없음)을 뺀다. 같은 모델·다른 계정 자리(RIN·MIO)는 계정까지 지정해야
 * 구분되므로 그대로 남긴다.
 */
export const MAIN_PRESETS: readonly CharacterRosterEntry[] = CHARACTER_ROSTER.filter(
  (entry) => entry.switchExample !== null,
);

/**
 * 프리셋 하나를 이 대화의 Main에 적용할 때 넘기는 값. 자리(roster entry)에서 그대로 나오고,
 * 계정 자리(`oauthPosition`)는 계정이 여럿인 provider에서만 있다.
 */
export interface MainPresetSelection {
  alias: CharacterRosterEntry["alias"];
  provider: string;
  modelId: string;
  oauthPosition?: 0 | 1;
}

/** roster 자리에서 프리셋 선택 값을 만든다. */
export function mainPresetSelection(entry: CharacterRosterEntry): MainPresetSelection {
  return {
    alias: entry.alias,
    provider: entry.provider,
    modelId: entry.model,
    ...(entry.oauthPosition !== undefined ? { oauthPosition: entry.oauthPosition } : {}),
  };
}

/** 순서대로 나눠 쓰는 자리의 수. 예약 얼굴을 뺀 앞쪽 풀이다. */
const POOL_SIZE = ACCOUNT_FACES.filter((face) => !("provider" in face)).length;

/** provider 예약 자리. 목록을 한 번만 훑어 둔다. */
const RESERVED_SLOTS: ReadonlyMap<string, number> = new Map(
  ACCOUNT_FACES.flatMap((face, slot) => ("provider" in face ? [[face.provider, slot] as const] : [])),
);

/**
 * 예약 얼굴의 완성된 값. 미리 만들어 두는 이유는 이 값이 `useSyncExternalStore` 의 스냅샷으로
 * 쓰이기 때문이다 — 부를 때마다 새 객체를 주면 스냅샷이 매번 달라져 리렌더가 멈추지 않는다.
 */
const PROVIDER_FACES: ReadonlyMap<string, AccountFace> = new Map(
  [...RESERVED_SLOTS].map(([provider, slot]) => [provider, { seed: slot, alias: ACCOUNT_FACES[slot].alias }]),
);

/** 그 provider 전용으로 예약된 자리. 없으면 -1. */
function reservedSlot(provider: string): number {
  return RESERVED_SLOTS.get(provider) ?? -1;
}

/** 자리를 가리키는 값에서 실제 자리로. 배정이 이미 자리를 고르므로 여기서 다시 섞지 않는다. */
function faceSlot(seed: number): number {
  return seed % ACCOUNT_FACES.length;
}

/**
 * 계정이 구조적으로 하나뿐인 provider 의 얼굴. 순서 배정 밖이라 다른 계정의 배정을 흔들지
 * 않고, 사용량 보고서가 없어도 나온다. 예약이 없는 provider 는 `null` 이고 그때는 얼굴을
 * 그리지 않는다. 같은 provider 에는 늘 같은 객체를 돌려준다.
 */
export function providerAccountFace(provider: string): AccountFace | null {
  return PROVIDER_FACES.get(provider) ?? null;
}

/** 그 자리의 별칭. 배정된 seed 로 부르면 화면에 보이는 이름과 항상 같다. */
export function aliasForSeed(seed: number): string {
  return ACCOUNT_FACES[faceSlot(seed)].alias;
}

/** 그 별칭과 짝인 그림의 경로. 이름과 얼굴은 같은 자리에서 나오므로 늘 함께 움직인다. */
export function avatarSrcForSeed(seed: number): string {
  return `/avatars/${ACCOUNT_FACES[faceSlot(seed)].file}`;
}

/** 첫 글자와 끝 글자만 남긴다. 1~2 글자는 끝 글자도 남기지 않는다. */
function maskSegment(value: string): string {
  if (value.length === 0) return "";
  if (value.length === 1) return "•••";
  if (value.length === 2) return `${value[0]}•••`;
  return `${value[0]}•••${value[value.length - 1]}`;
}

/**
 * 계정 두 개를 같은 문자열로 만들면 가린 것이 아니라 지운 것이다. 로컬 파트의 첫·끝 글자와
 * 최상위 도메인은 남겨 서로 다른 계정이 서로 다르게 보이게 한다.
 */
export function maskAccountIdentifier(value: string): string {
  const at = value.lastIndexOf("@");
  if (at <= 0) return maskSegment(value);
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const head = dot < 0 ? domain : domain.slice(0, dot);
  const tld = dot < 0 ? "" : domain.slice(dot);
  return `${maskSegment(value.slice(0, at))}@${head.length === 0 ? "" : `${head[0]}•••`}${tld}`;
}

/**
 * provider id 를 사람이 읽는 이름으로. 사용량 패널의 계정 헤더와 대화창의 메시지 헤더가
 * 같은 계정을 같은 이름으로 불러야 하므로 라벨 표도 한 벌만 둔다. 표에 없는 id 는 대시를
 * 끊어 읽는 일반 규칙으로 떨어지므로, 새 provider 가 와도 표시가 깨지지 않는다.
 */
export function providerDisplayName(provider: string): string {
  const known: Record<string, string> = {
    "openai-codex": "OpenAI Codex",
    anthropic: "Anthropic",
    "google-gemini": "Google Gemini",
    "github-copilot": "GitHub Copilot",
    "opencode-go": "OpenCode Go",
    devin: "Devin",
    // 일반 규칙이라면 「B Ai」·「Web6」이 된다. 사용량·설정에서 이미 부르는 이름으로 맞춘다.
    "b-ai": "B.AI",
    web6: "WEB6",
  };
  return known[provider] ?? provider.replace(/(^|-)(\w)/g, (_match, separator: string, character: string) => (
    `${separator ? " " : ""}${character.toUpperCase()}`
  ));
}

/**
 * 보고서 목록 전체에 별칭과 얼굴을 배정한다. 목록 단위로 계산하므로 한 화면에서 두 계정이
 * 같은 이름이나 같은 얼굴을 갖지 않는다.
 *
 * 계정이 여럿인 provider 는 **계정 순서**로 앞쪽 풀을 나눠 쓴다 — 목록에서 그 provider 의 몇
 * 번째인지가 곧 자리다. 로컬 credential id 를 섞지 않는 이유는 그 값이 PC 마다 달라서, 같은
 * 두 계정이 PC 마다 다른 얼굴로 보이기 때문이다. 사이드바와 패널이 같은(필터 이전) 목록을
 * 넘겨야 두 곳의 표시가 같다.
 *
 * 예약 얼굴을 가진 provider 는 순서를 거치지 않고 그 자리로 간다. 대화창이 사용량 보고서
 * 없이도 같은 얼굴을 쓰므로, 나중에 그 provider 가 보고서를 갖게 되어도 두 화면이 갈라지지
 * 않는다.
 */
export function accountIdentities(reports: readonly UsageReport[]): AccountIdentity[] {
  const seenByProvider = new Map<string, number>();
  return reports.map((report) => {
    const email = report.metadata?.email;
    const accountId = report.metadata?.accountId;
    const raw = typeof email === "string" && email.length > 0
      ? email
      : typeof accountId === "string" ? accountId : "";
    const masked = raw.length > 0 ? maskAccountIdentifier(raw) : "";

    const reserved = reservedSlot(report.provider);
    if (reserved >= 0) return { seed: reserved, alias: ACCOUNT_FACES[reserved].alias, masked, raw };

    const position = seenByProvider.get(report.provider) ?? 0;
    seenByProvider.set(report.provider, position + 1);
    const slot = position % POOL_SIZE;
    // 계정이 자산보다 많으면 자리가 돌아 같은 얼굴을 다시 쓴다. 그때만 뒤에 번호를 붙여
    // 이름만은 갈라 둔다.
    const alias = position < POOL_SIZE
      ? ACCOUNT_FACES[slot].alias
      : `${ACCOUNT_FACES[slot].alias}${position + 1}`;
    return { seed: slot, alias, masked, raw };
  });
}

export interface ModelAggregate {
  model: string;
  provider: string;
  requests: number;
  cost: number;
  costShare: number;
  costPerRequest: number | null;
  tokens: number;
  tokensPerRequest: number | null;
  outputPerRequest: number | null;
  cacheRate?: number;
  avgTtft?: number;
  avgTokensPerSecond?: number;
  errorRate?: number;
}

export interface AgentAggregate {
  agentType: string;
  requests: number;
  cost: number;
  costShare: number;
  costPerRequest: number | null;
  tokensPerRequest: number | null;
}

export interface DailyModelCost {
  timestamp: number;
  cost: number;
  models: Array<{ model: string; provider: string; cost: number }>;
}

export interface ModelStatsSnapshot {
  generatedAt: number;
  range: { from?: number; to?: number };
  overall: {
    requests: number;
    failedRequests: number;
    errorRate?: number;
    cost: number;
    tokens: number;
    cacheRate?: number;
    cacheSavings?: number;
    avgTtft?: number;
    avgDuration?: number;
  };
  models: ModelAggregate[];
  agents: AgentAggregate[];
  daily: DailyModelCost[];
}

export type ResourceClientErrorKind = "http" | "invalid-response" | "network" | "aborted" | "timeout";

export class ResourceClientError extends Error {
  public readonly code?: string;
  public readonly outcomeUnknown?: boolean;

  constructor(
    message: string,
    public readonly kind: ResourceClientErrorKind,
    public readonly status?: number,
    options?: ErrorOptions & { code?: string; outcomeUnknown?: boolean },
  ) {
    super(message, options);
    this.name = "ResourceClientError";
    this.code = options?.code;
    this.outcomeUnknown = options?.outcomeUnknown;
  }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type TimerHandle = number | NodeJS.Timeout;
type SetIntervalLike = (callback: () => void, delay: number) => TimerHandle;
type ClearIntervalLike = (handle: TimerHandle | undefined) => void;

export interface ResourceRequestOptions<T> {
  refresh?: boolean;
  previous?: T | null;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

function resourceUrl(path: "/usage" | "/models", refresh: boolean): string {
  return `${HANSE_RESOURCE_ORIGIN}${path}${refresh ? "?refresh=1" : ""}`;
}

function toClientError(error: unknown, timedOut: boolean, aborted = false): ResourceClientError {
  if (error instanceof ResourceClientError) return error;
  if (timedOut) return new ResourceClientError("요청 시간이 초과되었습니다.", "timeout", undefined, { cause: error });
  if (aborted || (error instanceof DOMException && error.name === "AbortError")) {
    return new ResourceClientError("요청이 취소되었습니다.", "aborted", undefined, { cause: error });
  }
  return new ResourceClientError(
    error instanceof Error ? error.message : String(error),
    "network",
    undefined,
    { cause: error },
  );
}

function fallback<T>(previous: T | null | undefined, error: ResourceClientError): ResourceLoadState<T> {
  return previous == null
    ? { status: "error", data: null, error }
    : { status: "stale", data: previous, error };
}

async function requestJson<T>(
  url: string,
  options: { signal?: AbortSignal; fetchImpl?: FetchLike; timeoutMs?: number },
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  let timeout: TimerHandle | undefined;

  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });

  if (options.timeoutMs != null) {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Timeout", "TimeoutError"));
    }, options.timeoutMs);
  }

  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new ResourceClientError("리소스 서버 응답이 JSON이 아닙니다.", "invalid-response", response.status, { cause: error });
    }
    const record = body && typeof body === "object" ? body as Record<string, unknown> : null;
    const message = typeof record?.error === "string" ? record.error : null;
    if (!response.ok || message) {
      throw new ResourceClientError(message ?? `HTTP ${response.status}`, "http", response.status, {
        code: typeof record?.code === "string" ? record.code : undefined,
        outcomeUnknown: record?.outcomeUnknown === true,
      });
    }
    return body as T;
  } catch (error) {
    throw toClientError(error, timedOut, controller.signal.aborted);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export async function loadUsage(
  options: ResourceRequestOptions<UsageSnapshot> = {},
): Promise<ResourceLoadState<UsageSnapshot>> {
  try {
    const data = await requestJson<UsageSnapshot>(resourceUrl("/usage", options.refresh === true), options);
    if (!data || !Array.isArray(data.reports)) {
      throw new ResourceClientError("사용량 응답 형식이 올바르지 않습니다.", "invalid-response");
    }
    return { status: "fresh", data, error: null };
  } catch (error) {
    return fallback(options.previous, toClientError(error, false));
  }
}

export async function loadSessionAccount(
  sessionId: string,
  options: ResourceRequestOptions<SessionAccountState> = {},
): Promise<ResourceLoadState<SessionAccountState>> {
  if (!sessionId) {
    return fallback<SessionAccountState>(undefined, new ResourceClientError("세션 id가 올바르지 않습니다.", "invalid-response"));
  }
  try {
    const data = await requestJson<SessionAccountState>(
      `/api/agent/${encodeURIComponent(sessionId)}/account`,
      options,
    );
    const validState = data?.state === "resolved"
      || data?.state === "unresolved"
      || data?.state === "not-running"
      || data?.state === "unsupported";
    if (!data
      || data.sessionId !== sessionId
      || typeof data.observedAt !== "number"
      || !validState
      || !Array.isArray(data.resetRecommendations)) {
      throw new ResourceClientError("현재 계정 응답 형식이 올바르지 않습니다.", "invalid-response");
    }
    return { status: "fresh", data, error: null };
  } catch (error) {
    return fallback<SessionAccountState>(undefined, toClientError(error, false));
  }
}

export async function loadModelStats(
  options: ResourceRequestOptions<ModelStatsSnapshot> = {},
): Promise<ResourceLoadState<ModelStatsSnapshot>> {
  try {
    const data = await requestJson<ModelStatsSnapshot>(resourceUrl("/models", options.refresh === true), {
      ...options,
      timeoutMs: options.timeoutMs ?? MODEL_REQUEST_TIMEOUT_MS,
    });
    if (!data || !Array.isArray(data.models) || !Array.isArray(data.agents) || !Array.isArray(data.daily)) {
      throw new ResourceClientError("모델 집계 응답 형식이 올바르지 않습니다.", "invalid-response");
    }
    return { status: "fresh", data, error: null };
  } catch (error) {
    return fallback(options.previous, toClientError(error, false));
  }
}

export interface CredentialActionResult {
  ok: true;
  credentialId: number;
  disabled: boolean;
}

export interface CredentialActionOptions {
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export async function setCredentialEnabled(
  credentialId: number,
  enabled: boolean,
  options: CredentialActionOptions = {},
): Promise<CredentialActionResult> {
  if (!Number.isSafeInteger(credentialId) || credentialId <= 0) {
    throw new ResourceClientError("credential id가 올바르지 않습니다.", "invalid-response");
  }
  const result = await requestJson<CredentialActionResult>(
    `${HANSE_RESOURCE_ORIGIN}/credential/${credentialId}/${enabled ? "enable" : "disable"}`,
    {
      ...options,
      timeoutMs: options.timeoutMs ?? CREDENTIAL_ACTION_TIMEOUT_MS,
      fetchImpl: async (url, init) => (options.fetchImpl ?? fetch)(url, { ...init, method: "POST" }),
    },
  );
  if (!result || result.ok !== true || result.credentialId !== credentialId || result.disabled !== !enabled) {
    throw new ResourceClientError("계정 전환 응답 형식이 올바르지 않습니다.", "invalid-response");
  }
  return result;
}

export interface CredentialResetResult {
  ok: boolean;
  credentialId: number;
  creditId: string;
  code: string;
  outcomeUnknown?: boolean;
}

export async function redeemCredentialReset(
  credentialId: number,
  creditId: string,
  options: CredentialActionOptions = {},
): Promise<CredentialResetResult> {
  if (!Number.isSafeInteger(credentialId) || credentialId <= 0) {
    throw new ResourceClientError("credential id가 올바르지 않습니다.", "invalid-response");
  }
  if (!creditId) {
    throw new ResourceClientError("credit id가 올바르지 않습니다.", "invalid-response");
  }
  const result = await requestJson<CredentialResetResult>(
    `${HANSE_RESOURCE_ORIGIN}/credential/${credentialId}/reset`,
    {
      ...options,
      timeoutMs: options.timeoutMs ?? CREDENTIAL_ACTION_TIMEOUT_MS,
      fetchImpl: async (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Content-Type", "application/json");
        return (options.fetchImpl ?? fetch)(url, {
          ...init,
          method: "POST",
          headers,
          body: JSON.stringify({ confirm: true, creditId }),
        });
      },
    },
  );
  if (!result
    || typeof result.ok !== "boolean"
    || result.credentialId !== credentialId
    || result.creditId !== creditId
    || typeof result.code !== "string"
    || result.ok !== (result.code === "reset")) {
    throw new ResourceClientError("리셋 사용 응답 형식이 올바르지 않습니다.", "invalid-response");
  }
  return result;
}

export function acquireCredentialAction(
  pendingCredentialIds: Set<number>,
  credentialId: number,
): (() => void) | null {
  if (pendingCredentialIds.has(credentialId)) return null;
  pendingCredentialIds.add(credentialId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pendingCredentialIds.delete(credentialId);
  };
}

export interface UsagePoller {
  start(): void;
  refresh(): Promise<ResourceLoadState<UsageSnapshot>>;
  setPaused(paused: boolean): void;
  stop(): void;
}

export interface UsagePollerOptions {
  onResult: (result: ResourceLoadState<UsageSnapshot>) => void;
  initialData?: UsageSnapshot | null;
  fetchImpl?: FetchLike;
  intervalMs?: number;
  setIntervalImpl?: SetIntervalLike;
  clearIntervalImpl?: ClearIntervalLike;
}

export interface SessionAccountPoller {
  setSessionId(sessionId: string | null): void;
  stop(): void;
}

export interface SessionAccountPollerOptions {
  onClear: (sessionId: string | null) => void;
  onResult: (result: ResourceLoadState<SessionAccountState>) => void;
  fetchImpl?: FetchLike;
  intervalMs?: number;
  setIntervalImpl?: SetIntervalLike;
  clearIntervalImpl?: ClearIntervalLike;
}

export function createSessionAccountPoller(options: SessionAccountPollerOptions): SessionAccountPoller {
  const intervalMs = options.intervalMs ?? ACCOUNT_STATE_POLL_INTERVAL_MS;
  const setIntervalImpl = options.setIntervalImpl ?? setInterval;
  const clearIntervalImpl = options.clearIntervalImpl ?? clearInterval;
  let sessionId: string | null = null;
  let interval: TimerHandle | undefined;
  let controller: AbortController | null = null;
  let sequence = 0;
  let stopped = false;

  const clearTimer = () => {
    clearIntervalImpl(interval);
    interval = undefined;
  };
  const load = async (targetSessionId: string) => {
    controller?.abort();
    controller = new AbortController();
    const currentController = controller;
    const current = ++sequence;
    const result = await loadSessionAccount(targetSessionId, {
      signal: currentController.signal,
      fetchImpl: options.fetchImpl,
    });
    if (!stopped
      && current === sequence
      && sessionId === targetSessionId
      && !currentController.signal.aborted) {
      options.onResult(result);
    }
  };

  return {
    setSessionId(nextSessionId) {
      if (stopped || nextSessionId === sessionId) return;
      sequence += 1;
      controller?.abort();
      controller = null;
      clearTimer();
      sessionId = nextSessionId;
      options.onClear(nextSessionId);
      if (!nextSessionId) return;
      void load(nextSessionId);
      interval = setIntervalImpl(() => {
        if (sessionId) void load(sessionId);
      }, intervalMs);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      sequence += 1;
      controller?.abort();
      controller = null;
      clearTimer();
      sessionId = null;
    },
  };
}

export function createUsagePoller(options: UsagePollerOptions): UsagePoller {
  const intervalMs = options.intervalMs ?? USAGE_POLL_INTERVAL_MS;
  const setIntervalImpl = options.setIntervalImpl ?? setInterval;
  const clearIntervalImpl = options.clearIntervalImpl ?? clearInterval;
  let previous = options.initialData ?? null;
  let interval: TimerHandle | undefined;
  let controller: AbortController | null = null;
  let sequence = 0;
  let running = false;
  let paused = false;

  const load = async (refresh: boolean): Promise<ResourceLoadState<UsageSnapshot>> => {
    controller?.abort();
    controller = new AbortController();
    const current = ++sequence;
    const result = await loadUsage({
      refresh,
      previous,
      signal: controller.signal,
      fetchImpl: options.fetchImpl,
    });
    if (running && current === sequence) {
      if (result.data) previous = result.data;
      options.onResult(result);
    }
    return result;
  };

  return {
    start() {
      if (running) return;
      running = true;
      void load(false);
      interval = setIntervalImpl(() => {
        if (!paused) void load(false);
      }, intervalMs);
    },
    refresh() {
      if (!running) {
        return Promise.resolve(fallback(previous, new ResourceClientError("사용량 폴링이 중지되었습니다.", "aborted")));
      }
      return load(true);
    },
    setPaused(nextPaused) {
      paused = nextPaused;
    },
    stop() {
      running = false;
      sequence += 1;
      controller?.abort();
      controller = null;
      clearIntervalImpl(interval);
      interval = undefined;
    },
  };
}
