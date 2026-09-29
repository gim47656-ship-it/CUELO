/**
 * ChatGPT 6 Pro 상담(SHION) 브리지의 순수 로직.
 *
 * 세션 바인딩(연결번호 저장소), 상담 답변 게시용 bearer 토큰, 답변 entry 배선을 맡는다.
 * WEB6 shim(`Tools/CUELO_Setup/web6/web6-server.js`)이 `/api/gpt6/web6-session`으로 바인딩을
 * 받고, 수집한 답을 `/api/gpt6/reply`에 이 토큰으로 게시한다. 기존
 * `app/api/mcp/route.ts`(OMP가 외부 MCP를 소비하는 설정 관리 API)와는 무관하다.
 *
 * 이 파일은 파일 I/O·세션 접근·시각·난수를 전부 {@link Gpt6BridgeDeps}로 주입받는다.
 * 라우트가 배선을 맡고 이 파일은 배선을 모르므로, 만료·폐기·보존·저장소 충돌·토큰 회전이
 * 실제 파일이나 살아 있는 세션 없이 전부 검증된다.
 *
 * 저장소 전역 bearer 토큰과 연결번호별 `handleKey`는 저장소에 sha256 다이제스트로만 남고,
 * 평문은 발급·회전 응답에서 한 번 나간다.
 */
import { createHash, timingSafeEqual } from "node:crypto";

// ============================================================================
// 계약 상수
// ============================================================================

/**
 * 저장소 스키마 세대. 1은 토큰 평문 + 핸들별 비밀이 없던 판이라 승계하지 않는다
 * (아래 `parseStore` 참조 — 다른 세대의 파일은 빈 저장소로 읽는다).
 */
export const GPT6_STORE_SCHEMA_VERSION = 2;
export const GPT6_DEFAULT_TTL_MINUTES = 720;
export const GPT6_MIN_TTL_MINUTES = 1;
export const GPT6_MAX_TTL_MINUTES = 10080;
/** 4자리 번호가 겹칠 때 다시 뽑아 보는 횟수. */
export const GPT6_HANDLE_ALLOCATION_ATTEMPTS = 20;
/** 폐기·만료된 연결번호를 목록과 저장소에 남겨 두는 시간. */
export const GPT6_HANDLE_RETENTION_MS = 24 * 60 * 60 * 1000;
/** 저장소에 남기는 연결번호 기록 상한. 활성 연결번호는 이 상한으로 지우지 않는다. */
export const GPT6_MAX_STORED_HANDLES = 50;

/** 6PRO가 세션에 남기는 글의 출처 표식. 바인딩 통지 첫 줄에 붙는다. */
export const GPT6_INJECTION_LABEL = "[6PRO 경유]";

/**
 * 6PRO가 만든 답변을 남기는 custom entry 종류. 대화창 투영(`lib/session-reader.ts`)이
 * 이 값 하나로 답변을 assistant 발화로 올린다.
 */
export const GPT6_REPLY_CUSTOM_TYPE = "gpt6-reply";
/** 답변 entry의 details에 남기는 출처. 사람이 화면에서 읽는 값이다. */
export const GPT6_REPLY_SOURCE = "ChatGPT 6PRO";

/**
 * 연결번호가 세션에 묶였다는 사실을 그 세션에 남기는 custom entry 종류.
 *
 * 왜 필요한가. 에이전트는 자기 session id를 환경에서 읽지 못한다 — 저장소(`gpt6-handles.json`)에
 * `sessionId`가 있어도 자기 것인지 대조할 방법이 없다. 그래서 묶는 쪽이 알려준다.
 *
 * 왜 custom entry인가. `custom_message`는 모델 문맥에 들어가지만(코어
 * `session/session-context.ts`가 `customMessageEntryMessage`로 밀어 넣는다) **턴을 돌리지 않는다**.
 * 내부 지시문(`sendInternalPrompt`)으로 알리면 통지 한 줄에 턴 하나를 태우게 된다.
 *
 * `gpt6-reply`와 종류를 분리하는 이유는 투영이 다르기 때문이다 — 답변은 대화 본문의
 * assistant로 올라가야 하고, 이 통지는 작업 로그에 남아야 한다.
 */
export const GPT6_BINDING_CUSTOM_TYPE = "gpt6-binding";

/**
 * 바인딩 통지 본문. 에이전트가 읽고 바로 판단할 수 있게 **무엇이 켜졌는지**까지 적는다.
 * 정책 정본은 `mainLane.web6Consult`이고, 여기 적은 두 자리가 바인딩 세션의 자동 발동분이다.
 */
