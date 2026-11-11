import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createPreflightCheck, opinionText, failureText, secs } from "../../extensions/lib/preflight-check";

const ASYNC_TIMEOUT_MS = 120_000;

export default function argonPreflight(pi: ExtensionAPI): void {
  const z = pi.zod;
  const state = createPreflightCheck(pi);
  const { ask, note } = state;

  pi.registerTool({
    name: "lab_preflight",
    label: "사전 점검",
    loadMode: "essential",
    description: "지금 계획(plan)을 사용자의 최근 말과 대 보게 해 빠진 요구·틀린 가정·더 나은 방법을 받는다. 두 참가자에게 같은 프롬프트로 동시에 묻는다: 이 PC의 Gemini 역할(modelRoles.implGemini)과 독립 사전 점검 역할(modelRoles.preflightAnthropic). 두 답은 모델 이름이 붙은 별개 의견과 실패 사유로 돌아오며, 합성하지 않는다. 한쪽이 실패해도 다른 쪽 의견은 그대로 쓴다. 공급자 사용량이나 속도 한도 오류면 그 모델의 설정된 같은 공급자 경로를 한 번 시도하고, 둘 다 조언을 못 냈을 때만 이 세션 Main의 반대 계열 기존 교차 검토 역할에 한 번 묻는다(Anthropic Main이면 crossReviewOpenAI, 그 밖의 Main이면 crossReviewAnthropic). 모든 호출은 같은 마감을 나눠 쓰고 이미 부른 모델은 다시 부르지 않는다. 발주와 큰 작업 목표의 자동 점검은 별도 preflight-routing 플러그인이 켜져 있을 때만 돈다. 비밀값이 의심되거나 취소됐거나 세션이 바뀌면 더 부르지 않는다. 참고 의견일 뿐 승인이나 검토 게이트가 아니다.",
    parameters: z.object({
      plan: z.string().describe("점검할 계획·브리프 전문"),
      question: z.string().optional().describe("특히 묻고 싶은 것(선택)"),
    }),
    async execute(_callId, params, signal, _onUpdate, ctx) {
      const { plan, question } = params as { plan: string; question?: string };
      if (!state.main) throw new Error("사전 점검은 Main 세션에서만 쓴다.");
      const mySession = state.session;
      const myGen = state.gen;
      const advice = await ask(ctx, `# 계획\n${plan}`, question ? `# 특히 묻는 것\n${question}` : "", ASYNC_TIMEOUT_MS, { signal, live: () => mySession === state.session && myGen === state.gen });
      if (mySession === state.session) note(ctx, advice.ok ? `직접 점검(${secs(advice.ms)}초):\n${opinionText(advice.opinions)}${advice.failures.length ? `\n${failureText(advice.failures)}` : ""}` : `직접 점검 실패: ${advice.why}`);
      if (!advice.ok) throw new Error(`사전 점검 실패: ${advice.why}`);
      const failedLanes = failureText(advice.failures);
      return { content: [{ type: "text", text: `${advice.opinions.map((o) => o.model).join("와 ")}(${secs(advice.ms)}초) 조언 — 참고 의견:${failedLanes ? `\n${failedLanes}` : ""}\n\n${opinionText(advice.opinions)}` }] };
    },
  });
}
