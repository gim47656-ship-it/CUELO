import {
  claimUpdateFailureNotice,
  claimUpdateWake,
  getUpdateInitiatorSessionId,
  releaseUpdateFailureNoticeClaim,
  releaseUpdateWakeClaim,
  type UpdateFailureNoticeDecision,
  type UpdateWakeDecision,
} from "./update-maintenance";
import { getRpcSession, startRpcSession } from "./rpc-manager";
import { resolveSessionPath } from "./session-reader";

declare global {
  // 같은 request·세션으로 준비 중인 Wake 발화. settle되면 바로 지운다 — 결과를 남기지 않는다.
  var __ompUpdateWakeDispatches: Map<string, Promise<void>> | undefined;
}

function getWakeDispatches(): Map<string, Promise<void>> {
  if (!globalThis.__ompUpdateWakeDispatches) globalThis.__ompUpdateWakeDispatches = new Map();
  return globalThis.__ompUpdateWakeDispatches;
}

/**
 * 업데이트를 시작한 세션에 남기는 내부 지시문. 사용자 발화가 아니라 하네스 통지이므로
 * 그 사실을 본문에 밝힌다. 사용자에게 다시 묻지 않고 하던 일을 이어가라는 뜻이다.
 */
function wakeMessage(requestId: string, stageHash: string): string {
  return [
    "[하네스 통지] 이 세션이 시작한 OMPWEB 업데이트가 끝나 런타임이 새 버전으로 교체됐고, 이 세션이 그 위에서 재개됐습니다.",
    `requestId=${requestId} stageHash=${stageHash}`,
    "사용자 발화가 아니라 재개 통지입니다. 업데이트 직전에 하던 작업을 이어가세요.",
    "산출물 정리는 백그라운드로 따로 진행되며 그 상태는 화면 상단 줄에 표시됩니다. 정리 결과를 기다리지 마세요.",
  ].join("\n");
}

/**
 * 브라우저 복귀가 확정된 시점에, 배포를 시작한 바로 그 세션을 한 번만 자동 재개한다.
 *
 * 발화 여부 판정과 중복 방지는 `claimUpdateWake`가 소유한다. 여기서는 그 판정에 필요한
 * 실행 중 여부만 런타임에서 읽어 넘기고, 통과했을 때 내부 지시문을 보낸다.
 * 내부 지시문은 `sendInternalPrompt`로만 보내므로 사용자 요청으로 계상되지 않는다.
 *
 * 실패해도 복귀 자체는 성공이다. 자동 재개는 부가 기능이고, 안 되면 사용자가 직접
 * 이어가는 오늘까지의 동작으로 떨어진다.
 *
 * 이 응답이 돌아올 때 대상 세션은 Wake prompt를 실행 중이거나 이미 끝냈다. 성공 발화는
 * `sendInternalPrompt`가 prompt를 실행 중으로 세운 뒤에 돌아오고, claim을 놓친 탭은 먼저
 * claim한 탭의 발화 준비가 settle될 때까지 기다렸다 답한다. 복귀 화면은 이 시점에 한 번만
 * 확인해도 그 run을 놓치지 않는다.
 */
export async function wakeUpdateInitiatorSession(input: {
  requestId: string;
  stageHash: string;
  clientId: string;
  sessionId: string | null;
}): Promise<UpdateWakeDecision> {
  const sessionId = input.sessionId?.trim().toLowerCase() || null;
  const initiator = getUpdateInitiatorSessionId(input.requestId);
  const live = initiator ? getRpcSession(initiator) : undefined;
  const decision = claimUpdateWake({
    requestId: input.requestId,
    stageHash: input.stageHash,
    clientId: input.clientId,
    sessionId,
    sessionBusy: live?.isAlive() === true && live.isRunning(),
  });
  const dispatches = getWakeDispatches();
  const dispatchKey = `${input.requestId}:${sessionId}`;
  if (!decision.wake) {
    // claim을 먼저 가져간 탭이 아직 세션을 되살리거나 확장 바인딩을 기다리는 중이면, 그 준비가
    // settle된 뒤에 답한다. 먼저 답하면 이 탭은 아직 시작되지 않은 run을 확인하고 놓친다.
    // 실패는 그 탭이 기록·반납하고 그대로 던지므로 여기서는 끝나기만 기다린다.
    if (decision.reason === "already-claimed") await dispatches.get(dispatchKey)?.catch(() => {});
    return decision;
  }

  // 업데이트는 런타임 프로세스를 교체하므로 대상 세션이 메모리에 없는 것이 정상이다.
  // 기록에서 되살리는 순서는 `app/api/agent/[id]/route.ts`의 재개 경로와 같다.
  //
  // claim은 동시 복귀 탭 사이의 배타성 때문에 이미 찍혔다. 여기서 터지면 아무도 깨우지
  // 못한 채 그 자리만 점유되므로, 실패한 단계와 이유를 남기고 claim을 반납한다.
  const dispatch = (async () => {
    let stage: "resume" | "prompt" = "resume";
    try {
      const session = live?.isAlive()
        ? live
        : (await startRpcSession(decision.sessionId, await resolveSessionPathOrThrow(decision.sessionId), undefined)).session;
      stage = "prompt";
      await session.sendInternalPrompt(wakeMessage(decision.requestId, decision.stageHash));
    } catch (error) {
      releaseUpdateWakeClaim({
        requestId: decision.requestId,
        stageHash: decision.stageHash,
        clientId: input.clientId,
        sessionId: decision.sessionId,
        stage,
        error,
      });
      throw error;
    }
  })();
  // claim과 같은 동기 구간에서 등록한다. 발화 준비는 첫 await에서 멈춰 있으므로 다른 복귀
  // 요청이 이 틈에 claim을 확인해도 이 약속을 본다.
  dispatches.set(dispatchKey, dispatch);
  try {
    await dispatch;
  } finally {
    if (dispatches.get(dispatchKey) === dispatch) dispatches.delete(dispatchKey);
  }
  return decision;
}

