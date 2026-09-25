/**
 * ChatGPT 6 Pro 브리지의 순수 로직.
 *
 * OMP가 MCP **서버**가 되어 6 Pro의 도구 호출을 받는 반대 방향 경로다. 기존
 * `app/api/mcp/route.ts`(OMP가 외부 MCP를 소비하는 설정 관리 API)와 무관하며 그쪽을
 * 재사용하지 않는다.
 *
 * 이 파일은 파일 I/O·세션 접근·시각·난수를 전부 {@link Gpt6BridgeDeps}로 주입받는다.
 * 라우트가 배선을 맡고 이 파일은 배선을 모르므로, 만료·폐기·스냅샷 불변·중복 전송
 * 차단이 실제 파일이나 살아 있는 세션 없이 전부 검증된다.
 *
 * 인증은 두 층이다. 저장소 전역 bearer 토큰은 커넥터 하나를 식별할 뿐이고, 연결번호
 * 하나에 대한 권한은 발급 때 만든 `handleKey`가 쥔다. 그래서 전역 토큰을 가진 호출자가
 * 4자리 번호를 순회해도 남의 연결번호에는 닿지 못한다. 두 비밀 모두 저장소에는 sha256
 * 다이제스트로만 남고, 평문은 발급·회전 응답에서 한 번 나간다.
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
export const GPT6_PROTOCOL_VERSION = "2025-06-18";
export const GPT6_SERVER_NAME = "omp-gpt6-bridge";
/** package.json의 version과 함께 올린다(화면 하단 `web v…`와 같은 값). */
export const GPT6_SERVER_VERSION = "0.4.4";
/** 키 없는 재전송을 같은 지시로 보는 창. 이 밖의 재전송은 의도된 전송으로 본다. */
export const GPT6_IMPLICIT_DEDUPE_WINDOW_MS = 60_000;
/** 핸들별 최근 전송 기록 링버퍼 크기. */
export const GPT6_RECENT_SENDS_MAX = 20;
/** 4자리 번호가 겹칠 때 다시 뽑아 보는 횟수. */
export const GPT6_HANDLE_ALLOCATION_ATTEMPTS = 20;
/**
 * 핸들 해소 실패를 세는 창과 그 창에서 허용하는 최대 실패 수. 창은 "마지막 실패로부터
 * 이 시간"이라, 실패가 이어지는 동안은 같은 창으로 세고 조용한 시간이 지나면 새 창이 열린다.
 */
export const GPT6_AUTH_FAILURE_WINDOW_MS = 60_000;
export const GPT6_AUTH_FAILURE_MAX = 10;
/** 폐기·만료된 연결번호를 목록과 저장소에 남겨 두는 시간. */
export const GPT6_HANDLE_RETENTION_MS = 24 * 60 * 60 * 1000;
/** 저장소에 남기는 연결번호 기록 상한. 활성 연결번호는 이 상한으로 지우지 않는다. */
export const GPT6_MAX_STORED_HANDLES = 50;
export const GPT6_MAX_RESULT_ENTRIES = 50;
export const GPT6_DEFAULT_RESULT_ENTRIES = 20;
export const GPT6_MAX_ENTRY_TEXT_CHARS = 4_000;
/** 프롬프트 수락 뒤 세션 entry에 사용자 메시지가 붙기를 기다리는 상한. */
export const GPT6_ENTRY_WAIT_MS = 1_500;
export const GPT6_ENTRY_POLL_MS = 30;

/** JSON-RPC 에러 코드. `-32000`대는 서버 정의 영역이다. */
export const GPT6_RPC_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unauthorized: -32000,
  handleRejected: -32001,
} as const;

/**
 * 6PRO가 주입한 지시는 사용자가 직접 입력한 것과 같은 `user` 역할로 세션에 들어간다.
 * 그래서 본문 첫 줄에 출처를 남긴다 — 이게 없으면 대화를 읽는 쪽에서 둘을 구분할 수 없다.
 */
export const GPT6_INJECTION_LABEL = "[6PRO 경유]";

/**
 * 6PRO가 만든 답변을 남기는 custom entry 종류. 화면 머리글과 재조회 필터가 이 값 하나를
 * 본다 — `omp_get_result`는 이 종류만 `role:"gpt6"`으로 투영한다.
 */
export const GPT6_REPLY_CUSTOM_TYPE = "gpt6-reply";
/** 답변 entry의 details에 남기는 출처. 사람이 화면에서 읽는 값이다. */
export const GPT6_REPLY_SOURCE = "ChatGPT 6PRO";
/**
 * 실행 전용 지시의 서두 표식. 6PRO가 확정한 브리프를 그대로 실행 계약으로 쓰게 하고,
 * 사용자에게 하는 답변(`omp_publish_reply`)과 실행 발주를 화면에서 구분한다.
 */
export const GPT6_DISPATCH_LABEL = "[6PRO 발주]";

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

/** 핸들 해소가 거부되는 이유. 각각 고유 코드로 끊는다 — 조용한 폴백은 없다. */
export type Gpt6RejectCode =
  | "unknown_handle"
  | "handle_unauthorized"
  | "handle_expired"
  | "handle_revoked"
  | "session_missing"
  | "cwd_mismatch"
  | "too_many_failures";

export type Gpt6ErrorCode =
  | Gpt6RejectCode
  | "invalid_argument"
  | "invalid_token"
  | "session_not_found"
  | "session_busy"
  | "send_failed"
  | "publish_failed"
  | "handle_exhausted"
  | "store_conflict"
  | "store_unreadable";

/** 해소 실패를 -32001 핸들 거부로 내보내는 코드인지. */
function isRejectCode(code: Gpt6ErrorCode): code is Gpt6RejectCode {
  switch (code) {
    case "unknown_handle":
    case "handle_unauthorized":
    case "handle_expired":
    case "handle_revoked":
    case "session_missing":
    case "cwd_mismatch":
    case "too_many_failures":
      return true;
    default:
      return false;
  }
}

export class Gpt6Error extends Error {
  readonly code: Gpt6ErrorCode;

  constructor(code: Gpt6ErrorCode, message: string) {
    super(message);
    this.name = "Gpt6Error";
    this.code = code;
  }
}

