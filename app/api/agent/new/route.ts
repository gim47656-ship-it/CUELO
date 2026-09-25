import { NextResponse } from "next/server";
import { parseConfiguredThinkingLevel as parseOmpThinkingLevel, type ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { allowFileRoot, getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { startRpcSession } from "@/lib/rpc-manager";
import { describeMissingModel } from "@/lib/model-discovery-recovery";
import { findModelWithRecovery, getOmpRuntime } from "@/lib/omp-runtime";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getUpdateMutationBlock } from "@/lib/update-maintenance";
// omp owns the selector grammar (including abbreviations like "med"); reuse its
// parser so the browser and the CLI accept exactly the same values.
function parseThinkingLevel(value: unknown): ConfiguredThinkingLevel | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "string" ? parseOmpThinkingLevel(value) : undefined;
  if (parsed === undefined) throw new Error(`Invalid thinking level: ${String(value)}`);
  return parsed;
}
// 자리 번호는 저장 순서(0부터)이고, 이름은 roster의 `oauth-position`과 같다. 잘못된 값은
// 조용히 무시하지 않고 요청을 실패시킨다 — 계정 지정을 흉내내지 않는다.
function parseOauthPosition(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid oauthPosition: ${String(value)}`);
  }
  return value;
}
// POST /api/agent/new  body: { cwd: string; type: string; message?: string; ... }
// Spawns a brand-new pi session. Most calls immediately send the first command;
// type:"ensure_session" only creates the runtime so clients can query commands.
// Returns pi's real session id plus the model/thinking state selected at startup.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const maintenance = getUpdateMutationBlock();
  if (maintenance) {
    return NextResponse.json({
      error: `CUELO update ${maintenance.phase}`,
      code: "update_draining",
      accepted: false,
      requestId: maintenance.requestId,
    }, { status: 503 });
  }


  const requestStarted = performance.now();
  let commandType: string | undefined;
  let promptAccepted = false;
  try {
    const body = await req.json() as { cwd?: string; [key: string]: unknown };
    const { cwd, ...command } = body;
    commandType = typeof command.type === "string" ? command.type : undefined;

    if (!cwd || typeof cwd !== "string") {
      return NextResponse.json({
        error: "cwd is required",
        ...(commandType === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 400 });
    }
    if (!existsSync(cwd)) {
      return NextResponse.json({
        error: `Directory does not exist: ${cwd}`,
        ...(commandType === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 400 });
    }
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    // Use a one-time key so startRpcSession's lock doesn't conflict with real session ids
    const { provider, modelId, toolNames, thinkingLevel, oauthPosition, ...promptCommand } = command as { provider?: string; modelId?: string; toolNames?: string[]; thinkingLevel?: unknown; oauthPosition?: unknown; [key: string]: unknown };
    if ((provider && !modelId) || (!provider && modelId)) {
      throw new Error("provider and modelId must be provided together");
    }
    const explicitThinkingLevel = parseThinkingLevel(thinkingLevel);
    const explicitOauthPosition = parseOauthPosition(oauthPosition);
    if (explicitOauthPosition !== undefined && !(provider && modelId)) {
      throw new Error("provider and modelId are required to select an account");
    }

    // Must be unique per request: startRpcSession coalesces concurrent callers
    // that share a key onto one session. Date.now() (ms resolution) collides for
    // requests in the same millisecond, merging two new sessions into one.
    const tempKey = `__new__${randomUUID()}`;
    // `initialModel` came directly from this request, unlike configured role
    // references recovered during session startup. Give only this explicit
    // selection one forced discovery pass before the normal role-ref flow.
    if (provider && modelId) {
      const { modelRegistry } = await getOmpRuntime();
      const lookup = await findModelWithRecovery(modelRegistry, provider, modelId, { forceDiscovery: true });
      if (lookup.miss) throw new Error(describeMissingModel(lookup.miss));
    }
    const { session, realSessionId } = await startRpcSession(tempKey, "", cwd, {
      ...(toolNames ? { toolNames } : {}),
      ...(provider && modelId ? { initialModel: { provider, modelId } } : {}),
      ...(explicitThinkingLevel ? { thinkingLevel: explicitThinkingLevel } : {}),
      ...(explicitOauthPosition !== undefined ? { accountOauthPosition: explicitOauthPosition } : {}),
    });

    // Keep the files-route allowed-roots cache (see app/api/files/[...path]/route.ts)
    // in sync so the new cwd is immediately readable via /api/files. Without this,
    // a file request under a brand-new cwd would 403 for up to the cache TTL.
    allowFileRoot(cwd);
    invalidateSessionListCache();

    const state = await session.send({ type: "get_state" }) as {
      model?: { id: string; provider: string };
      thinkingLevel?: string;
      configuredThinkingLevel?: string;
    };

    const sessionReady = performance.now();
    if (promptCommand.type === "ensure_session") {
      return NextResponse.json({
        success: true,
        sessionId: realSessionId,
        data: null,
        model: state.model
          ? { provider: state.model.provider, modelId: state.model.id }
          : null,
        thinkingLevel: state.thinkingLevel,
        configuredThinkingLevel: state.configuredThinkingLevel,
      }, { headers: {
        "Server-Timing": `session_prepare;dur=${(sessionReady - requestStarted).toFixed(2)}`,
      } });
    }

    const result = await session.send(promptCommand);
    promptAccepted = promptCommand.type === "prompt";
    const completed = performance.now();

    return NextResponse.json({
      success: true,
      sessionId: realSessionId,
      data: result,
      model: state.model
        ? { provider: state.model.provider, modelId: state.model.id }
        : null,
      thinkingLevel: state.thinkingLevel,
      configuredThinkingLevel: state.configuredThinkingLevel,
    }, { headers: {
      "Server-Timing": `session_prepare;dur=${(sessionReady - requestStarted).toFixed(2)}, command_accept;dur=${(completed - sessionReady).toFixed(2)}, request;dur=${(completed - requestStarted).toFixed(2)}`,
    } });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: 500 });
  }
}
