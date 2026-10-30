import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHandoff } from "./handoff.ts";

const NOW = new Date("2026-10-30T12:00:00Z");
const parse = (body) => parseHandoff(`## 관찰 대기\n${body}`, "HANDOFF.md", NOW);

test("dates in titles and forward cues become due dates", () => {
  const items = parseHandoff([
    "## 다음 행동",
    "- **11-02 후속 점검:** 10-26 측정과 종료한 항목의 근거는 기록에 있다.",
    "  - RAG 회상: 게이트·하한은 유지한다.",
    "- **하네스 보강 관찰(0.10.90, 11-09 점검):** 2주 뒤 원장을 본다.",
    "- **11-01 닫기 판정:**",
    "- **낡은 기억 정기 점검(다음은 11월 하순):** 10-23에 정리했다.",
  ].join("\n"), "HANDOFF.md", NOW);
  assert.deepEqual(items.map((x) => x.dueDate), ["2026-11-02", "2026-11-09", "2026-11-01", "2026-11-25"]);
  assert.match(items[0].ref.text, /RAG 회상/);
});

test("past dates mentioned in the body are not due dates", () => {
  // 실제 HANDOFF 문장: 「10-28 기준 OPEN」은 관측 시점이지 점검일이 아니다.
  const [item] = parse("- **computer 클래식 Win32 조작(10-21):** `20c81dcf`부터 가린 라디오 단일 클릭은 다시 백그라운드로 보낸다(10-28 기준 OPEN·미병합). 수정이 든 첫 릴리스로 올릴 때 재측정한다.");
  assert.notEqual(item.dueDate, "2026-10-28");
  assert.equal(item.overdue, false);
});

test("a later re-count cue wins over the title date", () => {
  const [item] = parse("- **가드·CI 축소(10-28, 사용자 승인):** 10-28에 게시·배포했다. 11-04쯤 감사 분석기로 advisory 발동 수를 다시 센다.");
  assert.equal(item.dueDate, "2026-11-04");
});

test("deploy-relative phrasings use the title date plus seven days", () => {
  const items = parse([
    "- **Terra 기본 Maker 관찰(10-30):** 배포 뒤 7일 동안 Terra Maker 발주 수를 센다.",
    "- **통역 자리 관찰(10-30):** 배포 후 7일간 세션 로그에서 확인한다.",
    "- **Maker 토큰 절감(10-29):** 배포 7일 뒤 비교한다.",
  ].join("\n"));
  assert.deepEqual(items.map((x) => [x.dueKind, x.dueDate]), [
    ["after-deploy", "2026-11-06"],
    ["after-deploy", "2026-11-06"],
    ["after-deploy", "2026-11-05"],
  ]);
});

test("conditional items have no date and are never overdue", () => {
  const [item] = parse("- **CI 첫 SSE 기한 초과:** 3000ms 기한 초과가 재발하면 원인을 단정하기 전에 상태를 읽는다.");
  assert.equal(item.dueKind, "condition");
  assert.equal(item.dueDate, null);
  assert.equal(item.overdue, false);
});

test("a conditional item stays undated even when its body names a cue date", () => {
  const [item] = parse("- **조건부 점검(10-20):** 재발하면 10-25까지 점검한다.");
  assert.equal(item.dueKind, "condition");
  assert.equal(item.overdue, false);
});

test("a re-count cue does not reach back across a sentence end", () => {
  for (const end of [".", "!", "?"]) {
    const [item] = parse(`- **관찰(10-30):** 10-31에 작업 완료${end} 11-02에 다시 센다.`);
    assert.equal(item.dueDate, "2026-11-02", end);
  }
});

test("an alert condition phrased with 때만 keeps the item's date", () => {
  const [item] = parse("- **관찰(10-30):** 11-02에 다시 센다. 실패할 때만 알린다.");
  assert.equal(item.dueKind, "date");
  assert.equal(item.dueDate, "2026-11-02");
  const [later] = parse("- **관찰(10-30):** 다음은 11월 중순에 다시 본다. 실패할 때만 알린다.");
  assert.deepEqual([later.dueKind, later.dueDate], ["date", "2026-11-15"]);
});

test("a conditional item with a due date in its title follows the title, not an earlier body date", () => {
  const [item] = parse("- **11-02 닫기 판정:** 재발하면 10-25까지 점검한다.");
  assert.equal(item.dueDate, "2026-11-02");
});

test("a past cue date is overdue", () => {
  const [item] = parseHandoff("## 관찰 대기\n- **11-02 닫기 판정:** 확인", "HANDOFF.md", new Date("2026-11-05T00:00:00Z"));
  assert.equal(item.overdue, true);
});
