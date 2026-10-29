// 2026-10-27 사용자 결정으로 완화한 교차검토 게이트(주석 증명·VB 주석·문자열 PLC·버전만 바뀐 diff·파일 단위 highRisk·표본 제외/상한·자문 비차단)의 계약 테스트.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  advisoryPending,
  collectChanges,
  commentOnlyEdit,
  CrossReviewRefusal,
  detectMarkers,
  isGateTarget,
  markBlockComments,
  ReviewerCallError,
  runGate,
  runResolve,
  runReview,
  sampleSelected,
  spawnExec,
  type GateOutcome,
  type Lane,
  type ReviewDeps,
} from "../lib/cross-review";
import { createRoutingLedger, readCrossReviewRecords } from "../lib/routing-ledger";

const OPUS = "anthropic/claude-opus-5-5";
const ASTRA = "openai-codex/gpt-6-astra";
const FABLE = "anthropic/claude-fable-5-1";
const roots: string[] = [];
const signal = new AbortController().signal;
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function sh(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}
const blobOf = (content: string) => createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0${content}`).digest("hex");

interface RepoEnv { work: string; ledger: string; snapshots: string }
function repo(): RepoEnv {
  const dir = mkdtempSync(join(tmpdir(), "cross-review-relax-"));
  roots.push(dir);
  const work = join(dir, "work");
  mkdirSync(work);
  sh(work, "init", "-q", "--initial-branch=main");
  sh(work, "config", "user.name", "t");
  sh(work, "config", "user.email", "t@example.invalid");
  sh(work, "config", "core.autocrlf", "false");
  writeFileSync(join(work, "base.txt"), "base\n");
  sh(work, "add", "base.txt");
  sh(work, "commit", "-q", "-m", "base");
  return { work, ledger: join(dir, "ledger.jsonl"), snapshots: join(dir, "snapshots") };
}
function commit(env: RepoEnv, files: Record<string, string | Buffer>): void {
  for (const [path, content] of Object.entries(files)) writeFileSync(join(env.work, path), content);
  sh(env.work, "add", ...Object.keys(files));
  sh(env.work, "commit", "-q", "-m", "c");
}

/** HEAD에 before를 커밋하고 작업 트리를 after로 바꾼 뒤 collectChanges가 본 그 파일. */
async function changeOf(path: string, before: string | Buffer, after: string | Buffer) {
  const env = repo();
  commit(env, { [path]: before });
  writeFileSync(join(env.work, path), after);
  const { changed } = await collectChanges(spawnExec(), "git", env.work, [path]);
  return changed[0]!;
}

describe("A1 주석만 바뀐 TS/JS는 TypeScript 파서로 증명한다", () => {
  test.each([
    // 8cecd912(lib/subagent-revive.ts) 모양: 백틱이 있는 파일에서 JSDoc 가운데 줄만 바꾼다.
    ["백틱이 있는 파일의 JSDoc 가운데 줄", "a.ts", "/**\n * old words\n */\nexport const s = `x${1}`;\n", "/**\n * new words, longer\n * and a second line\n */\nexport const s = `x${1}`;\n"],
    ["줄 끝 주석", "a.ts", "export const a = 1; // x\n", "export const a = 1; // y\n"],
    ["백틱이 있는 파일의 // 줄", "a.ts", "export const u = `x`;\n// old\n", "export const u = `x`;\n// new\n"],
    ["JS 파일의 일반 JSDoc 문구", "a.mjs", "/** Adds. */\nexport const add = (a, b) => a + b;\n", "/** Adds two numbers. */\nexport const add = (a, b) => a + b;\n"],
  ])("주석만 바꾼 수정은 대상이 아니다: %s", async (_label, path, before, after) => {
    const change = await changeOf(path, before, after);
    expect(change.commentOnly).toBe(true);
    expect(isGateTarget(change)).toBe(false);
  });

  test.each([
    ["타입만 바꾼 수정", "a.ts", "export const f = (x: string) => x;\n", "export const f = (x: number) => x;\n"],
    ["여러 줄 템플릿 리터럴 안의 글자", "a.ts", "export const s = `\n  hello\n`;\n", "export const s = `\n  hullo\n`;\n"],
    ["여러 줄 템플릿 리터럴 안의 // 줄", "a.ts", "export const s = `\n// a\n`;\n", "export const s = `\n// b\n`;\n"],
    ["eslint 지시 주석 추가", "a.ts", "export const a = 1;\n", "// eslint-disable-next-line\nexport const a = 1;\n"],
    ["prettier-ignore 추가", "a.ts", "export const a = 1;\n", "// prettier-ignore\nexport const a = 1;\n"],
    ["@ts-expect-error 문구 변경", "a.ts", "// @ts-expect-error old\nexport const a: string = 1;\n", "// @ts-expect-error new\nexport const a: string = 1;\n"],
    ["/*! 보존 주석", "a.ts", "/* x */\nexport const a = 1;\n", "/*! x */\nexport const a = 1;\n"],
    ["@license", "a.ts", "/** a */\nexport const a = 1;\n", "/** @license MIT */\nexport const a = 1;\n"],
    ["webpack magic comment", "a.ts", "export const m = () => import(\"./x\");\n", "export const m = () => import(/* webpackChunkName: \"x\" */ \"./x\");\n"],
    ["JS의 JSDoc @type", "a.js", "/** @type {string} */\nexport let a;\n", "/** @type {number} */\nexport let a;\n"],
    ["JS의 JSDoc @param {", "a.mjs", "/** @param {string} x */\nexport const f = (x) => x;\n", "/** @param {number} x */\nexport const f = (x) => x;\n"],
    ["BOM 추가", "a.ts", "export const a = 1;\n", "\uFEFFexport const a = 1;\n"],
    ["구문 오류가 있는 파일", "a.ts", "export const a = (;\n// old\n", "export const a = (;\n// new\n"],
    ["주석 안의 줄바꿈이 ASI를 바꾸는 return", "a.ts", "export function f() {\n  return /* a */ 1;\n}\n", "export function f() {\n  return /*\n*/ 1;\n}\n"],
  ])("주석으로 증명되지 않는 수정은 대상으로 남는다: %s", async (_label, path, before, after) => {
    const change = await changeOf(path, before, after);
    expect(change.commentOnly).toBeUndefined();
    expect(isGateTarget(change)).toBe(true);
  });

  test("파서를 쓸 수 없으면(standalone 실행 등 typescript 미해석) 닫힌 쪽으로 대상에 남고 던지지 않는다", () => {
    const lines = [{ line: 2, text: "// old", removed: true as const }, { line: 2, text: "// new" }];
    const before = "export const a = 1;\n// old\n";
    const after = "export const a = 1;\n// new\n";
    expect(commentOnlyEdit("a.ts", before, after, lines, null)).toBe(false);
  });
});

