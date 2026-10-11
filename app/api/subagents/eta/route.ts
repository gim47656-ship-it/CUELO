import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { NextResponse } from "next/server";
import { buildEtaHistories, parseLedgerLines, type SubagentEtaResponse } from "@/lib/subagent-progress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET ?sessionId= -> SubagentEtaResponse. 이 세션의 자식마다 같은 모델·등급의 과거 소요 시간(초,
 * 정렬)만 낸다. 원장 행·다른 세션·발주 id는 서버 밖으로 나가지 않는다. 경과가 계속 바뀌므로
 * 조건부 분위는 화면이 계산한다. 원장이 없으면 빈 결과다.
 */
export async function GET(req: Request) {
  const sessionId = new URL(req.url).searchParams.get("sessionId")?.trim() ?? "";
  if (!sessionId) return NextResponse.json({ error: "sessionId is required" }, { status: 400, headers: NO_STORE });
  let raw = "";
  try {
    raw = await readFile(join(getAgentDir(), "routing-ledger.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500, headers: NO_STORE });
    }
  }
  const body: SubagentEtaResponse = { sessionId, histories: buildEtaHistories(parseLedgerLines(raw), sessionId) };
  return NextResponse.json(body, { headers: NO_STORE });
}
