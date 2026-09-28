/**
 * Server half of the Korean thinking display: an English thinking block is sent to Gemini 3.8 Flash
 * (Antigravity) and the translation is cached on disk by content hash. Only the display changes;
 * the session file and the model context keep the original.
 *
 * Prompt, few-shot, tone and request tuning (3 s hedge, 12 s deadline + 2.5 s per 1k chars, one
 * retry, truncated output rejected) come from omp-thinking-ko v1.0.1
 * (https://github.com/hvvsdcm/omp-thinking-ko), MIT License, Copyright (c) 2026 hvvsdcm:
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 *   and associated documentation files (the "Software"), to deal in the Software without
 *   restriction, including without limitation the rights to use, copy, modify, merge, publish,
 *   distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 *   Software is furnished to do so, subject to the following conditions: The above copyright notice
 *   and this permission notice shall be included in all copies or substantial portions of the
 *   Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const TRANSLATION_PROVIDER = "google-antigravity";
export const TRANSLATION_MODEL = "gemini-3.8-flash";
export const MAX_SOURCE_CHARS = 40_000;
const HEDGE_AFTER_MS = 3_000;
const TIMEOUT_MS = 12_000;
const TIMEOUT_EXTRA_MS_PER_1K_CHARS = 2_500;
const MAX_ATTEMPTS = 2;
const MAX_IN_FLIGHT_REQUESTS = 3;
const MEMORY_CACHE_ENTRIES = 200;

export const SYSTEM_PROMPT = [
  "너는 코딩 에이전트가 속으로 하는 생각(영어)을 한국어 혼잣말로 옮기는 번역기야.",
  "규칙:",
  "- 짧고 단순한 반말·구어체로 써. 친구한테 중얼거리듯이. 감탄사(아!!, 오, 음..)와 말줄임(..)을 자연스럽게 써도 돼. 가끔 가벼운 욕(시발 같은)도 괜찮아.",
  "- 격식체 금지: '~합니다', '~했습니다', '~입니다', '~하겠습니다', '~해요' 쓰지 마.",
  "- 종결어미의 쌍시옷(ㅆ)은 시옷(ㅅ)으로 써: 있어→잇어, 했어→햇어, 됐어→됏어, 썼어→썻어, 찾았어→찾앗어, 하겠다→하겟다.",
  "- 파일명·코드 식별자·명령어·URL·숫자는 원문 그대로 둬.",
  "- 뜻은 빼거나 보태지 말고, 문장은 더 짧게 끊어. 마크다운 굵은 제목(**...**)이 있으면 제목도 짧게 번역해서 그대로 굵게 둬.",
  "- 입력이 이미 한국어면 뜻은 그대로 두고 말투만 이 규칙대로 바꿔(존댓말·격식체 → 반말).",
  "- 번역문만 출력해. 설명, 따옴표, 머리말 붙이지 마.",
].join("\n");

export const FEW_SHOT: ReadonlyArray<{ en: string; ko: string }> = [
  { en: "An error occurred while running the build. I found the cause, let me fix it.", ko: "아!! 시발 오류를 찾앗어.. 고쳐볼게." },
  {
    en: "The test is failing because the date parser expects ISO format. I need to check the implementation first.",
    ko: "테스트 터진 거 날짜 파서가 ISO 형식만 받아서 그런 거엿어. 일단 구현부터 봐야겟다.",
  },
  {
    en: "**Checking the config**\n\nThe user wants dark mode enabled. I've already updated settings.json, so now I'll verify the build passes.",
    ko: "**설정 확인**\n\n다크 모드 켜달래. settings.json은 벌써 고쳣으니까 이제 빌드 되는지 볼게.",
  },
];

/** One model call: resolves the Korean text or throws (timeout, auth, bad stop reason). */
export type TranslateCall = (source: string, signal: AbortSignal) => Promise<string>;

export interface ThinkingTranslatorOptions {
  cacheDir: string;
  call: TranslateCall;
  hedgeAfterMs?: number;
}

export function deadlineFor(source: string): number {
  return TIMEOUT_MS + Math.floor(Math.max(0, source.length - 1_000) / 1_000) * TIMEOUT_EXTRA_MS_PER_1K_CHARS;
}

export function maxTokensFor(source: string): number {
  return Math.min(16_384, Math.max(2_048, Math.ceil(source.length / 2) * 2 + 512));
}

function cacheKey(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 32);
}

/** Strips a leading "번역:" header the model sometimes adds, and surrounding blank lines. */
export function cleanTranslation(raw: string): string {
  return raw
    .replace(/^(?:[ \t]*\r?\n)+/, "")
    .replace(/(?:\r?\n[ \t]*)+$/, "")
    .replace(/^(?:번역|Translation)[ \t]*[:：][ \t]*(?:\r?\n|(?=[가-힣]))/i, "");
}

