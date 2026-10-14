import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  authorFamily,
  buildReviewPrompt,
  CrossReviewRefusal,
  detectMarkers,
  isCodeFile,
  MAX_INPUT_BYTES,
  parseChangedLines,
  parseReviewerOutput,
  reviewerFamilies,
  ReviewerCallError,
  runGate,
  runResolve,
  runReview,
  sampleSelected,
  spawnExec,
  type Family,
  type ReviewDeps,
} from "../lib/cross-review";
import { createRoutingLedger, readCrossReviewRecords, type CrossReviewLedgerRecord } from "../lib/routing-ledger";

const OPUS = "anthropic/claude-opus-5-5";
const ASTRA = "openai-codex/gpt-6-astra";
const roots: string[] = [];
const signal = new AbortController().signal;
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function sh(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** 파일 내용에서 git이 계산하는 blob과 같은 값. 표본 여부를 파일 쓰기 전에 고르는 데 쓴다. */
const blobOf = (content: string) => createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0${content}`).digest("hex");

interface RepoEnv { dir: string; work: string; ledger: string; snapshots: string }

function repo(): RepoEnv {
  const dir = mkdtempSync(join(tmpdir(), "cross-review-"));
  roots.push(dir);
  const work = join(dir, "work");
  mkdirSync(work);
  sh(work, "init", "-q", "--initial-branch=main");
  sh(work, "config", "user.name", "t");
  sh(work, "config", "user.email", "t@example.invalid");
  writeFileSync(join(work, "base.txt"), "base\n");
  sh(work, "add", "base.txt");
  sh(work, "commit", "-q", "-m", "base");
  return { dir, work, ledger: join(dir, "ledger.jsonl"), snapshots: join(dir, "snapshots") };
}

/** 한 파일 커밋이 표본에 걸리거나(want=true) 걸리지 않도록 줄 하나를 바꿔 가며 내용을 고른다. */
function contentWhere(path: string, base: string, want: boolean): string {
  for (let n = 0; n < 500; n++) {
    const content = `${base}// v${n}\n`;
    if (sampleSelected([{ path, blob: blobOf(content) }]) === want) return content;
  }
  throw new Error("no content found");
}

const MARKER_BASE = "import { rmSync } from \"node:fs\";\nexport const wipe = (p: string) => rmSync(p, { recursive: true });\n";
const PLAIN_BASE = "export const add = (a: number, b: number) => a + b;\n";

describe("계열 매핑", () => {
  test("anthropic 저자는 OpenAI reviewer, openai·그 밖의 provider는 Anthropic reviewer로 간다", () => {
    expect(authorFamily(`${OPUS}:high`)).toBe("anthropic");
    expect(authorFamily(ASTRA)).toBe("openai");
    expect(authorFamily("openai/gpt-5")).toBe("openai");
    expect(authorFamily("b-ai/deepseek-v4.1-flash")).toBe("other");
    expect(authorFamily("google-antigravity/gemini-3.8-flash")).toBe("other");
    expect(reviewerFamilies([OPUS], undefined)).toEqual(["openai"]);
    expect(reviewerFamilies([ASTRA], undefined)).toEqual(["anthropic"]);
    expect(reviewerFamilies(["b-ai/deepseek-v4.1-flash"], undefined)).toEqual(["anthropic"]);
    expect(reviewerFamilies(["google-antigravity/gemini-3.8-flash"], undefined)).toEqual(["anthropic"]);
  });

  test("저자가 두 계열에 걸치면 둘 다 돌리고, main은 현재 모델로 풀며 풀 수 없으면 던진다", () => {
    expect(reviewerFamilies([OPUS, ASTRA], undefined)).toEqual(["anthropic", "openai"]);
    expect(reviewerFamilies(["main"], OPUS)).toEqual(["openai"]);
    expect(reviewerFamilies(["main", ASTRA], OPUS)).toEqual(["anthropic", "openai"]);
    expect(() => reviewerFamilies(["main"], undefined)).toThrow("current model");
    expect(() => reviewerFamilies([], OPUS)).toThrow("at least one");
  });
});

describe("파일 분류", () => {
  test("문서·테스트·생성물은 제외하고 나머지는 모두 코드다", () => {
    for (const path of ["README.md", "notes.txt", "doc/history/a.ts", "docs/harness.md", "a/b.test.ts", "x.spec.mjs", "pkg/tests/helper.ts", "test/a.js", "__tests__/z.ts", "Tools/CUELO_Setup/files/source-integrity.json", "bun.lock", "patches/core-x-test.ts", "Tools/deploy-live-test.ps1"]) {
      expect(isCodeFile(path), path).toBe(false);
    }
    for (const path of ["a.ts", "Tools/x/setup.ps1", "config.yml", "package.json", "src/doc/render.ts", "src/testing.ts", "deploy.sh"]) {
      expect(isCodeFile(path), path).toBe(true);
    }
  });
});

