import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as zod from "@oh-my-pi/omptype/zod";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import slopGate, { CONTINUATION_TYPE, executeSlopCheck, WARNING_TYPE } from "../slop-gate";
import { appendSlopRecord, candidatesOf, classify, loadSlopConfig, mergeGateBlobs, passFor, readSlopRecords, sha256, SlopGateRefusal, trackable } from "../lib/slop-gate";
import { htmlText, jsonStrings, literalStrings, pythonPath, extractVisible } from "../slop-gate/extract";
import { parseAnswer, resolveFiles, reviewFiles, resolveFindings, type Complete, type SlopDeps } from "../slop-gate/review";

// 모델은 가짜다(결정론). 심사 흐름·원장·추적은 실제 코드가 실제 파일로 돈다.

const roots: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "slop-gate-test-"));
  roots.push(dir);
  return dir;
};
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); delete process.env.OMP_SLOP_GATE_LEDGER; });

const signal = new AbortController().signal;
const KO_SLOP = "이 도구는 혁신적인 솔루션입니다. 결론적으로, 지속가능한 효과적인 경험을 제공합니다. 다양한 사용자에게 핵심적인 가치를 제공하는 셈이다.\n";
const KO_PLAIN = "저장 버튼을 누르면 파일이 내려받기 폴더에 들어간다.\n한 번 더 누르면 같은 이름 뒤에 번호가 붙는다. 실패하면 빨간 줄로 이유를 보여 준다.\n";

/**
 * 호출을 세는 가짜 reviewer. answer는 프롬프트(<artifact id=…>)와 family를 보고 만든다. calls는 필수 reviewer(자문이 아닌 slot)로 간
 * 프롬프트, all은 모든 호출이다. per는 family별로 실패·다른 답을 강제할 때 쓴다.
 */
function fakeReviewer(answer: (ids: string[], prompt: string, family: string) => unknown, per: Record<string, "throw" | "junk"> = {}) {
  const calls: string[] = [];
  const all: { family: string; prompt: string }[] = [];
  const complete: Complete = async (family, _system, prompt) => {
    all.push({ family, prompt });
    if (family !== "google") calls.push(prompt);
    if (per[family] === "throw") throw new Error(`${family} outage`);
    if (per[family] === "junk") return { model: `fixture/${family}`, text: "looks fine to me" };
    const ids = [...prompt.matchAll(/<artifact id="(a\d+)"/g)].map((match) => match[1]!);
    return { model: `fixture/${family}`, text: JSON.stringify(answer(ids, prompt, family)) };
  };
  return { calls, all, complete };
}
/** 저자는 Anthropic 계열 fixture라 필수 reviewer는 openai slot, 자문은 google slot이다. */
const AUTHOR = "anthropic/fixture-author";
const clean = (ids: string[]) => ({ files: ids.map((id) => ({ id, findings: [] })) });
const dirty = (ids: string[]) => ({ files: ids.map((id) => ({ id, findings: [{ quote: "혁신적인 솔루션", rule: "humanizer:14 AI 어휘", fix: "무엇을 하는지 구체적으로 쓴다" }] })) });

function deps(cwd: string, complete: Complete, extra: Partial<SlopDeps> = {}): SlopDeps {
  return { cwd, ledgerPath: join(cwd, "ledger.jsonl"), complete, mainModel: AUTHOR, head: async () => undefined, ...extra };
}