/** `/api/gpt6/handles`·`/api/gpt6/token` 응답 상태 코드. 라우트가 이 표만 따른다. */
export function gpt6HttpStatus(code: Gpt6ErrorCode): number {
  switch (code) {
    case "unknown_handle":
    case "session_not_found":
      return 404;
    case "invalid_token":
    case "handle_unauthorized":
      return 401;
    case "too_many_failures":
      return 429;
    case "handle_revoked":
    case "handle_expired":
    case "cwd_mismatch":
    case "session_busy":
    case "store_conflict":
      return 409;
    case "invalid_argument":
      return 400;
    default:
      return 500;
  }
}

/** 핸들 하나에 남는 최근 전송 기록. dedupe 판단의 유일한 근거다. */
export interface Gpt6SendRecord {
  /** `id:` + idempotencyKey, 또는 `msg:` + message sha256. */
  key: string;
  /** 이 전송이 남긴 커서(세션 entry id). 전송 중 예약 상태에서는 빈 문자열. */
  entryId: string;
  sentAt: string;
  messageHash: string;
}

export interface Gpt6HandleRecord {
  handle: string;
  cwd: string;
  sessionId: string;
  instruction: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastCallAt: string | null;
  callCount: number;
  recentSends: Gpt6SendRecord[];
  /** 자동 WEB6 상담이면 이 핸들이 완성할 요청. 일반 수동 핸들에는 없다. */
  web6RequestId?: string;
  /** 이 연결번호 전용 비밀(`handleKey`)의 sha256 16진수. 평문은 저장하지 않는다. */
  handleKeyHash: string;
}

export interface Gpt6StoreFile {
  schemaVersion: number;
  /**
   * 저장소 세대. 읽기→수정→쓰기 사이에 값이 달라졌으면 그 쓰기를 버리고 다시 읽어
   * 병합 재시도한다. 동시 MCP 호출이 `callCount`나 dedupe 기록을 지우는 경로를 막는다.
   */
  revision: number;
  /** 전역 bearer 토큰의 sha256 16진수. 빈 문자열이면 아직 발급되지 않았다. */
  tokenHash: string;
  /** 현재 실패 창에서 센 핸들 해소 실패 수와 그 창의 마지막 실패 시각. */
  failedAuthCount: number;
  lastFailedAt: string | null;
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
  lastCallAt: string | null;
  callCount: number;
  status: Gpt6HandleStatus;
}

export interface Gpt6IssuedHandle extends Gpt6HandleSummary {
  /**
   * 지금 이 응답에서 처음 만들어진 토큰. 이미 토큰이 있던 발급에서는 null이라 평문이
   * 다시 나가지 않는다(회전 응답만이 새 평문을 내보낸다).
   */
  token: string | null;
  /** 이 연결번호 하나에 대한 비밀. 시작 문장에 담겨 대화 본문에 남는다. */
  handleKey: string;
  startSentence: string;
}

export interface Gpt6HandleList {
  handles: Gpt6HandleSummary[];
  tokenPresent: boolean;
  /** 최근 실패 창에서 센 핸들 해소 실패 수. 창이 지났으면 0으로 본다. */
  failedAuthCount: number;
  /** 그 창의 마지막 실패 시각. 창이 지났으면 null. */
  lastFailedAt: string | null;
}

/** 브리지가 세션에 요구하는 최소 표면. 라우트가 `AgentSessionWrapper`를 이 모양으로 감싼다. */
export interface Gpt6SessionHandle {
  readonly cwd: string;
  isAlive(): boolean;
  /** 턴·압축·셸·서브에이전트 중 하나라도 돌고 있으면 true(`AgentSessionWrapper.isRunning`). */
  isRunning(): boolean;
  send(command: Record<string, unknown>): Promise<unknown>;
  /** 세션 entry 배열(`inner.sessionManager.getEntries()`). */
  entries(): readonly unknown[];
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
   * 이 프로세스에 살아 있지 않은 세션을 세션 기록에서 되살린다. 발급 뒤 사용자가 WEB 탭을
   * 닫으면 세션은 레지스트리에서 사라지지만 기록(세션 파일)은 남는다 — 그 기록으로 다시
   * 띄워, 6 Pro의 도구 호출이 탭 상태에 묶이지 않게 한다.
   *
   * 기록 자체가 없으면 `undefined`다. 되살리기가 실패한 경우(예: 삭제가 진행 중)는 실패
   * 사유를 그대로 던진다 — 조용히 `undefined`로 뭉개면 "기록이 없다"로 잘못 보고된다.
   */
  resumeSession(sessionId: string): Promise<Gpt6SessionHandle | undefined>;
  wait(ms: number): Promise<void>;
}

export interface Gpt6IssueInput {
  cwd: string;
  sessionId: string;
  instruction?: string;
  ttlMinutes?: number;
  /** 자동 WEB6 상담의 요청 id. 이 값이 있으면 publish는 발급 requestId와 같은 requestId·idempotencyKey를 요구한다. */
  web6RequestId?: string;
}

export interface Gpt6JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface Gpt6JsonRpcError {
  code: number;
  message: string;
  data?: Record<string, unknown>;
}

export interface Gpt6JsonRpcResponse {
  jsonrpc: "2.0";
  id: unknown;
  result?: unknown;
  error?: Gpt6JsonRpcError;
}

export interface Gpt6ToolResult {
  payload: Record<string, unknown>;
  /** true면 MCP 결과의 `isError`로 나간다(JSON-RPC error가 아니다). */
  isError: boolean;
}

/**
 * 도구 광고값. MCP 2025-06-18 `ToolAnnotations`의 이름을 그대로 쓴다 — 클라이언트(ChatGPT
 * 개발자 모드 등)가 확인·차단 게이트를 정할 때 읽는 값이다. 서버 쪽 권한 판정에는 쓰지
 * 않는다: 권한은 언제나 `handleKey` 검사가 정한다.
 */
export interface Gpt6ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface Gpt6ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Gpt6ToolAnnotations;
}

/**
 * 핸들 없는 게시(`/api/gpt6/reply`)의 결과. `omp_publish_reply`가 돌려주는 값에서 중복
 * 판정(`deduped`)만 빠진다 — 그 경로에는 재전송을 묶을 핸들 기록이 없다.
 */
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
  /** 라우트가 JSON-RPC 본문을 파싱하기 전에 401로 끊는 데 쓴다. */
  acceptsToken(token: string): boolean;
  dispatch(request: unknown, auth: { token: string }): Promise<Gpt6JsonRpcResponse | null>;
  /**
   * 핸들 없이 세션 하나에 6PRO 답변 entry만 남긴다(`/api/gpt6/reply`). 값 검증은 도구
   * 인자와 같은 규칙을 쓰므로 라우트가 파싱한 본문을 그대로 넘긴다. 살아 있지 않은
   * 세션은 기록에서 되살린다 — `omp_publish_reply`와 같은 해소·같은 배선을 지난다.
   */
  publishReply(input: Record<string, unknown>): Promise<Gpt6PublishResult>;
}

