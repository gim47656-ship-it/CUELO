import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { queueRoutineReads } from "@/lib/routines/reads";
import { inspectRepo, routinesDir } from "@/lib/routines/store";

export const dynamic = "force-dynamic";

const KEYS_LIMIT = 500;

/**
 * POST `{ keys: ["<루틴 id>/<글 파일>", ...] }`: 이 PC에서 열어 본 글을 서버 메모리에 모으고, 잠시 뒤 한 번의 커밋으로
 * 이 PC의 읽음 파일(`reads/<PC>.json`)에 올린다. 형식이 맞지 않거나 오래된 키는 받지 않고 `queued`로 받은 개수를 돌려준다.
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  const dir = routinesDir();
  if (!inspectRepo(dir).ok) return NextResponse.json({ error: "Routines repository is not set up" }, { status: 409 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const keys = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length > KEYS_LIMIT || !keys.every((key) => typeof key === "string")) {
    return NextResponse.json({ error: `keys must be an array of at most ${KEYS_LIMIT} strings` }, { status: 400 });
  }
  return NextResponse.json({ queued: queueRoutineReads(dir, keys as string[]) });
}