describe("marker", () => {
  const hit = (text: string, path = "src/a.ts") => detectMarkers(path, [{ line: 1, text }]).map((item) => item.trigger);

  test("7개 trigger를 각각 잡는다", () => {
    expect(hit("process.kill(pid, 'SIGKILL')")).toContain("process-termination");
    expect(hit("Stop-Process -Id $pid -Force")).toContain("process-termination");
    expect(hit("fs.rmSync(dir, { recursive: true })")).toContain("deletion");
    expect(hit("rm -rf build")).toContain("deletion");
    expect(hit("DROP TABLE users;")).toContain("destructive-sql");
    expect(hit("db.exec('delete from orders')")).toContain("destructive-sql");
    expect(hit("run('gh release create v1')")).toContain("deploy-release-migration");
    expect(hit("x", "Tools/setup/deploy-live.ps1")).toContain("deploy-release-migration");
    expect(hit("x", "alembic/versions/001.py")).toContain("deploy-release-migration");
    expect(hit("const password = read()")).toContain("credentials-auth");
    expect(hit("headers.Authorization = `Bearer ${x}`")).toContain("credentials-auth");
    expect(hit("const refresh_token = load()")).toContain("credentials-auth");
    expect(hit("Encoding.GetEncoding(949)")).toContain("encoding");
    expect(hit("write(Buffer.from([0xEF, 0xBB, 0xBF]))  // BOM")).toContain("encoding"); // 줄 끝 주석은 코드 줄의 일부다
    expect(hit("const bom = \"\\uFEFF\"")).toContain("encoding");
    expect(hit("const port = new SerialPort({ path: 'COM3' })")).toContain("device-io");
    expect(hit("const s = new Socket()")).toContain("device-io");
  });

  test("token 단독·일반 코드·주석 줄은 잡지 않는다", () => {
    expect(hit("const tokens = countTokens(text)")).toEqual([]);
    expect(hit("maxTokens: 8192, tokenizer: 'x'")).toEqual([]);
    expect(hit("// rm -rf is dangerous, kill(pid)")).toEqual([]);
    expect(hit("# Stop-Process later")).toEqual([]);
    expect(hit("const total = items.map((item) => item.price).reduce((a, b) => a + b, 0)")).toEqual([]);
    expect(hit("export const add = (a: number, b: number) => a + b;")).toEqual([]);
  });

  test("diff에서는 추가·삭제 줄을 모두 보고 줄 번호는 각각 새·이전 파일 기준이다", () => {
    const diff = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,3 +1,3 @@", " keep", "-fs.rmSync(old)", "+const x = 1;", " tail"].join("\n");
    const lines = parseChangedLines(diff);
    expect(lines).toEqual([{ line: 2, text: "fs.rmSync(old)", removed: true }, { line: 2, text: "const x = 1;" }]);
    expect(detectMarkers("a.ts", lines)).toMatchObject([{ trigger: "deletion", line: 2, removed: true }]);
    const added = ["@@ -1,1 +4,2 @@", " ctx", "+fs.rmSync(new)"].join("\n");
    expect(parseChangedLines(added)).toEqual([{ line: 5, text: "fs.rmSync(new)" }]);
  });
});

describe("표본", () => {
  test("같은 path+blob 목록은 순서와 무관하게 언제나 같은 결과이고 약 10%만 뽑힌다", () => {
    const files = [{ path: "a.ts", blob: "1".repeat(40) }, { path: "b.ts", blob: "2".repeat(40) }];
    expect(sampleSelected(files)).toBe(sampleSelected([...files].reverse()));
    expect(sampleSelected(files)).toBe(sampleSelected(files));
    expect(sampleSelected([])).toBe(false);
    let selected = 0;
    for (let n = 0; n < 2000; n++) if (sampleSelected([{ path: `f${n}.ts`, blob: blobOf(String(n)) }])) selected++;
    expect(selected).toBeGreaterThan(140);
    expect(selected).toBeLessThan(260);
  });
});

describe("reviewer 답 해석", () => {
  test("펜스·앞뒤 말이 있어도 JSON을 읽고, 모르는 등급은 major로 올린다", () => {
    const body = '{"findings":[{"severity":"blocker","file":"a.ts","line":3,"claim":"c","why":"w"},{"severity":"weird","claim":"d"}],"summary":"s"}';
    for (const raw of [body, `\`\`\`json\n${body}\n\`\`\``, `Here you go:\n${body}\nDone.`]) {
      const parsed = parseReviewerOutput(raw);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.findings).toHaveLength(2);
        expect(parsed.findings[0]).toEqual({ severity: "blocker", file: "a.ts", line: 3, claim: "c", why: "w" });
        expect(parsed.findings[1].severity).toBe("major");
      }
    }
    expect(parseReviewerOutput('{"findings":[]}')).toEqual({ ok: true, findings: [], summary: "" });
  });

  test("모양이 틀리거나 JSON이 아니면 ok:false다", () => {
    for (const raw of ["PASS", "", "{\"findings\": 3}", "{\"findings\":[{\"severity\":\"major\"}]}", "{not json"]) {
      expect(parseReviewerOutput(raw).ok, raw).toBe(false);
    }
  });
});

