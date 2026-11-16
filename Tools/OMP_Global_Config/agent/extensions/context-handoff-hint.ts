import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createQuietDelivery } from "./lib/quiet-delivery";
import { onSessionLifecycle } from "./lib/session-identity";

/**
 * 맥락 크기 안내(2026-11-16 사용자 결정 「품질은 잃지않으면서 불필요한토큰 낭비를 막고싶다」, doc/history/2026/11/16-quiet-advisories).
 * 모델 호출마다 맥락 전체를 다시 읽는다. 7일 표본(Main 응답 13,142번)에서 맥락 30만 토큰 이상인 호출이 34%였고 토큰의 49%를 차지했다.
 * 압축은 45만(500K 창의 90%)에서야 일어나므로, 30만을 넘으면 Main에게 한 번 새 세션 전환을 사용자에게 제안하라고 알린다.
 * 전환 여부는 사용자가 정한다. 압축 등으로 기준 아래로 내려가면 다시 알릴 수 있다. 안내 자체는 lib/quiet-delivery로 보내 턴을 열지 않는다.
 */
export const CONTEXT_HINT_TOKENS = 300_000;
export const CONTEXT_HINT_TYPE = "context-handoff-hint";

export function contextHintText(tokens: number): string {
  return `[맥락 크기] 이 세션의 맥락이 약 ${Math.round(tokens / 10_000)}만 토큰이다. 이후 모델 호출마다 이만큼을 다시 읽는다. `
    + "진행 중인 작업 묶음은 끊지 말고, 그 묶음이 끝나 사용자에게 보고하는 자리에서 새 세션으로 넘기자고 한 줄로 제안하라. "
    + "넘길 때 이어 갈 일, 진행 중인 job·Maker, 읽을 기록 위치를 그 보고에 적는다. 사용자가 이 세션에서 계속하길 원하면 그대로 진행한다. "
    + "이 안내는 기준을 넘을 때 한 번이다.";
}

export default function contextHandoffHint(pi: ExtensionAPI): void {
  const quiet = createQuietDelivery(pi);
  let told = false;
  onSessionLifecycle(pi, { start: () => { told = false; } });
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant" || ctx.agent?.kind !== "main") return;
    const tokens = ctx.getContextUsage()?.tokens;
    if (typeof tokens !== "number") return;
    if (tokens < CONTEXT_HINT_TOKENS) {
      told = false;
      return;
    }
    if (told) return;
    told = true;
    quiet({ customType: CONTEXT_HINT_TYPE, content: contextHintText(tokens), display: false, attribution: "agent" }, ctx);
  });
}
