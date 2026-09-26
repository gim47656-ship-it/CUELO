import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createJevRuntime, type JevRuntimeDeps } from "../jev-runtime";

const fixtureSession = "session-1";
const fixtureDirs = new Set<string>();
function fixtureDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  fixtureDirs.add(dir);
  return dir;
}
afterEach(() => {
  for (const dir of fixtureDirs) {
    rmSync(dir, { recursive: true, force: true });
    fixtureDirs.delete(dir);
  }
});

type Handler = (event: unknown, ctx: unknown) => unknown;

interface SentMessage {
  message: { customType?: string; content?: unknown; display?: boolean; attribution?: string };
  options: { deliverAs?: string };
}

interface RecordedJudgment {
  state: Record<string, unknown>;
  questions: Record<string, { type: string }>;
}
interface RegisteredRouteTool {
  name: string;
  execute: (...args: unknown[]) => Promise<{ details: { routes: { status: string; recommendations: unknown; history?: unknown }[] } }>;
}
interface EventHarness {
  emit(name: string, event: unknown): Promise<unknown>;
}

interface HarnessOptions {
  judgeError?: string;
  judgeAnswers?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  noSettings?: boolean;
  resolveError?: string;
  asyncJobs?: Array<Record<string, unknown>>;
  /** getAsyncJobSnapshot().recent 행. core 실제형태처럼 settled row의 startTime·endTime을 싣는다. */
  recentJobs?: Array<Record<string, unknown>>;
  sessionEntries?: unknown[];
  judgeGate?: Promise<void>;
  ledgerPath?: string;
}


function structuralReports(sent: SentMessage[]): Array<Record<string, unknown>> {
  const content = String(sent.at(-1)?.message.content ?? "");
  const startMarker = "structuralSummary=";
  const start = content.indexOf(startMarker);
  const end = content.indexOf(". 구조 count", start);
  if (start < 0 || end < 0) throw new Error("pre-review structuralSummary가 없습니다.");
  const summary = JSON.parse(content.slice(start + startMarker.length, end)) as {
    details: Array<{
      locator: string;
      normalCount: number;
      problem: Record<string, unknown>;
      unobserved: string[];
      evidenceLocators: string[];
    }>;
  };
  return summary.details.map((detail) => {
    const report: Record<string, unknown> = {
      jobId: detail.locator,
      normalCount: detail.normalCount,
      evidenceLocators: detail.evidenceLocators,
      ...detail.problem,
    };
    for (const key of detail.unobserved) report[key] = null;
    return report;
  });
}
function createHarness(options: HarnessOptions = {}) {
  const handlers: Record<string, Handler[]> = {};
  const sent: SentMessage[] = [];
  const judgments: RecordedJudgment[] = [];
  const warnings: string[] = [];
  const tools: Record<string, RegisteredRouteTool> = {};
  const asyncJobs: Array<{ id: string; agentId: string }> = (options.asyncJobs ?? []) as Array<{ id: string; agentId: string }>;
  const zodChain = (): { nullable(): unknown; optional(): unknown } => ({ nullable: zodChain, optional: zodChain });

  const settings = options.noSettings
    ? undefined
    : {
        getModelRoles: () => (options.settings?.modelRoles as Record<string, string> | undefined) ?? {
          implSol: "test/local:high",
          implOpus: "test/broad:high",
          implDeepSeek: "test/deepseek:high",
          makerHardUiOpus: "test/interaction:high",
          makerHardCodeOpus: "test/invariants:high",
          makerHardCodeAstra: "test/alternate:high",
        },
      };

  // 실제 프로필의 routing-ledger.jsonl을 건드리지 않도록 harness마다 임시 경로를 준다.
  const ledgerPath = options.ledgerPath ?? join(fixtureDir("jev-ledger-"), "routing-ledger.jsonl");
  const deps: JevRuntimeDeps = {
    ledgerPath,
    findScopedSettings: () => settings,
    resolveJudge: () => {
      if (options.resolveError) throw new Error(options.resolveError);
      return {
        label: "fake/jev",
        async judge(request: { state: unknown; questions: Record<string, { type: string }> }) {
          if (options.judgeGate) await options.judgeGate;
          if (options.judgeError) throw new Error(options.judgeError);
          judgments.push({
            state: request.state as Record<string, unknown>,
            questions: request.questions,
          });
          const answers: Record<string, unknown> = {};
          for (const id in request.questions) {
            const question = request.questions[id];
            answers[id] =
              options.judgeAnswers?.[id] ??
              (question.type === "noul"
                ? { type: "noul", noul: 0.1 }
                // 강도 질문은 픽스처가 실제로 발주하는 high로 답한다.
                : id.startsWith("effort")
                  ? { type: "choice", choice: "high", probabilities: { high: 1 }, confidence: 1 }
                  : { type: "choice", choice: "lo", probabilities: { lo: 1 }, confidence: 1 });
          }
          return { answers, provider: "fake", model: "jev" };
        },
      };
    },
  };

  const ctx = {
    cwd: "E:/work",
    model: { provider: "openai-codex", id: "gpt-6-astra" },
    modelRegistry: { find: () => ({ thinking: { efforts: ["low", "medium", "high"] } }) },
    sessionManager: {
      getSessionId: () => "session-1",
      getBranch: () => options.sessionEntries ?? [],
    },
    getAsyncJobSnapshot: () => ({ running: asyncJobs, recent: options.recentJobs ?? [] }),
  };

  const pi = {
    // SDK가 소유하는 schema parsing은 실제 zod 등록 smoke에서 확인한다. 여기 stub은 등록 경로만 통과시킨다.
    zod: { object: (shape: unknown) => shape, string: zodChain, array: zodChain },
    registerTool(definition: RegisteredRouteTool) { tools[definition.name] = definition; },
    on(name: string, handler: Handler) {
      (handlers[name] ??= []).push(handler);
    },
    sendMessage(message: SentMessage["message"], sendOptions: SentMessage["options"]) {
      sent.push({ message, options: sendOptions });
    },
    logger: {
      warn(...args: unknown[]) {
        warnings.push(args.map(String).join(" "));
      },
    },
  };

  createJevRuntime(deps)(pi as never);

  let routeCalls = 0;
  return {
    sent,
    judgments,
    warnings,
    ledgerPath,
    prepare: (task = GUARDED_TASK, name = "Next") => tools.maker_route.execute(`route-${++routeCalls}`, {
      context: "", tasks: [{ name, task, assessment: {
        goal: "소유 범위의 구현", acceptance: ["검사 통과"], facts: ["기존 패턴이 있다"],
        paths: ["a.ts"], invariants: ["호출 계약"], checks: ["bun test"],
        hypotheses: null, unknowns: null, callBoundaries: null, settledImplementation: null,
        reusedPatterns: null, remainingJudgments: ["국소 구현 선택"], failureEvidence: null,
      } }],
    }, undefined, undefined, ctx),
    // routing_verdict 실제 등록 handler를 그대로 지난다.
    verdict: (params: Record<string, unknown>) =>
      tools.routing_verdict!.execute("verdict", params, undefined, undefined, ctx) as unknown as Promise<{ details: Record<string, unknown> }>,
    async emit(name: string, event: unknown) {
      let result: unknown;
      for (const handler of handlers[name] ?? []) {
        const candidate = await handler(event, ctx);
        if (candidate !== undefined) result = candidate;
      }
      return result;
    },
  };
}

function taskCall(id: string, task: string, extra: Record<string, unknown> = {}) {
  return {
    type: "tool_call",
    toolCallId: id,
    toolName: "task",
    input: { agent: "maker", task, ...extra },
  };
}

async function registerLiveMaker(
  harness: { emit(name: string, event: unknown): Promise<unknown> },
  name = "Existing",
  task = GUARDED_TASK,
) {
  await harness.emit("tool_result", {
    type: "tool_result",
    toolCallId: `spawn-${name}`,
    toolName: "task",
    input: { agent: "maker", name, task },
    content: [{ type: "text", text: "spawned" }],
    isError: false,
    details: { async: { jobId: `job-${name}` }, progress: [{ index: 0, id: `agent-${name}`, status: "running" }] },
  });
}

const GUARDED_TASK = `TASK_GUARD:
WORK_CLASS: maintenance
PURPOSE: primary
BLOCKS_PRIMARY: yes
PRIMARY_DELIVERABLE: x
OWNED_PATHS: a.ts,b.ts

본문 내용은 judge에내면 안 된다.`;

const PROGRESS_TASK = `TASK_GUARD:
WORK_CLASS: feature
PURPOSE: primary
BLOCKS_PRIMARY: yes
PRIMARY_DELIVERABLE: 카드가 실제 담당업무를 표시한다
OWNED_PATHS: a.ts
TASK_TITLE: 진행 상태와 실제 담당업무 분리
TODO_TASKS: ["stable title 구현","focused 검증"]
초기 formatter/lint/build/tests 모두 건너뛴다. Main이 frozen delta를 확인한 뒤 focused 검증을 해제한다.`;


