// 2026-10-28 사용자 결정으로 줄인 교차검토·슬롭 게이트의 회귀 테스트. 사례는 doc/history/2026/10/28-guard-audit 감사에서 실제로 거절·오류가 난 호출이다.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { CrossReviewRefusal, detectMarkers, MAX_INPUT_BYTES, ReviewerCallError, runGate, runResolve, runReview, sampleSelected, spawnExec, type Lane, type ReviewDeps } from "../lib/cross-review";
import { createRoutingLedger, readCrossReviewRecords } from "../lib/routing-ledger";
import { appendSlopRecord, MAX_REPORT_CSV_BYTES, pendingArtifacts, rawDataReason, readSlopRecords, runSlopGate, sha256, SlopGateRefusal } from "../lib/slop-gate";
import { buildReviewRequest, commaOnlyRule, reviewFiles, type Complete, type SlopDeps } from "../slop-gate/review";

const OPUS = "anthropic/claude-opus-5-5";
const ASTRA = "openai-codex/gpt-6-astra";
const roots: string[] = [];
const signal = new AbortController().signal;
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "review-gate-trim-"));
  roots.push(dir);
  return dir;
};
function sh(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}
const blobOf = (content: string) => createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0${content}`).digest("hex");
const put = (root: string, path: string, content: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };

interface RepoEnv { work: string; ledger: string; snapshots: string }
function repo(files: Record<string, string> = {}): RepoEnv {
  const dir = scratch();
  const work = join(dir, "work");
  mkdirSync(work);
  sh(work, "init", "-q", "--initial-branch=main");
  sh(work, "config", "user.name", "t");
  sh(work, "config", "user.email", "t@example.invalid");
  sh(work, "config", "core.autocrlf", "false");
  for (const [path, content] of Object.entries({ "base.txt": "base\n", ...files })) put(work, path, content);
  sh(work, "add", "-A");
  sh(work, "commit", "-q", "-m", "base");
  return { work, ledger: join(dir, "ledger.jsonl"), snapshots: join(dir, "snapshots") };
}

let idCounter = 0;
/** 필수 reviewer(openai)의 답은 reply가 프롬프트를 보고 정한다. prompts에 필수 reviewer가 받은 프롬프트가 쌓인다. */
function deps(env: RepoEnv, reply: (prompt: string) => string = () => '{"findings":[]}', prompts: string[] = []): ReviewDeps {
  const ledger = createRoutingLedger(env.ledger);
  return {
    cwd: env.work, sessionId: "s1", mainModel: OPUS, exec: spawnExec(), snapshotRoot: env.snapshots,
    readAll: () => readCrossReviewRecords(env.ledger), append: (record) => ledger.append(record),
    newId: () => `xr-trim-${process.pid}-${++idCounter}`,
    complete: async (family: Lane, prompt: string) => {
      prompts.push(prompt);
      return { model: family === "openai" ? ASTRA : OPUS, text: reply(prompt) };
    },
  } as ReviewDeps;
}
const finding = (claim: string) => JSON.stringify({ findings: [{ severity: "major", file: "a.ts", line: 1, claim, why: "because" }], summary: "s" });

// ── 1. marker는 바뀐 줄에서만 ────────────────────────────────────────────────

describe("경로 이름만으로는 marker가 걸리지 않는다", () => {
  const DEPLOY_VERIFY = "Tools/OMP_Global_Config/agent/tools/deploy-verify/index.ts";

  test("10-28 02:55 거절: deploy-verify의 설명 문자열 한 줄 수정은 경로에 deploy가 있어도 trigger가 아니다", () => {
    expect(detectMarkers(DEPLOY_VERIFY, [{ line: 12, text: "  description: \"Read-only verification that a WSL CUELO deploy finished\"," }])).toEqual([]);
    for (const path of ["Tools/setup/deploy-live.ps1", "alembic/versions/001.py", "src/auth/session.ts"]) expect(detectMarkers(path, [{ line: 1, text: "const x = 1;" }])).toEqual([]);
  });

  test("바뀐 줄의 marker는 그대로 잡는다(10-23 Apply-Migrations.ps1의 Remove-Item 줄)", () => {
    const hits = detectMarkers("Docs/history/2026/10/23-prod-db-migrations/Apply-Migrations.ps1", [{ line: 82, text: "Remove-Item Env:\\SQLCMDPASSWORD -ErrorAction SilentlyContinue" }]);
    expect(hits.map((hit) => hit.trigger)).toEqual(["deletion"]);
  });

  test("git_finalize 게이트: 표본에 뽑히지 않은 deploy-verify 일반 줄 수정은 통과 기록 없이 지나간다", async () => {
    const before = "export const name = \"deploy_verify\";\n";
    let after = "";
    for (let n = 0; n < 500 && !after; n++) {
      const candidate = `export const name = "deploy_verify ${n}";\n`;
      if (!sampleSelected([{ path: DEPLOY_VERIFY, blob: blobOf(candidate) }])) after = candidate;
    }
    const env = repo({ [DEPLOY_VERIFY]: before });
    put(env.work, DEPLOY_VERIFY, after);
    const outcome = await runGate({ cwd: env.work, files: [DEPLOY_VERIFY], ledgerPath: env.ledger });
    expect(outcome.decision?.required).toEqual([]);
  });
});

// ── 2. 통과 뒤 주석만 더한 파일 ─────────────────────────────────────────────

describe("통과 뒤 TS/JS 주석·공백만 바뀐 파일은 그 통과가 덮는다", () => {
  const BASE = "export const keep = 1;\n";
  const REVIEWED = `${BASE}import { rmSync } from "node:fs";\nexport const wipe = (p: string) => rmSync(p);\n`;

  async function passed(): Promise<RepoEnv> {
    const env = repo({ "a.ts": BASE });
    put(env.work, "a.ts", REVIEWED);
    const d = deps(env);
    const review = await runReview({ files: ["a.ts"], acceptance: "Never delete user files.", authors: ["main"] }, d, signal);
    expect((await runResolve({ reviewId: review.reviewId, resolutions: [] }, { exec: spawnExec(), readAll: d.readAll, append: d.append })).pass).toBe(true);
    return env;
  }

  test("주석 줄을 더하고 줄 끝 주석을 바꾼 수정은 다시 심사하지 않는다", async () => {
    const env = await passed();
    put(env.work, "a.ts", `${BASE}// 지운다: 사용자 파일이 아닌 임시 폴더만\nimport { rmSync } from "node:fs";\nexport const wipe = (p: string) => rmSync(p); // tmp only\n`);
    const outcome = await runGate({ cwd: env.work, files: ["a.ts"], ledgerPath: env.ledger });
    expect(outcome.decision?.uncovered).toEqual([]);
  });

  test("대조군: 코드 줄이 바뀌면 그 통과가 덮지 않는다", async () => {
    const env = await passed();
    put(env.work, "a.ts", `${REVIEWED}export const more = rmSync;\n`);
    await expect(runGate({ cwd: env.work, files: ["a.ts"], ledgerPath: env.ledger })).rejects.toBeInstanceOf(CrossReviewRefusal);
  });
});