class Slots {
  #free: number;
  readonly #waiters: Array<() => void> = [];
  constructor(size: number) { this.#free = size; }
  tryAcquire(): boolean {
    if (this.#free === 0) return false;
    this.#free -= 1;
    return true;
  }
  async acquire(signal: AbortSignal): Promise<void> {
    if (this.tryAcquire()) return;
    await new Promise<void>((resolve, reject) => {
      const wake = () => { signal.removeEventListener("abort", onAbort); resolve(); };
      const onAbort = () => {
        const index = this.#waiters.indexOf(wake);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(signal.reason);
      };
      this.#waiters.push(wake);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  release(): void {
    const next = this.#waiters.shift();
    if (next) next();
    else this.#free += 1;
  }
}

/**
 * One hedged attempt: if the first request has not finished after the hedge delay and a request
 * slot is free, the same request is sent again and the first success wins.
 */
async function hedgedAttempt(call: TranslateCall, source: string, slots: Slots, hedgeAfterMs: number): Promise<string> {
  const deadline = AbortSignal.timeout(deadlineFor(source));
  const controllers: AbortController[] = [];
  const launch = (): Promise<string> => {
    const controller = new AbortController();
    controllers.push(controller);
    return call(source, AbortSignal.any([deadline, controller.signal])).finally(() => slots.release());
  };
  await slots.acquire(deadline);
  return await new Promise<string>((resolve, reject) => {
    let pending = 0;
    let settled = false;
    const hedge = { timer: undefined as ReturnType<typeof setTimeout> | undefined };
    const start = () => {
      pending += 1;
      launch().then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(hedge.timer);
          for (const controller of controllers) controller.abort();
          resolve(value);
        },
        (error) => {
          pending -= 1;
          if (!settled && pending === 0) {
            settled = true;
            clearTimeout(hedge.timer);
            reject(error);
          }
        },
      );
    };
    start();
    hedge.timer = setTimeout(() => {
      if (!settled && slots.tryAcquire()) start();
    }, hedgeAfterMs);
  });
}

export function createThinkingTranslator({ cacheDir, call, hedgeAfterMs = HEDGE_AFTER_MS }: ThinkingTranslatorOptions) {
  const memory = new Map<string, Promise<string>>();
  const slots = new Slots(MAX_IN_FLIGHT_REQUESTS);

  async function translateUncached(source: string, key: string): Promise<string> {
    const file = join(cacheDir, `${key}.md`);
    try {
      return await readFile(file, "utf8");
    } catch {
      // Not cached yet.
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        const ko = cleanTranslation(await hedgedAttempt(call, source, slots, hedgeAfterMs));
        if (!ko.trim()) throw new Error("empty translation");
        await mkdir(cacheDir, { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        await writeFile(temp, ko, "utf8");
        await rename(temp, file);
        return ko;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  return function translate(source: string): Promise<string> {
    const key = cacheKey(source);
    const cached = memory.get(key);
    if (cached) {
      memory.delete(key);
      memory.set(key, cached);
      return cached;
    }
    const request = translateUncached(source, key);
    memory.set(key, request);
    request.catch(() => { if (memory.get(key) === request) memory.delete(key); });
    if (memory.size > MEMORY_CACHE_ENTRIES) {
      const oldest = memory.keys().next().value;
      if (oldest) memory.delete(oldest);
    }
    return request;
  };
}

/** The real model call through CUELO's shared omp runtime. */
export async function callGemini(source: string, signal: AbortSignal): Promise<string> {
  const [{ completeSimple }, { getOmpRuntime }] = await Promise.all([
    import("@oh-my-pi/pi-ai"),
    import("@/lib/omp-runtime"),
  ]);
  const { modelRegistry } = await getOmpRuntime();
  const model = modelRegistry.find(TRANSLATION_PROVIDER, TRANSLATION_MODEL);
  if (!model) throw new Error(`${TRANSLATION_PROVIDER}/${TRANSLATION_MODEL} is not available`);
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No credentials for ${TRANSLATION_PROVIDER}` : auth.error);
  const now = Date.now();
  const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const messages = FEW_SHOT.flatMap((shot) => [
    { role: "user" as const, content: shot.en, timestamp: now },
    {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: shot.ko }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: zeroCost },
      stopReason: "stop" as const,
      timestamp: now,
    },
  ]);
  const result = await completeSimple(model, {
    systemPrompt: [SYSTEM_PROMPT],
    messages: [...messages, { role: "user", content: source, timestamp: now }],
  }, {
    apiKey: auth.apiKey,
    headers: auth.headers,
    maxTokens: maxTokensFor(source),
    disableReasoning: true,
    cacheRetention: "none",
    signal,
  });
  if (result.stopReason !== "stop") {
    throw new Error(`translation stopped: ${result.stopReason}${result.errorMessage ? ` (${result.errorMessage})` : ""}`);
  }
  return result.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
