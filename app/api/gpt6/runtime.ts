/**
 * `/api/gpt6/*` 라우트가 함께 쓰는 배선. 순수 로직은 `lib/gpt6-bridge.ts`에 있고,
 * 여기서만 파일 I/O·세션 레지스트리·시각·난수를 붙인다.
 *
 * 저장소는 `<agentDir>/gpt6-handles.json` 하나다(0600, 원자적 교체). 토큰과 연결번호별
 * 키는 저장소에 sha256 다이제스트로만 남고, 평문은 발급·회전 응답에서만 나간다.
 */
import { randomBytes, randomInt } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { NextResponse } from "next/server";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";
import {
  buildGpt6BindingNotice,
  createGpt6Bridge,
  Gpt6Error,
  GPT6_BINDING_CUSTOM_TYPE,
  GPT6_REPLY_CUSTOM_TYPE,
  GPT6_REPLY_SOURCE,
  gpt6HttpStatus,
  type Gpt6Bridge,
  type Gpt6SessionHandle,
} from "@/lib/gpt6-bridge";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getRpcSession, startRpcSession, type AgentSessionWrapper } from "@/lib/rpc-manager";
import { buildSessionContext, resolveSessionPath } from "@/lib/session-reader";

export const GPT6_HANDLE_STORE_FILE = "gpt6-handles.json";
/** MCP 경로. 호스트는 서버가 아는 값에서 정하고 경로는 고정한다. */
export const GPT6_MCP_PATH = "/api/gpt6/mcp";
export function gpt6StorePath(): string {
  return join(getAgentDir(), GPT6_HANDLE_STORE_FILE);
}

/**
 * 살아 있는 런타임 세션 하나를 브리지가 요구하는 최소 표면으로 감싼다.
 * `cwd`는 매번 세션에서 읽는다 — 스냅샷과 비교해야 하므로 캐시하면 안 된다.
 */
function wrap(session: AgentSessionWrapper): Gpt6SessionHandle {
  return {
    get cwd() {
      return session.cwd;
    },
    isAlive: () => session.isAlive(),
    isRunning: () => session.isRunning(),
    send: (command) => session.send(command),
    entries: () => session.inner.sessionManager.getEntries(),
    appendCustomMessage: (customType, content, display, details) => {
      const manager = session.inner.sessionManager;
      const entryId = manager.appendCustomMessageEntry(customType, content, display, details);
      if (customType === GPT6_REPLY_CUSTOM_TYPE) {
        const entries = manager.getEntries() as never;
        session.publishSessionSnapshot(
          entryId,
          buildSessionContext(entries, manager.getLeafId(), {
            deferThinking: true,
            deferToolResultImages: true,
          }),
        );
      }
      return entryId;
    },
  };
}

/**
 * 이 프로세스에 없는 세션을 세션 기록(JSONL)에서 되살린다. 6PRO 탭에서 발급한 연결번호는
 * 사용자가 그 탭을 닫아도 살아 있어야 하므로, 브리지가 세션을 찾지 못하면 여기로 온다.
 *
 * `app/api/agent/[id]/route.ts`의 재개 경로와 같은 순서다: 기록 경로를 찾고(`resolveSessionPath`),
 * 그 파일로 런타임을 띄운다(`startRpcSession`). 기록이 없으면 `undefined`로 알리고, 삭제가
 * 진행 중인 세션처럼 띄울 수 없는 경우는 `startRpcSession`의 오류를 그대로 올린다.
 * cwd는 세션 기록에서 오므로, 발급 스냅샷과 다르면 브리지가 cwd_mismatch로 끊는다.
 */
async function resumeSession(sessionId: string): Promise<Gpt6SessionHandle | undefined> {
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) return undefined;
  const { session } = await startRpcSession(sessionId, filePath, undefined);
  return wrap(session);
}

/**
 * 연결번호가 묶였다는 사실을 그 세션에 남긴다. **최선 노력**이다 — 실패해도 발급은 성공한다.
 *
 * 살아 있는 세션이면 그대로 쓰고, 없으면 기록에서 되살린다(브리지의 도구 호출과 같은 순서).
 * 발급마다 새 연결번호가 나오므로 통지도 발급당 하나다.
 *
 * 모델은 실행되지 않는다. `appendCustomMessageEntry`는 entry만 남기고, 그 entry는 다음 턴의
 * 문맥에 실려 에이전트가 읽는다.
 */
