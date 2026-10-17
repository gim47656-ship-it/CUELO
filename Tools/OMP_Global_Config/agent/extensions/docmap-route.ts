import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type DocmapCandidate, type DocmapRoute, routeDocmap } from "./lib/docmap-search";
import { type CoreJudgmentModules, defaultLoadCore, JUDGE_STOPPED, type NativeJudge, resolveNativeJudge, stoppedBy } from "./lib/native-judge";

// 2026-10-16 재조사(doc/history/2026/10/16-rag-reinvestigation): 격리 표본 12건에서 문서 지도를 연 경우가 0건이었다.
// 도구나 규칙만 두면 같은 문제가 되풀이되므로, 사용자 요청마다 하네스가 지도·RECORD 헤더 검색을 직접 돌려
// 후보 기록과 맞는 구간을 그 prompt의 숨은 메시지로 넘긴다. 하한 미만·지도 없음·오류면 아무것도 붙이지 않는다.
// 안내는 external-advice-check와 같은 이유로 aside가 아니라 그 prompt의 `before_agent_start` 메시지로만 붙인다.
//
// 2026-10-17 사용자 결정(doc/history/2026/10/17-docmap-judge): 낱말로 고른 후보의 절반은 주제만 겹치는 지시였다
// (실제 프롬프트 표본 60건 중 맞는 첨부 29·엉뚱한 첨부 31). 낱말·길이·의도 표지로는 둘이 갈리지 않아, 붙이기 전에
// native JEV에 후보마다 「요청이 가리키는 그 과거 작업의 기록인가」를 한 요청으로 묻고 P>=0.6인 후보만 붙인다(사용자 선택).
// 같은 표본에서 맞는 첨부 19/29를 지키고 엉뚱한 첨부는 5/31만 남았다(0.5면 23/29·10/31). 판정 실패·제한 시간·native 판정기 없음은
// 낱말 후보를 그대로 붙이고(재현율 보존), 실행 중 steering·queued 재요청은 판정하지 않는다(스티어링 지연 방지).

export interface DocmapRouteDeps {
  /** 결정적 판정기 seam(테스트). 없으면 {@link loadCore}의 native JEV를 쓴다. */
  resolveJudge?: (ctx: ExtensionContext) => Promise<NativeJudge | undefined>;
  loadCore?: () => Promise<CoreJudgmentModules>;
  /** 판정 대기 상한. 테스트만 짧게 준다. 기본은 DOCMAP_JUDGE_TIMEOUT_MS다. */
  judgeTimeoutMs?: number;
  /** 날짜 의도 판정의 기준 시각(테스트). */
  now?: () => Date;
}

/** 판정 대기 상한. 넘으면 낱말 후보를 그대로 붙인다. */
export const DOCMAP_JUDGE_TIMEOUT_MS = 1_500;
/** 후보를 남기는 P(관련) 하한. */
export const DOCMAP_JUDGE_KEEP = 0.6;
const PROMPT_HEAD_CHARS = 1000;
const PROMPT_TAIL_CHARS = 1000;
const CUSTOM_TYPE = "docmap-route";

function judgePrompt(prompt: string): string {
  return prompt.length <= PROMPT_HEAD_CHARS + PROMPT_TAIL_CHARS ? prompt : `${prompt.slice(0, PROMPT_HEAD_CHARS)}\n…\n${prompt.slice(-PROMPT_TAIL_CHARS)}`;
}

/** 후보마다 예/아니오(core 판정 API 이름 `noul`) 질문 하나. 같은 state를 보므로 한 요청에 묶는다. */
export function buildDocmapJudgeRequest(prompt: string, route: DocmapRoute): { state: unknown; questions: Record<string, unknown> } {
  const questions: Record<string, unknown> = {};
  route.judgeCandidates.forEach((_, i) => {
    questions[`c${i + 1}`] = {
      type: "noul",
      instructions: `Is candidates[${i}] a record of the earlier work the prompt refers to (the same event, decision, procedure or state), not merely sharing words with it? The prompt is one message a user sent to a coding agent mid-conversation; a new instruction, a reaction or small talk that only shares vocabulary is "no".`,
      criteria: { true: "the prompt asks about or continues the work this record covers", false: "new instruction, reaction, small talk, or only topical word overlap" },
    };
  });
  return { state: { prompt: judgePrompt(prompt), candidates: route.judgeCandidates }, questions };
}

