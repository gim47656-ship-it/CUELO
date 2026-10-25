import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import {
  createGeminiInterpreterToken,
  GEMINI_INTERPRETER_MODEL,
  GeminiInterpreterError,
  listGeminiCredentials,
  NEW_SESSION_WINDOW_MS,
  TOKEN_LIFETIME_MS,
} from "./gemini-interpreter";
import { interpreterInstructions } from "./translator-live";
import { parseInterpreterContext } from "./translator-context";
import { GET, POST } from "../app/api/live/interpret/gemini/route";
import { findTranslatorLanguage } from "./translator-languages";

/** Fake stored values. Not key-shaped on purpose; the tests check that these never leave the server. */
const KEY_MARKER = "example-google-credential";
const GOOGLE_KEY = `${KEY_MARKER}-alpha`;
const SECOND_GOOGLE_KEY = `${KEY_MARKER}-beta`;
const OPENAI_KEY = "example-openai-token-not-a-real-key";

const ko = findTranslatorLanguage("ko")!;
const en = findTranslatorLanguage("en")!;
const context = parseInterpreterContext({
  profile: { mood: "polite", gender: "female", age: "30s" },
  history: [{ role: "user", text: "두 그릇 주세요" }, { role: "assistant", text: "Two bowls, please." }],
});
const NOW = Date.parse("2026-10-25T00:00:00.000Z");

let auth: AuthStorage;
let googleId = 0;
let secondGoogleId = 0;
let openaiId = 0;

beforeAll(async () => {
  auth = await AuthStorage.create(":memory:");
  await auth.credentials.set("google", [
    { type: "api_key", key: GOOGLE_KEY },
    { type: "api_key", key: SECOND_GOOGLE_KEY },
  ]);
  await auth.credentials.set("openai", { type: "api_key", key: OPENAI_KEY });
  [googleId, secondGoogleId] = auth.credentials.list("google").map((row) => row.id);
  openaiId = auth.credentials.list("openai")[0]!.id;
});

/** The token request this module sends (parsed back from the captured fetch body). */
interface TokenBody {
  uses: number;
  expireTime: string;
  newSessionExpireTime: string;
  fieldMask?: unknown;
  bidiGenerateContentSetup: {
    model: string;
    generationConfig: unknown;
    tools?: unknown;
    inputAudioTranscription?: unknown;
    outputAudioTranscription?: unknown;
    systemInstruction: { parts: { text: string }[] };
  };
}

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: TokenBody;
}

function fakeFetch(response: Response, calls: Captured[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    });
    return response;
  }) as typeof fetch;
}

const tokenResponse = () => Response.json({ name: "auth_tokens/test-token" });

function mint(credentialId: number, response: Response, calls: Captured[] = []) {
  return createGeminiInterpreterToken({
    credentials: auth.credentials,
    credentialId,
    mine: ko,
    theirs: en,
    context,
    pace: "slow",
    fetchImpl: fakeFetch(response, calls),
    now: NOW,
  });
}

async function rejection(promise: Promise<unknown>): Promise<GeminiInterpreterError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GeminiInterpreterError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("credential selection", () => {
  test("lists enabled Google API keys by id without any key bytes", () => {
    const options = listGeminiCredentials(auth.credentials);
    expect(options).toEqual([
      { id: googleId, label: `Google API 키 #${googleId}` },
      { id: secondGoogleId, label: `Google API 키 #${secondGoogleId}` },
    ]);
    expect(JSON.stringify(options)).not.toContain(KEY_MARKER);
  });

  test("uses exactly the selected key, not the first one", async () => {
    const calls: Captured[] = [];
    await mint(secondGoogleId, tokenResponse(), calls);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers["x-goog-api-key"]).toBe(SECOND_GOOGLE_KEY);
  });

  test("rejects an unknown id, a non-Google key and an OAuth row without calling Google", async () => {
    const calls: Captured[] = [];
    for (const id of [999_999, openaiId]) {
      const error = await rejection(mint(id, tokenResponse(), calls));
      expect(error.kind).toBe("credential-unavailable");
      expect(error.status).toBe(409);
    }
    const oauthOnly = {
      list: () => [{ id: 7, credential: { type: "oauth", access: "x" } }],
    };
    const error = await rejection(createGeminiInterpreterToken({
      credentials: oauthOnly,
      credentialId: 7,
      mine: ko,
      theirs: en,
      context,
      pace: "normal",
      fetchImpl: fakeFetch(tokenResponse(), calls),
    }));
    expect(error.kind).toBe("credential-unavailable");
    expect(calls).toHaveLength(0);
  });

  test("a disabled key is refused and no other key is used instead", async () => {
    const scratch = await AuthStorage.create(":memory:");
    await scratch.credentials.set("google", [
      { type: "api_key", key: GOOGLE_KEY },
      { type: "api_key", key: SECOND_GOOGLE_KEY },
    ]);
    const [first, second] = scratch.credentials.list("google").map((row) => row.id);
    expect(await scratch.credentials.disable(first!, "test: revoked")).toBe(true);
    const calls: Captured[] = [];
    const error = await rejection(createGeminiInterpreterToken({
      credentials: scratch.credentials,
      credentialId: first!,
      mine: ko,
      theirs: en,
      context,
      pace: "normal",
      fetchImpl: fakeFetch(tokenResponse(), calls),
    }));
    expect(error.kind).toBe("credential-unavailable");
    expect(calls).toHaveLength(0);
    expect(listGeminiCredentials(scratch.credentials).map((option) => option.id)).toEqual([second!]);
  });
});

