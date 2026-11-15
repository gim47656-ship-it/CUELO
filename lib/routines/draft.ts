import { completeSimple } from "@oh-my-pi/pi-ai";
import { parseModelString } from "@oh-my-pi/pi-tui/overlays/model-selector";
import { getOmpRuntime } from "../omp-runtime";
import { localParts, ROUTINE_TIMEZONE } from "./schedule";
import { parseRoutineInput, type Routine, type RoutineInput } from "./store";

export function defaultRoutineHost(routines: Routine[], thisHost: string): string {
  const counts = new Map<string, number>();
  for (const routine of routines) if (routine.enabled) counts.set(routine.host, (counts.get(routine.host) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? thisHost;
}

export function parseRoutineDraft(text: string, routines: Routine[], thisHost: string, now = new Date()): { draft: RoutineInput; oneOff: boolean } {
  const raw = JSON.parse(text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, ""));
  if (!raw || typeof raw !== "object" || typeof raw.oneOff !== "boolean") throw new Error("초안의 oneOff는 true 또는 false여야 합니다.");
  const at = localParts(now, ROUTINE_TIMEZONE);
  const parsed = parseRoutineInput({
    name: raw.name, prompt: raw.prompt,
    schedule: raw.oneOff ? { kind: "once", date: at.date, time: at.time } : raw.schedule,
    host: raw.oneOff ? thisHost : defaultRoutineHost(routines, thisHost), enabled: true, cwd: null, model: null,
  });
  if ("error" in parsed) throw new Error(`초안 형식이 올바르지 않습니다: ${parsed.error}`);
  return { draft: parsed.input, oneOff: raw.oneOff };
}

export async function createRoutineDraft(text: string, routines: Routine[], thisHost: string) {
  const { modelRegistry, settings } = await getOmpRuntime();
  const selector = settings.getModelRole("draft");
  const ref = selector ? parseModelString(selector) : null;
  const model = ref ? modelRegistry.find(ref.provider, ref.id) : undefined;
  if (!model) throw new Error("초안 모델을 사용할 수 없습니다.");
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? "초안 모델의 인증 정보가 없습니다." : auth.error);
  const now = new Date();
  const at = localParts(now, ROUTINE_TIMEZONE);
  const response = await completeSimple(model, {
    systemPrompt: [`사용자의 요청을 루틴 초안 JSON으로 변환한다. 도구 없이 JSON만 답한다. 형태: {"name":"짧은 이름","prompt":"사용자가 시킨 일","oneOff":false,"schedule":{"kind":"weekly","days":[0,1,2,3,4,5,6],"times":["09:00"]}}. schedule은 weekly(days 0 일요일..6 토요일, times HH:mm), hourly(everyHours 1..12, minute 0..59, 선택 startHour 0..23와 days), once(date YYYY-MM-DD, time HH:mm) 중 하나. 지금 한 번 실행할 요청이면 oneOff true. 특정 미래 날짜에 한 번은 oneOff false와 once 일정. 현재 한국 시각 ${at.date} ${at.time}. 사용자가 말하지 않은 조건, 기한, 여행 일정, 행동을 추가하지 않는다. prompt에는 실행할 일만 충실하게 다시 쓴다. 주기가 없으면 oneOff true.`],
    messages: [{ role: "user", content: text, timestamp: now.getTime() }],
  }, { apiKey: auth.apiKey, headers: auth.headers, maxTokens: 2048, disableReasoning: true, signal: AbortSignal.timeout(60_000), cacheRetention: "none" });
  if (response.stopReason !== "stop") throw new Error(`초안 생성이 끝나지 않았습니다: ${response.errorMessage ?? response.stopReason}`);
  return parseRoutineDraft(response.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""), routines, thisHost, now);
}
