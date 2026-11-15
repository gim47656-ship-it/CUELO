import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { pushPublicKey } from "@/lib/push/service";

export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  return NextResponse.json({ publicKey: pushPublicKey() });
}