// ============================================================================
// 도구 정의
// ============================================================================

const HANDLE_PROPERTY = {
  type: "string",
  description: "WEB 6PRO 탭에서 발급한 연결번호(예: H-1042).",
} as const;

const HANDLE_KEY_PROPERTY = {
  type: "string",
  description:
    "시작 문장에 포함된 handleKey를 그대로 전달한다. 그 연결번호를 인증하는 인자이며 다른 연결번호에는 통하지 않는다.",
} as const;

export const GPT6_TOOLS: readonly Gpt6ToolDefinition[] = [
  {
    name: "omp_resume_handle",
    description:
      "연결번호를 OMP 세션 스냅샷으로 되돌린다. 반환된 cwd·sessionId·instruction이 이 연결번호가 가리키는 작업이다.",
    annotations: {
      title: "OMP 연결번호 불러오기",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: { handle: HANDLE_PROPERTY, handleKey: HANDLE_KEY_PROPERTY },
      required: ["handle", "handleKey"],
      additionalProperties: false,
    },
  },
  {
    name: "omp_send_instruction",
    description:
      "연결번호에 묶인 OMP 세션에 지시문을 사용자 요청으로 전달한다. 대상 세션이 이미 턴을 돌고 있으면 session_busy로 거부하니 omp_get_status로 확인한 뒤 재시도한다. 응답을 못 받아 같은 호출을 다시 보낼 때는 같은 idempotencyKey를 쓰면 재전송되지 않는다.",
    annotations: {
      title: "OMP 세션에 지시 전달",
      readOnlyHint: false,
      destructiveHint: false,
      // 같은 인자의 재호출이 언제나 무효과인 것은 아니다 — 중복 제거는 idempotencyKey를
      // 준 경우와 60초 창 안의 같은 message뿐이고, 그 밖에는 다시 전달된다.
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        handle: HANDLE_PROPERTY,
        handleKey: HANDLE_KEY_PROPERTY,
        message: { type: "string", description: "OMP 세션에 전달할 지시문." },
        idempotencyKey: {
          type: "string",
          description: "같은 논리 호출을 식별하는 키. 생략하면 message 해시로 60초 안의 재전송을 막는다.",
        },
      },
      required: ["handle", "handleKey", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "omp_get_status",
    description: "연결번호가 묶인 세션의 현재 상태(턴 진행 여부·모델·서브에이전트 수·마지막 entry)를 조회한다.",
    annotations: {
      title: "OMP 세션 상태 조회",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: { handle: HANDLE_PROPERTY, handleKey: HANDLE_KEY_PROPERTY },
      required: ["handle", "handleKey"],
      additionalProperties: false,
    },
  },
  {
    name: "omp_get_result",
    description:
      "연결번호가 묶인 세션의 대화 entry를 조회한다. sinceEntryId 뒤의 entry만 주며, 생략하면 최근 것만 준다. truncated가 true면 잘렸으니 마지막 entry id를 다음 sinceEntryId로 이어 읽는다. entry에 failure가 있으면 그 턴은 실패로 끝난 것이다 — text가 비어 있어도 답이 없는 것이 아니라 failure.message가 사유다.",
    annotations: {
      title: "OMP 세션 결과 조회",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        handle: HANDLE_PROPERTY,
        handleKey: HANDLE_KEY_PROPERTY,
        sinceEntryId: { type: "string", description: "이 entry id 뒤의 것만 받는다." },
      },
      required: ["handle", "handleKey"],
      additionalProperties: false,
    },
  },
  {
    name: "omp_publish_reply",
    description:
      "6PRO의 답변 원문을 handle+handleKey로 묶인 OMP 세션에 기록한다. WEB6 자동 상담 핸들이면 발급 문장에 든 requestId를 requestId와 idempotencyKey에 동일하게 넣어야 한다.",
    annotations: {
      title: "6PRO 답변 기록",
      readOnlyHint: false,
      destructiveHint: false,
      // 같은 본문을 다시 올리면 60초 창(또는 같은 idempotencyKey) 안에서만 한 건으로 묶인다.
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        handle: HANDLE_PROPERTY,
        handleKey: HANDLE_KEY_PROPERTY,
        text: { type: "string", description: "화면에 그대로 남길 답변 원문." },
        requestId: {
          type: "string",
          description: "이 답변이 대응하는 질문·작업 식별자. WEB6 자동 상담은 발급 문장의 requestId를 그대로 쓴다.",
        },
        idempotencyKey: {
          type: "string",
          description: "같은 논리 호출을 식별하는 키. WEB6 자동 상담은 requestId와 같은 값을 써야 한다.",
        },
      },
      required: ["handle", "handleKey", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "omp_dispatch",
    description:
      "확정한 브리프를 실행 계약으로 보낸다. OMP는 요구를 다시 해석하지 않고 이 본문대로 실행한다. 대상 세션이 이미 턴을 돌고 있으면 session_busy로 거부하니 omp_get_status로 확인한 뒤 재시도한다. 사용자에게 하는 답변에는 쓰지 않는다(omp_publish_reply).",
    annotations: {
      title: "OMP 실행 발주",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        handle: HANDLE_PROPERTY,
        handleKey: HANDLE_KEY_PROPERTY,
        brief: {
          type: "string",
          description: "대상·변경·수용 조건이 든 브리프 전문. 이 본문이 그대로 실행 계약이 된다.",
        },
        idempotencyKey: {
          type: "string",
          description: "같은 논리 호출을 식별하는 키. 생략하면 본문 해시로 60초 안의 재전송을 막는다.",
        },
      },
      required: ["handle", "handleKey", "brief"],
      additionalProperties: false,
    },
  },
] as const;

// ============================================================================
// 작은 헬퍼
// ============================================================================

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Gpt6Error("invalid_argument", `${field} 인자가 필요합니다.`);
  }
  return value.trim();
}

/**
 * 연결번호의 cwd와 살아 있는 세션 cwd를 비교 가능한 형태로 만든다. OMP WEB의 주
 * 대상이 Windows라 대소문자와 구분자 차이를 흡수한다.
 */