describe("A2 VB 주석 줄은 marker 판정에서 뺀다", () => {
  const hit = (path: string, text: string) => detectMarkers(path, [{ line: 1, text }]).map((item) => item.trigger);
  test("VB 계열의 ' 주석·REM 줄은 보지 않고, 다른 언어와 VB 코드 줄은 그대로다", () => {
    for (const path of ["Form1.vb", "Module1.bas", "Main.frm", "C.cls", "U.ctl", "s.vbs"]) {
      expect(hit(path, "    ' Kill \"C:\\old.log\" SerialPort"), path).toEqual([]);
      expect(hit(path, "REM Kill \"C:\\old.log\""), path).toEqual([]);
      expect(hit(path, "rem kill \"x\""), path).toEqual([]);
    }
    expect(hit("Form1.vb", "Kill \"C:\\old.log\"")).toEqual(["deletion"]);
    expect(hit("Form1.vb", "Dim remark As String = x : Kill \"a\"")).toEqual(["deletion"]);
    expect(hit("a.ps1", "' Kill \"x\"")).toEqual(["deletion"]);
  });
});

describe("A3 device-io는 문자열 리터럴 안에서만 맞으면 세지 않는다", () => {
  const hit = (path: string, text: string) => detectMarkers(path, [{ line: 1, text }]).map((item) => item.trigger);
  test("화면 문구 속 PLC·COM은 빼고 실제 장치 코드는 잡는다", () => {
    expect(hit("Form1.vb", "Me.groupPlc.Text = \"PLC Communication\"")).toEqual([]);
    expect(hit("ko.json", "\"PC - PLC 연결\": \"PC - PLC 연결\",")).toEqual([]);
    expect(hit("a.ts", ",\"COM1\")")).toEqual([]);
    expect(hit("a.ts", "label('Winsock status')")).toEqual([]);
    expect(hit("Form1.vb", "x = \"He said \"\"PLC\"\" ok\"")).toEqual([]);
    expect(hit("a.ts", "const port = new SerialPort(\"COM1\")")).toEqual(["device-io"]);
    // 문자열 밖의 줄 끝 주석은 지금처럼 코드 줄의 일부로 본다.
    expect(hit("Form1.vb", "x = 1 ' \"PLC\" link")).toEqual(["device-io"]);
    expect(hit("Form1.vb", "Dim port As New SerialPort(\"COM3\")")).toEqual(["device-io"]);
    expect(hit("a.ts", "if (plcLink) send(\"x\"); // PLC")).toEqual(["device-io"]);
    // 다른 marker는 문자열 안이어도 그대로 센다.
    expect(hit("a.ts", "run(\"rm -rf build\")")).toEqual(["deletion"]);
  });
  test("HTML(.html·.htm)은 단어만으로 세지 않고 브라우저에서 실제로 여는 연결 호출만 센다", () => {
    // 닫는 태그의 `/` 때문에 문자열 제거가 줄 끝까지 코드로 남기던 덱 문구·덱 스크립트 줄.
    expect(hit("deck/index.html", "<li>PLC 연결 흐름</li>")).toEqual([]);
    expect(hit("deck/index.html", "<td>COM3</td><td>MSComm 응답 대기</td>")).toEqual([]);
    expect(hit("deck/index.htm", "box.innerHTML = \"<b>PLC</b>\" + note + \"</p>\";")).toEqual([]);
    expect(hit("deck/index.html", "const plc = steps.PLC; // COM1 단계")).toEqual([]);
    expect(hit("deck/index.html", "const ws = new WebSocket(url);")).toEqual(["device-io"]);
    // 서버 코드가 섞이는 Razor는 지금 규칙 그대로다.
    expect(hit("Views/Home.cshtml", "<li>PLC 연결</li>")).toEqual(["device-io"]);
  });
});

describe("A4 버전 문자열만 바뀐 diff는 대상이 아니다", () => {
  const SETUP = "$version = \"0.10.83\"\n$core = '18.12.1'\nRemove-Item $tmp -Recurse\nWrite-Host \"CUELO 0.10.83 / core 18.12.1\"\n$tarball = Join-Path $dir 'cuelo-0.10.83.tgz'\n";
  test("semver만 바뀐 수정은 대상이 아니다", async () => {
    const change = await changeOf("setup.ps1", SETUP, SETUP.replaceAll("0.10.83", "0.10.84").replaceAll("18.12.1", "18.13.0-rc.1"));
    expect(isGateTarget(change)).toBe(false);
  });
  test.each([
    ["IP 주소 변경", "$plc = \"192.168.1.10\"\n", "$plc = \"192.168.2.10\"\n"],
    ["4자리 어셈블리 버전", "[assembly: AssemblyVersion(\"1.0.0.0\")]\n", "[assembly: AssemblyVersion(\"1.0.0.1\")]\n"],
    ["버전 말고 다른 글자도 바뀜", SETUP, SETUP.replace("0.10.83\"", "0.10.84\" # x")],
    ["줄 추가", SETUP, `${SETUP.replaceAll("0.10.83", "0.10.84")}Write-Host done\n`],
    ["줄 바꿈 형식 변경", SETUP, SETUP.replaceAll("0.10.83", "0.10.84").replaceAll("\n", "\r\n")],
  ])("버전만 바뀐 것이 아니면 대상으로 남는다: %s", async (_label, before, after) => {
    expect(isGateTarget(await changeOf("setup.ps1", before, after))).toBe(true);
  });

  test("통과한 내용과 버전 문자열만 다르면 그 통과가 덮고, 다른 수정이 섞이면 덮지 않는다", async () => {
    const env = repo();
    const base = "export const VERSION = \"0.10.83\";\n";
    commit(env, { "a.ts": base });
    const reviewed = `${base}import { rmSync } from "node:fs";\nexport const wipe = (p: string) => rmSync(p);\n`;
    writeFileSync(join(env.work, "a.ts"), reviewed);
    const d = deps(env, {});
    const review = await runReview({ files: ["a.ts"], acceptance: "A", authors: ["main"] }, d, signal);
    await advisorySettled(env, review.reviewId);
    expect((await runResolve({ reviewId: review.reviewId, resolutions: [] }, { exec: spawnExec(), readAll: d.readAll, append: d.append })).pass).toBe(true);
    writeFileSync(join(env.work, "a.ts"), reviewed.replace("0.10.83", "0.10.84"));
    const outcome = await runGate({ cwd: env.work, files: ["a.ts"], ledgerPath: env.ledger });
    expect(outcome.decision?.uncovered).toEqual([]);
    writeFileSync(join(env.work, "a.ts"), `${reviewed.replace("0.10.83", "0.10.84")}export const more = 1;\n`);
    await expect(runGate({ cwd: env.work, files: ["a.ts"], ledgerPath: env.ledger })).rejects.toThrow("content changed after the pass");
  });
});

