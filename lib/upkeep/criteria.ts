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

/**
 * 건수 행은 두 기간 중 큰 쪽 원 건수가 이 수 이상일 때만 판정한다(2026-11-06 사용자 결정: 「20초 넘는 대기」가 원 건수 3 대 1만으로
 * 「문제」가 됐다). 비용 행의 COST_FLOOR_USD와 같은 역할이다.
 */
export const COUNT_FLOOR = 5;
/** Five incidents avoids single-error ratio alarms; reuse the existing count noise floor. */
export const INCIDENT_FLOOR = COUNT_FLOOR;
/** A 48h quiet window resets event alarms only after MIN_SAMPLE fresh opportunities. */
export const RECENT_WINDOW_MS = 48 * 3_600_000;
/** Model allocation is not a defect by itself: require ten times the $1 cost noise floor per week. */
export const MODEL_COST_FLOOR_USD = 10;
/** Budget: investigate a quarter of cache-writing spend; a majority is a problem. */
export const REWRITE_WATCH_SHARE = 0.25;
export const REWRITE_PROBLEM_SHARE = 0.5;
/** Weekly $10/$25 floors prevent negligible spend from exhausting the share budget. */
export const REWRITE_WATCH_USD = 10;
export const REWRITE_PROBLEM_USD = 25;
/** Budget: one reminder per four requests is watch; one per two is problem. */
export const NUDGE_WATCH_PER_100 = 25;
export const NUDGE_PROBLEM_PER_100 = 50;
/** 「다시 지적하는 표현」은 평소 주당 1건 안팎이라 5건 바닥이면 실제로 늘어난 것도 놓쳐 3건으로 둔다(2026-11-06 사용자 결정). */
export const COMPLAINT_COUNT_FLOOR = 3;

/** 도구 결과 뒤 다음 모델 요청까지 이보다 오래 걸리면 느린 대기로 센다. */
export const SLOW_GAP_MS = 20_000;

/** HANDOFF 「기본 Maker 관찰」: 한 모델이 partial로 2회 이상 끝나면 보고. */
export const EARLY_EXIT_REPORT_COUNT = 2;

/**
 * 「또」는 메시지 어디에 있든 센다. 접속사 「또는」과 「또한」만 뺀다(2026-11-12 사용자 결정: 집 PC 11-05~11-12 표시 뒤 문장 중간·끝
 * 「또」 6건 중 5건이 실제 지적(「지금또 바탕화면에 안보이네독이」「f5 또안눌리는데」)이었는데 첫머리 규칙은 4건만 잡았다).
 */
const AGAIN = /또(?![는한])/u;
export const COMPLAINT_EXPRESSIONS = ["왜 안", "아까 말", "말했잖", "다시 말하", "몇 번", "그게 아니라", "안 되잖", "왜 이래", "아직도"];

export function isComplaint(text: string): boolean {
  if (text.length > COMPLAINT_MAX_CHARS) return false;
  return AGAIN.test(text) || COMPLAINT_EXPRESSIONS.some((x) => text.includes(x));
}
/**
 * 이보다 긴 사용자 메시지는 지적 표현으로 세지 않는다(2026-11-04 사용자 결정). 붙여 넣은 글(조사 결과·다른 PC 요청)과 CUELO가
 * 만든 지시문(보수 점검 프롬프트는 지난 지적을 근거로 인용한다)이 여기에 든다. 11-04 점검의 실제 지적은 12~43자, 붙여 넣은
 * 글은 418자 이상이었다. 요청 수로는 그대로 센다.
 */
export const COMPLAINT_MAX_CHARS = 300;

/** HANDOFF 「리뷰 게이트 다듬기 후속(10-29)」의 번역 캐시 재작성 비율: 수정 전 51.5%, 평소 0.8%. */
export const TRANSLATION_CACHE_BEFORE = 0.515;
export const TRANSLATION_CACHE_BASELINE = 0.008;

/** 비용 지표는 두 기간 중 큰 쪽이 이 금액(달러) 이상일 때만 판정한다. */
export const COST_FLOOR_USD = 1;
/**
 * 비용 행은 작업량 차이를 빼려고 요청 100건당 금액으로 비교한다(2026-10-30 사용자 결정, 표본은 그 키의 호출 수).
 * 판정 금액은 OAuth(구독) 사용분을 뺀 청구분이다(2026-10-31 사용자 결정): 구독 사용량은 참고 금액으로만 보여 준다.
 */