function normalizeCwd(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function projectNameOf(cwd: string): string {
  const parts = cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || cwd;
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

/**
 * 6 Pro 대화에 붙여넣는 시작 문장. 연결번호·작업폴더·핸들 키가 이 한 문장에 다 들어 있어야
 * 6 Pro가 도구 인자를 스스로 채울 수 있다.
 */
function buildStartSentence(handle: string, cwd: string, handleKey: string): string {
  return `OMP 연결번호 ${handle}의 작업을 불러와서 메인으로 진행해. 작업폴더는 ${cwd}다. `
    + `omp_* 도구를 부를 때 handle에는 ${handle}, handleKey에는 ${handleKey}를 그대로 넣어. `
    + "사용자에게 하는 답변은 omp_publish_reply로 원문을 그대로 올려 — 그 도구는 OMP 모델을 실행하지 않는다. "
    + "실제 작업이 필요할 때만 omp_dispatch에 브리프를 실어 보내고, 결과는 omp_get_result로 확인해.";
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string" && record.text) parts.push(record.text);
  }
  return parts.join("\n");
}

interface Gpt6EntryView {
  id: string;
  role: string;
  text: string;
  /** 실패로 끝난 턴만 채운다. text가 비어 있는 이유가 여기에 있다. */
  failure?: Gpt6EntryFailure;
}

/** 실행이 실패로 끝난 turn의 사유. 모델·상태 코드까지 남겨야 원인을 6PRO가 판단할 수 있다. */
interface Gpt6EntryFailure {
  stopReason: string;
  message: string;
  status?: number;
  model?: string;
}

/**
 * 실패 사유. `stopReason:"error"`가 아니면 null이다. 사용량 한도·429로 끝난 턴은 content가
 * 비어 있고 사유는 entry의 이 필드들에만 남으므로, 버리면 "빈 답변"으로 보인다.
 */
function failureOf(payload: Record<string, unknown>): Gpt6EntryFailure | null {
  if (payload.stopReason !== "error") return null;
  const provider = typeof payload.provider === "string" ? payload.provider : "";
  const id = typeof payload.model === "string" ? payload.model : "";
  const model = provider && id ? `${provider}/${id}` : id || provider;
  return {
    stopReason: "error",
    message: typeof payload.errorMessage === "string" ? payload.errorMessage : "",
    ...(typeof payload.errorStatus === "number" ? { status: payload.errorStatus } : {}),
    ...(model ? { model } : {}),
  };
}

/**
 * 6PRO가 읽어야 하는 entry만 `{id, role, text}`로 투영한다. 대화 메시지(`type:"message"`)와
 * 6PRO가 직접 올린 답변(`GPT6_REPLY_CUSTOM_TYPE`)이 대상이고, 후자는 `role:"gpt6"`이다.
 */
function messageEntriesOf(session: Gpt6SessionHandle): Gpt6EntryView[] {
  const views: Gpt6EntryView[] = [];
  for (const entry of session.entries()) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id === "") continue;
    if (record.type === "custom_message") {
      // 6PRO 답변만 본다. 다른 확장의 custom entry는 이 창의 대화가 아니다.
      if (record.customType !== GPT6_REPLY_CUSTOM_TYPE) continue;
      views.push({ id: record.id, role: "gpt6", text: textOfContent(record.content) });
      continue;
    }
    if (record.type !== "message") continue;
    const message = record.message;
    if (!message || typeof message !== "object") continue;
    const payload = message as Record<string, unknown>;
    const role = typeof payload.role === "string" ? payload.role : "unknown";
    const failure = failureOf(payload);
    views.push({
      id: record.id,
      role,
      text: textOfContent(payload.content),
      ...(failure ? { failure } : {}),
    });
  }
  return views;
}

function lastEntryIdOf(session: Gpt6SessionHandle): string | undefined {
  const entries = session.entries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as Record<string, unknown>).id;
    if (typeof id === "string" && id !== "") return id;
  }
  return undefined;
}

function recordOf(state: unknown): Record<string, unknown> {
  return state && typeof state === "object" ? (state as Record<string, unknown>) : {};
}

function isBusy(session: Gpt6SessionHandle, state: unknown): boolean {
  if (session.isRunning()) return true;
  const payload = recordOf(state);
  return payload.isStreaming === true || payload.isPromptRunning === true;
}

function modelLabelOf(state: unknown): string | null {
  const model = recordOf(state).model;
  if (!model || typeof model !== "object") return null;
  const payload = model as Record<string, unknown>;
  const id = typeof payload.id === "string" ? payload.id : "";
  const provider = typeof payload.provider === "string" ? payload.provider : "";
  if (!id && !provider) return null;
  return provider && id ? `${provider}/${id}` : id || provider;
}

function runningAgentsOf(state: unknown): number {
  const subagents = recordOf(state).subagents;
  if (!Array.isArray(subagents)) return 0;
  return subagents.filter((agent) => {
    if (!agent || typeof agent !== "object") return false;
    return (agent as Record<string, unknown>).status === "running";
  }).length;
}

// ============================================================================
// 브리지
// ============================================================================