// ── 3. 이어지는 라운드는 files·acceptance를 이어받는다 ───────────────────────

describe("이어지는 라운드에서 files·acceptance를 생략하면 체인에서 이어받는다", () => {
  test("files:[]·acceptance:\"\"인 2회차가 거절되지 않고 같은 파일의 delta를 같은 기준으로 심사한다", async () => {
    const env = repo();
    put(env.work, "a.ts", "export const a = 1;\n");
    const prompts: string[] = [];
    const d = deps(env, undefined, prompts);
    const first = await runReview({ files: ["a.ts"], acceptance: "Keep the add contract.", authors: ["main"] }, d, signal);
    put(env.work, "a.ts", "export const a = 2;\n");
    const second = await runReview({ files: [], acceptance: "", authors: [], previousReviewId: first.reviewId }, d, signal);
    expect(second).toMatchObject({ round: 2, carriedOver: ["files", "acceptance"] });
    expect(prompts[1]).toContain("Keep the add contract.");
    expect(prompts[1]).toContain('<delta path="a.ts">');
  });

  test("기준을 남기지 않은 옛 라운드에서는 acceptance를 다시 달라고 하고, 준 값은 그대로 쓴다", async () => {
    const env = repo();
    put(env.work, "a.ts", "export const a = 1;\n");
    const prompts: string[] = [];
    const d = deps(env, undefined, prompts);
    const first = await runReview({ files: ["a.ts"], acceptance: "Old criteria.", authors: ["main"] }, d, signal);
    unlinkSync(join(env.snapshots, first.reviewId, "acceptance.txt"));
    put(env.work, "a.ts", "export const a = 2;\n");
    await expect(runReview({ files: [], acceptance: " ", authors: [], previousReviewId: first.reviewId }, d, signal)).rejects.toThrow("no stored acceptance to carry over");
    const second = await runReview({ files: [], acceptance: "New criteria.", authors: [], previousReviewId: first.reviewId }, d, signal);
    expect(second.carriedOver).toEqual(["files"]);
    expect(prompts.at(-1)).toContain("New criteria.");
  });

  test("R1-OAI-2: 바로 앞 라운드의 기준을 읽지 못하면 더 앞 라운드의 다른 기준으로 바꾸지 않는다", async () => {
    const env = repo();
    put(env.work, "a.ts", "export const a = 1;\n");
    const prompts: string[] = [];
    const d = deps(env, undefined, prompts);
    const first = await runReview({ files: ["a.ts"], acceptance: "Criteria A.", authors: ["main"] }, d, signal);
    put(env.work, "a.ts", "export const a = 2;\n");
    const second = await runReview({ files: [], acceptance: "Criteria B.", authors: [], previousReviewId: first.reviewId }, d, signal);
    unlinkSync(join(env.snapshots, second.reviewId, "acceptance.txt"));
    put(env.work, "a.ts", "export const a = 3;\n");
    await expect(runReview({ files: [], acceptance: "", authors: [], previousReviewId: second.reviewId }, d, signal)).rejects.toThrow("no stored acceptance to carry over");
    expect(prompts).toHaveLength(2);
  });
});

