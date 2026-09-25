import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 발주 라우팅 이력. 추천·실제 선택·실행 상태·Main 수용 판정을 append-only JSON Lines로 남기고,
 * 다음 maker_route에 advisory로만 요약한다. 규칙·후보·강도는 이 기록으로 자동 변경하지 않는다.
 *
 * 귀속은 name이 아니라 결정적 identity(sessionId·assignmentId·attemptId)로 한다. name은 표시용이다.
 * - assignment: 작업 단위. 같은 session에서 이름이 같아도 새 비재작업 발주면 새 assignment다.
 * - attempt: assignment 안의 시도. FINDING_ID 재작업은 assignmentId를 유지하고 attempt만 늘린다.
 *   실제로 spawn되지 않은 prepared attempt는 판정 대상이 아니다.
 */

/** 발주 시도 하나의 결정적 identity. maker_route 호출 id·session·batch index와 spawn 관측 agentId에서 파생한다. */
export interface AttemptIdentity {
  sessionId: string;
  assignmentId: string;
  /** assignment 안의 1부터 시작하는 시도 번호. */
  attempt: number;
  attemptId: string;
  /** spawn progress row의 canonical child id(= agent:// target). 관측하지 못하면 빈 문자열이며 추측으로 채우지 않는다. */
  agentId: string;
  /** 그 attempt가 실제로 settle한 async jobId. 관측하지 못하면 빈 문자열. */
  jobId: string;
}

export interface DispatchRecord extends AttemptIdentity {
  type: "dispatch";
  ts: string;
  /** 표시용 이름. 귀속에는 쓰지 않는다. */
  name: string;
  /** Jev가 고른 작업 등급(NORMAL|HARD). Jev 불가면 null. TASK_GUARD WORK_CLASS가 아니다. */
  workClass: string | null;
  /** HARD일 때 Jev hardFocus. NORMAL이면 null. */
  focus: string | null;
  recommendedProfile: string | null;
  recommendedModel: string | null;
  recommendedEffort: string | null;
  chosenModel: string;
  chosenEffort: string;
  routingReason: boolean;
  purpose: string | null;
}

export interface OutcomeRecord extends AttemptIdentity {
  type: "outcome";
  ts: string;
  /** 실행 상태일 뿐 품질 판정이 아니다. */
  status: "completed" | "failed" | "cancelled";
  durationSec: number | null;
}

/**
 * Main의 명시 수용 판정. 실행 상태(outcome)와 따로 남기며 자동 추정으로 만들지 않는다.
 * - accepted: 그 attempt가 완료되었고 Main이 revision·evidence와 함께 수용했다.
 * - rework: 그 attempt를 다시 해야 한다고 Main이 reason·evidence로 판정했다.
 * - held: 검증이 아직 끝나지 않았다. revision·evidence가 없을 수 있다.
 */
export interface VerdictRecord extends AttemptIdentity {
  type: "verdict";
  ts: string;
  verdict: "accepted" | "rework" | "held";
  revision: string | null;
  evidenceLocators: string[];
  reason: string;
}

export type LedgerRecord = DispatchRecord | OutcomeRecord | VerdictRecord;

export interface RoutingLedger {
  /** 실패해도 던지지 않는다. 기록 실패가 발주를 막으면 안 된다. 저장 성공 여부를 돌려준다. */
  append(record: LedgerRecord): boolean;
  /** 실패하면 빈 목록. 깨진 줄은 건너뛴다. */
  read(): LedgerRecord[];
}

/** 실행 프로필의 agent 루트. prompt-compact의 AGENT_DIR과 같은 관례이며 OMPWEB의 steering-received.jsonl과 같은 자리다. */
export const DEFAULT_LEDGER_PATH = join(import.meta.dir, "..", "..", "routing-ledger.jsonl");

// 요약은 최근 기록만 쓴다. 파일 전체를 매 route마다 읽지 않도록 꼬리만 읽는다.
// dispatch 한 줄은 약 400B라 1MiB면 수천 건이고 최근 30건 창에는 충분하다.
const TAIL_BYTES = 1 << 20;

export function createRoutingLedger(path: string, onError?: (error: unknown) => void): RoutingLedger {
  return {
    append(record) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
        return true;
      } catch (error) {
        onError?.(error);
        return false;
      }
    },
    read() {
      let fd: number | undefined;
      try {
        fd = openSync(path, "r");
        const size = fstatSync(fd).size;
        const start = Math.max(0, size - TAIL_BYTES);
        const bytes = new Uint8Array(size - start);
        readSync(fd, bytes, 0, bytes.length, start);
        let text = new TextDecoder().decode(bytes);
        // 꼬리 읽기의 첫 줄은 잘렸을 수 있다.
        if (start > 0) text = text.slice(text.indexOf("\n") + 1);
        return text.split("\n").flatMap((line) => {
          if (!line.trim()) return [];
          try {
            const parsed = JSON.parse(line) as LedgerRecord;
            return parsed && (parsed.type === "dispatch" || parsed.type === "outcome" || parsed.type === "verdict") ? [parsed] : [];
          } catch {
            return [];
          }
        });
      } catch (error) {
        if ((error as { code?: string } | null)?.code !== "ENOENT") onError?.(error);
        return [];
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    },
  };
}