export function createGpt6Bridge(deps: Gpt6BridgeDeps): Gpt6Bridge {
  /**
   * 한 요청 안에서 저장소를 여러 번 읽어도 파싱은 한 번만 한다. 토큰을 보는 401 판정과
   * 그 뒤 디스패치가 같은 파일을 두 번 파싱하던 비용이 사라진다. 내용이 달라졌으면
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
      failedAuthCount: 0,
      lastFailedAt: null,
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
        // 핸들 키 해시가 없는 기록은 그 연결번호를 인증할 수 없다. 통과시키지 않고 버린다.
        if (typeof record.handleKeyHash !== "string" || !HASH_PATTERN.test(record.handleKeyHash)) continue;
        handles[key] = {
          handle: typeof record.handle === "string" ? record.handle : key,
          cwd: record.cwd,
          sessionId: record.sessionId,
          instruction: typeof record.instruction === "string" ? record.instruction : "",
          createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date(0).toISOString(),
          expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : new Date(0).toISOString(),
          revokedAt: typeof record.revokedAt === "string" ? record.revokedAt : null,
          lastCallAt: typeof record.lastCallAt === "string" ? record.lastCallAt : null,
          callCount: typeof record.callCount === "number" ? record.callCount : 0,
          recentSends: Array.isArray(record.recentSends)
            ? record.recentSends.filter((send): send is Gpt6SendRecord => (
              !!send && typeof send === "object" && typeof (send as Gpt6SendRecord).key === "string"
            ))
            : [],
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
      failedAuthCount: typeof file.failedAuthCount === "number" ? file.failedAuthCount : 0,
      lastFailedAt: typeof file.lastFailedAt === "string" ? file.lastFailedAt : null,
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
   * 최신본에 다시 적용한다(1회). 두 MCP 호출이 겹쳐 `callCount`나 dedupe 기록이
   * 사라지는 경로를 막고, 두 번째 시도까지 실패하면 조용히 넘어가지 않고 끊는다.
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
      lastCallAt: record.lastCallAt,
      callCount: record.callCount,
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

  /** 마지막 실패로부터 아직 창 안인지. 창 밖이면 지난 실패 수는 0으로 본다. */
  function withinFailureWindow(store: Gpt6StoreFile, nowMs: number): boolean {
    if (!store.lastFailedAt) return false;
    const last = Date.parse(store.lastFailedAt);
    return Number.isFinite(last) && nowMs - last <= GPT6_AUTH_FAILURE_WINDOW_MS;
  }

  /**
   * 핸들 해소 실패 한 건을 기록하고, 이번 시도까지 창 안의 실패가 상한을 넘었는지 돌려준다.
   * 창은 "마지막 실패로부터 60초"라 실패가 이어지면 같은 창으로 세고, 조용한 시간이 지나면
   * 다음 실패가 새 창을 연다. 성공한 호출은 여기를 지나지 않으므로, 잠금은 실패하는
   * 해소에만 걸린다 — 정답 키를 가진 호출은 잠금 중에도 그대로 진행한다.
   */
  function recordAuthFailure(): boolean {
    return mutateStore((store) => {
      const nowMs = deps.now().getTime();
      store.failedAuthCount = withinFailureWindow(store, nowMs) ? store.failedAuthCount + 1 : 1;
      store.lastFailedAt = new Date(nowMs).toISOString();
      return store.failedAuthCount > GPT6_AUTH_FAILURE_MAX;
    });
  }

  /** 해소 실패를 기록한 뒤 원래 사유로 끊는다. 상한을 넘었으면 그 사실만 알린다. */
  function rejectHandleResolve(code: Gpt6RejectCode, message: string): never {
    if (recordAuthFailure()) {
      throw new Gpt6Error(
        "too_many_failures",
        `연결번호 해소 실패가 ${GPT6_AUTH_FAILURE_WINDOW_MS / 1000}초 안에 ${GPT6_AUTH_FAILURE_MAX}회를 넘었습니다.`
          + " 잠시 뒤 다시 시도하세요.",
      );
    }
    throw new Gpt6Error(code, message);
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
        lastCallAt: null,
        callCount: 0,
        recentSends: [],
        ...(web6RequestId === undefined ? {} : { web6RequestId }),
        handleKeyHash: hashSecret(handleKey),
      };
      store.handles[handle] = record;
      return {
        ...summarize(record, nowMs),
        token,
        handleKey,
        startSentence: buildStartSentence(handle, cwd, handleKey),
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
    const active = withinFailureWindow(store, nowMs);
    const handles = Object.values(store.handles)
      .filter((record) => isListed(record, nowMs))
      .map((record) => summarize(record, nowMs))
      .sort((left, right) => (
        right.createdAt.localeCompare(left.createdAt) || left.handle.localeCompare(right.handle)
      ));
    return {
      handles,
      tokenPresent: store.tokenHash !== "",
      failedAuthCount: active ? store.failedAuthCount : 0,
      lastFailedAt: active ? store.lastFailedAt : null,
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
   * 기록에서 되살린다 — 핸들 경로(`omp_publish_reply`)와 핸들 없는 경로
   * (`/api/gpt6/reply`)가 이 순서 하나를 함께 쓴다. 되살리지 못하면 `undefined`이고,
   * 어떤 코드로 끊을지는 부르는 쪽이 정한다(session_missing·session_not_found).
   */
  async function resolveSession(sessionId: string): Promise<Gpt6SessionHandle | undefined> {
    const live = deps.getSession(sessionId);
    const session = live?.isAlive()
      ? live
      : await deps.resumeSession(sessionId);
    return session && session.isAlive() ? session : undefined;
  }

  /**
   * 6PRO 답변 entry를 남기는 유일한 배선 — custom 종류·표시 여부·details 모양을 여기서만
   * 정한다. `omp_publish_reply`(핸들 경로)와 `/api/gpt6/reply`(핸들 없는 경로)가 함께
   * 쓰므로, 두 경로가 남긴 entry는 투영에서도 구분되지 않는다. 프롬프트가 아니므로
   * 어떤 모델도 실행되지 않는다.
   */
  function appendReplyEntry(
    session: Gpt6SessionHandle,
    text: string,
    fields: { handle?: string; model?: string; requestId?: string },
  ): string {
    const details = {
      source: GPT6_REPLY_SOURCE,
      ...(fields.handle ? { handle: fields.handle } : {}),
      ...(fields.model ? { model: fields.model } : {}),
      ...(fields.requestId ? { requestId: fields.requestId } : {}),
    };
    return session.appendCustomMessage(GPT6_REPLY_CUSTOM_TYPE, text, true, details);
  }

  /**
   * 연결번호 하나를 `{기록, 살아 있는 세션}`으로 해소한다. 핸들 키는 그 연결번호 전용
   * 비밀이라, 전역 토큰만 가진 호출자는 번호를 알아도 여기를 지나지 못한다. 실패는 전부
   * 고유 코드로 끊고, 다른 세션으로 대체하거나 스냅샷을 세션의 현재 cwd로 덮어쓰지 않는다.
   * `cwd`가 발급 시점 스냅샷이라, 세션이 다른 폴더로 옮겨졌으면 cwd_mismatch다.
   *
   * 세션이 이 WEB 프로세스에 살아 있지 않으면(탭을 닫았거나 프로세스가 다시 떠서) 세션
   * 기록에서 되살려 진행한다. 되살리지 못했을 때만 `session_missing`으로 끊는다 — 발급받은
   * 연결번호가 탭 하나의 수명에 묶이면 6 Pro의 왕복이 사용자 조작 없이 끊긴다.
   *
   * 해소에 성공하면 그 자리에서 호출 흔적을 남긴다. 열람(resume/status/result)도, 운용이
   * 거부된 호출(session_busy)도 6PRO 탭에 보여야 하므로 성공 여부와 무관하게 센다.
   */
  async function requireHandle(
    handle: unknown,
    handleKey: unknown,
  ): Promise<{ record: Gpt6HandleRecord; session: Gpt6SessionHandle }> {
    const key = nonEmptyString(handle, "handle");
    const record = readStore().handles[key];
    if (!record) rejectHandleResolve("unknown_handle", `연결번호 ${key}를 찾을 수 없습니다.`);
    if (!hashMatches(typeof handleKey === "string" ? handleKey : "", record.handleKeyHash)) {
      rejectHandleResolve("handle_unauthorized", `연결번호 ${record.handle}의 handleKey가 올바르지 않습니다.`);
    }
    if (record.revokedAt) throw new Gpt6Error("handle_revoked", `연결번호 ${record.handle}는 폐기되었습니다.`);
    if (Date.parse(record.expiresAt) <= deps.now().getTime()) {
      throw new Gpt6Error("handle_expired", `연결번호 ${record.handle}는 만료되었습니다.`);
    }
    const session = await resolveSession(record.sessionId);
    if (!session) {
      throw new Gpt6Error(
        "session_missing",
        `세션 ${record.sessionId}의 기록을 찾을 수 없습니다.`
          + " 이 세션이 삭제되었으면 6PRO 탭에서 연결번호를 새로 발급하세요.",
      );
    }
    if (normalizeCwd(session.cwd) !== normalizeCwd(record.cwd)) {
      throw new Gpt6Error(
        "cwd_mismatch",
        `세션 ${record.sessionId}의 작업폴더(${session.cwd})가 연결번호의 스냅샷(${record.cwd})과 다릅니다.`,
      );
    }
    mutateStore((store) => {
      const target = store.handles[record.handle];
      if (!target) return;
      target.callCount += 1;
      target.lastCallAt = deps.now().toISOString();
    });
    return { record, session };
  }

  function dedupeKeyOf(idempotencyKey: unknown, message: string): { key: string; explicit: boolean; messageHash: string } {
    const messageHash = createHash("sha256").update(message, "utf8").digest("hex");
    if (typeof idempotencyKey === "string" && idempotencyKey.trim() !== "") {
      return { key: `id:${idempotencyKey.trim()}`, explicit: true, messageHash };
    }
    return { key: `msg:${messageHash}`, explicit: false, messageHash };
  }

  /** 이미 라벨이 붙은 문장에는 다시 붙이지 않는다 — 6PRO가 직접 붙여 보낼 수도 있다. */
  function labelInjectedMessage(message: string): string {
    return message.startsWith(GPT6_INJECTION_LABEL) ? message : `${GPT6_INJECTION_LABEL}\n${message}`;
  }

  /** 키가 있는 재전송은 언제나, 키 없는 재전송은 60초 안에서만 같은 전송으로 본다. */
  function findRecentSend(
    record: Gpt6HandleRecord,
    key: string,
    explicit: boolean,
    nowMs: number,
  ): Gpt6SendRecord | undefined {
    const found = record.recentSends.find((send) => send.key === key);
    if (!found) return undefined;
    if (!explicit && nowMs - Date.parse(found.sentAt) > GPT6_IMPLICIT_DEDUPE_WINDOW_MS) return undefined;
    return found;
  }

  async function waitForNewEntryId(
    session: Gpt6SessionHandle,
    beforeId: string | undefined,
  ): Promise<string | undefined> {
    for (let waited = 0; waited <= GPT6_ENTRY_WAIT_MS; waited += GPT6_ENTRY_POLL_MS) {
      const observed = lastEntryIdOf(session);
      if (observed !== undefined && observed !== beforeId) return observed;
      if (waited === GPT6_ENTRY_WAIT_MS) break;
      await deps.wait(GPT6_ENTRY_POLL_MS);
    }
    return undefined;
  }

  /**
   * 브리프를 실행 계약으로 감싼다. 라벨은 출처 표기이자 재해석 금지 표시다 — 6PRO가
   * 이미 확정한 요구를 OMP가 다시 정하면 두 곳이 서로 다른 계약을 보게 된다.
   */
  function dispatchPrompt(brief: string): string {
    return `${GPT6_DISPATCH_LABEL}\n`
      + "아래 브리프는 6PRO가 확정한 실행 계약이다. 요구와 수용 조건을 다시 해석하거나 바꾸지 말고 그대로 실행해라.\n"
      + "빠진 정보나 모순이 있으면 임의로 채우지 말고 그 지점만 보고해라. 위임하면 이 본문을 과제에 그대로 실어라.\n"
      + `--- 브리프 ---\n${brief}`;
  }

  /**
   * 세션에 사용자 역할 프롬프트를 넣는 유일한 경로. `namespace`는 도구별 dedupe 칸을
   * 나눈다 — 같은 본문을 `omp_send_instruction`과 `omp_dispatch`로 보내는 것은 서로 다른
   * 호출이므로 한쪽이 다른 쪽의 예약에 걸리면 안 된다.
   */
  async function injectPrompt(
    body: string,
    args: Record<string, unknown>,
    namespace: string,
    compose: (body: string) => string,
  ): Promise<Gpt6ToolResult> {
    const { record, session } = await requireHandle(args.handle, args.handleKey);
    const { key: baseKey, explicit, messageHash } = dedupeKeyOf(args.idempotencyKey, body);
    const key = namespace === "" ? baseKey : `${namespace}/${baseKey}`;
    const nowMs = deps.now().getTime();

    const seen = findRecentSend(record, key, explicit, nowMs);
    if (seen) {
      // 예약만 있고 아직 entry가 없는 상태는 지금 전송이 진행 중이라는 뜻이다.
      return {
        payload: { accepted: true, entryId: seen.entryId, deduped: true, pending: seen.entryId === "" },
        isError: false,
      };
    }

    if (session.isRunning()) {
      return {
        payload: {
          error: `세션 ${record.sessionId}가 이미 턴을 돌고 있습니다.`,
          code: "session_busy",
          busy: true,
          sessionId: record.sessionId,
          hint: "omp_get_status로 현재 상태를 확인한 뒤, 작업이 끝난 다음 같은 idempotencyKey로 다시 보내세요.",
        },
        isError: true,
      };
    }

    const beforeId = lastEntryIdOf(session);
    const sentAt = new Date(nowMs).toISOString();
    // 보내기 전에 같은 키를 예약한다. 이 읽기·수정·쓰기 사이에는 await가 없으므로,
    // 겹쳐 들어온 같은 키의 두 번째 호출은 여기서 이미 예약을 본다.
    mutateStore((store) => {
      const target = store.handles[record.handle];
      if (!target) throw new Gpt6Error("unknown_handle", `연결번호 ${record.handle}를 찾을 수 없습니다.`);
      target.recentSends = [{ key, entryId: "", sentAt, messageHash }, ...target.recentSends]
        .slice(0, GPT6_RECENT_SENDS_MAX);
    });

    let entryId: string;
    try {
      // 중복 판정은 원문(`body`)으로 한다 — 라벨·서두는 세션에 남기는 표기일 뿐이므로,
      // 6PRO가 같은 문장을 재전송하면 표기 유무와 무관하게 같은 호출로 묶인다.
      await session.send({ type: "prompt", message: compose(body) });
      entryId = await waitForNewEntryId(session, beforeId) ?? beforeId ?? "";
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // 실패한 전송은 예약을 지워 같은 키의 재시도가 막히지 않게 한다.
      mutateStore((store) => {
        const target = store.handles[record.handle];
        if (target) target.recentSends = target.recentSends.filter((send) => !(send.key === key && send.entryId === ""));
      });
      return {
        payload: { error: `세션에 지시를 전달하지 못했습니다: ${reason}`, code: "send_failed", sessionId: record.sessionId },
        isError: true,
      };
    }

    mutateStore((store) => {
      const target = store.handles[record.handle];
      if (!target) return;
      const reservation = target.recentSends.find((send) => send.key === key && send.entryId === "");
      if (reservation) reservation.entryId = entryId;
    });

    return { payload: { accepted: true, entryId, deduped: false }, isError: false };
  }

  function sendInstruction(args: Record<string, unknown>): Promise<Gpt6ToolResult> {
    // 인자 검증이 먼저다: 잘못된 인자는 세션 상태와 무관하게 -32602로 나가야 한다.
    const message = nonEmptyString(args.message, "message");
    return injectPrompt(message, args, "", labelInjectedMessage);
  }

  function dispatchBrief(args: Record<string, unknown>): Promise<Gpt6ToolResult> {
    const brief = nonEmptyString(args.brief, "brief");
    return injectPrompt(brief, args, "dispatch", dispatchPrompt);
  }

  /**
   * 6PRO 답변을 기존 세션 entry에 정확히 한 번 남긴다. 자동 WEB6 상담 핸들이면 그 entry가
   * 정본이고, 발급 때 묶인 requestId를 requestId와 idempotencyKey에 동일하게 요구한다.
   * 같은 idempotencyKey 재전송은 dedupe 기록으로 entry를 늘리지 않는다.
   */
  async function publishReplyTool(
    args: Record<string, unknown>,
  ): Promise<Gpt6ToolResult> {
    const text = nonEmptyString(args.text, "text");
    const requestId = typeof args.requestId === "string" && args.requestId.trim() !== ""
      ? args.requestId.trim()
      : undefined;
    const { record, session } = await requireHandle(args.handle, args.handleKey);
    if (record.web6RequestId !== undefined) {
      const idempotencyKey = typeof args.idempotencyKey === "string" ? args.idempotencyKey.trim() : "";
      if (requestId !== record.web6RequestId || idempotencyKey !== record.web6RequestId) {
        throw new Gpt6Error(
          "invalid_argument",
          "WEB6 자동 상담 답변은 발급 문장의 requestId를 requestId와 idempotencyKey에 동일하게 넣어야 합니다.",
        );
      }
    }
    const { key: baseKey, explicit, messageHash } = dedupeKeyOf(args.idempotencyKey, text);
    const key = `reply/${baseKey}`;
    const nowMs = deps.now().getTime();

    const seen = findRecentSend(record, key, explicit, nowMs);
    if (seen && seen.messageHash !== messageHash) {
      throw new Gpt6Error("invalid_argument", "같은 idempotencyKey에 다른 답변 본문을 사용할 수 없습니다.");
    }

    let entryId = seen?.entryId;
    if (!entryId) {
      try {
        entryId = appendReplyEntry(session, text, { handle: record.handle, requestId });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
          payload: { error: `답변을 세션에 남기지 못했습니다: ${reason}`, code: "publish_failed", sessionId: record.sessionId },
          isError: true,
        };
      }

      mutateStore((store) => {
        const target = store.handles[record.handle];
        if (!target) return;
        target.recentSends = [{ key, entryId: entryId!, sentAt: new Date(nowMs).toISOString(), messageHash }, ...target.recentSends]
          .slice(0, GPT6_RECENT_SENDS_MAX);
      });
    }
    return {
      payload: { published: true, entryId, deduped: seen !== undefined, busy: session.isRunning() },
      isError: false,
    };
  }

  /**
   * 핸들 없이 세션 하나에 답변 entry만 남긴다(`/api/gpt6/reply`). 값 검증은 도구 인자와
   * 같은 규칙을 쓰고, 세션 해소와 entry 배선도 핸들 경로와 같은 것을 지난다 — 두 경로가
   * 남긴 entry는 투영에서도 구분되지 않는다. 재전송을 묶을 핸들 기록이 없으므로 중복
   * 판정은 하지 않는다(호출자가 같은 본문을 두 번 보내면 두 번 남는다).
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
    const entryId = appendReplyEntry(session, text, { model });
    return { published: true, entryId, busy: session.isRunning() };
  }

  async function getStatus(args: Record<string, unknown>): Promise<Gpt6ToolResult> {
    const { session } = await requireHandle(args.handle, args.handleKey);
    const state = await session.send({ type: "get_state" });
    return {
      payload: {
        busy: isBusy(session, state),
        model: modelLabelOf(state),
        runningAgents: runningAgentsOf(state),
        lastEntryId: lastEntryIdOf(session) ?? null,
      },
      isError: false,
    };
  }

  async function getResult(args: Record<string, unknown>): Promise<Gpt6ToolResult> {
    const { session } = await requireHandle(args.handle, args.handleKey);
    const since = typeof args.sinceEntryId === "string" && args.sinceEntryId.trim() !== ""
      ? args.sinceEntryId.trim()
      : undefined;
    const messages = messageEntriesOf(session);

    let window: Gpt6EntryView[];
    let truncated = false;
    let cursorMissing = false;
    if (since === undefined) {
      window = messages.slice(-GPT6_DEFAULT_RESULT_ENTRIES);
      truncated = messages.length > window.length;
    } else {
      const index = messages.findIndex((entry) => entry.id === since);
      if (index < 0) {
        // 압축 등으로 커서가 사라진 경우. 조용히 0건을 주지 않고 최근 것과 함께 알린다.
        cursorMissing = true;
        window = messages.slice(-GPT6_DEFAULT_RESULT_ENTRIES);
        truncated = messages.length > window.length;
      } else {
        const after = messages.slice(index + 1);
        truncated = after.length > GPT6_MAX_RESULT_ENTRIES;
        window = after.slice(0, GPT6_MAX_RESULT_ENTRIES);
      }
    }

    const entries = window.map((entry) => {
      if (entry.text.length <= GPT6_MAX_ENTRY_TEXT_CHARS) return entry;
      truncated = true;
      return { ...entry, text: `${entry.text.slice(0, GPT6_MAX_ENTRY_TEXT_CHARS)}\n…(이하 생략)` };
    });

    return {
      payload: {
        entries,
        busy: session.isRunning(),
        truncated,
        ...(cursorMissing ? { cursorMissing: true } : {}),
      },
      isError: false,
    };
  }

  async function callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Gpt6ToolResult> {
    switch (name) {
      case "omp_resume_handle": {
        const { record } = await requireHandle(args.handle, args.handleKey);
        return {
          payload: {
            handle: record.handle,
            cwd: record.cwd,
            projectName: projectNameOf(record.cwd),
            sessionId: record.sessionId,
            instruction: record.instruction,
            status: "active",
          },
          isError: false,
        };
      }
      case "omp_send_instruction":
        return sendInstruction(args);
      case "omp_publish_reply":
        return publishReplyTool(args);
      case "omp_dispatch":
        return dispatchBrief(args);
      case "omp_get_status":
        return getStatus(args);
      case "omp_get_result":
        return getResult(args);
      default:
        throw new Gpt6Error("invalid_argument", `알 수 없는 도구입니다: ${name}`);
    }
  }

  function ok(id: unknown, result: unknown): Gpt6JsonRpcResponse {
    return { jsonrpc: "2.0", id, result };
  }

  function fail(id: unknown, code: number, message: string, data?: Record<string, unknown>): Gpt6JsonRpcResponse {
    return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
  }

  function toolCallResponse(id: unknown, outcome: Gpt6ToolResult): Gpt6JsonRpcResponse {
    return ok(id, {
      content: [{ type: "text", text: JSON.stringify(outcome.payload) }],
      ...(outcome.isError ? { isError: true } : {}),
    });
  }

  /**
   * JSON-RPC 디스패치. 라우트가 Authorization 헤더를 먼저 보고 401로 끊지만, 여기서도
   * 토큰을 다시 검사한다 — 이 검사를 통과하지 못한 요청은 어떤 도구도 실행하지 않는다.
   *
   * 오류 분류:
   * - 프로토콜 문제(요청 형식·batch·모르는 메서드·모르는 도구·인자 누락) → JSON-RPC error.
   * - 핸들 해소 실패(unknown/unauthorized/expired/revoked/session_missing/cwd_mismatch/
   *   too_many_failures) → JSON-RPC error `-32001` + `data.code`. 대체 세션으로 진행하지 않는다 —
   *   죽은 세션은 기록에서 그 세션을 되살릴 뿐, 다른 세션으로 갈아타지 않는다.
   * - 해소 뒤의 운용 실패(session_busy·전송 실패·저장소 충돌) → `isError: true` + payload의
   *   `code`. 6 Pro가 읽고 판단해야 하는 실패라 도구 결과로 돌려준다.
   */
  async function dispatch(request: unknown, auth: { token: string }): Promise<Gpt6JsonRpcResponse | null> {
    // 이 서버는 JSON-RPC batch(배열 본문)를 구현하지 않는다. 배열을 객체로 취급하면
    // "method가 없다"는 -32600으로 보여 원인이 요청 형식 오류로 어긋난다.
    if (Array.isArray(request)) {
      return fail(null, GPT6_RPC_ERROR.invalidRequest, "JSON-RPC batch(배열 본문)는 지원하지 않습니다. 요청을 하나씩 보내세요.");
    }
    const body = recordOf(request);
    const id = body.id ?? null;

    if (!hashMatches(auth.token, readStore().tokenHash)) {
      return fail(id, GPT6_RPC_ERROR.unauthorized, "토큰이 올바르지 않습니다. 커넥터의 Authorization bearer 토큰을 확인하세요.", {
        code: "unauthorized",
      });
    }

    const method = typeof body.method === "string" ? body.method : "";
    if (method === "") return fail(id, GPT6_RPC_ERROR.invalidRequest, "JSON-RPC method가 없습니다.");
    // 알림은 응답하지 않는다(라우트가 202로 끊는다).
    if (method.startsWith("notifications/")) return null;

    if (method === "initialize") {
      // 서버가 실제로 구현한 버전만 확정한다. 클라이언트가 보낸 문자열을 그대로 되돌려주면
      // 지원하지도 않는 버전으로 왕복이 이어지다 엉뚱한 지점에서 끊긴다.
      return ok(id, {
        protocolVersion: GPT6_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: GPT6_SERVER_NAME, version: GPT6_SERVER_VERSION },
      });
    }

    if (method === "tools/list") {
      return ok(id, { tools: GPT6_TOOLS });
    }

    if (method === "tools/call") {
      const params = recordOf(body.params);
      const name = typeof params.name === "string" ? params.name : "";
      if (!GPT6_TOOLS.some((tool) => tool.name === name)) {
        // MCP 규약: 모르는 도구 이름은 Invalid params다.
        return fail(id, GPT6_RPC_ERROR.invalidParams, `알 수 없는 도구입니다: ${name || "(이름 없음)"}`);
      }
      const args = recordOf(params.arguments);
      try {
        return toolCallResponse(id, await callTool(name, args));
      } catch (error) {
        if (error instanceof Gpt6Error) {
          if (error.code === "invalid_argument") {
            return fail(id, GPT6_RPC_ERROR.invalidParams, error.message, { code: error.code });
          }
          if (isRejectCode(error.code)) {
            return fail(id, GPT6_RPC_ERROR.handleRejected, error.message, { code: error.code });
          }
          return toolCallResponse(id, {
            payload: { error: error.message, code: error.code },
            isError: true,
          });
        }
        const reason = error instanceof Error ? error.message : String(error);
        return toolCallResponse(id, {
          payload: { error: `도구 실행이 실패했습니다: ${reason}`, code: "internal_error" },
          isError: true,
        });
      }
    }

    return fail(id, GPT6_RPC_ERROR.methodNotFound, `지원하지 않는 메서드입니다: ${method}`);
  }

  return {
    issueHandle,
    listHandles,
    revokeHandle,
    rotateToken,
    acceptsToken: (token) => hashMatches(token, readStore().tokenHash),
    dispatch,
    publishReply,
  };
}