/** files 전체(path+content)의 표본 여부가 want가 되도록 vary 파일의 내용을 고른다. */
function pickSample(files: Record<string, string>, vary: string, want: boolean): Record<string, string> {
  for (let n = 0; n < 2000; n++) {
    const next = { ...files, [vary]: files[vary]!.replace("/*v*/", `/*v${n}*/`) };
    if (sampleSelected(Object.entries(next).map(([path, content]) => ({ path, blob: blobOf(content) }))) === want) return next;
  }
  throw new Error("no content found");
}

describe("A5 crossReviewHighRisk는 적은 파일에만 걸린다", () => {
  test("목록의 파일만 declared high-risk이고, files에 없는 경로는 거절한다", async () => {
    const env = repo();
    const files = pickSample({ "a.ts": "export const a = 1; /*v*/\n", "b.ts": "export const b = 2;\n" }, "a.ts", false);
    for (const [path, content] of Object.entries(files)) writeFileSync(join(env.work, path), content);
    const error = await runGate({ cwd: env.work, files: ["a.ts", "b.ts"], ledgerPath: env.ledger, highRisk: ["a.ts"] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CrossReviewRefusal);
    expect((error as Error).message).toContain("- a.ts: declared high-risk");
    expect((error as Error).message).not.toContain("- b.ts:");
    await expect(runGate({ cwd: env.work, files: ["a.ts"], ledgerPath: env.ledger, highRisk: ["b.ts"] })).rejects.toThrow("crossReviewHighRisk");
  });
});

describe("A6 표본은 프로젝트·스타일·디자이너 파일을 빼고 바뀐 줄이 많은 5개까지만 요구한다", () => {
  test("뽑힌 커밋에서 상위 5개 코드 파일만 표본 이유를 받고, marker 파일은 상한 밖이어도 요구된다", async () => {
    const env = repo();
    const ts = (n: number) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";
    const big = Array.from({ length: 40 }, (_, i) => `  <Item${i} />`).join("\n") + "\n";
    const files = pickSample({
      "s1.ts": "export const s = 1; /*v*/\n", "s2.ts": ts(2), "s3.ts": ts(3), "s4.ts": ts(4), "s5.ts": ts(5), "s6.ts": ts(6),
      "App.csproj": `<Project>\n${big}</Project>\n`, "site.css": `.a {\n${big}}\n`, "Form1.Designer.vb": `Partial Class Form1\n${big}End Class\n`,
      "m.ts": "rmSync(x);\n",
    }, "s1.ts", true);
    for (const [path, content] of Object.entries(files)) writeFileSync(join(env.work, path), content);
    const error = await runGate({ cwd: env.work, files: Object.keys(files), ledgerPath: env.ledger }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CrossReviewRefusal);
    const required = [...(error as Error).message.matchAll(/^- (\S+): (.*)$/gm)].map((match) => [match[1], match[2]] as const);
    expect(required.filter(([, reason]) => reason.includes("sampled")).map(([path]) => path).sort()).toEqual(["s2.ts", "s3.ts", "s4.ts", "s5.ts", "s6.ts"]);
    expect(required.map(([path]) => path).sort()).toEqual(["m.ts", "s2.ts", "s3.ts", "s4.ts", "s5.ts", "s6.ts"]);
    expect(required.find(([path]) => path === "m.ts")?.[1]).toContain("marker deletion");
  });
});

// ── A7 자문 비차단 ───────────────────────────────────────────────────────────

const finding = (claim: string) => JSON.stringify({ findings: [{ severity: "major", file: "a.ts", line: 1, claim, why: "because" }], summary: "s" });
let idCounter = 0;
function deps(env: RepoEnv, delays: Partial<Record<Lane, { ms: number; text?: string; error?: string }>>, notices: string[] = []): ReviewDeps {
  const ledger = createRoutingLedger(env.ledger);
  return {
    cwd: env.work, sessionId: "s1", mainModel: OPUS, advisoryModel: FABLE, exec: spawnExec(), snapshotRoot: env.snapshots,
    readAll: () => readCrossReviewRecords(env.ledger), append: (record) => ledger.append(record),
    newId: () => `xr-relax-${process.pid}-${++idCounter}`,
    notify: (text: string) => notices.push(text),
    complete: async (family) => {
      const plan = delays[family] ?? { ms: 0 };
      const model = family === "openai" ? ASTRA : family === "advisory" ? FABLE : OPUS;
      await Bun.sleep(plan.ms);
      if (plan.error) throw new ReviewerCallError(plan.error, model);
      return { model, text: plan.text ?? '{"findings":[]}' };
    },
  } as ReviewDeps;
}
/** 백그라운드 자문이 끝나 원장에 기록될 때까지(최대 15 s) 기다린다. 자문 자리가 없거나 이미 답했으면 곧바로 돌아온다. */
async function advisorySettled(env: RepoEnv, reviewId: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const records = readCrossReviewRecords(env.ledger) as { type: string; reviewId: string; reviewers?: { advisory?: true; status: string }[] }[];
    const review = records.find((record) => record.type === "cross-review" && record.reviewId === reviewId);
    const pending = review?.reviewers?.some((reviewer) => reviewer.advisory && reviewer.status === "pending");
    if (!pending || records.some((record) => record.type === "cross-review-advisory" && record.reviewId === reviewId)) return;
    await Bun.sleep(50);
  }
  throw new Error("advisory never settled");
}

