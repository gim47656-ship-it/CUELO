import { interpreterInstructions } from "./translator-live";
import type { InterpreterContext } from "./translator-context";
import type { TranslatorLanguage } from "./translator-languages";
import type { LivePace } from "./live-types";

/**
 * Gemini 통역의 서버 쪽. 사용자가 고른 저장 Google API 키(AuthStorage 행 id)로 짧게 사는 일회용
 * 토큰을 만들고, 그 토큰에 통역 설정 전체(모델·지시·전사·응답 형식)를 잠근다. 브라우저는 토큰만 받아
 * Gemini Live에 직접 연결하며, 키 자체는 서버 밖으로 나가지 않는다.
 *
 * - 지시는 Codex 통역과 같은 `interpreterInstructions`(분위기·성별·나이·속도·앞선 대화)를 그대로 쓴다.
 * - 도구·위임이 없다. 설정에 `tools`를 넣지 않는다.
 * - 고른 키가 없거나 꺼졌거나 Google API 키가 아니면 거절한다. 다른 키·다른 공급자로 넘어가지 않는다.
 */

/** The general Live model: bidirectional interpreting with system instructions (checked live 2026-10-25). */
export const GEMINI_INTERPRETER_MODEL = "gemini-3.8-live";
/** AuthStorage provider id of Google AI Studio API keys. */
export const GEMINI_CREDENTIAL_PROVIDER = "google";

const AUTH_TOKENS_URL = "https://generativelanguage.googleapis.com/v1beta/auth_tokens";
/** The token must open its session within this window. */
export const NEW_SESSION_WINDOW_MS = 60_000;
/**
 * Messages are refused after this. Gemini ends a connection after about ten minutes anyway; the
 * browser then reconnects with a new token, so a longer lifetime would only widen exposure.
 */
export const TOKEN_LIFETIME_MS = 15 * 60_000;

/** The slice of `AuthStorage.credentials` this module reads. It lists active rows only. */
export interface GeminiCredentialSource {
  list(provider: string): readonly { id: number; credential: { type: string; key?: unknown } }[];
}

export interface GeminiCredentialOption {
  id: number;
  label: string;
}

export type GeminiInterpreterErrorKind = "credential-unavailable" | "live-auth" | "live-upstream";

export class GeminiInterpreterError extends Error {
  readonly kind: GeminiInterpreterErrorKind;
  readonly status: number;

  constructor(kind: GeminiInterpreterErrorKind, status: number, message: string) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

const isUsableKey = (credential: { type: string; key?: unknown }): credential is { type: "api_key"; key: string } =>
  credential.type === "api_key" && typeof credential.key === "string" && credential.key.trim().length > 0;

/** Enabled Google API keys by row id. Never the key, masked or not. */
export function listGeminiCredentials(source: GeminiCredentialSource): GeminiCredentialOption[] {
  return source.list(GEMINI_CREDENTIAL_PROVIDER)
    .filter((row) => isUsableKey(row.credential))
    .map((row) => ({ id: row.id, label: `Google API 키 #${row.id}` }));
}

function selectedKey(source: GeminiCredentialSource, credentialId: number): string {
  const row = source.list(GEMINI_CREDENTIAL_PROVIDER).find((entry) => entry.id === credentialId);
  if (!row || !isUsableKey(row.credential)) {
    throw new GeminiInterpreterError("credential-unavailable", 409, "The selected Google API key is not available. Choose another key.");
  }
  return row.credential.key.trim();
}

/** The whole Live setup locked into the token. The browser's own setup frame is ignored. */
export function geminiInterpreterSetup(
  mine: TranslatorLanguage,
  theirs: TranslatorLanguage,
  context: InterpreterContext,
  pace: LivePace,
) {
  return {
    model: `models/${GEMINI_INTERPRETER_MODEL}`,
    generationConfig: { responseModalities: ["AUDIO"] },
    systemInstruction: { parts: [{ text: interpreterInstructions(mine, theirs, context, pace) }] },
    inputAudioTranscription: { languageCodes: [mine.tag, theirs.tag] },
    outputAudioTranscription: { languageCodes: [mine.tag, theirs.tag] },
    // Long calls: drop the oldest context instead of ending the session at the audio limit.
    contextWindowCompression: { slidingWindow: {} },
  };
}

export interface GeminiTokenRequest {
  credentials: GeminiCredentialSource;
  credentialId: number;
  mine: TranslatorLanguage;
  theirs: TranslatorLanguage;
  context: InterpreterContext;
  pace: LivePace;
  fetchImpl?: typeof fetch;
  now?: number;
}

export interface GeminiTokenResponse {
  /** The single-use ephemeral token (`auth_tokens/...`). */
  token: string;
  model: string;
  expiresAt: string;
  newSessionExpiresAt: string;
}

const SAFE_CODE = /^[A-Z_]{1,64}$/;

/** One property of parsed JSON, or `undefined` when `value` is not an object holding it. */
function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && key in value ? (value as Record<string, unknown>)[key] : undefined;
}

