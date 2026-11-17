import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import promptCompact, { SKILL_CATALOG_POINTER, TARGETS, applyMainOnly, compactSkills, freshCopy, loadSwaps, sourceFingerprint } from "../prompt-compact";

type Agent = { kind: "main" | "sub"; name: string };
type Handler = (event: { systemPrompt: string[] }, ctx?: { agent: Agent; cwd?: string }) => { systemPrompt: string[] } | undefined;

function register(): Handler | undefined {
  let handler: Handler | undefined;
  promptCompact({ on: (name: string, fn: Handler) => { if (name === "before_agent_start") handler = fn; } } as never);
  return handler;
}

const SKILLS = "# Skills & Rules\n<skills>\n- adaptive: Android UI adapting\n- hwpx: Reading Korean HWP: 한글, 공문\n- web-perf: Long web performance description\n- cuelo-release-deploy: Long CUELO release description\n</skills>\n";
const SHIPPED_GENERIC = `${SKILLS}<generic-rules>\n# 한국어 전역 규칙\n</generic-rules>`;

describe("prompt-compact", () => {
  test("both shipped English copies have current source fingerprints", () => {
    const root = join(import.meta.dir, "../..");
    for (const target of TARGETS) {
      expect(freshCopy(readFileSync(join(root, target.source), "utf8"), readFileSync(join(root, target.copy), "utf8"))).toBeDefined();
    }
  });

  test("shipped English copies replace the Korean rule bodies and leave other blocks untouched", () => {
    const handler = register();
    // A stale copy must not replace the canonical Korean source.
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

  test("every role gets short skill triggers while only Maker loses main-only instructions", () => {
    const handler = register()!;
    const maker = handler({ systemPrompt: [SHIPPED_GENERIC] }, { agent: { kind: "sub", name: "maker" } })!.systemPrompt[0]!;
    const main = handler({ systemPrompt: [SHIPPED_GENERIC] }, { agent: { kind: "main", name: "main" } })!.systemPrompt[0]!;
    const advisor = handler({ systemPrompt: [SHIPPED_GENERIC] }, { agent: { kind: "sub", name: "advisor" } })!.systemPrompt[0]!;
    for (const text of [main, maker, advisor]) {
      expect(text).toContain(SKILL_CATALOG_POINTER);
      expect(text).toContain("- hwpx:");
      expect(text).toContain("- cuelo-release-deploy:");
      expect(text).not.toContain("- adaptive:");
      expect(text).not.toContain("Long CUELO release description");
      expect(text).not.toContain("main-only");
    }
    expect(advisor).toBe(main);
    expect(maker.length).toBeLessThan(main.length);
    expect(maker).toContain("# Global Rules");
    expect(main).toContain("# Global Rules");
  });

  test("main-only markers vanish for Main and take their span for a Maker", () => {
    const body = "- keep A\n<!-- main-only -->\n  - main B\n<!-- /main-only -->\n- keep C\n";
    expect(applyMainOnly(body, false)).toBe("- keep A\n  - main B\n- keep C\n");
    expect(applyMainOnly(body, true)).toBe("- keep A\n- keep C\n");
  });

  test("worktrees and nested packages inherit mapped identity; unrelated cwd uses global and safe defaults", () => {
    const root = mkdtempSync(join(tmpdir(), "prompt-catalog-"));
    try {
      const worktree = join(root, "worktrees/wt-feature");
      const nested = join(worktree, "src/nested");
      const unrelated = join(root, "other");
      mkdirSync(nested, { recursive: true });
      mkdirSync(unrelated);
      writeFileSync(join(worktree, "package.json"), JSON.stringify({ name: "cuelo" }));
      writeFileSync(join(unrelated, "package.json"), JSON.stringify({ name: "unmapped-project" }));
      const handler = register()!;
      // Registered-hook seam, also reused for parent mapping and cwd changes.
      const render = (cwd: string) => handler({ systemPrompt: [SKILLS] }, { agent: { kind: "main", name: "main" }, cwd })!.systemPrompt[0]!;
      for (const cwd of [worktree, nested]) {
        expect(render(cwd)).toContain("- cuelo-release-deploy:");
        expect(render(cwd)).toContain("- hwpx:");
      }
      for (const [index, name] of ["sub-package", undefined].entries()) {
        const packageCwd = join(nested, `package-${index}`);
        mkdirSync(packageCwd);
        writeFileSync(join(packageCwd, "package.json"), JSON.stringify({ name, type: "module" }));
        expect(render(packageCwd)).toContain("- cuelo-release-deploy:");
      }
      for (const cwd of [unrelated, root]) {
        const text = render(cwd);
        expect(text).toContain("- hwpx:");
        expect(text).toContain("- web-perf:");
        expect(text).not.toContain("- cuelo-release-deploy:");
        expect(text).toContain("skill://__catalog__");
      }
      for (const name of ["constructor", "toString", "valueOf"]) {
        writeFileSync(join(unrelated, "package.json"), JSON.stringify({ name }));
        expect(render(unrelated)).toContain("- web-perf:");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("BOM package identity is accepted and an initially malformed file can recover in the same session", () => {
    const root = mkdtempSync(join(tmpdir(), "prompt-catalog-bom-"));
    try {
      const handler = register()!;
      const file = join(root, "package.json");
      writeFileSync(file, "\uFEFF" + JSON.stringify({ name: "cuelo" }));
      expect(handler({ systemPrompt: [SKILLS] }, { agent: { kind: "main", name: "main" }, cwd: root })!.systemPrompt[0]).toContain("- cuelo-release-deploy:");
      writeFileSync(file, JSON.stringify({ name: "unmapped-root" }));
      const malformed = join(root, "new-repo");
      mkdirSync(malformed);
      writeFileSync(join(malformed, "package.json"), "{");
      // No mapped ancestor outside this fixture should be required for recovery.
      const recoveryHandler = register()!;
      recoveryHandler({ systemPrompt: [SKILLS] }, { agent: { kind: "main", name: "main" }, cwd: malformed });
      writeFileSync(join(malformed, "package.json"), JSON.stringify({ name: "cuelo" }));
      expect(recoveryHandler({ systemPrompt: [SKILLS] }, { agent: { kind: "main", name: "main" }, cwd: malformed })!.systemPrompt[0]).toContain("- cuelo-release-deploy:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("display compaction preserves surrounding blocks and triggers without altering the input catalog", () => {
    const before = `prefix\n${SKILLS}suffix`;
    const triggers = { hwpx: "Korean HWPX documents." };
    const after = compactSkills(before, triggers);
    expect(after).toStartWith("prefix\n");
    expect(after).toEndWith("suffix");
    expect(after).toContain("- hwpx: Korean HWPX documents.");
    expect(after).not.toContain("- adaptive:");
    expect(before).toContain("- adaptive:");
    expect(compactSkills(before)).toBe(before);
    expect(compactSkills(before, { absent: "Missing skill." })).toBe(before);
    expect(compactSkills("<skills>\n- constructor: Unmapped skill\n- hwpx: HWPX\n</skills>", triggers)).not.toContain("- constructor:");
  });

  test("missing or invalid catalog configuration warns once and preserves the complete skill list", async () => {
    const root = mkdtempSync(join(tmpdir(), "prompt-catalog-config-"));
    const originalWarn = console.warn;
    const notices: string[] = [];
    console.warn = (message: unknown) => { notices.push(String(message)); };
    try {
      const source = readFileSync(join(import.meta.dir, "../prompt-compact.ts"), "utf8");
      for (const [index, config] of [undefined, "skills: {}", "skills: [invalid"].entries()) {
        const agent = join(root, `agent-${index}`);
        mkdirSync(join(agent, "extensions"), { recursive: true });
        writeFileSync(join(agent, "extensions/prompt-compact.ts"), source);
        if (config !== undefined) writeFileSync(join(agent, "config.yml"), config);
        // Runtime-generated module location exercises import.meta.dir config loading.
        const { default: registerFixture } = await import(join(agent, "extensions/prompt-compact.ts"));
        let handler: Handler | undefined;
        registerFixture({ on: (_name: string, fn: Handler) => { handler = fn; } } as never);
        expect(handler!({ systemPrompt: [SKILLS] }, { agent: { kind: "sub", name: "maker" } })!.systemPrompt[0]).toBe(SKILLS);
      }
      expect(notices).toHaveLength(3);
      expect(notices.every((notice) => notice.includes("retaining the complete skill list"))).toBe(true);
    } finally {
      console.warn = originalWarn;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a skills block without parsable entries is left alone", () => {
    expect(compactSkills("<skills>\nfree text\n</skills>", { hwpx: "HWPX" })).toBe("<skills>\nfree text\n</skills>");
    expect(compactSkills("no skills here", { hwpx: "HWPX" })).toBe("no skills here");
  });
});