describe("A7 자문은 필수 reviewer를 막지 않고 늦게 도착한다", () => {
  test("필수 1 s·자문 5 s: review는 약 1 s에 돌아오고 자문 finding은 약 5 s 뒤 원장에 붙으며, 닫기 전에는 resolve가 통과하지 않는다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), "export const a = 1;\n");
    const notices: string[] = [];
    const d = deps(env, { openai: { ms: 1_000 }, advisory: { ms: 5_000, text: finding("late advisory objection") } }, notices);
    const started = Date.now();
    const review = await runReview({ files: ["a.ts"], acceptance: "A", authors: ["main"] }, d, signal);
    const returnedAt = Date.now() - started;
    expect(returnedAt).toBeGreaterThanOrEqual(900);
    expect(returnedAt).toBeLessThan(2_500);
    expect(review.findings).toEqual([]);
    expect(review.reviewers).toMatchObject([{ family: "openai", status: "ok" }, { family: "advisory", status: "pending", advisory: true }]);
    await advisorySettled(env, review.reviewId);
    const arrivedAt = Date.now() - started;
    expect(arrivedAt).toBeGreaterThanOrEqual(4_900);
    expect(arrivedAt).toBeLessThan(8_000);
    const late = readCrossReviewRecords(env.ledger).filter((record) => (record as { type: string }).type === "cross-review-advisory");
    expect(late).toMatchObject([{ reviewId: review.reviewId, reviewer: { family: "advisory", status: "ok", model: FABLE }, findings: [{ id: "R1-ADV-1", claim: "late advisory objection" }] }]);
    expect(notices.join("\n")).toContain("R1-ADV-1");
    const rd = { exec: spawnExec(), readAll: d.readAll, append: d.append };
    expect(await runResolve({ reviewId: review.reviewId, resolutions: [] }, rd)).toMatchObject({ pass: false, open: ["R1-ADV-1"] });
    expect(await runResolve({ reviewId: review.reviewId, resolutions: [{ id: "R1-ADV-1", status: "refuted", evidence: "a is a constant" }] }, rd)).toMatchObject({ pass: true, open: [] });
  }, 20_000);

  test("다음 라운드는 앞 라운드의 늦은 자문 finding을 열린 지적으로 보여 준다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), "export const a = 1;\n");
    const first = await runReview({ files: ["a.ts"], acceptance: "A", authors: ["main"] }, deps(env, { advisory: { ms: 200, text: finding("late one") } }), signal);
    await advisorySettled(env, first.reviewId);
    writeFileSync(join(env.work, "a.ts"), "export const a = 2;\n");
    const prompts: string[] = [];
    const base = deps(env, {});
    const second = await runReview({ files: ["a.ts"], acceptance: "A", authors: ["main"], previousReviewId: first.reviewId }, { ...base, complete: async (family, prompt, attempt) => { prompts.push(prompt); return base.complete(family, prompt, attempt); } }, signal);
    expect(prompts[0]).toContain("R1-ADV-1");
    expect(prompts[0]).toContain("late one");
    expect((second as { earlierAdvisoryFindings?: { id: string }[] }).earlierAdvisoryFindings).toMatchObject([{ id: "R1-ADV-1" }]);
    await advisorySettled(env, second.reviewId);
    expect(await runResolve({ reviewId: second.reviewId, resolutions: [] }, { exec: spawnExec(), readAll: base.readAll, append: base.append })).toMatchObject({ pass: false, open: ["R1-ADV-1"] });
  }, 20_000);

  test("resolve는 이 프로세스에서 아직 도는 자문을 기다리며 진행을 알리고, 그 finding을 닫아야 통과한다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), "export const a = 1;\n");
    const d = deps(env, { advisory: { ms: 1_500, text: finding("slow advisory") } });
    const review = await runReview({ files: ["a.ts"], acceptance: "A", authors: ["main"] }, d, signal);
    const progress: string[] = [];
    const resolved = await runResolve({ reviewId: review.reviewId, resolutions: [] }, { exec: spawnExec(), readAll: d.readAll, append: d.append, onProgress: (text: string) => progress.push(text) } as never);
    expect(progress.join("\n")).toContain("advisory");
    expect(resolved).toMatchObject({ pass: false, open: ["R1-ADV-1"] });
  }, 20_000);

  test("자문 실패·시간 초과는 기록만 하고 통과를 막지 않는다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), "export const a = 1;\n");
    const d = { ...deps(env, { advisory: { ms: 5_000 } }), advisoryTimeoutMs: 100 };
    const review = await runReview({ files: ["a.ts"], acceptance: "A", authors: ["main"] }, d, signal);
    await advisorySettled(env, review.reviewId);
    expect(readCrossReviewRecords(env.ledger).filter((record) => (record as { type: string }).type === "cross-review-advisory")).toMatchObject([{ reviewer: { status: "error", error: expect.stringContaining("timed out") }, findings: [] }]);
    expect(await runResolve({ reviewId: review.reviewId, resolutions: [] }, { exec: spawnExec(), readAll: d.readAll, append: d.append })).toMatchObject({ pass: true });
  }, 20_000);

  test("재시작 뒤(진행 중 호출도 완료 기록도 없음) 대기 중이던 자문은 실패로 기록되고 통과를 막지 않는다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), "export const a = 1;\n");
    const d = deps(env, {});
    const review = await runReview({ files: ["a.ts"], acceptance: "A", authors: ["main"] }, d, signal);
    // 지난 프로세스가 남긴 것처럼: 자문이 pending인 1회차 기록을 새 id로 복제한다(이 프로세스에는 그 호출이 없다).
    const lost = { ...(readCrossReviewRecords(env.ledger)[0] as object), reviewId: "xr-lost-1", reviewers: [{ family: "openai", model: ASTRA, status: "ok", elapsedMs: 1 }, { family: "advisory", model: "@crossReviewAdvisory", status: "pending", elapsedMs: 0, advisory: true }], findings: [] };
    writeFileSync(env.ledger, `${readFileSync(env.ledger, "utf8")}${JSON.stringify(lost)}\n`);
    void review;
    const resolved = await runResolve({ reviewId: "xr-lost-1", resolutions: [] }, { exec: spawnExec(), readAll: d.readAll, append: d.append });
    expect(resolved.pass).toBe(true);
    expect(readCrossReviewRecords(env.ledger).filter((record) => (record as { type: string }).type === "cross-review-advisory" && (record as { reviewId: string }).reviewId === "xr-lost-1")).toMatchObject([{ reviewId: "xr-lost-1", reviewer: { status: "error", error: expect.stringContaining("restart") } }]);
  }, 20_000);

  test("게이트는 자문 기록 줄이 섞인 원장도 그대로 읽는다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), "import { rmSync } from \"node:fs\";\nrmSync(\"x\");\n");
    const d = deps(env, { advisory: { ms: 100 } });
    const review = await runReview({ files: ["a.ts"], acceptance: "A", authors: ["main"] }, d, signal);
    await advisorySettled(env, review.reviewId);
    expect((await runResolve({ reviewId: review.reviewId, resolutions: [] }, { exec: spawnExec(), readAll: d.readAll, append: d.append })).pass).toBe(true);
    expect(((await runGate({ cwd: env.work, files: ["a.ts"], ledgerPath: env.ledger })) as GateOutcome).decision?.uncovered).toEqual([]);
  }, 20_000);
});