// ── 4. 상한을 넘는 변경은 나눠 심사한다 ─────────────────────────────────────

describe("한 호출 상한을 넘는 변경은 거절하지 않고 나눠 같은 라운드로 심사한다", () => {
  const bigFile = (bytes: number) => "export const x = 1;\n".repeat(Math.ceil(bytes / 20));

  test("상한을 넘는 새 파일(줄 번호를 붙이면 약 1.35배)은 reviewer 자리마다 두 번 부르고, 두 답의 finding을 한 라운드에 이어 붙인다", async () => {
    const env = repo();
    put(env.work, "a.ts", bigFile(MAX_INPUT_BYTES));
    const prompts: string[] = [];
    const result = await runReview({ files: ["a.ts"], acceptance: "A", authors: ["main"] }, deps(env, (prompt) => finding(`part ${/shows part (\d+) of/.exec(prompt)?.[1]}`), prompts), signal);
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(MAX_INPUT_BYTES);
      expect(prompt).toContain("SPLIT REVIEW");
    }
    expect(prompts[0]).toContain('<new-file path="a.ts" part="1/2">');
    expect(result).toMatchObject({ batches: 2, passable: true });
    expect(result.findings.map((item) => [item.id, item.claim])).toEqual([["R1-OAI-1", "part 1"], ["R1-OAI-2", "part 2"]]);
    expect(readCrossReviewRecords(env.ledger).filter((record) => record.type === "cross-review")).toHaveLength(1);
  });

  test("나눈 답 하나라도 해석할 수 없으면 그 자리는 해석 불가이고 통과할 수 없다", async () => {
    const env = repo();
    put(env.work, "a.ts", bigFile(MAX_INPUT_BYTES));
    const result = await runReview({ files: ["a.ts"], acceptance: "A", authors: ["main"] }, deps(env, (prompt) => (prompt.includes("shows part 2 of") ? "PASS" : '{"findings":[]}')), signal);
    expect(result.passable).toBe(false);
    expect(result.reviewers[0]).toMatchObject({ family: "openai", status: "unparsable" });
  });

  test("8번으로도 모자라면 아무것도 보내지 않고 나누라고 거절한다", async () => {
    const env = repo();
    put(env.work, "a.ts", bigFile(MAX_INPUT_BYTES * 9));
    const prompts: string[] = [];
    await expect(runReview({ files: ["a.ts"], acceptance: "A", authors: ["main"] }, deps(env, undefined, prompts), signal)).rejects.toThrow(/calls per reviewer, above the limit of 8[^]*Nothing was sent/);
    expect(prompts).toEqual([]);
  });

  test("R1-OAI-3: 공통 부분을 앞 지적이 차지해 거절할 때 그 지적 묶음을 큰 조각 목록에 올린다", async () => {
    const env = repo();
    put(env.work, "a.ts", "export const a = 1;\n");
    const prompts: string[] = [];
    const first = await runReview({ files: ["a.ts"], acceptance: "A", authors: ["main"] }, deps(env, () => finding("x".repeat(MAX_INPUT_BYTES)), prompts), signal);
    put(env.work, "a.ts", "export const a = 2;\n");
    await expect(runReview({ files: [], acceptance: "", authors: [], previousReviewId: first.reviewId }, deps(env, undefined, prompts), signal)).rejects.toThrow(/Largest pieces: earlier findings \(1\) \d+ bytes/);
    expect(prompts).toHaveLength(1);
  });
});

