import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { runToolTrial, type TrialInput } from "../tool-trial";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function env() {
  const base = mkdtempSync(join(tmpdir(), "tool-trial-"));
  scratch.push(base);
  const root = join(base, "trials");
  const cwd = join(base, "work");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "run.log"), "observed\n");
  const call = (input: TrialInput, sessionId = "session-a") => runToolTrial(input, { root, cwd, sessionId });
  const start = (sessionId = "session-a", environment: Record<string, string> = { os: "win11", app: "notepad 11.2" }) => {
    const result = call({
      action: "start", scenario: "메모장에 글자 입력 후 저장", acceptance: "저장 파일에 입력한 글자가 있다", environment,
      baselineTool: "windows_control", baselineVersion: "core 18.16.0", candidateTool: "nexus", candidateVersion: "0.3.1",
    }, sessionId);
    expect(result.isError).toBe(false);
    return /시험 (t-\S+)/.exec(result.text)![1]!;
  };
  return { root, cwd, call, start };
}

const observe = (trialId: string, side: "baseline" | "candidate", outcome: TrialInput["outcome"], extra: Partial<TrialInput> = {}): TrialInput =>
  ({ action: "observe", trialId, side, outcome, evidence: outcome === "not-run" ? [] : ["run.log:1"], ...extra });

describe("tool_trial 판정", () => {
  test("후보만 통과하고 기존을 돌리지 않았으면 개선이 아니라 판단 보류다", () => {
    const { call, start } = env();
    const id = start();
    call(observe(id, "baseline", "not-run"));
    const result = call(observe(id, "candidate", "pass"));
    expect(result.text).toContain("baseline-not-run");
    expect(result.text).not.toContain("added-capability-observed");
  });

  test("둘 다 통과하면 추가 능력이 입증되지 않았다고 말한다", () => {
    const { call, start } = env();
    const id = start();
    call(observe(id, "baseline", "pass"));
    expect(call(observe(id, "candidate", "pass")).text).toContain("no-added-capability");
  });

  test("기존 미지원·후보 통과는 그 시나리오에 한정한 추가 능력이고, 반대 증거가 오면 판단 보류로 내려간다", () => {
    const { call, start } = env();
    const id = start();
    call(observe(id, "baseline", "unsupported"));
    expect(call(observe(id, "candidate", "pass")).text).toContain("added-capability-observed");
    const countered = call(observe(id, "candidate", "fail", { evidence: ["artifact://42"] }));
    expect(countered.text).toContain("conflicting-evidence");
    expect(countered.text).toContain("미확인");
  });

  test("기존과 후보를 다른 환경에서 관찰하면 판단 보류다", () => {
    const { call, start } = env();
    const id = start();
    call(observe(id, "baseline", "fail"));
    expect(call(observe(id, "candidate", "pass", { environment: { app: "notepad 11.3" } })).text).toContain("environment-mismatch");
  });

  test("기존 통과·후보 실패, 둘 다 실패, 후보 미실행을 구분한다", () => {
    const { call, start } = env();
    const worse = start();
    call(observe(worse, "baseline", "pass"));
    expect(call(observe(worse, "candidate", "unsupported")).text).toContain("candidate-worse-observed");
    const neither = start();
    call(observe(neither, "baseline", "fail"));
    expect(call(observe(neither, "candidate", "fail")).text).toContain("neither-passed");
    const pending = start();
    expect(call(observe(pending, "baseline", "pass")).text).toContain("candidate-not-run");
  });
});

describe("tool_trial 입력 거절", () => {
  test("근거 없는 관찰·없는 경로·비밀 값은 기록하지 않고, 미실행은 근거 없이 받는다", () => {
    const { call, start } = env();
    const id = start();
    expect(call(observe(id, "candidate", "pass", { evidence: [] }))).toMatchObject({ isError: true });
    expect(call(observe(id, "candidate", "pass", { evidence: ["missing.log"] }))).toMatchObject({ isError: true });
    expect(call(observe(id, "candidate", "pass", { note: "password=hunter2-secret" }))).toMatchObject({ isError: true });
    expect(call(observe(id, "candidate", "pass", { evidence: ["https://user:pw@example.com/x"] }))).toMatchObject({ isError: true });
    expect(call(observe(id, "candidate", "not-run")).isError).toBe(false);
    expect(call({ action: "show", trialId: id }).text).toContain("revision 2");
  });

  test("시작할 때 환경과 버전이 없으면 거절한다", () => {
    const { call } = env();
    expect(call({ action: "start", scenario: "s", acceptance: "a", environment: {}, baselineTool: "a", baselineVersion: "1", candidateTool: "b", candidateVersion: "2" }).isError).toBe(true);
    expect(call({ action: "start", scenario: "s", acceptance: "a", environment: { os: "x" }, baselineTool: "a", candidateTool: "b", candidateVersion: "2" }).isError).toBe(true);
  });
});