describe("classify: 보이는 산출물과 내부·코드", () => {
  test.each([
    "README.md", "CHANGELOG.md", "docs/guide/setup.md", "notes/guide.md", "site/index.html", "deck.pptx", "보고서.docx", "sheet.xlsx", "manual.pdf", "공문.hwpx",
    "lib/i18n/messages/ko.json", "lib/i18n/messages/en.ts", "reports/월간.csv", "doc/guide.md", "Tools/X/doc/manual.pdf", "app/doc/intro.html", "src/lang/ko.json", "web/l10n/en.yaml", "app/translations/fr.po", "src/locales/en.ts", "src/i18n/en.ts", "src/lang/ko.js", "src/i18n/en/index.ts", "lib/i18n/registry.ts", "/home/user/app/locale/ko.json", "i18n/ko.json", "/mnt/c/Users/user/Downloads/보고서.docx", "/mnt/d/Users/x/Desktop/a.csv",
  ])("보이는 산출물: %s", (path) => { expect(classify(path).visible).toBe(true); });

  test.each([
    "HANDOFF.md", "doc/README.md", "doc/history/2026/10/26-slop-gate/maker-SlopGate.md", "Tools/X/doc/history/2026/10/a/main.md",
    "Tools/OMP_Global_Config/agent/rules/subagent.md", "Tools/OMP_Global_Config/agent/skills/humanizer/README.md", "Tools/OMP_Global_Config/agent/sop/maker.md",
    "AGENTS.md", "Tools/OMP_Global_Config/agent/RULES.md", "Tools/OMP_Global_Config/agent/prompt-copies/RULES.en.md",
    "src/app.ts", "src/messages/en.ts", "lib/api-credits.d.ts", "lib/api-credits.test.mjs", "tests/fixtures/page.html", "node_modules/x/README.md", "dist/index.html",
    "data/prices.csv", "run.log", "/tmp/scratch.md", "/mnt/c/Users/user/AppData/Local/x/node_modules/a.md",
  ])("내부·코드·생성물·데이터: %s", (path) => { expect(classify(path).visible).toBe(false); });

  test("프로젝트 설정은 보이는 산출물을 더하기만 하고, ignore 키는 읽지도 않는다", () => {
    const cwd = scratch();
    writeFileSync(join(cwd, ".slop-gate.json"), JSON.stringify({ visible: ["data/*.csv"], ignore: ["docs/**"] }));
    const config = loadSlopConfig(cwd);
    expect(config).toEqual({ visible: ["data/*.csv"] });
    expect(classify("data/prices.csv", config).visible).toBe(true);
    expect(classify("data/prices.csv").visible).toBe(false);
    expect(classify("docs/guide.md", config).visible).toBe(true);
  });

  test("점검 대상 경로: cwd 안, 또는 cwd 밖이어도 시스템 영역이 아닌 절대 경로. 시스템·임시·내부·캐시·의존성은 아니다", () => {
    const cwd = "/home/user/work";
    const home = homedir();
    for (const path of [`${cwd}/a.md`, `${home}/Documents/보고서.docx`, "/mnt/c/Users/user/Desktop/a.pptx", "/mnt/d/보고/월간.xlsx", "/srv/deliverables/report.pdf", "/media/shared/report.pdf", "/data/customer/report.pdf", "/opt/customer/report.pdf", "/var/www/a.md", "/usr/share/nginx/html/index.html", "/var/tmp/customer-report.pdf"]) expect(trackable(path, cwd)).toBe(true);
    for (const path of ["/tmp/a.md", `${home}/.omp/agent/a.md`, `${home}/.cache/x/a.md`, `${home}/proj/node_modules/x/a.md`, `${home}/proj/.git/a.md`, "/etc/a.md", "/usr/lib/a.md", "/var/log/a.md", "/proc/1/a.md"]) expect(trackable(path, cwd)).toBe(false);
  });

  test("slop_check 대상 해석은 같은 규칙이다: 홈 아래 cwd 밖 파일은 받고 /tmp 밖 파일은 거절한다", () => {
    const dir = mkdtempSync(join(homedir(), ".slop-gate-test-"));
    roots.push(dir);
    writeFileSync(join(dir, "out.md"), KO_PLAIN);
    const cwd = scratch();
    expect(resolveFiles([join(dir, "out.md")], join(homedir(), "nowhere-cwd")).ok).toHaveLength(1);
    const outsideTmp = join(scratch(), "x.md");
    writeFileSync(outsideTmp, KO_PLAIN);
    const refused = resolveFiles([outsideTmp], join(homedir(), "nowhere-cwd"));
    expect(refused.ok).toHaveLength(0);
    expect(refused.errors[0]!.error).toContain("outside the session cwd");
    expect(cwd).toBeTruthy();
  });

  test("게이트 blob 합치기: cross-review가 본 코드 blob은 그대로 두고, 빈 곳만 채우며, 둘 다 본 파일의 blob이 다르면 거절한다", () => {
    const slop = { checked: true, artifacts: [{ path: "README.md", sha256: "h" }], gateBlobs: { "README.md": "b-readme", "src/a.ts": "b-slop-view", "src/other.ts": "b-other" } };
    const crossReview = { "src/a.ts": "b-reviewed", "src/other.ts": "b-other", "README.md": "b-readme" };
    expect(mergeGateBlobs(crossReview, slop)).toEqual({ "README.md": "b-readme", "src/a.ts": "b-reviewed", "src/other.ts": "b-other" });
    expect(mergeGateBlobs(undefined, slop)).toEqual(slop.gateBlobs);
    expect(mergeGateBlobs(crossReview, { checked: true, artifacts: [] })).toBe(crossReview);
    expect(() => mergeGateBlobs({ ...crossReview, "README.md": "b-older" }, slop)).toThrow(SlopGateRefusal);
  });
});