export async function announceGpt6Binding(sessionId: string, handle: string, expiresAt: string): Promise<boolean> {
  try {
    const live = getRpcSession(sessionId);
    const target = live?.isAlive() ? wrap(live) : await resumeSession(sessionId);
    if (!target) return false;
    target.appendCustomMessage(GPT6_BINDING_CUSTOM_TYPE, buildGpt6BindingNotice(handle, expiresAt), true, {
      source: GPT6_REPLY_SOURCE,
      handle,
    });
    return true;
  } catch (error) {
    // 통지는 부가 기능이다. 죽은 런타임·삭제 중인 세션 때문에 발급이 실패하면 안 된다.
    console.warn(`[gpt6] 바인딩 통지를 남기지 못했습니다 (${handle}):`, error);
    return false;
  }
}

/** WEB6 shim이 sessionId만으로 현재 세션의 새 handle을 발급하는 권위 경로. */
export async function issueGpt6HandleForWeb6(sessionId: string, requestId: string) {
  const normalizedSessionId = sessionId.trim();
  const normalizedRequestId = requestId.trim();
  if (!normalizedSessionId || !normalizedRequestId) {
    throw new Gpt6Error("invalid_argument", "sessionId와 requestId가 필요합니다.");
  }
  const live = getRpcSession(normalizedSessionId);
  const session = live?.isAlive() ? wrap(live) : await resumeSession(normalizedSessionId);
  if (!session) {
    throw new Gpt6Error("session_not_found", `세션 ${normalizedSessionId}의 기록을 찾을 수 없습니다.`);
  }
  const issued = getGpt6Bridge().issueHandle({
    cwd: session.cwd,
    sessionId: normalizedSessionId,
    instruction: "WEB6 자동 상담",
    web6RequestId: normalizedRequestId,
  });
  await announceGpt6Binding(issued.sessionId, issued.handle, issued.expiresAt);
  return issued;
}

export function getGpt6Bridge(): Gpt6Bridge {
  const storePath = gpt6StorePath();
  return createGpt6Bridge({
    readStore: () => {
      try {
        return readFileSync(storePath, "utf8");
      } catch (error) {
        // 아직 한 번도 발급하지 않았으면 파일이 없다. 그 밖의 읽기 실패는 숨기지 않는다.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    writeStore: (contents) => {
      mkdirSync(dirname(storePath), { recursive: true });
      writePrivateFileAtomicSync(storePath, contents);
    },
    now: () => new Date(),
    randomToken: () => randomBytes(32).toString("base64url"),
    randomHandleKey: () => randomBytes(32).toString("base64url"),
    randomHandleDigits: () => String(randomInt(0, 10_000)).padStart(4, "0"),
    getSession: (sessionId) => {
      const session = getRpcSession(sessionId);
      return session ? wrap(session) : undefined;
    },
    resumeSession,
    wait: (ms) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, ms);
      return promise;
    },
  });
}

/**
 * ChatGPT 커넥터에 넣는 것은 URL이 아니라 OpenAI Platform에서 받은 `tunnel_id`다. 그 터널의
 * 요청을 이 서버로 넘기는 것은 집 PC에서 도는 `tunnel-client`이고, 그 프로세스는 같은 기계의
 * 루프백으로 붙는다. 그래서 이 주소는 노출 호스트와 무관하게 **언제나** loopback이다 —
 * `gpt6McpUrl()`이 폰·다른 PC의 직접 접속용 주소를 계속 내주는 것과 별개다.
 * 요청 헤더(`x-forwarded-host`·`Host` 등)는 여기서도 쓰지 않는다.
 *
 * `PORT`는 Next가 실제 바인딩한 포트로 채운다(`start-server.js`가 `process.env.PORT`에
 * listen 결과를 넣는다).
 */
export function gpt6TunnelTargetUrl(): string {
  return `http://127.0.0.1:${process.env.PORT?.trim() || "30141"}${GPT6_MCP_PATH}`;
}

/**
 * 화면에 보여 줄 MCP URL — 터널을 거치지 않고 이 서버에 직접 붙을 때 쓰는 주소.
 * 폰·다른 PC는 여기에 bearer 토큰을 실어 부르므로, 요청자가 정하는 헤더
 * (`x-forwarded-host`·`Host` 등)는 쓰지 않고 서버가 아는 값만 쓴다.
 *
 * 1순위는 운영자가 지정한 노출 호스트다. `launch.ps1`이 Tailscale HTTPS 앞단이 보내는
 * 테일넷 이름을 `OMP_WEB_ALLOWED_HOSTS`에 넣고, 그 이름은 https(443)로 열린다. 그 값이
 * 없으면(로컬에서만 쓰는 배치) 로컬 기준값 `http://127.0.0.1:<port>`로 만든다.
 * 어느 쪽이든 이 URL은 서버 기준 주소이고, 폰·다른 PC에서 쓰는 주소가 따로 있으면
 * 사용자가 직접 확인해야 한다 — 그 사실을 패널이 함께 안내한다.
 */
