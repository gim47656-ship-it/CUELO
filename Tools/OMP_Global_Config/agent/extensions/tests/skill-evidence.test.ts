import { describe, expect, test } from "bun:test";
import { briefSkillCoverage, dispatchRequiredSkills, loadRequiredSkillContract, observeSkillReads, parseRequiredSkillContract, renderSkillEvidence, requiredSkillGaps, selectRequiredSkills, type DispatchRequiredSkills } from "../lib/skill-evidence";

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

describe("required-skills 정본 소비", () => {
  test("실제 rule://frontend 블록을 읽고, 블록이 없거나 깨졌으면 unavailable 이유를 준다", () => {
    const source = loadRequiredSkillContract();
    expect(source.state).toBe("loaded");
    if (source.state === "loaded") expect(source.contract.sets.map((set) => set.id)).toContain("web-ui");
    expect(parseRequiredSkillContract("# no block").state).toBe("unavailable");
    expect(parseRequiredSkillContract("<!-- required-skills:start -->\n```json\n{\"version\":1,\"sets\":[],\"modifiers\":[]}\n```\n<!-- required-skills:end -->").state).toBe("unavailable");
    expect(parseRequiredSkillContract("<!-- required-skills:start -->\n```json\n{\"version\":1,\"sets\":[{\"id\":\"a\",\"when\":\"w\",\"skills\":[\"bad name\"]}],\"modifiers\":[]}\n```\n<!-- required-skills:end -->").state).toBe("unavailable");
  });

  test("넓은 분류가 UNKNOWN이어도 구체 세트 답은 버리지 않고 분류 미확인을 알린다 (SKILL-VISIBILITY-DISCARD)", () => {
    const source = loadRequiredSkillContract();
    if (source.state !== "loaded") throw new Error("rule://frontend 정본을 읽지 못함");
    const answers = (deliverable: string, positive: string[]) => Object.fromEntries([
      ["requiredSkillDeliverable", { choice: deliverable }],
      ...source.contract.sets.map((set) => [`requiredSkillSet_${set.id.replace(/[^A-Za-z0-9]/g, "_")}`, { noul: positive.includes(set.id) ? 0.9 : 0.1 }]),
      ...source.contract.modifiers.map((modifier) => [`requiredSkillModifier_${modifier.id.replace(/[^A-Za-z0-9]/g, "_")}`, { noul: positive.includes(modifier.id) ? 0.9 : 0.1 }]),
    ]);
    const webUi = source.contract.sets.find((set) => set.id === "web-ui")!.skills;
    const unknown = selectRequiredSkills(source, answers("UNKNOWN", ["web-ui", "ko-copy"]));
    expect(unknown).toMatchObject({ state: "ambiguous", sets: ["web-ui"], modifiers: ["ko-copy"] });
    expect(unknown.skills).toEqual(expect.arrayContaining([...webUi, "humanizer"]));
    const gaps = requiredSkillGaps(unknown, briefSkillCoverage("skill://hallmark 또는 skill://ui-ux-pro-max 중 하나를 적용한다.", unknown));
    expect(gaps.some((gap) => gap.includes("skill://seed-design"))).toBe(true);
    expect(gaps.some((gap) => gap.startsWith("필수 스킬을 선택형으로 줄임"))).toBe(true);
    expect(selectRequiredSkills(source, answers("NONVISUAL", []))).toMatchObject({ state: "none", sets: [], skills: [] });
    expect(selectRequiredSkills(source, answers("UNKNOWN", []))).toMatchObject({ state: "ambiguous", sets: [], skills: [] });
  });

  test("실제 Jev 답 모양: UNKNOWN+web-ui는 요구하고, NONVISUAL과 모순된 ui-polish는 관측만 남기고 필수 누락으로 단정하지 않는다 (SKILL-CONTRADICTORY-REQUIREMENT)", () => {
    const source = loadRequiredSkillContract();
    if (source.state !== "loaded") throw new Error("rule://frontend 정본을 읽지 못함");
    // Main --observe 실측값. 실측에 없던 나머지 세트·modifier는 0.1로 둔다.
    const shape = (choice: string, values: Record<string, number>) => ({
      requiredSkillDeliverable: { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 },
      ...Object.fromEntries([...source.contract.sets.map((set) => `requiredSkillSet_${set.id.replace(/-/g, "_")}`), ...source.contract.modifiers.map((modifier) => `requiredSkillModifier_${modifier.id.replace(/-/g, "_")}`)]
        .map((key) => [key, { type: "noul", noul: values[key] ?? 0.1 }])),
    });
    const ops = selectRequiredSkills(source, shape("UNKNOWN", { requiredSkillSet_web_ui: 0.96, requiredSkillModifier_operator_screen: 0.91, requiredSkillModifier_ko_copy: 0.76 }));
    expect(ops).toMatchObject({ state: "ambiguous", sets: ["web-ui"], modifiers: ["operator-screen", "ko-copy"] });
    expect(ops.skills).toEqual(expect.arrayContaining(["seed-design", "hallmark", "operational-expert-tool-ui", "humanizer"]));

    const parser = selectRequiredSkills(source, shape("NONVISUAL", { requiredSkillSet_ui_polish: 0.56 }));
    const uiPolish = source.contract.sets.find((set) => set.id === "ui-polish")!.skills;
    expect(parser).toMatchObject({ state: "ambiguous", sets: [], skills: [], contradictedSets: ["ui-polish"] });
    expect(parser.reason).toContain("ui-polish 0.56");
    const task = "TASK_GUARD:\nWORK_CLASS: feature\n# Change\n길이 0이면 빈 payload.";
    const gaps = requiredSkillGaps(parser, parser.skills.length > 0 ? briefSkillCoverage(task, parser) : null);
    expect(gaps.some((gap) => gap.startsWith("필수 스킬 세트 분류 미확인") && gap.includes("모순"))).toBe(true);
    expect(gaps.some((gap) => gap.startsWith("필수 스킬 누락"))).toBe(false);
    // 완료 advisory의 기대값(원장 requiredSkills)에도 ui-polish 스킬이 필수로 들어가지 않는다.
    expect(dispatchRequiredSkills(parser, task).skills.filter((skill) => uiPolish.includes(skill))).toEqual([]);
  });
});