function deps(env: RepoEnv, answers: Partial<Record<Family, string | Error>>, calls: { family: Family; prompt: string }[] = []): ReviewDeps {
  const ledger = createRoutingLedger(env.ledger);
  return {
    cwd: env.work, sessionId: "s1", mainModel: OPUS, exec: spawnExec(), snapshotRoot: env.snapshots,
    readAll: () => readCrossReviewRecords(env.ledger), append: (record) => ledger.append(record),
    newId: () => `xr-test-${++idCounter}`,
    complete: async (family, prompt) => {
      calls.push({ family, prompt });
      const answer = answers[family];
      const model = family === "openai" ? ASTRA : OPUS;
      if (answer instanceof ReviewerCallError) throw answer;
      if (answer instanceof Error) throw new ReviewerCallError(answer.message, model);
      return { model, text: answer ?? '{"findings":[]}' };
    },
  };
}
let idCounter = 0;
const finding = (claim: string, severity = "major") => JSON.stringify({ findings: [{ severity, file: "a.ts", line: 1, claim, why: "because" }], summary: "s" });
const input = (over: Partial<Parameters<typeof runReview>[0]> = {}) => ({ files: ["a.ts"], acceptance: "Never delete user files.", authors: ["main"], ...over });

describe("runReview", () => {
  test("Anthropic 저자의 변경은 OpenAI reviewer 한 명에게만 가고 diff·acceptance·체크리스트만 담는다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), MARKER_BASE);
    const calls: { family: Family; prompt: string }[] = [];
    const result = await runReview(input(), deps(env, { openai: finding("rmSync can delete the wrong dir", "blocker") }, calls), signal);
    expect(calls.map((call) => call.family)).toEqual(["openai"]);
    expect(calls[0].prompt).toContain("Never delete user files.");
    expect(calls[0].prompt).toContain("<new-file path=\"a.ts\">");
    expect(calls[0].prompt).toContain("2: export const wipe");
    expect(calls[0].prompt).toContain("CHECKLIST");
    expect(result).toMatchObject({ reviewId: expect.stringMatching(/^xr-test-\d+$/), round: 1, passable: true, triggers: ["deletion"] });
    expect(result.reviewers).toMatchObject([{ family: "openai", model: ASTRA, status: "ok" }]);
    expect(result.findings).toMatchObject([{ id: "R1-OAI-1", severity: "blocker", reviewer: ASTRA, claim: "rmSync can delete the wrong dir" }]);
    expect(existsSync(join(result.snapshotDir, "manifest.json"))).toBe(true);
    const [record] = readCrossReviewRecords(env.ledger);
    expect(record).toMatchObject({ type: "cross-review", reviewId: result.reviewId, files: [{ path: "a.ts", blob: blobOf(MARKER_BASE) }] });
  });

  test("저자가 두 계열이면 두 reviewer가 모두 돌고 finding id에 reviewer 표지가 붙는다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), PLAIN_BASE);
    const calls: { family: Family; prompt: string }[] = [];
    const result = await runReview(input({ authors: [OPUS, ASTRA] }), deps(env, { openai: finding("x"), anthropic: finding("y") }, calls), signal);
    expect(calls.map((call) => call.family).sort()).toEqual(["anthropic", "openai"]);
    expect(result.findings.map((item) => item.id).sort()).toEqual(["R1-ANT-1", "R1-OAI-1"]);
  });

  test("해석할 수 없는 답은 원문과 함께 기록되고 그 체인은 어떤 경우에도 통과하지 못한다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), PLAIN_BASE);
    const d = deps(env, { openai: "PASS - looks fine" });
    const result = await runReview(input(), d, signal);
    expect(result.passable).toBe(false);
    expect(result.reviewers[0]).toMatchObject({ status: "unparsable", raw: "PASS - looks fine" });
    const resolved = await runResolve({ reviewId: result.reviewId, resolutions: [] }, { exec: spawnExec(), readAll: d.readAll, append: d.append });
    expect(resolved.pass).toBe(false);
    expect(resolved.unusable).toContain("never pass");
    await expect(runReview(input({ previousReviewId: result.reviewId }), d, signal)).rejects.toThrow("can never pass");
  });

  test("호출이 실패한 reviewer가 있으면 기록은 남지만 통과 불가이고, 전부 실패해도 기록한다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), PLAIN_BASE);
    const partial = await runReview(input({ authors: [OPUS, ASTRA] }), deps(env, { openai: new Error("timeout") }), signal);
    expect(partial.passable).toBe(false);
    expect(partial.reviewers.find((item) => item.family === "openai")).toMatchObject({ status: "error", error: "timeout" });
    const all = await runReview(input(), deps(env, { openai: new Error("down") }), signal);
    expect(all).toMatchObject({ passable: false, reviewers: [{ status: "error", error: "down" }] });
    expect(all.nextStep).toContain("can never pass");
    const records = readCrossReviewRecords(env.ledger).filter((record) => record.type === "cross-review");
    expect(records).toHaveLength(2);
    expect(records.at(-1)).toMatchObject({ reviewId: all.reviewId, passable: false });
  });

  test("해석할 수 없는 긴 답은 결과에는 전부, 원장에는 앞 20 KB만 남긴다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), PLAIN_BASE);
    const long = "x".repeat(30_000);
    const result = await runReview(input(), deps(env, { openai: long }), signal);
    expect(result.reviewers[0].raw).toBe(long.slice(0, 2_000));
    expect(result.reviewers[0].rawChars).toBe(30_000);
    expect(readFileSync(result.reviewers[0].rawFile!, "utf8")).toBe(long);
    const [record] = readCrossReviewRecords(env.ledger) as { reviewers: { raw: string; rawFile: string }[] }[];
    expect(record.reviewers[0].raw).toHaveLength(20_000);
    expect(record.reviewers[0].rawFile).toBe(result.reviewers[0].rawFile!);
  });

  test("비밀 경로·개인키 블록 파일은 보내지 않고, 비밀 값은 가린 채 심사한다", async () => {
    const env = repo();
    const passwordKey = ["pass", "word"].join("");
    writeFileSync(join(env.work, "a.ts"), PLAIN_BASE);
    writeFileSync(join(env.work, ".env.local"), "X=1\n");
    writeFileSync(join(env.work, "b.ts"), `const ${passwordKey} = "hunter2-not-real";\nexport const kept = 1;\n`);
    writeFileSync(join(env.work, "c.json"), `{"${passwordKey}": "json-secret-value", "name": "kept-name"}\n`);
    writeFileSync(join(env.work, "d.ts"), `const pem = \`${["-----BEGIN RSA PRIV", "ATE KEY-----"].join("")}\`;\n`);
    const calls: { family: Family; prompt: string }[] = [];
    const result = await runReview(input({ files: ["a.ts", ".env.local", "b.ts", "c.json", "d.ts"] }), deps(env, {}, calls), signal);
    expect(calls[0].prompt).not.toMatch(/hunter2|X=1|json-secret-value|BEGIN RSA/);
    expect(calls[0].prompt).toContain("[REDACTED]");
    expect(calls[0].prompt).toContain("export const kept = 1;");
    expect(calls[0].prompt).toContain("kept-name");
    expect(result.skipped.map((item) => item.path).sort()).toEqual([".env.local", "d.ts"]);
    expect(result.redacted.map((item) => item.path).sort()).toEqual(["b.ts", "c.json"]);
    const [record] = readCrossReviewRecords(env.ledger) as { files: { path: string }[] }[];
    expect(record.files.map((file) => file.path).sort()).toEqual(["a.ts", "b.ts", "c.json"]);
  });

  test("입력이 상한을 넘으면 모델을 부르지 않고 나누라고 거절한다(긴 acceptance도 포함)", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), `${"const x = 1;\n".repeat(Math.ceil(MAX_INPUT_BYTES / 10))}`);
    const calls: { family: Family; prompt: string }[] = [];
    await expect(runReview(input(), deps(env, {}, calls), signal)).rejects.toThrow("Split the change");
    writeFileSync(join(env.work, "a.ts"), PLAIN_BASE);
    await expect(runReview(input({ acceptance: "criterion ".repeat(MAX_INPUT_BYTES / 5) }), deps(env, {}, calls), signal)).rejects.toThrow("Split the change");
    expect(calls).toEqual([]);
  });

  test("준비하는 동안 파일이 바뀌면 사본을 만들지 않고 다시 하라고 거절한다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), PLAIN_BASE);
    const base = deps(env, {});
    let diffs = 0;
    const exec = spawnExec();
    const racing = { ...base, exec: async (command: string, args: string[], options: { cwd: string }) => {
      const result = await exec(command, args, options);
      if (args.includes("hash-object") && ++diffs === 1) writeFileSync(join(env.work, "a.ts"), `${PLAIN_BASE}// edited mid-review\n`);
      return result;
    } };
    await expect(runReview(input(), racing, signal)).rejects.toThrow("changed while the review input was being prepared");
    expect(readCrossReviewRecords(env.ledger)).toEqual([]);
  });

  test("바뀐 것이 없거나 파일 인자가 잘못되면 거절한다", async () => {
    const env = repo();
    await expect(runReview(input({ files: ["base.txt"] }), deps(env, {}), signal)).rejects.toThrow("Nothing to review");
    await expect(runReview(input({ files: ["/etc/passwd"] }), deps(env, {}), signal)).rejects.toThrow("cwd-relative");
    await expect(runReview(input({ acceptance: " " }), deps(env, {}), signal)).rejects.toThrow("acceptance");
  });

  test("2회차는 1회차 사본과 현재의 delta만 보내고 3회차는 거절한다", async () => {
    const env = repo();
    const far = Array.from({ length: 40 }, (_, index) => `export const filler${index} = ${index};\n`).join("");
    writeFileSync(join(env.work, "a.ts"), `export const two = 2;\n${far}export const three = 3;\n`);
    const d = deps(env, { openai: finding("two is wrong") });
    const first = await runReview(input(), d, signal);
    writeFileSync(join(env.work, "a.ts"), `export const two = 22;\n${far}export const three = 3;\n`);
    const calls: { family: Family; prompt: string }[] = [];
    const second = await runReview(input({ previousReviewId: first.reviewId }), { ...d, complete: async (family, prompt) => { calls.push({ family, prompt }); return { model: ASTRA, text: '{"findings":[]}' }; } }, signal);
    expect(second.round).toBe(2);
    expect(calls[0].prompt).toContain("<delta path=\"a.ts\">");
    expect(calls[0].prompt).toContain("-export const two = 2;");
    expect(calls[0].prompt).toContain("+export const two = 22;");
    expect(calls[0].prompt).not.toContain("export const three");
    expect(calls[0].prompt).not.toContain("filler30");
    expect(calls[0].prompt).toContain("two is wrong"); // 1회차 지적이 reviewer에게 전달된다
    await expect(runReview(input({ previousReviewId: second.reviewId }), d, signal)).rejects.toThrow("Round limit");
    await expect(runReview(input({ previousReviewId: first.reviewId }), d, signal)).rejects.toThrow("already has a round 2");
    await expect(runReview(input({ previousReviewId: "nope" }), d, signal)).rejects.toThrow("unknown");
    // 1회차를 resolve하려 하면 2회차가 이어졌으므로 거절한다.
    await expect(runResolve({ reviewId: first.reviewId, resolutions: [] }, { exec: spawnExec(), readAll: d.readAll, append: d.append })).rejects.toThrow("round 2");
  });

  test("2회차에서 바뀐 것이 없으면 거절한다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), PLAIN_BASE);
    const d = deps(env, {});
    const first = await runReview(input(), d, signal);
    await expect(runReview(input({ previousReviewId: first.reviewId }), d, signal)).rejects.toThrow("nothing changed since round 1");
  });
});

