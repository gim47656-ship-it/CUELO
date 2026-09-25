import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getOmpWebUpdateStatus } from "@/lib/omp-updates";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  try {
    const status = await getOmpWebUpdateStatus();
    return NextResponse.json(status, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message || "Unable to check for updates" }, { status: 502 });
  }
}