describe("jev-runtime pre-dispatch", () => {
  test("준비 없이 task를 호출하면 spawn 전에 멈추고 hook은 Jev를 호출하지 않는다", async () => {
    const harness = createHarness();
    const result = await harness.emit("tool_call", taskCall("call-1", GUARDED_TASK));
    expect(result).toMatchObject({ block: true });
    expect(harness.judgments).toHaveLength(0);
  });
  test("등록한 maker_route가 최소 사실과 후보별 질문을 Main에게 돌려준다", async () => {
    const harness = createHarness();
    const result = await harness.prepare();
    expect(result.details.routes[0].status).toBe("judged");
    expect(harness.judgments).toHaveLength(1);
    expect(harness.judgments[0]!.questions).toHaveProperty("workClass");
    expect(harness.judgments[0]!.questions).not.toHaveProperty("easyFocus");
    expect(result.details.candidates.find((candidate: { profile: string }) => candidate.profile === "HARD_CODE_OPUS").efforts).toEqual(["high"]);
    expect(JSON.stringify(harness.judgments[0]!.state)).not.toContain("본문 내용은");
    expect(JSON.stringify(harness.judgments[0]!.state)).not.toContain("test/local");
  });
  test("진행 입력 뒤에도 prepared ref를 재사용하고 canonical brief를 task hook에 전달한다", async () => {
    const harness = createHarness({
      judgeAnswers: {
        workClass: { type: "choice", choice: "NORMAL", probabilities: { NORMAL: 1 }, confidence: 1 },
        hardFocus: { type: "choice", choice: "CODE_SYSTEM", probabilities: { CODE_SYSTEM: 1 }, confidence: 1 },
        effort0: { type: "choice", choice: "high", probabilities: { high: 1 }, confidence: 1 },
      },
    });
    const prepared = await harness.prepare();
    const preparedId = prepared.details.routes[0].preparedId as string;
    await harness.emit("input", { type: "input", source: "rpc", text: "현재 진행 상황만 알려줘" });
    const result = await harness.emit("tool_call", taskCall(
      "call-prepared",
      `PREPARED_TASK: ${preparedId}`,
      { name: "Next", context: "PREPARED_CONTEXT", model: "test/local:high" },
    )) as { input?: Record<string, unknown> };
    expect(result.input?.context).toBe("");
    expect(result.input?.task).toBe(GUARDED_TASK);
    expect(harness.judgments).toHaveLength(1);
  });
  test("NORMAL 대안 후보 변경은 명시한 Main 근거와 후보 구간 안 concrete effort를 실제 task hook에서 검사한다", async () => {
    const harness = createHarness({
      judgeAnswers: {
        workClass: { type: "choice", choice: "NORMAL", probabilities: { NORMAL: 1 }, confidence: 1 },
        effort0: { type: "choice", choice: "high", probabilities: { high: 1 }, confidence: 1 },
      },
    });
    await harness.prepare();
    const reasoned = GUARDED_TASK.replace("OWNED_PATHS:", "ROUTING_REASON: Main이 한도 참고로 대안 후보를 선택함\nOWNED_PATHS:");
    expect(await harness.emit("tool_call", taskCall("call-alternate", reasoned, { name: "Next", model: "test/broad:high" }))).toBeUndefined();
    expect(await harness.emit("tool_call", taskCall("call-alternate-low", reasoned, { name: "Next", model: "test/broad:low" })))
      .toMatchObject({ block: true, reason: expect.stringContaining("NORMAL_OPUS") });
  });
  test("session reset은 prepared ref와 준비 판단을 함께 끊는다", async () => {
    const harness = createHarness();
    const prepared = await harness.prepare();
    const preparedId = prepared.details.routes[0].preparedId as string;
    await harness.emit("session_start", { type: "session_start" });
    const result = await harness.emit("tool_call", taskCall(
      "call-stale",
      `PREPARED_TASK: ${preparedId}`,
      { name: "Next", context: "PREPARED_CONTEXT", model: "test/local:high" },
    ));
    expect(result).toMatchObject({ block: true });
    expect(harness.judgments).toHaveLength(1);
  });
  test("사용자 경계가 routing 상속 lock만 해제해 B의 명시 첫 task 뒤 생략 둘째 task를 B에 연결한다", async () => {
    const boundaries: Array<[string, (harness: EventHarness) => Promise<unknown>]> = [
      ["genuine input", (harness) => harness.emit("input", { type: "input", source: "rpc", text: "B로 전환" })],
      ["steering", (harness) => harness.emit("message_start", {
        type: "message_start",
        message: { role: "user", steering: true, content: "B로 전환" },
      })],
    ];
    for (const [label, crossBoundary] of boundaries) {
      const harness = createHarness({
        judgeAnswers: {
          workClass: { type: "choice", choice: "NORMAL", probabilities: { NORMAL: 1 }, confidence: 1 },
          hardFocus: { type: "choice", choice: "CODE_SYSTEM", probabilities: { CODE_SYSTEM: 1 }, confidence: 1 },
          effort0: { type: "choice", choice: "high", probabilities: { high: 1 }, confidence: 1 },
        },
      });
      await harness.prepare(GUARDED_TASK, `FirstA-${label}`);
      const firstInput = taskCall(`call-a-${label}`, GUARDED_TASK, {
        name: `FirstA-${label}`,
        model: "test/local:high",
      });
      expect(await harness.emit("tool_call", firstInput)).toBeUndefined();
      await harness.emit("tool_result", {
        ...firstInput,
        type: "tool_result",
        content: [{ type: "text", text: "spawned" }],
        isError: false,
        details: { async: { jobId: `job-a-${label}` }, progress: [{ index: 0, id: `agent-a-${label}`, status: "running" }] },
      });

      await crossBoundary(harness);
      const bTask = GUARDED_TASK
        .replace("PRIMARY_DELIVERABLE: x", "PRIMARY_DELIVERABLE: y")
        .replace("OWNED_PATHS: a.ts,b.ts", "OWNED_PATHS: c.ts");
      await harness.prepare(bTask, `FirstB-${label}`);
      const firstBInput = taskCall(`call-b-${label}`, bTask, {
        name: `FirstB-${label}`,
        model: "test/local:high",
      });
      expect(await harness.emit("tool_call", firstBInput)).toBeUndefined();
      await harness.emit("tool_result", {
        ...firstBInput,
        type: "tool_result",
        content: [{ type: "text", text: "spawned" }],
        isError: false,
        details: { async: { jobId: `job-b-${label}` }, progress: [{ index: 0, id: `agent-b-${label}`, status: "running" }] },
      });

      const inherited = "TASK_GUARD:\nOWNED_PATHS: d.ts\n\nB의 둘째 child";
      await harness.prepare(inherited, `SecondB-${label}`);
      const explicitB = bTask.replace("OWNED_PATHS: c.ts", "OWNED_PATHS: d.ts");
      expect(await harness.emit("tool_call", taskCall(`call-second-${label}`, explicitB, {
        name: `SecondB-${label}`,
        model: "test/local:high",
      }))).toBeUndefined();
    }
  });

  test("성공 task result만 후속 inherited TaskGuard 준비의 lock을 확립한다", async () => {
    const inherited = "TASK_GUARD:\nOWNED_PATHS: next.ts\n\nlock 상속 child";
    const success = createHarness();
    await registerLiveMaker(success, "First");
    expect((await success.prepare(inherited, "Second")).details.routes[0].status).toBe("judged");

    const failed = createHarness();
    await failed.emit("tool_result", {
      type: "tool_result",
      toolCallId: "failed-spawn",
      toolName: "task",
      input: { agent: "maker", name: "First", task: GUARDED_TASK },
      content: [{ type: "text", text: "spawn failed" }],
      isError: true,
    });
    let failure: unknown;
    try {
      await failed.prepare(inherited, "Second");
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain("TaskGuard lock");
  });
  async function spawnAndSettle(
    harness: { prepare(task: string, name: string): Promise<unknown>; emit(name: string, event: unknown): Promise<unknown> },
    name: string,
    callId: string,
    agentId: string,
  ) {
    await harness.prepare(GUARDED_TASK, name);
    const input = taskCall(callId, GUARDED_TASK, { name, model: "test/local:high" });
    await harness.emit("tool_call", input);
    await harness.emit("tool_result", {
      ...input,
      type: "tool_result",
      content: [{ type: "text", text: "spawned" }],
      isError: false,
      // core 실제형태: progress row id=agentId(canonical agent:// target), async job은 jobId와 agentId가 다르다.
      details: { async: { jobId: `job-${agentId}` }, progress: [{ index: 0, id: agentId, status: "running" }] },
    });
    await harness.emit("message_start", {
      type: "message_start",
      message: {
        role: "custom", customType: "async-result", attribution: "agent",
        details: { jobs: [{ jobId: `job-${agentId}`, agentId, type: "task", status: "completed", durationMs: 61_400 }] },
      },
    });
  }

  test("spawn·settle 뒤에만 수용되고 held 뒤 명시수용과 reload 복원이 이어진다", async () => {
    const harness = createHarness({
      judgeAnswers: {
        workClass: { type: "choice", choice: "NORMAL", probabilities: { NORMAL: 1 }, confidence: 1 },
      },
    });
    await harness.prepare(GUARDED_TASK, "Ledger");
    const input = taskCall("call-ledger", GUARDED_TASK, { name: "Ledger", model: "test/local:high" });
    expect(await harness.emit("tool_call", input)).toBeUndefined();
    await harness.emit("tool_result", {
      ...input,
      type: "tool_result",
      content: [{ type: "text", text: "spawned" }],
      isError: false,
      details: { async: { jobId: "job-ledger" }, progress: [{ index: 0, id: "agent-ledger", status: "running" }] },
    });
    const identity = { sessionId: fixtureSession, assignmentId: "session-1#call-ledger#0", attempt: 1, attemptId: "session-1#call-ledger#0#a1", agentId: "agent-ledger" };
    const judge = (overrides: Record<string, unknown>) => harness.verdict({ ...identity, reason: "검수", ...overrides });

    // 실행 중에는 완료를 관측하지 못했으므로 accepted를 쓸 수 없다.
    expect((await judge({ verdict: "accepted", revision: "rev-1", evidenceLocators: ["artifact://e"] })).details)
      .toMatchObject({ ok: false, error: expect.stringContaining("완료가 관측된") });
    // held는 실행 상태와 무관하게 reason만으로 기록된다.
    expect((await judge({ verdict: "held" })).details).toMatchObject({ ok: true });
    // 실행 중 reload도 dispatch의 실제 job identity를 복원해야 한다.
    await harness.emit("session_start", { type: "session_start" });

    await harness.emit("message_start", {
      type: "message_start",
      message: {
        role: "custom", customType: "async-result", attribution: "agent",
        details: { jobs: [{ jobId: "job-ledger", agentId: "agent-ledger", type: "task", status: "completed", durationMs: 61_400 }] },
      },
    });
    // 중간 입력은 수용 상태를 종결하지 않는다. held가 그대로 남는다.
    await harness.emit("input", { type: "input", source: "interactive", text: "다음" });
    expect((await harness.prepare(GUARDED_TASK, "AfterInput")).details.routes[0]!.history)
      .toMatchObject({ attempts: 1, followed: { ok: 0, held: 1 } });

    // 완료 뒤에는 accepted가 기록된다.
    expect((await judge({ verdict: "accepted", revision: "rev-1", evidenceLocators: ["artifact://focused"] })).details)
      .toMatchObject({ ok: true });
    // git_finalize 성공은 수용을 추정하지 않는다.
    await harness.emit("tool_result", {
      type: "tool_result", toolName: "git_finalize", toolCallId: "call-finalize", input: {},
      content: [{ type: "text", text: "Committed and pushed" }], isError: false,
    });

    // reload(session_start) 뒤에도 같은 session의 scoped 기록으로 복원되어 다시 판정된다.
    await harness.emit("session_start", { type: "session_start" });
    expect((await judge({ verdict: "held" })).details).toMatchObject({ ok: true });

    const records = readFileSync(harness.ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records).toMatchObject([
      {
        type: "dispatch", name: "Ledger", workClass: "NORMAL", focus: null,
        recommendedProfile: "NORMAL_SOL", recommendedModel: "test/local", recommendedEffort: "high",
        chosenModel: "test/local", chosenEffort: "high", routingReason: false, purpose: "primary", ...identity,
      },
      { type: "verdict", verdict: "held", revision: null, evidenceLocators: [], reason: "검수", ...identity },
      { type: "outcome", status: "completed", durationSec: 61, ...identity },
      { type: "verdict", verdict: "accepted", revision: "rev-1", evidenceLocators: ["artifact://focused"], reason: "검수", ...identity },
      { type: "verdict", verdict: "held", revision: null, evidenceLocators: [], reason: "검수", ...identity },
    ]);
  });

  test("같은 이름의 새 발주는 새 assignment이고, 성공한 REWORK write가 실제 새 jobId로만 재개 attempt를 연다", async () => {
    // 전송 전에 이미 알던 job 집합과 전송 뒤 새 job을 구분할 수 있도록 스냅샷을 흉내낸다.
    const jobs: Array<{ id: string; agentId: string }> = [];
    const harness = createHarness({
      asyncJobs: jobs,
      judgeAnswers: {
        workClass: { type: "choice", choice: "NORMAL", probabilities: { NORMAL: 1 }, confidence: 1 },
      },
    });
    await spawnAndSettle(harness, "Fix", "call-a", "agent-a");
    await spawnAndSettle(harness, "Fix", "call-b", "agent-b");
    jobs.push({ id: "job-old", agentId: "agent-b" });
    const records = () => readFileSync(harness.ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const of = (type: string) => records().filter((record) => record.type === type);
    expect(of("dispatch").map((record) => record.assignmentId)).toEqual(["session-1#call-a#0", "session-1#call-b#0"]);
    expect((await harness.verdict({
      sessionId: fixtureSession, assignmentId: "session-1#call-b#0", attemptId: "session-1#call-b#0#a1",
      verdict: "rework", revision: "r1", reason: "재작업 근거", evidenceLocators: ["artifact://original"],
    })).details).toMatchObject({ ok: true });

    const rework = (callId: string) => ({
      type: "tool_call", toolCallId: callId, toolName: "write",
      input: { path: "agent://agent-b", content: "REWORK task_id=Fix role=maker previous_revision=r1 next_revision=r2\n범위 유지." },
    });
    // 전송 성공(tool_result) 전에는 attempt를 만들지 않는다. tool_call에서 전송 전 job 집합을 캡처한다.
    const first = rework("call-rew-1");
    await harness.emit("tool_call", first);
    expect(of("dispatch")).toHaveLength(2);
    // 성공 직후 실제 새 job이 등록된다.
    jobs.push({ id: "job-new", agentId: "agent-b" });
    await harness.emit("tool_result", { ...first, type: "tool_result", content: [{ type: "text", text: "Delivered" }], isError: false });
    const resumed = of("dispatch").at(-1)!;
    expect(resumed).toMatchObject({
      assignmentId: "session-1#call-b#0", attempt: 2, attemptId: "session-1#call-b#0#a2", agentId: "agent-b", jobId: "job-new", name: "Fix",
    });
    // 원 attempt의 dispatch metadata를 정확한 identity로 복사해 모델·effort 관측이 사라지지 않는다.
    expect(resumed.recommendedModel).toBe("test/local");
    expect(resumed.chosenEffort).toBe("high");

    // 새 job 결과보다 먼저 '전송 전에 알던 job'이 정산돼도 재개 attempt를 소비하지 않는다.
    await harness.emit("message_start", {
      type: "message_start",
      message: {
        role: "custom", customType: "async-result", attribution: "agent",
        details: { jobs: [{ jobId: "job-old", agentId: "agent-b", type: "task", status: "completed", durationMs: 30 }] },
      },
    });
    expect(of("outcome").map((record) => record.attemptId)).toEqual(["session-1#call-a#0#a1", "session-1#call-b#0#a1"]);

    // 실제 새 job이 정산되면 그때 재개 attempt에 연결된다.
    await harness.emit("message_start", {
      type: "message_start",
      message: {
        role: "custom", customType: "async-result", attribution: "agent",
        details: { jobs: [{ jobId: "job-new", agentId: "agent-b", type: "task", status: "completed", durationMs: 2_000 }] },
      },
    });
    expect(of("outcome").map((record) => record.attemptId))
      .toEqual(["session-1#call-a#0#a1", "session-1#call-b#0#a1", "session-1#call-b#0#a2"]);
    harness.sent.length = 0;
    await harness.emit("tool_call", {
      type: "tool_call", toolCallId: "follow-up-after-resume", toolName: "write",
      input: { path: "agent://agent-b", content: "후속 검증 증거를 확인해줘." },
    });
    const missing = harness.sent.filter((entry) => String(entry.message.content).includes("명시 판정 미기록"));
    expect(missing).toHaveLength(1);
    expect(String(missing[0]!.message.content)).toContain("session-1#call-b#0#a2");
    expect(String(missing[0]!.message.content)).not.toContain("session-1#call-b#0#a1");
    expect((await harness.verdict({
      sessionId: fixtureSession, assignmentId: "session-1#call-b#0", attemptId: "session-1#call-b#0#a2",
      verdict: "accepted", revision: "r2", reason: "재개 검수", evidenceLocators: ["artifact://resume"],
    })).details).toMatchObject({ ok: true });
    harness.sent.length = 0;
    await harness.emit("tool_call", {
      type: "tool_call", toolCallId: "follow-up-after-accepted", toolName: "write",
      input: { path: "agent://agent-b", content: "다른 검증 증거를 확인해줘." },
    });
    expect(harness.sent.filter((entry) => String(entry.message.content).includes("명시 판정 미기록"))).toHaveLength(0);

    // 두 번째 REWORK는 아직 새 job이 스냅샷에 없다: receipt를 pending으로 보관하고 새 attempt를 만들지 않는다.
    const second = rework("call-rew-2");
    await harness.emit("tool_call", second);
    await harness.emit("tool_result", { ...second, type: "tool_result", content: [{ type: "text", text: "Delivered" }], isError: false });
    expect(of("dispatch")).toHaveLength(3);

    // 낯선 agent의 job은 재개 대상도 아니고 원 attempt에도 붙지 않는다.
    await harness.emit("message_start", {
      type: "message_start",
      message: {
        role: "custom", customType: "async-result", attribution: "agent",
        details: { jobs: [{ jobId: "job-stranger", agentId: "agent-unknown", type: "task", status: "completed", durationMs: 7 }] },
      },
    });
    expect(of("dispatch")).toHaveLength(3);
    expect(of("outcome")).toHaveLength(3);

    // 두 번째 지시가 pending receipt의 기준선을 덮지 않는다. 오래된 이벤트 자체는 새 job 증거가 아니다.
    jobs.push({ id: "job-late-resume", agentId: "agent-b" });
    const overlapping = rework("call-rew-overlap");
    await harness.emit("tool_call", overlapping);
    await harness.emit("tool_result", { ...overlapping, type: "tool_result", isError: false });
    await harness.emit("message_start", {
      message: { role: "custom", customType: "async-result", details: {
        jobs: [{ jobId: "job-stale-not-in-snapshot", agentId: "agent-b", type: "task", status: "completed" }],
      } },
    });
    expect(of("dispatch")).toHaveLength(3);
    // 현재 snapshot의 유일한 새 job이 정산될 때 attempt 3이 열린다.
    await harness.emit("message_start", {
      type: "message_start",
      message: {
        role: "custom", customType: "async-result", attribution: "agent",
        details: { jobs: [{ jobId: "job-late-resume", agentId: "agent-b", type: "task", status: "completed", durationMs: 900 }] },
      },
    });
    const lateResume = of("dispatch").at(-1)!;
    expect(lateResume).toMatchObject({
      assignmentId: "session-1#call-b#0", attempt: 3, attemptId: "session-1#call-b#0#a3", agentId: "agent-b", jobId: "job-late-resume", name: "Fix",
    });
    expect(of("outcome").map((record) => record.attemptId))
      .toEqual(["session-1#call-a#0#a1", "session-1#call-b#0#a1", "session-1#call-b#0#a2", "session-1#call-b#0#a3"]);
  });

  test("core 실제형태: 재개 job이 원 jobId(=agentId)를 재사용하고 async-result에 agentId가 없어도 REWORK attempt를 잇는다", async () => {
    // core 18.3.2: spawn job과 IRC wake job 모두 `id: agentId`로 등록되고, 소비된 row는 30초 뒤 evict되어 같은 id가 다시 쓰인다.
    // async-result details.jobs에는 agentId가 없고, 실행 구분은 snapshot row의 startTime뿐이다.
    const running: Array<Record<string, unknown>> = [];
    const recent: Array<Record<string, unknown>> = [];
    const harness = createHarness({
      asyncJobs: running,
      recentJobs: recent,
      judgeAnswers: { workClass: { type: "choice", choice: "NORMAL", probabilities: { NORMAL: 1 }, confidence: 1 } },
    });
    const records = () => readFileSync(harness.ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const of = (type: string) => records().filter((record) => record.type === type);
    const assignmentId = "session-1#call-real#0";
    const settleRow = (startTime: number) => {
      running.length = 0;
      recent.length = 0;
      recent.push({ id: "agent-r", agentId: "agent-r", type: "task", status: "completed", startTime, endTime: startTime + 50 });
    };
    const deliver = () => harness.emit("message_start", {
      type: "message_start",
      message: {
        role: "custom", customType: "async-result", attribution: "agent",
        details: { jobs: [{ jobId: "agent-r", type: "task", label: "Fix", durationMs: 50 }] },
      },
    });
    const rework = async (callId: string, previous: string, next: string) => {
      const call = {
        type: "tool_call", toolCallId: callId, toolName: "write",
        input: { path: "agent://agent-r", content: `REWORK task_id=Fix role=maker previous_revision=${previous} next_revision=${next}\n범위 유지.` },
      };
      await harness.emit("tool_call", call);
      await harness.emit("tool_result", { ...call, type: "tool_result", content: [{ type: "text", text: "Delivered" }], isError: false });
    };

    await harness.prepare(GUARDED_TASK, "Fix");
    const input = taskCall("call-real", GUARDED_TASK, { name: "Fix", model: "test/local:high" });
    await harness.emit("tool_call", input);
    running.push({ id: "agent-r", agentId: "agent-r", type: "task", status: "running", startTime: Date.now() - 120_000 });
    await harness.emit("tool_result", {
      ...input, type: "tool_result", content: [{ type: "text", text: "spawned" }], isError: false,
      details: { async: { jobId: "agent-r" }, progress: [{ index: 0, id: "agent-r", status: "running" }] },
    });
    settleRow(Date.now() - 120_000);
    await deliver();
    expect(of("outcome").map((record) => record.attemptId)).toEqual([`${assignmentId}#a1`]);
    expect((await harness.verdict({
      sessionId: fixtureSession, assignmentId, attemptId: `${assignmentId}#a1`,
      verdict: "rework", revision: "r1", reason: "재작업 근거", evidenceLocators: ["artifact://a1"],
    })).details).toMatchObject({ ok: true });

    // 원 row가 아직 retained인 동안 보낸 REWORK: 그 row를 다시 보여 주는 wait는 옛 실행이므로 새 attempt가 아니다.
    await rework("call-rew-real-1", "r1", "r2");
    await harness.emit("tool_result", {
      type: "tool_result", toolCallId: "wait-old", toolName: "wait", input: {}, isError: false,
      content: [{ type: "text", text: "done" }], details: { jobs: [{ id: "agent-r", type: "task", status: "completed" }] },
    });
    expect(of("dispatch")).toHaveLength(1);

    // 원 row evict 뒤 wake job이 같은 id로 등록·완료된다.
    settleRow(Date.now() + 1);
    await deliver();
    expect(of("dispatch").at(-1)).toMatchObject({ assignmentId, attempt: 2, attemptId: `${assignmentId}#a2`, agentId: "agent-r", jobId: "agent-r", name: "Fix" });
    expect(of("outcome").map((record) => record.attemptId)).toEqual([`${assignmentId}#a1`, `${assignmentId}#a2`]);
    expect((await harness.verdict({
      sessionId: fixtureSession, assignmentId, attemptId: `${assignmentId}#a2`,
      verdict: "rework", revision: "r2", reason: "두 번째 재작업", evidenceLocators: ["artifact://a2"],
    })).details).toMatchObject({ ok: true });

    // 두 번째 REWORK도 같은 id를 다시 쓰는 새 실행에만 a3을 연다. 같은 결과의 중복 관측은 a4를 만들지 않는다.
    recent.length = 0;
    await rework("call-rew-real-2", "r2", "r3");
    settleRow(Date.now() + 2);
    await deliver();
    await harness.emit("tool_result", {
      type: "tool_result", toolCallId: "wait-dup", toolName: "wait", input: {}, isError: false,
      content: [{ type: "text", text: "done" }], details: { jobs: [{ id: "agent-r", type: "task", status: "completed" }] },
    });
    expect(of("dispatch").map((record) => record.attemptId))
      .toEqual([`${assignmentId}#a1`, `${assignmentId}#a2`, `${assignmentId}#a3`]);
    expect(of("outcome").map((record) => record.attemptId))
      .toEqual([`${assignmentId}#a1`, `${assignmentId}#a2`, `${assignmentId}#a3`]);
    expect((await harness.verdict({
      sessionId: fixtureSession, assignmentId, attemptId: `${assignmentId}#a3`,
      verdict: "accepted", revision: "r3", reason: "최종 수용", evidenceLocators: ["artifact://a3"],
    })).details).toMatchObject({ ok: true });
  });

  test("평문 후속 지시로 재개한 결과는 새 attempt를 만들지 않는다", async () => {
    const running: Array<Record<string, unknown>> = [];
    const recent: Array<Record<string, unknown>> = [];
    const harness = createHarness({
      asyncJobs: running,
      recentJobs: recent,
      judgeAnswers: { workClass: { type: "choice", choice: "NORMAL", probabilities: { NORMAL: 1 }, confidence: 1 } },
    });
    const records = () => readFileSync(harness.ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    await harness.prepare(GUARDED_TASK, "Fix");
    const input = taskCall("call-plain", GUARDED_TASK, { name: "Fix", model: "test/local:high" });
    await harness.emit("tool_call", input);
    running.push({ id: "agent-p", agentId: "agent-p", type: "task", status: "running", startTime: Date.now() - 120_000 });
    await harness.emit("tool_result", {
      ...input, type: "tool_result", content: [{ type: "text", text: "spawned" }], isError: false,
      details: { async: { jobId: "agent-p" }, progress: [{ index: 0, id: "agent-p", status: "running" }] },
    });
    const deliver = () => harness.emit("message_start", {
      type: "message_start",
      message: { role: "custom", customType: "async-result", attribution: "agent", details: { jobs: [{ jobId: "agent-p", type: "task", label: "Fix" }] } },
    });
    running.length = 0;
    recent.push({ id: "agent-p", agentId: "agent-p", type: "task", status: "completed", startTime: Date.now() - 120_000 });
    await deliver();
    const call = { type: "tool_call", toolCallId: "plain-1", toolName: "write", input: { path: "agent://agent-p", content: "이 부분도 고쳐줘." } };
    await harness.emit("tool_call", call);
    await harness.emit("tool_result", { ...call, type: "tool_result", content: [{ type: "text", text: "Delivered" }], isError: false });
    recent.length = 0;
    recent.push({ id: "agent-p", agentId: "agent-p", type: "task", status: "completed", startTime: Date.now() + 1 });
    await deliver();
    expect(records().filter((record) => record.type === "dispatch").map((record) => record.attemptId)).toEqual(["session-1#call-plain#0#a1"]);
    expect(records().filter((record) => record.type === "outcome").map((record) => record.attemptId)).toEqual(["session-1#call-plain#0#a1"]);
  });

  test("배치 두 child가 같은 label로 역순 완료돼도 각 실제 job에 수용이 귀속된다", async () => {
    const harness = createHarness({
      asyncJobs: [{ id: "job-left", agentId: "agent-left" }, { id: "job-right", agentId: "agent-right" }],
      judgeAnswers: { workClass: { type: "choice", choice: "NORMAL", probabilities: { NORMAL: 1 }, confidence: 1 } },
    });
    const left = GUARDED_TASK.replace("a.ts,b.ts", "left.ts");
    const right = GUARDED_TASK.replace("a.ts,b.ts", "right.ts");
    await harness.prepare(left, "Left");
    await harness.prepare(right, "Right");
    const call = {
      type: "tool_call", toolName: "task", toolCallId: "batch",
      input: { context: "", tasks: [
        { name: "Left", agent: "maker", task: left, model: "test/local:high" },
        { name: "Right", agent: "maker", task: right, model: "test/local:high" },
      ] },
    };
    expect(await harness.emit("tool_call", call)).toBeUndefined();
    await harness.emit("tool_result", {
      ...call, type: "tool_result", isError: false,
      details: { async: { jobId: "job-left" }, progress: [
        { index: 0, id: "agent-left", status: "running" },
        { index: 1, id: "agent-right", status: "running" },
      ] },
    });
    await harness.emit("message_start", {
      message: { role: "custom", customType: "async-result", details: { jobs: [
        { jobId: "job-right", agentId: "agent-right", label: "Fix", type: "task", status: "completed" },
        { jobId: "job-left", agentId: "agent-left", label: "Fix", type: "task", status: "completed" },
      ] } },
    });
    expect((await harness.verdict({
      sessionId: fixtureSession, assignmentId: "session-1#batch#1", attemptId: "session-1#batch#1#a1",
      verdict: "accepted", revision: "right-r1", evidenceLocators: ["artifact://right"], reason: "검수",
    })).details).toMatchObject({ ok: true });
    const records = readFileSync(harness.ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.filter((record) => record.type === "outcome").map((record) => [record.assignmentId, record.jobId]))
      .toEqual([["session-1#batch#1", "job-right"], ["session-1#batch#0", "job-left"]]);
    expect((await harness.prepare(GUARDED_TASK, "AfterBatch")).details.routes[0]!.history)
      .toMatchObject({ attempts: 2, followed: { ok: 1, pending: 1 } });
  });
  test("명시 판정 저장 실패는 성공으로 넘기지 않고 기록되지 않았음을 알린다", async () => {
    const dir = fixtureDir("jev-verdict-fail-");
    const ledgerPath = join(dir, "routing-ledger.jsonl");
    const harness = createHarness({
      ledgerPath,
      judgeAnswers: {
        workClass: { type: "choice", choice: "NORMAL", probabilities: { NORMAL: 1 }, confidence: 1 },
      },
    });
    await spawnAndSettle(harness, "Save", "call-save", "job-save");
    // 파일 자리에 디렉터리를 두면 이후 append가 실패한다.
    rmSync(ledgerPath, { force: true });
    mkdirSync(ledgerPath);
    const result = await harness.verdict({
      sessionId: fixtureSession, assignmentId: "session-1#call-save#0", attemptId: "session-1#call-save#0#a1",
      verdict: "accepted", revision: "rev", reason: "검수", evidenceLocators: ["artifact://e"],
    });
    expect(result.details).toMatchObject({ ok: false, error: expect.stringContaining("원장 기록에 실패") });
  });

  test("ledger 쓰기 실패는 경고만 남기고 발주와 settle을 막지 않는다", async () => {
    // 디렉터리를 파일 경로로 주면 append가 실패한다.
    const harness = createHarness({
      ledgerPath: fixtureDir("jev-ledger-dir-"),
      judgeAnswers: {
        workClass: { type: "choice", choice: "NORMAL", probabilities: { NORMAL: 1 }, confidence: 1 },
      },
    });
    await harness.prepare(GUARDED_TASK, "Broken");
    const input = taskCall("call-broken", GUARDED_TASK, { name: "Broken", model: "test/local:high" });
    expect(await harness.emit("tool_call", input)).toBeUndefined();
    await harness.emit("tool_result", {
      ...input,
      type: "tool_result",
      content: [{ type: "text", text: "spawned" }],
      isError: false,
      details: { async: { jobId: "job-broken" }, progress: [{ index: 0, id: "agent-broken", status: "running" }] },
    });
    expect(harness.warnings.some((warning) => warning.includes("routing ledger"))).toBe(true);
    expect((await harness.prepare(GUARDED_TASK, "After")).details.routes[0]!.status).toBe("judged");
  });

});
describe("jev-runtime 기존 Maker 자연어 추가 지시", () => {
  const ownerMessage = (message: string, to = "Existing") => ({
    type: "tool_call",
    toolCallId: `dm-${to}-${message.length}`,
    toolName: "write",
    input: { path: `agent://${to}`, content: message },
  });
  // 18.3.0 수신 경로 두 가지: `irc:incoming` 주입(details.message)과 `wait`가 소비한 메시지(details.waited.body).
  const incomingDm = (id: string, from: string, message: string) => ({
    type: "message_start",
    message: { role: "custom", customType: "irc:incoming", attribution: "agent", details: { id, from, message } },
  });
  const waitedDm = (id: string, from: string, body: string) => ({
    type: "tool_result",
    toolCallId: `wait-${id}`,
    toolName: "wait",
    input: {},
    content: [{ type: "text", text: `[${id}] ${from}: ${body}` }],
    isError: false,
    details: { op: "wait", from: "Main", waited: { id, from, to: "Main", body, ts: 0 } },
  });
  const waitCall = (id: string) => ({ type: "tool_call", toolCallId: id, toolName: "wait", input: {} });
  const CHECKPOINT = "위치: src/a.ts:1-40\n불변식:\n- 계약 유지\n동작 변화: 추가";

  test("문구와 동시성 변경은 같은 구조 신호만 안내하고 의미 판단 JEV를 호출하지 않는다", async () => {
    const harness = createHarness();
    await registerLiveMaker(harness);
    await harness.emit("tool_call", ownerMessage("버튼 문구 수정해."));
    await harness.emit("tool_call", ownerMessage("동시 주문 처리 수정해."));

    expect(harness.judgments).toHaveLength(0);
    expect(harness.sent).toHaveLength(2);
    for (const sent of harness.sent) {
      const advisory = String(sent.message.content);
      expect(advisory).toContain("actionSignal=true");
      expect(advisory).toContain("scopeSignal=false");
      expect(advisory).toContain("acceptanceSignal=false");
      expect(advisory).toContain("requestedMeaning");
      expect(advisory).toContain("exactScopeDelta");
      expect(advisory).toContain("unknown");
      expect(advisory).toContain("별도 JEV 판단을 호출하지 않는다");
      expect(advisory).toContain("detailLocator=tool_call:");
    }
    const outbound = harness.sent.map((sent) => String(sent.message.content)).join("\n");
    expect(outbound).not.toContain("버튼 문구");
    expect(outbound).not.toContain("동시 주문");
  });

  test("명백한 상태 질문·승인과 체크포인트에 답하는 상태 서술은 local advisory를 만들지 않는다", async () => {
    const harness = createHarness();
    await registerLiveMaker(harness);
    await harness.emit("tool_call", ownerMessage("현재 테스트 결과 알려줘?"));
    await harness.emit("tool_call", ownerMessage("approved: 그 방향으로 진행"));
    expect(harness.sent).toHaveLength(0);

    await harness.emit("message_start", incomingDm("158c0220f80b33f0", "Existing", CHECKPOINT));
    await harness.emit("tool_call", ownerMessage("결과 봤고 그 위치 맞음"));
    expect(harness.sent).toHaveLength(0);
    // 답한 뒤에는 체크포인트가 없으므로 같은 서술도 일반 지시로 안내한다.
    await harness.emit("tool_call", ownerMessage("결과 봤고 그 위치 맞음"));
    expect(harness.judgments).toHaveLength(0);
    expect(harness.sent).toHaveLength(1);
  });

  test("미회신 maker 체크포인트는 다음 wait 전에 한 번 알리고, 수신 뒤 같은 Maker로 간 첫 DM만 답으로 본다", async () => {
    const harness = createHarness();
    await registerLiveMaker(harness, "Parser");
    await registerLiveMaker(harness, "Sheet");
    // 수신 전에 보낸 DM과 agent://all 브로드캐스트는 답이 아니다.
    await harness.emit("tool_call", ownerMessage("approved", "Parser"));
    await harness.emit("tool_result", waitedDm("158c0220f80b33f6", "Parser", CHECKPOINT));
    await harness.emit("message_start", incomingDm("158c02646acb33f7", "Sheet", CHECKPOINT));
    await harness.emit("message_start", incomingDm("158c0269a84b33f8", "Stranger", CHECKPOINT));
    await harness.emit("message_start", {
      type: "message_start",
      message: {
        role: "custom", customType: "irc:incoming", attribution: "agent",
        details: { id: "158c0269a84b33f9", from: "Parser", message: CHECKPOINT, wakeRelay: true },
      },
    });
    await harness.emit("tool_call", ownerMessage("approved", "all"));
    await harness.emit("tool_call", ownerMessage("approved", "Sheet"));
    harness.sent.length = 0;
    await harness.emit("tool_call", waitCall("w2"));
    await harness.emit("tool_call", waitCall("w3"));

    expect(harness.sent).toHaveLength(1);
    const advisory = String(harness.sent[0]!.message.content);
    expect(advisory).toContain("[JevRuntime:pre-wait-unanswered-checkpoint]");
    expect(advisory).toContain("Parser(id=158c0220f80b33f6)");
    expect(advisory).toContain("write agent://");
    expect(advisory).not.toContain("Sheet(");
    expect(advisory).not.toContain("Stranger");
  });

  test("코드·경로·secret 후보는 제외 사실만 local advisory에 남긴다", async () => {
    const harness = createHarness();
    await registerLiveMaker(harness);
    const message = "E:/work/a.ts 범위도 구현해.\n```ts\nconst privateWire = 'do-not-send';\n```\nAuthorization: Bearer secret-token-xyz";
    await harness.emit("tool_call", ownerMessage(message));

    expect(harness.judgments).toHaveLength(0);
    expect(harness.sent).toHaveLength(1);
    const outbound = String(harness.sent[0]!.message.content);
    expect(outbound).toContain("actionSignal=true");
    expect(outbound).toContain("ownedPathOverlap=true");
    expect(outbound).toContain("excludedSensitiveDetail=true");
    expect(outbound).not.toContain("privateWire");
    expect(outbound).not.toContain("secret-token-xyz");
    expect(outbound).not.toContain("E:/work/a.ts");
  });

  test("같은 정규화 지시만 합치고 서로 다른 경로 업무와 구분 불가능 지시는 보존한다", async () => {
    const harness = createHarness();
    await registerLiveMaker(harness);
    await harness.emit("tool_call", ownerMessage("src/a.ts도 고쳐 주세요."));
    await harness.emit("tool_call", ownerMessage("src/a.ts도 고쳐 주세요."));
    await harness.emit("tool_call", ownerMessage("src/b.ts도 고쳐 주세요."));
    await harness.emit("tool_call", ownerMessage("그 부분까지 부탁합니다."));

    expect(harness.judgments).toHaveLength(0);
    expect(harness.sent).toHaveLength(3);
    expect(String(harness.sent[2]!.message.content)).toContain("actionSignal=false");
    expect(String(harness.sent[2]!.message.content)).toContain("scopeSignal=false");
    expect(String(harness.sent[2]!.message.content)).toContain("requestedMeaning");
  });

  test("완료 보고로 live routing에서 닫힌 known Maker도 local advisory 대상이다", async () => {
    const harness = createHarness();
    await registerLiveMaker(harness);
    await harness.emit("message_start", {
      type: "message_start",
      message: {
        role: "custom",
        customType: "async-result",
        attribution: "agent",
        details: { jobs: [{ jobId: "job-Existing", type: "task", status: "completed" }] },
      },
    });
    harness.sent.length = 0;
    await harness.emit("tool_call", ownerMessage("완료한 범위에 회귀 검사를 추가해."));

    expect(harness.judgments).toHaveLength(0);
    expect(harness.sent).toHaveLength(1);
    expect(String(harness.sent[0]!.message.content)).toContain("targetOwner=Existing");
  });

  test("완료 owner 후속 지시는 canonical agentId의 미기록 attempt를 한 번 알리고 기록 뒤에는 멈춘다", async () => {
    const harness = createHarness({
      judgeAnswers: { workClass: { type: "choice", choice: "NORMAL", probabilities: { NORMAL: 1 }, confidence: 1 } },
    });
    await harness.prepare(GUARDED_TASK, "Existing");
    const spawn = taskCall("call-existing", GUARDED_TASK, { name: "Existing", model: "test/local:high" });
    expect(await harness.emit("tool_call", spawn)).toBeUndefined();
    await harness.emit("tool_result", {
      ...spawn, type: "tool_result", isError: false,
      details: { async: { jobId: "job-Existing" }, progress: [{ index: 0, id: "agent-Existing" }] },
    });
    await harness.emit("tool_call", ownerMessage("추가 회귀 검사를 해줘.", "agent-Existing"));
    expect(harness.sent.filter((entry) => String(entry.message.content).includes("명시 판정 미기록"))).toHaveLength(0);
    await harness.emit("message_start", {
      message: { role: "custom", customType: "async-result", details: {
        jobs: [{ jobId: "job-Existing", agentId: "agent-Existing", type: "task", status: "completed" }],
      } },
    });
    harness.sent.length = 0;
    await harness.emit("tool_call", ownerMessage("빠진 증거를 확인해줘.", "agent-Existing"));
    await harness.emit("tool_call", ownerMessage("또 다른 증거도 봐줘.", "agent-Existing"));
    const reminders = harness.sent.filter((entry) => String(entry.message.content).includes("명시 판정 미기록"));
    expect(reminders).toHaveLength(1);
    expect(String(reminders[0]!.message.content)).toContain("session-1|session-1#call-existing#0|session-1#call-existing#0#a1");
    expect(harness.judgments).toHaveLength(1);
    expect((await harness.verdict({
      sessionId: fixtureSession, assignmentId: "session-1#call-existing#0", attemptId: "session-1#call-existing#0#a1",
      verdict: "held", reason: "증거 대기",
    })).details).toMatchObject({ ok: true });
    await harness.emit("tool_call", ownerMessage("검증을 이어가줘.", "agent-Existing"));
    expect(harness.sent.filter((entry) => String(entry.message.content).includes("명시 판정 미기록"))).toHaveLength(1);
    await harness.emit("session_start", { type: "session_start" });
    harness.sent.length = 0;
    await harness.emit("tool_call", ownerMessage("보류 중 추가 증거를 봐줘.", "agent-Existing"));
    expect(harness.sent.filter((entry) => String(entry.message.content).includes("명시 판정 미기록"))).toHaveLength(0);
  });

  test("reload 후 기존 rework는 보존하고 다른 완료 attempt의 누락만 해당 canonical owner에게 알린다", async () => {
    const harness = createHarness({
      judgeAnswers: { workClass: { type: "choice", choice: "NORMAL", probabilities: { NORMAL: 1 }, confidence: 1 } },
    });
    for (const name of ["First", "Second"]) {
      const task = name === "First" ? GUARDED_TASK : GUARDED_TASK.replace("a.ts,b.ts", "c.ts,d.ts");
      await harness.prepare(task, name);
      const spawn = taskCall(`call-${name}`, task, { name, model: "test/local:high" });
      expect(await harness.emit("tool_call", spawn)).toBeUndefined();
      await harness.emit("tool_result", {
        ...spawn, type: "tool_result", isError: false,
        details: { async: { jobId: `job-${name}` }, progress: [{ index: 0, id: `agent-${name}` }] },
      });
    }
    await harness.emit("message_start", {
      message: { role: "custom", customType: "async-result", details: { jobs: [
        { jobId: "job-First", agentId: "agent-First", type: "task", status: "completed" },
        { jobId: "job-Second", agentId: "agent-Second", type: "task", status: "completed" },
      ] } },
    });
    expect((await harness.verdict({
      sessionId: fixtureSession, assignmentId: "session-1#call-First#0", attemptId: "session-1#call-First#0#a1",
      verdict: "rework", revision: "first-r1", evidenceLocators: ["artifact://first"], reason: "실제 결함",
    })).details).toMatchObject({ ok: true });
    await harness.emit("session_start", { type: "session_start" });
    harness.sent.length = 0;
    await harness.emit("tool_call", ownerMessage("후속 확인해줘.", "agent-First"));
    await harness.emit("tool_call", ownerMessage("후속 확인해줘.", "agent-Second"));
    const reminders = harness.sent.filter((entry) => String(entry.message.content).includes("명시 판정 미기록"));
    expect(reminders).toHaveLength(1);
    expect(String(reminders[0]!.message.content)).toContain("session-1#call-Second#0#a1");
    expect(String(reminders[0]!.message.content)).not.toContain("session-1#call-First#0#a1");
  });

  test("새 사용자 입력은 known owner dedupe를 보존하고 서로 다른 지시는 각각 안내한다", async () => {
    const harness = createHarness();
    await registerLiveMaker(harness);
    await harness.emit("message_start", {
      type: "message_start",
      message: {
        role: "custom",
        customType: "async-result",
        attribution: "agent",
        details: { jobs: [{ jobId: "job-Existing", type: "task", status: "completed" }] },
      },
    });
    harness.sent.length = 0;
    await harness.emit("tool_call", ownerMessage("완료 조건을 바꾸고 범위를 추가해."));
    await harness.emit("input", { type: "input", source: "rpc", text: "현재 진행만 알려줘" });
    await harness.emit("tool_call", ownerMessage("완료 조건을 바꾸고 범위를 추가해."));
    await harness.emit("tool_call", ownerMessage("같은 범위에서 회귀 검사까지 추가해."));

    expect(harness.judgments).toHaveLength(0);
    expect(harness.sent).toHaveLength(2);
  });
});

describe("jev-runtime pre-retry", () => {
  const bashCall = (id: string, command: string) => ({
    type: "tool_call",
    toolCallId: id,
    toolName: "bash",
    input: { command },
  });
  const bashError = (
    id: string,
    command: string,
    text: string,
    details?: Record<string, unknown>,
  ) => ({
    type: "tool_result",
    toolCallId: id,
    toolName: "bash",
    input: { command },
    content: [{ type: "text", text }],
    isError: true,
    ...(details ? { details } : {}),
  });

  test("실패 뒤 같은 도구 재호출에서 구조 관측만 한 번 알리고 JEV를 호출하지 않는다", async () => {
    const harness = createHarness();
    await harness.emit("tool_result", bashError("c1", "bun test", "exit code 1", { exitCode: 1 }));
    const result = await harness.emit("tool_call", bashCall("c2", "bun test"));
    expect(result).toBeUndefined();
    expect(harness.judgments).toHaveLength(0);
    expect(harness.sent).toHaveLength(1);
    const advisory = String(harness.sent[0]!.message.content);
    expect(advisory).toContain("tool=bash");
    expect(advisory).toContain("errorCategory=exit-status");
    expect(advisory).toContain("inputChanged=false");
    expect(advisory).toContain("deterministicExitObserved=true");
    expect(advisory).toContain("sameCause, newEvidence");
    expect(advisory).toContain("[JevRuntime:pre-retry]");
  });

  test("toolResult 원문은 advisory에 보내지 않고 카테고리만 보낸다", async () => {
    const harness = createHarness();
    await harness.emit(
      "tool_result",
      bashError("c1", "bun test", "secret-token-xyz exit code 1"),
    );
    await harness.emit("tool_call", bashCall("c2", "bun test"));
    expect(String(harness.sent[0]!.message.content)).not.toContain("secret-token-xyz");
    expect(String(harness.sent[0]!.message.content)).toContain("errorCategory=exit-status");
  });
  test("숫자 부분문자열은 auth가 아니고 HTTP 상태만 auth다", async () => {
    for (const [error, category] of [
      ["ENOENT: C:/missing (wall time 1401ms, pid=4039)", "missing-path"],
      ["HTTP 403 Forbidden", "auth"],
      ["exit code 1401", "exit-status"],
      ["path /tmp/4010-not-found", "other"],
      ["HTTP 403 response not found", "auth"],
      ["pid=403", "other"],
    ]) {
      const harness = createHarness();
      await harness.emit("tool_result", bashError("c1", "probe", error));
      await harness.emit("tool_call", bashCall("c2", "probe"));
      expect(String(harness.sent[0]!.message.content)).toContain(`errorCategory=${category}`);
    }
  });

  test("Windows 셸 오류는 일반 경로·exit 오류보다 먼저 분류하고 로컬 교정을 안내한다", async () => {
    for (const error of [
      "ParserError: foreach( in $items) 식이 없습니다. exit code 1",
      "값 식이 없고 빈 파이프",
      "unterminated backquote",
      "C:Users\\name\\run.ps1 not found",
      "The argument '.cleanup.ps1' to the -File parameter does not exist",
      "pi-natives:command: syntax error",
      "command not found: del",
      "command not found: copy",
      "command not found: findstr",
    ]) {
      const harness = createHarness();
      await harness.emit("tool_result", bashError("c1", "probe", error));
      await harness.emit("tool_call", bashCall("c2", "probe"));
      const advisory = String(harness.sent[0]!.message.content);
      expect(advisory).toContain("errorCategory=windows-shell");
      expect(advisory).toContain("write");
      expect(advisory).toContain("-File");
      expect(advisory).toContain("Remove-Item -LiteralPath");
      expect(advisory).not.toContain(error);
      expect(harness.judgments).toHaveLength(0);
    }
  });

  test("자기 async job이 삭제 leaf 또는 glob prefix를 쥐고 있을 때만 차단한다", async () => {
    const jobs = [{ id: "bash-1", type: "bash", status: "running" }];
    const harness = createHarness({ asyncJobs: jobs });
    const command = "du -sh .cuelo-stage-20260927-*";
    await harness.emit("tool_call", { ...bashCall("run-1", command), input: { command, async: true } });
    await harness.emit("tool_result", {
      type: "tool_result", toolCallId: "run-1", toolName: "bash",
      input: { command, async: true }, isError: false,
      details: { async: { state: "running", jobId: "bash-1", type: "bash" } },
    });
    expect(await harness.emit("tool_call", bashCall("del-1", "rm -rf .cuelo-stage-20260927-145500-1234")))
      .toMatchObject({ block: true, reason: expect.stringContaining("proc://bash-1/kill") });
    expect(await harness.emit("tool_call", bashCall("echo-only", "echo rm -rf .cuelo-stage-20260927-145500-1234")))
      .toBeUndefined();
    expect(await harness.emit("tool_call", bashCall("ps-delete", "powershell -Command \"Remove-Item -LiteralPath '.cuelo-stage-20260927-145500-1234' -Recurse -Force\"")))
      .toMatchObject({ block: true });
    expect(await harness.emit("tool_call", bashCall("del-2", "rm -rf .cuelo-rollback-20260927-145500-1234")))
      .toBeUndefined();
    expect(await harness.emit("tool_call", bashCall("del-3", "powershell -File /tmp/deploy-live.ps1 -CleanupArtifacts -ConfirmCleanup")))
      .toMatchObject({ block: true, reason: expect.stringContaining("bash-1") });
    expect(await harness.emit("tool_call", bashCall("echo-cleanup", "echo deploy-live.ps1 -CleanupArtifacts -ConfirmCleanup")))
      .toBeUndefined();
    expect(await harness.emit("tool_call", bashCall("del-3b", "rm -rf .omp-web-rollback-20260927-145500-1234")))
      .toBeUndefined();
    await harness.emit("tool_result", {
      type: "tool_result", toolCallId: "kill-1", toolName: "write",
      input: { path: "proc://bash-1/kill" }, isError: false,
      details: { proc: { op: "cancel", cancelled: [{ id: "bash-1", status: "cancelled" }] } },
    });
    expect(await harness.emit("tool_call", bashCall("del-after-kill", "rm -rf .cuelo-stage-20260927-145500-1234")))
      .toBeUndefined();
    jobs.splice(0);
    expect(await harness.emit("tool_call", bashCall("del-4", "rm -rf .cuelo-stage-20260927-145500-1234")))
      .toBeUndefined();
    expect(harness.judgments).toHaveLength(0);
  });

  test("실제 du stage·rollback glob이 승인 정리와 겹치고 무관 폴더는 막지 않는다", async () => {
    const harness = createHarness({ asyncJobs: [{ id: "bash-du", type: "bash", status: "running" }] });
    const command = "du -sh .cuelo-* .omp-web-*";
    await harness.emit("tool_call", { ...bashCall("du", command), input: { command, async: true } });
    await harness.emit("tool_result", {
      type: "tool_result", toolCallId: "du", toolName: "bash",
      input: { command, async: true }, isError: false,
      details: { async: { state: "running", jobId: "bash-du", type: "bash" } },
    });
    expect(await harness.emit("tool_call", bashCall("cleanup", "powershell -File F:/CUELO/Tools/CUELO_Setup/deploy-live.ps1 -CleanupArtifacts -ConfirmCleanup")))
      .toMatchObject({ block: true, reason: expect.stringContaining("bash-du") });
    expect(await harness.emit("tool_call", bashCall("other", "rm -rf /tmp/independent")))
      .toBeUndefined();
  });

  test("name 서비스의 점유는 종료 관측 뒤 풀고 unrelated·dry-run은 통과한다", async () => {
    const harness = createHarness();
    const command = "bun run dev --dir /tmp/build-assets";
    await harness.emit("tool_call", {
      ...bashCall("svc-1", command), input: { command, name: "my-dev" },
    });
    await harness.emit("tool_result", {
      type: "tool_result", toolCallId: "svc-1", toolName: "bash",
      input: { command, name: "my-dev" }, isError: false,
      details: { service: { name: "my-dev", state: "ready" } },
    });
    expect(await harness.emit("tool_call", bashCall("del-a", "Remove-Item -LiteralPath /tmp/build-assets -Recurse -Force")))
      .toMatchObject({ block: true, reason: expect.stringContaining("proc://my-dev/kill") });
    expect(await harness.emit("tool_call", bashCall("del-b", "rmdir /tmp/build-other")))
      .toBeUndefined();
    expect(await harness.emit("tool_call", bashCall("dry", "powershell -File /tmp/deploy-live.ps1 -CleanupArtifacts")))
      .toBeUndefined();
    await harness.emit("tool_result", {
      type: "tool_result", toolCallId: "read-stopping", toolName: "read",
      input: { path: "proc://my-dev" }, isError: false,
      details: { proc: { daemon: { name: "my-dev", state: "stopping" } } },
    });
    expect(await harness.emit("tool_call", bashCall("del-stopping", "rd /s /q /tmp/build-assets")))
      .toMatchObject({ block: true });
    await harness.emit("tool_result", {
      type: "tool_result", toolCallId: "read-svc", toolName: "read",
      input: { path: "proc://my-dev" }, isError: false,
      details: { proc: { daemon: { name: "my-dev", state: "exited" } } },
    });
    expect(await harness.emit("tool_call", bashCall("del-c", "rd /s /q /tmp/build-assets")))
      .toBeUndefined();
  });

  test("proc:// 목록에서 서비스 종료가 관측되면 점유 기록을 푼다", async () => {
    const harness = createHarness();
    const command = "bun run dev --dir /tmp/build-assets";
    await harness.emit("tool_call", { ...bashCall("svc", command), input: { command, name: "my-dev" } });
    await harness.emit("tool_result", {
      toolCallId: "svc", toolName: "bash", isError: false,
      details: { service: { name: "my-dev", state: "ready" } },
    });
    const removal = bashCall("del", "rm -rf /tmp/build-assets");
    expect(await harness.emit("tool_call", removal)).toMatchObject({ block: true });
    await harness.emit("tool_result", {
      toolCallId: "list", toolName: "read", isError: false,
      input: { path: "proc://" }, details: { proc: { daemons: [] } },
    });
    expect(await harness.emit("tool_call", removal)).toBeUndefined();
  });

  test("취소 원문만 있고 terminal exit 근거가 없으면 회수 또는 한 변수 확인을 지시한다", async () => {
    const harness = createHarness();
    await harness.emit("tool_result", bashError("c1", "bun test", "Command aborted"));
    await harness.emit("tool_call", bashCall("c2", "bun test"));
    const advisory = String(harness.sent[0]!.message.content);
    expect(advisory).toContain("cancelled=true");
    expect(advisory).toContain("deterministicExitObserved=false");
    expect(String(harness.sent[0]!.message.content)).toContain("취소 근거 없음");
    expect(String(harness.sent[0]!.message.content)).toContain("실행 결과 회수 또는 다음 한 변수 확인");
  });

  test("같은 실패→재시도 경계는 한 번만 판정하고, 새 실패는 새 경계다", async () => {
    const harness = createHarness();
    await harness.emit("tool_result", bashError("c1", "bun test", "exit code 1"));
    await harness.emit("tool_call", bashCall("c2", "bun test"));
    await harness.emit("tool_call", bashCall("c3", "bun test"));
    // 경계는 c2에서 소비됐으므로 c3은 판정하지 않는다.
    expect(harness.sent).toHaveLength(1);
    // c3의 실패는 새 경계를 만든다.
    await harness.emit("tool_result", bashError("c3", "bun test", "exit code 1"));
    await harness.emit("tool_call", bashCall("c4", "bun test"));
    expect(harness.sent).toHaveLength(2);
  });

  test("실패 뒤 다른 도구 호출은 경계를 소비하지 않고 interveningTools로 남는다", async () => {
    const harness = createHarness();
    await harness.emit("tool_result", bashError("c1", "bun test", "exit code 1"));
    // read로 조사한 뒤 같은 도구를 재시도하는 경계가 유지돼야 한다.
    await harness.emit("tool_call", {
      type: "tool_call",
      toolCallId: "c2",
      toolName: "read",
      input: { path: "src/x.ts" },
    });
    await harness.emit("tool_result", {
      type: "tool_result",
      toolCallId: "c2",
      toolName: "read",
      input: { path: "src/x.ts" },
      content: [{ type: "text", text: "file body" }],
      isError: false,
    });
    await harness.emit("tool_call", bashCall("c3", "bun test"));
    expect(harness.sent).toHaveLength(1);
    expect(String(harness.sent[0]!.message.content)).toContain("interveningTools=read");
  });

  test("같은 도구의 성공은 실패 문맥을 닫는다", async () => {
    const harness = createHarness();
    await harness.emit("tool_result", bashError("c1", "bun test", "exit code 1"));
    await harness.emit("tool_call", bashCall("c2", "bun test --fix"));
    await harness.emit("tool_result", {
      type: "tool_result",
      toolCallId: "c2",
      toolName: "bash",
      input: { command: "bun test --fix" },
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });
    // 성공으로 문맥이 닫혔으므로 다음 bash 호출은 재시도 경계가 아니다.
    await harness.emit("tool_call", bashCall("c3", "bun test"));
    expect(harness.sent).toHaveLength(1);
  });

  test("agent 귀속 user 메시지는 재시도 문맥을 끊지 않는다", async () => {
    const harness = createHarness();
    await harness.emit("tool_result", bashError("c1", "bun test", "exit code 1"));
    await harness.emit("message_start", {
      type: "message_start",
      message: { role: "user", attribution: "agent", content: "auto" },
    });
    await harness.emit("tool_call", bashCall("c2", "bun test"));
    expect(harness.sent).toHaveLength(1);
  });

  test("독립 실패 둘은 도구별로 보존되어 각각 재시도 경계를 만든다", async () => {
    const harness = createHarness();
    await harness.emit("tool_result", bashError("c1", "bun test", "exit code 1"));
    // edit 실패가 bash 실패를 지우지 않는다.
    await harness.emit("tool_result", {
      type: "tool_result",
      toolCallId: "c2",
      toolName: "edit",
      input: { input: "x" },
      content: [{ type: "text", text: "permission denied" }],
      isError: true,
    });
    await harness.emit("tool_call", bashCall("c3", "bun test"));
    expect(harness.sent).toHaveLength(1);
    expect(String(harness.sent[0]!.message.content)).toContain("tool=bash");
    expect(String(harness.sent[0]!.message.content)).toContain("interveningTools=edit");
    // edit 재시도도 독립 경계로 판정한다.
    await harness.emit("tool_call", {
      type: "tool_call",
      toolCallId: "c4",
      toolName: "edit",
      input: { input: "x" },
    });
    expect(harness.sent).toHaveLength(2);
    expect(String(harness.sent[1]!.message.content)).toContain("tool=edit");
  });

  test("실패 뒤 다른 도구 호출은 재시도 경계가 아니다", async () => {
    const harness = createHarness();
    await harness.emit("tool_result", bashError("c1", "bun test", "exit code 1"));
    await harness.emit("tool_call", {
      type: "tool_call",
      toolCallId: "c2",
      toolName: "edit",
      input: { input: "x" },
    });
    expect(harness.judgments).toHaveLength(0);
    expect(harness.sent).toHaveLength(0);
  });

  test("탐색 도구 실패는 재시도 판정을 세우지 않는다", async () => {
    const harness = createHarness();
    await harness.emit("tool_result", {
      type: "tool_result",
      toolCallId: "c1",
      toolName: "read",
      input: { path: "missing.ts" },
      content: [{ type: "text", text: "ENOENT: no such file" }],
      isError: true,
    });
    await harness.emit("tool_call", {
      type: "tool_call",
      toolCallId: "c2",
      toolName: "read",
      input: { path: "missing.ts" },
    });
    expect(harness.judgments).toHaveLength(0);
  });

  test("running job을 결과 없이 취소하려 하면 결정론 advisory만 한 번 보낸다", async () => {
    const harness = createHarness({
      asyncJobs: [{ id: "bash-running", type: "bash", status: "running" }],
    });
    const event = {
      type: "tool_call",
      toolCallId: "cancel-1",
      toolName: "write",
      input: { path: "proc://bash-running/kill" },
    };
    await harness.emit("tool_call", event);
    await harness.emit("tool_call", { ...event, toolCallId: "cancel-2" });
    expect(harness.judgments).toHaveLength(0);
    expect(harness.sent).toHaveLength(1);
    expect(String(harness.sent[0]!.message.content)).toContain("취소 근거 없음: 실행 결과 회수 또는 다음 한 변수 확인");
    expect(String(harness.sent[0]!.message.content)).toContain("stdout 침묵·낮은 CPU·elapsed만으로 stall을 확정하지 않는다");
  });

  test("사람의 새 입력은 재시도 문맥을 끊는다", async () => {
    const harness = createHarness();
    await harness.emit("tool_result", bashError("c1", "bun test", "exit code 1"));
    await harness.emit("message_start", {
      type: "message_start",
      message: { role: "user", steering: true, content: "다른 걸 해" },
    });
    await harness.emit("tool_call", bashCall("c2", "bun test"));
    expect(harness.judgments).toHaveLength(0);
  });
});

describe("jev-runtime pre-review", () => {
  const asyncResult = (jobId: string, extra: Record<string, unknown> = {}) => ({
    type: "message_start",
    message: {
      role: "custom",
      customType: "async-result",
      attribution: "agent",
      details: {
        jobs: [
          {
            jobId,
            type: "task",
            status: "completed",
            label: "Maker",
            schema: { status: "valid", data: { validation: {}, changed_paths: [] } },
            ...extra,
          },
        ],
      },
    },
  });

  const todoResult = (
    input: Record<string, unknown>,
    tasks: Array<{ content: string; status: string }>,
  ) => ({
    type: "tool_result",
    toolCallId: "todo-result",
    toolName: "todo",
    input,
    content: [{ type: "text", text: "todo updated" }],
    isError: false,
    details: { phases: [{ name: "구현", tasks }] },
  });

  test("async-result의 settled task job에서 한 번 판정한다", async () => {
    const harness = createHarness();
    await harness.emit("message_start", asyncResult("job-1"));
    expect(harness.judgments).toHaveLength(0);
    expect(String(harness.sent[0]!.message.content)).toContain("[JevRuntime:pre-review]");
    const report = structuralReports(harness.sent)[0]!;
    expect(report.jobId).toBe("job-1");
    expect(report.normalCount).toBe(4);
    expect(report.terminalRevisionPresent).toBe(false);
    expect(report).not.toHaveProperty("dataKeys");
    // validation 맵이 비어 있으면 미관측이므로 null이다.
    expect(report.unverifiedCount).toBeNull();
    expect(report.unresolvedCount).toBeNull();
  });
  test("구조 요약은 관측된 0과 미관측 null을 구분하고 job detail locator를 보존한다", async () => {
    const unobserved = createHarness();
    await unobserved.emit("message_start", asyncResult("job-null"));
    const unobservedAdvisory = String(unobserved.sent[0]!.message.content);
    expect(unobservedAdvisory).toContain("unverified=미관측(1건:job-null)");
    expect(unobservedAdvisory).toContain("unresolved=미관측(1건:job-null)");
    expect(unobservedAdvisory).toContain("\"locator\":\"job-null\"");
    expect(unobservedAdvisory).not.toContain("structuralReports=");

    const observed = createHarness();
    await observed.emit("message_start", asyncResult("job-zero", {
      schema: {
        status: "valid",
        data: {
          revision: "rev-zero",
          changed_paths: [],
          unresolved: [],
          validation: {
            focused: { state: "met", evidence_locator: "artifact://focused-zero" },
          },
        },
      },
    }));
    const observedAdvisory = String(observed.sent[0]!.message.content);
    expect(observedAdvisory).toContain("unverified=0");
    expect(observedAdvisory).toContain("unresolved=0");
    expect(observedAdvisory).toContain("\"normalCount\":");
    expect(observedAdvisory).toContain("\"evidenceLocators\":[\"artifact://focused-zero\"]");
    expect(observedAdvisory).not.toContain("\"unverifiedCount\":0");
    expect(observedAdvisory).not.toContain("\"unresolvedCount\":0");
    expect(observedAdvisory).not.toContain("\"dataKeys\"");
    expect(observedAdvisory).not.toContain("\"changed_paths\"");
  });


  test("부정·질문·인용·approved marker는 검증 권한 상태나 실행 advisory를 만들지 않는다", async () => {
    const harness = createHarness();
    await harness.emit("tool_result", todoResult(
      { op: "init" },
      [
        { content: "stable title 구현", status: "in_progress" },
        { content: "focused 검증", status: "pending" },
      ],
    ));
    await registerLiveMaker(harness, "ProgressVisibility", PROGRESS_TASK);
    const messages = [
      "focused 검증을 허용한 건 아니지?",
      "focused 검증을 실행하지 마.",
      "> focused 검증 허용: 실행해.",
      "approved: focused 검증",
    ];
    for (const [index, message] of messages.entries()) {
      await harness.emit("tool_call", {
        type: "tool_call",
        toolCallId: `permission-false-positive-${index}`,
        toolName: "write",
        input: { path: "agent://ProgressVisibility", content: message },
      });
    }
    const ownerAdvisories = harness.sent.map((entry) => String(entry.message.content)).join("\n");
    expect(ownerAdvisories).not.toContain("exact 허용");
    expect(ownerAdvisories).not.toContain("initial hold보다");
    expect(harness.judgments).toHaveLength(0);
    harness.sent.length = 0;

    await harness.emit("message_start", asyncResult("job-ProgressVisibility", {
      schema: {
        status: "valid",
        data: {
          revision: "rev-no-permission-inference",
          changed_paths: ["a.ts"],
          unresolved: [],
          validation: {
            "stable title 구현": {
              state: "met",
              evidence_locator: "artifact://progress/stable-title.log",
            },
            "focused 검증": {
              state: "unverified",
              blocker: "focused 검증은 승인 대기 중",
              approved: true,
            },
          },
        },
      },
    }));
    const advisory = String(harness.sent[0]!.message.content);
    expect(advisory).not.toContain("검증 허용 충돌");
    expect(advisory).not.toContain("todoPermissionConflictCount");
    expect(advisory).toContain("artifact://progress/stable-title.log");
    expect(advisory).toContain("\"focused 검증\": exact terminal validation이 없거나 미검증");
  });

  test("Main 직접 DM은 원문 write agent:// call을 차단하지 않고 자동 허용 상태도 만들지 않는다", async () => {
    const harness = createHarness();
    await registerLiveMaker(harness, "ProgressVisibility", PROGRESS_TASK);
    const result = await harness.emit("tool_call", {
      type: "tool_call",
      toolCallId: "main-exact-focused-command",
      toolName: "write",
      input: {
        path: "agent://ProgressVisibility",
        content: "focused 검증 명령 `bun test agent/extensions/tests/task-progress.test.ts`을 실행하세요.",
      },
    });
    expect(result).toBeUndefined();
    const advisory = harness.sent.map((entry) => String(entry.message.content)).join("\n");
    expect(advisory).toContain("requestedMeaning");
    expect(advisory).toContain("unknown");
    expect(advisory).not.toContain("exact 허용");
    expect(advisory).not.toContain("initial hold보다");
  });

  test("child 완료 상태만으로 Main 수용하지 않고 성공한 exact todo done receipt만 센다", async () => {
    const terminal = {
      schema: {
        status: "valid",
        data: {
          revision: "rev-accept-1",
          changed_paths: ["a.ts"],
          unresolved: [],
          validation: {
            "stable title 구현": {
              state: "met",
              evidence: "artifact://progress/stable-title.log",
            },
            "focused 검증": {
              state: "met",
              evidence: "artifact://progress/focused.log",
            },
          },
        },
      },
    };

    const lifecycleOnly = createHarness();
    await lifecycleOnly.emit("tool_result", todoResult(
      { op: "init" },
      [
        { content: "stable title 구현", status: "in_progress" },
        { content: "focused 검증", status: "in_progress" },
      ],
    ));
    await registerLiveMaker(lifecycleOnly, "ProgressVisibility", PROGRESS_TASK);
    await lifecycleOnly.emit("tool_result", todoResult(
      { op: "view" },
      [
        { content: "stable title 구현", status: "completed" },
        { content: "focused 검증", status: "in_progress" },
      ],
    ));
    await lifecycleOnly.emit("message_start", asyncResult("job-ProgressVisibility", terminal));
    const lifecycleReport = structuralReports(lifecycleOnly.sent)[0]!;
    expect(lifecycleReport).not.toHaveProperty("todoMainAcceptedCount");
    expect(lifecycleReport).not.toHaveProperty("todoReadyForMainAcceptanceCount");
    expect(lifecycleReport.todoUnattributedCompletedCount).toBe(1);
    expect(String(lifecycleOnly.sent[0]!.message.content)).toContain("Main 수용 후보=1");

    const explicitDone = createHarness();
    await explicitDone.emit("tool_result", todoResult(
      { op: "init" },
      [
        { content: "stable title 구현", status: "in_progress" },
        { content: "focused 검증", status: "in_progress" },
      ],
    ));
    await registerLiveMaker(explicitDone, "ProgressVisibility", PROGRESS_TASK);
    await explicitDone.emit("tool_result", todoResult(
      { op: "done", task: "stable title 구현" },
      [
        { content: "stable title 구현", status: "completed" },
        { content: "focused 검증", status: "in_progress" },
      ],
    ));
    await explicitDone.emit("message_start", asyncResult("job-ProgressVisibility", terminal));
    const acceptedReport = structuralReports(explicitDone.sent)[0]!;
    expect(acceptedReport).not.toHaveProperty("todoMainAcceptedCount");
    expect(acceptedReport).not.toHaveProperty("todoUnattributedCompletedCount");
    expect(String(explicitDone.sent[0]!.message.content))
      .toContain("\"stable title 구현\": Main의 explicit todo done 수용");
  });

  test("같은 문구 init 계획교체 뒤 늦은 child 결과를 새 TODO에 연결하지 않는다", async () => {
    const harness = createHarness();
    const tasks = [
      { content: "stable title 구현", status: "in_progress" },
      { content: "focused 검증", status: "pending" },
    ];
    await harness.emit("tool_result", todoResult({ op: "init" }, tasks));
    await registerLiveMaker(harness, "ProgressVisibility", PROGRESS_TASK);
    await harness.emit("tool_result", todoResult({ op: "init" }, tasks));
    await harness.emit("message_start", asyncResult("job-ProgressVisibility", {
      schema: {
        status: "valid",
        data: {
          revision: "rev-late-1",
          changed_paths: ["a.ts"],
          unresolved: [],
          validation: {
            "stable title 구현": { state: "met", evidence: "artifact://old-child/stable" },
            "focused 검증": { state: "met", evidence: "artifact://old-child/focused" },
          },
        },
      },
    }));
    const report = structuralReports(harness.sent)[0]!;
    expect(report.todoStaleBindingCount).toBe(2);
    expect(report).not.toHaveProperty("todoReadyForMainAcceptanceCount");
    expect(String(harness.sent[0]!.message.content)).toContain("Main 수용 후보=0");
    const advisory = String(harness.sent[0]!.message.content);
    expect(advisory).toContain("늦은 child 결과");
    expect(advisory).not.toContain("확인·추가");
  });

  test("state 없는 validation 항목은 미확인으로 보존한다", async () => {
    const harness = createHarness();
    await harness.emit("message_start", {
      type: "message_start",
      message: {
        role: "custom",
        customType: "async-result",
        attribution: "agent",
        details: {
          jobs: [
            {
              jobId: "job-x",
              type: "task",
              status: "completed",
              schema: {
                status: "valid",
                data: {
                  validation: { build: { state: "met" }, lint: { note: "ran" } },
                  unresolved: ["a"],
                },
              },
            },
          ],
        },
      },
    });
    const report = structuralReports(harness.sent)[0]!;
    // state:"met"만 있고 evidence locator가 없는 항목과 형식 불명 항목 모두 미확인이다.
    expect(report.unverifiedCount).toBe(2);
    expect(report.unresolvedCount).toBe(1);
  });

  test("같은 jobId는 async-result와 read proc:// 경로에서 중복 판정하지 않는다", async () => {
    const harness = createHarness();
    const procRead = (id: string, path: string, proc: Record<string, unknown>) => ({
      type: "tool_result",
      toolCallId: id,
      toolName: "read",
      input: { path },
      content: [{ type: "text", text: "done" }],
      isError: false,
      details: { proc },
    });
    await harness.emit("message_start", asyncResult("job-1"));
    await harness.emit("tool_result", procRead("r1", "proc://", {
      jobs: [{ id: "job-1", type: "task", status: "completed", label: "Maker" }],
    }));
    expect(harness.sent).toHaveLength(1);
    // 단건 read proc://<id>는 details.proc.job 하나로 온다.
    await harness.emit("tool_result", procRead("r2", "proc://job-2", {
      job: { id: "job-2", type: "task", status: "completed", label: "Maker" },
    }));
    expect(harness.sent).toHaveLength(2);
    expect(String(harness.sent[1]!.message.content)).toContain("via=read proc://");
    // proc://가 아닌 read는 같은 모양의 details가 있어도 경계가 아니다.
    await harness.emit("tool_result", procRead("r3", "notes/proc.md", {
      job: { id: "job-3", type: "task", status: "completed", label: "Maker" },
    }));
    expect(harness.judgments).toHaveLength(0);
    expect(harness.sent).toHaveLength(2);
  });

  test("wait가 먼저 settled 결과를 회수해도 같은 dedupe로 판정한다", async () => {
    const harness = createHarness();
    await harness.emit("tool_result", {
      type: "tool_result",
      toolCallId: "h1",
      toolName: "wait",
      input: {},
      content: [{ type: "text", text: "done" }],
      isError: false,
      details: {
        jobs: [
          {
            id: "job-9",
            type: "task",
            status: "completed",
            label: "Maker",
            structured: { status: "invalid", error: "schema mismatch" },
          },
        ],
      },
    });
    expect(harness.judgments).toHaveLength(0);
    expect(harness.sent).toHaveLength(1);
    const report = structuralReports(harness.sent)[0]!;
    expect(report.jobId).toBe("job-9");
    expect(report.schemaStatus).toBe("invalid");
    expect(report.hasError).toBe(true);
    // 이후 async-result 재전달은 같은 jobId라 무시한다.
    await harness.emit("message_start", asyncResult("job-9"));
    expect(harness.sent).toHaveLength(1);
  });

  test("running job과 task가 아닌 job은 판정하지 않는다", async () => {
    const harness = createHarness();
    await harness.emit("message_start", {
      type: "message_start",
      message: {
        role: "custom",
        customType: "async-result",
        attribution: "agent",
        details: {
          jobs: [
            { jobId: "j1", type: "task", status: "running" },
            { jobId: "j2", type: "bash", status: "completed" },
          ],
        },
      },
    });
    expect(harness.judgments).toHaveLength(0);
    expect(harness.sent).toHaveLength(0);
  });

  test("자기 advisory 메시지는 재귀하지 않는다", async () => {
    const harness = createHarness();
    await harness.emit("message_start", {
      type: "message_start",
      message: {
        role: "custom",
        customType: "jev-runtime-advisory",
        content: "[JevRuntime:pre-review] ...",
      },
    });
    expect(harness.judgments).toHaveLength(0);
    expect(harness.sent).toHaveLength(0);
  });
});

describe("jev-runtime fail-open과 세션 격리", () => {
  test("judge 해석 오류와 timeout은 Main 결정이 가능한 unavailable로 돌려준다", async () => {
    for (const options of [{ resolveError: "Cannot find module" }, { judgeError: "TimeoutError" }]) {
      const harness = createHarness(options);
      const result = await harness.prepare();
      expect(result.details.routes[0].status).toBe("unavailable");
      expect(result.details.routes[0].recommendations).toBeNull();
    }
  });

  test("batch 중 한 child만 settle돼도 sibling maker는 live로 남는다", async () => {
    const harness = createHarness({ asyncJobs: [{ id: "job-1", agentId: "agent-1" }, { id: "job-2", agentId: "agent-2" }] });
    const multiTask = { tasks: [{ task: GUARDED_TASK }, { task: GUARDED_TASK }] };
    await harness.emit("tool_result", {
      type: "tool_result",
      toolCallId: "call-1",
      toolName: "task",
      input: multiTask,
      content: [{ type: "text", text: "spawned" }],
      isError: false,
      details: {
        // 실제 wire: primary jobId는 details.async.jobId이고 canonical agentId는 progress row에 있다.
        async: { jobId: "job-1" },
        progress: [
          { index: 0, id: "agent-1", status: "running" },
          { index: 1, id: "agent-2", status: "running" },
        ],
      },
    });
    // job-1만 settle → job-2는 live로 남아 다음 dispatch의 existingMakers에 보인다.
    await harness.emit("message_start", {
      type: "message_start",
      message: {
        role: "custom",
        customType: "async-result",
        attribution: "agent",
        details: { jobs: [{ jobId: "job-1", agentId: "agent-1", type: "task", status: "completed" }] },
      },
    });
    await harness.prepare();
    const second = harness.judgments.at(-1)!;
    expect((second.state.existingOwners as unknown[]).length).toBe(1);
  });

  test("settled known owner는 재개 후보로 남고 다른 active 경로 owner는 placement 후보에서 빠진다", async () => {
    const harness = createHarness();
    const policyTask = GUARDED_TASK.replace("a.ts,b.ts", "policy.ts");
    const snapshotTask = GUARDED_TASK.replace("a.ts,b.ts", "snapshot.ts");
    await registerLiveMaker(harness, "PolicyScope", policyTask);
    await harness.emit("message_start", {
      type: "message_start",
      message: {
        role: "custom",
        customType: "async-result",
        attribution: "agent",
        details: { jobs: [{ jobId: "job-PolicyScope", type: "task", status: "completed" }] },
      },
    });
    await registerLiveMaker(harness, "SnapshotAsync", snapshotTask);
    harness.judgments.length = 0;

    await harness.prepare(policyTask, "PolicyRework");
    expect(harness.judgments).toHaveLength(1);
    const existingOwners = harness.judgments[0]!.state.existingOwners as Array<Record<string, unknown>>;
    expect(existingOwners).toEqual([{
      owner: 0,
      name: "PolicyScope",
      goal: "x",
      ownedPaths: ["policy.ts"],
    }]);
  });

  test("child 세션의 pre-retry는 그 세션의 advisory로만 간다", async () => {
    // extension은 세션마다 rebuild되므로 두 인스턴스가 서로의 상태를 공유하지 않는다.
    const parent = createHarness();
    const child = createHarness();
    await child.emit("tool_result", {
      type: "tool_result",
      toolCallId: "c1",
      toolName: "bash",
      input: { command: "bun test" },
      content: [{ type: "text", text: "exit code 1" }],
      isError: true,
    });
    await child.emit("tool_call", {
      type: "tool_call",
      toolCallId: "c2",
      toolName: "bash",
      input: { command: "bun test" },
    });
    expect(child.judgments).toHaveLength(0);
    expect(child.sent).toHaveLength(1);
    // 부모 세션에는 아무 판정도 전달되지 않는다.
    expect(parent.judgments).toHaveLength(0);
    expect(parent.sent).toHaveLength(0);
  });
});