export function gpt6McpUrl(): string {
  const exposed = configuredExposureHost();
  if (exposed) return `https://${exposed}${GPT6_MCP_PATH}`;
  return gpt6TunnelTargetUrl();
}

/** `OMP_WEB_ALLOWED_HOSTS`에서 외부 노출 호스트명 하나를 고른다. IP 리터럴은 노출 주소가 아니다. */
function configuredExposureHost(): string | null {
  for (const entry of process.env.OMP_WEB_ALLOWED_HOSTS?.split(",") ?? []) {
    const value = entry.trim().replace(/\.$/, "").toLowerCase();
    if (!value || isIP(value) !== 0 || value === "localhost" || value.endsWith(".localhost")) continue;
    return value;
  }
  return null;
}

/** `Authorization: Bearer <token>`. 다른 인증 경로는 쓰지 않는다. */
export function gpt6BearerToken(request: Request): string {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  return match ? match[1] : "";
}

/**
 * 요청이 로컬(loopback)이나 같은 테일넷(CGNAT 100.64.0.0/10)에서 왔는지.
 *
 * Next 16은 라우트 핸들러에 소켓 주소를 주지 않는다 — `NextRequestAdapter.fromNodeNextRequest`
 * (`next/dist/server/web/spec-extension/adapters/next-request.js:82`)가 `NextRequest`를 만들 때
 * `ip`를 넘기지 않으므로(`:109-111`이 `// ip` 자리만 남긴다) `request.socket` 같은 통로가 없다.
 * 남은 통로는 Next 서버가 채워 주는 `x-forwarded-for` 하나다
 * (`next/dist/server/base-server.js:577`: `req.headers['x-forwarded-for'] ??= originalRequest.socket.remoteAddress`).
 * 클라이언트가 같은 헤더를 보내면 Next는 덮어쓰지 않으므로(`??=`), 이 값은 "원격에서 온
 * 평범한 요청"을 끊는 심층 방어이지 인증 근거가 아니다. 그래서 이 검사는 실제 자격증명
 * (전역 토큰 + 핸들 키)을 대체하지 않고 그 앞에 한 겹 더 놓는다.
 *
 * 홉이 여럿이면 가장 오른쪽 값을 쓴다. 앞은 클라이언트가 넣은 값일 수 있고, 우리 앞의
 * 프록시(로컬 tailscaled·Next 서버 자신)가 마지막에 실제 피어를 덧붙이기 때문이다.
 * 값이 없거나 IP 리터럴이 아니면 거부한다 — 출처를 모르면 통과시키지 않는다.
 */
export function isGpt6LocalClient(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-for");
  if (!forwarded) return false;
  const hops = forwarded.split(",");
  return isTrustedPeerAddress(hops[hops.length - 1] ?? "");
}

/** loopback(127.0.0.0/8, ::1, IPv4-mapped 포함)과 Tailscale CGNAT(100.64.0.0/10)만 신뢰한다. */
function isTrustedPeerAddress(value: string): boolean {
  const address = value.trim().toLowerCase().replace(/^::ffff:/, "");
  if (address === "::1") return true;
  if (isIP(address) !== 4) return false;
  const octets = address.split(".").map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  if (octets[0] === 127) return true;
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

/**
 * 연결번호 관리 라우트(`/api/gpt6/handles`·`/api/gpt6/token`)의 입구. 이 라우트들은
 * 평문 토큰과 전 핸들 목록을 내주므로, 기존 브라우저 가드 위에 로컬 전용 검사를 더한다.
 * 통과면 null, 아니면 그대로 돌려줄 403 응답이다.
 */
export function gpt6AdminGuard(request: Request): NextResponse | null {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!isGpt6LocalClient(request)) {
    return NextResponse.json(
      { error: "Connection numbers are managed from this machine or its tailnet only.", code: "local_only" },
      { status: 403 },
    );
  }
  return null;
}

/** 라우트가 던져진 오류를 그대로 돌려줄 응답으로 바꾼다. 두 관리 라우트가 같은 표를 쓴다. */
export function gpt6ErrorResponse(error: unknown): NextResponse {
  if (error instanceof Gpt6Error) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: gpt6HttpStatus(error.code) });
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error), code: "internal_error" },
    { status: 500 },
  );
}
