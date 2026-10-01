import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { CartesiaError } from "@/lib/cartesia";
import { getLiveVoiceService } from "@/lib/live-character-voice-runtime";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function failure(error: unknown) {
  if (error instanceof CartesiaError) {
    const status = error.kind === "auth" || error.kind === "bad-request" ? 400 : error.kind === "rate" ? 429 : 502;
    const code = error.kind === "auth" ? "invalid-key" : error.kind === "plan" ? "plan" : error.kind === "bad-request" ? "bad-request" : "upstream";
    return NextResponse.json({ error: code, message: error.message }, { status, headers: NO_STORE });
  }
  const message = error instanceof Error ? error.message : String(error);
  return NextResponse.json({ error: "failed", message }, { status: 500, headers: NO_STORE });
}

/** GET - masked key and per-character readiness. Reads local state only. */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    return NextResponse.json(await getLiveVoiceService().settings(), { headers: NO_STORE });
  } catch (error) {
    return failure(error);
  }
}

/**
 * POST `{ apiKey?: string, prepare?: true, acknowledged?: true }`.
 *
 * `apiKey` is verified with one free list request and stored server-side.
 * `prepare` starts the paid private cloning only when the same request carries
 * the user's explicit acknowledgement of upload, credit use, and rights.
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let apiKey: string | undefined;
  let prepare = false;
  let acknowledged = false;
  try {
    const body: unknown = await req.json();
    if (body && typeof body === "object") {
      if ("apiKey" in body && typeof body.apiKey === "string") apiKey = body.apiKey;
      prepare = "prepare" in body && body.prepare === true;
      acknowledged = "acknowledged" in body && body.acknowledged === true;
    }
  } catch {
    return NextResponse.json({ error: "bad-request" }, { status: 400, headers: NO_STORE });
  }
  if (apiKey === undefined && !prepare) {
    return NextResponse.json({ error: "bad-request" }, { status: 400, headers: NO_STORE });
  }
  if (prepare && !acknowledged) {
    return NextResponse.json({ error: "consent-required" }, { status: 400, headers: NO_STORE });
  }

  const service = getLiveVoiceService();
  try {
    if (apiKey !== undefined) await service.saveKey(apiKey);
    if (prepare) await service.prepare();
    return NextResponse.json(await service.settings(), { status: prepare ? 202 : 200, headers: NO_STORE });
  } catch (error) {
    return failure(error);
  }
}

/** DELETE - forget the stored key. Private voices stay in the user's Cartesia account. */
export async function DELETE(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const service = getLiveVoiceService();
  try {
    await service.removeKey();
    return NextResponse.json(await service.settings(), { headers: NO_STORE });
  } catch (error) {
    return failure(error);
  }
}
