/**
 * 캐릭터 발화 큐 — 감정·상황 태그로 묶인 (스티커, 음성) 세트를 고른다.
 *
 * 이벤트가 태그를 고르고(`cueTagForOutcome`), 태그는 매니페스트
 * (`public/audio/completion/voices.json`)에서 그 의미에 맞는 스티커·음성 세트를 찾는다.
 * 그래서 실패·중단에 완료 대사가 나가지 않고, 중간 이벤트에도 그 상황의 대사·스티커가 나간다.
 * 세트가 비어 있으면(자산 미조달) 음성은 중립 tone으로, 스티커는 표시 없음으로 물러난다 —
 * 자산이 없어도 알림 자체는 동작해야 한다.
 */
import type { AgentMessage } from "./types";

export const COMPLETION_AUDIO_ALIASES = [
  "YUKI(유키)",
  "ISANA(이사나)",
  "MIO(미오)",
  "RIN(린)",
  "NOVA(노바)",
  "SHION(시온)",
] as const;

export type CompletionAudioAlias = (typeof COMPLETION_AUDIO_ALIASES)[number];

/** 매니페스트의 `characters[].id`이자 자산 디렉터리 이름. */
const CHARACTER_ID_BY_ALIAS: Readonly<Record<CompletionAudioAlias, string>> = {
  "YUKI(유키)": "yuki",
  "ISANA(이사나)": "isana",
  "MIO(미오)": "mio",
  "RIN(린)": "rin",
  "NOVA(노바)": "nova",
  "SHION(시온)": "shion",
};

/**
 * 태그. **「이걸 본 사용자가 무엇을 해야 하는가」**로 나눈다 — 턴이 어떻게 끝났는지가 아니다.
 * 이벤트가 이 중 하나를 고르고, 매니페스트가 태그마다 세트를 갖는다.
 *
 * `approval` 지금 답해야 함 / `choice` 지금 골라야 함 / `done` 결과 확인 /
 * `failed` 원인 확인 / `blocked` 사용자만 풀 수 있음 / `working` 할 일 없음, 알림만.
 */
export const CUE_TAGS = ["approval", "choice", "done", "failed", "blocked", "working"] as const;

export type CueTag = (typeof CUE_TAGS)[number];

/** 태그의 감정 이름. 스티커의 대체 텍스트이자 자산을 만들고 검수할 때 쓰는 공통 표기. */
export const CUE_TAG_MEANING: Readonly<Record<CueTag, string>> = {
  approval: "부름",
  choice: "물음",
  done: "기쁨",
  failed: "사과",
  blocked: "난처",
  working: "시작",
};

/**
 * 자산이 없을 때 중립 tone으로 물러나지 않는 태그. `working`은 사용자가 **할 일이 없는**
 * 진행 알림이라, 그 캐릭터의 착수 음성이 있으면 말하되 음성이 없다고 2음 tone으로 손을
 * 멈추게 하지는 않는다.
 */
export const NO_TONE_FALLBACK_CUE_TAGS: Readonly<Record<CueTag, boolean>> = {
  approval: false,
  choice: false,
  done: false,
  failed: false,
  blocked: false,
  working: true,
};

/**
 * 확장 대화창이 사용자에게 시키는 일. 선택지를 내미는 요청(`select`, 질문마다 선택지가 있는
 * `ask`)은 고르는 일이고, 그 밖의 확인·입력·계획 검토는 답하는 일이다.
 */
export function cueTagForDialog(method: string): CueTag {
  return method === "select" || method === "ask" ? "choice" : "approval";
}

/**
 * 한 캐릭터의 한 태그에 배정된 자산. 둘 중 하나만 있어도 그 하나는 쓴다.
 * `lines`는 음성 url → 그 대사의 한국어 표기다. 화면 말풍선은 합성된 일본어가 아니라
 * 이 한국어를 읽어야 소리를 못 듣는 사용자도 같은 내용을 안다.
 * `captions`는 음성 없이 화면에만 띄우는 한국어 대사다. 음성이 있는 태그는 그 음성의 대사를
 * 쓰므로(자막과 소리가 어긋나지 않게) 음성이 하나도 없을 때만 여기서 고른다.
 */
export interface CueSet {
  readonly voices: readonly string[];
  readonly stickers: readonly string[];
  readonly lines: ReadonlyMap<string, string>;
  readonly captions: readonly string[];
}

/** 알림 한 번이 화면에 내보내는 것 — 스티커와 그 대사. 둘 다 없을 수 있다. */
export interface CuePresentation {
  readonly sticker: string | null;
  readonly text: string | null;
}

