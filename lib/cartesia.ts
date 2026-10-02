import { wrapFetchForProxy } from "@oh-my-pi/pi-ai/utils/proxy";

/**
 * Cartesia REST 경계 (API `2026-08-14`). 키는 이 모듈의 요청 헤더로만 나가고, 오류 메시지에는
 * provider가 돌려준 제목·본문만 담는다 — 키나 요청 헤더를 메시지에 섞지 않는다.
 */

export const CARTESIA_API_ORIGIN = "https://api.cartesia.ai";
export const CARTESIA_VERSION = "2026-08-14";
export const CARTESIA_PROXY_PROVIDER = "cartesia";

const MAX_ERROR_DETAIL = 300;
const LIST_PAGE_LIMIT = 100;
/** 소유 voice 목록을 끝까지 넘기는 상한. 넘으면 목록 확인을 끝냈다고 말하지 않는다. */
const MAX_LIST_PAGES = 50;
const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;
/**
 * 억양 추가는 provider가 voice를 다시 처리하는 요청이라 목록·조회보다 훨씬 오래 걸린다. 갓 복제한 voice에서
 * 30초를 넘겨 준비가 `ambiguous`로 멈춘 것을 관측했다(같은 요청을 다시 보냈을 때는 11초).
 */
const ACCENT_TIMEOUT_MS = 120_000;

/**
 * - `auth`: 키가 틀렸거나 폐기됨
 * - `plan`: 플랜·크레딧이 이 작업을 허용하지 않음(402/403)
 * - `ambiguous`: 요청이 provider에 닿았는지 모름(네트워크 끊김·시간 초과·5xx). 유료 생성 요청이면
 *   소유 목록으로 실제 결과를 맞춰 보기 전에는 다시 보내지 않는다.
 */
export type CartesiaErrorKind = "auth" | "plan" | "rate" | "bad-request" | "not-found" | "ambiguous";

export class CartesiaError extends Error {
  constructor(message: string, readonly kind: CartesiaErrorKind, readonly status?: number) {
    super(message);
    this.name = "CartesiaError";
  }
}

export interface CartesiaVoiceAccent {
  accent: string;
  locale?: string;
  isNative: boolean;
}

export interface CartesiaVoice {
  id: string;
  name: string;
  description: string;
  isOwner: boolean;
  accents: CartesiaVoiceAccent[];
}

export interface CartesiaCloneRequest {
  clip: Blob;
  fileName: string;
  name: string;
  description: string;
  language: string;
  accent: string;
}

type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

function kindForStatus(status: number): CartesiaErrorKind {
  if (status === 401) return "auth";
  if (status === 402 || status === 403) return "plan";
  if (status === 429) return "rate";
  if (status === 404) return "not-found";
  if (status >= 500) return "ambiguous";
  return "bad-request";
}

/**
 * provider 오류 문구에 키가 그대로 되돌아와도 상태 파일·화면·로그로 새지 않게 지운다.
 * 자르기 전에 지워야 한다 — 잘린 키 조각은 더는 찾을 수 없다.
 */
export function redactSecret(text: string, secret: string): string {
  return secret ? text.replaceAll(secret, "[redacted]") : text;
}

async function errorFromResponse(response: Response, apiKey: string): Promise<CartesiaError> {
  const body = redactSecret(await response.text().catch(() => ""), apiKey);
  let detail = body.trim();
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const parts = [parsed.title, parsed.message, parsed.error].filter((part): part is string => typeof part === "string" && part !== "");
    if (parts.length > 0) detail = parts.join(": ");
  } catch {
    // provider가 JSON이 아닌 본문을 주면 그대로 줄여 쓴다.
  }
  detail = detail.replaceAll(/\s+/g, " ").slice(0, MAX_ERROR_DETAIL) || redactSecret(response.statusText, apiKey);
  return new CartesiaError(`Cartesia ${response.status}: ${detail}`, kindForStatus(response.status), response.status);
}

