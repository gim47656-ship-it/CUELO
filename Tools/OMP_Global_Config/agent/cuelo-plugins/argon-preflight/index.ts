import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createPreflightCheck, opinionText } from "../../extensions/lib/preflight-check";

const ASYNC_TIMEOUT_MS = 120_000;

export default function argonPreflight(pi: ExtensionAPI): void {
  const z = pi.zod;
  const state = createPreflightCheck(pi);
  const { ask, note } = state;

  pi.registerTool({
    name: "lab_preflight",
    label: "사전 점검",
    loadMode: "essential",
    description: "Main-only plan check against the user's request. Skip for bounded solo work without risk. Send the full plan/brief and optional question; one model from the opposite-family preflight slot returns advice. Content goes to that provider: no secrets. Advisory only, never approval or a review gate.",
    parameters: z.object({
      plan: z.string().describe("Full plan/brief"),
      question: z.string().optional().describe("Specific question (optional)"),
    }),
    async execute(_callId, params, signal, _onUpdate, ctx) {
      const { plan, question } = params as { plan: string; question?: string };
      if (!state.main) throw new Error("사전 점검은 Main 세션에서만 쓴다.");
      const mySession = state.session;
      const myGen = state.gen;
      const live = () => mySession === state.session && myGen === state.gen;
      const abort = new AbortController();
      state.inflight.add(abort);
      try {
        const advice = await ask(ctx, `# 계획\n${plan}`, question ? `# 특히 묻는 것\n${question}` : "", ASYNC_TIMEOUT_MS, {
          signal: signal ? AbortSignal.any([signal, abort.signal]) : abort.signal, live,
        });
        if (!live()) throw new Error("사전 점검 실패: 사용자 지시나 세션이 바뀌어 이전 답을 버렸다.");
        note(ctx, advice.ok ? `직접 점검:\n${opinionText(advice.opinion)}` : `직접 점검 실패: ${advice.why}`);
        if (!advice.ok) throw new Error(`사전 점검 실패: ${advice.why}`);
        return { content: [{ type: "text", text: `사전 점검 조언 — 참고 의견:\n\n${opinionText(advice.opinion)}` }] };
      } finally {
        state.inflight.delete(abort);
      }
    },
  });
}
