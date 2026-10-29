import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import draftCoverage from "../draft-coverage";
import { proseBlocks, proseChanges } from "../lib/draft-coverage";

// 사용자 보고(2026-10-27) 모양: HTML 앞 네 문단은 draft 결과를 옮기고, 뒤 세 문단은 직접 썼다.
const DRAFTED = [
  "이번 점검에서는 측정 장비의 통신 지연이 언제 생기는지 먼저 살펴보았습니다. 지연은 주로 교대 시간대에 몰려 있었습니다.",
  "현장 PC의 로그를 모아 보니 같은 시각에 데이터베이스 백업 작업이 함께 돌고 있었습니다. 백업이 끝나면 지연도 사라졌습니다.",
  "그래서 백업 시작 시각을 새벽 세 시로 옮기는 방안을 우선 검토했습니다. 생산 일정에 주는 영향은 없는 것으로 확인했습니다.",
  "변경 뒤 일주일 동안 같은 지표를 다시 기록해 지연이 줄었는지 비교할 계획입니다. 결과는 다음 주 회의에서 공유하겠습니다.",
];
const DIRECT = [
  "추가로 장비 펌웨어 버전이 라인마다 달라서 통신 재시도 횟수에도 차이가 났다는 점을 덧붙입니다. 이 부분은 업체에 문의해 둔 상태입니다.",
  "운영자 화면에는 지연이 길어질 때 경고 색을 바꾸는 표시를 넣으면 현장에서 더 빨리 알아챌 수 있을 것으로 봅니다.",
  "결론적으로 이번 문제는 장비 자체보다 작업 일정의 겹침에서 비롯되었고, 일정 조정만으로도 대부분 해소될 것으로 기대합니다.",
];
// humanizer식 교정: 어미·연결어를 다듬고 수치 하나를 고친 문장.
const EDITED_DRAFT = [
  "이번 점검은 측정 장비의 통신 지연이 언제 생기는지부터 살폈습니다. 지연은 주로 교대 시간대에 몰렸습니다.",
  "현장 PC 로그를 모아 보니 같은 시각에 데이터베이스 백업 작업이 함께 돌았습니다. 백업이 끝나면 지연도 사라졌습니다.",
  "그래서 백업 시작 시각을 새벽 네 시로 옮기는 방안을 먼저 검토했습니다. 생산 일정에 주는 영향은 없었습니다.",
  "변경 뒤 일주일 동안 같은 지표를 다시 기록해 지연이 줄었는지 비교합니다. 결과는 다음 주 회의에서 공유합니다.",
];

const html = (paragraphs: readonly string[]) => `<!doctype html><html><body><main>${paragraphs.map((p) => `<p>${p}</p>`).join("")}</main></body></html>`;
const markdown = (paragraphs: readonly string[]) => `# 점검 결과\n\n${paragraphs.join("\n\n")}\n`;

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;
const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** 확장 하나를 붙인 가짜 세션. 다른 세션(Maker)은 같은 cwd로 두 번째 인스턴스를 만든다. */
function session(cwd: string) {
  const handlers: Record<string, Handler[]> = {};
  const sent: { content: string; options?: unknown }[] = [];
  const pi = {
    on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); },
    sendMessage: (message: { content: string }, options?: unknown) => { sent.push({ content: message.content, options }); },
  };
  draftCoverage(pi as never);
  const ctx = { cwd, agent: { kind: "main" }, sessionManager: { getSessionId: () => "s" } };
  const emit = (name: string, event: Record<string, unknown>) => (handlers[name] ?? []).map((handler) => handler(event, ctx));
  let n = 0;
  return {
    sent,
    input: () => emit("input", { source: "interactive", text: "보고서 HTML 만들어줘" }),
    shutdown: () => emit("session_shutdown", {}),
    call: (toolName: string, input: Record<string, unknown>) => emit("tool_call", { toolName, toolCallId: `c${++n}`, input })[0] as { block?: boolean; reason?: string } | undefined,
    result: (toolName: string, input: Record<string, unknown>, isError = false, text = "model: fake\n\n저장: x") =>
      emit("tool_result", { toolName, toolCallId: `c${n}`, input, isError, content: [{ type: "text", text }] }),
    resultAt: (id: number, toolName: string, input: Record<string, unknown>) =>
      emit("tool_result", { toolName, toolCallId: `c${id}`, input, isError: false, content: [{ type: "text", text: "ok" }] }),
    /** 도구가 실제로 파일을 쓴 것처럼 디스크에 남기고 성공 결과를 보낸다(차단되지 않았을 때만). */
    write(path: string, content: string) {
      const verdict = this.call("write", { path, content });
      if (!verdict?.block) {
        writeFileSync(join(cwd, path), content);
        this.result("write", { path, content }, false, "ok");
      }
      return verdict;
    },
    /** edit 호출. 막히지 않으면 ok에 따라 성공·실패 결과를 보낸다(파일 내용은 판정에 쓰지 않는다: 기준선은 입력마다 고정). */
    edit(path: string, line: string, ok = true) {
      const input = { input: `[${path}#AB12]\nPUT >1:\n+${line}` };
      const verdict = this.call("edit", input);
      if (!verdict?.block) this.result("edit", input, !ok, ok ? "ok" : "stale anchor");
      return verdict;
    },
    draft(output: string, content: string, ok = true) {
      if (ok) writeFileSync(join(cwd, output), content);
      this.result("draft", { instruction: "보고서", output }, !ok, ok ? `model: fake\n\n저장: ${output}` : "model: none\n\nDeepSeek 실패: outage");
    },
  };
}

