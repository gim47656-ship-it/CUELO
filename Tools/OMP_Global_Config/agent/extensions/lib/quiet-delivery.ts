import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { onSessionLifecycle } from "./session-identity";

type Payload = Parameters<ExtensionAPI["sendMessage"]>[0];

/**
 * 모델 호출을 새로 만들지 않는 안내 전달(2026-11-16 사용자 결정 「품질은 잃지않으면서 불필요한토큰 낭비를 막고싶다」,
 * doc/history/2026/11/16-quiet-advisories). `deliverAs: "aside"`는 쉬는 세션에 새 턴을 열고, 진행 중인 `wait`를 끝내며,
 * 모델이 도구 없이 마지막 답을 내는 경계에 들어오면 턴을 한 번 더 늘린다. 7일 표본에서 이런 안내가 wait를 90번 끊었다.
 * - 실행 중: 담아 두었다가 `wait`가 아닌 도구 결과가 나올 때 aside로 싣는다. 도구 결과 뒤에는 어차피 모델 호출이 있으므로
 *   그 경계에 함께 실린다. `wait` 실행 중이면 wait 결과가 나올 때까지 미룬다(병렬 묶음의 다른 도구 결과로 wait를 끊지 않는다).
 * - 턴이 도구 없이 끝나면 다음 턴으로 넘긴다(쉬면 턴 없이 붙이고, 아직 마무리 중이면 nextTurn 보류 큐).
 * - 쉬는 중: 턴 없이 붙인다. ctx가 쉬는 상태를 확인해 주면 옵션 없이 보내 display 메시지를 바로 그린다.
 * 모델이 읽을 안내는 늦어도 다음 모델 호출 전에 닿는다. 사람만 보는 표시는 그 경계나 다음 턴에 보인다.
 */
export function createQuietDelivery(pi: Pick<ExtensionAPI, "on" | "sendMessage">): (message: Payload, ctx?: ExtensionContext) => void {
  let held: Payload[] = [];
  let waits = 0;
  let running = false;
  const reset = () => {
    held = [];
    waits = 0;
    running = false;
  };
  // 전송이 실패하면 그 안내와 아직 보내지 않은 안내를 큐 앞에 되돌려 다음 기회에 다시 보낸다. 오류는 호스트가 기록하도록 다시 던진다.
  const flush = (deliver: (message: Payload) => void) => {
    const out = held;
    held = [];
    for (const [index, message] of out.entries()) {
      try {
        deliver(message);
      } catch (error) {
        held = [...out.slice(index), ...held];
        throw error;
      }
    }
  };
  // 실행 중이 아닐 때: 남아 있던 안내부터 순서대로 턴 없이 붙인다(쉬면 옵션 없이, 마무리 중이면 nextTurn).
  const settle = (ctx?: ExtensionContext) =>
    flush((queued) => pi.sendMessage(queued, ctx?.isIdle() ? undefined : { deliverAs: "nextTurn" }));
  const send = (message: Payload, ctx?: ExtensionContext) => {
    held.push(message);
    if (!running) settle(ctx);
  };

  onSessionLifecycle(pi, { start: reset });
  pi.on("session_shutdown", reset);
  pi.on("agent_start", () => {
    running = true;
  });
  pi.on("tool_call", (event) => {
    if (event.toolName === "wait") waits += 1;
  });
  pi.on("tool_result", (event) => {
    if (event.toolName === "wait") waits = Math.max(0, waits - 1);
    if (waits > 0 || held.length === 0) return;
    flush((message) => pi.sendMessage(message, { deliverAs: "aside" }));
  });
  pi.on("agent_end", (event, ctx) => {
    if (event.willContinue) return;
    running = false;
    waits = 0;
    settle(ctx);
  });
  return send;
}
