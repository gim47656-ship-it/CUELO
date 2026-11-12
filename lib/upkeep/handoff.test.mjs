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

test("a date in link text is a record name, and 다음 점검일 names the due date", () => {
  // 실제 HANDOFF 문장(instabox, 11-02): 링크 「11-01 점검·발급 기록」을 점검일로 읽은 오탐.
  const [item] = parseHandoff("## 관찰 대기\n- **instabox:** 토큰을 새로 받아 11-09 낮 만료로 추정한다. 다음 점검일은 사무실 토큰 만료 전인 11-09다. 새 토큰은 대시보드에서 만든다([11-01 점검·발급 기록](doc/history/2026/11/01-instabox-token-check/main.md)).", "HANDOFF.md", new Date("2026-11-02T08:00:00Z"));
  assert.equal(item.dueDate, "2026-11-09");
  assert.equal(item.overdue, false);
});

test("an explicit 다음 점검일 replaces earlier body cues that record a past check", () => {
  // 실제 HANDOFF 문장(11-13 보수 점검): 「11-12 점검에서」를 기한으로 읽어 「11-18 점검」 항목을 기한 지남으로 보고했다.
  const [item] = parseHandoff("## 다음 행동\n- **검색 노출 등록(11-04 등록, 11-18 점검):** 11-12 점검에서 Search Console 「페이지」는 색인 수가 없었다. 다음 점검일은 11-18: 색인 수가 0보다 크면 닫는다.", "HANDOFF.md", new Date("2026-11-12T16:00:00Z"));
  assert.deepEqual([item.dueDate, item.overdue], ["2026-11-18", false]);
});

test("a title that names an observation or confirmation date is a due date", () => {
  // 실제 HANDOFF 제목(11-08): 「11-10 실사용 관찰」·「11-02, 11-09 확인」을 점검일로 읽지 못해 기한이 비었다.
  const items = parseHandoff([
    "## 다음 행동",
    "- **Codex 공백 스트림 복구(11-10 실사용 관찰):** 같은 오류가 복구되는지 확인한다.",
    "- **전체 슬롭 체계 보강(11-02, 11-09 확인):** 적용 사례를 대조한다.",
    "- **draft 작성 범위 관찰(11-12 확인):** 안내가 나오는지 본다.",
  ].join("\n"), "HANDOFF.md", new Date("2026-11-08T12:00:00Z"));
  assert.deepEqual(items.map((x) => [x.dueKind, x.dueDate]), [
    ["date", "2026-11-10"],
    ["date", "2026-11-09"],
    ["date", "2026-11-12"],
  ]);
});

test("registration, completion and deploy dates in a title stay record dates", () => {
  // 「11-04 등록」·「11-05 완료」·「11-06 배포」는 그날 한 일이지 확인 행위가 아니다.
  const items = parse("- **검색 노출 등록(11-04 등록, 11-13 재확인 예정):** 사이트맵을 제출했다.\n- **릴리스 정리(11-05 완료):** 끝났다.\n- **배포 점검(11-06 배포):** 나갔다.");
  assert.deepEqual(items.map((x) => [x.dueKind, x.dueDate]), [
    ["date", "2026-11-13"],
    ["none", null],
    ["none", null],
  ]);
});

test("a cue that names a finished check is a record date, not a due date", () => {
  // 교차 검토 R1-ANT-5: 「11-05 확인 완료」는 그날 한 일이다.
  const [item] = parse("- **릴리스 정리(11-05 확인 완료):** 끝났다.");
  assert.deepEqual([item.dueKind, item.dueDate, item.overdue], ["none", null, false]);
});

test("a new cue followed by a predicate is a finished record, not a remaining due date", () => {
  // 교차 검토 R2-ANT-3·R3-ANT-1: 새로 더한 확인·관찰 단서 뒤에 서술어가 붙으면 그날 한 일이다.
  // 「점검을 마쳤다」는 기존 점검 단서라 이번 변경 전후 판정이 같다(범위 밖).
  const items = parse([
    "- **A(11-05 확인했다):** 끝났다.",
    "- **B(11-05 확인함):** 끝났다.",
    "- **E(11-05 확인됐다):** 끝났다.",
    "- **F(11-05 확인되었다):** 끝났다.",
    "- **G(11-05 관찰됐다):** 끝났다.",
    "- **D(11-05 확인):** 남은 확인이다.",
    "- **H(11-05 관찰):** 남은 관찰이다.",
  ].join("\n"));
  assert.deepEqual(items.map((x) => [x.dueKind, x.dueDate]), [
    ["none", null], ["none", null], ["none", null], ["none", null], ["none", null],
    ["date", "2026-11-05"], ["date", "2026-11-05"],
  ]);
});

test("the existing check cues keep their judgement while the new cues need a label position", () => {
  // 교차 검토 R4-ANT-1: 새 단서를 좁히면서 기존 단서(후속 점검·닫기 판정·점검)까지 좁히면 안 된다.
  const items = parseHandoff([
    "## 다음 행동",
    "- **X(11-10 후속 점검 필요):** 본문",
    "- **Y(11-10 닫기 판정: 보류):** 본문",
    "- **W(11-10 점검):** 본문",
    "- **C(11-05 확인 완료):** 본문",
  ].join("\n"), "HANDOFF.md", new Date("2026-11-12T12:00:00Z"));
  assert.deepEqual(items.map((x) => [x.dueKind, x.dueDate]), [
    ["date", "2026-11-10"], ["date", "2026-11-10"], ["date", "2026-11-10"], ["none", null],
  ]);
});