// ── 5. 슬롭 게이트 ───────────────────────────────────────────────────────────

const KO = "짧은 SHA가 들어오면 전체 SHA로 바꿔 조회하고, 조회에 실패하면 오류로 처리합니다.\n배포가 끝나면 상태를 다시 읽어 맞는지 확인합니다. 맞지 않으면 원인을 적어 알려 줍니다.\n";
const COMMA = { quote: "짧은 SHA가 들어오면 전체 SHA로 바꿔 조회하고, 조회에 실패하면 오류로 처리합니다.", rule: "humanizer 패턴 3: 연결어미 뒤 쉼표", fix: "쉼표를 뺀다" };
const AUTHOR = "anthropic/fixture-author";
const ids = (prompt: string) => [...prompt.matchAll(/<artifact id="(a\d+)"/g)].map((match) => match[1]!);
function slopDeps(cwd: string, complete: Complete): SlopDeps {
  return { cwd, ledgerPath: join(cwd, "ledger.jsonl"), complete, mainModel: AUTHOR, head: async () => undefined };
}

describe("humanizer 패턴 3(연결어미 뒤 쉼표)만 든 지적은 finding이 아니다", () => {
  test.each([
    ["humanizer 패턴 3: 연결어미 뒤 쉼표", true],
    ["humanizer 패턴 3 (연결어미 뒤 쉼표, S2). 이 페이지에서 7회 반복됩니다: 마쳤으나, / 썼고, / 인정했으며,", true],
    ["humanizer 패턴 3: 연결어미 뒤 쉼표 (S2; this delta has 3 hits: '맡고,', '선택하며,', '아니며,')", true],
    ["humanizer 패턴 1: 과도한 쉼표 사용 (명사구를 쪼개는 쉼표)", false],
    ["humanizer 패턴 6: 줄표 과다 사용 (S2) / stop-slop: Em-dashes", false],
    ["humanizer 패턴 3, 패턴 1: 쉼표가 문단에 몰림", false],
    ["humanizer 패턴 3 / stop-slop: Rhythm Patterns", false],
    ["stop-slop pattern 3", false],
    // R1-OAI-1: 나열한 다른 번호도 센다. 횟수는 번호가 아니다.
    ["humanizer pattern 3, 1: connective commas and excessive comma density", false],
    ["humanizer 패턴 3·1: 쉼표 몰림", false],
    ["humanizer patterns 1 and 3: commas", false],
    ["humanizer 패턴 3 / #5: 연결어미 뒤 쉼표", false],
    ["humanizer 패턴 3: 연결어미 뒤 쉼표, 12회 반복 (3 hits in this delta)", true],
    // R2-OAI-1: 키워드 바로 뒤의 횟수도 번호가 아니다. "3번"은 번호다.
    ["humanizer 패턴 3: 연결어미 뒤 쉼표 (이 패턴 7회 반복)", true],
    ["humanizer 패턴 3번, 1번: 연결어미 뒤 쉼표와 쉼표 몰림", false],
    // R3-OAI-1: 단위 글자로 시작하는 낱말("개선")은 횟수가 아니다.
    ["humanizer 패턴 3: 연결어미 뒤 쉼표; 패턴 1 개선 필요: 과도한 쉼표", false],
  ] as const)("%s → %p", (rule, comma) => { expect(commaOnlyRule(rule)).toBe(comma); });

  test("감사한 지적(10-27 deploy_verify 안내문)만 나온 파일은 통과하고 뺀 수를 남기며, system에 조정을 알린다", async () => {
    const cwd = scratch();
    writeFileSync(join(cwd, ".slop-gate.json"), JSON.stringify({ visible: ["a.md"] }));
    writeFileSync(join(cwd, "a.md"), KO);
    const systems: string[] = [];
    const complete: Complete = async (family, system, prompt) => {
      systems.push(system);
      return { model: `fixture/${family}`, text: JSON.stringify({ files: ids(prompt).map((id) => ({ id, findings: [COMMA] })) }) };
    };
    const out = await reviewFiles(["a.md"], undefined, slopDeps(cwd, complete), signal);
    expect(out.files[0]).toMatchObject({ status: "pass", relaxed: 1 });
    expect(systems[0]).toContain("pattern 3 (a comma after a connective ending");
    expect(readSlopRecords(join(cwd, "ledger.jsonl")).some((record) => record.type === "slop-pass" && record.sha256 === sha256(KO))).toBe(true);
    expect(buildReviewRequest([], ["stop-slop"]).system).not.toContain("Gate adjustment");
  });
});

