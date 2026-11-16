import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  classifySkillScanReport,
  hashSkillFolders,
  scanSkillFolders,
  worstSkillScan,
  type SkillScanItem,
} from "./skill-scan";

function report(recommendation: string, score: number, completeness = "complete", issues: unknown[] = []): string {
  return JSON.stringify({
    risk_assessment: { score, severity: "LOW", recommendation, max_issue_severity: "LOW" },
    analysis_completeness: { status: completeness },
    issues,
  });
}

const issue = (id: string, severity: string, file: string, line: number) => ({
  id,
  severity,
  pattern: `pattern ${id}`,
  finding: "untrusted matched text",
  location: { file, start_line: line },
});

describe("classifySkillScanReport", () => {
  test("SAFE with a complete analysis passes", () => {
    expect(classifySkillScanReport(0, report("SAFE", 0))).toMatchObject({ status: "safe", score: 0 });
    expect(classifySkillScanReport(0, report("SAFE", 5, "complete_with_caveats")).status).toBe("safe");
  });

  test("SAFE with a partial analysis is incomplete", () => {
    expect(classifySkillScanReport(0, report("SAFE", 0, "partial"))).toMatchObject({
      status: "incomplete",
      reason: "partial-analysis",
    });
  });

  test("CAUTION and DO_NOT_INSTALL are risk, with the top five findings by severity", () => {
    const issues = [
      issue("A", "LOW", "a.md", 1),
      issue("B", "CRITICAL", "SKILL.md", 38),
      issue("C", "MEDIUM", "b.py", 2),
      issue("D", "HIGH", "c.py", 3),
      issue("E", "MEDIUM", "d.py", 4),
      issue("F", "INFO", "e.py", 5),
      issue("B", "CRITICAL", "SKILL.md", 38), // same rule, file and line again: shown once
    ];
    const item = classifySkillScanReport(1, report("DO_NOT_INSTALL", 100, "complete", issues));
    expect(item).toMatchObject({ status: "risk", score: 100, recommendation: "DO_NOT_INSTALL" });
    expect(item.issues.map((entry) => entry.ruleId)).toEqual(["B", "D", "C", "E", "A"]);
    expect(item.issues[0]).toEqual({ ruleId: "B", severity: "CRITICAL", file: "SKILL.md:38", message: "pattern B" });
    expect(classifySkillScanReport(0, report("CAUTION", 30)).status).toBe("risk");
  });

  test("exit code 1 never passes even when the report says SAFE", () => {
    expect(classifySkillScanReport(1, report("SAFE", 0)).status).toBe("risk");
  });

  test("usage errors and unreadable reports are incomplete", () => {
    expect(classifySkillScanReport(2, report("SAFE", 0))).toMatchObject({ status: "incomplete", reason: "scan-failed" });
    expect(classifySkillScanReport(0, "not json")).toMatchObject({ status: "incomplete", reason: "unreadable-report" });
    expect(classifySkillScanReport(0, undefined).status).toBe("incomplete");
    expect(classifySkillScanReport(0, JSON.stringify({ risk_assessment: { score: 0 } })).status).toBe("incomplete");
    expect(classifySkillScanReport(0, JSON.stringify({ risk_assessment: { recommendation: "MAYBE" } })).status).toBe("incomplete");
  });
});

describe("worstSkillScan", () => {
  const safe: SkillScanItem = { status: "safe", score: 0, recommendation: "SAFE", issues: [] };
  const risky = (score: number, ruleId: string): SkillScanItem => ({
    status: "risk",
    score,
    recommendation: "DO_NOT_INSTALL",
    issues: [{ ruleId, severity: "HIGH", file: "SKILL.md:1", message: "m" }],
  });

  test("all safe returns null", () => {
    expect(worstSkillScan([{ name: "a", item: safe }, { name: "b", item: safe }])).toBeNull();
  });

  test("risk beats incomplete beats unavailable, and the highest score leads", () => {
    const incomplete: SkillScanItem = { status: "incomplete", reason: "timed-out", issues: [] };
    const unavailable: SkillScanItem = { status: "unavailable", reason: "not-installed", issues: [] };
    expect(worstSkillScan([{ name: "a", item: unavailable }, { name: "b", item: incomplete }])).toMatchObject({
      status: "incomplete",
      reason: "timed-out",
    });
    const summary = worstSkillScan([
      { name: "a", item: risky(60, "R1") },
      { name: "b", item: incomplete },
      { name: "c", item: risky(96, "R2") },
      { name: "d", item: safe },
    ]);
    expect(summary).toMatchObject({ status: "risk", score: 96 });
    expect(summary?.issues.map((entry) => entry.file)).toEqual(["a/SKILL.md:1", "c/SKILL.md:1"]);
  });
});