function readVoice(raw: unknown): CartesiaVoice | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id === "") return null;
  const accents: CartesiaVoiceAccent[] = [];
  if (Array.isArray(record.accents)) {
    for (const item of record.accents) {
      if (typeof item !== "object" || item === null) continue;
      const { accent, locale, is_native: isNative } = item as Record<string, unknown>;
      if (typeof accent !== "string") continue;
      accents.push({ accent, ...(typeof locale === "string" ? { locale } : {}), isNative: isNative === true });
    }
  }
  return {
    id: record.id,
    name: typeof record.name === "string" ? record.name : "",
    description: typeof record.description === "string" ? record.description : "",
    isOwner: record.is_owner === true,
    accents,
  };
}

export interface CartesiaClient {
  /** 크레딧을 쓰지 않는 목록 한 장 조회로 키가 유효한지 본다. */
  verifyKey(): Promise<void>;
  /** 이 키 조직이 소유한 활성 voice 전부. 상한까지 다 넘기지 못하면 `ambiguous`로 실패한다. */
  listOwnedVoices(): Promise<CartesiaVoice[]>;
  getVoice(id: string): Promise<CartesiaVoice>;
  cloneVoice(request: CartesiaCloneRequest): Promise<CartesiaVoice>;
  addAccents(id: string, accents: readonly string[]): Promise<CartesiaVoice>;
}

export function createCartesiaClient(
  apiKey: string,
  fetchImpl: FetchImpl = wrapFetchForProxy(fetch, CARTESIA_PROXY_PROVIDER) as FetchImpl,
): CartesiaClient {
  const headers = { Authorization: `Bearer ${apiKey}`, "Cartesia-Version": CARTESIA_VERSION };

  async function send(path: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${CARTESIA_API_ORIGIN}${path}`, {
        ...init,
        headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
        redirect: "error",
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : "network";
      throw new CartesiaError(`Cartesia 요청이 끝나지 않았습니다 (${reason})`, "ambiguous");
    }
    if (!response.ok) throw await errorFromResponse(response, apiKey);
    try {
      return await response.json();
    } catch {
      throw new CartesiaError("Cartesia 응답을 읽지 못했습니다", "ambiguous", response.status);
    }
  }

  async function voiceFrom(path: string, init: RequestInit, timeoutMs?: number): Promise<CartesiaVoice> {
    const voice = readVoice(await send(path, init, timeoutMs));
    if (!voice) throw new CartesiaError("Cartesia가 voice id 없는 응답을 돌려줬습니다", "ambiguous");
    return voice;
  }

  return {
    async verifyKey() {
      await send("/voices?limit=1&is_owner=true", { method: "GET" });
    },
    async listOwnedVoices() {
      const voices: CartesiaVoice[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const query = new URLSearchParams({ limit: String(LIST_PAGE_LIMIT), is_owner: "true" });
        if (cursor) query.set("starting_after", cursor);
        const body = await send(`/voices?${query}`, { method: "GET" });
        const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
        if (!Array.isArray(record.data)) throw new CartesiaError("Cartesia voice 목록 형식이 올바르지 않습니다", "ambiguous");
        for (const item of record.data) {
          const voice = readVoice(item);
          if (voice) voices.push(voice);
        }
        if (record.has_more !== true) return voices;
        const next = typeof record.next_page === "string" && record.next_page
          ? record.next_page
          : voices.at(-1)?.id;
        if (!next || next === cursor) break;
        cursor = next;
      }
      throw new CartesiaError("Cartesia voice 목록을 끝까지 확인하지 못했습니다", "ambiguous");
    },
    getVoice(id) {
      return voiceFrom(`/voices/${encodeURIComponent(id)}`, { method: "GET" });
    },
    cloneVoice(request) {
      const form = new FormData();
      form.set("clip", request.clip, request.fileName);
      form.set("name", request.name);
      form.set("description", request.description);
      form.set("language", request.language);
      form.set("accent", request.accent);
      form.set("access", "private");
      return voiceFrom("/voices/clone", { method: "POST", body: form }, UPLOAD_TIMEOUT_MS);
    },
    addAccents(id, accents) {
      return voiceFrom(`/voices/${encodeURIComponent(id)}/accents`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accents }),
      }, ACCENT_TIMEOUT_MS);
    },
  };
}