/**
 * Google's error `status` and `details[].reason` codes (e.g. `RESOURCE_EXHAUSTED`,
 * `API_KEY_INVALID`). Only these fixed codes are kept: the free-text message is never echoed.
 */
async function googleErrorCodes(response: Response): Promise<{ status: string; reasons: string[] }> {
  const error = field(await response.json().catch(() => null), "error");
  const rawStatus = field(error, "status");
  const status = typeof rawStatus === "string" && SAFE_CODE.test(rawStatus) ? rawStatus : `HTTP ${response.status}`;
  const reasons: string[] = [];
  const details = field(error, "details");
  if (Array.isArray(details)) {
    for (const detail of details) {
      const reason = field(detail, "reason");
      if (typeof reason === "string" && SAFE_CODE.test(reason)) reasons.push(reason);
    }
  }
  return { status, reasons };
}

export async function createGeminiInterpreterToken(request: GeminiTokenRequest): Promise<GeminiTokenResponse> {
  const key = selectedKey(request.credentials, request.credentialId);
  const now = request.now ?? Date.now();
  const expiresAt = new Date(now + TOKEN_LIFETIME_MS).toISOString();
  const newSessionExpiresAt = new Date(now + NEW_SESSION_WINDOW_MS).toISOString();
  let response: Response;
  try {
    response = await (request.fetchImpl ?? fetch)(AUTH_TOKENS_URL, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        uses: 1,
        expireTime: expiresAt,
        newSessionExpireTime: newSessionExpiresAt,
        // No field mask: the effective setup is taken entirely from here.
        bidiGenerateContentSetup: geminiInterpreterSetup(request.mine, request.theirs, request.context, request.pace),
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "network error";
    throw new GeminiInterpreterError("live-upstream", 502, `Gemini token request failed (${reason}).`);
  }
  if (!response.ok) {
    const { status, reasons } = await googleErrorCodes(response);
    // An invalid key is 400 INVALID_ARGUMENT with reason API_KEY_INVALID; a restricted or revoked one
    // is 401/403. Any other 400 is a setup Google rejected, not the user's key.
    const keyRefused = response.status === 401 || response.status === 403
      || reasons.some((reason) => reason.startsWith("API_KEY_"));
    const code = reasons[0] ? `${status}/${reasons[0]}` : status;
    if (keyRefused) throw new GeminiInterpreterError("live-auth", 401, `Google refused the selected API key (${code}).`);
    throw new GeminiInterpreterError("live-upstream", 502, `Gemini token request failed (${code}).`);
  }
  const token = field(await response.json().catch(() => null), "name");
  if (typeof token !== "string" || !token) {
    throw new GeminiInterpreterError("live-upstream", 502, "Gemini returned no token.");
  }
  return { token, model: GEMINI_INTERPRETER_MODEL, expiresAt, newSessionExpiresAt };
}
