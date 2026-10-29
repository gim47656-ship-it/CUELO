import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import promptCompact, { SKILL_NAMES_POINTER, TARGETS, applyMainOnly, loadSwaps, namesOnlySkills, sourceFingerprint } from "../prompt-compact";

type Agent = { kind: "main" | "sub"; name: string };
type Handler = (event: { systemPrompt: string[] }, ctx?: { agent: Agent }) => { systemPrompt: string[] } | undefined;

function register(): Handler | undefined {
  let handler: Handler | undefined;
  promptCompact({ on: (name: string, fn: Handler) => { if (name === "before_agent_start") handler = fn; } } as never);
  return handler;
}

const SKILLS = "# Skills & Rules\n<skills>\n- adaptive: Android UI adapting\n- hwpx: Reading Korean HWP: 한글, 공문\n</skills>\n";
const SHIPPED_GENERIC = `${SKILLS}<generic-rules>\n# 한국어 전역 규칙\n</generic-rules>`;

describe("prompt-compact", () => {
  test("shipped English copies replace the Korean rule bodies and leave other blocks untouched", () => {
    const handler = register();
    // 원문을 고치고 사본을 갱신하지 않으면 handler가 등록되지 않아 여기서 실패한다.
    expect(handler).toBeDefined();
    const agents = TARGETS[0]!;
    const rules = TARGETS[1]!;
    const system = [
      `<repo-rules>\n${agents.open}\n# 한국어 원문\n</file>\n<file path="C:\\repo\\AGENTS.md">\n프로젝트 규칙\n</file>\n</repo-rules>`,
      `<generic-rules>\n# 한국어 전역 규칙\n</generic-rules>\n<domain-rules>유지</domain-rules>`,
      "<character-voice>음성</character-voice>",
    ];
    const out = handler!({ systemPrompt: system })!.systemPrompt;
    expect(out[0]).toContain("# Global Agent Instructions");
    expect(out[0]).not.toContain("# 한국어 원문");
    expect(out[0]).toContain("프로젝트 규칙");
    expect(out[1]).toContain("# Global Rules");
    expect(out[1]).not.toContain("# 한국어 전역 규칙");
    expect(out[1]).toContain("<domain-rules>유지</domain-rules>");
    expect(out[1]).toContain(rules.close);
    expect(out[2]).toBe(system[2]);
  });

  test("a copy made from an older source is not used", () => {
    const dir = mkdtempSync(join(tmpdir(), "prompt-compact-"));
    try {
      mkdirSync(join(dir, "prompt-copies"));
      const target = { source: "RULES.md", copy: "prompt-copies/RULES.en.md", open: "<generic-rules>", close: "</generic-rules>" };
      writeFileSync(join(dir, "RULES.md"), "원문 v1");
      writeFileSync(join(dir, target.copy), `<!-- source-fingerprint: ${sourceFingerprint("원문 v1")} -->\nEnglish v1\n`);
      expect(loadSwaps(dir, [target]).map((swap) => swap.body)).toEqual(["English v1"]);
      writeFileSync(join(dir, "RULES.md"), "원문 v2");
      expect(loadSwaps(dir, [target])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a Maker child gets names-only skills and loses only main-only rule items", () => {
    const handler = register()!;
    const maker = handler({ systemPrompt: [SHIPPED_GENERIC] }, { agent: { kind: "sub", name: "maker" } })!.systemPrompt[0]!;
    const main = handler({ systemPrompt: [SHIPPED_GENERIC] }, { agent: { kind: "main", name: "main" } })!.systemPrompt[0]!;
    const advisor = handler({ systemPrompt: [SHIPPED_GENERIC] }, { agent: { kind: "sub", name: "advisor" } })!.systemPrompt[0]!;
    expect(maker).toContain(`<skills>\n${SKILL_NAMES_POINTER}\nadaptive, hwpx\n</skills>`);
    expect(maker).not.toContain("Android UI adapting");
    // Main·다른 subagent는 설명 포함 목록을 그대로 받는다.
    expect(main).toContain("- adaptive: Android UI adapting");
    expect(advisor).toBe(main);
    // 배포·git_finalize 항목은 Main에만 남고 Maker 의무(같은 조치 반복 금지·승인 경계)는 둘 다 받는다.
    for (const text of [main, maker]) {
      expect(text).toContain("Do not repeat the same action under the same conditions.");
      expect(text).toContain("get user approval before deletion, deployment, incurring cost, or breaking compatibility");
      expect(text).not.toContain("main-only");
    }
    expect(main).toContain("use Main's `git_finalize` tool");
    expect(main).toContain("read `rule://deploy-ops`");
    expect(maker).not.toContain("use Main's `git_finalize` tool");
    expect(maker).not.toContain("read `rule://deploy-ops`");
  });

  test("main-only markers vanish for Main and take their span for a Maker", () => {
    const body = "- keep A\n<!-- main-only -->\n  - main B\n<!-- /main-only -->\n- keep C\n";
    expect(applyMainOnly(body, false)).toBe("- keep A\n  - main B\n- keep C\n");
    expect(applyMainOnly(body, true)).toBe("- keep A\n- keep C\n");
  });

  test("a skills block without parsable entries is left alone", () => {
    expect(namesOnlySkills("<skills>\nfree text\n</skills>")).toBe("<skills>\nfree text\n</skills>");
    expect(namesOnlySkills("no skills here")).toBe("no skills here");
  });
});
