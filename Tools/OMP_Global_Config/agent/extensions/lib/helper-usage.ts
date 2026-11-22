import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import type { ExtensionContext, SessionManager } from "@oh-my-pi/pi-coding-agent";

/**
 * 도구 없는 helper 모델 호출(preflight·skim·cross_review 리뷰어·통역·consult)의 시도별 비용 장부 기록기.
 * `completeSimple`의 `onAttempt`는 core가 내부에서 다시 부른 시도(thinking-loop 재시도)를 포함해 끝난 응답마다
 * 한 번씩 부르므로, 호출자는 이 기록기만 `onAttempt`에 꽂고 최종 응답 usage를 따로 다시 적지 않는다(이중 합산 방지).
 * 각 항목은 그 시도에 실제로 응답한 provider/model과 usage, stopReason, errorMessage를 담고, 호출을 시작한 세션과
 * leaf에 묶는다. 응답 없이 던진 실패는 관측한 usage가 없어 항목을 만들지 않는다(0원으로 적지 않고 미기록).
 */
export interface HelperAttemptMeta {
  purpose: string;
  /** 모델 slot 이름. 정확한 경로·고정 모델 호출이면 생략한다. */
  role?: string;
  /** 호출 대상. 응답이 자기 provider/model/api를 싣지 않았을 때만 쓴다. */
  model: Model<Api>;
  /** 장부에 남기기 전에 오류 문구에서 비밀 값을 가린다. 호출자가 표시할 때 이미 가리는 문구라면 장부에도 같은 규칙을 쓴다. */
  scrub?: (errorMessage: string) => string;
}

export interface HelperAttemptRecorder {
  onAttempt: (attempt: AssistantMessage) => void;
  /**
   * 장부 저장이 실패했으면 그 오류를 던진다. 저장 실패는 삼키지 않지만, core가 아직 재시도를 도는 중에 던져
   * 그 호출을 공급자 실패로 오인하지 않도록 호출이 끝난 뒤 한 번 확인한다.
   */
  assertSaved: () => void;
}

export function helperAttemptRecorder(ctx: ExtensionContext, meta: HelperAttemptMeta): HelperAttemptRecorder {
  const manager = ctx.sessionManager as Partial<Pick<SessionManager, "appendModelUsage" | "getLeafId" | "getSessionId">>;
  // 모든 시도는 호출을 시작한 leaf에 매달려, 재시도가 더한 항목끼리 서로 사슬로 이어지지 않는다.
  const owner = manager.appendModelUsage && manager.getSessionId
    ? { sessionId: manager.getSessionId(), parentId: manager.getLeafId?.() ?? null }
    : undefined;
  let failure: { error: unknown } | undefined;
  return {
    onAttempt(attempt) {
      if (!owner) return;
      try {
        manager.appendModelUsage!({
          purpose: meta.purpose, role: meta.role,
          api: attempt.api ?? meta.model.api, provider: attempt.provider ?? meta.model.provider, model: attempt.model ?? meta.model.id,
          usage: attempt.usage, stopReason: attempt.stopReason,
          errorMessage: attempt.errorMessage === undefined || !meta.scrub ? attempt.errorMessage : meta.scrub(attempt.errorMessage),
        }, owner);
      } catch (error) {
        failure ??= { error };
      }
    },
    assertSaved() {
      if (failure) throw failure.error;
    },
  };
}
