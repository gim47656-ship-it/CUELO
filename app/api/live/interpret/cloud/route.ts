import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { readLivePace } from "@/lib/live-pace";
import { findTranslatorLanguage } from "@/lib/translator-languages";
import { parseInterpreterContext } from "@/lib/translator-context";
import { GEMINI_INTERPRETER_MODEL } from "@/lib/gemini-interpreter";
import { CloudInterpreterError, createCloudCall, hasCloudCredentials, readCloudConfig, requireCloudConfig, stopCloudCall } from "@/lib/cloud-interpreter";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/live/interpret/cloud - whether the server can open a Google Cloud(Vertex AI) interpreter
 * call: a project and location are set (`configured`) and an ADC credential file exists (`signedIn`).
 * No project id, path or credential detail.
 */
export function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  return NextResponse.json(
    { configured: readCloudConfig() !== null, signedIn: hasCloudCredentials(), model: GEMINI_INTERPRETER_MODEL },
    { headers: NO_STORE },
  );
}

/**
 * POST /api/live/interpret/cloud - open a relayed Vertex AI Live session for this pair.
 *
 * Body `{ mine, theirs, context? }`, validated like the Developer API route. Returns
 * `{ callId, model }`; the browser then reads `/cloud/events?callId=` and posts audio to
 * `/cloud/input`. Only the server's ADC sign-in is used; nothing else is tried.
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let mineCode: unknown;
  let theirsCode: unknown;
  let contextValue: unknown;
  try {
    const body: unknown = await req.json();
    if (body && typeof body === "object") {
      if ("mine" in body) mineCode = body.mine;
      if ("theirs" in body) theirsCode = body.theirs;
      if ("context" in body) contextValue = body.context;
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
    const result = await createCloudCall({
      config: requireCloudConfig(),
      mine,
      theirs,
      context: parseInterpreterContext(contextValue),
      pace: await readLivePace(),
    });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof CloudInterpreterError) {
      return NextResponse.json({ error: error.kind, message: error.message }, { status: error.status, headers: NO_STORE });
    }
    console.error("[cloud-interpreter] open failed:", error instanceof Error ? error.name : typeof error);
    return NextResponse.json({ error: "live-upstream", message: "Google Cloud interpreter call could not be opened." }, { status: 502, headers: NO_STORE });
  }
}

/** DELETE /api/live/interpret/cloud?callId= - stop a relayed call. */
export function DELETE(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const callId = new URL(req.url).searchParams.get("callId");
  if (callId) stopCloudCall(callId);
  return new Response(null, { status: 204 });
}