describe("교차검토 1회차(xr-20261027014753-15a93f) 지적 회귀", () => {
  test("R1-OAI-1: JS의 여러 줄 JSDoc 타입은 가운데 줄만 바뀌어도 주석 증명을 하지 않는다(지시 블록도 같다)", () => {
    const js = (type: string) => `/** @type {{\n * value: ${type}\n * }} */\nexport let config;\n`;
    expect(commentOnlyEdit("a.js", js("string"), js("number"), [{ line: 2, text: " * value: string", removed: true }, { line: 2, text: " * value: number" }])).toBe(false);
    const lint = (rule: string) => `/* eslint-disable\n   ${rule}\n*/\nexport const a = 1;\n`;
    expect(commentOnlyEdit("a.ts", lint("no-console"), lint("no-debugger"), [{ line: 2, text: "   no-console", removed: true }, { line: 2, text: "   no-debugger" }])).toBe(false);
    // 지시·타입 표지가 없는 블록의 가운데 줄은 여전히 증명된다.
    const doc = (word: string) => `/**\n * ${word}\n */\nexport let config;\n`;
    expect(commentOnlyEdit("a.js", doc("old"), doc("new"), [{ line: 2, text: " * old", removed: true }, { line: 2, text: " * new" }])).toBe(true);
  });

  test("R1-OAI-2: 보간 템플릿의 글자 부분 PLC는 세지 않고, 보간 식 안의 장치 코드는 센다", () => {
    const hit = (text: string) => detectMarkers("a.ts", [{ line: 1, text }]).map((item) => item.trigger);
    expect(hit("const label = `PLC ${name} Communication`;")).toEqual([]);
    expect(hit("const label = `${name}: SerialPort ready`;")).toEqual([]);
    expect(hit("const label = `${new SerialPort(path)} ok`;")).toContain("device-io");
  });

  test("R1-OAI-3: 늦은 자문 답을 원장에 못 쓰면 잃지 않고, resolve가 다시 쓰거나 거절한다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), "export const a = 1;\n");
    const base = deps(env, { advisory: { ms: 200, text: finding("kept despite write failure") } });
    let failing = true;
    const d = { ...base, append: (record: Parameters<ReviewDeps["append"]>[0]) => ((record as { type: string }).type === "cross-review-advisory" && failing ? false : base.append(record)) };
    const review = await runReview({ files: ["a.ts"], acceptance: "A", authors: ["main"] }, d, signal);
    await advisoryPending(review.reviewId);
    const rd = { exec: spawnExec(), readAll: d.readAll, append: d.append };
    await expect(runResolve({ reviewId: review.reviewId, resolutions: [] }, rd)).rejects.toThrow("could not be written to the routing ledger");
    failing = false;
    expect(await runResolve({ reviewId: review.reviewId, resolutions: [] }, rd)).toMatchObject({ pass: false, open: ["R1-ADV-1"] });
  }, 20_000);

  test("R1-OAI-4: probe 라운드에 늦게 답한 자문의 판단도 기록되고 resolve 결과에 나온다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), "export const a = 1;\n");
    const probed = JSON.stringify({ findings: [{ severity: "major", file: "a.ts", line: 1, claim: "c", why: "w", probe: { steps: "run it", expectIfReal: "boom" } }], summary: "s" });
    const first = await runReview({ files: ["a.ts"], acceptance: "A", authors: ["main"] }, deps(env, { openai: { ms: 0, text: probed } }), signal);
    await advisorySettled(env, first.reviewId);
    const verdict = JSON.stringify({ findings: [], verdicts: [{ id: "R1-OAI-1", verdict: "confirmed", why: "the output shows boom" }], summary: "s" });
    const d = deps(env, { advisory: { ms: 300, text: verdict } });
    const probe = await runReview({ files: ["a.ts"], acceptance: "A", authors: ["main"], previousReviewId: first.reviewId, probeResults: [{ findingId: "R1-OAI-1", command: "run it", exitCode: 1, output: "boom" }] }, d, signal);
    await advisorySettled(env, probe.reviewId);
    const late = readCrossReviewRecords(env.ledger).find((record) => (record as { type: string; reviewId: string }).type === "cross-review-advisory" && (record as { reviewId: string }).reviewId === probe.reviewId);
    expect(late).toMatchObject({ verdicts: [{ id: "R1-OAI-1", verdict: "confirmed", reviewer: FABLE }] });
    const resolved = await runResolve({ reviewId: probe.reviewId, resolutions: [{ id: "R1-OAI-1", status: "fixed", evidence: "x" }] }, { exec: spawnExec(), readAll: d.readAll, append: d.append });
    expect(resolved.verdicts).toEqual(expect.arrayContaining([expect.objectContaining({ id: "R1-OAI-1", verdict: "confirmed", reviewer: FABLE })]));
  }, 20_000);

  test("R1-OAI-5: 필수 reviewer가 실패해도 도는 자문은 멈추지 않고 늦은 finding을 붙인다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), "export const a = 1;\n");
    const d = deps(env, { openai: { ms: 0, error: "provider down" }, advisory: { ms: 300, text: finding("still useful") } });
    const review = await runReview({ files: ["a.ts"], acceptance: "A", authors: ["main"] }, d, signal);
    expect(review.passable).toBe(false);
    await advisorySettled(env, review.reviewId);
    expect(readCrossReviewRecords(env.ledger).filter((record) => (record as { type: string }).type === "cross-review-advisory")).toMatchObject([{ reviewer: { status: "ok" }, findings: [{ id: "R1-ADV-1", claim: "still useful" }] }]);
  }, 20_000);

  test("R1-OAI-6: 자문을 기다리는 사이 다음 라운드가 생기면 resolve는 옛 머리를 판정하지 않는다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), "export const a = 1;\n");
    const d = deps(env, { advisory: { ms: 1_500 } });
    const first = await runReview({ files: ["a.ts"], acceptance: "A", authors: ["main"] }, d, signal);
    let waiting!: () => void;
    const started = new Promise<void>((resolve) => { waiting = resolve; });
    const resolving = runResolve({ reviewId: first.reviewId, resolutions: [] }, { exec: spawnExec(), readAll: d.readAll, append: d.append, onProgress: () => waiting() } as never);
    await started;
    writeFileSync(join(env.work, "a.ts"), "export const a = 2;\n");
    await runReview({ files: ["a.ts"], acceptance: "A", authors: ["main"], previousReviewId: first.reviewId }, deps(env, {}), signal);
    await expect(resolving).rejects.toThrow("while resolve waited for its advisory reviewer");
  }, 20_000);
});