describe("필수 reviewer의 해석할 수 없는 답은 같은 자리에 한 번 다시 묻는다", () => {
  // 10-27 감사의 openai 답 6건과 같은 모양: JSON이 끝 괄호 `]}` 없이 끝난다.
  const TRUNCATED = '{"files":[{"id":"a1","findings":[]}';

  test("첫 답이 끊겼고 다시 받은 답이 맞으면 통과하며, 첫 답의 원문과 파서 오류는 failedAttempts에 남는다", async () => {
    const cwd = scratch();
    writeFileSync(join(cwd, ".slop-gate.json"), JSON.stringify({ visible: ["a.md"] }));
    writeFileSync(join(cwd, "a.md"), KO);
    const asked: { family: string; prompt: string }[] = [];
    const complete: Complete = async (family, _system, prompt) => {
      asked.push({ family, prompt });
      const first = asked.filter((item) => item.family === family).length === 1;
      return { model: `fixture/${family}`, text: family === "openai" && first ? TRUNCATED : JSON.stringify({ files: ids(prompt).map((id) => ({ id, findings: [] })) }) };
    };
    const out = await reviewFiles(["a.md"], undefined, slopDeps(cwd, complete), signal);
    expect(out.files[0]!.status).toBe("pass");
    const openai = asked.filter((item) => item.family === "openai");
    expect(openai).toHaveLength(2);
    expect(openai[1]!.prompt).toContain("Your previous answer to this request could not be read");
    expect(out.reviewers?.find((status) => status.family === "openai")).toMatchObject({ status: "ok", retry: true });
    expect(out.failedAttempts).toMatchObject([{ family: "openai", status: "unparsable", raw: TRUNCATED, error: expect.stringContaining("invalid JSON") }]);
  });

  test("다시 묻는 호출도 같은 slot으로 부른다(slop 전용 slot이 풀린 필수 reviewer)", async () => {
    const cwd = scratch();
    writeFileSync(join(cwd, ".slop-gate.json"), JSON.stringify({ visible: ["a.md"] }));
    writeFileSync(join(cwd, "a.md"), KO);
    const slots: (string | undefined)[] = [];
    const complete: Complete = async (family, _system, prompt, _signal, slot) => {
      if (family === "openai") slots.push(slot);
      return { model: `fixture/${family}`, text: family === "openai" && slots.length === 1 ? TRUNCATED : JSON.stringify({ files: ids(prompt).map((id) => ({ id, findings: [] })) }) };
    };
    const out = await reviewFiles(["a.md"], undefined, { ...slopDeps(cwd, complete), slopSlots: { openai: "openai-codex/gpt-6-luna" } }, signal);
    expect(out.files[0]!.status).toBe("pass");
    expect(slots).toEqual(["slopReviewOpenAI", "slopReviewOpenAI"]);
  });

  test("자문 reviewer와 호출 오류는 다시 묻지 않는다", async () => {
    const cwd = scratch();
    writeFileSync(join(cwd, ".slop-gate.json"), JSON.stringify({ visible: ["a.md"] }));
    writeFileSync(join(cwd, "a.md"), KO);
    const asked: string[] = [];
    const complete: Complete = async (family) => {
      asked.push(family);
      if (family === "openai") throw new ReviewerCallError("Model stopped: length", "fixture/openai", TRUNCATED);
      return { model: `fixture/${family}`, text: "not json" };
    };
    const out = await reviewFiles(["a.md"], undefined, slopDeps(cwd, complete), signal);
    expect(asked.sort()).toEqual(["openai"]);
    expect(out.files[0]!.status).toBe("error");
  });
});

