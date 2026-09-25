import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assignmentsByName,
  createRoutingLedger,
  HISTORY_WINDOW,
  summarizeHistory,
  type DispatchRecord,
  type LedgerRecord,
  type OutcomeRecord,
  type VerdictRecord,
} from "../lib/routing-ledger";

const OPUS = "anthropic/claude-opus-5-5";
const ASTRA = "openai-codex/gpt-6-astra";
const SESSION = "s1";

/** 결정적 identity. 재작업은 같은 assignmentId를 유지하고 attempt만 올린다. */
const ids = (assignment: string, attempt = 1) => {
  const assignmentId = `${SESSION}#${assignment}`;
  return {
    sessionId: SESSION, assignmentId, attempt, attemptId: `${assignmentId}#a${attempt}`,
    agentId: `agent-${assignment}`, jobId: `job-${assignment}`,
  };
};
const dispatch = (assignment: string, overrides: Partial<DispatchRecord> = {}): DispatchRecord => ({
  type: "dispatch", ts: "2026-09-24T00:00:00.000Z", name: assignment, workClass: "HARD", focus: "CODE_SYSTEM",
  recommendedProfile: "HARD_CODE_SYSTEM", recommendedModel: OPUS, recommendedEffort: "high",
  chosenModel: OPUS, chosenEffort: "high", routingReason: false, purpose: "primary",
  ...ids(assignment), ...overrides,
});
const outcome = (assignment: string, status: OutcomeRecord["status"], overrides: Partial<OutcomeRecord> = {}): OutcomeRecord => ({
  type: "outcome", ts: "2026-09-24T00:10:00.000Z", status, durationSec: 600,
  ...ids(assignment), ...overrides,
});
const verdict = (assignment: string, value: VerdictRecord["verdict"], overrides: Partial<VerdictRecord> = {}): VerdictRecord => ({
  type: "verdict", ts: "2026-09-24T00:20:00.000Z", verdict: value,
  revision: value === "held" ? null : "rev-1",
  evidenceLocators: value === "held" ? [] : ["artifact://evidence"],
  reason: "Main 판정 근거",
  ...ids(assignment), ...overrides,
});
const switchedTo = (assignment: string, model = ASTRA, effort = "high") =>
  dispatch(assignment, { chosenModel: model, chosenEffort: effort, routingReason: true });