/** identity(sessionId·assignmentId·attemptId)와 관측된 canonical agentId가 모두 있어야 귀속 대상이다. */
export function hasIdentity(record: { sessionId?: unknown; assignmentId?: unknown; attemptId?: unknown; agentId?: unknown }): boolean {
  return typeof record.sessionId === "string" && record.sessionId.length > 0
    && typeof record.assignmentId === "string" && record.assignmentId.length > 0
    && typeof record.attemptId === "string" && record.attemptId.length > 0
    // agentId를 관측하지 못한 발주는 unobserved이며 정상 품질 기록이 아니다.
    && typeof record.agentId === "string" && record.agentId.length > 0;
}

/**
 * ok=명시 수용, rework=명시 재작업, held=수용 미확인, pending=판정 전,
 * aborted=운영 중단(failed/cancelled)이며 품질 실패가 아니다.
 */
export interface HistoryBucket { ok: number; rework: number; held: number; pending: number; aborted: number }
export interface RoutingHistory {
  workClass: string;
  focus: string | null;
  /** 요약에 쓴 attempt 수(최대 HISTORY_WINDOW). */
  attempts: number;
  /** identity가 없어 집계에서 뺀 발주 수. 과거 name-only 기록이 여기 든다. */
  unobserved: number;
  followed: HistoryBucket;
  switched: Record<string, HistoryBucket>;
  /** 관측 건수와 불확실성만 적는 중립 안내. 우열 판정도 자동 변경도 하지 않는다. */
  observation: string | null;
}

/** 같은 등급(HARD면 분야 포함)의 최근 발주만 본다. 오래된 배치 결과가 현재 후보 표를 대변하지 않게 한다. */
export const HISTORY_WINDOW = 30;

const emptyBucket = (): HistoryBucket => ({ ok: 0, rework: 0, held: 0, pending: 0, aborted: 0 });
/** 성공률 분모는 품질 판정이 끝난 attempt뿐이다. held·pending·운영 중단은 뺀다. */
const decided = (bucket: HistoryBucket) => bucket.ok + bucket.rework;

interface AttemptSample { dispatch: DispatchRecord; outcome: OutcomeRecord | null; verdict: VerdictRecord | null }

/** 같은 session에서 이름이 단 하나의 assignment를 가리킬 때만 명시 FINDING_ID 재발주를 연결한다. */
export function assignmentsByName(
  records: readonly LedgerRecord[],
  sessionId: string,
): Map<string, { assignmentId: string; lastAttempt: number }> {
  const known = new Map<string, { assignmentId: string; lastAttempt: number }>();
  const ambiguous = new Set<string>();
  if (!sessionId) return known;
  for (const record of records) {
    if (record.type !== "dispatch" || record.sessionId !== sessionId || !hasIdentity(record) || ambiguous.has(record.name)) continue;
    const previous = known.get(record.name);
    if (previous && previous.assignmentId !== record.assignmentId) {
      ambiguous.add(record.name);
      known.delete(record.name);
    } else {
      known.set(record.name, { assignmentId: record.assignmentId, lastAttempt: Math.max(previous?.lastAttempt ?? 0, record.attempt) });
    }
  }
  return known;
}

/** 같은 session에서 identity가 있는 attempt를 원장에서 복원한다. dispatch·outcome·verdict 어느 것으로도 등록된다. */
export function scopedAttempts(
  records: readonly LedgerRecord[],
  sessionId: string,
): { identity: AttemptIdentity; name: string; status: OutcomeRecord["status"] | "running" }[] {
  if (!sessionId) return [];
  const byAttempt = new Map<string, { identity: AttemptIdentity; name: string; status: OutcomeRecord["status"] | "running" }>();
  const order: string[] = [];
  for (const record of records) {
    if (!hasIdentity(record) || record.sessionId !== sessionId) continue;
    const key = attemptKey(record);
    const entry = byAttempt.get(key) ?? {
      identity: {
        sessionId: record.sessionId,
        assignmentId: record.assignmentId,
        attempt: record.attempt,
        attemptId: record.attemptId,
        agentId: record.agentId,
        jobId: record.jobId,
      },
      name: "",
      status: "running",
    };
    if (record.type === "dispatch") entry.name = record.name;
    else if (record.type === "outcome") entry.status = record.status;
    if (!byAttempt.has(key)) order.push(key);
    byAttempt.set(key, entry);
  }
  return order.map((key) => byAttempt.get(key)!);
}