describe.skipIf(process.platform === "win32")("scanSkillFolders", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function fixture(script?: string) {
    const root = await mkdtemp(join(tmpdir(), "skill-scan-test-"));
    cleanup.push(root);
    const bin = join(root, "bin");
    await mkdir(bin);
    const skill = join(root, "skill");
    await mkdir(skill);
    await writeFile(join(skill, "SKILL.md"), "# test\n");
    if (script) {
      await writeFile(join(bin, "skillspector"), `#!/bin/sh\n${script}\n`);
      await chmod(join(bin, "skillspector"), 0o755);
    }
    return { env: { PATH: bin }, home: join(root, "home"), folders: [{ name: "skill", dir: skill }] };
  }

  // The fake scanner writes the report to the path after --output, like the real one.
  const writeReport = (json: string) => `out=; while [ $# -gt 0 ]; do [ "$1" = --output ] && out=$2; shift; done; printf '%s' '${json}' > "$out"`;

  test("a missing scanner is unavailable", async () => {
    const { env, home, folders } = await fixture();
    expect(await scanSkillFolders(folders, { env, home })).toEqual({
      passed: false,
      summary: { status: "unavailable", reason: "not-installed", issues: [] },
    });
  });

  test("SAFE report passes and a risky exit-1 report does not", async () => {
    const safe = await fixture(`${writeReport(report("SAFE", 0))}; exit 0`);
    expect(await scanSkillFolders(safe.folders, safe)).toEqual({ passed: true });
    const risky = await fixture(`${writeReport(report("DO_NOT_INSTALL", 100))}; exit 1`);
    const outcome = await scanSkillFolders(risky.folders, risky);
    expect(outcome).toMatchObject({ passed: false, summary: { status: "risk", score: 100 } });
  });

  test("a scan that outlives the budget is incomplete", async () => {
    const slow = await fixture("sleep 30");
    const started = Date.now();
    const outcome = await scanSkillFolders(slow.folders, { ...slow, budgetMs: 1500 });
    expect(outcome).toMatchObject({ passed: false, summary: { status: "incomplete", reason: "timed-out" } });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("exit code 2 is incomplete", async () => {
    const broken = await fixture("exit 2");
    expect(await scanSkillFolders(broken.folders, broken)).toMatchObject({
      passed: false,
      summary: { status: "incomplete", reason: "scan-failed" },
    });
  });
});

describe("hashSkillFolders", () => {
  test("is stable across locations and changes with any byte", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-hash-test-"));
    try {
      const make = async (dir: string, body: string) => {
        await mkdir(join(root, dir, "scripts"), { recursive: true });
        await writeFile(join(root, dir, "SKILL.md"), "# s\n");
        await writeFile(join(root, dir, "scripts", "run.sh"), body);
        return { name: "s", dir: join(root, dir) };
      };
      const a = await hashSkillFolders([await make("a", "echo 1")]);
      const b = await hashSkillFolders([await make("b", "echo 1")]);
      const c = await hashSkillFolders([await make("c", "echo 2")]);
      expect(a).toBe(b);
      expect(a).not.toBe(c);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("file names cannot forge another tree's hash, and links may not leave the folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-hash-test-"));
    try {
      const digest = (text: string) => createHash("sha256").update(text).digest("hex");
      await mkdir(join(root, "a"));
      await mkdir(join(root, "b"));
      // One file named so that its old plain-text entry line equals the two lines of tree b.
      await writeFile(join(root, "a", `x ${digest("evil")}\nF y`), "safe");
      await writeFile(join(root, "b", "x"), "evil");
      await writeFile(join(root, "b", "y"), "safe");
      expect(await hashSkillFolders([{ name: "s", dir: join(root, "a") }]))
        .not.toBe(await hashSkillFolders([{ name: "s", dir: join(root, "b") }]));

      await mkdir(join(root, "c"));
      await writeFile(join(root, "c", "SKILL.md"), "# s\n");
      await symlink("../outside", join(root, "c", "link"));
      await expect(hashSkillFolders([{ name: "s", dir: join(root, "c") }])).rejects.toThrow("outside its folder");
      await rm(join(root, "c", "link"));
      await symlink("SKILL.md", join(root, "c", "link"));
      await expect(hashSkillFolders([{ name: "s", dir: join(root, "c") }])).resolves.toMatch(/^[a-f0-9]{64}$/);

      // A link that is lexically inside the folder but escapes through an intermediate link.
      await mkdir(join(root, "d", "a", "b"), { recursive: true });
      await symlink("..", join(root, "d", "a", "b", "p"));
      await symlink("p/../../../outside", join(root, "d", "a", "b", "leak"));
      await writeFile(join(root, "outside"), "x");
      await expect(hashSkillFolders([{ name: "s", dir: join(root, "d") }])).rejects.toThrow("outside its folder");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