describe("심사와 통과 기록", () => {
  test("finding이 있으면 통과가 없고, 고친 새 내용이 깨끗하면 그 내용에 통과가 기록된다", async () => {
    const cwd = scratch();
    const file = join(cwd, "guide.md");
    writeFileSync(file, KO_SLOP);
    const reviewer = fakeReviewer((ids) => dirty(ids));
    const first = await reviewFiles(["guide.md"], undefined, deps(cwd, reviewer.complete), signal);
    expect(first.files[0]).toMatchObject({ file: "guide.md", status: "findings" });
    expect(first.files[0]!.findings![0]).toMatchObject({ id: "R-OAI-1", file: "guide.md", quote: "혁신적인 솔루션", rule: "humanizer:14 AI 어휘", quoteFound: true, reviewer: "openai" });
    expect(first.files[0]!.findings!.map((finding) => finding.id)).toEqual(["R-OAI-1", "R-GGL-1"]);
    expect(passFor(readSlopRecords(join(cwd, "ledger.jsonl")), sha256(KO_SLOP))).toBeUndefined();
    // 규칙 본문이 그대로 실린다(의역 없음).
    expect(reviewer.calls[0]).toContain("humanizer: 한국어 AI 작문 패턴 감지 및 교정기");

    writeFileSync(file, KO_PLAIN);
    const second = await reviewFiles(["guide.md"], undefined, deps(cwd, fakeReviewer(clean).complete), signal);
    expect(second.files[0]).toMatchObject({ status: "pass", sha256: sha256(KO_PLAIN) });
    expect(passFor(readSlopRecords(join(cwd, "ledger.jsonl")), sha256(KO_PLAIN))).toMatchObject({ model: "fixture/openai + fixture/google", findings: [] });
  });

  test("통과한 내용은 모델을 다시 부르지 않고, 한 바이트만 바뀌어도 새로 심사한다", async () => {
    const cwd = scratch();
    const file = join(cwd, "guide.md");
    writeFileSync(file, KO_PLAIN);
    const reviewer = fakeReviewer(clean);
    await reviewFiles(["guide.md"], undefined, deps(cwd, reviewer.complete), signal);
    expect(reviewer.calls).toHaveLength(1);
    const again = await reviewFiles(["guide.md"], undefined, deps(cwd, reviewer.complete), signal);
    expect(again.files[0]!.status).toBe("already-passed");
    expect(reviewer.calls).toHaveLength(1);
    writeFileSync(file, `${KO_PLAIN} `);
    const changed = await reviewFiles(["guide.md"], undefined, deps(cwd, reviewer.complete), signal);
    expect(changed.files[0]!.status).toBe("pass");
    expect(reviewer.calls).toHaveLength(2);
  });

  test("여러 파일은 한 호출에 묶고, 고친 파일을 다시 심사할 때는 이전 finding을 함께 보낸다", async () => {
    const cwd = scratch();
    writeFileSync(join(cwd, "a.md"), KO_SLOP);
    writeFileSync(join(cwd, "b.md"), KO_PLAIN);
    const reviewer = fakeReviewer((ids, prompt) => ({
      files: ids.map((id) => ({ id, findings: id === "a1" && !prompt.includes("<previous-round") ? dirty([id]).files[0]!.findings : [] })),
    }));
    const first = await reviewFiles(["a.md", "b.md"], undefined, deps(cwd, reviewer.complete), signal);
    expect(reviewer.calls).toHaveLength(1);
    expect(first.files.map((file) => file.status).sort()).toEqual(["findings", "pass"]);
    writeFileSync(join(cwd, "a.md"), `${KO_SLOP}한 줄을 더 고쳤다.\n`);
    await reviewFiles(["a.md"], undefined, deps(cwd, reviewer.complete), signal);
    expect(reviewer.calls[1]).toContain("<previous-round");
    expect(reviewer.calls[1]).toContain("R-OAI-1 humanizer:14 AI 어휘");
  });

  test("추출·모델·해석 실패와 빠진 파일은 통과가 아니다", async () => {
    const cwd = scratch();
    writeFileSync(join(cwd, "a.md"), KO_PLAIN);
    writeFileSync(join(cwd, "empty.md"), "   \n");
    const failing = await reviewFiles(["a.md"], undefined, deps(cwd, async () => { throw new Error("outage"); }), signal);
    expect(failing.files[0]).toMatchObject({ status: "error" });
    expect(failing.files[0]!.error).toContain("outage");
    const junk = await reviewFiles(["a.md"], undefined, deps(cwd, async () => ({ model: "m", text: "looks fine to me" })), signal);
    expect(junk.files[0]!.status).toBe("error");
    const skipped = await reviewFiles(["a.md"], undefined, deps(cwd, async () => ({ model: "m", text: "{\"files\":[]}" })), signal);
    expect(skipped.files[0]!.error).toContain("skipped");
    const empty = await reviewFiles(["empty.md"], undefined, deps(cwd, fakeReviewer(clean).complete), signal);
    expect(empty.files[0]!.error).toContain("no extractable text");
    expect(readSlopRecords(join(cwd, "ledger.jsonl")).filter((record) => record.type === "slop-pass")).toEqual([]);
  });

  test("cwd 밖·없는 파일·비밀 경로는 모델에 보내지 않고 거절한다", async () => {
    const cwd = scratch();
    const outside = join(scratch(), "x.md");
    writeFileSync(outside, KO_PLAIN);
    writeFileSync(join(cwd, "secret-notes.md"), KO_PLAIN);
    const reviewer = fakeReviewer(clean);
    const result = await reviewFiles([outside, "missing.md", "secret-notes.md"], undefined, deps(cwd, reviewer.complete), signal);
    expect(result.files.map((file) => file.status)).toEqual(["error", "error", "error"]);
    expect(reviewer.calls).toHaveLength(0);
  });
});

