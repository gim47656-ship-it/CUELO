import { getAgentDir } from "@oh-my-pi/pi-utils";
import { NextResponse } from "next/server";
import { readCharacterModePayload, writeCharacterMode } from "@/lib/character-mode";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** GET -> { mode, rosterAvailable, seats }: the server-wide character set and, in office mode, the replacement seats. */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    return NextResponse.json(await readCharacterModePayload(getAgentDir()), { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

/** PUT { mode: "default" | "office" } -> the same payload as GET. */
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "application/json body required" }, { status: 415 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }
  const mode = typeof body === "object" && body !== null && "mode" in body ? body.mode : undefined;
  if (mode !== "default" && mode !== "office") {
    return NextResponse.json({ error: "mode must be \"default\" or \"office\"" }, { status: 400 });
  }
  try {
    await writeCharacterMode(getAgentDir(), mode);
    return NextResponse.json(await readCharacterModePayload(getAgentDir()), { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