describe("routing ledger 파일", () => {
  test("append한 기록을 순서대로 읽고 깨진 줄은 건너뛴다", () => {
    const path = join(mkdtempSync(join(tmpdir(), "routing-ledger-")), "nested", "routing-ledger.jsonl");
    const ledger = createRoutingLedger(path);
    expect(ledger.read()).toEqual([]);
    ledger.append(dispatch("A"));
    appendFileSync(path, "{깨진 줄\n");
    ledger.append(outcome("A", "completed"));
    expect(ledger.read()).toEqual([dispatch("A"), outcome("A", "completed")]);
  });
  test("쓰기·읽기 실패는 던지지 않고 onError로만 알린다", () => {
    const errors: unknown[] = [];
    // 디렉터리를 파일 경로로 주면 append와 read가 모두 실패한다.
    const ledger = createRoutingLedger(mkdtempSync(join(tmpdir(), "routing-ledger-dir-")), (error) => errors.push(error));
    expect(ledger.append(dispatch("A"))).toBe(false);
    expect(ledger.read()).toEqual([]);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});

describe("history 요약", () => {
  test("동명 assignment가 여럿이면 이름만으로 재발주 대상을 고르지 않는다", () => {
    const records = [
      dispatch("A", { name: "Fix" }),
      dispatch("A", { name: "Fix", ...ids("A", 2) }),
      dispatch("B", { name: "Fix" }),
      dispatch("A", { name: "Fix", ...ids("A", 3) }),
      dispatch("Only", { ...ids("Only", 2) }),
    ];
    expect([...assignmentsByName(records, SESSION)])
      .toEqual([["Only", { assignmentId: "s1#Only", lastAttempt: 2 }]]);
  });
  test("identity로 묶고 실행 상태와 Main 명시 판정을 ok·rework·held·pending·aborted로 나누며 identity 없는 기록은 제외한다", () => {
    const records: LedgerRecord[] = [
      dispatch("Ok"), outcome("Ok", "completed"), verdict("Ok", "accepted"),
      // 완료만으로는 성공이 아니다. 명시 판정이 없으면 대기다.
      dispatch("Unjudged"), outcome("Unjudged", "completed"),
      dispatch("Held"), outcome("Held", "completed"), verdict("Held", "held"),
      // 운영 실패·취소는 Main이 구현 결함을 evidence와 함께 판정하기 전까지 품질 실패가 아니다.
      dispatch("Operational"), outcome("Operational", "failed"),
      dispatch("Cancelled"), outcome("Cancelled", "cancelled"),
      // 운영 실패에 Main이 재작업을 명시하면 품질 실패로 센다.
      dispatch("OperationalRework"), outcome("OperationalRework", "failed"), verdict("OperationalRework", "rework"),
      // 같은 assignment의 attempt 1은 재작업, attempt 2는 추천대로 수용. 원 attempt의 귀속은 지워지지 않는다.
      dispatch("Two", { chosenModel: ASTRA }), outcome("Two", "completed"), verdict("Two", "rework"),
      dispatch("Two", { ...ids("Two", 2) }),
      outcome("Two", "completed", { ...ids("Two", 2) }),
      verdict("Two", "accepted", { ...ids("Two", 2) }),
      // 완료가 관측되지 않은 attempt의 수용은 성공으로 세지 않고 대기로 남는다.
      dispatch("Early"), verdict("Early", "accepted"),
      // 실행 중이며 판정 전인 대체는 pending이다.
      switchedTo("Running", ASTRA, "xhigh"),
      // 범위 밖: 다른 분야·다른 등급·추천 없음.
      dispatch("Ui", { focus: "UI_UX", recommendedProfile: "HARD_UI_UX" }), outcome("Ui", "completed"),
      dispatch("Normal", { workClass: "NORMAL", focus: null }), outcome("Normal", "failed"),
      dispatch("NoJev", { recommendedModel: null, recommendedEffort: null, recommendedProfile: null }),
      // identity가 없는 과거 name-only 기록은 버리지 않고 집계에서만 제외한다.
      { ...dispatch("Legacy"), sessionId: "", assignmentId: "", attemptId: "", agentId: "", jobId: "" },
      // dispatch 없는 outcome은 어느 attempt에도 붙지 않는다.
      outcome("Ghost", "failed"),
    ];
    const history = summarizeHistory(records, "HARD", "CODE_SYSTEM");
    expect(history).toEqual({
      workClass: "HARD", focus: "CODE_SYSTEM", attempts: 10, unobserved: 1,
      followed: { ok: 2, rework: 1, held: 1, pending: 2, aborted: 2 },
      switched: {
        [`${ASTRA}:high`]: { ok: 0, rework: 1, held: 0, pending: 0, aborted: 0 },
        [`${ASTRA}:xhigh`]: { ok: 0, rework: 0, held: 0, pending: 1, aborted: 0 },
      },
      observation: expect.any(String),
    });
    // NORMAL은 분야를 가르지 않는다.
    expect(summarizeHistory(records, "NORMAL", null)).toMatchObject({
      attempts: 1, unobserved: 0, followed: { ok: 0, rework: 0, held: 0, pending: 0, aborted: 1 },
    });
  });

  test("우열 제안 없이 관측 건수와 불확실성만 적고 창은 최근 attempt만 본다", () => {
    const old = Array.from({ length: HISTORY_WINDOW }, (_, index) =>
      [dispatch(`Old${index}`), outcome(`Old${index}`, "failed")]).flat();
    const recent = [dispatch("New"), outcome("New", "completed"), verdict("New", "accepted")];
    const history = summarizeHistory([...old, ...recent], "HARD", "CODE_SYSTEM");
    expect(history.attempts).toBe(HISTORY_WINDOW);
    // 창 밖으로 밀린 가장 오래된 attempt는 빠지고 나머지 운영 중단과 최근 수용만 남는다.
    expect(history.followed).toEqual({ ok: 1, rework: 0, held: 0, pending: 0, aborted: HISTORY_WINDOW - 1 });

    // 대체 3/3 대 추천 0/1이어도 우열을 선언하지 않는다: 대체 버킷에 그대로 귀속될 뿐 자동 변경은 없다.
    const skewed = summarizeHistory([
      dispatch("F0"), outcome("F0", "completed"), verdict("F0", "rework"),
      ...["S0", "S1", "S2"].flatMap((name) => [switchedTo(name), outcome(name, "completed"), verdict(name, "accepted")]),
    ], "HARD", "CODE_SYSTEM");
    expect(skewed.followed).toEqual({ ok: 0, rework: 1, held: 0, pending: 0, aborted: 0 });
    expect(skewed.switched[`${ASTRA}:high`]).toEqual({ ok: 3, rework: 0, held: 0, pending: 0, aborted: 0 });

    // 기록이 없으면 안내도 없다.
    expect(summarizeHistory([], "HARD", "CODE_SYSTEM").observation).toBeNull();
  });
});
