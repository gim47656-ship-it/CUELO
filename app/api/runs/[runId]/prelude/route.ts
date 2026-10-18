import { NextResponse } from "next/server";
import type { SessionDumpToolInfo } from "@oh-my-pi/pi-coding-agent/session/session-dump-format";
import { getRpcSession } from "@/lib/rpc-manager";
import { RunXrayError, locateRunTranscripts, parseRunId } from "@/lib/run-xray";
import {
  buildRunPrelude,
  loadRunWindow,
  maskedErrorMessage,
  resolveRunRoleTranscript,
  type LivePromptSource,
} from "@/lib/run-xray-turns";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/** 코어 `AgentSession.formatSessionAsText()`가 `/dump`에 넘기는 것과 같은 필드만 읽는다. */
interface LiveAgentState {
  agent?: {
    state?: {
      systemPrompt?: string | string[];
      tools?: readonly SessionDumpToolInfo[];
      model?: { provider?: unknown; id?: unknown } | null;
      thinkingLevel?: string;
    };
    pruneToolDescriptions?: boolean;
  };
}

/**
 * 이 프로세스에 지금 살아 있는 부모 세션에서 프롬프트 재료를 꺼낸다. 세션을 새로 열거나 깨우지 않는다.
 * 자식 transcript의 프롬프트는 이 레지스트리에 없으므로 `main`만 다룬다.
 */
function livePromptSource(sessionId: string): LivePromptSource | null {
  const wrapper = getRpcSession(sessionId);
  if (!wrapper?.isAlive()) return null;
  const state = (wrapper.inner as unknown as LiveAgentState).agent?.state;
  if (!state) return null;
  const blocks = [state.systemPrompt ?? []].flat().filter((block) => typeof block === "string");
  const model = state.model;
  return {
    systemPrompt: blocks,
    tools: state.tools ?? [],
    model: model && typeof model.provider === "string" && typeof model.id === "string"
      ? { provider: model.provider, id: model.id }
      : null,
    thinkingLevel: state.thinkingLevel ?? null,
    inlineToolDescriptors: (wrapper.inner as unknown as LiveAgentState).agent?.pruneToolDescriptions === true,
  };
}

function failure(error: unknown): NextResponse {
  const status = error instanceof RunXrayError ? error.status : 500;
  return NextResponse.json({ error: maskedErrorMessage(error) }, { status });
}

/**
 * GET /api/runs/<runId>/prelude?role=main[&rebuild=1] — 시스템 프롬프트·도구. 기록된 부분(지문·켜진 도구
 * 이름·기억 회상 블록)을 주고, 세션이 지금 열려 있으면 `rebuild=1`일 때 현재 설정으로 `/dump` 머리말을 다시 그린다.
 */
export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const { sessionId, entryId } = parseRunId((await params).runId);
    const url = new URL(req.url);
    const role = url.searchParams.get("role") || "main";
    const location = locateRunTranscripts(sessionId, entryId);
    const { file, window } = resolveRunRoleTranscript(location, role);
    const data = loadRunWindow(file, window);
    const live = role === "main" ? livePromptSource(sessionId) : null;
    const render = url.searchParams.get("rebuild") === "1";
    return NextResponse.json(buildRunPrelude(data, { runId: location.detail.runId, role }, live, render));
  } catch (error) {
    return failure(error);
  }
}