describe("브리프 인계 대조", () => {
  test("줄바꿈한 SKILL_EXCLUSIONS의 이유 문장에 나온 스킬 이름은 인계로 세지 않는다", () => {
    const selection = { state: "selected" as const, reason: null, sets: ["web-ui"], modifiers: ["ko-copy"], skills: ["kill-ai-slop", "humanizer"] };
    const task = "TASK_GUARD:\nOWNED_PATHS: a.ts\n\nSKILL_EXCLUSIONS: {\n  \"kill-ai-slop\": \"기존 {theme} 보존; humanizer 점검으로 대신하지 않음\"\n}\n# Change\n화면 문구를 고친다.";
    const coverage = briefSkillCoverage(task, selection);
    expect(coverage.missing).toEqual(["humanizer"]);
    expect(coverage.excluded).toEqual([{ skill: "kill-ai-slop", reason: "기존 {theme} 보존; humanizer 점검으로 대신하지 않음" }]);
  });

  test("skill:// URI 안의 '/'는 선택형 구분자가 아니고, 실제 선택형은 그대로 잡는다 (SKILL-URI-SEPARATOR)", () => {
    const selection = { state: "selected" as const, reason: null, sets: ["web-ui"], modifiers: ["ko-copy"], skills: ["hallmark", "ui-ux-pro-max", "humanizer"] };
    expect(briefSkillCoverage("Required: skill://hallmark + skill://ui-ux-pro-max + skill://humanizer", selection).alternatives).toEqual([]);
    expect(briefSkillCoverage("읽기: skill://hallmark/references/a.md, skill://ui-ux-pro-max, skill://humanizer", selection).alternatives).toEqual([]);
    for (const line of ["skill://hallmark 또는 skill://ui-ux-pro-max, humanizer", "hallmark/ui-ux-pro-max, humanizer", "skill://hallmark/skill://ui-ux-pro-max, humanizer", "hallmark/or ui-ux-pro-max, humanizer", "hallmark/또는 ui-ux-pro-max, humanizer"]) {
      expect(briefSkillCoverage(line, selection).alternatives).toEqual([line]);
    }
  });
});

describe("child transcript의 skill:// 읽기 관측", () => {
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