describe("tool_trial 기록", () => {
  test("다른 세션 기록은 past로만 보이고 현재 판정에 합치지 않는다", () => {
    const { call, start } = env();
    const old = start("session-old", { os: "win10", app: "notepad 10" });
    call(observe(old, "baseline", "fail"), "session-old");
    call(observe(old, "candidate", "pass"), "session-old");
    const id = start();
    expect(call({ action: "list" }).text).not.toContain(old);
    expect(call({ action: "show", trialId: old }).isError).toBe(true);
    const past = call({ action: "past", trialId: id });
    expect(past.text).toContain(old);
    expect(past.text).toContain("다른 세션");
    expect(past.text).toContain("환경 다름: os, app");
    expect(call({ action: "show", trialId: id }).text).toContain("candidate-not-run");
  });

  test("expectedRevision이 낡았으면 충돌로 멈추고 아무것도 쓰지 않는다", () => {
    const { call, start } = env();
    const id = start();
    call(observe(id, "baseline", "pass", { expectedRevision: 1 }));
    const stale = call(observe(id, "candidate", "pass", { expectedRevision: 1 }));
    expect(stale).toMatchObject({ isError: true });
    expect(stale.text).toContain("기록 충돌");
    expect(call({ action: "show", trialId: id }).text).toContain("revision 2");
  });

  test("번호가 끊긴 기록은 손상으로 알리고 그 위에 쓰지 않는다", () => {
    const { root, call, start } = env();
    const id = start();
    call(observe(id, "baseline", "pass"));
    call(observe(id, "candidate", "pass"));
    const dir = join(root, "session-a", id);
    renameSync(join(dir, "000002.json"), join(dir, "000009.json"));
    expect(call({ action: "show", trialId: id })).toMatchObject({ isError: true, text: expect.stringContaining("끊겼") });
    expect(call(observe(id, "candidate", "pass")).isError).toBe(true);
    expect(call({ action: "list" })).toMatchObject({ isError: true, text: expect.stringContaining("손상된 기록") });
  });

  test("판정 필드가 알 수 없는 값으로 바뀐 기록은 손상으로 알리고 판정·기록하지 않는다", () => {
    const { root, call, start } = env();
    const id = start();
    call(observe(id, "baseline", "fail"));
    const file = join(root, "session-a", id, "000002.json");
    writeFileSync(file, readFileSync(file, "utf8").replace('"outcome":"fail"', '"outcome":"broken"'));
    expect(call({ action: "show", trialId: id })).toMatchObject({ isError: true, text: expect.stringContaining("형식") });
    expect(call(observe(id, "candidate", "pass")).isError).toBe(true);
    expect(readdirSync(join(root, "session-a", id))).toHaveLength(2);
  });

  test("scheme 근거를 확인된 로컬 근거로 바꿔 적은 기록도 손상으로 알린다", () => {
    const { root, call, start } = env();
    const id = start();
    call(observe(id, "baseline", "fail", { evidence: ["artifact://7"] }));
    const file = join(root, "session-a", id, "000002.json");
    writeFileSync(file, readFileSync(file, "utf8").replace('"check":"unchecked"', '"check":"local-exists"'));
    expect(call({ action: "show", trialId: id })).toMatchObject({ isError: true, text: expect.stringContaining("형식") });
  });

  test("다른 세션 폴더로 이어지는 링크나 겹칠 수 있는 세션 id로는 읽거나 쓰지 않는다", () => {
    const { root, call, start } = env();
    const id = start("session-b");
    symlinkSync(join(root, "session-b"), join(root, "session-a"));
    expect(call(observe(id, "candidate", "not-run")).isError).toBe(true);
    expect(call({ action: "list" }).isError).toBe(true);
    expect(readdirSync(join(root, "session-b", id))).toHaveLength(1);
    expect(call({ action: "list" }, "session/b").isError).toBe(true);
    // 대소문자만 다른 세션 id는 대소문자를 가리지 않는 파일 시스템에서도 다른 폴더가 된다.
    const upper = start("SESSION-B");
    expect(readdirSync(root).sort()).toEqual(["_s_e_s_s_i_o_n-_b", "session-a", "session-b"]);
    expect(call({ action: "show", trialId: upper }, "session-b").isError).toBe(true);
    expect(call({ action: "show", trialId: upper }, "SESSION-B").isError).toBe(false);
    // 끝 점은 Windows에서 같은 폴더가 될 수 있어 받지 않고, 다른 세션 폴더로 옮겨진 기록은 주인이 맞지 않아 손상으로 알린다.
    expect(call({ action: "list" }, "session-b.").isError).toBe(true);
    cpSync(join(root, "session-b"), join(root, "session-c"), { recursive: true });
    expect(call({ action: "show", trialId: id }, "session-c")).toMatchObject({ isError: true, text: expect.stringContaining("맞지 않습니다") });
    expect(call(observe(id, "candidate", "not-run"), "session-c").isError).toBe(true);
  });

  test("환경 키에 토큰 모양이 있으면 기록하지 않는다", () => {
    const { call } = env();
    const result = call({ action: "start", scenario: "s", acceptance: "a", environment: { [`ghp_${"a".repeat(36)}`]: "x" }, baselineTool: "a", baselineVersion: "1", candidateTool: "b", candidateVersion: "2" });
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("ghp_");
  });

  test("여러 프로세스가 동시에 기록해도 관찰이 사라지지 않는다", async () => {
    const { root, cwd, start } = env();
    const id = start();
    const worker = join(cwd, "worker.ts");
    const module = fileURLToPath(new URL("../tool-trial.ts", import.meta.url));
    writeFileSync(worker, [
      `import { runToolTrial } from ${JSON.stringify(module)};`,
      "const [root, cwd, id, tag] = process.argv.slice(2);",
      "for (let i = 0; i < 15; i += 1) {",
      "  const r = runToolTrial({ action: 'observe', trialId: id, side: i % 2 ? 'baseline' : 'candidate', outcome: 'pass', evidence: ['run.log'], note: `${tag}-${i}` }, { root, cwd, sessionId: 'session-a' });",
      "  if (r.isError) { console.error(r.text); process.exit(1); }",
      "}",
    ].join("\n"));
    const procs = ["w1", "w2", "w3", "w4"].map((tag) => Bun.spawn([process.execPath, worker, root, cwd, id, tag], { stderr: "pipe" }));
    const codes = await Promise.all(procs.map((proc) => proc.exited));
    expect(codes).toEqual([0, 0, 0, 0]);
    const files = readdirSync(join(root, "session-a", id)).sort();
    expect(files).toHaveLength(61);
    expect(files.at(-1)).toBe("000061.json");
    const text = runToolTrial({ action: "show", trialId: id }, { root, cwd, sessionId: "session-a" }).text;
    for (const tag of ["w1", "w2", "w3", "w4"]) for (let i = 0; i < 15; i += 1) expect(text).toContain(`메모: ${tag}-${i}`);
  }, 60_000);

  test("SDK 확장 loader로 등록되고 핸들러가 이 세션 기록을 남긴다", async () => {
    const { root, cwd } = env();
    const path = fileURLToPath(new URL("../tool-trial.ts", import.meta.url));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "..", "agent");
    try {
      const loaded = await loadExtensions([path], cwd);
      expect(loaded.errors).toEqual([]);
      const tool = loaded.extensions[0]!.tools.get("tool_trial")!.definition;
      const ctx = { cwd, sessionManager: { getSessionId: () => "loader-session" } } as never;
      const started = await tool.execute("call-1", {
        action: "start", scenario: "s", acceptance: "a", environment: { os: "linux" },
        baselineTool: "read", baselineVersion: "1", candidateTool: "skim", candidateVersion: "2",
      } as never, undefined, undefined, ctx);
      expect(started.isError).toBeUndefined();
      expect(readdirSync(join(root, "..", "agent", "tool-trials", "loader-session"))).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});