export function buildGpt6BindingNotice(handle: string, expiresAt: string): string {
  return [
    `${GPT6_INJECTION_LABEL} 이 세션은 6PRO 연결번호 ${handle}에 묶였다(만료 ${expiresAt}).`,
    "",
    "하네스 정책 `mainLane.web6Consult`에 따라 이 세션에서는 ChatGPT 6 Pro 상담 네 자리 중",
    "**발주 전 설계**와 **최종 판정 직전 상담** 둘이 자동으로 발동한다. 나머지 둘(경합 가설 판정,",
    "되돌리기 비싼 설계 선택)은 조건이 맞을 때 Main 재량이다.",
    "",
    "경로는 loopback shim이고 상담은 조언이다 — 분할·진단·판정은 그대로 Main이 소유한다.",
    "shim이 응답하지 않으면 막지 말고 기존 경로로 진행한 뒤 상담 없이 판정했음을 남긴다.",
  ].join("\n");
}

// ============================================================================
// 타입
// ============================================================================

export type Gpt6ErrorCode =
  | "unknown_handle"
  | "invalid_argument"
  | "invalid_token"
  | "session_not_found"
  | "handle_exhausted"
  | "store_conflict"
  | "store_unreadable";

export class Gpt6Error extends Error {
  readonly code: Gpt6ErrorCode;

  constructor(code: Gpt6ErrorCode, message: string) {
    super(message);
    this.name = "Gpt6Error";
    this.code = code;
  }
}

/** `/api/gpt6/*` 응답 상태 코드. 라우트가 이 표만 따른다. */
export function gpt6HttpStatus(code: Gpt6ErrorCode): number {
  switch (code) {
    case "unknown_handle":
    case "session_not_found":
      return 404;
    case "invalid_token":
      return 401;
    case "store_conflict":
      return 409;
    case "invalid_argument":
      return 400;
    default:
      return 500;
  }
}

export interface Gpt6HandleRecord {
  handle: string;
  cwd: string;
  sessionId: string;
  instruction: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  /** 자동 WEB6 상담이면 이 핸들을 발급하게 한 요청 id(`web6-consults.jsonl`과 대조). */
  web6RequestId?: string;
  /** 이 연결번호 전용 비밀(`handleKey`)의 sha256 16진수. 평문은 저장하지 않는다. */
  handleKeyHash: string;
}

export interface Gpt6StoreFile {
  schemaVersion: number;
  /**
   * 저장소 세대. 읽기→수정→쓰기 사이에 값이 달라졌으면 그 쓰기를 버리고 다시 읽어
   * 병합 재시도한다. 겹친 발급·폐기가 서로의 기록을 지우는 경로를 막는다.
   */
  revision: number;
  /** 전역 bearer 토큰의 sha256 16진수. 빈 문자열이면 아직 발급되지 않았다. */
  tokenHash: string;
  handles: Record<string, Gpt6HandleRecord>;
}

export type Gpt6HandleStatus = "active" | "expired" | "revoked";

export interface Gpt6HandleSummary {
  handle: string;
  cwd: string;
  sessionId: string;
  instruction: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  status: Gpt6HandleStatus;
}

export interface Gpt6IssuedHandle extends Gpt6HandleSummary {
  /**
   * 지금 이 응답에서 처음 만들어진 토큰. 이미 토큰이 있던 발급에서는 null이라 평문이
   * 다시 나가지 않는다(회전 응답만이 새 평문을 내보낸다).
   */
  token: string | null;
  /** 이 연결번호 하나에 대한 비밀. WEB6 shim은 요청 메모리에만 두고 브라우저로 보내지 않는다. */
  handleKey: string;
  startSentence: string;
}

export interface Gpt6HandleList {
  handles: Gpt6HandleSummary[];
  tokenPresent: boolean;
}

/** 브리지가 세션에 요구하는 최소 표면. 라우트가 `AgentSessionWrapper`를 이 모양으로 감싼다. */
export interface Gpt6SessionHandle {
  readonly cwd: string;
  isAlive(): boolean;
  /** 턴·압축·셸·서브에이전트 중 하나라도 돌고 있으면 true(`AgentSessionWrapper.isRunning`). */
  isRunning(): boolean;
  /**
   * 턴을 돌리지 않고 entry만 남긴다(`inner.sessionManager.appendCustomMessageEntry`).
   * 반환값은 새 entry id다. 이 경로로 들어온 글은 모델을 실행시키지 않는다.
   */
  appendCustomMessage(customType: string, content: string, display: boolean, details?: unknown): string;
}

