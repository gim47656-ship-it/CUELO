import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { collectUpkeep } from "@/lib/upkeep/collect";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  try { return NextResponse.json(await collectUpkeep(new URL(req.url).searchParams.get("refresh") === "1")); }
  catch { return NextResponse.json({ error: "Upkeep scan failed" }, { status: 500 }); }
}
