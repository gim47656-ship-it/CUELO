import { isAuthRetryableError, withOAuthAccess } from "@oh-my-pi/pi-ai";
import { wrapFetchForProxy } from "@oh-my-pi/pi-ai/utils/proxy";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getOmpRuntime } from "@/lib/omp-runtime";
import { findTranslatorLanguage } from "@/lib/translator-languages";

export interface TranscribeSecretDeps {
  withToken: <T>(attempt: (token: string) => Promise<T>) => Promise<T>;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
}
const defaults: TranscribeSecretDeps = {
  withToken: async (attempt) => {
    const { authStorage } = await getOmpRuntime();
    return withOAuthAccess(authStorage, "openai-codex", ({ accessToken }) => attempt(accessToken), {
      isAuthError: isAuthRetryableError,
      missingAccessMessage: "No Codex OAuth credential is available.",
    });
  },
  fetch: wrapFetchForProxy(fetch, "openai-codex"),
};

export function createTranscribeSecretHandler(deps = defaults) {
  return async function POST(req: Request): Promise<Response> {
    if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted API request" }, { status: 403 });
    if (!hasJsonContentType(req)) return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
    let raw: Record<string, unknown>;
    try { raw = await req.json(); } catch { return Response.json({ error: "bad-request" }, { status: 400 }); }
    const mine = findTranslatorLanguage(raw?.mine), theirs = findTranslatorLanguage(raw?.theirs);
    if (!mine || !theirs || mine.code === theirs.code) return Response.json({ error: "bad-request" }, { status: 400 });
    try {
      const result = await deps.withToken(async (token) => {
        const upstream = await deps.fetch("https://api.openai.com/v1/realtime/client_secrets", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: 60 }, session: {
            type: "transcription", audio: { input: {
              format: { type: "audio/pcm", rate: 24000 },
              transcription: { model: "gpt-live-transcribe", delay: "low", languages: [mine.code, theirs.code] },
              turn_detection: null,
            } },
          } }),
          signal: AbortSignal.any([req.signal, AbortSignal.timeout(15000)]),
        });
        if (!upstream.ok) {
          // Do not reflect provider error bodies: credentials and internal details never reach the UI.
          const error = new Error("Transcription credential request refused") as Error & { status: number };
          error.status = upstream.status;
          throw error;
        }
        const body = await upstream.json() as { value?: unknown };
        if (typeof body.value !== "string" || !body.value) throw new Error("Incomplete transcription credential");
        return body.value;
      });
      return Response.json({ secret: result }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
      const auth = status === 401 || status === 403 || (error instanceof Error && /OAuth|credential.*available/i.test(error.message));
      return Response.json({ error: auth ? "live-auth" : "live-upstream" }, { status: auth ? 401 : 502 });
    }
  };
}
