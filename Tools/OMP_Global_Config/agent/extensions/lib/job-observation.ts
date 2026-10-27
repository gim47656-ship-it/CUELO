// Main이 띄운 장기 background bash/eval job의 관측 시점 원장(harness-policy mainLane.waitContract.requiredObservation).
// 2026-10-15 실측: Main이 공개 CI watch job 하나에 `wait`로 약 8분을 막힌 채 중간 관측 없이 지냈다. `wait`는 job 정산·메시지·
// service 종료·30분 상한에만 깨고, 기존 SubagentActivityWatch(core patch)는 task child만 본다. 이 원장은 jev-runtime이
// wait 진입 차단과 대기 중 aside 깨우기를 결정론적으로 판단하도록 job incarnation(id+startTime)별 관측 근거만 기록한다.
// 기대 실행 시간을 받는 API가 없으므로(bash `timeout`은 마감이지 예상 시간이 아니다) 첫 관측은 10분 fallback을 쓴다. 측정한
// 예상 실행 시간이 아니다. 2026-10-28 감사(doc/history/2026/10/28-guard-trim/advisory): 5분 기한 알림을 받은 job 중 끝난 시각을
// 찾은 90개의 61개(68%)가 10분 전에, 78개(87%)가 15분 전에 끝났고 알림 151건 중 137건의 확인은 아직 실행 중이었다. 출력이
// 바뀐 확인 뒤에만 15·30분으로 넓히고, 바뀌지 않은 확인은 첫 주기로 되돌려 원인 조사를 요구한다. 경과 시간은 실패 근거가 아니다.

export interface JobObservationClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}

export const JOB_OBSERVATION_INTERVALS_MS: readonly number[] = [10 * 60_000, 15 * 60_000, 30 * 60_000];

// 출력 비교용으로 보관하는 꼬리 길이. core가 이미 진행 출력을 꼬리로 잘라 주므로 비교만을 위한 상한이다.
const OUTPUT_COMPARE_CHARS = 16_000;

export interface ObservedJob {
  readonly id: string;
  readonly type: "bash" | "eval";
  readonly startTime: number;
  label: string;
  /** 같은 incarnation의 마지막 성공한 `read proc://<id>` 시각. */
  inspectedAt: number | undefined;
  inspections: number;
  /** 마지막 확인의 출력 꼬리. 첫 확인은 비교 기준만 세운다. */
  output: string | undefined;
  /** JOB_OBSERVATION_INTERVALS_MS 단계. 출력이 바뀐 확인만 올린다. */
  step: number;
  /** 마지막 두 확인의 출력이 같았다. */
  unchanged: boolean;
  /** 이 due 시각에 대기 중 알림을 이미 보냈다. */
  notifiedDueAt: number | undefined;
}

/** job 하나의 실행 식별(같은 id를 재사용한 새 실행은 startTime·type이 다르다). */
export type JobIncarnation = Pick<ObservedJob, "id" | "type" | "startTime">;

interface EligibleRow {
  id: string;
  type: "bash" | "eval";
  startTime: number;
  label: string;
}

/**
 * snapshot running 행 중 관측 대상만 고른다. task(agent-backed) job은 기존 SubagentActivityWatch가 맡고, 이름 붙은
 * bash service는 AsyncJobManager 행이 아니므로 여기 오지 않는다.
 */
function eligible(raw: unknown): EligibleRow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as { id?: unknown; type?: unknown; status?: unknown; startTime?: unknown; agentId?: unknown; label?: unknown };
  if (row.type !== "bash" && row.type !== "eval") return undefined;
  if (row.status !== "running") return undefined;
  if (typeof row.id !== "string" || !row.id) return undefined;
  if (typeof row.startTime !== "number" || !Number.isFinite(row.startTime)) return undefined;
  if (typeof row.agentId === "string" && row.agentId) return undefined;
  return { id: row.id, type: row.type, startTime: row.startTime, label: typeof row.label === "string" ? row.label : "" };
}

export class JobObservationLedger {
  readonly #jobs = new Map<string, ObservedJob>();
  readonly intervals: readonly number[];

  constructor(intervals: readonly number[] = JOB_OBSERVATION_INTERVALS_MS) {
    if (intervals.length === 0 || intervals.some((value) => !(value > 0))) throw new Error("job observation intervals must be positive");
    this.intervals = intervals;
  }