describe("400000바이트를 넘는 csv는 원자료로 보고 슬롭 검사를 요구하지 않는다", () => {
  const rows = (bytes: number) => "ts,cpu,temp\n".padEnd(bytes, "1");

  test("경계: csv만, 400000바이트를 넘을 때만", () => {
    expect(rawDataReason("log.csv", MAX_REPORT_CSV_BYTES)).toBeUndefined();
    expect(rawDataReason("log.CSV", MAX_REPORT_CSV_BYTES + 1)).toContain("raw data file");
    expect(rawDataReason("guide.md", 50_000_000)).toBeUndefined();
  });

  // 감사 사례는 cwd 밖 절대 경로(/mnt/c/tmp/SensorLogger/…)의 csv라 "csv deliverable"로 보이는 산출물이었다. 같은 모양을 홈 아래 cwd 밖 폴더로 만든다.
  const outside = () => {
    const dir = mkdtempSync(join(homedir(), ".review-gate-trim-"));
    roots.push(dir);
    return dir;
  };

  test("slop_check: 10-27의 59 MB 센서 로그(20 MiB 초과 오류)는 오류 대신 internal과 이유를 돌려주고 reviewer를 부르지 않는다", async () => {
    const log = join(outside(), "LibreHardwareMonitorLog-2026-10-27.csv");
    writeFileSync(log, "Time,CPU Package\n");
    truncateSync(log, 59 * 1024 * 1024);
    const asked: string[] = [];
    const out = await reviewFiles([log], undefined, slopDeps(scratch(), async (family) => { asked.push(family); return { model: "m", text: "{}" }; }), signal);
    expect(out.files).toEqual([{ file: log, status: "internal", reason: expect.stringContaining("raw data file") }]);
    expect(asked).toEqual([]);
  });

  test("턴 끝 게이트는 cwd 밖에서 바뀐 큰 csv를 묻지 않고, 작은 csv 산출물은 여전히 묻는다", () => {
    const dir = outside();
    writeFileSync(join(dir, "big.csv"), rows(MAX_REPORT_CSV_BYTES + 1));
    writeFileSync(join(dir, "small.csv"), "이름,값\n전력,12\n");
    const pending = pendingArtifacts({ files: [join(dir, "big.csv"), join(dir, "small.csv")], dirs: [] }, scratch(), 0, []);
    expect(pending.map((item) => item.path)).toEqual([join(dir, "small.csv")]);
  });

  test("커밋 게이트: 큰 csv는 통과 없이 지나가되 결과와 거절 문구에 이유와 함께 남는다", async () => {
    const env = repo();
    put(env.work, "reports/log.csv", rows(MAX_REPORT_CSV_BYTES + 1));
    put(env.work, "page.html", KO);
    const ledgerPath = join(env.work, "..", "slop.jsonl");
    const refused = await runSlopGate({ cwd: env.work, files: ["reports/log.csv", "page.html"], ledgerPath }).then(() => "", (error: Error) => { expect(error).toBeInstanceOf(SlopGateRefusal); return error.message; });
    expect(refused).toContain("1 visible artifact(s)");
    expect(refused).toContain("(not gated) reports/log.csv: raw data file");
    appendSlopRecord(ledgerPath, { type: "slop-pass", path: join(env.work, "page.html"), sha256: sha256(KO), reviewedAt: "t", model: "m", reviewId: "r", findings: [] });
    const outcome = await runSlopGate({ cwd: env.work, files: ["reports/log.csv", "page.html"], ledgerPath });
    expect(outcome.artifacts.map((item) => item.path)).toEqual(["page.html"]);
    expect(outcome.rawData).toEqual([{ path: "reports/log.csv", reason: expect.stringContaining("raw data file") }]);
    expect(outcome.gateBlobs?.["reports/log.csv"]).toBe(sh(env.work, "hash-object", "reports/log.csv"));
  });
});
