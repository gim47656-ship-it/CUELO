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
    description: "Main-only plan check against the user's request. Send the full plan/brief and optional question; returns independent configured-model opinions and failures. Content goes to their providers: no secrets. Advisory only, never approval or a review gate.",
    parameters: z.object({
      plan: z.string().describe("Full plan/brief"),
      question: z.string().optional().describe("Specific question (optional)"),
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