describe("runResolve", () => {
  async function reviewed(answers: Partial<Record<Family, string>>) {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), PLAIN_BASE);
    const d = deps(env, answers);
    const review = await runReview(input(), d, signal);
    const rd = { exec: spawnExec(), readAll: d.readAll, append: d.append };
    return { env, d, review, rd };
  }

  test("지적이 없으면 빈 판정으로 통과하고 resolve 시점 blob이 지문이 된다", async () => {
    const { review, rd } = await reviewed({});
    const result = await runResolve({ reviewId: review.reviewId, resolutions: [] }, rd);
    expect(result).toMatchObject({ pass: true, open: [], rejected: [], files: [{ path: "a.ts", blob: blobOf(PLAIN_BASE) }] });
    expect(rd.readAll().filter((record) => record.type === "cross-review-resolve")).toHaveLength(1);
  });

  test("근거 없는 판정·없는 id·잘못된 status는 거절되고 finding은 열려 있다", async () => {
    const { review, rd } = await reviewed({ openai: finding("bad") });
    const id = review.findings[0].id;
    const result = await runResolve({ reviewId: review.reviewId, resolutions: [{ id, status: "fixed", evidence: "  " }, { id: "R9-X-1", status: "fixed", evidence: "e" }, { id, status: "ok", evidence: "e" }] }, rd);
    expect(result.pass).toBe(false);
    expect(result.open).toEqual([id]);
    expect(result.rejected.map((item) => item.reason)).toEqual(["evidence is required and must not be empty", "no such finding in this review chain", "status must be fixed, refuted or limit"]);
  });

  test("판정은 나눠 보내도 되고 모두 닫히면 통과하며 통과 뒤 내용이 바뀌면 지문은 이전 blob을 덮는다", async () => {
    const answers = { openai: JSON.stringify({ findings: [{ severity: "major", claim: "a" }, { severity: "minor", claim: "b" }] }) };
    const { env, review, rd } = await reviewed(answers);
    const [one, two] = review.findings.map((item) => item.id);
    expect((await runResolve({ reviewId: review.reviewId, resolutions: [{ id: one, status: "fixed", evidence: "commit abc" }] }, rd)).open).toEqual([two]);
    const done = await runResolve({ reviewId: review.reviewId, resolutions: [{ id: two, status: "limit", evidence: "documented in README" }] }, rd);
    expect(done).toMatchObject({ pass: true, open: [] });
    expect(done.files[0].blob).toBe(blobOf(PLAIN_BASE));
    writeFileSync(join(env.work, "a.ts"), `${PLAIN_BASE}// changed\n`);
    const records = rd.readAll();
    const passes = records.filter((record): record is Extract<CrossReviewLedgerRecord, { type: "cross-review-resolve" }> => record.type === "cross-review-resolve" && record.pass);
    expect(passes).toHaveLength(1);
    expect(passes[0].files[0].blob).not.toBe(blobOf(`${PLAIN_BASE}// changed\n`));
  });

  test("2회차 체인은 1회차 finding까지 모두 닫아야 통과한다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), PLAIN_BASE);
    const d = deps(env, { openai: finding("first") });
    const first = await runReview(input(), d, signal);
    writeFileSync(join(env.work, "a.ts"), `${PLAIN_BASE}export const fixed = true;\n`);
    const second = await runReview(input({ previousReviewId: first.reviewId }), { ...d, complete: async () => ({ model: ASTRA, text: finding("second") }) }, signal);
    const rd = { exec: spawnExec(), readAll: d.readAll, append: d.append };
    expect(second.findings.map((item) => item.id)).toEqual(["R2-OAI-1"]);
    const partial = await runResolve({ reviewId: second.reviewId, resolutions: [{ id: "R2-OAI-1", status: "refuted", evidence: "e" }] }, rd);
    expect(partial).toMatchObject({ pass: false, open: ["R1-OAI-1"] });
    const full = await runResolve({ reviewId: second.reviewId, resolutions: [{ id: "R1-OAI-1", status: "fixed", evidence: "e" }] }, rd);
    expect(full).toMatchObject({ pass: true, open: [] });
  });
});

