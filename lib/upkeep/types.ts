/**
 * 보수 대시보드(upkeep) 데이터 계약. 서버 수집기(`lib/upkeep/collect*.ts`, `GET /api/upkeep`)가 만들고
 * 화면(`components/upkeep/*`)과 점검 프롬프트 생성기가 읽는다. 두 쪽이 같은 모양을 보도록 이 파일만
 * 정본으로 둔다.
 */

/** 정상·주의·문제. 비교할 표본이 없거나 자료를 못 읽으면 `unknown`이다. */
export type UpkeepStatus = "ok" | "watch" | "problem" | "unknown";

/** 섹션 순서는 화면 순서와 같다. */
export const UPKEEP_SECTION_IDS = ["bottleneck", "memory", "cost", "due", "complaints", "deploy"] as const;
export type UpkeepSectionId = (typeof UPKEEP_SECTION_IDS)[number];

export type UpkeepUnit = "count" | "ratio" | "usd" | "ms" | "tokens";

/** 지표 하나를 뒷받침하는 사례. 세션으로 이어지면 `sessionId`를 채운다. */
export interface UpkeepEvidence {
  label: string;
  count?: number;
  sessionId?: string;
  /** 세션 파일 절대 경로. 프롬프트가 작업 세션에 그대로 넘긴다. */
  sessionPath?: string;
  /** ISO 시각 */
  timestamp?: string;
  detail?: string;
}

/** 판정 기준이 HANDOFF 항목에서 왔을 때 그 항목. 프롬프트에 원문 그대로 실린다. */
export interface UpkeepHandoffRef {
  /** 저장소 기준 상대 경로, 예: `HANDOFF.md` */
  path: string;
  /** 굵은 주제 문자열(콜론 앞), 예: `Terra 기본 Maker 관찰(10-30)` */
  title: string;
  /** 그 글머리표 본문 전체(하위 글머리표 포함) */
  text: string;
}

export interface UpkeepMetric {
  /** 섹션 안에서 고유. 프롬프트·테스트가 이 값으로 지표를 찾는다. */
  id: string;
  label: string;
  unit: UpkeepUnit;
  /** 현재 창(최근 7일) 값. 측정 불가면 null */
  current: number | null;
  /** 직전 창(그 전 7일) 값. 측정 불가면 null */
  previous: number | null;
  status: UpkeepStatus;
  /** 사람이 읽는 판정 기준 한 줄, 예: "직전 7일보다 50% 넘게 늘면 주의, 2배면 문제" */
  criterion: string;
  /** 기준을 HANDOFF에서 가져왔으면 그 항목 */
  handoff?: UpkeepHandoffRef;
  /** 값의 한계·해석 주의 한 줄(표본 부족 등) */
  note?: string;
  /** 상위 사례. 최대 10개 */
  evidence: UpkeepEvidence[];
}

/** HANDOFF의 「다음 행동」·「관찰 대기」·「남은 일」 글머리표 하나. */
export interface UpkeepDueItem {
  ref: UpkeepHandoffRef;
  /** 원문 절 제목, 예: `관찰 대기` */
  section: string;
  /** 점검 예정일(YYYY-MM-DD). 본문에서 날짜를 읽지 못하면 null */
  dueDate: string | null;
  /** `date`: 명시한 점검일, `after-deploy`: "배포 7일 뒤"처럼 기준일+기간으로 계산, `condition`: 조건 발생 시에만, `none`: 못 읽음 */
  dueKind: "date" | "after-deploy" | "condition" | "none";
  /** dueDate가 오늘(KST) 이전이면 true */
  overdue: boolean;
}

export interface UpkeepSection {
  id: UpkeepSectionId;
  title: string;
  /** 섹션 안 지표·항목 중 가장 나쁜 상태 */
  status: UpkeepStatus;
  /** 한 줄 요약 */
  summary: string;
  metrics: UpkeepMetric[];
  /** `due` 섹션에서만 채운다 */
  items?: UpkeepDueItem[];
  /** 이 섹션을 만들다 생긴 읽기 실패·건너뛴 자료 */
  warnings: string[];
}

export interface UpkeepReport {
  generatedAt: string;
  window: {
    /** 현재 창 시작·끝(ISO), 직전 창 시작(끝은 현재 창 시작) */
    currentStart: string;
    currentEnd: string;
    previousStart: string;
  };
  /** 읽은 세션 파일 수와 걸린 시간 */
  scannedFiles: number;
  scanMs: number;
  /** 작업 프롬프트로 새 세션을 열 CUELO 저장소 경로. 찾지 못하면 null(화면이 사용자에게 고르게 한다) */
  repoCwd: string | null;
  sections: UpkeepSection[];
}