/** 캐릭터 id → 태그 → 세트. 자산이 없는 태그도 빈 세트로 존재한다. */
export type CueManifest = ReadonlyMap<string, ReadonlyMap<CueTag, CueSet>>;

export const CUE_MANIFEST_PATH = "/audio/completion/voices.json";

/** 매니페스트의 `clips[].file`·`stickers[].file`이 각각 어디 기준 상대 경로인지. */
const VOICE_ROOT = "/audio/completion/";
const STICKER_ROOT = "/stickers/";

/** 태그가 없는 옛 항목은 완료 대사로 본다. */
const DEFAULT_CUE_TAG: CueTag = "done";

export type CompletionOutcome = "completed" | "failed" | "aborted" | "unknown";

/**
 * 턴 종료가 낼 알림. 태그거나, 태그 없는 중립음(`"neutral"`)이거나, 알릴 것이 없다(`null`).
 */
export type OutcomeCue = CueTag | "neutral" | null;

/**
 * 완료 결과 → 알림. 결과가 다르면 태그도 달라야 실패에 완료 대사가 새지 않는다.
 *
 * `aborted`는 **알리지 않는다** — 사용자가 방금 자기 손으로 멈춘 것이라 되돌려줄 정보가 없다.
 * `unknown`은 끝났는지 모르는 상태이므로 `done` 대사("끝났어, 확인해 봐")를 내면 거짓말이 된다.
 * 태그 없이 중립음만 내보내 「무언가 끝났다」까지만 말한다.
 */
export function cueForOutcome(outcome: CompletionOutcome): OutcomeCue {
  switch (outcome) {
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "aborted":
      return null;
    default:
      return "neutral";
  }
}

/**
 * 항목의 태그. 없으면 완료(태그 도입 전 매니페스트), 모르는 값이면 null이다 —
 * 오타 난 태그를 완료로 읽어 엉뚱한 대사를 내보내지 않도록 그 항목은 버린다.
 */
function readCueTag(tag: unknown): CueTag | null {
  if (tag === undefined) return DEFAULT_CUE_TAG;
  if (typeof tag !== "string" || !Object.hasOwn(CUE_TAG_MEANING, tag)) return null;
  return tag as CueTag;
}

/** 항목을 태그별 url 목록과 url → 한국어 대사 표기로 읽는다. `ko`가 없으면 그 url은 대사가 없다. */
function readCueFiles(entries: unknown, root: string): { files: Map<CueTag, string[]>; lines: Map<string, string> } {
  const files = new Map<CueTag, string[]>();
  const lines = new Map<string, string>();
  if (!Array.isArray(entries)) return { files, lines };
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const { file, tag, ko } = entry as { file?: unknown; tag?: unknown; ko?: unknown };
    if (typeof file !== "string" || file === "") continue;
    const cueTag = readCueTag(tag);
    if (cueTag === null) continue;
    const url = root + file.replace(/^\/+/, "");
    const list = files.get(cueTag);
    if (list) list.push(url);
    else files.set(cueTag, [url]);
    if (typeof ko === "string" && ko.trim() !== "") lines.set(url, ko.trim());
  }
  return { files, lines };
}

/** 음성 없는 자막을 태그별로 읽는다. `ko`가 빈 항목과 모르는 태그는 버린다. */
function readCueCaptions(entries: unknown): Map<CueTag, string[]> {
  const captions = new Map<CueTag, string[]>();
  if (!Array.isArray(entries)) return captions;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const { tag, ko } = entry as { tag?: unknown; ko?: unknown };
    if (typeof ko !== "string" || ko.trim() === "") continue;
    const cueTag = readCueTag(tag);
    if (cueTag === null) continue;
    const list = captions.get(cueTag);
    if (list) list.push(ko.trim());
    else captions.set(cueTag, [ko.trim()]);
  }
  return captions;
}

/**
 * 매니페스트를 캐릭터별 태그 세트로 읽는다. 형식이 어긋난 항목은 건너뛰고 나머지를 살린다 —
 * 자산 하나가 잘못 적혔다고 그 캐릭터의 다른 대사까지 잃을 이유가 없다.
 */