describe("게이트", () => {
  const gateOptions = (env: RepoEnv, over: Partial<Parameters<typeof runGate>[0]> = {}) =>
    ({ cwd: env.work, files: ["a.ts"], ledgerPath: env.ledger, ...over });

  async function passReview(env: RepoEnv, files: string[]) {
    const d = deps(env, {});
    const review = await runReview(input({ files }), d, signal);
    return runResolve({ reviewId: review.reviewId, resolutions: [] }, { exec: spawnExec(), readAll: d.readAll, append: d.append });
  }

  test("문서만, 또는 표본·marker에 걸리지 않는 코드는 검토를 요구하지 않는다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "notes.md"), "# markdown with rm -rf and password\n");
    expect((await runGate(gateOptions(env, { files: ["notes.md"] }))).decision?.required).toEqual([]);
    const plain = contentWhere("a.ts", PLAIN_BASE, false);
    writeFileSync(join(env.work, "a.ts"), plain);
    expect((await runGate(gateOptions(env))).decision).toEqual({ required: [], uncovered: [] });
  });

  test("테스트 파일은 marker가 있어도 제외한다", async () => {
    const env = repo();
    mkdirSync(join(env.work, "tests"));
    writeFileSync(join(env.work, "tests", "a.test.ts"), MARKER_BASE);
    expect((await runGate(gateOptions(env, { files: ["tests/a.test.ts"] }))).decision?.required).toEqual([]);
  });

  test("marker가 걸린 코드는 검토가 없으면 거절하고, 이유와 다음 단계를 말한다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), MARKER_BASE);
    const error = await runGate(gateOptions(env)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CrossReviewRefusal);
    const message = (error as Error).message;
    expect(message).toContain("- a.ts: marker deletion at L2");
    expect(message).toContain("cross_review");
    expect(message).toContain("crossReviewWaiver");
  });

  test("통과한 검토의 blob이 같으면 통과하고, 통과 뒤 내용이 바뀌면 다시 거절한다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), MARKER_BASE);
    await passReview(env, ["a.ts"]);
    expect((await runGate(gateOptions(env))).decision?.uncovered).toEqual([]);
    writeFileSync(join(env.work, "a.ts"), `${MARKER_BASE}export const extra = 1;\n`);
    await expect(runGate(gateOptions(env))).rejects.toThrow("content changed after the pass");
  });

  test("통과하지 못한 resolve는 아무것도 덮지 않는다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), MARKER_BASE);
    const d = deps(env, { openai: finding("open one") });
    const review = await runReview(input(), d, signal);
    await runResolve({ reviewId: review.reviewId, resolutions: [] }, { exec: spawnExec(), readAll: d.readAll, append: d.append });
    await expect(runGate(gateOptions(env))).rejects.toBeInstanceOf(CrossReviewRefusal);
  });

  test("파일마다 다른 통과 기록이 덮을 수 있고, 한 파일이라도 덮이지 않으면 그 파일만 거절한다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), MARKER_BASE);
    writeFileSync(join(env.work, "b.ts"), `${MARKER_BASE}export const b = 1;\n`);
    await passReview(env, ["a.ts"]);
    const error = await runGate(gateOptions(env, { files: ["a.ts", "b.ts"] })).catch((caught: unknown) => caught as Error);
    expect((error as Error).message).toContain("- b.ts:");
    expect((error as Error).message).not.toContain("- a.ts:");
    await passReview(env, ["b.ts"]);
    expect((await runGate(gateOptions(env, { files: ["a.ts", "b.ts"] }))).decision?.uncovered).toEqual([]);
  });

  test("crossReviewHighRisk 선언은 marker가 없어도 검토를 요구한다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), contentWhere("a.ts", PLAIN_BASE, false));
    await expect(runGate(gateOptions(env, { highRisk: true }))).rejects.toThrow("declared high-risk");
  });

  test("결정적 10% 표본에 뽑힌 코드는 marker가 없어도 검토를 요구한다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), contentWhere("a.ts", PLAIN_BASE, true));
    await expect(runGate(gateOptions(env))).rejects.toThrow("sampled");
  });

  test("이미 커밋돼 바뀐 것이 없는 파일(resume-push)은 검사하지 않는다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), MARKER_BASE);
    sh(env.work, "add", "a.ts");
    sh(env.work, "commit", "-q", "-m", "already committed");
    expect(await runGate(gateOptions(env))).toMatchObject({ checked: true, decision: { required: [], uncovered: [] } });
  });

  test("waiver는 사유와 함께 원장에 기록되고 통과시키며, 필요 없을 땐 기록하지 않는다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), MARKER_BASE);
    const outcome = await runGate(gateOptions(env, { waiver: "user said skip for this hotfix" }));
    expect(outcome.waived).toBe(true);
    const waivers = readCrossReviewRecords(env.ledger).filter((record) => record.type === "cross-review-waiver");
    expect(waivers).toMatchObject([{ reason: "user said skip for this hotfix", files: [{ path: "a.ts", blob: blobOf(MARKER_BASE) }] }]);
    writeFileSync(join(env.work, "b.txt"), "docs only\n");
    await runGate(gateOptions(env, { files: ["b.txt"], waiver: "unneeded" }));
    expect(readCrossReviewRecords(env.ledger).filter((record) => record.type === "cross-review-waiver")).toHaveLength(1);
  });

  test("원장이 길어 1MiB 꼬리 밖으로 밀려도 오래된 통과 기록을 찾는다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), MARKER_BASE);
    await passReview(env, ["a.ts"]);
    const filler = `${JSON.stringify({ type: "dispatch", pad: "x".repeat(1000) })}\n`;
    writeFileSync(env.ledger, `${readFileSync(env.ledger, "utf8")}${filler.repeat(1200)}`);
    expect((await runGate(gateOptions(env))).decision?.uncovered).toEqual([]);
  });
});