describe("reviewer 배정: cross_review와 같은 reviewerFamilies", () => {
  const write = (cwd: string) => writeFileSync(join(cwd, "a.md"), KO_PLAIN);
  const families = (reviewer: ReturnType<typeof fakeReviewer>) => reviewer.all.map((call) => call.family).sort();

  test("Anthropic 저자는 openai 필수 + google 자문 reviewer를 병렬로 부르고, OpenAI 저자는 anthropic 필수가 된다", async () => {
    const cwd = scratch();
    write(cwd);
    const first = fakeReviewer(clean);
    await reviewFiles(["a.md"], undefined, deps(cwd, first.complete), signal);
    expect(families(first)).toEqual(["google", "openai"]);
    const second = fakeReviewer(clean);
    writeFileSync(join(cwd, "a.md"), `${KO_PLAIN} `);
    await reviewFiles(["a.md"], undefined, deps(cwd, second.complete, { authors: ["openai-codex/fixture-author"] }), signal);
    expect(families(second)).toEqual(["anthropic", "google"]);
  });

  test("Google 저자는 자문 reviewer가 빠지고 cross_review가 정한 필수 reviewer만 부른다", async () => {
    const cwd = scratch();
    write(cwd);
    const reviewer = fakeReviewer(clean);
    await reviewFiles(["a.md"], undefined, deps(cwd, reviewer.complete, { authors: ["google-vertex/gemini-fixture"] }), signal);
    expect(families(reviewer)).toEqual(["anthropic"]);
  });

  test("자문 reviewer의 실패·해석 불가는 기록만 하고 통과를 막지 않는다", async () => {
    const cwd = scratch();
    write(cwd);
    for (const mode of ["throw", "junk"] as const) {
      writeFileSync(join(cwd, "a.md"), `${KO_PLAIN}${mode}`);
      const out = await reviewFiles(["a.md"], undefined, deps(cwd, fakeReviewer(clean, { google: mode }).complete), signal);
      expect(out.files[0]!.status).toBe("pass");
      expect(out.advisoryReviewers?.[0]).toContain("google");
    }
  });

  test("필수 reviewer의 실패·해석 불가는 통과가 아니다", async () => {
    const cwd = scratch();
    write(cwd);
    for (const mode of ["throw", "junk"] as const) {
      const out = await reviewFiles(["a.md"], undefined, deps(cwd, fakeReviewer(clean, { openai: mode }).complete), signal);
      expect(out.files[0]!.status).toBe("error");
      expect(out.files[0]!.error).toContain("required reviewer (openai)");
    }
    expect(readSlopRecords(join(cwd, "ledger.jsonl")).some((record) => record.type === "slop-pass")).toBe(false);
  });

  test("자문 reviewer가 낸 finding도 닫기 전에는 통과가 없고, 같은 resolve로 닫는다", async () => {
    const cwd = scratch();
    write(cwd);
    const out = await reviewFiles(["a.md"], undefined, deps(cwd, fakeReviewer((ids, _prompt, family) => (family === "google" ? dirty(ids) : clean(ids))).complete), signal);
    expect(out.files[0]).toMatchObject({ status: "findings" });
    expect(out.files[0]!.findings!.map((finding) => finding.id)).toEqual(["R-GGL-1"]);
    const closed = resolveFindings(out.reviewId!, [{ id: "R-GGL-1", status: "refuted", evidence: "공식 상품명 인용이라 바꿀 수 없다" }], deps(cwd, fakeReviewer(clean).complete));
    expect(closed.passed).toEqual([join(cwd, "a.md")]);
  });
});

describe("delta 심사: git이 추적하는 파일은 HEAD 대비 바뀐 글만", () => {
  const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  const OLD = "## 0.1.0\n\n이 도구는 혁신적인 솔루션입니다. 결론적으로 지속가능한 효과적인 경험을 제공합니다.\n\n## 0.0.9\n\n저장 버튼이 생겼다.\n";
  function repo(): string {
    const cwd = scratch();
    git(cwd, "init", "-q");
    writeFileSync(join(cwd, "CHANGELOG.md"), OLD);
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "base");
    return cwd;
  }
  const real = (cwd: string, complete: Complete) => deps(cwd, complete, { head: undefined });
  const shownTo = (reviewer: ReturnType<typeof fakeReviewer>) => reviewer.calls[0]!.slice(reviewer.calls[0]!.indexOf("<artifact id="));

  test("HEAD부터 있던 슬롭 문장은 보내지 않고, 깨끗한 줄만 더하면 통과한다", async () => {
    const cwd = repo();
    writeFileSync(join(cwd, "CHANGELOG.md"), `## 0.2.0\n\n목록 정렬 기준을 이름순으로 바꿨다.\n\n${OLD}`);
    const reviewer = fakeReviewer(clean);
    const out = await reviewFiles(["CHANGELOG.md"], undefined, real(cwd, reviewer.complete), signal);
    const shown = shownTo(reviewer);
    expect(shown).toContain("+ 목록 정렬 기준을 이름순으로 바꿨다.");
    expect(shown).toContain('scope="delta(');
    expect(shown).not.toContain("혁신적인 솔루션");
    expect(out.files[0]).toMatchObject({ status: "pass", sha256: sha256(readFileSync(join(cwd, "CHANGELOG.md"))) });
    expect(out.files[0]!.scope).toStartWith("delta(");
  });

  test("추가한 줄의 슬롭은 심사하고, 그 finding은 전체 파일이 아닌 delta 줄을 가리킨다", async () => {
    const cwd = repo();
    writeFileSync(join(cwd, "CHANGELOG.md"), `## 0.2.0\n\n새 기능은 혁신적인 솔루션을 제공한다.\n\n${OLD}`);
    const reviewer = fakeReviewer((ids) => dirty(ids));
    const out = await reviewFiles(["CHANGELOG.md"], undefined, real(cwd, reviewer.complete), signal);
    expect(shownTo(reviewer)).toContain("+ 새 기능은 혁신적인 솔루션을 제공한다.");
    expect(out.files[0]!.status).toBe("findings");
  });

  test("삭제·이동뿐이면 모델을 부르지 않고 통과하며, 추적하지 않는 파일은 전체를 본다", async () => {
    const cwd = repo();
    writeFileSync(join(cwd, "CHANGELOG.md"), "## 0.0.9\n\n저장 버튼이 생겼다.\n");
    const reviewer = fakeReviewer(clean);
    const removed = await reviewFiles(["CHANGELOG.md"], undefined, real(cwd, reviewer.complete), signal);
    expect(removed.files[0]).toMatchObject({ status: "pass" });
    expect(reviewer.all).toHaveLength(0);
    writeFileSync(join(cwd, "NEW.md"), OLD);
    await reviewFiles(["NEW.md"], undefined, real(cwd, reviewer.complete), signal);
    expect(shownTo(reviewer)).toContain("혁신적인 솔루션");
    expect(shownTo(reviewer)).toContain('scope="whole"');
  });
});

