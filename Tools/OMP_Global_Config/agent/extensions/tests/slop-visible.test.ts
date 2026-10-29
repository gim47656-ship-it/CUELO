import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zod from "@oh-my-pi/omptype/zod";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import slopGate, { CONTINUATION_TYPE } from "../slop-gate";
import { classify, runSlopGate, SlopGateRefusal } from "../lib/slop-gate";
import { reviewFiles, type Complete, type SlopDeps } from "../slop-gate/review";

// 사용자 결정 2026-10-29(2026-10-27의 "보이는 형식 전부"를 대체): 슬롭 게이트 대상은 사람이 실제로 보는 산출물(슬라이드·html·Office·pdf·보고 csv·UI 문구)이다.
// 마크다운은 위치와 관계없이 대상이 아니고 `.slop-gate.json` visible glob이 선언한 것만 대상이다. 공개 선언(.publicignore·public:true)은 대상을 정하지 않는다. 내부 기록·코드·테스트는 그대로 빠진다.

const roots: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "slop-visible-test-"));
  roots.push(dir);
  return dir;
};
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); delete process.env.OMP_SLOP_GATE_LEDGER; });

const signal = new AbortController().signal;
const KO_PLAIN = "저장 버튼을 누르면 파일이 내려받기 폴더에 들어간다.\n한 번 더 누르면 같은 이름 뒤에 번호가 붙는다. 실패하면 빨간 줄로 이유를 보여 준다.\n";
const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
const put = (cwd: string, path: string, text: string) => { mkdirSync(join(cwd, path, ".."), { recursive: true }); writeFileSync(join(cwd, path), text); };

function reviewer() {
  const calls: string[] = [];
  const complete: Complete = async (family, _system, prompt) => {
    calls.push(family);
    const ids = [...prompt.matchAll(/<artifact id="(a\d+)"/g)].map((match) => match[1]!);
    return { model: `fixture/${family}`, text: JSON.stringify({ files: ids.map((id) => ({ id, findings: [] })) }) };
  };
  return { calls, complete };
}
/** 공개 선언이 없는 호출(slop_check에 public을 주지 않은 것). 추출은 형식과 무관하게 같은 문장을 돌려준다(pptx·docx 추출기 없이도 돈다). */
function deps(cwd: string, complete: Complete): SlopDeps {
  return {
    cwd, ledgerPath: join(cwd, "ledger.jsonl"), complete, mainModel: "anthropic/fixture-author", advisoryModel: "anthropic/fixture-advisor",
    head: async () => undefined, extract: async () => ({ text: KO_PLAIN, kind: "prose", leads: [] }),
  } as SlopDeps;
}