/** 정확한 triple로만 잇는다. sessionId·assignmentId·attemptId 중 하나라도 다른 기록은 붙이지 않는다. */
const attemptKey = (record: AttemptIdentity) => `${record.sessionId}\u0000${record.assignmentId}\u0000${record.attemptId}`;

/** 정확한 identity triple로 dispatch·outcome·verdict를 묶는다. identity 없는 발주는 버리지 않고 따로 모은다. */
function samplesOf(records: readonly LedgerRecord[]): { samples: AttemptSample[]; unscopedDispatches: DispatchRecord[] } {
  const byAttempt = new Map<string, AttemptSample>();
  const order: string[] = [];
  const unscopedDispatches: DispatchRecord[] = [];
  for (const record of records) {
    if (!hasIdentity(record)) {
      if (record.type === "dispatch") unscopedDispatches.push(record);
      continue;
    }
    const key = attemptKey(record);
    if (record.type === "dispatch") {
      // 같은 triple이 다시 오면 첫 dispatch를 유지한다. 재발행 기록이 앞선 시도를 이중 집계하지 않게 한다.
      if (!byAttempt.has(key)) {
        byAttempt.set(key, { dispatch: record, outcome: null, verdict: null });
        order.push(key);
      }
      continue;
    }
    const sample = byAttempt.get(key);
    if (!sample) continue;
    if (record.type === "outcome") sample.outcome = record;
    else sample.verdict = record;
  }
  return { samples: order.map((key) => byAttempt.get(key)!), unscopedDispatches };
}

/** attempt 하나를 품질 버킷에 넣는다. 실행 상태만으로 품질을 정하지 않는다. */
function classify(sample: AttemptSample): keyof HistoryBucket {
  const status = sample.outcome?.status ?? null;
  switch (sample.verdict?.verdict) {
    case "accepted":
      // 수용은 그 attempt가 실제로 완료됐을 때만 성공이다.
      return status === "completed" ? "ok" : "pending";
    case "rework":
      // 재작업 판정은 운영 상태와 무관한 품질 실패다.
      return "rework";
    case "held":
      return "held";
    default:
      // 운영 실패·취소는 Main이 구현 결함을 evidence와 함께 판정하기 전까지 품질 실패가 아니다.
      return status === "failed" || status === "cancelled" ? "aborted" : "pending";
  }
}

const counts = (bucket: HistoryBucket) =>
  `판정 ${decided(bucket)}건(수용 ${bucket.ok}·재작업 ${bucket.rework}), 보류 ${bucket.held}·대기 ${bucket.pending}·운영중단 ${bucket.aborted}`;

export function summarizeHistory(records: readonly LedgerRecord[], workClass: string, focus: string | null): RoutingHistory {
  const inScope = (dispatch: DispatchRecord) =>
    dispatch.workClass === workClass && (workClass !== "HARD" || dispatch.focus === focus);
  const { samples, unscopedDispatches } = samplesOf(records);
  const unobserved = unscopedDispatches.filter(inScope).length;
  const scoped = samples
    .filter((sample) => inScope(sample.dispatch) && sample.dispatch.recommendedModel !== null)
    .slice(-HISTORY_WINDOW);
  const followed = emptyBucket();
  const switched: Record<string, HistoryBucket> = {};
  for (const sample of scoped) {
    const { dispatch } = sample;
    const same = dispatch.chosenModel === dispatch.recommendedModel && dispatch.chosenEffort === dispatch.recommendedEffort;
    const bucket = same ? followed : (switched[`${dispatch.chosenModel}:${dispatch.chosenEffort}`] ??= emptyBucket());
    bucket[classify(sample)] += 1;
  }
  let observation: string | null = null;
  if (scoped.length > 0) {
    const parts = [`추천 따름 ${counts(followed)}`];
    for (const [value, bucket] of Object.entries(switched)) parts.push(`대체 ${value} ${counts(bucket)}`);
    const excluded = unobserved > 0 ? ` identity 없는 과거 발주 ${unobserved}건은 집계에서 제외했습니다.` : "";
    observation = `최근 ${scoped.length}건: ${parts.join("; ")}. 건수와 불확실성만 적으며 우열 판정이나 기준 자동 변경은 하지 않습니다.${excluded}`;
  }
  return { workClass, focus, attempts: scoped.length, unobserved, followed, switched, observation };
}