describe("resolve: 반박으로만 닫고, 심사한 바이트에서만 통과", () => {
  async function reviewed(cwd: string) {
    writeFileSync(join(cwd, "a.md"), KO_SLOP);
    const out = await reviewFiles(["a.md"], undefined, deps(cwd, fakeReviewer((ids, _prompt, family) => (family === "google" ? clean(ids) : dirty(ids))).complete), signal);
    return { reviewId: out.reviewId!, id: out.files[0]!.findings![0]!.id };
  }

  test("모든 finding을 근거와 함께 반박하고 파일이 그대로면 통과가 기록된다", async () => {
    const cwd = scratch();
    const { reviewId, id } = await reviewed(cwd);
    const result = resolveFindings(reviewId, [{ id, status: "refuted", evidence: "공식 상품명을 그대로 인용한 문장이라 고칠 수 없다" }], deps(cwd, async () => { throw new Error("no model"); }));
    expect(result).toMatchObject({ passed: [join(cwd, "a.md")], open: [], stale: [], rejected: [] });
    expect(passFor(readSlopRecords(join(cwd, "ledger.jsonl")), sha256(KO_SLOP))?.findings).toMatchObject([{ id, status: "refuted" }]);
  });

  test("fixed·limit 선언, 근거 없는 반박, 모르는 id는 거절되고 통과가 없다", async () => {
    const cwd = scratch();
    const { reviewId, id } = await reviewed(cwd);
    const result = resolveFindings(reviewId, [
      { id, status: "fixed", evidence: "고쳤다고 주장하는 긴 문장입니다" },
      { id, status: "limit", evidence: "한계로 받아들이는 긴 문장입니다" },
      { id, status: "refuted", evidence: "짧다" },
      { id: "F999", status: "refuted", evidence: "그런 finding은 이 심사에 없다고 해도" },
    ], deps(cwd, async () => { throw new Error("no model"); }));
    expect(result.rejected.map((item) => item.id)).toEqual([id, id, id, "F999"]);
    expect(result.passed).toEqual([]);
    expect(result.open).toEqual([id]);
    expect(readSlopRecords(join(cwd, "ledger.jsonl")).some((record) => record.type === "slop-pass")).toBe(false);
  });

  test("반박한 뒤 파일이 바뀌었으면 통과가 아니고 새 심사를 요구한다", async () => {
    const cwd = scratch();
    const { reviewId, id } = await reviewed(cwd);
    writeFileSync(join(cwd, "a.md"), KO_PLAIN);
    const result = resolveFindings(reviewId, [{ id, status: "refuted", evidence: "공식 상품명을 그대로 인용한 문장이다" }], deps(cwd, async () => { throw new Error("no model"); }));
    expect(result.stale).toEqual([join(cwd, "a.md")]);
    expect(result.passed).toEqual([]);
  });

  test("slop_check resolve는 subagent 세션에서 거절된다", async () => {
    const cwd = scratch();
    const { reviewId, id } = await reviewed(cwd);
    const call = executeSlopCheck({ action: "resolve", reviewId, resolutions: [{ id, status: "refuted", evidence: "근거를 적은 긴 문장입니다" }] }, { agent: { kind: "sub" }, cwd } as never, deps(cwd, fakeReviewer(clean).complete), signal);
    await expect(call).rejects.toThrow("Main-only");
  });
});

describe("추출", () => {
  test("html은 태그·script·style을 걷고 alt·placeholder는 더하며, 언어 팩은 문자열 값만 읽는다", () => {
    const text = htmlText("<html><style>a{color:red}</style><body><h1>제목</h1><p>본문 &amp; 설명</p><img alt=\"로고 그림\"><script>var x='코드'</script></body></html>");
    expect(text).toContain("제목");
    expect(text).toContain("본문 & 설명");
    expect(text).toContain("[attr] 로고 그림");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("코드");
    expect(jsonStrings({ a: { b: "안녕하세요" }, n: 3, list: ["하나"] })).toEqual(["a.b: 안녕하세요", "list[0]: 하나"]);
    expect(literalStrings("import x from \"../types\";\nexport const m = { \"a.title\": \"Open repository\", n: 'x' };")).toEqual(["Open repository", "x"]);
    // 한 단어 값·여러 줄 백틱 템플릿·이어 붙인 리터럴도 문구로 읽고, 객체 키와 import 경로만 뺀다.
    expect(literalStrings("import a from './a';\nexport default {\n  save: 'Save',\n  welcome: `Welcome to\nour app ${name}`,\n  hint: 'Press ' + 'Enter to send',\n};")).toEqual(["Save", "Welcome to\nour app ${name}", "Press ", "Enter to send"]);
  });

  test("답 해석: 펜스·앞뒤 말은 걷고, quote·rule이 빠진 finding은 답 전체를 거절한다", () => {
    expect(parseAnswer("결과:\n```json\n{\"files\":[{\"id\":\"a1\",\"findings\":[]}]}\n```")).toEqual({ files: [{ id: "a1", findings: [] }] });
    expect(parseAnswer("{\"files\":[{\"id\":\"a1\",\"findings\":[{\"quote\":\"\",\"rule\":\"x\",\"fix\":\"y\"}]}]}")).toBeUndefined();
    expect(parseAnswer("no json")).toBeUndefined();
    // 같은 파일 id가 두 번이면 깨끗한 항목 뒤에 finding을 숨길 수 있어 답 전체를 거절한다.
    expect(parseAnswer("{\"files\":[{\"id\":\"a1\",\"findings\":[]},{\"id\":\"a1\",\"findings\":[{\"quote\":\"q\",\"rule\":\"r\",\"fix\":\"f\"}]}]}")).toBeUndefined();
  });

  test.skipIf(!existsSync(pythonPath()))("pptx에서 슬라이드·표·노트 글을 뽑는다(관리 Python 환경)", async () => {
    const dir = scratch();
    const deck = join(dir, "deck.pptx");
    const make = Bun.spawnSync([pythonPath(), "-c", [
      "from pptx import Presentation", "p = Presentation()", "s = p.slides.add_slide(p.slide_layouts[1])",
      "s.shapes.title.text = '분기 보고'", "s.placeholders[1].text = '매출이 올랐다'", "s.notes_slide.notes_text_frame.text = '발표 메모'", `p.save(${JSON.stringify(deck)})`,
    ].join("\n")]);
    expect(make.exitCode).toBe(0);
    const extracted = await extractVisible(deck);
    expect(extracted).toMatchObject({ kind: "office" });
    expect(extracted.text).toContain("분기 보고");
    expect(extracted.text).toContain("매출이 올랐다");
    expect(extracted.text).toContain("[notes] 발표 메모");
  });
});