describe("프롬프트", () => {
  test("2회차는 delta 범위와 1회차 지적을 알리고 사용자 프로필·대화 문구를 담지 않는다", () => {
    const prompt = buildReviewPrompt({ acceptance: "A", round: 2, parts: [{ path: "a.ts", kind: "delta", text: "@@" }], previousFindings: [{ id: "R1-OAI-1", severity: "major", file: "a.ts", claim: "claim one", why: "w", reviewer: ASTRA }] });
    expect(prompt).toContain("ROUND 2");
    expect(prompt).toContain("claim one");
    expect(prompt).toContain("untrusted data");
  });
});

describe("게이트 보강", () => {
  const options = (env: RepoEnv, over: Partial<Parameters<typeof runGate>[0]> = {}) => ({ cwd: env.work, files: ["a.ts"], ledgerPath: env.ledger, ...over });

  test("삭제한 줄에 marker가 있으면(보호 코드를 지우는 변경) 검토를 요구한다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), `export const check = (${["pass", "word"].join("")}: string) => {\n  return verify(${["pass", "word"].join("")});\n};\n`);
    sh(env.work, "add", "a.ts");
    sh(env.work, "commit", "-q", "-m", "add");
    writeFileSync(join(env.work, "a.ts"), "export const check = () => true;\n");
    await expect(runGate(options(env))).rejects.toThrow("removed L");
  });

  test("코드 파일이 있으면 요청한 모든 경로(안 바뀐 코드 파일 포함)의 blob을 돌려주고, 문서만이면 주지 않는다", async () => {
    const env = repo();
    const content = contentWhere("a.ts", PLAIN_BASE, false);
    writeFileSync(join(env.work, "a.ts"), content);
    writeFileSync(join(env.work, "notes.md"), "docs\n");
    writeFileSync(join(env.work, "clean.ts"), PLAIN_BASE);
    sh(env.work, "add", "clean.ts");
    sh(env.work, "commit", "-q", "-m", "clean");
    const outcome = await runGate(options(env, { files: ["a.ts", "notes.md", "clean.ts"] }));
    expect(outcome.gateBlobs).toEqual({ "a.ts": blobOf(content), "notes.md": blobOf("docs\n"), "clean.ts": blobOf(PLAIN_BASE) });
    expect((await runGate(options(env, { files: ["notes.md"] }))).gateBlobs).toBeUndefined();
  });

  test("저장소 상태를 git으로 읽지 못하면 열어 두지 않고 거절하고, 입력 모양 오류는 finalizer에 맡긴다", async () => {
    const env = repo();
    const notRepo = mkdtempSync(join(tmpdir(), "cross-review-norepo-"));
    roots.push(notRepo);
    writeFileSync(join(notRepo, "a.ts"), PLAIN_BASE);
    await expect(runGate({ cwd: notRepo, files: ["a.ts"], ledgerPath: env.ledger })).rejects.toThrow("could not be read");
    expect(await runGate(options(env, { files: ["/etc/hosts"] }))).toEqual({ checked: false });
  });

  test("2회차는 1회차와 다른 저장소의 파일을 같은 이름으로 비교하지 않는다", async () => {
    const first = repo();
    writeFileSync(join(first.work, "a.ts"), PLAIN_BASE);
    const d = deps(first, {});
    const review = await runReview(input(), d, signal);
    const second = repo();
    writeFileSync(join(second.work, "a.ts"), `${PLAIN_BASE}// other repo\n`);
    await expect(runReview(input({ previousReviewId: review.reviewId }), { ...d, cwd: second.work }, signal)).rejects.toThrow("same repository");
  });
});

