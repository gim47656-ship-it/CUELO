/**
 * 하네스가 세션에 user 메시지로 넣는 재개·통지 문구. 서버(update-interrupt·update-wake)가 보내고, 화면(turn-summary)은
 * 이 문구로 시작한 메시지를 사용자의 새 요청이 아니라 진행 중이던 요청의 이어짐으로 읽는다. 의존성 없는 모듈이라 두 쪽이
 * 같은 문자열을 쓴다.
 */

/** 업데이트·재시작으로 abort된 세션에 새 서버가 넣는 재개 지시. */
export const INTERRUPT_RESUME_MESSAGE =
  "[자동 재개] CUELO 업데이트·재시작 때문에 이 세션의 진행 중 작업이 중단(abort)됐다. 서버가 새 버전으로 다시 떴다. "
  + "중단 직전에 돌던 명령·도구 결과는 사라졌을 수 있으니 파일·프로세스 상태를 먼저 확인하고, 하던 작업을 이어서 진행한다. "
  + "그때 돌던 SubAgent(task child)도 멈췄지만 기록은 남아 있다. 결과를 받지 못한 child에는 먼저 `write agent://<id>`로 이어서 하라고 보내 되살리고, "
  + "되살아나지 않으면(isolated 작업 공간 등) 남은 파일 상태를 확인한 뒤 새로 맡긴다.";

/** 서버가 갑자기 죽어(전원·강제 종료·크래시) abort 없이 끊긴 부모 세션용. 명령을 다시 실행하라고 하지 않는다. */
export const ABRUPT_RESUME_MESSAGE =
  "[자동 재개] CUELO 서버가 예기치 않게 종료돼 이 세션의 진행 중 작업이 중간에 끊겼다. 서버가 다시 떴다. "
  + "끊기기 직전에 돌던 명령·도구 결과는 사라졌을 수 있다. 그 명령을 그대로 다시 실행하지 말고, 파일·프로세스 상태를 먼저 확인한 뒤 하던 작업을 이어서 진행한다. "
  + "그때 돌던 SubAgent(task child)도 멈췄지만 기록은 남아 있다. 결과를 받지 못한 child에는 먼저 `write agent://<id>`로 이어서 하라고 보내 되살리고, "
  + "되살아나지 않으면 남은 파일 상태를 확인한 뒤 새로 맡긴다.";

/** 업데이트 drain이 abort했지만 업데이트가 교체 없이 실패해, 그대로 살아 있는 기존 서버가 다시 잇는 세션용. */
export const UPDATE_FAILED_RESUME_MESSAGE =
  "[자동 재개] CUELO 업데이트의 세션 정지 단계가 이 세션의 진행 중 작업을 중단(abort)했지만, 업데이트가 실패해 기존 서버가 그대로 돌고 있다(새 버전으로 바뀌지 않았다). "
  + "중단 직전에 돌던 명령·도구 결과는 사라졌을 수 있으니 파일·프로세스 상태를 먼저 확인하고, 하던 작업을 이어서 진행한다. "
  + "그때 돌던 SubAgent(task child)도 멈췄지만 기록은 남아 있다. 결과를 받지 못한 child에는 먼저 `write agent://<id>`로 이어서 하라고 보내 되살리고, "
  + "되살아나지 않으면(isolated 작업 공간 등) 남은 파일 상태를 확인한 뒤 새로 맡긴다.";

/** 업데이트를 시작한 세션에 복귀 뒤 넣는 성공 통지의 첫 줄. 다음 줄은 `requestId=… stageHash=…`다. */
export const UPDATE_WAKE_HEADLINE = "[하네스 통지] 이 세션이 시작한 CUELO 업데이트가 끝나 런타임이 새 버전으로 교체됐고, 이 세션이 그 위에서 재개됐습니다.";

/** 업데이트를 시작한 세션에 넣는 실패 통지의 첫 줄. 다음 줄은 `requestId=… stageHash=…`다. */
export const UPDATE_FAILURE_HEADLINE = "[하네스 통지] 이 세션이 시작한 CUELO 업데이트가 실패했습니다.";

/**
 * 하네스가 넣은 재개·통지 메시지인지. 재개 지시는 문구 전체가 같아야 하고, 업데이트 통지는 첫 줄이 그 줄이고 둘째 줄이
 * `requestId=`로 시작해야 한다. 비슷한 말을 담은 사용자 입력은 아니다.
 */
export function isHarnessResumeNotice(text: string): boolean {
  if (text === INTERRUPT_RESUME_MESSAGE || text === ABRUPT_RESUME_MESSAGE || text === UPDATE_FAILED_RESUME_MESSAGE) return true;
  const [first, second] = text.split("\n", 2);
  return (first === UPDATE_WAKE_HEADLINE || first === UPDATE_FAILURE_HEADLINE) && second !== undefined && second.startsWith("requestId=");
}