describe("턴 끝 게이트: 저장소 밖 산출물", () => {
  type Handler = (event: Record<string, unknown>, ctx: unknown) => void;
  function session(cwd: string, tools = ["slop_check"]) {
    const handlers: Record<string, Handler[]> = {};
    const sent: { customType: string; content: string; display: boolean }[] = [];
    const deliveries: unknown[] = [];
    slopGate({
      zod, registerTool: () => {}, getActiveTools: () => tools,
      on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); },
      sendMessage: (message: (typeof sent)[number], options: unknown) => { sent.push(message); deliveries.push(options); },
    } as unknown as ExtensionAPI);
    const ctx = { cwd, agent: { kind: "main" } };
    const emit = (name: string, event: Record<string, unknown>) => { for (const handler of handlers[name] ?? []) handler(event, ctx); };
    return {
      sent, deliveries,
      input: () => emit("input", { source: "interactive", text: "보고서 만들어줘" }),
      tool: (toolName: string, input: Record<string, unknown>) => emit("tool_result", { toolName, input, isError: false, content: [] }),
      end: (extra: Record<string, unknown> = {}) => emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }], ...extra }),
    };
  }
  const setup = () => {
    const cwd = scratch();
    process.env.OMP_SLOP_GATE_LEDGER = join(cwd, "ledger.jsonl");
    return cwd;
  };

  test("bash가 만든 저장소 밖 .pptx에 통과가 없으면 끝내지 않고 이어 가게 하고, 두 번 뒤에는 보이는 경고만 남긴다", () => {
    const cwd = setup();
    const s = session(cwd);
    s.input();
    writeFileSync(join(cwd, "deck.pptx"), "PK-fake-deck");
    s.tool("bash", { command: "python build_deck.py --out deck.pptx" });
    s.end();
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ customType: CONTINUATION_TYPE, display: false });
    expect(s.sent[0]!.content).toContain(join(cwd, "deck.pptx"));
    expect(s.sent[0]!.content).toContain("slop_check");
    expect(s.deliveries[0]).toEqual({ deliverAs: "aside" });
    s.end();
    expect(s.sent).toHaveLength(2);
    s.end();
    expect(s.sent[2]).toMatchObject({ customType: WARNING_TYPE, display: true });
    s.end();
    expect(s.sent).toHaveLength(3);
  });

  test("현재 내용에 통과가 있으면 이어 가지 않고, 통과 뒤에 바이트가 바뀌면 다시 이어 간다", () => {
    const cwd = setup();
    const s = session(cwd);
    s.input();
    const deck = join(cwd, "deck.pptx");
    writeFileSync(deck, "PK-fake-deck");
    appendSlopRecord(join(cwd, "ledger.jsonl"), { type: "slop-pass", path: deck, sha256: sha256("PK-fake-deck"), reviewedAt: "2026-10-26T00:00:00Z", model: "fake", reviewId: "r", findings: [] });
    s.tool("write", { path: "deck.pptx" });
    s.end();
    expect(s.sent).toHaveLength(0);
    writeFileSync(deck, "PK-fake-deck-edited");
    s.end();
    expect(s.sent).toHaveLength(1);
  });

  test("이번 입력에서 쓰지 않은 파일·git 안 파일·내부 기록·코드는 이어 가지 않는다", () => {
    const cwd = setup();
    const old = join(cwd, "old.docx");
    writeFileSync(old, "old");
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(old, past, past);
    const s = session(cwd);
    s.input();
    s.tool("bash", { command: "cat old.docx; node tool.mjs notes.ts" });
    mkdirSync(join(cwd, "doc", "history"), { recursive: true });
    writeFileSync(join(cwd, "doc", "history", "record.md"), "내부 기록");
    writeFileSync(join(cwd, "tool.ts"), "export {}");
    s.tool("write", { path: "doc/history/record.md" });
    s.tool("write", { path: "tool.ts" });
    s.end();
    expect(s.sent).toHaveLength(0);

    const repo = setup();
    mkdirSync(join(repo, ".git"));
    const inGit = session(repo);
    inGit.input();
    writeFileSync(join(repo, "README.md"), "# 소개\n");
    inGit.tool("write", { path: "README.md" });
    inGit.end();
    expect(inGit.sent).toHaveLength(0);
  });

  test("추가 실행이 예정된 종료·중단된 턴·slop_check가 없는 세션은 이어 가지 않고, 없는 세션은 경고만 남긴다", () => {
    const cwd = setup();
    const s = session(cwd);
    s.input();
    writeFileSync(join(cwd, "r.html"), "<p>x</p>");
    s.tool("write", { path: "r.html" });
    s.end({ willContinue: true });
    s.end({ messages: [{ role: "assistant", stopReason: "aborted" }] });
    expect(s.sent).toHaveLength(0);
    const noTool = session(cwd, []);
    noTool.input();
    noTool.tool("write", { path: "r.html" });
    noTool.end();
    expect(noTool.sent).toHaveLength(1);
    expect(noTool.sent[0]).toMatchObject({ customType: WARNING_TYPE, display: true });
  });

  test("명령에 적힌 Windows 경로·따옴표 경로를 후보로 읽고 홈·/mnt 드라이브 밖과 /tmp는 보지 않는다", () => {
    const found = candidatesOf("bash", { command: "soffice --convert-to pdf \"C:\\Users\\user\\Desktop\\월간 보고.docx\" && cp a.xlsx /home/user/other/a.xlsx" }, "/home/user/work");
    expect(found.files).toEqual(["/mnt/c/Users/user/Desktop/월간 보고.docx", "/home/user/work/a.xlsx", "/home/user/other/a.xlsx"]);
    expect(candidatesOf("bash", { command: "cp a.xlsx /tmp/a.xlsx && cp b.md /etc/b.md" }, "/home/user/work").files).toEqual(["/home/user/work/a.xlsx", "/home/user/work/b.md"]);
    expect(candidatesOf("bash", { command: "ls /mnt/c/Users/user/Downloads" }, "/home/user/work").dirs).toEqual(["/mnt/c/Users/user/Downloads"]);
    expect(candidatesOf("draft", { output: "out/report.docx" }, "/home/user/work").files).toEqual(["/home/user/work/out/report.docx"]);
    expect(candidatesOf("edit", { input: "[docs/guide.md#AB12]\nPUT 1.=1:\n+x" }, "/home/user/work").files).toEqual(["/home/user/work/docs/guide.md"]);
  });
});