describe("교차검토 2회차(xr-20261027015522-8736b8) 지적 회귀", () => {
  test("R2-OAI-1: 문자열 속 `/*`가 있어도 식 안의 JSDoc 타입 주석 변경은 증명하지 않는다", () => {
    const js = (type: string) => `const sentinel = "/*";\nexport const result = 2*/** @type {\n * ${type}\n * } */ (input);\n`;
    expect(commentOnlyEdit("a.js", js("number"), js("string"), [{ line: 3, text: " * number", removed: true }, { line: 3, text: " * string" }])).toBe(false);
  });

  test("R2-OAI-2: 보간 식 안 문자열의 중괄호가 장치 코드를 지우지 않는다", () => {
    expect(detectMarkers("a.ts", [{ line: 1, text: "const label = `${\"}\" + new SerialPort(path)}`;" }]).map((item) => item.trigger)).toContain("device-io");
  });
});

describe("교차검토 3회차(xr-20261027020031-ef6308) 지적 회귀", () => {
  test("R3-OAI-1: 보간 식 안의 주석·정규식·중첩 템플릿은 그 템플릿부터 줄 끝까지 코드로 둔다", () => {
    const hit = (text: string) => detectMarkers("a.ts", [{ line: 1, text }]).map((item) => item.trigger);
    expect(hit("const label = `${/* \" */ \"}\" + new SerialPort(path)}`;")).toContain("device-io");
    expect(hit("const label = `${/\"}/.test(x) + new SerialPort(path)}`;")).toContain("device-io");
    expect(hit("const label = `${`a${\"`\"}b` + new SerialPort(path)}`;")).toContain("device-io");
    // 템플릿 밖의 블록 주석·정규식 속 따옴표도 실제 코드를 문자열로 지우지 못한다.
    expect(hit("foo(/* \" */ \"a\"); new SerialPort(path); \"b\";")).toContain("device-io");
    expect(hit("if (/\"/.test(x)) new SerialPort(path); \"b\";")).toContain("device-io");
    // 단순한 보간은 여전히 글자 부분만 지운다.
    expect(hit("const label = `PLC ${name} Communication`;")).toEqual([]);
  });
});