export const COST_CRITERION = "OAuth(구독) 사용분을 뺀 청구분의 요청 100건당 금액이 직전 7일보다 50% 넘게 늘면 주의, 2배 이상이면 문제 (두 기간 모두 호출 20건 이상이고 큰 쪽 청구분이 $1 이상일 때)";
/** 캐시 쓰기 비율은 이 값 이상이고 직전보다 늘었을 때만 판정한다. */
export const CACHE_WRITE_FLOOR = 0.1;
/** 비용 섹션에 따로 보이는 목적·모델 수. 나머지는 「기타 합계」로 묶는다. */
export const COST_TOP = 12;

/**
 * 본 요청 캐시 다시 쓰기(2026-10-31 사용자 결정): 캐시 쓰기가 이 토큰 수 이상이고 캐시 읽기가 직전 요청 프롬프트
 * (input+cacheRead+cacheWrite)의 이 비율 미만이면 다시 쓰기로 본다. 만료 판단은 이 요청이 1시간 캐시를 썼으면 1시간,
 * 아니면 5분이다.
 */
export const REWRITE_MIN_WRITE = 20_000;
export const REWRITE_READ_SHARE = 0.5;
export const CACHE_TTL_LONG_MS = 3_600_000;
export const CACHE_TTL_SHORT_MS = 300_000;

/** 이 기간 동안 세션 기록이 없는 worktree는 남은 작업 공간으로 본다. */
export const STALE_WORKTREE_MS = 3 * 86_400_000;

/**
 * 원격 `wt/nightly-YYYYMMDD` 브랜치를 그 날짜(KST)부터 이 기간 남긴다. 각 PC의 아침 보고가 이 브랜치로 클라우드 변경을 모으므로,
 * 며칠 꺼져 있던 PC도 보고를 받게 한다. 야간 정리와 「남은 작업 공간」이 같은 기준을 쓴다.
 */
export const NIGHTLY_BRANCH_RETENTION_DAYS = 7;

/**
 * 이름 전체가 `wt/nightly-YYYYMMDD`(앞에 `origin/`·`refs/heads/` 하나는 허용)인 브랜치의 날짜 KST 00:00(ms). 야간 브랜치 이름이
 * 아니거나 달력에 없는 날짜(2월 30일 같은)면 null.
 */
export function nightlyBranchStart(branch: string): number | null {
  const match = /^(?:origin\/|refs\/heads\/)?wt\/nightly-(\d{4})(\d{2})(\d{2})$/.exec(branch);
  if (!match) return null;
  const day = `${match[1]}-${match[2]}-${match[3]}`;
  const start = Date.parse(`${day}T00:00:00+09:00`);
  // Date.parse는 넘친 날짜를 다음 달로 넘기므로, 되돌린 KST 날짜가 같은지 본다.
  if (Number.isNaN(start) || new Date(start + 9 * 3_600_000).toISOString().slice(0, 10) !== day) return null;
  return start;
}

/** 날짜를 읽은 야간 브랜치가 아직 보존 기간 안이면 true. 야간 브랜치가 아니거나 날짜를 못 읽으면 false. */
export function nightlyBranchRetained(branch: string, now: number): boolean {
  const start = nightlyBranchStart(branch);
  return start !== null && now - start < NIGHTLY_BRANCH_RETENTION_DAYS * 86_400_000;
}

/** 고침 표시한 행 중 분모가 없는 기간 합계 행은 표시 뒤 이 시간이 지나야 판정한다(그 전에는 관찰 중). */
export const FIX_OBSERVE_MS = 86_400_000;

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
  incidents?: readonly [number, number],
): UpkeepStatus {
  if (current === null || previous === null || currentSample < MIN_SAMPLE || previousSample < MIN_SAMPLE) return "unknown";
  if (incidents && Math.max(...incidents) < INCIDENT_FLOOR) return "ok";
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

/** Versioned rule identities keep unrelated criteria out of the same precision group. */
export function criterionIdForMetric(id: string): string {
  if (id.startsWith("skill:")) return "skill-correlation-info-v2";
  if (id.startsWith("model:")) return "model-cost-v2";
  if (id.startsWith("purpose:")) return "purpose-cost-v1";
  return `${id}-v2`;
}
