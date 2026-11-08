import { NextResponse } from "next/server";
import { isAuthRetryableError, withOAuthAccess, type OAuthAccess } from "@oh-my-pi/pi-ai";
import { wrapFetchForProxy } from "@oh-my-pi/pi-ai/utils/proxy";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { LiveError } from "@/lib/live-session";
import { getOmpRuntime } from "@/lib/omp-runtime";
import { findTranslatorLanguage, type TranslatorLanguage } from "@/lib/translator-languages";

/** The Codex sign-in is the same one `lib/live-session.ts` uses for a live call. */
const CREDENTIAL_PROVIDER = "openai-codex";
const SECRETS_URL = "https://api.openai.com/v1/realtime/translations/client_secrets";
const TRANSLATE_MODEL = "gpt-realtime-translate";
const MAX_ERROR_BODY_LENGTH = 200;

export interface DraftSecretDeps {
  /** Run `attempt` with a bearer token, retrying on another credential when it fails with an auth error. */
  withToken: <T>(attempt: (token: string) => Promise<T>) => Promise<T>;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
}

const defaultDeps: DraftSecretDeps = {
  withToken: async (attempt) => {
    const { authStorage } = await getOmpRuntime();
    return await withOAuthAccess(authStorage, CREDENTIAL_PROVIDER, (access: OAuthAccess) => attempt(access.accessToken), {
      isAuthError: isAuthRetryableError,
      missingAccessMessage: "No Codex OAuth credential is available for the draft captions.",
    });
  },
  fetch: wrapFetchForProxy(fetch, CREDENTIAL_PROVIDER),
};

/** A short-lived browser credential for one translation session whose output is `language`. */
async function mintSecret(deps: DraftSecretDeps, token: string, language: TranslatorLanguage): Promise<string> {
  const response = await deps.fetch(SECRETS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ session: { model: TRANSLATE_MODEL, audio: { output: { language: language.code } } } }),
  });
  const text = await response.text();
  if (!response.ok) {
    const detail = text.trim().replaceAll(/\s+/g, " ").slice(0, MAX_ERROR_BODY_LENGTH) || response.statusText;
    const auth = response.status === 401 || response.status === 403;
    throw new LiveError(`Translation secret failed (${response.status}): ${detail}`, auth ? "live-auth" : "live-upstream", auth ? 401 : 502);
  }
  let secret: unknown;
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === "object" && "value" in body) secret = body.value;
  } catch {
    // Handled below with the other malformed answers.
  }
  if (typeof secret !== "string" || !secret) throw new LiveError("Translation secret answer had no secret", "live-upstream", 502);
  return secret;
}

/**
 * POST /api/live/draft-secret - mint the browser credentials for the quick draft captions.
 *
 * Body `{ mine, theirs }`, two distinct entries of `lib/translator-languages.ts`. The answer holds
 * one secret per session, `{ sessions: [{ language: mine, secret }, { language: theirs, secret }] }`:
 * the browser opens one dedicated translation session per output language and sends both the same
 * microphone audio. Secrets are never logged or stored here.
 */
export function createDraftSecretHandler(deps: DraftSecretDeps = defaultDeps) {
  return async function POST(req: Request): Promise<Response> {
    if (!isApiRequestAllowed(req)) {
      return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
    }
    if (!hasJsonContentType(req)) {
      return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
    }
    let mineCode: unknown;
    let theirsCode: unknown;
    try {
      const body: unknown = await req.json();
      if (body && typeof body === "object") {
        if ("mine" in body) mineCode = body.mine;
        if ("theirs" in body) theirsCode = body.theirs;
      }
    } catch {
      return NextResponse.json({ error: "bad-request" }, { status: 400 });
    }
    const mine = findTranslatorLanguage(mineCode);
    const theirs = findTranslatorLanguage(theirsCode);
    if (!mine || !theirs || mine.code === theirs.code) {
      return NextResponse.json({ error: "bad-request" }, { status: 400 });
    }

    try {
      const languages = [mine, theirs];
      const secrets = await deps.withToken((token) => Promise.all(languages.map((language) => mintSecret(deps, token, language))));
      const sessions = languages.map((language, index) => ({ language: language.code, secret: secrets[index] }));
      return NextResponse.json({ sessions }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      if (error instanceof LiveError) {
        return NextResponse.json({ error: error.kind, message: error.message }, { status: error.status });
      }
      const message = error instanceof Error ? error.message : String(error);
      // A missing or expired Codex credential is the one failure the user can fix.
      const isAuth = message.includes("OAuth") || message.includes("credential") || message.includes("401");
      return NextResponse.json(
        { error: isAuth ? "live-auth" : "live-upstream", message },
        { status: isAuth ? 401 : 502 },
      );
    }
  };
}
