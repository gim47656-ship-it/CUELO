import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import promptCompact, { TARGETS, loadSwaps, sourceFingerprint } from "../prompt-compact";

type Handler = (event: { systemPrompt: string[] }) => { systemPrompt: string[] } | undefined;

function register(): Handler | undefined {
  let handler: Handler | undefined;
  promptCompact({ on: (name: string, fn: Handler) => { if (name === "before_agent_start") handler = fn; } } as never);
  return handler;
}

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
    expect(out[0]).toMatch(/\b(?:before|prior to)\b[^\n]*\b(?:long-running process|background job|queue)\b[^\n]*\b(?:tell|inform|notify)\b[^\n]*\buser\b/i);
    expect(out[0]).toMatch(/\banswer(?:ed|ing)?\b[^\n]*\buser\b[^\n]*\bbackground job\b[^\n]*\b(?:still alive|in progress|active)\b[^\n]*\b(?:wait(?:ing)?|collect)\b[^\n]*\bsame (?:response|turn)\b/i);
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
});