export interface Gpt6BridgeDeps {
  readStore(): string | null;
  writeStore(contents: string): void;
  now(): Date;
  randomToken(): string;
  /** 연결번호 전용 비밀(`handleKey`). 발급마다 새로 뽑는다. */
  randomHandleKey(): string;
  /** `H-` 뒤에 붙일 4자리 십진수. */
  randomHandleDigits(): string;
  getSession(sessionId: string): Gpt6SessionHandle | undefined;
  /**
   * 이 프로세스에 살아 있지 않은 세션을 세션 기록에서 되살린다. 사용자가 WEB 탭을 닫으면
   * 세션은 레지스트리에서 사라지지만 기록(세션 파일)은 남는다 — 그 기록으로 다시 띄워,
   * 상담 답변 게시가 탭 상태에 묶이지 않게 한다.
   *
   * 기록 자체가 없으면 `undefined`다. 되살리기가 실패한 경우(예: 삭제가 진행 중)는 실패
   * 사유를 그대로 던진다 — 조용히 `undefined`로 뭉개면 "기록이 없다"로 잘못 보고된다.
   */
  resumeSession(sessionId: string): Promise<Gpt6SessionHandle | undefined>;
}

export interface Gpt6IssueInput {
  cwd: string;
  sessionId: string;
  instruction?: string;
  ttlMinutes?: number;
  /** 자동 WEB6 상담의 요청 id. 저장소 기록에 남겨 상담 기록과 대조한다. */
  web6RequestId?: string;
}

/** 핸들 없는 게시(`/api/gpt6/reply`)의 결과. */
export interface Gpt6PublishResult {
  published: true;
  entryId: string;
  /** 기록 시점에 대상 세션이 턴을 돌고 있었는지. 기록 자체는 실행과 경합하지 않는다. */
  busy: boolean;
}

export interface Gpt6Bridge {
  issueHandle(input: Gpt6IssueInput): Gpt6IssuedHandle;
  listHandles(): Gpt6HandleList;
  revokeHandle(handle: string): { handle: string; revoked: true };
  /**
   * 저장소 토큰을 교체한다. 현재 토큰을 제시하지 못하면 회전하지 않는다 — 회전 응답이
   * 새 평문 토큰을 담으므로, 증명 없는 회전은 토큰 탈취 경로가 된다.
   */
  rotateToken(currentToken: string): { token: string; rotatedAt: string };
  /** 라우트가 본문을 파싱하기 전에 401로 끊는 데 쓴다. */
  acceptsToken(token: string): boolean;
  /**
   * 핸들 없이 세션 하나에 6PRO 답변 entry만 남긴다(`/api/gpt6/reply`). 라우트가 파싱한
   * 본문을 그대로 넘기고, 살아 있지 않은 세션은 기록에서 되살린다.
   */
  publishReply(input: Record<string, unknown>): Promise<Gpt6PublishResult>;
}

// ============================================================================
// 작은 헬퍼
// ============================================================================

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Gpt6Error("invalid_argument", `${field}는 비어 있지 않은 문자열이어야 합니다.`);
  }
  return value.trim();
}

/** 저장소에 남기는 비밀의 형태(sha256 16진수). 이 모양이 아니면 비밀로 인정하지 않는다. */
const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** 비밀(전역 토큰·핸들 키)은 저장소에 다이제스트로만 남긴다. */
function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * 제시된 비밀과 저장된 다이제스트를 비교한다. 양쪽을 고정 길이로 맞춘 뒤 비교하므로
 * 길이·접두사가 새지 않고, 저장된 값이 비밀 모양이 아니면(빈 문자열 포함) 통과시키지 않는다.
 */
