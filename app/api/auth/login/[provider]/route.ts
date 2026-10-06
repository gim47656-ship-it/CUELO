import type { OAuthAuthInfo, OAuthPrompt } from "@oh-my-pi/pi-ai/oauth";
import { invalidateModelsCache } from "@/lib/models-cache";
import { getOmpRuntime, invalidateOmpRuntime } from "@/lib/omp-runtime";
import { resolveOAuthLoginId } from "@/lib/provider-listing-runtime";

export const dynamic = "force-dynamic";

/** 로그인의 다음 상태. 붙여 넣은 값 뒤에 이어진 결과를 POST 가 그대로 돌려준다. */
type LoginStep = { state: "success" } | { state: "error"; message: string } | { state: "input" } | { state: "pending" };

interface PendingInput {
  resolve: (v: string) => void;
  reject: (e: Error) => void;
  /** 이 입력 다음에 일어날 일(성공·실패·다음 입력 요청)을 기다린다. */
  nextStep: () => Promise<LoginStep>;
}

// In-memory registry: loginToken -> pending browser input of a running login
declare global {
  var __ompLoginCallbacks: Map<string, PendingInput> | undefined;
}

function getCallbackRegistry() {
  if (!globalThis.__ompLoginCallbacks) globalThis.__ompLoginCallbacks = new Map();
  return globalThis.__ompLoginCallbacks;
}

/**
 * 휴대폰은 로그인하러 브라우저로 넘어가면 이 화면을 백그라운드로 보내 SSE 가 끊긴다. 끊겼다고 바로
 * 취소하면 돌아와 붙여 넣은 주소가 갈 곳이 없으므로, 입력을 이만큼 더 기다린 뒤에 취소한다.
 */
const DETACHED_LOGIN_TTL_MS = 10 * 60_000;
/** 붙여 넣은 값으로 토큰 교환이 끝나기를 POST 가 기다리는 상한. */
const STEP_WAIT_MS = 90_000;

// POST /api/auth/login/[provider] — frontend sends redirect URL or auth code
export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const { token, code } = (await req.json()) as { token?: string; code?: string };

  if (!token || !code) {
    return Response.json({ error: "token and code required" }, { status: 400 });
  }

  const registry = getCallbackRegistry();
  const callbacks = registry.get(token);
  if (!callbacks) {
    return Response.json({ error: "No pending login for token" }, { status: 404 });
  }
  // Verify token belongs to this provider (token format: "<provider>-<ts>-<random>")
  if (!token.startsWith(`${provider}-`)) {
    return Response.json({ error: "Token does not match provider" }, { status: 400 });
  }

  const next = callbacks.nextStep();
  callbacks.resolve(code);
  registry.delete(token);
  // SSE 가 끊긴 화면도 결과를 알 수 있게, 이 입력 다음의 결과를 응답으로 돌려준다.
  const step = await Promise.race([
    next,
    new Promise<LoginStep>((resolve) => setTimeout(() => resolve({ state: "pending" }), STEP_WAIT_MS)),
  ]);
  if (step.state === "error") return Response.json({ error: step.message, state: step.state }, { status: 400 });
  return Response.json({ ok: true, provider, state: step.state });
}

