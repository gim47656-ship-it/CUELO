import { join } from "node:path";
import { NextResponse } from "next/server";
import { getOmpRuntime } from "@/lib/omp-runtime";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { needsKoreanTranslation } from "@/lib/thinking-korean";
import { callGemini, createThinkingTranslator, MAX_SOURCE_CHARS } from "@/lib/thinking-translate";

type Translate = ReturnType<typeof createThinkingTranslator>;

declare global {
  var __cueloThinkingTranslator: Promise<Translate> | undefined;
}

function translator(): Promise<Translate> {
  globalThis.__cueloThinkingTranslator ??= getOmpRuntime().then(({ agentDir }) =>
    createThinkingTranslator({ cacheDir: join(agentDir, "cuelo-thinking-ko"), call: callGemini }));
  return globalThis.__cueloThinkingTranslator;
}

/** POST { text } -> { ko }: a Korean display copy of one finished English thinking block. */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "JSON body required" }, { status: 415 });
  const body = await req.json().catch(() => null) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text : "";
  if (!text.trim() || text.length > MAX_SOURCE_CHARS) {
    return NextResponse.json({ error: "text is empty or too long" }, { status: 400 });
  }
  if (!needsKoreanTranslation(text)) return NextResponse.json({ ko: null });
  try {
    return NextResponse.json({ ko: await (await translator())(text) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
