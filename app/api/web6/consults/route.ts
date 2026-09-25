/**
 * GET /api/web6/consults — 6 Pro(SHION) 상담 기록을 화면에 넘긴다.
 *
 * 기록을 만드는 쪽은 loopback shim(`CUELO_Setup/web6/web6-server.js`)이고 이 라우트는
 * 읽기만 한다. 성공 답변의 정본은 session-native custom entry이며, 이 로그에서는
 * query의 authoritative sessionId와 정확히 일치하는 기록만 반환한다.
 *
 * 기록이 없는 것은 오류가 아니라 빈 목록이다 — shim 을 한 번도 쓰지 않은 PC 가 그 상태다.
 */
import { NextResponse } from "next/server";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isApiRequestAllowed } from "@/lib/request-security";
import { parseConsultLine, type Web6ConsultRecord } from "@/lib/hanse-web6-client";

export const dynamic = "force-dynamic";

/** shim 이 쓰는 자리와 같다(`web6-server.js` 의 `DEFAULT_CONSULT_LOG`). 두 프로세스는 이 경로로만 만난다. */
const CONSULT_LOG = join(homedir(), ".omp", "web6-consults.jsonl");

/**
 * 한 번에 읽는 최대 바이트. shim 이 파일을 2MB 로 제한하지만 대화창은 최근 상담만 쓰므로
 * 꼬리만 읽는다 — 폴링마다 전부 읽으면 파일 크기가 그대로 폴링 비용이 된다.
 */
const TAIL_BYTES = 512 * 1024;

/** 한 응답에 싣는 최대 건수. 이보다 오래된 상담은 화면에 설 턴이 이미 지나갔다. */
const MAX_RECORDS = 100;

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const sessionId = new URL(req.url).searchParams.get("sessionId")?.trim() ?? "";
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  let handle;
  try {
    handle = await open(CONSULT_LOG, "r");
  } catch {
    // 파일 부재가 기본 상태다. 읽기 권한이 없는 경우도 화면에는 똑같이 "상담 없음"이다.
    return NextResponse.json({ consults: [] });
  }

  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);

    let text = buffer.toString("utf8");
    if (size > length) {
      // 꼬리만 읽었으므로 첫 줄은 반쪽이다. 통째로 버린다(부분 복구를 시도하지 않는다).
      const firstBreak = text.indexOf("\n");
      text = firstBreak < 0 ? "" : text.slice(firstBreak + 1);
    }

    const consults: Web6ConsultRecord[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const record = parseConsultLine(line);
      if (record?.sessionId === sessionId) consults.push(record);
    }
    return NextResponse.json({ consults: consults.slice(-MAX_RECORDS) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  } finally {
    await handle.close();
  }
}