describe("2회차 심사 보강", () => {
  const optionsFor = (env: RepoEnv, files: string[]) => ({ cwd: env.work, files, ledgerPath: env.ledger });

  test("따옴표로 감싼 비밀 값은 공백이 있어도 통째로 가린다", async () => {
    const env = repo();
    const key = ["pass", "word"].join("");
    writeFileSync(join(env.work, "a.ts"), `export const ok = 1;\n`);
    writeFileSync(join(env.work, "c.json"), `{"${key}": "zebra quartz plum", "name": "kept-name"}\n`);
    writeFileSync(join(env.work, "b.ts"), `const cfg = { ${key}: 'yodel plum quartz', keep: 2 };\nconst ${key}2 = "zebra quartz plum yodel";\n`);
    const calls: { family: Family; prompt: string }[] = [];
    await runReview(input({ files: ["a.ts", "c.json", "b.ts"] }), deps(env, {}, calls), signal);
    expect(calls[0].prompt).not.toMatch(/zebra|quartz|plum|yodel/);
    expect(calls[0].prompt).toContain("kept-name");
    expect(calls[0].prompt).toContain("keep: 2");
  });

  test("파일을 통째로 지우는 변경도 지운 줄의 marker로 검토를 요구한다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "guard.ts"), `export const check = (${["pass", "word"].join("")}: string) => verify(${["pass", "word"].join("")});\n`);
    sh(env.work, "add", "guard.ts");
    sh(env.work, "commit", "-q", "-m", "guard");
    rmSync(join(env.work, "guard.ts"));
    await expect(runGate(optionsFor(env, ["guard.ts"]))).rejects.toThrow("removed L1");
  });

  test("1회차 사본은 reviewer가 본 바이트이고, 읽은 뒤 파일이 바뀌었다가 되돌아와도 어긋나지 않는다", async () => {
    const env = repo();
    const seen = `${PLAIN_BASE}// seen by the reviewer\n`;
    const flipped = `${PLAIN_BASE}// flipped meanwhile\n`;
    const file = join(env.work, "a.ts");
    writeFileSync(file, seen);
    const base = deps(env, {});
    const real = spawnExec();
    let hashes = 0;
    const racing = { ...base, exec: async (command: string, args: string[], options: { cwd: string; stdin?: Buffer }) => {
      // 파일을 읽은 직후(첫 hash-object)에 바꾸고 마지막 재확인 직전(둘째)에 되돌린다. 예전 코드는 이 사이에 본문·사본을 다시 읽었다.
      if (args.includes("hash-object") && ++hashes === 2) writeFileSync(file, seen);
      const result = await real(command, args, options);
      if (args.includes("hash-object") && hashes === 1) writeFileSync(file, flipped);
      return result;
    } };
    const calls: { family: Family; prompt: string }[] = [];
    const result = await runReview(input(), { ...racing, complete: (family, prompt, attempt) => { calls.push({ family, prompt }); return base.complete(family, prompt, attempt); } }, signal);
    expect(calls[0].prompt).toContain("seen by the reviewer");
    expect(calls[0].prompt).not.toContain("flipped meanwhile");
    expect(readFileSync(join(result.snapshotDir, "f0"), "utf8")).toBe(seen);
    expect(readCrossReviewRecords(env.ledger)).toMatchObject([{ files: [{ path: "a.ts", blob: blobOf(seen) }] }]);
  });

  test("수정한 파일의 diff를 만드는 동안 파일이 바뀌면 사본 없이 거절한다", async () => {
    const env = repo();
    const file = join(env.work, "a.ts");
    writeFileSync(file, PLAIN_BASE);
    sh(env.work, "add", "a.ts");
    sh(env.work, "commit", "-q", "-m", "a");
    writeFileSync(file, `${PLAIN_BASE}// first\n`);
    const real = spawnExec();
    const racing = { ...deps(env, {}), exec: async (command: string, args: string[], options: { cwd: string; stdin?: Buffer }) => {
      if (args.includes("diff")) writeFileSync(file, `${PLAIN_BASE}// second\n`);
      return real(command, args, options);
    } };
    await expect(runReview(input(), racing, signal)).rejects.toThrow("changed while it was being read");
    expect(readCrossReviewRecords(env.ledger)).toEqual([]);
  });

  test("출력 한도 등으로 끝난 reviewer의 부분 답도 원문으로 남기지만 통과는 못 한다", async () => {
    const env = repo();
    writeFileSync(join(env.work, "a.ts"), PLAIN_BASE);
    const partial = `{"findings":[{"severity":"major","claim":"cut off ${"x".repeat(25_000)}`;
    const result = await runReview(input(), deps(env, { openai: new ReviewerCallError("Model stopped: length", ASTRA, partial) }), signal);
    expect(result.passable).toBe(false);
    expect(result.reviewers[0]).toMatchObject({ status: "error", error: "Model stopped: length", raw: partial.slice(0, 2_000), rawChars: partial.length });
    expect(readFileSync(result.reviewers[0].rawFile!, "utf8")).toBe(partial);
    const [record] = readCrossReviewRecords(env.ledger) as { reviewers: { raw: string; rawFile: string }[] }[];
    expect(record.reviewers[0].raw).toBe(partial.slice(0, 20_000));
    expect(record.reviewers[0].rawFile).toBe(result.reviewers[0].rawFile!);
  });
});
