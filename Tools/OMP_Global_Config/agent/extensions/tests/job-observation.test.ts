import { describe, expect, test } from "bun:test";

import { describeObservedJob, JobObservationLedger } from "../lib/job-observation";

const MIN = 60_000;
const bash = (id: string, startTime: number, extra: Record<string, unknown> = {}) =>
  ({ id, type: "bash", status: "running", label: `watch ${id}`, startTime, ...extra });
const incarnation = (id: string, startTime: number) => ({ id, type: "bash" as const, startTime });
// 기한 계산 원리를 보는 아래 테스트는 기본 주기와 무관하게 짧은 주기를 직접 준다.
const FIVE_TEN_FIFTEEN = [5 * MIN, 10 * MIN, 15 * MIN];

describe("장기 job 관측 원장", () => {
  // 2026-10-28 감사: 5분 기한 알림을 받은 job의 68%가 10분 전에 끝나 첫 기한을 10분, 넓힌 주기를 15·30분으로 바꿨다.
  test("첫 관측은 10분 fallback, 출력이 바뀐 확인만 15·30분으로 넓히고 같은 출력은 10분으로 되돌린다", () => {
    const ledger = new JobObservationLedger();
    const running = [bash("bg_1", 0)];
    const [job] = ledger.sync(running);
    expect(ledger.dueAt(job!)).toBe(10 * MIN);
    expect(ledger.overdue([job!], 10 * MIN - 1)).toEqual([]);
    expect(ledger.overdue([job!], 10 * MIN)).toEqual([job!]);

    // 첫 확인은 비교 기준만 세운다.
    ledger.inspect(running, job!, "step 1", 10 * MIN);
    expect(ledger.dueAt(job!)).toBe(20 * MIN);
    ledger.inspect(running, job!, "step 2", 20 * MIN);
    expect(ledger.dueAt(job!)).toBe(35 * MIN);
    ledger.inspect(running, job!, "step 3", 35 * MIN);
    expect(ledger.dueAt(job!)).toBe(65 * MIN);
    ledger.inspect(running, job!, "step 4", 65 * MIN);
    expect(ledger.dueAt(job!)).toBe(95 * MIN);

    ledger.inspect(running, job!, "step 4", 95 * MIN);
    expect(job!.unchanged).toBe(true);
    expect(ledger.dueAt(job!)).toBe(105 * MIN);
    expect(describeObservedJob(ledger, job!, 105 * MIN)).toContain("원인을 조사");

    ledger.inspect(running, job!, "step 5", 105 * MIN);
    expect(job!.unchanged).toBe(false);
    expect(ledger.dueAt(job!)).toBe(120 * MIN);
  });

  test("task·agent-backed·정산된·시작 시각 없는 행은 관측 대상이 아니다", () => {
    const ledger = new JobObservationLedger();
    const tracked = ledger.sync([
      { id: "Maker", type: "task", status: "running", startTime: 0, agentId: "Maker" },
      bash("bg_agent", 0, { agentId: "Child" }),
      bash("bg_done", 0, { status: "completed" }),
      { id: "bg_nostart", type: "bash", status: "running" },
      { id: "ev_1", type: "eval", status: "running", startTime: 0 },
    ]);
    expect(tracked.map((job) => job.id)).toEqual(["ev_1"]);
    expect(ledger.inspect([bash("bg_done", 0, { status: "completed" })], incarnation("bg_done", 0), "x", MIN)).toBeUndefined();
  });

  test("같은 id를 재사용한 새 incarnation은 이전 확인 근거를 잇지 않고, 이전 incarnation에 묶인 늦은 확인도 받지 않는다", () => {
    const ledger = new JobObservationLedger(FIVE_TEN_FIFTEEN);
    ledger.inspect([bash("bg_1", 0)], incarnation("bg_1", 0), "old run", 4 * MIN);
    const [fresh] = ledger.sync([bash("bg_1", 6 * MIN)]);
    expect(fresh!.inspectedAt).toBeUndefined();
    expect(fresh!.output).toBeUndefined();
    expect(ledger.dueAt(fresh!)).toBe(11 * MIN);

    expect(ledger.inspect([bash("bg_1", 6 * MIN)], incarnation("bg_1", 0), "late old read", 12 * MIN)).toBeUndefined();
    expect(fresh!.inspectedAt).toBeUndefined();
    expect(ledger.overdue([fresh!], 12 * MIN)).toEqual([fresh!]);
  });

  test("기한 알림은 같은 due에 한 번이고, 새 확인 뒤의 다음 due에서만 다시 알린다", () => {
    const ledger = new JobObservationLedger(FIVE_TEN_FIFTEEN);
    const running = [bash("bg_1", 0), bash("bg_2", MIN)];
    const tracked = ledger.sync(running);
    expect(ledger.takeAnnouncements(tracked, 5 * MIN).map((job) => job.id)).toEqual(["bg_1"]);
    expect(ledger.takeAnnouncements(tracked, 5 * MIN + 1)).toEqual([]);
    expect(ledger.nextDueAt(tracked)).toBe(6 * MIN);
    expect(ledger.takeAnnouncements(tracked, 6 * MIN).map((job) => job.id)).toEqual(["bg_2"]);
    expect(ledger.nextDueAt(tracked)).toBeUndefined();

    ledger.inspect(running, tracked[0]!, "progress", 7 * MIN);
    expect(ledger.takeAnnouncements(ledger.sync(running), 12 * MIN).map((job) => job.id)).toEqual(["bg_1"]);
  });
});