describe("S3 슬롭 게이트 대상은 보이는 산출물 전부(공개 선언 불필요)", () => {
  test("(a) 선언 없는 git 저장소의 .pptx·.docx·.html 산출물을 slop_check가 심사하고, 커밋 게이트가 요구한다(md는 아니다)", async () => {
    const cwd = scratch();
    git(cwd, "init", "-q");
    put(cwd, ".gitignore", "ledger.jsonl\n");
    for (const path of ["deck.pptx", "report.docx", "page.html"]) put(cwd, path, KO_PLAIN);
    const fake = reviewer();
    const out = await reviewFiles(["deck.pptx", "report.docx", "page.html"], undefined, deps(cwd, fake.complete), signal);
    expect(out.files.map((file) => file.status)).toEqual(["pass", "pass", "pass"]);
    expect(fake.calls.length).toBeGreaterThan(0);
    for (const path of ["deck2.pptx", "report2.docx", "page2.html"]) put(cwd, path, KO_PLAIN.replace("저장", "보관"));
    put(cwd, "guide2.md", KO_PLAIN.replace("저장", "보관"));
    const refused = await runSlopGate({ cwd, files: ["deck2.pptx", "report2.docx", "page2.html", "guide2.md"], ledgerPath: join(cwd, "ledger.jsonl") }).then(() => "", (error: Error) => { expect(error).toBeInstanceOf(SlopGateRefusal); return error.message; });
    expect(refused).toContain("3 visible artifact(s)");
    for (const path of ["deck2.pptx", "report2.docx", "page2.html"]) expect(refused).toContain(`- ${path}`);
    expect(refused).not.toContain("guide2.md");
  });

  test("(b) .publicignore가 미러에서 지우는 보이는 파일(비공개 고객 문서)도 심사하고 요구한다", async () => {
    const cwd = scratch();
    git(cwd, "init", "-q");
    put(cwd, ".gitignore", "ledger.jsonl\n");
    put(cwd, ".publicignore", "/README.md\n/private/\n");
    put(cwd, "private/고객.docx", KO_PLAIN);
    const fake = reviewer();
    const out = await reviewFiles(["private/고객.docx"], undefined, deps(cwd, fake.complete), signal);
    expect(out.files[0]).toMatchObject({ status: "pass" });
    put(cwd, "private/고객2.docx", `${KO_PLAIN}설치 방법은 아래에 있다.\n`);
    const refused = await runSlopGate({ cwd, files: ["private/고객2.docx"], ledgerPath: join(cwd, "ledger.jsonl") }).then(() => "", (error: Error) => error.message);
    expect(refused).toContain("- private/고객2.docx");
  });

  test("(c) 이번 턴에 git 밖에 쓴 선언 없는 보이는 산출물은 턴 끝 게이트를 깨운다", () => {
    const cwd = scratch();
    process.env.OMP_SLOP_GATE_LEDGER = join(cwd, "ledger.jsonl");
    const handlers: Record<string, ((event: Record<string, unknown>, ctx: unknown) => void)[]> = {};
    const sent: { customType: string; content: string }[] = [];
    slopGate({
      zod, registerTool: () => {}, getActiveTools: () => ["slop_check"],
      on: (name: string, handler: (event: Record<string, unknown>, ctx: unknown) => void) => { (handlers[name] ??= []).push(handler); },
      sendMessage: (message: (typeof sent)[number]) => { sent.push(message); },
    } as unknown as ExtensionAPI);
    const emit = (name: string, event: Record<string, unknown>) => { for (const handler of handlers[name] ?? []) handler(event, { cwd, agent: { kind: "main" } }); };
    emit("input", { source: "interactive", text: "고객 발표 자료 만들어줘" });
    writeFileSync(join(cwd, "고객발표.pptx"), "PK-fake-deck");
    emit("tool_result", { toolName: "bash", input: { command: "python build.py --out 고객발표.pptx" }, isError: false, content: [] });
    emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ customType: CONTINUATION_TYPE });
    expect(sent[0]!.content).toContain(join(cwd, "고객발표.pptx"));
  });

  test("(d) HANDOFF.md·doc/history·코드·테스트는 여전히 모델 호출 없이 빠지고, 이유는 분류 이유다", async () => {
    const cwd = scratch();
    git(cwd, "init", "-q");
    put(cwd, ".gitignore", "ledger.jsonl\n");
    const files = ["HANDOFF.md", "doc/history/2026/10/27-x/main.md", "src/app.ts", "tests/guide.md"];
    for (const path of files) put(cwd, path, KO_PLAIN);
    const fake = reviewer();
    const out = await reviewFiles(files, undefined, deps(cwd, fake.complete), signal);
    expect(fake.calls).toHaveLength(0);
    expect(out.files.map((file) => file.status)).toEqual(["internal", "internal", "internal", "internal"]);
    expect(out.files.map((file) => file.reason)).toEqual(["internal prompt or rule file", "internal record", "not a visible format", "test or fixture"]);
    const gate = await runSlopGate({ cwd, files, ledgerPath: join(cwd, "ledger.jsonl") });
    expect(gate.artifacts).toEqual([]);
  });

  test("(e) classify: 마크다운은 위치와 관계없이 대상이 아니고 사람이 보는 형식은 대상이다", () => {
    for (const path of ["README.md", "CHANGELOG.md", "docs/x.md", "doc/README.md", "guide/설치.mdx", "/mnt/d/공유/문서/안내.md"]) expect(classify(path).visible, path).toBe(false);
    expect(classify("README.md").reason).toContain("markdown");
    for (const path of ["deck.html", "manual.pdf", "report.docx", "slides.pptx", "locales/ko.json", "매뉴얼.hwpx", "report-2026.csv"]) expect(classify(path).visible, path).toBe(true);
  });

  test("(f) .slop-gate.json visible glob이 선언한 마크다운만 대상이고, 내부 파일은 선언으로도 못 올린다", () => {
    expect(classify("README.md", { visible: ["README.md"] })).toEqual({ visible: true, reason: "project declared" });
    expect(classify("docs/x.md", { visible: ["README.md"] }).visible).toBe(false);
    expect(classify("HANDOFF.md", { visible: ["*.md"] }).visible).toBe(false);
    expect(classify("doc/history/2026/10/29-x/main.md", { visible: ["**/*.md"] }).visible).toBe(false);
  });

  test("(g) 선언 없는 README.md는 slop_check가 모델 없이 internal로 돌려주고 커밋 게이트도 요구하지 않으며, 선언하면 심사·요구한다", async () => {
    const cwd = scratch();
    git(cwd, "init", "-q");
    put(cwd, ".gitignore", "ledger.jsonl\n");
    put(cwd, "README.md", KO_PLAIN);
    const fake = reviewer();
    const out = await reviewFiles(["README.md"], undefined, deps(cwd, fake.complete), signal);
    expect(out.files[0]).toMatchObject({ status: "internal", reason: expect.stringContaining("markdown") });
    expect(fake.calls).toHaveLength(0);
    expect((await runSlopGate({ cwd, files: ["README.md"], ledgerPath: join(cwd, "ledger.jsonl") })).artifacts).toEqual([]);
    put(cwd, ".slop-gate.json", JSON.stringify({ visible: ["README.md"] }));
    const declared = await reviewFiles(["README.md"], undefined, deps(cwd, fake.complete), signal);
    expect(declared.files[0]).toMatchObject({ status: "pass" });
    put(cwd, "README.md", `${KO_PLAIN}설치 방법은 아래에 있다.\n`);
    const refused = await runSlopGate({ cwd, files: ["README.md"], ledgerPath: join(cwd, "ledger.jsonl") }).then(() => "", (error: Error) => error.message);
    expect(refused).toContain("- README.md");
  });
});
