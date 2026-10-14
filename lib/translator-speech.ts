/**
 * 통역 모드의 읽어 주기. 통화 캐릭터 음성과 같은 Cartesia 키(AuthStorage `cartesia`)로 번역문 한 건을
 * `sonic-3.6` mp3로 합성한다. 목소리는 그 언어가 원어(native accent)인 공개 voice를 언어마다 한 번
 * 골라 프로세스에 기억하므로, 매 문장 조회하지 않는다. 키는 요청 헤더로만 나가고 오류 문구에서 지운다.
 */
import { wrapFetchForProxy } from "@oh-my-pi/pi-ai/utils/proxy";
import { CARTESIA_API_ORIGIN, CARTESIA_PROXY_PROVIDER, CARTESIA_VERSION, redactSecret } from "./cartesia";
import { LIVE_VOICE_KEY_PROVIDER } from "./live-character-voice-runtime";
import { getOmpRuntime } from "./omp-runtime";
import type { TranslatorLanguage } from "./translator-languages";

export const TRANSLATOR_SPEECH_MODEL = "sonic-3.6";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ERROR_DETAIL = 200;

/** 키가 없거나 Cartesia가 거절한 경우. 화면은 이때 폰 기본 목소리로 대신 읽는다. */
export class TranslatorSpeechError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

declare global {
  var __translatorVoiceIds: Map<string, Promise<string>> | undefined;
}

const cartesiaFetch = wrapFetchForProxy(fetch, CARTESIA_PROXY_PROVIDER);

async function cartesia(
  apiKey: string,
  path: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
  signal?: AbortSignal,
): Promise<Response> {
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await cartesiaFetch(`${CARTESIA_API_ORIGIN}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, "Cartesia-Version": CARTESIA_VERSION, ...init.headers },
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) {
    const body = redactSecret(await response.text().catch(() => ""), apiKey).replaceAll(/\s+/g, " ").slice(0, MAX_ERROR_DETAIL);
    throw new TranslatorSpeechError(`Cartesia ${response.status}: ${body || response.statusText}`, 502);
  }
  return response;
}

/**
 * 그 언어가 원어인 공개 voice. 한 페이지(최대 100개)에 원어 표시가 있는 voice가 없을 때만 그 언어로 걸러진
 * 첫 voice를 쓴다. 같은 언어의 첫 요청들은 같은 조회를 기다리고, 조회가 실패하면 다음 요청이 다시 고른다.
 */
function voiceIdFor(apiKey: string, language: TranslatorLanguage): Promise<string> {
  const voiceIds = (globalThis.__translatorVoiceIds ??= new Map());
  const pending = voiceIds.get(language.code);
  if (pending) return pending;
  const lookup = (async () => {
    const query = new URLSearchParams({ language: language.code, is_owner: "false", limit: "100" });
    const body = (await (await cartesia(apiKey, `/voices?${query}`, { method: "GET" })).json()) as {
      data?: Array<{ id?: unknown; accents?: Array<{ locale?: unknown; is_native?: unknown }> }>;
    };
    const voices = (body.data ?? []).filter((voice): voice is { id: string; accents?: Array<{ locale?: unknown; is_native?: unknown }> } => typeof voice.id === "string");
    const base = language.code.split("-")[0];
    const native = voices.find((voice) => voice.accents?.some((accent) =>
      accent.is_native === true && typeof accent.locale === "string" && accent.locale.split(/[-_]/)[0] === base));
    const id = (native ?? voices[0])?.id;
    if (!id) throw new TranslatorSpeechError(`Cartesia has no voice for ${language.code}`, 502);
    return id;
  })();
  voiceIds.set(language.code, lookup);
  lookup.catch(() => {
    if (voiceIds.get(language.code) === lookup) voiceIds.delete(language.code);
  });
  return lookup;
}

/** 번역문 한 건의 mp3. */
export async function synthesizeTranslation(text: string, language: TranslatorLanguage, signal?: AbortSignal): Promise<ArrayBuffer> {
  const { authStorage } = await getOmpRuntime();
  const credential = authStorage.credentials.get(LIVE_VOICE_KEY_PROVIDER);
  const apiKey = credential?.type === "api_key" ? credential.key : undefined;
  if (!apiKey) throw new TranslatorSpeechError("No Cartesia key is stored", 503);
  const voice = await voiceIdFor(apiKey, language);
  const response = await cartesia(apiKey, "/tts/bytes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model_id: TRANSLATOR_SPEECH_MODEL,
      transcript: text,
      voice: { id: voice },
      language: language.code,
      output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
    }),
  }, signal);
  return response.arrayBuffer();
}