// 공개 이슈 #53: Python f-string·C#/VB 보간 문자열의 `{…}` 안은 실행식이라 문자열 제거가 지우면 안 된다.
describe("#53 보간 문자열의 실행식은 device-io로 남는다", () => {
  const hit = (path: string, text: string) => detectMarkers(path, [{ line: 1, text }]).map((item) => item.trigger);

  test.each([
    ["Python f-string", "ports.py", "    return f\"{socket.send(data)}\""],
    ["C# $\"", "ports.cs", "    static string Show(string path) => $\"{new SerialPort(path).PortName}\";"],
    ["VB $\"", "ports.vb", "        Return $\"{New SerialPort(path).PortName}\""],
    ["JS 백틱(대조군)", "ports.ts", "export const show = (path: string) => `${new SerialPort(path).port}`;"],
    ["직접 호출(대조군)", "ports-direct.py", "    return socket.send(data)"],
  ])("보간 안의 장치 코드는 센다: %s", (_label, path, text) => {
    expect(hit(path, text)).toContain("device-io");
  });

  test.each([
    ["ports.ts", "export const text = \"SerialPort status\";"],
    ["ports.py", "    return \"SerialPort status\""],
    ["ports.py", "    return f\"SerialPort status {name}\""],
    ["ports.py", "    return f\"{{SerialPort}} {name}\""],
    ["ports.cs", "    var s = $\"PLC {name} ready\";"],
    ["ports.cs", "    var s = $\"{{SerialPort}} {name}\";"],
    ["ports.vb", "        Return $\"PLC {name} said \"\"COM1\"\"\""],
  ])("보간 밖의 글자 부분은 세지 않는다: %s %s", (path, text) => {
    expect(hit(path, text)).toEqual([]);
  });

  test.each([
    ["Python rf/Rf/fR/Fr 접두사", "a.py", ["rf\"\\d{socket.send(x)}\"", "Rf\"{socket.send(x)}\"", "fR'{socket.send(x)}'", "Fr\"{socket.send(x)}\""]],
    ["Python 식 안의 같은 따옴표·중첩 중괄호·서식", "a.py", ["f\"{d[\"k\"]} {socket.send(x)}\"", "f\"{x:{w}} {socket.send(x)}\"", "f\"{ {'a': 1}['a'] }{socket.send(x)}\""]],
    ["C# $@·@$ 축자 보간", "a.cs", ["$@\"C:\\{new SerialPort(p)}\"", "@$\"{new SerialPort(p)}\""]],
    ["C# 식 안의 중첩 문자열", "a.cs", ["$\"{(ok ? \"a\" : \"b\")} {new SerialPort(p)}\""]],
    ["VB 식 안의 중첩 문자열", "a.vb", ["$\"{If(ok, \"a\", \"b\")} {New SerialPort(p)}\""]],
    ["여러 보간 중 뒤쪽 식", "a.py", ["f\"{a} text {socket.send(b)}\""]],
  ])("지원하는 접두사·문법: %s", (_label, path, lines) => {
    for (const text of lines) expect(hit(path, text), text).toContain("device-io");
  });

  test.each([
    ["식이 줄 안에서 닫히지 않음", "a.py", "x = f\"{socket.send(data)"],
    ["식 안의 `/`(나눗셈·주석)", "a.py", "x = f\"{a / b}\"; socket.send(data)"],
    ["식 안의 닫히지 않은 따옴표", "a.cs", "var s = $\"{(a + \"}\"; new SerialPort(p);"],
    ["닫히지 않은 보간 문자열", "a.cs", "var s = $\"PLC {x}"],
    ["삼중 따옴표·C# raw 보간", "a.cs", "var s = $\"\"\"PLC {x}\"\"\";"],
    ["Python 삼중 따옴표 f-string", "a.py", "x = f\"\"\"{socket.send(d)}\"\"\""],
  ])("경계를 확신할 수 없으면 줄 끝까지 코드로 둔다(닫힌 쪽): %s", (_label, path, text) => {
    expect(hit(path, text)).toContain("device-io");
  });

  test("1회차 지적(xr-20261027063952-f2c9d6): 보간 앞의 역슬래시와 `$$` raw 보간도 실행식을 지우지 않는다", () => {
    // R1-OAI-1: Python에서 `\{`의 역슬래시는 글자일 뿐이고 `{`는 여전히 보간을 연다. `\\{`·`\"`는 그대로 이스케이프다.
    expect(hit("a.py", "s = rf\"\\{SerialPort(p)}\"")).toContain("device-io");
    expect(hit("a.py", "s = f\"x\\{socket.send(d)}\"")).toContain("device-io");
    expect(hit("a.py", "s = f\"\\\\{socket.send(d)}\"")).toContain("device-io");
    expect(hit("a.py", "s = f\"say \\\"SerialPort\\\" {name}\"")).toEqual([]);
    // R1-OAI-2: `$$"""`처럼 `$`가 여럿인 raw 보간은 삼중 따옴표라 줄 끝까지 코드로 둔다.
    expect(hit("a.cs", "var s = $$\"\"\"{{new SerialPort(p)}}\"\"\";")).toContain("device-io");
  });

  test.each([
    ["ports.py", "def show(socket, data):\n    return f\"{socket.send(data)}\"\n# /*v*/\n"],
    ["ports.cs", "class D {\n    static string Show(string p) => $\"{new SerialPort(p).PortName}\";\n}\n// /*v*/\n"],
    ["ports.vb", "Module D\n    Function Show(p As String) As String\n        Return $\"{New SerialPort(p).PortName}\"\n    End Function\nEnd Module\n' /*v*/\n"],
  ])("표본이 아니고 통과 원장이 비어도 runGate가 검토를 요구한다: %s", async (path, content) => {
    const env = repo();
    const files = pickSample({ [path]: content }, path, false);
    writeFileSync(join(env.work, path), files[path]!);
    const error = await runGate({ cwd: env.work, files: [path], ledgerPath: env.ledger }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CrossReviewRefusal);
    expect((error as Error).message).toContain("device-io");
  });

  test("순수 문자열 문구만 있는 파일은 같은 조건에서 검토를 요구하지 않는다", async () => {
    const env = repo();
    const files = pickSample({ "label.py": "TEXT = \"SerialPort status\"\n# /*v*/\n" }, "label.py", false);
    writeFileSync(join(env.work, "label.py"), files["label.py"]!);
    const outcome = (await runGate({ cwd: env.work, files: ["label.py"], ledgerPath: env.ledger })) as GateOutcome;
    expect(outcome.decision?.required).toEqual([]);
  });
});