describe("심사 정확성: 같은 바이트·중복 id·html 크기와 속성", () => {
  test("추출기가 원본 파일을 바꿔도 통과는 심사한 바이트에 묶이고, 바뀐 내용에는 통과가 없다", async () => {
    const cwd = scratch();
    const file = join(cwd, "guide.md");
    writeFileSync(file, KO_PLAIN);
    const reviewer = fakeReviewer(clean);
    const out = await reviewFiles(["guide.md"], undefined, deps(cwd, reviewer.complete, {
      extract: async (copy) => {
        writeFileSync(file, KO_SLOP);
        return { text: readFileSync(copy, "utf8"), kind: "prose", leads: [] };
      },
    }), signal);
    expect(out.files[0]).toMatchObject({ status: "pass", sha256: sha256(KO_PLAIN) });
    expect(reviewer.calls[0]).toContain("저장 버튼을 누르면");
    expect(reviewer.calls[0]).not.toContain("혁신적인 솔루션");
    const records = readSlopRecords(join(cwd, "ledger.jsonl"));
    expect(passFor(records, sha256(KO_PLAIN))).toBeDefined();
    expect(passFor(records, sha256(KO_SLOP))).toBeUndefined();
  });

  test("필수 reviewer 답에 같은 파일 id가 두 번 나오면 통과가 없고, 자문 reviewer의 중복은 기록만 한다", async () => {
    const cwd = scratch();
    writeFileSync(join(cwd, "a.md"), KO_PLAIN);
    const twice = (ids: string[]) => ({ files: [...clean(ids).files, { id: ids[0]!, findings: [{ quote: "저장 버튼", rule: "humanizer:1 x", fix: "y" }] }] });
    const required = await reviewFiles(["a.md"], undefined, deps(cwd, fakeReviewer((ids, _p, family) => (family === "google" ? clean(ids) : twice(ids))).complete), signal);
    expect(required.files[0]).toMatchObject({ status: "error" });
    expect(required.files[0]!.error).toContain("required reviewer (openai) unparsable");
    expect(readSlopRecords(join(cwd, "ledger.jsonl")).some((record) => record.type === "slop-pass")).toBe(false);
    const advisory = await reviewFiles(["a.md"], undefined, deps(cwd, fakeReviewer((ids, _p, family) => (family === "google" ? twice(ids) : clean(ids))).complete), signal);
    expect(advisory.files[0]).toMatchObject({ status: "pass" });
    expect(advisory.advisoryReviewers?.[0]).toContain("google: unparsable");
  });

  test("언어 팩 형식인데 문구가 하나도 없으면 모델 없이 그 내용에 통과를 남긴다(코드만 든 파일이 막히지 않는다)", async () => {
    const cwd = scratch();
    mkdirSync(join(cwd, "i18n"));
    writeFileSync(join(cwd, "i18n", "format.ts"), "export const fmt = (n: number) => n.toFixed(2);\n");
    const reviewer = fakeReviewer(clean);
    const out = await reviewFiles(["i18n/format.ts"], undefined, deps(cwd, reviewer.complete), signal);
    expect(out.files[0]).toMatchObject({ status: "pass" });
    expect(reviewer.all).toHaveLength(0);
  });

  test("실제 추출기: 한 글자·슬래시가 든 짧은 문구('开', 'On/Off')도 빈 글이 아니라 reviewer에게 간다", async () => {
    const cwd = scratch();
    mkdirSync(join(cwd, "locales"));
    writeFileSync(join(cwd, "locales", "index.ts"), "import x from './x';\nexport default { toggle: 'On/Off', action: 'Save/Cancel', open: '开' };\n");
    expect(literalStrings(readFileSync(join(cwd, "locales", "index.ts"), "utf8"))).toEqual(["On/Off", "Save/Cancel", "开"]);
    expect(literalStrings("import a from './a';\nexport default { help: '/help', start: '/start', api: '/api/users', file: 'a/b.json', mod: '@/x' };")).toEqual(["/help", "/start"]);
    const reviewer = fakeReviewer(clean);
    const out = await reviewFiles(["locales/index.ts"], "en", deps(cwd, reviewer.complete, { extract: undefined }), signal);
    expect(out.files[0]).toMatchObject({ status: "pass" });
    expect(reviewer.calls).toHaveLength(1);
    for (const phrase of ["On/Off", "Save/Cancel", "开"]) expect(reviewer.calls[0]).toContain(phrase);
  });

  test("실제 추출기: 템플릿·이어 붙인 문구가 든 언어 팩은 빈 글로 통과하지 않고 reviewer에게 간다", async () => {
    const cwd = scratch();
    mkdirSync(join(cwd, "src", "i18n"), { recursive: true });
    writeFileSync(join(cwd, "src", "i18n", "en.ts"), "export default {\n  welcome: `Welcome to our\n  innovative application`,\n  hint: 'Press ' + 'Enter to send',\n  save: 'Save',\n};\n");
    const reviewer = fakeReviewer(clean);
    const out = await reviewFiles(["src/i18n/en.ts"], "en", deps(cwd, reviewer.complete, { extract: undefined }), signal);
    expect(out.files[0]).toMatchObject({ status: "pass" });
    expect(reviewer.calls).toHaveLength(1);
    for (const phrase of ["Welcome to our", "innovative application", "Enter to send", "Save"]) expect(reviewer.calls[0]).toContain(phrase);
  });

  test("html 속성은 큰따옴표·작은따옴표·따옴표 없는 값을 모두 읽는다", () => {
    const text = htmlText("<img alt='혁신적인 솔루션 로고'><input placeholder=검색어를입력하세요><a title=\"링크 설명\">x</a><meta content=\"\">");
    expect(text).toContain("[attr] 혁신적인 솔루션 로고");
    expect(text).toContain("[attr] 검색어를입력하세요");
    expect(text).toContain("[attr] 링크 설명");
  });

  test("html 원문이 한도를 넘으면 잘라서 통과시키지 않고 통과 없음 오류를 낸다. 뒤쪽 슬롭도 보인다", async () => {
    const cwd = scratch();
    const filler = "<p>저장 버튼을 누르면 파일이 내려받기 폴더에 들어갑니다.</p>\n".repeat(2000);
    writeFileSync(join(cwd, "huge.html"), `<html><body>${filler}</body></html>`);
    const reviewer = fakeReviewer(clean);
    const out = await reviewFiles(["huge.html"], undefined, deps(cwd, reviewer.complete, { extract: undefined }), signal);
    expect(out.files[0]).toMatchObject({ status: "error" });
    expect(out.files[0]!.error).toContain("no pass");
    expect(reviewer.all).toHaveLength(0);
    // 한도 안이면 원문 끝까지 모델에 간다(40,000자 뒤의 CSS도 잘리지 않는다).
    const mid = "<p>입고 화면에서 품번을 입력하고 저장을 누르면 재고가 늘어납니다.</p>\n".repeat(500);
    writeFileSync(join(cwd, "mid.html"), `<html><body>${mid}</body><style>.tail{background:linear-gradient(135deg,#6366f1,#8b5cf6)}</style></html>`);
    const mine = fakeReviewer(clean);
    await reviewFiles(["mid.html"], undefined, deps(cwd, mine.complete, { extract: undefined }), signal);
    expect(mine.calls[0]).toContain("linear-gradient(135deg,#6366f1,#8b5cf6)");
  });
});

describe("원장 형식", () => {
  test("원장은 0600이고 한 줄씩 덧붙으며 깨진 줄은 건너뛴다", () => {
    const dir = scratch();
    const path = join(dir, "ledger.jsonl");
    appendSlopRecord(path, { type: "slop-pass", path: "/x/a.md", sha256: "aa", reviewedAt: "t", model: "m", reviewId: "r", findings: [] });
    writeFileSync(path, `${readFileSync(path, "utf8")}{"type":"slop-pass","broken\n`, "utf8");
    appendSlopRecord(path, { type: "slop-pass", path: "/x/b.md", sha256: "bb", reviewedAt: "t", model: "m", reviewId: "r", findings: [] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readSlopRecords(path).map((record) => record.type === "slop-pass" && record.sha256)).toEqual(["aa", "bb"]);
  });
});