// GET /api/auth/login/[provider] — SSE stream for OAuth flow
export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;

  const encoder = new TextEncoder();
  const send = (controller: ReadableStreamDefaultController, data: unknown) => {
    // 화면이 떠난 뒤에도 로그인은 이어지므로, 닫힌 스트림에 쓰는 실패는 무시한다.
    try {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
    } catch {}
  };

  // 화면 연결이 끊기면 바로 취소하지 않고, 입력을 기다릴 시간을 둔 뒤 AuthStorage.oauth.login() 을 멈춘다.
  const abort = new AbortController();
  let detachTimer: ReturnType<typeof setTimeout> | undefined;
  const detach = () => {
    if (detachTimer === undefined && !abort.signal.aborted) detachTimer = setTimeout(() => abort.abort(), DETACHED_LOGIN_TTL_MS);
  };
  req.signal.addEventListener("abort", detach);

  const stream = new ReadableStream({
    async start(controller) {
      const loginId = resolveOAuthLoginId(provider);
      if (!loginId) {
        send(controller, { type: "error", message: `Unknown provider: ${provider}` });
        controller.close();
        return;
      }
      const { authStorage } = await getOmpRuntime();

      const registry = getCallbackRegistry();
      const activeTokens = new Set<string>();
      let pendingManualRequest: { token: string; promise: Promise<string> } | undefined;
      let stepWaiters: ((step: LoginStep) => void)[] = [];
      const announce = (step: LoginStep) => {
        const waiters = stepWaiters;
        stepWaiters = [];
        for (const waiter of waiters) waiter(step);
      };
      const nextStep = () => new Promise<LoginStep>((resolve) => stepWaiters.push(resolve));

      const createClientInputRequest = () => {
        // 앞서 붙여 넣은 값이 이 새 입력 요청으로 이어졌다.
        announce({ state: "input" });
        const token = `${provider}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        activeTokens.add(token);

        const promise = new Promise<string>((resolve, reject) => {
          registry.set(token, {
            resolve: (value) => {
              activeTokens.delete(token);
              registry.delete(token);
              resolve(value);
            },
            reject: (error) => {
              activeTokens.delete(token);
              registry.delete(token);
              reject(error);
            },
            nextStep,
          });
        });

        return { token, promise };
      };

      const getManualInputRequest = () => {
        if (!pendingManualRequest) {
          pendingManualRequest = createClientInputRequest();
          pendingManualRequest.promise
            .finally(() => {
              pendingManualRequest = undefined;
            })
            .catch(() => {});
        }
        return pendingManualRequest;
      };

      // Cleanup: remove pending token and abort any waiting promise
      const cleanup = () => {
        for (const token of activeTokens) {
          registry.get(token)?.reject(new Error("Login cancelled"));
          registry.delete(token);
        }
        activeTokens.clear();
      };

      // 입력 대기 시간이 지나면 남은 입력을 취소한다.
      abort.signal.addEventListener("abort", cleanup);

      try {
        await authStorage.oauth.login(loginId, {
          // Every provider prompt (paste-the-code, enterprise URL, ...) becomes
          // a browser input request keyed by a short-lived token.
          onPrompt: async (prompt: OAuthPrompt) => {
            const request = createClientInputRequest();
            send(controller, {
              type: "prompt_request",
              message: prompt.message,
              placeholder: prompt.placeholder ?? null,
              token: request.token,
            });
            return request.promise;
          },
          // Manual-code flows resolve through the same pending request as the
          // auth URL so a user who pastes the redirect completes the login.
          onManualCodeInput: () => getManualInputRequest().promise,
          onAuth: (info: OAuthAuthInfo) => {
            const request = getManualInputRequest();
            send(controller, {
              type: "auth",
              // 실제 인증 주소를 준다. core 의 `launchUrl` 은 서버 자신의 localhost 라서
              // 휴대폰·원격 브라우저에서는 열리지 않는다.
              url: info.url,
              instructions: info.instructions ?? null,
              token: request.token,
            });
          },
          onProgress: (message: string) => {
            send(controller, { type: "progress", message });
          },
          signal: abort.signal,
        });

        invalidateModelsCache();
        invalidateOmpRuntime();
        announce({ state: "success" });
        send(controller, { type: "success" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        announce({ state: "error", message: msg });
        if (msg !== "Login cancelled") {
          send(controller, { type: "error", message: msg });
        } else {
          send(controller, { type: "cancelled" });
        }
      } finally {
        if (detachTimer !== undefined) clearTimeout(detachTimer);
        cleanup();
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      detach();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
