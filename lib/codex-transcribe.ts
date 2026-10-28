/**
 * Fallback speech-to-text through ChatGPT's dictation endpoint (`POST {CODEX_BASE_URL}/transcribe`)
 * with the Codex OAuth login CUELO already holds. The endpoint is private and undocumented: it takes a
 * multipart `file` (the upload's extension picks the decoder) and answers `{ text }`. It is used only
 * after the primary transcriber failed, on short MP3 chunks.
 *
 * Auth is one credential read from CUELO's shared `authStorage`. There is no `withOAuthAccess`, so a
 * refusal is never retried and never rotated to another account, and no attestation is built. The
 * request identity is the one `lib/live-session.ts` already sends for Codex live calls.
 */
import { wrapFetchForProxy } from "@oh-my-pi/pi-ai/utils/proxy";
import {
  applyCodexResidencyHeader,
  CODEX_BASE_URL,
  CODEX_CLIENT_VERSION,
  getCodexAccountId,
  OPENAI_HEADERS,
} from "@oh-my-pi/pi-catalog/wire/codex";

/**
 * Length of each fallback chunk. Chosen from one live request that returned 200 for a 15 s clip; it is
 * not a documented limit of the endpoint.
 */
export const CODEX_CHUNK_SECONDS = 15;
/** One chunk request's deadline. */
export const CODEX_REQUEST_TIMEOUT_MS = 60_000;

const PROVIDER = "openai-codex";
const ORIGINATOR = "Codex Desktop";
const MP3_MIME_TYPE = "audio/mpeg";
const UPLOAD_NAME = "audio.mp3";

export type CodexAccess = { accessToken: string; accountId?: string };

export type CodexTranscriberDeps = {
  getAccess: (signal?: AbortSignal) => Promise<CodexAccess | undefined>;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  baseUrl: string;
  timeoutMs?: number;
};

/** Builds a transcriber over injected credentials and transport; the shipped one is {@link transcribeAudioWithCodex}. */
export function createCodexTranscriber({ getAccess, fetch: fetchImpl, baseUrl, timeoutMs = CODEX_REQUEST_TIMEOUT_MS }: CodexTranscriberDeps) {
  return async (audio: Uint8Array, mimeType: string, signal?: AbortSignal): Promise<string> => {
    // The endpoint answers 500 for an unknown extension, so only the chunks CUELO itself encodes go out.
    if (mimeType !== MP3_MIME_TYPE) throw new Error(`Codex transcription takes only MP3 chunks, not ${mimeType}`);
    const access = await getAccess(signal);
    if (!access?.accessToken) throw new Error("No Codex OAuth credential is available");
    const headers: Record<string, string> = {
      Authorization: `Bearer ${access.accessToken}`,
      Accept: "application/json",
      "User-Agent": `Codex Desktop/${CODEX_CLIENT_VERSION}`,
      [OPENAI_HEADERS.ORIGINATOR]: ORIGINATOR,
    };
    const accountId = access.accountId ?? getCodexAccountId(access.accessToken);
    if (accountId) headers[OPENAI_HEADERS.ACCOUNT_ID] = accountId;
    applyCodexResidencyHeader(headers, access.accessToken);

    // No `language` field: the endpoint detects the spoken language.
    const form = new FormData();
    // Chunks are read from disk into plain ArrayBuffer-backed arrays; the type only lost that.
    const bytes = audio as Uint8Array<ArrayBuffer>;
    form.append("file", new File([bytes], UPLOAD_NAME, { type: MP3_MIME_TYPE }));
    const deadline = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(`${baseUrl}/transcribe`, {
      method: "POST",
      headers,
      body: form,
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    if (!response.ok) {
      // The body of an error reply (a gateway page can echo the request headers) is not forwarded.
      await response.body?.cancel();
      throw new Error(`Codex transcription failed (HTTP ${response.status})`);
    }
    const body = await response.text();
    let text: unknown;
    try {
      text = (JSON.parse(body) as { text?: unknown }).text;
    } catch {
      throw new Error("Codex transcription returned a response that is not JSON");
    }
    if (typeof text !== "string") throw new Error("Codex transcription response has no text");
    return text.trim();
  };
}

/** One chunk through CUELO's shared omp runtime and the Codex login it holds. */
export async function transcribeAudioWithCodex(audio: Uint8Array, mimeType: string, signal?: AbortSignal): Promise<string> {
  const { getOmpRuntime } = await import("@/lib/omp-runtime");
  const { authStorage } = await getOmpRuntime();
  return createCodexTranscriber({
    getAccess: (abort) => authStorage.oauth.access(PROVIDER, undefined, { signal: abort }),
    fetch: wrapFetchForProxy(fetch, PROVIDER),
    baseUrl: CODEX_BASE_URL,
  })(audio, mimeType, signal);
}
