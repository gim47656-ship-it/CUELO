// 2026-11-07 사용자 결정: cross_review에 기다리지 않는 보조 검토자(modelRoles.crossReviewAdvisory)를 되살린다.
// 필수 검토자가 끝난 뒤 최대 유예(기본 60 s)까지만 기다리고, 그 안에 온 지적은 라운드 지적으로 합쳐 똑같이 닫아야 한다.
// 늦음·잘림·실패·미설정은 기록만 하고 라운드를 막지 않는다. 모델은 가짜이고 심사 흐름·원장은 실제 코드가 실제 git 저장소로 돈다.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReviewerCallError, runResolve, runReview, spawnExec, type ReviewDeps } from "../lib/cross-review";
import { createRoutingLedger, readCrossReviewRecords, type CrossReviewRecord } from "../lib/routing-ledger";

const OPUS = "anthropic/claude-opus-5-5";
const ASTRA = "openai-codex/gpt-6-astra";
const ARGON = "aistudio/gemini-4-argon";
const VERTEX = "google-vertex/gemini-4-argon";
const roots: string[] = [];
const signal = new AbortController().signal;
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function sh(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

interface RepoEnv { work: string; ledger: string; snapshots: string }
function repo(): RepoEnv {
  const dir = mkdtempSync(join(tmpdir(), "cross-review-advisory-"));
  roots.push(dir);
  const work = join(dir, "work");
  mkdirSync(work);
  sh(work, "init", "-q", "--initial-branch=main");
  sh(work, "config", "user.name", "t");
  sh(work, "config", "user.email", "t@example.invalid");
  writeFileSync(join(work, "base.txt"), "base\n");
  sh(work, "add", "base.txt");
  sh(work, "commit", "-q", "-m", "base");
  writeFileSync(join(work, "a.ts"), "import { rmSync } from \"node:fs\";\nrmSync(\"x\");\n");
  return { work, ledger: join(dir, "ledger.jsonl"), snapshots: join(dir, "snapshots") };
}

const clean = '{"findings":[]}';
const finding = (claim: string) => JSON.stringify({ findings: [{ severity: "major", file: "a.ts", line: 2, claim, why: "because", proof: "cited-line" }], summary: "s" });

/**
 * 중단 신호를 따르는 잠. 중단되면 오류로 끝난다(제공자 호출이 끊긴 것과 같다). 실제 시계를 쓴다: 검사 대상이 필수 검토자 종료 뒤 유예 타이머와
 * 보조 호출의 실제 경주이고, runReview가 git 하위 프로세스를 기다리는 동안 가짜 시계로는 그 순서를 재현할 수 없다. 지연은 수십~수백 ms로 둔다.
 */
function sleep(ms: number, abort: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (abort.aborted) { reject(new Error("aborted")); return promise; }
  const timer = setTimeout(resolve, ms);
  abort.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
  return promise;
}

interface Advisor { ms: number; text?: string; error?: Error }
interface Route extends Advisor { model: string }
interface Trace { requiredDoneAt?: number; advisoryCalls: number; advisoryAborted: boolean; routeCalls: string[]; routeAborted: boolean }
let idCounter = 0;
/** 필수 reviewer는 OpenAI 자리(Opus 저자)이며 requiredMs 뒤 깨끗한 답을 낸다. advisor가 없으면 보조 slot이 설정되지 않은 것이다. */
function deps(env: RepoEnv, trace: Trace, options: { requiredMs?: number; advisor?: Advisor; advisoryModel?: string; graceMs?: number; routes?: Route[] | Error } = {}): ReviewDeps {
  const ledger = createRoutingLedger(env.ledger);
  const { advisor } = options;
  return {
    cwd: env.work, sessionId: "s1", mainModel: OPUS, exec: spawnExec(), snapshotRoot: env.snapshots,
    readAll: () => readCrossReviewRecords(env.ledger), append: (record) => ledger.append(record),
    newId: () => `xr-adv-${process.pid}-${++idCounter}`,
    requiredModels: { openai: ASTRA, anthropic: OPUS },
    advisoryGraceMs: options.graceMs ?? 2_000,
    complete: async (family, _prompt, attempt) => {
      await sleep(options.requiredMs ?? 20, attempt);
      trace.requiredDoneAt = Date.now();
      return { model: family === "openai" ? ASTRA : OPUS, text: clean };
    },
    ...(advisor ? {
      advisory: {
        model: options.advisoryModel ?? ARGON,
        complete: async (_prompt: string, attempt: AbortSignal) => {
          trace.advisoryCalls++;
          attempt.addEventListener("abort", () => { trace.advisoryAborted = true; }, { once: true });
          await sleep(advisor.ms, attempt);
          if (advisor.error) throw advisor.error;
          return { model: options.advisoryModel ?? ARGON, text: advisor.text ?? clean };
        },
        // 같은 모델의 다른 공급자 경로. Error면 경로 조회 자체가 실패한다.
        ...(options.routes ? {
          limitRoutes: async () => {
            if (options.routes instanceof Error) throw options.routes;
            return options.routes!.map((route) => ({
              model: route.model,
              complete: async (_prompt: string, attempt: AbortSignal) => {
                trace.routeCalls.push(route.model);
                attempt.addEventListener("abort", () => { trace.routeAborted = true; }, { once: true });
                await sleep(route.ms, attempt);
                if (route.error) throw route.error;
                return { model: route.model, text: route.text ?? clean };
              },
            }));
          },
        } : {}),
      },
    } : {}),
  } as ReviewDeps;
}
const trace = (): Trace => ({ advisoryCalls: 0, advisoryAborted: false, routeCalls: [], routeAborted: false });
const input = { files: ["a.ts"], acceptance: "Never delete user files.", authors: [OPUS] };
const recordOf = (env: RepoEnv, reviewId: string) => readCrossReviewRecords(env.ledger).find((record): record is CrossReviewRecord => record.type === "cross-review" && record.reviewId === reviewId)!;
const resolveDeps = (d: ReviewDeps) => ({ exec: spawnExec(), readAll: d.readAll, append: d.append });

describe("보조 검토자가 유예 안에 답하면", () => {
  test("지적이 라운드 지적에 보조 표시·모델과 함께 합쳐지고, 닫기 전에는 통과하지 않는다", async () => {
    const env = repo();
    const t = trace();
    const d = deps(env, t, { advisor: { ms: 80, text: finding("rmSync deletes a relative path") }, graceMs: 5_000 });
    const review = await runReview(input, d, signal);
    const returnedAt = Date.now();
    expect(t.advisoryCalls).toBe(1);
    expect(review.findings).toEqual([expect.objectContaining({ id: "R1-ADV-1", advisory: true, reviewer: ARGON, claim: "rmSync deletes a relative path" })]);
    expect(review.advisory).toMatchObject({ status: "ok", model: ARGON, findings: 1 });
    // 답이 오면 유예를 다 쓰지 않고 곧 돌아온다.
    expect(returnedAt - t.requiredDoneAt!).toBeLessThan(1_000);
    const record = recordOf(env, review.reviewId);
    expect(record.findings.map((item) => item.id)).toEqual(["R1-ADV-1"]);
    expect(record.advisory).toMatchObject({ status: "ok", model: ARGON });
    expect(record.reviewers.map((reviewer) => reviewer.family)).toEqual(["openai"]);
    expect(record.passable).toBe(true);
    expect(await runResolve({ reviewId: review.reviewId, resolutions: [] }, resolveDeps(d))).toMatchObject({ pass: false, open: ["R1-ADV-1"] });
    expect(await runResolve({ reviewId: review.reviewId, resolutions: [{ id: "R1-ADV-1", status: "refuted", evidence: "x is a fixture path" }] }, resolveDeps(d))).toMatchObject({ pass: true, open: [] });
  });

  test("delta 라운드도 보조를 부르고 probe 라운드는 부르지 않는다", async () => {
    const env = repo();
    const t = trace();
    const d = deps(env, t, { advisor: { ms: 10, text: finding("first objection") } });
    const first = await runReview(input, d, signal);
    writeFileSync(join(env.work, "a.ts"), "import { rmSync } from \"node:fs\";\nrmSync(\"./x\");\n");
    const second = await runReview({ files: [], acceptance: "", authors: [OPUS], previousReviewId: first.reviewId }, d, signal);
    expect(t.advisoryCalls).toBe(2);
    expect(second.findings.map((item) => item.id)).toEqual(["R2-ADV-1"]);
    const probe = await runReview({ files: [], acceptance: "", authors: [OPUS], previousReviewId: second.reviewId, probeResults: [{ findingId: "R2-ADV-1", command: "bun test a", exitCode: 0, output: "1 pass" }] }, d, signal);
    expect(t.advisoryCalls).toBe(2);
    expect(probe.advisory).toMatchObject({ status: "skipped" });
    expect(probe.advisory?.reason).toContain("probe");
  });
});

describe("보조 검토자가 필수+유예보다 늦으면", () => {
  test("라운드는 유예 상한에서 돌아오고, 보조 호출은 끊기며 late로 기록만 남는다", async () => {
    const env = repo();
    const t = trace();
    const graceMs = 300;
    const d = deps(env, t, { requiredMs: 50, advisor: { ms: 10_000, text: finding("too late") }, graceMs });
    const review = await runReview(input, d, signal);
    const waited = Date.now() - t.requiredDoneAt!;
    expect(waited).toBeGreaterThanOrEqual(graceMs - 20);
    expect(waited).toBeLessThan(graceMs + 700);
    expect(t.advisoryAborted).toBe(true);
    expect(review.findings).toEqual([]);
    expect(review.advisory).toMatchObject({ status: "late", model: ARGON });
    expect(review.advisory?.reason).toContain(`${graceMs / 1000} s`);
    expect(recordOf(env, review.reviewId).advisory).toMatchObject({ status: "late", model: ARGON });
    expect(await runResolve({ reviewId: review.reviewId, resolutions: [] }, resolveDeps(d))).toMatchObject({ pass: true });
  });
});

describe("보조 검토자의 실패·잘림·해석 불가는 라운드에 영향이 없다", () => {
  const cases: [string, Advisor, string][] = [
    ["truncated", { ms: 10, error: new ReviewerCallError("Model stopped: length", ARGON, "{\"findings\":[{\"sev", "length") }, "truncated"],
    ["error", { ms: 10, error: new ReviewerCallError("HTTP 503 from relay", ARGON) }, "error"],
    ["unparsable", { ms: 10, text: "I think it is fine." }, "unparsable"],
  ];
  for (const [name, advisor, status] of cases) {
    test(`${name}: 기록만 하고 통과 가능 여부·지적은 필수 검토자만으로 정한다`, async () => {
      const env = repo();
      const t = trace();
      const d = deps(env, t, { advisor });
      const review = await runReview(input, d, signal);
      expect(t.advisoryCalls).toBe(1);
      expect(review.passable).toBe(true);
      expect(review.findings).toEqual([]);
      expect(review.advisory).toMatchObject({ status, model: ARGON });
      expect(recordOf(env, review.reviewId).advisory).toMatchObject({ status, model: ARGON });
      expect(await runResolve({ reviewId: review.reviewId, resolutions: [] }, resolveDeps(d))).toMatchObject({ pass: true });
    });
  }
});

test("R1-OAI-1: 보조 답 원문 파일을 쓰지 못해도 라운드는 기록되고 보조는 error로 남는다", async () => {
  const env = repo();
  const d = deps(env, trace(), { advisor: { ms: 10, text: "not json" } });
  d.newId = () => "xr-adv-rawfail";
  const complete = d.advisory!.complete;
  d.advisory!.complete = async (prompt, attempt) => {
    // 원문 파일 자리에 디렉터리를 두어 writeFileSync가 EISDIR로 실패하게 한다.
    mkdirSync(join(env.snapshots, "xr-adv-rawfail", "raw-advisory.txt"), { recursive: true });
    return complete(prompt, attempt);
  };
  const review = await runReview(input, d, signal);
  expect(review.passable).toBe(true);
  expect(review.advisory).toMatchObject({ status: "error", model: ARGON });
  expect(review.advisory?.reason).toContain("EISDIR");
  expect(recordOf(env, review.reviewId).advisory).toMatchObject({ status: "error" });
});

describe("보조 slot이 없거나 쓸 수 없는 자리면 부르지 않는다", () => {
  test("slot 미설정: 호출 없이 skipped로 기록한다", async () => {
    const env = repo();
    const t = trace();
    const review = await runReview(input, deps(env, t), signal);
    expect(t.advisoryCalls).toBe(0);
    expect(review.advisory).toMatchObject({ status: "skipped" });
    expect(review.advisory?.reason).toContain("crossReviewAdvisory");
  });

  test("보조 모델이 저자 자신이거나 필수 검토자와 같은 모델이면 부르지 않는다", async () => {
    const env = repo();
    const t = trace();
    const authored = await runReview({ ...input, authors: [ARGON] }, deps(env, t, { advisor: { ms: 10 } }), signal);
    expect(authored.advisory).toMatchObject({ status: "skipped" });
    writeFileSync(join(env.work, "a.ts"), "import { rmSync } from \"node:fs\";\nrmSync(\"y\");\n");
    const same = await runReview(input, deps(env, t, { advisor: { ms: 10 }, advisoryModel: ASTRA }), signal);
    expect(same.advisory).toMatchObject({ status: "skipped" });
    expect(t.advisoryCalls).toBe(0);
  });

  test("#71: delta 라운드의 저자가 보조 모델이면 1회차 저자가 달라도 그 라운드는 부르지 않는다", async () => {
    const env = repo();
    const t = trace();
    const d = deps(env, t, { advisor: { ms: 10, text: finding("self review") } });
    const first = await runReview(input, d, signal);
    expect(t.advisoryCalls).toBe(1);
    writeFileSync(join(env.work, "a.ts"), "import { rmSync } from \"node:fs\";\nrmSync(\"./x\");\n");
    const delta = await runReview({ files: [], acceptance: "", authors: [ARGON], previousReviewId: first.reviewId }, d, signal);
    expect(t.advisoryCalls).toBe(1);
    expect(delta.advisory).toMatchObject({ status: "skipped" });
    expect(delta.advisory?.reason).toContain("author");
    expect(delta.findings.filter((item) => item.advisory)).toEqual([]);
  });

  test("#71: 기록된 \"main\"은 그때 세션 모델로 남아, 세션 모델이 바뀐 뒤 이어도 보조 모델을 저자로 본다", async () => {
    const env = repo();
    const t = trace();
    const d = deps(env, t, { advisor: { ms: 10, text: finding("self review") } });
    d.mainModel = ARGON;
    const first = await runReview({ ...input, authors: ["main"] }, d, signal);
    expect(first.advisory).toMatchObject({ status: "skipped" });
    writeFileSync(join(env.work, "a.ts"), "import { rmSync } from \"node:fs\";\nrmSync(\"./x\");\n");
    d.mainModel = OPUS;
    const delta = await runReview({ files: [], acceptance: "", authors: ["main"], previousReviewId: first.reviewId }, d, signal);
    expect(t.advisoryCalls).toBe(0);
    expect(delta.advisory).toMatchObject({ status: "skipped" });
    expect(delta.findings.filter((item) => item.advisory)).toEqual([]);
  });
});

// 2026-11-11 사용자 결정 「버택스로 넘겨」: 보조 검토자가 공급자 한도로 실패하면 대체 순서에 적힌 같은 모델의 다른 공급자 경로를 한 번 부른다.
// 유예 상한, 저자와 필수 검토자 제외, 「실패는 기록만」은 그 경로에도 그대로 적용된다.
describe("보조 검토자가 공급자 한도로 실패하면", () => {
  const LIMIT = "Google API error (429): You've reached your usage limit for this model (resets in 59 minutes). RESOURCE_EXHAUSTED";
  const OTHER = "google-antigravity/gemini-4-argon";
  const limited = (): Advisor => ({ ms: 10, error: new ReviewerCallError(LIMIT, ARGON) });

  test("같은 모델의 첫 경로를 한 번 부르고 그 지적이 그 경로 이름으로 합쳐진다", async () => {
    const env = repo();
    const t = trace();
    const d = deps(env, t, { advisor: limited(), routes: [{ model: VERTEX, ms: 10, text: finding("route objection") }, { model: OTHER, ms: 10 }], graceMs: 5_000 });
    const review = await runReview(input, d, signal);
    expect(t.advisoryCalls).toBe(1);
    expect(t.routeCalls).toEqual([VERTEX]);
    expect(review.findings).toEqual([expect.objectContaining({ id: "R1-ADV-1", advisory: true, reviewer: VERTEX, claim: "route objection" })]);
    expect(review.advisory).toMatchObject({ status: "ok", model: VERTEX, findings: 1, limited: { model: ARGON, error: LIMIT } });
    expect(recordOf(env, review.reviewId).advisory).toMatchObject({ status: "ok", model: VERTEX, limited: { model: ARGON, error: LIMIT } });
    expect(await runResolve({ reviewId: review.reviewId, resolutions: [] }, resolveDeps(d))).toMatchObject({ pass: false, open: ["R1-ADV-1"] });
  });

  test("한도가 아닌 실패와 경로 조회 실패는 경로를 부르지 않고 원래 실패만 기록한다", async () => {
    const t = trace();
    const other = await runReview(input, deps(repo(), t, { advisor: { ms: 10, error: new ReviewerCallError("HTTP 503 from relay", ARGON) }, routes: [{ model: VERTEX, ms: 10 }] }), signal);
    expect(other.advisory).toMatchObject({ status: "error", model: ARGON });
    expect(other.advisory?.reason).toContain("HTTP 503 from relay");
    expect(other.advisory).not.toHaveProperty("limited");
    const broken = await runReview(input, deps(repo(), t, { advisor: limited(), routes: new Error("settings unreadable") }), signal);
    expect(broken.passable).toBe(true);
    expect(broken.advisory).toMatchObject({ status: "error", model: ARGON });
    expect(broken.advisory?.reason).toContain("usage limit");
    expect(broken.advisory).not.toHaveProperty("limited");
    expect(t.advisoryCalls).toBe(2);
    expect(t.routeCalls).toEqual([]);
  });

  test("저자나 필수 검토자와 같은 모델인 경로는 건너뛰고, 남는 경로가 없으면 원래 실패만 기록한다", async () => {
    const t = trace();
    // Google 저자의 필수 검토자는 Anthropic 자리(OPUS)다. 보조 모델은 공급자가 달라 불리고, Vertex 경로는 저자 자신이다.
    const authored = { ...input, authors: [VERTEX] };
    const next = await runReview(authored, deps(repo(), t, { advisor: limited(), routes: [{ model: VERTEX, ms: 10 }, { model: OPUS, ms: 10 }, { model: OTHER, ms: 10 }] }), signal);
    expect(t.routeCalls).toEqual([OTHER]);
    expect(next.advisory).toMatchObject({ status: "ok", model: OTHER, limited: { model: ARGON } });
    const none = await runReview(authored, deps(repo(), t, { advisor: limited(), routes: [{ model: VERTEX, ms: 10 }, { model: OPUS, ms: 10 }] }), signal);
    expect(t.routeCalls).toEqual([OTHER]);
    expect(none.passable).toBe(true);
    expect(none.advisory).toMatchObject({ status: "error", model: ARGON });
    expect(none.advisory).not.toHaveProperty("limited");
  });

  test("경로도 실패하면 그 경로 이름의 error로 기록만 하고 다음 경로는 부르지 않는다", async () => {
    const env = repo();
    const t = trace();
    const d = deps(env, t, { advisor: limited(), routes: [{ model: VERTEX, ms: 10, error: new ReviewerCallError("HTTP 503 from Vertex", VERTEX) }, { model: OTHER, ms: 10 }] });
    const review = await runReview(input, d, signal);
    expect(t.routeCalls).toEqual([VERTEX]);
    expect(review.passable).toBe(true);
    expect(review.findings).toEqual([]);
    expect(review.advisory).toMatchObject({ status: "error", model: VERTEX, limited: { model: ARGON, error: LIMIT } });
    expect(review.advisory?.reason).toContain("HTTP 503 from Vertex");
    expect(await runResolve({ reviewId: review.reviewId, resolutions: [] }, resolveDeps(d))).toMatchObject({ pass: true });
  });

  test("경로 호출도 같은 유예 상한에서 끊기고 late로 기록된다", async () => {
    const env = repo();
    const t = trace();
    const graceMs = 300;
    const d = deps(env, t, { requiredMs: 50, advisor: limited(), routes: [{ model: VERTEX, ms: 10_000, text: finding("too late") }], graceMs });
    const review = await runReview(input, d, signal);
    const waited = Date.now() - t.requiredDoneAt!;
    expect(waited).toBeGreaterThanOrEqual(graceMs - 20);
    expect(waited).toBeLessThan(graceMs + 700);
    expect(t.routeCalls).toEqual([VERTEX]);
    expect(t.routeAborted).toBe(true);
    expect(review.findings).toEqual([]);
    expect(review.advisory).toMatchObject({ status: "late", model: VERTEX, limited: { model: ARGON } });
    expect(await runResolve({ reviewId: review.reviewId, resolutions: [] }, resolveDeps(d))).toMatchObject({ pass: true });
  });
});
