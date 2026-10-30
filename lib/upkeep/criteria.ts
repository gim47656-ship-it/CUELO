/**
 * 보수 대시보드 판정 기준. 임계값은 모두 여기 이름 붙은 상수로 둔다.
 * 기본 규칙: 직전 7일보다 50% 넘게 나빠지면 주의, 2배 이상이면 문제. 한 기간이라도 표본이
 * MIN_SAMPLE보다 적으면 판정하지 않는다. HANDOFF에 따로 적힌 기준이 있으면 그 기준이 이긴다.
 */
import type { UpkeepStatus } from "./types";

export const MIN_SAMPLE = 20;
export const WATCH_FACTOR = 1.5;
export const PROBLEM_FACTOR = 2;
export const GENERIC_CRITERION = "직전 7일 대비 50% 넘게 나빠지면 주의, 2배 이상이면 문제 (두 기간 모두 표본 20 이상일 때)";

/** 건수 지표는 작업량 차이를 빼려고 사용자 요청 100건당으로 비교한다. */
export const PER_TURNS = 100;

/** 도구 결과 뒤 다음 모델 요청까지 이보다 오래 걸리면 느린 대기로 센다. */
export const SLOW_GAP_MS = 20_000;

/** HANDOFF 「기본 Maker 관찰」: 한 모델이 partial로 2회 이상 끝나면 보고. */
export const EARLY_EXIT_REPORT_COUNT = 2;

export const COMPLAINT_EXPRESSIONS = ["또 ", "왜 안", "아까 말", "말했잖", "다시 말하", "몇 번", "그게 아니라", "안 되잖", "왜 이래", "아직도"];

/** HANDOFF 「리뷰 게이트 다듬기 후속(10-29)」의 번역 캐시 재작성 비율: 수정 전 51.5%, 평소 0.8%. */
export const TRANSLATION_CACHE_BEFORE = 0.515;
export const TRANSLATION_CACHE_BASELINE = 0.008;

/** 비용 지표는 두 기간 중 큰 쪽이 이 금액(달러) 이상일 때만 판정한다. */
export const COST_FLOOR_USD = 1;
/** 캐시 쓰기 비율은 이 값 이상이고 직전보다 늘었을 때만 판정한다. */
export const CACHE_WRITE_FLOOR = 0.1;
/** 비용 섹션에 따로 보이는 목적·모델 수. 나머지는 「기타 합계」로 묶는다. */
export const COST_TOP = 12;

/** 기한 초과 HANDOFF 항목 수 기준. */
export const OVERDUE_WATCH = 1;
export const OVERDUE_PROBLEM = 3;

/** 진행 중인 CI가 이 시간을 넘기면 주의. */
export const CI_STALE_MS = 3_600_000;

export function compare(
  current: number | null,
  previous: number | null,
  currentSample: number,
  previousSample: number,
  direction: "higher" | "lower" = "higher",
): UpkeepStatus {
  if (current === null || previous === null || currentSample < MIN_SAMPLE || previousSample < MIN_SAMPLE) return "unknown";
  const worse = direction === "higher" ? current > previous : current < previous;
  if (!worse) return "ok";
  const factor = direction === "higher"
    ? (previous === 0 ? Infinity : current / previous)
    : (current === 0 ? Infinity : previous / current);
  if (factor >= PROBLEM_FACTOR) return "problem";
  return factor > WATCH_FACTOR ? "watch" : "ok";
}

export function worst(statuses: UpkeepStatus[]): UpkeepStatus {
  if (statuses.includes("problem")) return "problem";
  if (statuses.includes("watch")) return "watch";
  if (statuses.includes("unknown")) return "unknown";
  return "ok";
}

export function perTurns(count: number, turns: number): number | null {
  return turns ? (count / turns) * PER_TURNS : null;
}