/** 판정 답에서 남길 후보. 답이 없는 후보는 버린다. */
export function keptByJudge(route: DocmapRoute, answers: Record<string, { noul?: number } | undefined>): DocmapCandidate[] {
  return route.candidates.filter((_, i) => (answers[`c${i + 1}`]?.noul ?? 0) >= DOCMAP_JUDGE_KEEP);
}

export function createDocmapRoute(deps: DocmapRouteDeps = {}) {
  const loadCore = deps.loadCore ?? defaultLoadCore;
  const resolveJudge = deps.resolveJudge ?? ((ctx: ExtensionContext) => resolveNativeJudge(ctx, loadCore, "docmap_route"));
  const judgeTimeoutMs = deps.judgeTimeoutMs ?? DOCMAP_JUDGE_TIMEOUT_MS;

  return function docmapRoute(pi: ExtensionAPI): void {
    let pendingText: string | undefined;
    let judgePromise: Promise<NativeJudge | undefined> | undefined;
    /** agent_start~agent_end 사이. 실행 중 steering·queued 재요청은 판정 없이 붙인다(mcp-selection과 같은 추적). */
    let inRun = false;
    const judgeFor = (ctx: ExtensionContext) => (judgePromise ??= resolveJudge(ctx).catch(() => undefined));

    pi.on("session_start", () => {
      pendingText = undefined;
      judgePromise = undefined;
      inRun = false;
    });
    pi.on("session_shutdown", () => { pendingText = undefined; });
    pi.on("agent_start", () => { inRun = true; });
    pi.on("agent_end", () => { inRun = false; });
    pi.on("input", (event) => {
      pendingText = undefined;
      if (event.source !== "interactive" && event.source !== "rpc") return;
      const text = event.text.trim();
      if (text) pendingText = text;
    });

    /** 판정으로 거른 안내문. 판정 실패·제한 시간이면 낱말 후보 그대로. */
    const filtered = async (route: DocmapRoute, prompt: string, ctx: ExtensionContext): Promise<string> => {
      const controller = new AbortController();
      const stopped = stoppedBy(controller.signal);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, judgeTimeoutMs);
      try {
        const judge = await Promise.race([judgeFor(ctx), stopped]);
        if (judge === JUDGE_STOPPED) throw new Error("판정 취소");
        if (!judge) throw new Error("native JEV 판정기 없음");
        const result = await Promise.race([judge.judge(buildDocmapJudgeRequest(prompt, route), { signal: controller.signal }), stopped]);
        if (result === JUDGE_STOPPED) throw new Error("판정 취소");
        return route.render(keptByJudge(route, result.answers));
      } catch (error) {
        pi.logger.debug("docmap-route: JEV 후보 판정 없이 낱말 후보를 붙임", {
          error: timedOut ? "판정이 제한 시간 안에 끝나지 않음" : error instanceof Error ? error.message : String(error),
        });
        return route.text;
      } finally {
        clearTimeout(timer);
      }
    };

    pi.on("before_agent_start", async (event, ctx) => {
      // 대화형·RPC는 사용자 입력과 같은 본문의 prompt에만 붙인다. CUELO의 재개·업데이트 통지와 goal 계속 같은
      // 내부 prompt는 `input`을 내지 않아(lib/rpc-manager.ts isGenuineUserRequest) 여기서 빠진다.
      // `omp -p`는 input 이벤트가 없어 최상위 세션의 CLI prompt 자체를 사용자 요청으로 본다. CUELO도 확장을
      // mode 없이 초기화해 ctx.mode가 "print"이므로, UI 문맥이 없다는 것까지 봐야 CLI로 가를 수 있다.
      const fromInput = pendingText !== undefined && event.prompt.includes(pendingText);
      const cliPrompt = (ctx.mode === "print" || ctx.mode === "json") && !ctx.hasUI && ctx.agent?.kind === "main";
      if (!fromInput && !cliPrompt) return;
      const prompt = fromInput ? pendingText! : event.prompt;
      let route: DocmapRoute | undefined;
      try {
        route = routeDocmap(ctx.cwd, prompt, deps.now?.());
      } catch {
        return;
      }
      if (!route) return;
      const content = inRun ? route.text : await filtered(route, prompt, ctx);
      if (!content) return;
      return { message: { customType: CUSTOM_TYPE, content, display: false, attribution: "agent" } };
    });
  };
}

export default createDocmapRoute();