  /**
   * 현재 running snapshot과 맞춘다. 정산·제거된 job과 같은 id를 재사용한 새 incarnation은 이전 관측 근거를 잇지 않는다.
   */
  sync(running: readonly unknown[]): ObservedJob[] {
    const live = new Map<string, EligibleRow>();
    for (const raw of running) {
      const row = eligible(raw);
      if (row) live.set(row.id, row);
    }
    for (const [id, job] of this.#jobs) {
      const row = live.get(id);
      if (!row || row.startTime !== job.startTime || row.type !== job.type) this.#jobs.delete(id);
    }
    const tracked: ObservedJob[] = [];
    for (const row of live.values()) {
      let job = this.#jobs.get(row.id);
      if (!job) {
        job = {
          id: row.id, type: row.type, startTime: row.startTime, label: row.label,
          inspectedAt: undefined, inspections: 0, output: undefined, step: 0, unchanged: false, notifiedDueAt: undefined,
        };
        this.#jobs.set(row.id, job);
      }
      job.label = row.label;
      tracked.push(job);
    }
    return tracked;
  }

  dueAt(job: ObservedJob): number {
    return (job.inspectedAt ?? job.startTime) + this.intervals[Math.min(job.step, this.intervals.length - 1)]!;
  }

  overdue(jobs: readonly ObservedJob[], now: number): ObservedJob[] {
    return jobs.filter((job) => this.dueAt(job) <= now);
  }

  nextDueAt(jobs: readonly ObservedJob[]): number | undefined {
    let next: number | undefined;
    for (const job of jobs) {
      if (job.notifiedDueAt === this.dueAt(job)) continue;
      const due = this.dueAt(job);
      if (next === undefined || due < next) next = due;
    }
    return next;
  }

  /**
   * 같은 incarnation의 성공한 `read proc://<id>`를 확인 근거로 기록한다. 호출 시점에 묶은 incarnation이 지금도 running이
   * 아니면(정산·같은 id 재사용) 기록하지 않는다.
   * snapshot 확인은 관측을 증명할 뿐 진행을 증명하지 않는다: 출력 변화는 주기만 넓히고, 같은 출력은 첫 주기로 되돌린다.
   */
  inspect(running: readonly unknown[], incarnation: JobIncarnation, output: string, now: number): ObservedJob | undefined {
    const job = this.sync(running).find((candidate) => candidate.id === incarnation.id);
    if (!job || job.startTime !== incarnation.startTime || job.type !== incarnation.type) return undefined;
    const tail = output.slice(-OUTPUT_COMPARE_CHARS);
    if (job.output === undefined) {
      job.step = 0;
      job.unchanged = false;
    } else if (job.output === tail) {
      job.step = 0;
      job.unchanged = true;
    } else {
      job.step = Math.min(job.step + 1, this.intervals.length - 1);
      job.unchanged = false;
    }
    job.output = tail;
    job.inspectedAt = now;
    job.inspections += 1;
    job.notifiedDueAt = undefined;
    return job;
  }

  /** 이 due 시각에 아직 알리지 않은 기한 도달 job을 고르고 알림 완료로 표시한다. 같은 due는 한 번만 알린다. */
  takeAnnouncements(jobs: readonly ObservedJob[], now: number): ObservedJob[] {
    const due: ObservedJob[] = [];
    for (const job of this.overdue(jobs, now)) {
      const at = this.dueAt(job);
      if (job.notifiedDueAt === at) continue;
      job.notifiedDueAt = at;
      due.push(job);
    }
    return due;
  }

  clear(): void {
    this.#jobs.clear();
  }
}

function minutes(ms: number): string {
  return `${Math.max(0, Math.round(ms / 60_000))}분`;
}

export function describeObservedJob(ledger: JobObservationLedger, job: ObservedJob, now: number): string {
  const label = job.label ? ` ${JSON.stringify(job.label.replace(/\s+/gu, " ").slice(0, 80))}` : "";
  const base = `${job.id}(${job.type}${label}, 실행 ${minutes(now - job.startTime)}`;
  if (job.inspectedAt === undefined) {
    return `${base}, 확인 없음, 첫 관측 기본 ${minutes(ledger.intervals[0]!)} fallback)`;
  }
  const last = `마지막 확인 ${new Date(job.inspectedAt).toISOString().slice(11, 19)}Z(${minutes(now - job.inspectedAt)} 전)`;
  if (job.unchanged) {
    return `${base}, ${last}, 직전 두 확인의 출력이 같음: 다시 기다리기 전에 외부 상태·프로세스 생존·산출물로 원인을 조사하고 확인한 상태를 보고한다. 출력 정지만으로 실패를 확정하지 않는다)`;
  }
  return `${base}, ${last}, 다음 주기 ${minutes(ledger.dueAt(job) - job.inspectedAt)})`;
}

export const OBSERVATION_CLEARING_RULE =
  "같은 job의 성공한 read proc://<id>만 이 관측 요구를 푼다. 로그 파일·gh run view 같은 다른 조회는 계속 허용되지만 요구를 풀지 않는다.";

export const OBSERVATION_SAFETY_NOTE =
  "job은 계속 실행되며 자동 취소·재시도·재발주하지 않는다. 완료 결과는 기존 전달 경로로 따로 오고 이 안내보다 먼저 처리한다. 경과 시간은 실패 근거가 아니다.";