async function resolveSessionPathOrThrow(sessionId: string): Promise<string> {
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) throw new Error(`session record not found: ${sessionId}`);
  return filePath;
}

/**
 * 업데이트가 실패했을 때 배포를 시작한 세션에 남기는 내부 지시문. 성공 재개와 마찬가지로
 * 사용자 발화가 아니라 하네스 통지이므로 그 사실을 밝힌다. 실패 원인과 "live runtime은
 * 변경하지 않았다"는 사실을 그대로 전해야 세션이 다음 행동을 원인에 맞춰 정할 수 있다.
 */
function failureMessage(requestId: string, stageHash: string, terminalError: string | null): string {
  return [
    "[하네스 통지] 이 세션이 시작한 OMPWEB 업데이트가 실패했습니다.",
    `requestId=${requestId} stageHash=${stageHash}`,
    terminalError
      ? `원인: ${terminalError}`
      : "원인: 배포 결과 receipt에 오류 문장이 없습니다. 배포 evidence를 확인하세요.",
    "실패한 업데이트는 live runtime을 변경하지 않았으므로, 새 버전으로 교체되지 않았다면 기존 서비스가 그대로 살아 있습니다.",
    "사용자 발화가 아니라 하네스 통지입니다. 사용자에게 실패를 보고하고, 원인에 맞춰 다음 행동을 정하세요.",
  ].join("\n");
}

/**
 * 실패를 관측한 대기 화면의 요청으로, 배포를 시작한 세션에 실패를 한 번만 알린다.
 *
 * 성공 재개와 달리 실패 시점에는 기존 런타임이 그대로 살아 있으므로 대상 세션이 메모리에
 * idle로 있는 것이 정상 경로다. 그 경우 재기동 없이 그 세션에 바로 내부 지시문을 보낸다.
 * 메모리에 없을 때만 성공 Wake와 같은 방식으로 기록에서 되살린다.
 *
 * 발화 여부 판정과 중복 방지는 `claimUpdateFailureNotice`가 소유한다. 실패해도 대기 화면의
 * 실패 표시는 그대로다 — 통지는 부가 기능이고, 안 되면 사용자가 직접 이어가는 동작으로 떨어진다.
 */
export async function notifyUpdateFailureToInitiator(input: {
  requestId: string;
  stageHash: string;
  clientId: string;
  sessionId: string | null;
}): Promise<UpdateFailureNoticeDecision> {
  const sessionId = input.sessionId?.trim().toLowerCase() || null;
  const initiator = getUpdateInitiatorSessionId(input.requestId);
  const live = initiator ? getRpcSession(initiator) : undefined;
  const decision = claimUpdateFailureNotice({
    requestId: input.requestId,
    stageHash: input.stageHash,
    clientId: input.clientId,
    sessionId,
    sessionBusy: live?.isAlive() === true && live.isRunning(),
  });
  if (!decision.notice) return decision;

  let stage: "resume" | "prompt" = "resume";
  try {
    const session = live?.isAlive()
      ? live
      : (await startRpcSession(decision.sessionId, await resolveSessionPathOrThrow(decision.sessionId), undefined)).session;
    stage = "prompt";
    await session.sendInternalPrompt(failureMessage(decision.requestId, decision.stageHash, decision.terminalError));
  } catch (error) {
    releaseUpdateFailureNoticeClaim({
      requestId: decision.requestId,
      stageHash: decision.stageHash,
      clientId: input.clientId,
      sessionId: decision.sessionId,
      stage,
      error,
    });
    throw error;
  }
  return decision;
}