export function parseCueManifest(raw: unknown): CueManifest {
  const manifest = new Map<string, ReadonlyMap<CueTag, CueSet>>();
  if (typeof raw !== "object" || raw === null) return manifest;
  const { characters } = raw as { characters?: unknown };
  if (!Array.isArray(characters)) return manifest;

  for (const character of characters) {
    if (typeof character !== "object" || character === null) continue;
    const { id, clips, stickers, captions } = character as { id?: unknown; clips?: unknown; stickers?: unknown; captions?: unknown };
    if (typeof id !== "string" || id === "") continue;

    const voices = readCueFiles(clips, VOICE_ROOT);
    const stickerFiles = readCueFiles(stickers, STICKER_ROOT);
    const captionLines = readCueCaptions(captions);
    const sets = new Map<CueTag, CueSet>();
    for (const tag of CUE_TAGS) {
      const tagVoices = voices.files.get(tag) ?? [];
      const lines = new Map<string, string>();
      for (const url of tagVoices) {
        const line = voices.lines.get(url);
        if (line !== undefined) lines.set(url, line);
      }
      sets.set(tag, {
        voices: tagVoices,
        stickers: stickerFiles.files.get(tag) ?? [],
        lines,
        captions: captionLines.get(tag) ?? [],
      });
    }
    manifest.set(id, sets);
  }
  return manifest;
}

export function cueSetFor(
  manifest: CueManifest,
  alias: string | null | undefined,
  tag: CueTag,
): CueSet | null {
  if (!alias || !Object.hasOwn(CHARACTER_ID_BY_ALIAS, alias)) return null;
  const characterId = CHARACTER_ID_BY_ALIAS[alias as CompletionAudioAlias];
  return manifest.get(characterId)?.get(tag) ?? null;
}

/** 매니페스트를 읽는다. 실패하면 빈 매니페스트 — 알림은 중립 tone으로 계속 동작한다. */
export async function loadCueManifest(fetchImpl: typeof fetch = fetch): Promise<CueManifest> {
  try {
    const response = await fetchImpl(CUE_MANIFEST_PATH);
    if (!response.ok) return new Map();
    return parseCueManifest(await response.json());
  } catch {
    return new Map();
  }
}

/** 직전에 쓴 자산만 피해 하나 고른다. 후보가 하나뿐이면 그 하나를 그대로 쓴다. */
export function selectCueAsset(
  assets: readonly string[],
  previous: string | null,
  random: () => number = Math.random,
): string | null {
  if (assets.length === 0) return null;
  if (assets.length === 1) return assets[0];

  const previousIndex = previous === null ? -1 : assets.indexOf(previous);
  const candidateCount = previousIndex === -1 ? assets.length : assets.length - 1;
  const randomIndex = Math.min(candidateCount - 1, Math.max(0, Math.floor(random() * candidateCount)));
  const assetIndex = previousIndex !== -1 && randomIndex >= previousIndex ? randomIndex + 1 : randomIndex;
  return assets[assetIndex];
}

/** 스티커만 뜰 때도 알아볼 최소 시간, 그리고 알림 하나가 화면을 잡고 있을 상한. */
export const CUE_VISIBLE_MIN_MS = 4000;
export const CUE_VISIBLE_MAX_MS = 7000;
/** 읽는 속도를 한 글자당 이만큼으로 본다(한국어 짧은 문장 기준). */
const CUE_READ_MS_PER_CHAR = 140;
/** 눈이 말풍선을 찾아가는 데 드는 시간. 글자 수와 무관하게 먼저 붙는다. */
const CUE_NOTICE_MS = 1200;

/** 말풍선이 머무는 시간. 대사가 길수록 읽을 시간을 더 주되 최소·최대 안에 둔다. */
export function cueVisibleMs(text: string | null): number {
  if (!text) return CUE_VISIBLE_MIN_MS;
  const needed = CUE_NOTICE_MS + text.length * CUE_READ_MS_PER_CHAR;
  return Math.min(CUE_VISIBLE_MAX_MS, Math.max(CUE_VISIBLE_MIN_MS, needed));
}

/**
 * 큐를 붙일 메시지를 라이브 목록과 저장된 기록 양쪽에서 같은 것으로 알아보는 열쇠.
 * 역할·보이는 글·도구 호출 id만 본다 — 시각은 낙관적 입력과 저장본이 다르고, thinking은
 * 저장본이 미뤄 보내 비어 있으므로 열쇠에 넣으면 같은 메시지를 놓친다.
 */
export function cueMessageIdentity(message: AgentMessage): string {
  const parts: string[] = [];
  if (message.role !== "bashExecution") {
    if (typeof message.content === "string") {
      parts.push(message.content.trim());
    } else {
      for (const block of message.content) {
        if (block.type === "text") {
          parts.push(block.text.trim());
        } else if (block.type === "toolCall") {
          // 정규화 전 블록은 id를 `id`에 둔다. 두 모양이 같은 호출로 읽혀야 한다.
          const rawId = "id" in block && typeof block.id === "string" ? block.id : "";
          parts.push(`toolCall:${block.toolCallId || rawId}`);
        }
      }
    }
  }
  const key = message.role === "toolResult"
    ? message.toolCallId
    : message.role === "custom"
      ? message.customType
      : message.role === "bashExecution"
        ? message.command
        : null;
  return JSON.stringify([message.role, key, parts.filter(Boolean)]);
}