describe("블록 주석 안의 줄은 marker를 걸지 않는다 (2026-10-29 SJF fixture-schema.sql)", () => {
  const triggers = (change: { path: string; changedLines: Parameters<typeof detectMarkers>[1] }) => detectMarkers(change.path, change.changedLines).map((hit) => hit.trigger);
  const whole = (path: string, content: string) => detectMarkers(path, markBlockComments(path, content.split("\n").map((text, index) => ({ line: index + 1, text })), content, null)).map((hit) => hit.trigger);
  const SQL_NOTE = ["/*", "  모드 두 열은 이 스크립트가 만들지 않는다. PLC MAP 에 신호가 없으면 DELETE 대상이 아니다.", "  - 이 파일은 UTF-8 BOM 으로 저장한다.", "*/", ""].join("\n");

  test("SQL의 /* */ 안 한글 PLC·BOM 설명은 marker가 아니고, 같은 파일의 DELETE FROM 코드 줄은 그대로 걸린다", async () => {
    expect(triggers(await changeOf("fixture-schema.sql", "SELECT 1;\n", `${SQL_NOTE}SELECT 1;\n`))).toEqual([]);
    expect(triggers(await changeOf("fixture-schema.sql", "SELECT 1;\n", `${SQL_NOTE}DELETE FROM dbo.QrCorrectLog WHERE Id = 1;\n`))).toEqual(["destructive-sql"]);
  });

  test("새 파일과 CRLF 파일도 같다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "n.sql"), `${SQL_NOTE.replaceAll("\n", "\r\n")}SELECT 1;\r\n`);
    expect(triggers((await collectChanges(spawnExec(), "git", env.work, ["n.sql"])).changed[0]!)).toEqual([]);
  });

  test("PowerShell <# #> 블록 설명은 marker가 아니고 블록 밖 Remove-Item은 걸린다", async () => {
    const note = "<#\n.SYNOPSIS\n  PLC 연결 전에 UTF-8 BOM 상태를 확인한다. password 는 읽지 않는다.\n#>\n";
    expect(triggers(await changeOf("run.ps1", "Write-Host 1\n", `${note}Write-Host 1\n`))).toEqual([]);
    expect(triggers(await changeOf("run.ps1", "Write-Host 1\n", `${note}Remove-Item $tmp\n`))).toEqual(["deletion"]);
  });

  test("블록 주석을 지우는 수정도 HEAD 내용으로 주석 줄을 알아 marker가 아니다", async () => {
    expect(triggers(await changeOf("fixture-schema.sql", `${SQL_NOTE}SELECT 1;\n`, "SELECT 1;\n"))).toEqual([]);
    // 이전 내용을 모르면 지금까지처럼 줄 하나로 판정한다.
    const lines = [{ line: 2, text: "  PLC MAP", removed: true }];
    expect(detectMarkers("a.sql", markBlockComments("a.sql", lines, null, null)).map((hit) => hit.trigger)).toEqual(["device-io"]);
  });

  test("줄 맨 앞이 아닌 /*(문자열 안 glob)는 코드를 가리지 않는다", () => {
    expect(whole("a.ts", "const glob = \"src/**/*.ts\";\nprocess.kill(pid);\nconst end = 1; /* x */\n")).toEqual(["process-termination"]);
  });

  test("Python은 def·class 바로 아래 docstring만 주석이고 execute(\"\"\"…\"\"\")의 SQL 본문은 코드다", () => {
    expect(whole("a.py", "def f():\n    \"\"\"\n    PLC 설명, UTF-8 BOM.\n    \"\"\"\n    return 1\n")).toEqual([]);
    expect(whole("a.py", "\"\"\"모듈 설명: PLC MAP\"\"\"\nx = 1\n")).toEqual([]);
    expect(whole("a.py", "cur.execute(\n    \"\"\"\n    DELETE FROM t\n    \"\"\"\n)\n")).toEqual(["destructive-sql"]);
  });

  test("HTML <!-- --> 블록 안 설명은 marker가 아니다", () => {
    expect(whole("a.html", "<!--\n  PLC 와 UTF-8 BOM 설명\n-->\n<p>x</p>\n")).toEqual([]);
  });

  test("닫는 표시 뒤에 코드가 있으면 그 줄은 코드로 남는다", () => {
    expect(whole("a.sql", "/*\nnote */ DELETE FROM t;\n")).toEqual(["destructive-sql"]);
  });

  // cross_review 1회차 지적(R1-OAI-1·2, R1-ADV-1): 문자열 안의 표시나 docstring이 아닌 삼중 따옴표가 실제 코드를 가리면 안 된다.
  test("줄을 넘는 문자열 안의 줄 맨 앞 /*는 주석이 아니고 그 뒤 실제 코드 줄은 그대로 걸린다", () => {
    expect(whole("a.ts", "const banner = `\n/*\n`;\ndb.execute(\"DELETE FROM accounts\");\n")).toEqual(["destructive-sql"]);
    expect(whole("a.sql", "SELECT '\n/*\n';\nDELETE FROM t;\n")).toEqual(["destructive-sql"]);
    expect(whole("a.cs", "var s = @\"\n/*\n\";\nFile.Delete(path);\n")).toEqual(["deletion"]);
    expect(whole("a.java", "String s = \"\"\"\n/*\n\"\"\";\nnew File(p).delete(); Runtime.exec(\"taskkill /F\");\n")).toEqual(["process-termination"]);
    expect(whole("a.ps1", "$s = @\"\n<#\n\"@\nRemove-Item $x\n")).toEqual(["deletion"]);
  });

  test("진짜 블록 주석 뒤의 코드는 계속 코드고, 같은 줄 앞쪽의 문자열 /*도 주석을 열지 못한다", () => {
    expect(whole("a.ts", "/* PLC note */\nprocess.kill(pid);\n")).toEqual(["process-termination"]);
    // 코드 뒤에서 여는 블록 주석은 줄 맨 앞에서 연 것이 아니므로 믿지 않는다(그 안의 줄은 지금까지처럼 코드로 판정한다).
    expect(whole("a.ts", "foo(\"x\"); /* tail\nPLC prose\n*/\nbar();\n")).toEqual(["device-io"]);
    expect(whole("a.ts", "const s = \"/*\"; process.kill(1);\nprocess.kill(2);\n")).toEqual(["process-termination", "process-termination"]);
  });

  test("Python은 def·class 머리(여러 줄 포함) 바로 아래만 docstring이고, 딕셔너리 값·인자 위치·삼중 문자열 안의 줄은 코드다", () => {
    expect(whole("a.py", "cursor.execute({\n    \"sql\":\n    \"\"\"\n    DELETE FROM accounts\n    \"\"\"\n}[\"sql\"])\n")).toEqual(["destructive-sql"]);
    expect(whole("a.py", "def f(a,\n      b):\n    \"\"\"\n    PLC 설명 UTF-8 BOM\n    \"\"\"\n    return a\n")).toEqual([]);
    expect(whole("a.py", "q = \"\"\"\ndef f():\n    not a docstring\n\"\"\"\ncur.execute(\"\"\"\nDELETE FROM t\n\"\"\")\n")).toEqual(["destructive-sql"]);
    expect(whole("a.py", "cur.execute(\"\"\"\nDELETE FROM t\n\"\"\"\n)\n\"\"\"\nPLC\n\"\"\"\n")).toEqual(["destructive-sql", "device-io"]);
  });
  // 2회차 지적(R2-OAI-1·2): Groovy의 ''' 문자열, Python 문자열 안의 이스케이프한 삼중 따옴표.
  test("Groovy ''' 문자열 안의 /*와 Python 문자열 안의 이스케이프한 \"\"\"는 뒤의 실제 코드를 가리지 못한다", () => {
    expect(whole("a.groovy", "def text = '''\n/*\n'''\nprintln('x'); \"taskkill /F\".execute()\n")).toEqual(["process-termination"]);
    expect(whole("a.py", "payload = \"\"\"\n\\\"\"\"\ndef fake():\n\"\"\"\ncursor.execute(\"DELETE FROM users\")\n")).toEqual(["destructive-sql"]);
  });
});