function workdir(): string {
  const root = mkdtempSync(join(tmpdir(), "draft-coverage-"));
  roots.push(root);
  const cwd = join(root, "work");
  mkdirSync(cwd);
  return cwd;
}

describe("draft-coverage: 쓰기 전에 draft를 거치지 않은 새 글을 멈춘다", () => {
  test("앞 네 문단만 draft하고 뒤 세 문단을 직접 쓴 HTML은 첫 write에서 멈추고 직접 쓴 세 덩어리만 보여 준다", () => {
    const s = session(workdir());
    s.input();
    s.draft("intro.md", markdown(DRAFTED));
    const verdict = s.write("report.html", html([...EDITED_DRAFT, ...DIRECT]));
    expect(verdict?.block).toBe(true);
    for (const p of DIRECT) expect(verdict!.reason).toContain(p.slice(0, 30));
    for (const p of EDITED_DRAFT) expect(verdict!.reason).not.toContain(p.slice(0, 30));
  });

  test("빠진 덩어리를 draft한 뒤 같은 내용을 다시 쓰면 통과한다", () => {
    const s = session(workdir());
    s.input();
    s.draft("intro.md", markdown(DRAFTED));
    expect(s.write("report.html", html([...EDITED_DRAFT, ...DIRECT]))?.block).toBe(true);
    s.draft("rest.md", markdown(DIRECT));
    expect(s.write("report.html", html([...EDITED_DRAFT, ...DIRECT]))?.block).toBeUndefined();
  });

  test("기존 글의 사실 교정과 배치만 바꾼 다시 쓰기는 draft 없이 통과한다", () => {
    const cwd = workdir();
    writeFileSync(join(cwd, "report.html"), html([...DRAFTED, ...DIRECT]));
    const s = session(cwd);
    s.input();
    const relaid = `<section class="grid"><div class="card"><h2>점검</h2>${[...EDITED_DRAFT, ...DIRECT].map((p) => `<div class="cell"><span>${p}</span></div>`).join("")}</div></section>`;
    expect(s.write("report.html", relaid)?.block).toBeUndefined();
  });

  test("실패한 draft와 상관없는 draft는 새 글을 덮지 않는다", () => {
    const s = session(workdir());
    s.input();
    s.draft("rest.md", markdown(DIRECT), false);
    s.draft("other.md", markdown(["사내 동호회 일정은 매월 첫째 주 금요일로 바뀌었으며 참가 신청은 게시판에서 받습니다. 장소는 본관 회의실입니다."]));
    expect(s.write("report.md", markdown(DIRECT))?.block).toBe(true);
  });

  test("draft 뒤에 draft 파일을 손으로 고쳐 넣은 글은 덮이지 않는다(성공 순간의 내용으로 고정)", () => {
    const cwd = workdir();
    const s = session(cwd);
    s.input();
    s.draft("intro.md", markdown(DRAFTED));
    writeFileSync(join(cwd, "intro.md"), markdown([...DRAFTED, ...DIRECT]));
    expect(s.write("report.md", markdown([...DRAFTED, ...DIRECT]))?.block).toBe(true);
  });

  test("다른 세션(Maker)의 draft 결과는 이 세션이 그 파일을 read한 뒤에만 덮는다", () => {
    const cwd = workdir();
    const maker = session(cwd);
    const main = session(cwd);
    maker.input();
    main.input();
    maker.draft("doc/rest.md", (mkdirSync(join(cwd, "doc")), markdown(DIRECT)));
    expect(main.write("report.md", markdown(DIRECT))?.block).toBe(true);
    main.result("read", { path: "doc/rest.md:1-40" });
    expect(main.write("report.md", markdown(DIRECT))?.block).toBeUndefined();
  });

  test("같은 경로에 다시 draft해도 앞 draft 결과는 계속 덮는다", () => {
    const s = session(workdir());
    s.input();
    s.draft("part.md", markdown(DRAFTED));
    s.draft("part.md", markdown(DIRECT));
    expect(s.write("report.md", markdown([...DRAFTED, ...DIRECT]))?.block).toBeUndefined();
  });

  const SENTENCES = DIRECT.flatMap((p) => p.split(/(?<=다\.) /));
  const EXTRA = "점검 일지 양식은 다음 달부터 새 서식으로 바꾸어 쓰기로 했습니다.";

  test("잘게 나눈 edit도 한 입력 안에서 쌓여 문단 이상이 되면 멈춘다", () => {
    const cwd = workdir();
    writeFileSync(join(cwd, "guide.md"), "# 안내\n");
    const s = session(cwd);
    s.input();
    const verdicts = SENTENCES.map((sentence) => s.edit("guide.md", sentence));
    expect(verdicts[0]?.block).toBeUndefined();
    expect(verdicts.some((verdict) => verdict?.block)).toBe(true);
  });

  test("실패한 edit는 쌓이지 않는다", () => {
    const s = session(workdir());
    s.input();
    expect(SENTENCES.map((sentence) => s.edit("guide.md", sentence, false)).some((verdict) => verdict?.block)).toBe(false);
  });

  test("멈춘 뒤 빠진 덩어리를 draft하면 앞서 쌓인 덩어리도 다시 덮인 것으로 본다", () => {
    const s = session(workdir());
    s.input();
    const verdicts = SENTENCES.map((sentence) => s.edit("guide.md", sentence));
    const stop = verdicts.findIndex((verdict) => verdict?.block);
    expect(stop).toBeGreaterThan(0);
    s.draft("rest.md", markdown(DIRECT));
    expect(s.edit("guide.md", SENTENCES[stop]!)?.block).toBeUndefined();
    expect(s.edit("guide.md", EXTRA)?.block).toBeUndefined();
  });

  test("세션이 바뀌면 앞 세션의 draft는 read하기 전에는 덮지 않는다", () => {
    const s = session(workdir());
    s.input();
    s.draft("rest.md", markdown(DIRECT));
    s.shutdown();
    s.input();
    expect(s.write("report.md", markdown(DIRECT))?.block).toBe(true);
  });

  test("같은 파일의 edit 결과가 겹쳐 도착해도 성공한 덩어리는 모두 쌓인다", () => {
    const s = session(workdir());
    s.input();
    const edits = [SENTENCES[0]!, SENTENCES[2]!].map((line) => ({ input: `[guide.md#AB12]\nPUT >1:\n+${line}` }));
    expect(s.call("edit", edits[0]!)?.block).toBeUndefined();
    expect(s.call("edit", edits[1]!)?.block).toBeUndefined();
    s.resultAt(1, "edit", edits[0]!);
    s.resultAt(2, "edit", edits[1]!);
    const verdicts = [SENTENCES[3]!].map((sentence) => s.edit("guide.md", sentence));
    expect(verdicts.some((verdict) => verdict?.block)).toBe(true);
  });

  test("멈춘 호출을 그대로 다시 보내면 한 번은 통과하고, 그 덩어리는 다시 묻지 않지만 새 덩어리는 다시 멈춘다", () => {
    const s = session(workdir());
    s.input();
    const first = markdown(DIRECT);
    expect(s.write("report.md", first)?.block).toBe(true);
    expect(s.write("report.md", first)?.block).toBeUndefined();
    const more = markdown([...DIRECT, "덧붙여 다음 분기에는 라인별 통신 품질 지표를 대시보드에 올려 관리자들이 매일 확인할 수 있게 하는 작업을 진행하려 합니다.", "이를 위해 각 라인 담당자와 일정 협의를 먼저 하고, 필요한 권한 요청도 같은 주에 마무리하겠습니다. 대시보드 초안은 다음 달에 공유합니다."]);
    const verdict = s.write("report.md", more);
    expect(verdict?.block).toBe(true);
    expect(verdict!.reason).not.toContain(DIRECT[0]!.slice(0, 30));
  });

  test("규칙·스킬·테스트 파일과 글이 아닌 파일은 보지 않는다", () => {
    const s = session(workdir());
    s.input();
    expect(s.write("AGENTS.md", markdown(DIRECT))?.block).toBeUndefined();
    expect(s.call("write", { path: "skills/x/guide.md", content: markdown(DIRECT) })?.block).toBeUndefined();
    expect(s.call("write", { path: "notes.ts", content: DIRECT.join("\n") })?.block).toBeUndefined();
  });

  // 2026-10-28 감사: 26회 차단 중 20회가 슬롭 게이트 면제 내부 기록(HANDOFF.md·doc/history·maker 기록)이었다.
  test("슬롭 게이트가 면제하는 내부 기록은 보지 않고, 같은 글의 공개 문서는 계속 멈춘다", () => {
    const s = session(workdir());
    s.input();
    for (const path of ["HANDOFF.md", "Tools/X/HANDOFF.md", "doc/history/2026/10/28-x/main.md", "doc/history/2026/10/28-x/maker-A.md", "doc/README.md"]) {
      expect(s.call("write", { path, content: markdown(DIRECT) })?.block).toBeUndefined();
    }
    expect(s.call("write", { path: "doc/guide.md", content: markdown(DIRECT) })?.block).toBe(true);
    expect(s.call("write", { path: "CHANGELOG.md", content: markdown(DIRECT) })?.block).toBe(true);
  });

  test("bash가 바꾼 글 파일은 내용을 볼 수 없어 한 번만 알린다", () => {
    const cwd = workdir();
    const s = session(cwd);
    s.input();
    const command = "python make.py > out/report.html";
    s.call("bash", { command });
    mkdirSync(join(cwd, "out"));
    writeFileSync(join(cwd, "out/report.html"), html(DIRECT));
    s.result("bash", { command });
    s.call("bash", { command });
    s.result("bash", { command });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.content).toContain("report.html");
    const old = join(cwd, "old.md");
    writeFileSync(old, "x");
    utimesSync(old, new Date(0), new Date(0));
    s.call("bash", { command: "cat old.md" });
    s.result("bash", { command: "cat old.md" });
    expect(s.sent).toHaveLength(1);
  });

  test("CSS-only HTML edits pass while visible paragraphs remain gated", () => {
    const s = session(workdir());
    s.input();
    const css = [".card {", "  background-color: lightgoldenrodyellow;", "  font-family: extraordinarilylongfontfamilyname;", "  border-color: rebeccapurple;", "  /* This stylesheet comment describes the visual presentation of the component. */", "}"].join("\n+");
    expect(s.call("edit", { input: `[report.html#AB12]\nPUT >1:\n+${css}` })?.block).toBeUndefined();
    expect(s.call("edit", { input: `[report.html#AB12]\nPUT >1:\n+<p>${DIRECT.join(" ")}</p>` })?.block).toBe(true);
    // 교차검토 R1-OAI-2: 한 줄 규칙과 한 줄에 선언 여러 개도 CSS다.
    const oneLine = [".card { background-color: lightgoldenrodyellow; font-family: extraordinarilylongfontfamilyname; }", ".badge { border-color: rebeccapurple }", "background-color: lightgoldenrodyellow; font-family: extraordinarilylongfontfamilyname;"];
    expect(proseBlocks(oneLine.join("\n"), "report.html")).toEqual([]);
    // 교차검토 R2-OAI-2: 대문자로 시작하는 `Word: …;` 산문 줄은 CSS 선언으로 빼지 않는다.
    const prose = "Summary: The revised onboarding experience gives every customer clear guidance and explains all available recovery options;";
    expect(proseBlocks(prose, "report.html")).toEqual([prose]);
    expect(s.call("edit", { input: `[report.html#AB12]\nPUT >1:\n+${[...oneLine, ...oneLine, ...oneLine].join("\n+")}` })?.block).toBeUndefined();
  });

  test("URI paths are not resolved or gated for writes and edits", () => {
    const s = session(workdir());
    s.input();
    expect(s.call("write", { path: "local://x.md", content: markdown(DIRECT) })?.block).toBeUndefined();
    expect(s.call("edit", { input: `[local://x.md#AB12]\nPUT >1:\n+${DIRECT.join(" ")}` })?.block).toBeUndefined();
    expect(proseChanges("write", { path: "memory://x.md", content: markdown(DIRECT) }, "/project")).toEqual([]);
    expect(proseChanges("edit", { input: `[artifact://x.md#AB12]\nPUT >1:\n+${DIRECT.join(" ")}` }, "/project")).toEqual([]);
  });

  test("한 줄로 압축한 HTML도 블록 태그로 덩어리를 나눈다", () => {
    expect(proseBlocks(html([...DRAFTED, ...DIRECT]), "a.html")).toHaveLength(7);
  });
});
