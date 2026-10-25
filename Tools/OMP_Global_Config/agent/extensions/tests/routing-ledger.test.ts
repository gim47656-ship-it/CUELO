import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assignTaskResultBlocks,
  assignmentsByName,
  createRoutingLedger,
  deriveRevisionRelation,
  HISTORY_WINDOW,
  pickReportRevision,
  readCrossReviewRecords,
  revisionRelationDiagnostic,
  scopedAttempts,
  summarizeHistory,
  type DispatchRecord,
  type LedgerRecord,
  type OutcomeRecord,
  type VerdictRecord,
} from "../lib/routing-ledger";

const OPUS = "anthropic/claude-opus-5-5";
const ASTRA = "openai-codex/gpt-6-astra";
const SESSION = "s1";
const OTHER_SESSION = "s2";

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
    const dir = mkdtempSync(join(tmpdir(), "routing-ledger-"));
    try {
      const path = join(dir, "nested", "routing-ledger.jsonl");
      const ledger = createRoutingLedger(path);
      expect(ledger.read()).toEqual([]);
      ledger.append(dispatch("A"));
      appendFileSync(path, "{깨진 줄\n");
      ledger.append(outcome("A", "completed"));
      expect(ledger.read()).toEqual([dispatch("A"), outcome("A", "completed")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("쓰기·읽기 실패는 던지지 않고 onError로만 알린다", () => {
    const errors: unknown[] = [];
    // 디렉터리를 파일 경로로 주면 append와 read가 모두 실패한다.
    const dir = mkdtempSync(join(tmpdir(), "routing-ledger-dir-"));
    try {
      const ledger = createRoutingLedger(dir, (error) => errors.push(error));
      expect(ledger.append(dispatch("A"))).toBe(false);
      expect(ledger.read()).toEqual([]);
      expect(errors.length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe("소유권 복원", () => {
  test("관측 spawn dispatch의 소유 계약만 attempt별로 복원하고 과거·손상 row는 미상(null)으로 둔다", () => {
    const ownership = { primaryDeliverable: "표시 오류 수정", ownedPaths: ["src/view.ts"], workspace: "shared" as const };
    const records: LedgerRecord[] = [
      dispatch("New", { ownership }),
      // FINDING_ID 재작업은 같은 assignment의 다음 attempt이며 원 계약을 그대로 잇는다.
      dispatch("New", { ...ids("New", 2), ownership }),
      outcome("New", "completed", ids("New", 2)),
      // 이 변경 전 기록은 ownership 필드가 없다. 빈 소유로 바꾸지 않는다.
      dispatch("Legacy"),
      dispatch("Broken", { ownership: { primaryDeliverable: "x", ownedPaths: "src/", workspace: "shared" } as never }),
      dispatch("Other", { ...ids("Other"), sessionId: OTHER_SESSION, ownership }),
    ];
    const restored = scopedAttempts(records, SESSION);
    expect(restored.map((entry) => [entry.identity.attemptId, entry.status, entry.ownership])).toEqual([
      ["s1#New#a1", "running", ownership],
      ["s1#New#a2", "completed", ownership],
      ["s1#Legacy#a1", "running", null],
      ["s1#Broken#a1", "running", null],
    ]);
  });
});

describe("교차검증 기록", () => {
  test("같은 파일에 남아도 이력 read()에는 섞이지 않고 전용 읽기는 꼬리 밖 기록까지 찾는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "routing-ledger-xr-"));
    try {
      const path = join(dir, "routing-ledger.jsonl");
      const ledger = createRoutingLedger(path);
      const waiver = { type: "cross-review-waiver" as const, ts: "2026-10-11T00:00:00.000Z", root: "/r", reason: "user said so", files: [] };
      expect(ledger.append(waiver)).toBe(true);
      for (let index = 0; index < 1500; index++) ledger.append(dispatch(`pad${index}`, { name: "x".repeat(700) }));
      expect(ledger.read().every((record) => record.type === "dispatch")).toBe(true);
      expect(ledger.read().length).toBeLessThan(1501); // 오래된 waiver가 있던 앞부분은 꼬리 창 밖이다
      expect(readCrossReviewRecords(path)).toEqual([waiver]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 아래 입력은 2026-10-25 원장의 실제 revision 모양이다(doc/history/2026/10/25-harness-gaps/maker-RevisionRelationCause.md).
describe("deriveRevisionRelation", () => {
  const SHA = "0e7fa41a164a555f6b70cc40db9290639e7cad5a";
  const relate = (sourceRevision: string | null, revision: string | null, integratedFrom?: string) =>
    deriveRevisionRelation({ sourceRevision, revision, integratedFrom });

  test("같은 commit을 가리키면 짧은 id·꼬리말·대소문자가 달라도 same이다", () => {
    expect(relate(`${SHA} (audited HEAD; report untracked)`, SHA)).toMatchObject({ relation: "same", cause: "same-commit" });
    expect(relate("29434c1 (워킹트리 clean, 읽기 전용 조사)", "29434c1")).toMatchObject({ relation: "same" });
    expect(relate("working tree on HEAD 33ec7de5 (uncommitted)", "Working-Tree on 33EC7DE5 + docs")).toMatchObject({ relation: "same" });
    expect(relate("r1  frozen", "R1 Frozen")).toMatchObject({ relation: "same", cause: "exact" });
  });

  test("commit이 다르거나 작업 트리 여부가 다르면 같다고 추정하지 않는다", () => {
    // Maker는 작업 트리, Main은 base commit 자체를 검수했다: 변경분을 검수했는지 알 수 없다.
    expect(relate("uncommitted working tree on base HEAD 247d237e589a1200071fd1d48dc293120f79822f", "247d237e589a1200071fd1d48dc293120f79822f + final evidence/ui.diff"))
      .toMatchObject({ relation: "mismatch", cause: "unlinked" });
    expect(relate("working tree (uncommitted)", "a7ed2ef+runtime186-artifact138")).toMatchObject({ relation: "mismatch" });
    expect(relate("abc1234", "def5678")).toMatchObject({ relation: "mismatch" });
  });

  test("mismatch는 그대로 넘길 integratedFrom을 알려 주고, 그 값을 넘기면 integrated가 된다", () => {
    const source = "working tree (uncommitted), 2026-10-04 KYS";
    const first = relate(source, "c19007b449cd73eca7beb73747aad6f2ef33e49d");
    expect(first).toMatchObject({ relation: "mismatch", cause: "unlinked", integratedFromHint: source });
    expect(relate(source, "c19007b449cd73eca7beb73747aad6f2ef33e49d", first.integratedFromHint)).toMatchObject({ relation: "integrated", cause: "linked" });
    // 긴 원 revision은 commit id로 줄여 준다. 그 값도 연결된다.
    const long = `base HEAD cfb28c03299515001ac2299fc51e04d8d3c5469d + ${"x".repeat(300)}`;
    const hint = relate(long, "a6b0a31").integratedFromHint!;
    expect(hint).toBe("cfb28c03299515001ac2299fc51e04d8d3c5469d");
    expect(relate(long, "a6b0a31", hint)).toMatchObject({ relation: "integrated" });
  });

  test("integratedFrom은 원 revision의 앞부분(8자 이상)이나 같은 commit이면 이어진다. 엉뚱한 값은 link-mismatch다", () => {
    expect(relate("working-tree-wave1-r1 (uncommitted, on top of 33ec7de5)", "05cd2fac5926388d", "working-tree-wave1-r1")).toMatchObject({ relation: "integrated" });
    expect(relate("uncommitted working tree on HEAD 33ec7de5 (Main commits)", "a8fd3d569f76", "working tree on HEAD 33ec7de5 (uncommitted)")).toMatchObject({ relation: "integrated" });
    expect(relate("uncommitted working tree on top of 33ec7de5", "3f432ef7", "uncommitted working tree on top of 0c50bb05 (nothing committed)"))
      .toMatchObject({ relation: "mismatch", cause: "link-mismatch" });
    expect(relate("r1 frozen diff", "r2 final", "r1")).toMatchObject({ relation: "mismatch", cause: "link-mismatch" }); // 8자 미만 앞부분은 연결로 보지 않는다
  });

  test("명시한 integratedFrom은 같은 commit 추정보다 우선한다(문자열이 똑같을 때만 same)", () => {
    expect(relate("working tree on 33ec7de5 (uncommitted)", "working tree on 33ec7de5 + docs", "working tree on 33ec7de5 (uncommitted)"))
      .toMatchObject({ relation: "integrated", cause: "linked" });
    expect(relate("r1 frozen", "r1 frozen", "r1 frozen")).toMatchObject({ relation: "same", cause: "exact" });
  });

  test("숫자만·글자만인 짧은 해시도 긴 해시와 앞부분이 맞으면 같은 commit이다. 날짜·숫자 둘뿐은 commit이 아니다", () => {
    expect(relate("1234567 (clean)", "1234567abcdef0123456789abcdef0123456789a")).toMatchObject({ relation: "same", cause: "same-commit" });
    expect(relate("1234567abcdef0123456789abcdef0123456789a + docs", "1234567")).toMatchObject({ relation: "same" });
    expect(relate("deadbee (audited)", "deadbeef1234567890abcdef1234567890abcdef")).toMatchObject({ relation: "same" });
    expect(relate("deadbeef1234567890abcdef1234567890abcdef", "deadbee + docs")).toMatchObject({ relation: "same" });
    // 날짜 모양(YYYYMMDD)은 긴 해시와 앞부분이 맞아도 commit id가 아니다.
    expect(relate("report 20261025", "20261025ab34cd56ef78")).toMatchObject({ relation: "mismatch" });
    expect(relate("20261025", "2026102512ab34cd56ef")).toMatchObject({ relation: "mismatch" });
    // 짧은 해시가 아닌 숫자(byte 수 등)나 단어끼리는 서로 같은 commit 증거가 되지 않는다.
    expect(relate("r1 size 1234567 bytes", "r2 size 1234567 bytes")).toMatchObject({ relation: "mismatch" });
    expect(relate("1234567", "1234568")).toMatchObject({ relation: "mismatch" });
    // 시각이 오후(20~23시)인 YYYYMMDDHHMMSS도 날짜 모양이다.
    expect(relate("build 20260315213000", "commit 20260315213000abcdef")).toMatchObject({ relation: "mismatch" });
  });

  test("원 revision 미관측과 검수 revision 없음은 unknown이다", () => {
    expect(relate(null, "r1")).toMatchObject({ relation: "unknown", cause: "source-unobserved" });
    expect(relate("  ", "r1")).toMatchObject({ relation: "unknown", cause: "source-unobserved" });
    expect(relate("r1", null)).toMatchObject({ relation: "unknown", cause: "no-review-revision" });
  });
});

describe("revisionRelationDiagnostic", () => {
  const diagnose = (sourceRevision: string | null, revision: string | null, integratedFrom?: string, attempt?: number) => {
    const result = deriveRevisionRelation({ sourceRevision, revision, integratedFrom });
    return revisionRelationDiagnostic(result, { sourceRevision, revision, integratedFrom, attempt });
  };

  test("mismatch 진단은 관측한 원 revision과 넘길 integratedFrom 값을 그대로 담는다", () => {
    const unlinked = diagnose("working tree (uncommitted), 2026-10-04 KYS", "c19007b4");
    expect(unlinked).toContain("integratedFrom='working tree (uncommitted), 2026-10-04 KYS'");
    expect(unlinked).toContain("c19007b4");
    const wrong = diagnose("r1 (uncommitted)", "r2", "r0");
    expect(wrong).toContain("integratedFrom 'r0'");
    expect(wrong).toContain("integratedFrom='r1 (uncommitted)'");
  });

  test("unknown은 원 revision이 미관측일 때만, 연속 attempt면 prose 가능성을 덧붙여 설명한다", () => {
    expect(diagnose(null, "r1")).toContain("미관측");
    expect(diagnose(null, "r1")).not.toContain("재작업");
    expect(diagnose(null, "r1", undefined, 2)).toContain("재작업");
    expect(diagnose(null, null)).toBeUndefined(); // held처럼 검수 revision이 없으면 설명하지 않는다
    expect(diagnose("r1", "r1")).toBeUndefined();
    expect(diagnose("r1 frozen", "r2", "r1 frozen")).toBeUndefined();
  });
});

describe("pickReportRevision", () => {
  test("최상위 revision 문자열이 우선이고 앞뒤 공백은 자른다", () => {
    expect(pickReportRevision({ revision: "  r2 ", sourceRevision: "r1" })).toBe("r2");
  });

  test("object revision은 id·commit 같은 대표 필드를, 없으면 압축 JSON을 쓴다", () => {
    expect(pickReportRevision({ revision: { id: "r2", base_head: "65713d17" } })).toBe("r2");
    expect(pickReportRevision({ revision: { kind: "working-tree", base_head: "cfb28c03" } })).toBe("cfb28c03");
    expect(pickReportRevision({ revision: { kind: "working-tree" } })).toBe('{"kind":"working-tree"}');
    expect(pickReportRevision({ revision: {} })).toBeUndefined();
  });

  test("revision object의 대표 필드가 없고 뜻이 다른 *_revision만 있으면 압축 JSON으로 읽지 않고 별칭을 쓴다", () => {
    expect(pickReportRevision({ revision: { alembic_revision: "abc1234" }, sourceRevision: "def5678" })).toBe("def5678");
    expect(pickReportRevision({ revision: { alembic_revision: "abc1234" }, source_revision: "def5678" })).toBe("def5678");
    expect(pickReportRevision({ revision: { alembic_revision: "abc1234" } })).toBeUndefined();
    // 대표 필드가 있으면 별칭보다 우선(대소문자 무시), 둘 다 없고 *_revision도 없을 때만 압축 JSON.
    expect(pickReportRevision({ revision: { HEAD: "76a280c", dirty: ["a.ts"] }, sourceRevision: "def5678" })).toBe("76a280c");
    expect(pickReportRevision({ revision: { files: { "a.ts": "c31e68c9" } }, sourceRevision: "def5678" })).toBe("def5678");
    expect(pickReportRevision({ revision: { files: { "a.ts": "c31e68c9" } } })).toBe('{"files":{"a.ts":"c31e68c9"}}');
  });

  test("sourceRevision·source_revision 별칭은 읽지만 뜻이 다른 *_revision은 읽지 않는다", () => {
    expect(pickReportRevision({ sourceRevision: "r1 (uncommitted)" })).toBe("r1 (uncommitted)");
    expect(pickReportRevision({ source_revision: "abc1234" })).toBe("abc1234");
    expect(pickReportRevision({ alembic_revision: "0123abcd", scalar_revision: "x", revision_fingerprint: "y" })).toBeUndefined();
    expect(pickReportRevision({ revision: 3, summary: "r1" })).toBeUndefined();
  });
});

describe("assignTaskResultBlocks", () => {
  const block = (id: string) => `<task-result id="${id}" agent="maker" status="completed">{"revision":"${id}-rev"}</task-result>`;

  test("블록 없는 재개 job이 앞에 있어도 각 job은 자기 id의 블록을 받는다(순서 짝짓기 오류 회귀)", () => {
    // 실제 사례: jobs=[RecoveryBoundaryReview-2(prose, 블록 없음), MakerEvalReview], blocks=[MakerEvalReview]
    const assigned = assignTaskResultBlocks([block("MakerEvalReview")], [
      { jobId: "RecoveryBoundaryReview-2", label: "RecoveryBoundaryReview" },
      { jobId: "MakerEvalReview", label: "MakerEvalReview" },
    ]);
    expect(assigned[0]).toBeUndefined();
    expect(assigned[1]).toContain("MakerEvalReview-rev");
  });

  test("jobId가 -2처럼 바뀌어도 label·agentId로 맞추고, 블록은 한 job만 소비한다", () => {
    const assigned = assignTaskResultBlocks([block("ContractAudit")], [
      { jobId: "ContractAudit-2", agentId: "ContractAudit" },
      { jobId: "ContractAudit-3", label: "ContractAudit" },
    ]);
    expect(assigned.filter(Boolean)).toHaveLength(1);
    expect(assigned[0]).toContain("ContractAudit-rev");
  });

  test("id로 맞은 job이 있어도 못 맞춘 job은 id로 소비되지 않은 블록을 순서대로 받는다", () => {
    const noId = `<task-result agent="maker" status="completed">{"revision":"second-rev"}</task-result>`;
    const assigned = assignTaskResultBlocks([block("A"), noId], [{ jobId: "A" }, { jobId: "B" }]);
    expect(assigned[0]).toContain("A-rev");
    expect(assigned[1]).toBe(noId);
    // id로 소비된 블록은 다른 job에 다시 주지 않는다.
    expect(assignTaskResultBlocks([block("A")], [{ jobId: "B" }, { jobId: "A" }])).toEqual([undefined, block("A")]);
  });

  test("어느 job과도 id가 맞지 않으면 기존처럼 순서로 짝짓는다", () => {
    const assigned = assignTaskResultBlocks([block("a"), block("b")], [{ jobId: "x" }, { jobId: "y" }]);
    expect(assigned[0]).toContain("a-rev");
    expect(assigned[1]).toContain("b-rev");
  });
});
