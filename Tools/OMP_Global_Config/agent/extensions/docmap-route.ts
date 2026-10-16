import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { routeDocmap } from "./lib/docmap-search";

// 2026-10-16 재조사(doc/history/2026/10/16-rag-reinvestigation): 격리 표본 12건에서 문서 지도를 연 경우가 0건이었다.
// 도구나 규칙만 두면 같은 문제가 되풀이되므로, 사용자 요청마다 하네스가 지도·RECORD 헤더 검색을 직접 돌려
// 후보 기록과 맞는 구간을 그 prompt의 숨은 메시지로 넘긴다. 하한 미만·지도 없음·오류면 아무것도 붙이지 않는다.
// 안내는 external-advice-check와 같은 이유로 aside가 아니라 그 prompt의 `before_agent_start` 메시지로만 붙인다.
export default function docmapRoute(pi: ExtensionAPI): void {
  let pendingText: string | undefined;
  pi.on("session_start", () => { pendingText = undefined; });
  pi.on("session_shutdown", () => { pendingText = undefined; });
  pi.on("input", (event) => {
    pendingText = undefined;
    if (event.source !== "interactive" && event.source !== "rpc") return;
    const text = event.text.trim();
    if (text) pendingText = text;
  });
  pi.on("before_agent_start", (event, ctx) => {
    // 대화형·RPC는 사용자 입력과 같은 본문의 prompt에만 붙인다. CUELO의 재개·업데이트 통지와 goal 계속 같은
    // 내부 prompt는 `input`을 내지 않아(lib/rpc-manager.ts isGenuineUserRequest) 여기서 빠진다.
    // `omp -p`는 input 이벤트가 없어 최상위 세션의 CLI prompt 자체를 사용자 요청으로 본다. CUELO도 확장을
    // mode 없이 초기화해 ctx.mode가 "print"이므로, UI 문맥이 없다는 것까지 봐야 CLI로 가를 수 있다.
    const fromInput = pendingText !== undefined && event.prompt.includes(pendingText);
    const cliPrompt = (ctx.mode === "print" || ctx.mode === "json") && !ctx.hasUI && ctx.agent?.kind === "main";
    if (!fromInput && !cliPrompt) return;
    try {
      const route = routeDocmap(ctx.cwd, fromInput ? pendingText! : event.prompt);
      if (!route) return;
      return { message: { customType: "docmap-route", content: route.text, display: false, attribution: "agent" } };
    } catch {
      return;
    }
  });
}