describe("token request", () => {
  test("locks the whole interpreter setup, single use and short-lived", async () => {
    const calls: Captured[] = [];
    const result = await mint(googleId, tokenResponse(), calls);
    const { url, body } = calls[0]!;
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/auth_tokens");
    expect(body.uses).toBe(1);
    expect(body.newSessionExpireTime).toBe(new Date(NOW + NEW_SESSION_WINDOW_MS).toISOString());
    expect(body.expireTime).toBe(new Date(NOW + TOKEN_LIFETIME_MS).toISOString());
    expect(TOKEN_LIFETIME_MS).toBeLessThanOrEqual(30 * 60_000);
    // No field mask: Gemini takes the setup entirely from the token, never from the browser.
    expect(body.fieldMask).toBeUndefined();
    const setup = body.bidiGenerateContentSetup;
    expect(setup.model).toBe(`models/${GEMINI_INTERPRETER_MODEL}`);
    expect(setup.generationConfig).toEqual({ responseModalities: ["AUDIO"] });
    expect(setup.tools).toBeUndefined();
    expect(setup.inputAudioTranscription).toBeDefined();
    expect(setup.outputAudioTranscription).toBeDefined();
    // The shared prompt with the chosen mood, gender, age, pace and earlier lines.
    const instruction = setup.systemInstruction.parts[0]!.text;
    expect(instruction).toBe(interpreterInstructions(ko, en, context, "slow"));
    expect(instruction).toContain("a woman in their 30s");
    expect(instruction).toContain("Two bowls, please.");
    expect(result).toEqual({
      token: "auth_tokens/test-token",
      model: GEMINI_INTERPRETER_MODEL,
      expiresAt: body.expireTime,
      newSessionExpiresAt: body.newSessionExpireTime,
    });
  });

  test("an invalid key is an auth failure; quota and other refusals are upstream; messages never echo Google's text", async () => {
    const googleError = (status: number, code: string, reason?: string) => Response.json(
      { error: { code: status, status: code, message: `leak ${GOOGLE_KEY}`, details: reason ? [{ reason }] : [] } },
      { status },
    );
    const invalid = await rejection(mint(googleId, googleError(400, "INVALID_ARGUMENT", "API_KEY_INVALID")));
    expect([invalid.kind, invalid.status]).toEqual(["live-auth", 401]);
    const denied = await rejection(mint(googleId, googleError(403, "PERMISSION_DENIED")));
    expect([denied.kind, denied.status]).toEqual(["live-auth", 401]);
    const quota = await rejection(mint(googleId, googleError(429, "RESOURCE_EXHAUSTED")));
    expect([quota.kind, quota.status]).toEqual(["live-upstream", 502]);
    expect(quota.message).toContain("RESOURCE_EXHAUSTED");
    const badSetup = await rejection(mint(googleId, googleError(400, "INVALID_ARGUMENT")));
    expect(badSetup.kind).toBe("live-upstream");
    for (const error of [invalid, denied, quota, badSetup]) expect(error.message).not.toContain(KEY_MARKER);
  });
});

describe("route", () => {
  const original = globalThis.__ompRuntimePromise;
  const originalFetch = globalThis.fetch;
  const calls: Captured[] = [];

  beforeAll(() => {
    // The route reads the runtime lazily per request; only `authStorage` is used.
    globalThis.__ompRuntimePromise = Promise.resolve({ authStorage: auth } as unknown as Awaited<typeof original & {}>);
    globalThis.fetch = fakeFetch(tokenResponse(), calls);
  });
  afterAll(() => {
    globalThis.__ompRuntimePromise = original;
    globalThis.fetch = originalFetch;
  });

  const post = (body: unknown) => POST(new Request("http://localhost/api/live/interpret/gemini", {
    method: "POST",
    headers: { "Content-Type": "application/json", host: "localhost:3000" },
    body: JSON.stringify(body),
  }));

  test("GET lists ids and labels only", async () => {
    const response = await GET(new Request("http://localhost/api/live/interpret/gemini", { headers: { host: "localhost:3000" } }));
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ credentials: listGeminiCredentials(auth.credentials), model: GEMINI_INTERPRETER_MODEL });
    expect(text).not.toContain(KEY_MARKER);
  });

  test("POST validates languages and the credential id before anything else", async () => {
    for (const body of [
      { mine: "ko", theirs: "ko", credentialId: googleId },
      { mine: "ko", theirs: "xx", credentialId: googleId },
      { mine: "ko", theirs: "en", credentialId: "27" },
      { mine: "ko", theirs: "en", credentialId: 0 },
    ]) expect((await post(body)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("POST refuses a non-Google key and returns only the token for a valid one", async () => {
    const refused = await post({ mine: "ko", theirs: "en", credentialId: openaiId });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe("credential-unavailable");

    const response = await post({ mine: "ko", theirs: "en", credentialId: googleId, context: { profile: { mood: "formal" } } });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(text).token).toBe("auth_tokens/test-token");
    expect(text).not.toContain(KEY_MARKER);
    const instruction = calls.at(-1)!.body.bidiGenerateContentSetup.systemInstruction.parts[0]!.text;
    expect(instruction).toContain("formal");
  });
});
