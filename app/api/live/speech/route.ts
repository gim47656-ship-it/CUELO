import { withOAuthAccess, isAuthRetryableError } from "@oh-my-pi/pi-ai";
import { getProxyForUrl, wrapFetchForProxy } from "@oh-my-pi/pi-ai/utils/proxy";
import { configuredLiveVoice } from "@/lib/live-session";
import { getOmpRuntime } from "@/lib/omp-runtime";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { INTERPRETER_TEXT_OUTPUT_MAX_CHARS } from "@/lib/translator-context";
import { readElevenLabsKey, synthesizeElevenLabs } from "@/lib/elevenlabs-tts";
import { synthesize } from "./synthesize";

const provider = "openai-codex";
const realtimeVoices = ["alloy", "ash", "ballad", "cedar", "coral", "echo", "marin", "sage", "shimmer", "verse"];
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  const input = await req.json().catch(() => null);
  if (typeof input?.text !== "string" || !input.text.trim() || input.text.length > INTERPRETER_TEXT_OUTPUT_MAX_CHARS) return Response.json({ error: "bad-request" }, { status: 400 });
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(60000)]);
  if (input.engine === "elevenlabs") {
    const key = await readElevenLabsKey();
    if (!key) return Response.json({ error: "elevenlabs-unavailable" }, { status: 503 });
    try {
      const upstream = await synthesizeElevenLabs(input.text, key, signal);
      if (!upstream.ok || !upstream.body || !upstream.headers.get("content-type")?.startsWith("audio/")) {
        await upstream.body?.cancel().catch(() => {});
        return Response.json({ error: "speech-unavailable" }, { status: 502 });
      }
      return new Response(upstream.body, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
    } catch { return Response.json({ error: "speech-unavailable" }, { status: 502 }); }
  }
  try {
    const { authStorage } = await getOmpRuntime();
    const configured = await configuredLiveVoice(undefined);
    const voice = realtimeVoices.includes(configured) ? configured : "marin";
    const token = await withOAuthAccess(authStorage, provider, async ({ accessToken }) => {
      const r = await wrapFetchForProxy(fetch, provider)("https://api.openai.com/v1/realtime/client_secrets", { method: "POST", signal,
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: 60 }, session: {
          type: "realtime", model: "gpt-realtime", audio: { output: { voice, format: { type: "audio/pcm", rate: 24000 } } },
        } }) });
      if (!r.ok) throw Object.assign(new Error("Speech credential refused"), { status: r.status });
      const { value } = await r.json();
      if (typeof value !== "string" || !value) throw new Error("Speech credential unavailable");
      return value;
    }, { isAuthError: isAuthRetryableError, missingAccessMessage: "Codex sign-in required" });
    const wav = await synthesize(input.text, (url) => Reflect.construct(WebSocket, [url, {
      headers: { Authorization: `Bearer ${token}` }, proxy: getProxyForUrl(provider, new URL(url)),
    }]), signal);
    return new Response(wav, { headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" } });
  } catch { return Response.json({ error: "speech-unavailable" }, { status: 502 }); }
}