function hashMatches(provided: string, storedHash: string): boolean {
  if (provided === "" || !HASH_PATTERN.test(storedHash)) return false;
  const actual = createHash("sha256").update(provided, "utf8").digest();
  const expected = Buffer.from(storedHash, "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

// ============================================================================
// 브리지
// ============================================================================

export function createGpt6Bridge(deps: Gpt6BridgeDeps): Gpt6Bridge {
  /**
   * 한 요청 안에서 저장소를 여러 번 읽어도 파싱은 한 번만 한다. 토큰을 보는 401 판정과
   * 그 뒤 게시가 같은 파일을 두 번 파싱하지 않는다. 내용이 달라졌으면
   * (다른 프로세스의 쓰기) 반드시 다시 파싱한다 — revision 충돌 감지가 이 비교에 기댄다.
   * 그래서 같은 요청 안의 두 읽기는 같은 객체를 돌려줄 수 있고, 그 객체는 뒤이은
   * mutateStore가 제자리에서 고친다. 읽는 쪽은 값을 오래 붙들지 않는다.
   */
  let cachedRaw: string | null | undefined;
  let cachedStore: Gpt6StoreFile | null = null;

  function emptyStore(): Gpt6StoreFile {
    return {
      schemaVersion: GPT6_STORE_SCHEMA_VERSION,
      revision: 0,
      tokenHash: "",
      handles: {},
    };
  }

  function parseStore(raw: string | null): Gpt6StoreFile {
    if (raw === null || raw.trim() === "") return emptyStore();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Gpt6Error("store_unreadable", "핸들 저장소(gpt6-handles.json)를 JSON으로 읽을 수 없습니다.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Gpt6Error("store_unreadable", "핸들 저장소(gpt6-handles.json)의 형식이 올바르지 않습니다.");
    }
    const file = parsed as Partial<Gpt6StoreFile>;
    // 다른 세대의 파일은 승계하지 않는다. 세대 1의 평문 토큰이나 핸들 키 없는 연결번호가
    // 조용히 계속 통하는 것보다, 새 저장소로 시작해 다시 발급받는 편이 안전하다.
    if (file.schemaVersion !== GPT6_STORE_SCHEMA_VERSION) return emptyStore();
    const handles: Record<string, Gpt6HandleRecord> = {};
    if (file.handles && typeof file.handles === "object") {
      for (const [key, value] of Object.entries(file.handles)) {
        if (!value || typeof value !== "object") continue;
        const record = value as Partial<Gpt6HandleRecord>;
        if (typeof record.sessionId !== "string" || typeof record.cwd !== "string") continue;
        // 핸들 키 해시가 없는 기록은 세대 2의 연결번호가 아니다. 통과시키지 않고 버린다.
        if (typeof record.handleKeyHash !== "string" || !HASH_PATTERN.test(record.handleKeyHash)) continue;
        handles[key] = {
          handle: typeof record.handle === "string" ? record.handle : key,
          cwd: record.cwd,
          sessionId: record.sessionId,
          instruction: typeof record.instruction === "string" ? record.instruction : "",
          createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date(0).toISOString(),
          expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : new Date(0).toISOString(),
          revokedAt: typeof record.revokedAt === "string" ? record.revokedAt : null,
          ...(typeof record.web6RequestId === "string" && record.web6RequestId.trim() !== ""
            ? { web6RequestId: record.web6RequestId.trim() }
            : {}),
          handleKeyHash: record.handleKeyHash,
        };
      }
    }
    return {
      schemaVersion: GPT6_STORE_SCHEMA_VERSION,
      revision: typeof file.revision === "number" ? file.revision : 0,
      tokenHash: typeof file.tokenHash === "string" && HASH_PATTERN.test(file.tokenHash) ? file.tokenHash : "",
      handles,
    };
  }

  function readStore(): Gpt6StoreFile {
    const raw = deps.readStore();
    if (cachedStore !== null && raw === cachedRaw) return cachedStore;
    const store = parseStore(raw);
    cachedRaw = raw;
    cachedStore = store;
    return store;
  }

  /** 핸들 기록의 수명이 끝난 시각. 폐기됐으면 폐기 시각, 아니면 만료 시각이다. */
  function endedAtMs(record: Gpt6HandleRecord): number {
    return Date.parse(record.revokedAt ?? record.expiresAt);
  }

  /** 목록에 남길 기록인지. 수명이 끝난 뒤 보존 기간 안에 있는 것만 남긴다. */
  function isListed(record: Gpt6HandleRecord, nowMs: number): boolean {
    return endedAtMs(record) > nowMs - GPT6_HANDLE_RETENTION_MS;
  }

  /**
   * 수명이 끝나고 보존 기간이 지난 기록과 저장소 상한 초과분을 지운다. 상한을 넘겨도
   * 아직 살아 있는 연결번호는 지우지 않는다 — 그 연결번호는 지금 쓰이고 있다.
   */
  function pruneHandles(store: Gpt6StoreFile, nowMs: number): void {
    for (const key of Object.keys(store.handles)) {
      const record = store.handles[key];
      if (record && !isListed(record, nowMs)) delete store.handles[key];
    }
    let overflow = Object.keys(store.handles).length - GPT6_MAX_STORED_HANDLES;
    if (overflow <= 0) return;
    const ended = Object.entries(store.handles)
      .filter(([, record]) => endedAtMs(record) <= nowMs)
      .sort((left, right) => endedAtMs(left[1]) - endedAtMs(right[1]));
    for (const [key] of ended) {
      if (overflow <= 0) break;
      delete store.handles[key];
      overflow -= 1;
    }
  }

  /**
   * 읽기→수정→쓰기. 쓰기 직전에 다시 읽어 revision이 달라졌으면 그 쓰기를 버리고
   * 최신본에 다시 적용한다(1회). 겹친 발급·폐기·회전이 서로의 기록을 지우는 경로를 막고,
   * 두 번째 시도까지 실패하면 조용히 넘어가지 않고 끊는다.
   * 저장소 정리(수명 종료·상한)는 모든 쓰기가 지나는 여기서만 한다.
   */
  function mutateStore<T>(apply: (store: Gpt6StoreFile) => T): T {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const target = readStore();
      const result = apply(target);
      pruneHandles(target, deps.now().getTime());
      const latest = readStore();
      if (latest.revision !== target.revision) continue;
      target.revision += 1;
      deps.writeStore(`${JSON.stringify(target, null, 2)}\n`);
      return result;
    }
    throw new Gpt6Error("store_conflict", "핸들 저장소가 다른 호출과 충돌했습니다. 잠시 뒤 다시 시도하세요.");
  }

  function summarize(record: Gpt6HandleRecord, nowMs: number): Gpt6HandleSummary {
    const status: Gpt6HandleStatus = record.revokedAt
      ? "revoked"
      : Date.parse(record.expiresAt) <= nowMs
        ? "expired"
        : "active";
    return {
      handle: record.handle,
      cwd: record.cwd,
      sessionId: record.sessionId,
      instruction: record.instruction,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      revokedAt: record.revokedAt,
      status,
    };
  }

  function resolveTtlMinutes(value: unknown): number {
    if (value === undefined || value === null) return GPT6_DEFAULT_TTL_MINUTES;
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new Gpt6Error("invalid_argument", "ttlMinutes는 정수여야 합니다.");
    }
    if (value < GPT6_MIN_TTL_MINUTES || value > GPT6_MAX_TTL_MINUTES) {
      throw new Gpt6Error(
        "invalid_argument",
        `ttlMinutes는 ${GPT6_MIN_TTL_MINUTES}~${GPT6_MAX_TTL_MINUTES} 범위여야 합니다.`,
      );
    }
    return value;
  }

  /** 핸들 발급에서만 쓴다. 세션·cwd 실재 확인은 라우트가 발급 전에 끝낸다. */
  function issueHandle(input: Gpt6IssueInput): Gpt6IssuedHandle {
    const cwd = nonEmptyString(input.cwd, "cwd");
    const sessionId = nonEmptyString(input.sessionId, "sessionId");
    const instruction = typeof input.instruction === "string" ? input.instruction : "";
    const web6RequestId = input.web6RequestId === undefined
      ? undefined
      : nonEmptyString(input.web6RequestId, "web6RequestId");
    const ttlMinutes = resolveTtlMinutes(input.ttlMinutes);
    const nowMs = deps.now().getTime();

    return mutateStore((store) => {
      // 토큰은 아직 없을 때만 만든다. 이미 있으면 이 응답에 평문을 싣지 않는다 —
      // 평문이 나가는 자리는 여기(최초 생성)와 rotateToken 둘뿐이다.
      let token: string | null = null;
      if (store.tokenHash === "") {
        token = deps.randomToken();
        store.tokenHash = hashSecret(token);
      }
      let handle = "";
      for (let attempt = 0; attempt < GPT6_HANDLE_ALLOCATION_ATTEMPTS; attempt += 1) {
        const candidate = `H-${deps.randomHandleDigits()}`;
        if (!store.handles[candidate]) {
          handle = candidate;
          break;
        }
      }
      if (handle === "") {
        throw new Gpt6Error("handle_exhausted", "연결번호를 발급하지 못했습니다. 4자리 번호가 소진되었습니다.");
      }
      const handleKey = deps.randomHandleKey();
      const record: Gpt6HandleRecord = {
        handle,
        cwd,
        sessionId,
        instruction,
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + ttlMinutes * 60_000).toISOString(),
        revokedAt: null,
        ...(web6RequestId === undefined ? {} : { web6RequestId }),
        handleKeyHash: hashSecret(handleKey),
      };
      store.handles[handle] = record;
      return {
        ...summarize(record, nowMs),
        token,
        handleKey,
        // 발급 응답 계약(web6-server.js가 존재를 검사)에 싣는 사람용 바인딩 요약.
        startSentence: `OMP 연결번호 ${handle}에 묶인 세션의 상담이다. 작업폴더는 ${cwd}다.`,
      };
    });
  }

  /**
   * 저장소 토큰을 교체한다. 현재 토큰을 제시하지 못하면 회전하지 않는다 — 회전 응답이
   * 새 평문 토큰을 담으므로, 증명 없는 회전은 토큰 탈취 경로가 된다. 이전 토큰은 저장소에서
   * 해시가 지워지는 순간 거부된다(연결번호 기록은 그대로다).
   */
  function rotateToken(currentToken: string): { token: string; rotatedAt: string } {
    return mutateStore((store) => {
      if (!hashMatches(currentToken, store.tokenHash)) {
        throw new Gpt6Error("invalid_token", "현재 토큰이 올바르지 않습니다. 회전에는 지금 쓰는 토큰이 필요합니다.");
      }
      const token = deps.randomToken();
      store.tokenHash = hashSecret(token);
      return { token, rotatedAt: deps.now().toISOString() };
    });
  }

  function listHandles(): Gpt6HandleList {
    const store = readStore();
    const nowMs = deps.now().getTime();
    const handles = Object.values(store.handles)
      .filter((record) => isListed(record, nowMs))
      .map((record) => summarize(record, nowMs))
      .sort((left, right) => (
        right.createdAt.localeCompare(left.createdAt) || left.handle.localeCompare(right.handle)
      ));
    return {
      handles,
      tokenPresent: store.tokenHash !== "",
    };
  }

  function revokeHandle(handle: string): { handle: string; revoked: true } {
    const key = nonEmptyString(handle, "handle");
    return mutateStore((store) => {
      const record = store.handles[key];
      if (!record) throw new Gpt6Error("unknown_handle", `연결번호 ${key}를 찾을 수 없습니다.`);
      if (!record.revokedAt) record.revokedAt = deps.now().toISOString();
      return { handle: key, revoked: true as const };
    });
  }

  /**
   * 세션 하나를 브리지가 요구하는 표면으로 해소한다. 살아 있는 런타임이 없으면 세션
   * 기록에서 되살린다. 되살리지 못하면 `undefined`이고, 부르는 쪽이 session_not_found로 끊는다.
   */
  async function resolveSession(sessionId: string): Promise<Gpt6SessionHandle | undefined> {
    const live = deps.getSession(sessionId);
    const session = live?.isAlive()
      ? live
      : await deps.resumeSession(sessionId);
    return session && session.isAlive() ? session : undefined;
  }

  /**
   * 핸들 없이 세션 하나에 답변 entry만 남긴다(`/api/gpt6/reply`). custom 종류·표시 여부·
   * details 모양을 여기서만 정한다. 프롬프트가 아니므로 어떤 모델도 실행되지 않는다.
   * 재전송을 묶을 핸들 기록이 없으므로 중복 판정은 하지 않는다(호출자가 같은 본문을 두 번
   * 보내면 두 번 남는다 — WEB6 shim이 요청당 한 번만 게시한다).
   */
  async function publishReply(input: Record<string, unknown>): Promise<Gpt6PublishResult> {
    const sessionId = nonEmptyString(input.sessionId, "sessionId");
    const text = nonEmptyString(input.text, "text");
    const model = typeof input.model === "string" && input.model.trim() !== ""
      ? input.model.trim()
      : GPT6_REPLY_SOURCE;
    const session = await resolveSession(sessionId);
    if (!session) {
      throw new Gpt6Error("session_not_found", `세션 ${sessionId}의 기록을 찾을 수 없습니다.`);
    }
    const entryId = session.appendCustomMessage(GPT6_REPLY_CUSTOM_TYPE, text, true, {
      source: GPT6_REPLY_SOURCE,
      model,
    });
    return { published: true, entryId, busy: session.isRunning() };
  }

  return {
    issueHandle,
    listHandles,
    revokeHandle,
    rotateToken,
    acceptsToken: (token) => hashMatches(token, readStore().tokenHash),
    publishReply,
  };
}