/**
 * 아직 기록 id를 받지 못한 메시지 뒤에 붙을 큐의 자리. 트리거 순간 이미 기록돼 있던 마지막
 * 항목(`baseEntryId`, 빈 세션이면 null) 뒤에서, 그 메시지와 열쇠가 같은 기록 중
 * `occurrence`번째가 그 자리다. 다음 턴이 먼저 시작돼 여러 턴이 한꺼번에 기록돼도 위치가
 * 아니라 메시지로 찾으므로 다른 턴에 붙지 않는다.
 */
export interface CueAnchorIntent {
  readonly baseEntryId: string | null;
  readonly identity: string;
  readonly occurrence: number;
}

/** 트리거 순간 정한 자리. 이미 기록된 메시지면 그 id, 아니면 기록을 기다리는 의도다. */
export type CueAnchorCapture =
  | { readonly kind: "entry"; readonly entryId: string }
  | { readonly kind: "pending"; readonly liveIndex: number; readonly intent: CueAnchorIntent };

/**
 * 지금 화면의 마지막 메시지 뒤를 큐의 자리로 잡는다. `entryIds`는 `messages`의 앞부분만
 * 덮는다(라이브로 붙은 메시지는 다음 로드 전까지 id가 없다).
 */
export function captureCueAnchor(messages: readonly AgentMessage[], entryIds: readonly string[]): CueAnchorCapture | null {
  const liveIndex = messages.length - 1;
  if (liveIndex < 0) return null;
  const tracked = Math.min(messages.length, entryIds.length);
  if (liveIndex < tracked) return { kind: "entry", entryId: entryIds[liveIndex] };
  const identity = cueMessageIdentity(messages[liveIndex]);
  let occurrence = 0;
  for (let i = tracked; i <= liveIndex; i++) {
    if (cueMessageIdentity(messages[i]) === identity) occurrence += 1;
  }
  return {
    kind: "pending",
    liveIndex,
    intent: { baseEntryId: tracked > 0 ? entryIds[tracked - 1] : null, identity, occurrence },
  };
}

/**
 * 기록된 앞부분에서 의도한 메시지를 찾는다. 찾으면 그 id, 기준 항목이 사라졌으면(브랜치
 * 이동·압축·다른 기록) 붙일 근거가 없으므로 버림, 아직 기록되지 않았으면 null(계속 기다림).
 */
export function resolveCueAnchor(
  intent: CueAnchorIntent,
  messages: readonly AgentMessage[],
  entryIds: readonly string[],
): { kind: "entry"; entryId: string } | { kind: "drop" } | null {
  const tracked = Math.min(messages.length, entryIds.length);
  let start = 0;
  if (intent.baseEntryId !== null) {
    const base = entryIds.indexOf(intent.baseEntryId);
    if (base === -1 || base >= tracked) return { kind: "drop" };
    start = base + 1;
  }
  let seen = 0;
  for (let i = start; i < tracked; i++) {
    if (cueMessageIdentity(messages[i]) !== intent.identity) continue;
    seen += 1;
    if (seen === intent.occurrence) return { kind: "entry", entryId: entryIds[i] };
  }
  return null;
}

/**
 * 6PRO 상담 답변이 대화창에 투영될 때의 모델 표기. `lib/gpt6-bridge.ts`의 `GPT6_REPLY_SOURCE`와
 * 같은 값이다 — 그쪽은 서버 전용 모듈이라 브라우저 코드가 값을 가져올 수 없다.
 */
export const CONSULT_REPLY_MODEL = "ChatGPT 6PRO";

/**
 * 같은 기록이 뒤로 자라며 새로 붙은 6PRO 상담 답변의 id. 상담 답변은 에이전트 턴이 아니라
 * 턴 종료 알림이 없다. 앞부분이 그대로 이어질 때만 「새로 도착했다」고 본다 — 처음 불러온
 * 기록·브랜치 이동·다른 세션은 성장이 아니므로 지난 답변을 다시 알리지 않는다.
 */
export function newConsultReplyEntryIds(
  previous: readonly string[],
  next: readonly string[],
  messages: readonly AgentMessage[],
): string[] {
  if (previous.length === 0 || next.length <= previous.length) return [];
  for (let i = 0; i < previous.length; i++) {
    if (previous[i] !== next[i]) return [];
  }
  const fresh: string[] = [];
  const tracked = Math.min(messages.length, next.length);
  for (let i = previous.length; i < tracked; i++) {
    const message = messages[i];
    if (message.role === "assistant" && message.provider === "web6" && message.model === CONSULT_REPLY_MODEL) {
      fresh.push(next[i]);
    }
  }
  return fresh;
}
