import { describe, expect, test } from "bun:test";
import { observeSkillReads, renderSkillEvidence, type DispatchRequiredSkills } from "../lib/skill-evidence";

// 실제 child transcript 줄과 같은 모양(core SessionManager가 쓰는 message entry). 실제 SDK 기록 smoke는 jev-runtime.test.ts에 있다.
const header = [
  JSON.stringify({ type: "title", v: 1, title: "" }),
  JSON.stringify({ type: "session", version: 3, id: "child", timestamp: "2026-11-03T00:00:00.000Z", cwd: "/w" }),
];
const call = (id: string, name: string, args: Record<string, unknown>, at: string) =>
  JSON.stringify({ type: "message", id: `a-${id}`, timestamp: at, message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } });
const result = (id: string, name: string, at: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "message", id: `r-${id}`, timestamp: at, message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "body" }], ...extra } });
const expected: DispatchRequiredSkills = {
  state: "selected", reason: null, sets: ["web-ui"], modifiers: ["ko-copy"],
  skills: ["seed-design", "hallmark", "humanizer", "kill-ai-slop"], excluded: [],
};



describe("child transcript의 skill:// 읽기 관측", () => {
  test("refusal, script exception and I/O failure are distinct and none prove a skill read", () => {
    const stamp = "2026-11-03T00:10:00.000Z";
    const text = [...header, ...[
      { isError: true },
      { isError: false, details: { refused: { by: "secret-path" } } },
      { isError: false, details: { scriptError: true } },
    ].flatMap((outcome, index) => [
      call(String(index), "read", { path: "skill://hallmark" }, stamp),
      result(String(index), "read", stamp, outcome),
    ])].join("\n");
    expect(observeSkillReads(text, "x.jsonl")).toMatchObject({
      state: "observed", reads: [], failed: 1, refused: 1, scriptError: 1,
    });
  });

  test("이전 attempt 읽기는 따로 보이고 이번 필수 대조에 세지 않으며, slop_check 통과는 읽기가 아니다", () => {
    const text = [...header,
      call("1", "read", { path: "skill://hallmark" }, "2026-11-03T01:00:00.000Z"), result("1", "read", "2026-11-03T01:00:00.100Z"),
      call("2", "read", { path: "skill://seed-design" }, "2026-11-03T02:00:00.000Z"), result("2", "read", "2026-11-03T02:00:00.100Z"),
      call("3", "slop_check", { files: ["page.html"] }, "2026-11-03T02:01:00.000Z"), result("3", "slop_check", "2026-11-03T02:01:00.100Z", { details: { status: "pass" } }),
      call("4", "read", { path: "skill://humanizer" }, "2026-11-03T02:02:00.000Z"), result("4", "read", "2026-11-03T02:02:00.100Z", { details: { truncation: { truncated: true } } }),
      // path 밖 범위 인자가 있으면 성공해도 전체 읽기가 아니다.
      call("5", "read", { path: "skill://kill-ai-slop", offset: 1, limit: 5 }, "2026-11-03T02:03:00.000Z"), result("5", "read", "2026-11-03T02:03:00.100Z"),
    ].join("\n");
    const line = renderSkillEvidence({
      label: "Ui s#a2", observation: observeSkillReads(text, "agent-Ui.jsonl"),
      window: { kind: "from", ms: Date.parse("2026-11-03T01:30:00.000Z") }, expected, expectedSource: "ledger",
    });
    expect(line).toContain("관측 읽기 seed-design[전체]@2026-11-03T02:00:00.100Z, humanizer[잘림]@2026-11-03T02:02:00.100Z, kill-ai-slop[범위 인자 범위]@2026-11-03T02:03:00.100Z;");
    expect(line).toContain("이전 attempt 읽기(이번 attempt 근거·절차 완료 아님): hallmark[전체]@2026-11-03T01:00:00.100Z");
    expect(line).toContain("전체 읽기 관측 seed-design;");
    expect(line).toContain("부분 읽기만 humanizer, kill-ai-slop");
    expect(line).toContain("이번 attempt 밖에서만 읽음 hallmark");
    expect(line).not.toContain("읽기 관측 없음");
  });

  test("header 없는 파일·이번 attempt 기록이 없는 transcript는 0건이 아니라 미관측이고, 깨진 줄은 건수로 알린다", () => {
    const headerless = observeSkillReads(call("1", "read", { path: "skill://hallmark" }, "2026-11-03T01:00:00.000Z"), "x.jsonl");
    expect(headerless.state).toBe("unobserved");
    const old = [...header, call("1", "read", { path: "skill://hallmark" }, "2026-11-03T01:00:00.000Z"), result("1", "read", "2026-11-03T01:00:00.100Z")].join("\n");
    const stale = renderSkillEvidence({ label: "Ui s#a2", observation: observeSkillReads(old, "agent-Ui.jsonl"), window: { kind: "from", ms: Date.parse("2026-11-03T05:00:00.000Z") }, expected, expectedSource: "ledger" });
    expect(stale).toContain("읽기 증거 없음(미관측: transcript에 이 attempt 시작 뒤 기록이 없음");
    expect(stale).not.toContain("관측 읽기");
    const broken = [...header, `${call("1", "read", { path: "skill://hallmark" }, "2026-11-03T01:00:00.000Z").slice(0, -5)}`].join("\n");
    const observation = observeSkillReads(broken, "agent-Ui.jsonl");
    expect(observation).toMatchObject({ state: "observed", unparsed: 1, reads: [] });
  });

  test("attempt를 가르지 못하면 읽기를 보이되 이번 근거로 세지 않는다", () => {
    const text = [...header, call("1", "read", { path: "skill://seed-design" }, "2026-11-03T01:00:00.000Z"), result("1", "read", "2026-11-03T01:00:00.100Z")].join("\n");
    const line = renderSkillEvidence({ label: "Ui s#a3", observation: observeSkillReads(text, "agent-Ui.jsonl"), window: { kind: "unknown", reason: "재개 attempt 시작 시각 미관측" }, expected, expectedSource: "ledger" });
    expect(line).toContain("attempt를 가르지 못한 읽기(이번 attempt 근거·절차 완료 아님): seed-design[전체]");
    expect(line).toContain("전체 읽기 관측 없음");
  });
});
