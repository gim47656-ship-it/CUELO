import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRoutingPolicy, registerMakerRouting, routingQuestions, routingState, type Owner, type QuotaSnapshot, type RoutingDeps, type RoutingFacts } from "../lib/maker-routing";
import { bindTaskGuardSession, createTaskGuardState, noteUserRequestText, releaseCancelledSpawns, reserveTaskCall, settleTaskCall, unbindTaskGuardSession, type TaskGuardState } from "../command-guard/task-guard";
import { resolvePreparedTaskInput } from "../lib/prepared-task";
import type { LedgerRecord, RoutingLedger } from "../lib/routing-ledger";
import { loadRequiredSkillContract, parseRequiredSkillContract } from "../lib/skill-evidence";

// 캐릭터 summon marker의 oauth-position은 PC 설정(`config.yml` `characterSeats`)에서 온다(2026-11-06).
// 이 파일은 그 값을 결정적으로 보도록 격리 agent dir에 좌석을 심는다(빈 dir인 CI에서 marker가 달라지지 않게).
const realAgentDir = process.env.PI_CODING_AGENT_DIR;
const isolatedAgentDir = mkdtempSync(join(tmpdir(), "maker-routing-agent-"));
// 준비와 복원을 한 try에 묶는다. 준비가 실패하면 즉시 되돌리고 다시 던져, 임시 dir와 env가 남지 않게 한다
// (afterAll은 모듈 로드 실패 시 불리지 않는다). 성공했을 때만 러너의 afterAll에 복원을 맡긴다.
try {
  writeFileSync(join(isolatedAgentDir, "config.yml"), 'characterSeats:\n  "RIN(린)": 0\n  "MIO(미오)": 1\n', "utf8");
} catch (error) {
  // 이 시점에 env는 아직 바꾸지 않았다. 임시 dir만 지우고 다시 던진다(env를 되돌리면 미설정이 "undefined"가 된다).
  rmSync(isolatedAgentDir, { recursive: true, force: true });
  throw error;
}
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
afterAll(() => {
  if (realAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = realAgentDir;
  rmSync(isolatedAgentDir, { recursive: true, force: true });
});

const facts: RoutingFacts = {
  goal: "상태 표시 오류 수정", acceptance: ["오류 경로 정상 표시"], facts: ["한 화면에서 재현됨"],
  hypotheses: ["갱신 시점 누락"], unknowns: ["어느 단계에서 값이 바뀌는지"], paths: ["src/view.ts"],
  callBoundaries: ["상태 저장소 → 표시"], settledImplementation: null, reusedPatterns: ["src/other.ts:20"],
  remainingJudgments: ["입력부터 표시까지 원인 추적"], invariants: ["정상 상태 표시 유지"], checks: ["오류 재현 실행"], failureEvidence: null,
};
const brief = "TASK_GUARD:\nWORK_CLASS: maintenance\nPRIMARY_DELIVERABLE: 표시 오류 수정\nOWNED_PATHS: src/view.ts\n\n구현 원문은 Jev에 보내지 않는다.";
const reworkTaskBrief = brief.replace("OWNED_PATHS:", "FINDING_ID: f-1\nOWNED_PATHS:");
const allStrengths = ["low", "medium", "high", "xhigh", "max"];
const SONNET = "anthropic/claude-sonnet-5-5";
const OPUS = "anthropic/claude-opus-5-5";
const DEEPSEEK = "hive/deepseek-ai/deepseek-v4.1-flash-1017";
const candidates = [
  { profile: "NORMAL_SONNET", model: SONNET, efforts: allStrengths },
  { profile: "NORMAL_OPUS", model: "anthropic/claude-opus-5-5", efforts: allStrengths },
  { profile: "HARD_UI_OPUS", model: "anthropic/claude-opus-5-5", efforts: allStrengths },
  { profile: "HARD_CODE_OPUS", model: "anthropic/claude-opus-5-5", efforts: allStrengths },
  { profile: "HARD_CODE_SONNET", model: SONNET, efforts: allStrengths },
  { profile: "HARD_UI_SONNET", model: SONNET, efforts: allStrengths },
  { profile: "NORMAL_DEEPSEEK", model: DEEPSEEK, efforts: allStrengths },
  { profile: "HARD_CODE_DEEPSEEK", model: DEEPSEEK, efforts: allStrengths },
  { profile: "NORMAL_SOL", model: "openai-codex/gpt-6.1-sol", efforts: allStrengths },
  { profile: "HARD_CODE_TERRA", model: "openai-codex/gpt-6.1-sol", efforts: allStrengths },
  { profile: "HARD_CODE_SOL61", model: "openai-codex/gpt-6.1-sol", efforts: allStrengths },
];
const without = (...profiles: string[]) => candidates.filter((candidate) => !profiles.includes(candidate.profile));
/** 후보·Main 모델의 계열. 코어 `ctx.models.family`(=`model.identity.class`)를 대신하는 하네스 fixture다. */
const families: Record<string, string> = {
  "openai-codex/gpt-6-sol": "openai",
  "openai-codex/gpt-6.1-sol": "openai",
  "anthropic/claude-opus-5-5": "anthropic",
  [SONNET]: "anthropic",
  [DEEPSEEK]: "unknown",
};
/** 메모리 ledger. 파일 경로 없이 기록·요약 경로를 본다. */
function memoryLedger(initial: LedgerRecord[] = []): RoutingLedger & { records: LedgerRecord[] } {
  const records = [...initial];
  return { records, append: (record) => { records.push(record); }, read: () => [...records] };
}
const CODEX_MAIN = { provider: "openai-codex", id: "gpt-6-sol" };
const ANTHROPIC_MAIN = { provider: "anthropic", id: "claude-opus-5-5" };
let nextHarnessSession = 0;
/**
 * 실제 task 호출은 core schema의 필수 solutionSpace를 싣는다. 이 파일의 발주 fixture는 그 필드가 관심사가 아니라서
 * 빠진 항목에만 채운다. 키를 명시한 입력(undefined 포함)은 그대로 둬 공백·누락 거절을 시험할 수 있다.
 */
function withSolutionSpace(input: Record<string, unknown>): Record<string, unknown> {
  const fill = (item: unknown) => item && typeof item === "object" && !("solutionSpace" in item)
    ? { ...(item as Record<string, unknown>), solutionSpace: "one fix: settled" }
    : item;
  return Array.isArray(input.tasks) ? { ...input, tasks: input.tasks.map(fill) } : fill(input) as Record<string, unknown>;
}

function harness(options: {
  fail?: boolean;
  failCalls?: number[];
  duplicate?: number;
  additional?: number;
  ownerTarget?: string;
  workClass?: string;
  workClasses?: string[];
  /** Jev workClass choice의 confidence. 주면 선택 등급에 그 확률, 나머지 등급에 1-그 값을 싣는다. */
  workClassConfidence?: number;
  hardFocuses?: string[];
  uiUxBoundary?: number;
  candidates?: typeof candidates;
  main?: { provider: string; id: string } | null;
  families?: Record<string, string>;
  candidateGate?: Promise<void>;
  candidateGateOnCall?: number;
  onCandidate?: (call: number) => void;
  judgeGate?: Promise<void>;
  judgeGateOnCall?: number;
  onJudge?: () => void;
  quota?: (providers: string[], signal?: AbortSignal) => Promise<QuotaSnapshot>;
  clock?: () => number;
  ledger?: RoutingLedger;
  delegation?: string;
  /** Jev의 designOpen 확률. 기본 0(방향이 정해짐), null이면 답에서 생략해 열린 설계로 본다. */
  designOpen?: number | null;
  /** Jev의 uiDifficulty 선택. 기본 NONE(남은 UI 판단 없음). null이면 답을 싣지 않는다(모름). */
  uiDifficulty?: string | null;
  /** Jev의 reworkNature 선택. 기본 NONE. */
  reworkNature?: string;
  /** Jev의 boundedDesign 선택. 기본 NONE. null이면 답을 싣지 않는다(모름). */
  boundedDesign?: string | null;
  /** 호출 순서별 designOpen·reworkNature. 같은 하네스에서 다시 준비한 판단을 시험한다. */
  designOpens?: number[];
  reworkNatures?: string[];
  /** Jev의 crossReviewNeed 선택. 생략하면 답에 싣지 않는다. */
  crossReviewNeed?: string;
  /** 필수 스킬 분류 답. 기본은 보이는 산출물 없음(NONVISUAL)이고 세트·조건 noul은 0이다. 준 키만 덮는다. */
  skillAnswers?: Record<string, { choice?: string; noul?: number }>;
  /** 필수 스킬 정본. 생략하면 실제 rules/frontend.md를 읽는다. */
  requiredSkills?: RoutingDeps["requiredSkills"];
} = {}) {
  const sessionId = "example".concat(String(++nextHarnessSession));
  const modelFamilies = options.families ?? families;
  let mainModel = options.main ? { ...options.main, identity: { class: modelFamilies[`${options.main.provider}/${options.main.id}`] ?? "unknown" } } : undefined;
  const routingCtx = {
    sessionManager: { getSessionId: () => sessionId },
    get model() { return mainModel; },
    models: {
      current: () => mainModel,
      family: (model: { provider: string; id: string }) =>
        modelFamilies[`${model.provider}/${model.id}`] ?? model.provider,
    },
    modelRegistry: {
      find: (provider: string, id: string) =>
        (`${provider}/${id}` in modelFamilies ? { provider, id, identity: { class: modelFamilies[`${provider}/${id}`] } } : undefined),
    },
  } as never;
  const policy = structuredClone(loadRoutingPolicy());
  const requests: Parameters<RoutingDeps["judge"]>[1][] = [];
  let owners: Owner[] = [];
  let candidateCalls = 0;
  // 등록 도구 경로를 그대로 지난다. 코어가 주는 zod는 schema 등록에만 쓰이므로 사슬 stub이면 충분하다.
  const toolDefinitions: { execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<{ content: { text: string }[]; details: unknown }> }[] = [];
  const zodChain = (): { nullable(): unknown; describe(): unknown } => ({ nullable: () => zodChain(), describe: () => zodChain() });
  const route = registerMakerRouting({
    zod: { string: zodChain, array: zodChain, object: zodChain },
    registerTool: (definition: never) => { toolDefinitions.push(definition); },
  } as never, {
    policy: () => policy, settings: async () => undefined,
    candidates: async () => {
      candidateCalls += 1;
      options.onCandidate?.(candidateCalls);
      if (options.candidateGate && candidateCalls === (options.candidateGateOnCall ?? 1)) {
        await options.candidateGate;
      }
      return options.candidates ?? candidates;
    },
    owners: () => owners,
    quota: options.quota ?? (async () => ({ state: "unavailable", observedAt: 0, reason: "test harness" })),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.ledger ? { ledger: options.ledger } : {}),
    ...(options.requiredSkills ? { requiredSkills: options.requiredSkills } : {}),
    judge: async (_ctx, request) => {
      requests.push(request);
      const call = requests.length;
      options.onJudge?.();
      if (options.judgeGate && call === (options.judgeGateOnCall ?? 1)) await options.judgeGate;
      if (options.fail || options.failCalls?.includes(call)) throw new Error("TimeoutError");
      return { answers: {
        workClass: {
          choice: options.workClasses?.[call - 1] ?? options.workClass ?? "NORMAL",
          ...(options.workClassConfidence === undefined ? {} : (() => {
            const chosen = options.workClasses?.[call - 1] ?? options.workClass ?? "NORMAL";
            const other = chosen === "HARD" ? "NORMAL" : "HARD";
            return { confidence: options.workClassConfidence, probabilities: { [chosen]: options.workClassConfidence, [other]: 1 - options.workClassConfidence } };
          })()),
        },
        hardFocus: { choice: options.hardFocuses?.[call - 1] ?? "CODE_SYSTEM" },
        uiUxBoundary: { noul: options.uiUxBoundary ?? 0 },
        duplicate: { noul: options.duplicate ?? 0 }, additionalInstruction: { noul: options.additional ?? 0 },
        delegation: { choice: options.delegation ?? "MAKER" },
        ...(options.uiDifficulty === null ? {} : { uiDifficulty: { choice: options.uiDifficulty ?? "NONE" } }),
        ...(options.boundedDesign === null ? {} : { boundedDesign: { choice: options.boundedDesign ?? "NONE" } }),
        reworkNature: { choice: options.reworkNatures?.[call - 1] ?? options.reworkNature ?? "NONE" },
        ...(options.designOpen === null ? {} : { designOpen: { noul: options.designOpens?.[call - 1] ?? options.designOpen ?? 0 } }),
        ...(options.ownerTarget ? { ownerTarget: { choice: options.ownerTarget } } : {}),
        ...(options.crossReviewNeed ? { crossReviewNeed: { choice: options.crossReviewNeed } } : {}),
        ...Object.fromEntries(Object.entries(request.questions).filter(([key]) => key.startsWith("requiredSkill"))
          .map(([key, question]) => [key, question.type === "choice" ? { choice: "NONVISUAL" } : { noul: 0 }])),
        ...options.skillAnswers,
      } };
    },
  });
  const task = { name: "ViewFix", task: brief, assessment: facts };
  const input = { context: "같은 계약", tasks: [{ name: task.name, task: brief, agent: "maker", model: `${DEEPSEEK}:auto` }] };
  return {
    ...route,
    policy,
    requests,
    task,
    input,
    sessionId,
    ctx: routingCtx,
    tool: toolDefinitions[0]!,
    prepare: (context: string, tasks: typeof task[], _ctx: unknown, signal?: AbortSignal) =>
      route.prepare(context, tasks, routingCtx, signal),
    prepareBatch: (context: string, tasks: typeof task[], _ctx: unknown, signal?: AbortSignal) =>
      route.prepareBatch(context, tasks, routingCtx, signal, "route"),
    beforeTask: (value: Record<string, unknown>, _ctx: unknown, callId?: string) =>
      route.beforeTask(withSolutionSpace(value), routingCtx, callId),
    noteSpawned: (value: Record<string, unknown>, callId = "task-call",
      ids = new Map<number, { agentId: string; jobId: string }>([[0, { agentId: "agent-viewfix", jobId: "job-viewfix" }]])) =>
      route.noteSpawned(value, sessionId, callId, ids),
    // core는 같은 task 호출의 admission과 spawn 결과에 같은 toolCallId를 준다. noteSpawned 기본값과 같은 호출로 낸다.
    dispatch: (model: string, task: string = brief) => route.beforeTask(withSolutionSpace({
      context: input.context,
      tasks: [{ name: input.tasks[0]!.name, task, agent: "maker", model }],
    }), routingCtx, "task-call"),
    setOwners(value: typeof owners) { owners = value; },
    setMain(value: typeof CODEX_MAIN | null) { mainModel = value ? { ...value, identity: { class: modelFamilies[`${value.provider}/${value.id}`] ?? "unknown" } } : undefined; },
  };
}

describe("2026-11-07 dispatch format normalization", () => {
  type NormalizedDispatch = { block?: boolean; input: { context: string; tasks: Array<Record<string, unknown>> }; notices: string[] };
  test("candidate selector suffix and coarse effort normalize without mutating input", async () => {
    const h = harness();
    await h.prepare("", [h.task], {});
    for (const model of [DEEPSEEK, `${DEEPSEEK}:high`, `${DEEPSEEK}:auto`]) {
      const item = { ...h.input.tasks[0], model, effort: "hi" };
      const result = await h.beforeTask({ ...h.input, tasks: [item] }, {}) as NormalizedDispatch;
      expect(result?.block).not.toBe(true);
      expect(result.input.tasks[0].model).toBe(`${DEEPSEEK}:auto`);
      expect(result.input.tasks[0]).not.toHaveProperty("effort");
      expect(result.notices.join("\n")).toContain("auto");
      expect(item.effort).toBe("hi");
    }
    expect(await h.dispatch("unknown/not-a-candidate")).toMatchObject({ block: true });
    const flat = await h.beforeTask({ context: "", name: h.task.name, task: brief, model: `${DEEPSEEK}:high`, effort: "hi" }, {}) as { input: Record<string, unknown> };
    expect(flat.input.model).toBe(`${DEEPSEEK}:auto`);
    expect(flat.input).not.toHaveProperty("effort");
  });
  test("prepared additions and mixed full briefs dispatch with restored content", async () => {
    const h = harness();
    const other = { ...h.task, name: "Other", task: brief.replace("src/view.ts", "src/other.ts") };
    const routes = await h.prepare("stored context", [h.task, other], {});
    const full = { name: other.name, task: other.task, model: `${DEEPSEEK}:auto` };
    const result = await h.beforeTask({
      context: "PREPARED_CONTEXT\nMain context addition",
      tasks: [{ task: `PREPARED_TASK: ${routes[0].preparedId}\nMain brief addition`, model: `${DEEPSEEK}:auto` }, full],
    }, {}) as NormalizedDispatch;
    expect(result?.block).not.toBe(true);
    expect(result.input.context).toBe("stored context\nMain context addition");
    expect(result.input.tasks[0].task).toBe(`${brief}\nMain brief addition`);
    expect(result.input.tasks[1].task).toBe(full.task);
    expect(await h.beforeTask({ context: "PREPARED_CONTEXT", task: "PREPARED_TASK: missing" }, {})).toMatchObject({ block: true });
  });
  test("first dispatch defaults and unambiguous prefixes are visible to the child", async () => {
    for (const [value, expected] of [["", "feature"], ["feat", "feature"], ["maint", "maintenance"], ["diag", "diagnostic"]]) {
      const h = harness();
      const task = `TASK_GUARD:\n${value ? `WORK_CLASS: ${value}\n` : ""}OWNED_PATHS: src/view.ts\nTASK_TITLE: Normalize contract\n\nbody`;
      await h.prepare("", [{ ...h.task, task }], {});
      const routed = await h.dispatch(`${DEEPSEEK}:auto`, task);
      expect(routed ?? {}).not.toMatchObject({ block: true });
      const result = reserveTaskCall(createTaskGuardState(), "first", { name: h.task.name, agent: "maker", task });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.input?.task).toContain(`WORK_CLASS: ${expected}`);
        expect(result.input?.task).toContain("PRIMARY_DELIVERABLE: Normalize contract");
      }
    }
    const fallback = reserveTaskCall(createTaskGuardState(), "fallback", { name: "FallbackName", agent: "maker", task: "TASK_GUARD:\nOWNED_PATHS: src/view.ts" });
    expect(fallback).toMatchObject({ ok: true, input: { task: expect.stringContaining("PRIMARY_DELIVERABLE: FallbackName") } });
  });
  test("additional deliverables dispatch with advisory and retain budget accounting", async () => {
    const h = harness();
    const other = { ...h.task, name: "Other", task: brief.replace("maintenance", "feature").replace("표시 오류 수정", "another deliverable").replace("src/view.ts", "src/other.ts") };
    const routes = await h.prepare("", [h.task, other], {});
    expect(routes[1].briefGaps?.join("\n")).toContain("maintenance:표시 오류 수정");
    const input = { tasks: [h.task, other].map((task) => ({ name: task.name, task: task.task, agent: "maker", model: `${DEEPSEEK}:auto` })) };
    const routed = await h.beforeTask(input, {});
    expect(routed).not.toMatchObject({ block: true });
    const state = createTaskGuardState();
    const reserved = reserveTaskCall(state, "additional", input);
    expect(reserved.ok).toBe(true);
    if (reserved.ok) expect(reserved.notices?.join("\n")).toContain("feature:another deliverable");
    expect(state.usage).toEqual({ primaryMaker: 2, reworkMaker: 0, total: 2 });
    expect(state.admitted).toHaveLength(1);
  });
});

describe("Main의 추천 확인 전에는 발주하지 않는 라우팅", () => {
  test("동일 준비의 병렬 호출은 한 번만 판단하고 task 경계에서는 재호출하지 않는다", async () => {
    const h = harness();
    expect(await h.beforeTask(h.input, {} as never)).toMatchObject({ block: true });
    expect(h.requests.length).toBe(0);
    await Promise.all([h.prepare("같은 계약", [h.task], {} as never), h.prepare("같은 계약", [h.task], {} as never)]);
    expect(await h.beforeTask(h.input, {} as never)).toBeUndefined();
    expect(h.requests.length).toBe(1);
    expect(JSON.stringify(h.requests[0])).not.toContain("구현 원문");
  });
  test("준비와 다른 계약으로 발주하면 어긋난 필드와 다음 한 수를 거절 문구에 집는다", async () => {
    const h = harness();
    await h.prepare("같은 계약", [h.task], {} as never);
    const dispatch = async (task: string) => (await h.beforeTask({
      context: "같은 계약",
      tasks: [{ name: h.task.name, task, agent: "maker", model: `${DEEPSEEK}:auto` }],
    }, {} as never)) as { block: boolean; reason: string };

    const added = await dispatch(brief.replace("OWNED_PATHS: src/view.ts", "OWNED_PATHS: src/view.ts, src/extra.ts"));
    expect(added.block).toBe(true);
    expect(added.reason).toContain("이름 'ViewFix'의 준비 계약과 이번 발주 계약이 다릅니다");
    expect(added.reason).toContain("OWNED_PATHS 추가: src/extra.ts");
    expect(added.reason).toContain("maker_route를 다시 부르고 그 결과의 preparedId로 발주하세요");
    expect(added.reason).not.toContain("구현 원문");

    const removed = await dispatch(brief.replace("OWNED_PATHS: src/view.ts", "OWNED_PATHS: src/other.ts"));
    expect(removed.reason).toContain("OWNED_PATHS 추가: src/other.ts");
    expect(removed.reason).toContain("OWNED_PATHS 빠짐: src/view.ts");

    const fields = await dispatch(brief
      .replace("WORK_CLASS: maintenance", "WORK_CLASS: feature")
      .replace("PRIMARY_DELIVERABLE: 표시 오류 수정", "PRIMARY_DELIVERABLE: 표시 오류 재설계"));
    expect(fields.reason).toContain("WORK_CLASS 준비='maintenance' 발주='feature'");
    expect(fields.reason).toContain("PRIMARY_DELIVERABLE 준비='표시 오류 수정' 발주='표시 오류 재설계'");

    const finding = await dispatch(brief.replace("OWNED_PATHS:", "FINDING_ID: f-1\nOWNED_PATHS:"));
    expect(finding.reason).toContain("FINDING_ID 준비=<없음> 발주='f-1'");

    // 계약이 다르다고 단정하면서 차이를 못 짚는 모순된 안내는 나오지 않는다.
    for (const blocked of [added, removed, fields, finding]) {
      expect(blocked.reason).toContain("계약이 다릅니다");
      expect(blocked.reason).not.toContain("차이 필드를 찾지 못했습니다");
    }
  });
  test("소유 범위가 같으면 표기 순서·중복만 다른 OWNED_PATHS도 같은 준비 판단으로 발주한다", async () => {
    const h = harness();
    const prepared = await h.prepare("같은 계약", [{
      ...h.task,
      task: brief.replace("OWNED_PATHS: src/view.ts", "OWNED_PATHS: src/view.ts, src/extra.ts"),
    }], {} as never);
    expect(prepared[0]!.status).toBe("judged");
    const dispatch = async (paths: string) => h.beforeTask({
      context: "같은 계약",
      tasks: [{
        name: h.task.name,
        task: brief.replace("OWNED_PATHS: src/view.ts", `OWNED_PATHS: ${paths}`),
        agent: "maker",
        model: `${DEEPSEEK}:auto`,
      }],
    }, {} as never);

    expect(await dispatch("src/extra.ts, src/view.ts")).toBeUndefined();
    expect(await dispatch("src/view.ts, src/extra.ts, src/extra.ts")).toBeUndefined();
    // 같은 소유 범위는 같은 키로 붙으므로 판단을 다시 묻지 않는다.
    expect(h.requests).toHaveLength(1);
    // 소유 범위가 실제로 달라지면 그대로 차단하고 그 경로를 지목한다.
    const narrowed = await dispatch("src/view.ts") as { block: boolean; reason: string };
    expect(narrowed.block).toBe(true);
    expect(narrowed.reason).toContain("OWNED_PATHS 빠짐: src/extra.ts");
  });
  test("준비되지 않은 이름으로 발주하면 준비된 이름 목록과 다음 한 수를 보여준다", async () => {
    const empty = harness();
    const nothing = await empty.beforeTask(empty.input, {} as never) as { block: boolean; reason: string };
    expect(nothing.block).toBe(true);
    expect(nothing.reason).toContain("이름 'ViewFix'으로 준비된 발주가 없습니다");
    expect(nothing.reason).toContain("이 session에는 준비된 발주가 없습니다");

    const h = harness();
    await h.prepare("같은 계약", [h.task], {} as never);
    const other = await h.beforeTask({
      ...h.input,
      tasks: [{ ...h.input.tasks[0], name: "OtherFix" }],
    }, {} as never) as { block: boolean; reason: string };
    expect(other.block).toBe(true);
    expect(other.reason).toContain("이름 'OtherFix'으로 준비된 발주가 없습니다");
    expect(other.reason).toContain("이 session에 준비된 이름: ViewFix");
    expect(other.reason).toContain("maker_route를 다시 부르고 그 결과의 preparedId로 발주하세요");
  });
  test("같은 이름의 준비가 여럿이면 차이가 가장 적은 계약을 비교 대상으로 고른다", async () => {
    const h = harness();
    const wide = { ...h.task, task: brief.replace("OWNED_PATHS: src/view.ts", "OWNED_PATHS: src/view.ts, src/wide.ts") };
    const narrow = { ...h.task, task: brief.replace("PRIMARY_DELIVERABLE: 표시 오류 수정", "PRIMARY_DELIVERABLE: 표시 오류 재설계") };
    await h.prepare("같은 계약", [wide], {} as never);
    await h.prepare("같은 계약", [narrow], {} as never);
    const closest = await h.beforeTask(h.input, {} as never) as { block: boolean; reason: string };
    expect(closest.block).toBe(true);
    expect(closest.reason).toContain("PRIMARY_DELIVERABLE 준비='표시 오류 재설계' 발주='표시 오류 수정'");
    expect(closest.reason).not.toContain("src/wide.ts");

    const older = { ...h.task, task: brief.replace("OWNED_PATHS: src/view.ts", "OWNED_PATHS: src/a.ts") };
    const newer = { ...h.task, task: brief.replace("OWNED_PATHS: src/view.ts", "OWNED_PATHS: src/b.ts") };
    const tie = harness();
    await tie.prepare("같은 계약", [older], {} as never);
    await tie.prepare("같은 계약", [newer], {} as never);
    const latest = await tie.beforeTask(tie.input, {} as never) as { block: boolean; reason: string };
    expect(latest.reason).toContain("OWNED_PATHS 빠짐: src/b.ts");
    expect(latest.reason).not.toContain("src/a.ts");
  });
  test("거절 문구는 사용자 입력 유래 값을 상한 안으로 자르고 본문을 싣지 않는다", async () => {
    const h = harness();
    const longName = "Fix".repeat(40);
    await h.prepare("같은 계약", [{ ...h.task, name: longName }], {} as never);
    const longPath = `${"deep/".repeat(20)}file.ts`;
    const reason = await h.beforeTask({
      context: "같은 계약",
      tasks: [{
        name: longName,
        task: brief.replace("OWNED_PATHS: src/view.ts", `OWNED_PATHS: src/view.ts, ${longPath}`),
        agent: "maker",
        model: `${DEEPSEEK}:auto`,
      }],
    }, {} as never) as { block: boolean; reason: string };
    expect(reason.block).toBe(true);
    expect(reason.reason).not.toContain(longName);
    expect(reason.reason).not.toContain(longPath);
    expect(reason.reason).toContain("…");
    expect(reason.reason).not.toContain("구현 원문");
  });
  test("판정이 먼저 끝나도 이번 quota 조회를 기다리고 최신 잔량으로 반환한다", async () => {
    let calls = 0;
    let returned = false;
    const quotaStarted = Promise.withResolvers<void>();
    const quotaRelease = Promise.withResolvers<void>();
    const judgeReached = Promise.withResolvers<void>();
    const h = harness({
      onJudge: () => judgeReached.resolve(),
      quota: async (_providers, signal) => {
        calls += 1;
        if (calls === 1) {
          quotaStarted.resolve();
          await quotaRelease.promise;
          expect(signal?.aborted).toBe(false);
        }
        return {
          state: "observed", observedAt: 1_000 + calls,
          providers: {
            anthropic: [{ credentialId: 9, disabled: false, autoBlockedUntilMs: null, limitReached: false, fetchedAt: 900,
              limits: [{ id: "anthropic:5h", usedFraction: 0.42, resetsAt: 20_000, daySlot: null },
                { id: "anthropic:weekly", usedFraction: 0.7, resetsAt: 500_000, daySlot: { usedPct: 12, quotaPct: 14.3, slotsLeft: 3, quality: "exact" } }] }],
            "openai-codex": [],
          },
        };
      },
    });
    const pending = h.prepareBatch("같은 계약", [h.task], {} as never).then((result) => {
      returned = true;
      return result;
    });
    await Promise.all([judgeReached.promise, quotaStarted.promise]);
    expect(h.requests.length).toBe(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(returned).toBe(false);
    quotaRelease.resolve();
    const first = await pending;
    expect(first).toMatchObject({
      candidates,
      unavailableCandidates: [],
      quota: {
        state: "observed",
        observedAt: 1_001,
      },
    });
    expect(calls).toBe(1);
    expect(first.routes).toHaveLength(1);
    expect(first.routes[0]).not.toHaveProperty("quota");
    expect(first.routes[0]).not.toHaveProperty("candidates");
    expect(JSON.stringify(h.requests[0])).not.toContain("usedFraction");
    // 새 준비에서는 잔량을 다시 읽고, 이미 끝난 값이면 결과에 포함한다.
    const second = await h.prepareBatch("같은 계약", [h.task], {} as never);
    expect(second).toMatchObject({
      quota: {
        state: "observed",
        observedAt: 1_002,
        providers: { anthropic: [{ limits: [{ usedFraction: 0.42 }, { daySlot: { slotsLeft: 3 } }] }] },
      },
    });
    expect(h.requests.length).toBe(1);
    expect(await h.beforeTask(h.input, {} as never)).toBeUndefined();
  });
  test("acceptance·checks가 비었거나 공백뿐인 발주는 briefGaps로 알리고, 발주 자체는 막지 않는다", async () => {
    const h = harness();
    const filled = await h.prepareBatch("같은 계약", [h.task], {});
    expect(filled.routes[0]!.briefGaps).toBeNull();
    const empty = { ...h.task, assessment: { ...facts, acceptance: ["  "], checks: [] } };
    const batch = await h.prepareBatch("같은 계약", [empty], {});
    expect(batch.routes[0]!.briefGaps).toEqual([
      "acceptance가 비어 있음: 무엇을 만족해야 끝나는지 적으세요.",
      "checks가 비어 있음: 어떻게 확인할지(명령·관측 대상) 적으세요.",
    ]);
    expect(batch.routes[0]!.status).toBe("judged");
    expect(await h.beforeTask(h.input, {})).toBeUndefined();
  });
  test("FINDING_ID 재작업인데 failureEvidence가 비면 briefGaps로 실패 원인과 이전 접근의 한계를 요구하고, 있으면 알리지 않는다", async () => {
    const h = harness();
    const rework = { ...h.task, task: reworkTaskBrief };
    const missing = await h.prepareBatch("재작업", [rework], {});
    expect(missing.routes[0]!.briefGaps).toEqual([
      "FINDING_ID 재작업인데 failureEvidence가 비어 있음: 이전 시도가 무엇 때문에 실패했는지와 그 접근의 한계를 적으세요.",
    ]);
    const blank = await h.prepareBatch("재작업", [{ ...rework, assessment: { ...facts, failureEvidence: [" "] } }], {});
    expect(blank.routes[0]!.briefGaps).toHaveLength(1);
    const given = await h.prepareBatch("재작업", [{ ...rework, assessment: { ...facts, failureEvidence: ["f-1: 캐시 무효화 누락으로 이전 수정이 새로고침 뒤 되돌아감"] } }], {});
    expect(given.routes[0]!.briefGaps).toBeNull();
    // 재작업이 아니면 failureEvidence가 없어도 빈칸이 아니다.
    expect((await h.prepareBatch("새 작업", [h.task], {})).routes[0]!.briefGaps).toBeNull();
  });
  test("같은 배치의 OWNED_PATHS 겹침은 준비 결과 ownershipOverlaps로 먼저 알리고, 같은 배치 발주는 그대로 막힌다", async () => {
    const make = (name: string, paths: string) => ({
      name,
      task: brief.replace("OWNED_PATHS: src/view.ts", `OWNED_PATHS: ${paths}`),
      assessment: { ...facts, paths: paths.split(",") },
    });
    const h = harness();
    const tasks = [make("Left", "src/view.ts,lib/i18n/"), make("Right", "lib/i18n/ko.ts"), make("Solo", "doc/note.md")];
    const batch = await h.prepareBatch("같은 batch", tasks, {} as never);
    expect(batch.routes.map((route) => route.ownershipOverlaps)).toEqual([
      ["'Right'과 겹침: lib/i18n/"],
      ["'Left'과 겹침: lib/i18n/ko.ts"],
      null,
    ]);
    expect(batch.instruction).toContain("ownershipOverlaps");
    // 경고는 발주 판정을 바꾸지 않는다. 같은 배치를 공유 작업공간으로 내면 기존 검사가 막고, 겹침 없는 항목만 내면 통과한다.
    const item = (task: typeof tasks[number]) => ({ name: task.name, task: task.task, agent: "maker", model: `${DEEPSEEK}:auto` });
    expect(await h.beforeTask({ context: "같은 batch", tasks: tasks.map(item) }, {} as never, "batch"))
      .toMatchObject({ block: true, reason: expect.stringContaining("'Left' ↔ 'Right'") });
    expect(await h.beforeTask({ context: "같은 batch", tasks: [item(tasks[0]!), item(tasks[2]!)] }, {} as never, "pair")).toBeUndefined();
  });
  test("같은 파일의 동등한 표기(//, /./)도 exact와 똑같이 겹침으로 알리고 막되, 다른 파일은 통과시킨다", async () => {
    const make = (name: string, paths: string) => ({
      name,
      task: brief.replace("OWNED_PATHS: src/view.ts", `OWNED_PATHS: ${paths}`),
      assessment: { ...facts, paths: paths.split(",") },
    });
    const item = (task: { name: string; task: string }) => ({ name: task.name, task: task.task, agent: "maker", model: `${DEEPSEEK}:auto` });
    for (const [right, overlaps] of [
      ["src/view.ts", true], ["src//view.ts", true], ["src/./view.ts", true], ["./src\\view.ts", true],
      ["src/view.tsx", false], ["src/other.ts", false],
    ] as const) {
      const h = harness();
      const tasks = [make("Left", "src/view.ts"), make("Right", right)];
      const batch = await h.prepareBatch("같은 batch", tasks, {} as never);
      expect(batch.routes.map((route) => route.ownershipOverlaps !== null)).toEqual([overlaps, overlaps]);
      const result = await h.beforeTask({ context: "같은 batch", tasks: tasks.map(item) }, {} as never, "batch");
      if (overlaps) expect(result).toMatchObject({ block: true, reason: expect.stringContaining("'Left' ↔ 'Right'") });
      else expect(result).toBeUndefined();
    }
  });
  test("OWNED_PATHS에 설명 괄호·glob이 섞이면 briefGaps로 경로가 아니라고 알리고, Next 경로 그룹·동적 세그먼트는 그대로 둔다", async () => {
    const h = harness();
    const paths = "app/globals.css (panel,deck blocks only),lib/i18n/messages/*,app/(chat)/page.tsx,app/api/agent/[id]/route.ts";
    const annotated = { ...h.task, task: brief.replace("OWNED_PATHS: src/view.ts", `OWNED_PATHS: ${paths}`) };
    const batch = await h.prepareBatch("같은 계약", [annotated], {} as never);
    expect(batch.routes[0]!.briefGaps).toEqual([
      "OWNED_PATHS에 경로가 아닌 항목: 'app/globals.css (panel', 'deck blocks only)', 'lib/i18n/messages/*'. 설명·괄호·glob 없이 파일 또는 후행 /의 디렉터리만 콤마로 적으세요. 같은 파일을 블록으로 나눠 맡기는 범위는 소유 검사가 표현하지 못하므로 # Target에 적습니다.",
    ]);
    const plain = { ...h.task, task: brief.replace("OWNED_PATHS: src/view.ts", "OWNED_PATHS: app/(chat)/page.tsx,app/api/agent/[id]/route.ts,lib/i18n/") };
    expect((await h.prepareBatch("같은 계약", [plain], {} as never)).routes[0]!.briefGaps).toBeNull();
  });
  test("registry에 없는 후보는 unavailable로 분리되고 나머지 후보의 발주는 막히지 않는다", async () => {
    const policy = loadRoutingPolicy();
    const profiles = Object.keys(policy.modelSelection.profiles);
    const modelRoles: Record<string, string> = {};
    for (const profile of profiles) {
      const slot = policy.modelSelection.profiles[profile]!.modelConfigPath.slice("modelRoles.".length);
      modelRoles[slot] = candidates.find((candidate) => candidate.profile === profile)!.model;
    }
    // 다른 후보와 모델을 공유하지 않는 후보를 registry에서 뺀다.
    const missing = candidates.find((candidate) => candidate.profile === "NORMAL_DEEPSEEK")!;
    const registry = {
      find: (provider: string, id: string) => {
        const model = `${provider}/${id}`;
        if (model === missing.model) return undefined;
        const found = candidates.find((candidate) => candidate.model === model);
        return found ? { thinking: { efforts: found.efforts } } : undefined;
      },
      refreshDiscoverableProviders: async () => {},
    };
    const sessionId = "sample";
    const ctx = { sessionManager: { getSessionId: () => sessionId }, modelRegistry: registry, models: { current: () => undefined } } as never;
    const route = registerMakerRouting({} as never, {
      policy: () => policy,
      settings: async () => ({ getModelRoles: () => modelRoles }),
      owners: () => [],
      quota: async () => ({ state: "unavailable", observedAt: 0, reason: "test" }),
      judge: async () => ({ answers: { workClass: { choice: "NORMAL" }, designOpen: { noul: 0 }, uiDifficulty: { choice: "NONE" }, boundedDesign: { choice: "NONE" } } }),
    });
    const task = { name: "ViewFix", task: brief, assessment: facts };
    const batch = await route.prepareBatch("계약", [task], ctx);
    expect(batch.candidates.map((candidate) => candidate.model)).not.toContain(missing.model);
    expect(batch.unavailableCandidates).toEqual([
      { profile: "NORMAL_DEEPSEEK", model: missing.model, reason: "registry에 없는 Maker 후보" },
      { profile: "HARD_CODE_DEEPSEEK", model: missing.model, reason: "registry에 없는 Maker 후보" },
    ]);
    expect(batch.routes[0]!.status).toBe("judged");
    // DeepSeek 자리가 비면 Sonnet으로 자동 대체하지 않고 추천 없음이다. 추천 없는 route는 근거 없이는 막히고, Main이 근거를 남기면 직접 고른 후보가 발주된다.
    expect(batch.routes[0]!.profile).toBeNull();
    const reasoned = brief.replace("OWNED_PATHS: src/view.ts", "OWNED_PATHS: src/view.ts\nROUTING_REASON: DeepSeek가 registry에 없어 Main이 Sonnet을 직접 선택함");
    const bare = { context: "계약", tasks: [{ name: task.name, task: brief, agent: "maker", model: `${SONNET}:auto` }] };
    expect(await route.beforeTask(withSolutionSpace(bare), ctx)).toMatchObject({ block: true });
    const input = { context: "계약", tasks: [{ name: task.name, task: reasoned, agent: "maker", model: `${SONNET}:auto` }] };
    expect(await route.beforeTask(withSolutionSpace(input), ctx)).toBeUndefined();
    // 불가한 후보를 지정하면 다른 모델로 대체하지 않고 막는다.
    const blocked = { context: "계약", tasks: [{ name: task.name, task: brief, agent: "maker", model: `${missing.model}:auto` }] };
    expect(await route.beforeTask(withSolutionSpace(blocked), ctx)).toMatchObject({ block: true });
  });
  test("registry 강도는 유지하고 발주 selector만 auto로 보정한다", async () => {
    const policy = loadRoutingPolicy();
    const modelRoles: Record<string, string> = {};
    for (const profile of Object.keys(policy.modelSelection.profiles)) {
      const slot = policy.modelSelection.profiles[profile]!.modelConfigPath.slice("modelRoles.".length);
      // 설정 slot은 운영처럼 :auto suffix다. 후보 해석은 suffix를 떼고 registry를 찾는다.
      modelRoles[slot] = `${candidates.find((candidate) => candidate.profile === profile)!.model}:auto`;
    }
    // DeepSeek는 운영 models.yml처럼 low·high만 선언한다. 후보 강도는 그 선언 그대로다.
    const ladders: Record<string, string[]> = { "hive/deepseek-ai/deepseek-v4.1-flash-1017": ["low", "high"] };
    const registry = {
      find: (provider: string, id: string) => {
        const found = candidates.find((candidate) => candidate.model === `${provider}/${id}`);
        return found ? { thinking: { efforts: ladders[found.model] ?? found.efforts } } : undefined;
      },
      refreshDiscoverableProviders: async () => {},
    };
    const ctx = { sessionManager: { getSessionId: () => "auto-only" }, modelRegistry: registry, models: { current: () => undefined } } as never;
    const asked: Record<string, unknown>[] = [];
    const route = registerMakerRouting({} as never, {
      policy: () => policy,
      settings: async () => ({ getModelRoles: () => modelRoles }),
      owners: () => [],
      quota: async () => ({ state: "unavailable", observedAt: 0, reason: "test" }),
      judge: async (_ctx, request) => {
        asked.push(request.questions);
        return { answers: { workClass: { choice: "HARD" }, hardFocus: { choice: "CODE_SYSTEM" }, uiUxBoundary: { noul: 0 }, designOpen: { noul: 0 }, uiDifficulty: { choice: "NONE" }, boundedDesign: { choice: "NONE" }, reworkNature: { choice: "NONE" } } };
      },
    });
    const batch = await route.prepareBatch("계약", [{ name: "Deep", task: brief, assessment: facts }], ctx);
    // 정책 구간으로 좁히지 않는다. Opus·Sonnet·Sol·DeepSeek 모두 registry가 선언한 단계 그대로다.
    expect(batch.candidates).toEqual(candidates.map((candidate) => ({ ...candidate, efforts: ladders[candidate.model] ?? candidate.efforts })));
    expect(Object.keys(asked[0]!).filter((key) => /effort/i.test(key))).toEqual([]);
    expect(batch.routes[0]!.profile).toBe("HARD_CODE_DEEPSEEK");
    const dispatch = (model: string) => withSolutionSpace({ context: "계약", tasks: [{ name: "Deep", task: brief, agent: "maker", model }] });
    for (const concrete of [`${DEEPSEEK}:low`, `${DEEPSEEK}:max`, DEEPSEEK]) {
      expect(await route.beforeTask(dispatch(concrete), ctx)).toMatchObject({
        input: { tasks: [expect.objectContaining({ model: `${DEEPSEEK}:auto` })] },
      });
    }
    expect(await route.beforeTask(dispatch(`${DEEPSEEK}:auto`), ctx)).toBeUndefined();
  });
  test("reset은 candidate·judge·beforeTask await의 stale 결과 게시와 dispatch를 막는다", async () => {
    {
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const reached = new Promise<void>((resolve) => { entered = resolve; });
      const h = harness({ candidateGate: gate, onCandidate: () => entered() });
      const pending = h.prepare("candidate 대기", [h.task], {} as never);
      await reached;
      h.reset();
      release();
      await expect(pending).rejects.toThrow();
      expect(h.requests).toHaveLength(0);
      expect(await h.beforeTask(h.input, {} as never)).toMatchObject({ block: true });
    }
    {
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const reached = new Promise<void>((resolve) => { entered = resolve; });
      const h = harness({ judgeGate: gate, onJudge: () => entered() });
      const pending = h.prepare("judge 대기", [h.task], {} as never);
      await reached;
      h.reset();
      release();
      await expect(pending).rejects.toThrow();
      expect(h.requests).toHaveLength(1);
      expect(await h.beforeTask(h.input, {} as never)).toMatchObject({ block: true });
    }
    {
      const h = harness();
      await h.prepare("dispatch 대기", [h.task], {} as never);
      const pending = h.beforeTask(h.input, {} as never);
      h.reset();
      expect(await pending).toMatchObject({ block: true });
    }
    {
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const reached = new Promise<void>((resolve) => { entered = resolve; });
      const h = harness({
        candidateGate: gate,
        candidateGateOnCall: 2,
        onCandidate: (call) => { if (call === 2) entered(); },
      });
      await h.prepare("beforeTask candidate 대기", [h.task], {} as never);
      const pending = h.beforeTask(h.input, {} as never);
      await reached;
      h.reset();
      release();
      expect(await pending).toMatchObject({ block: true });
    }
  });
  test("beforeTask candidate await 중 최신 prepare가 생기면 이전 dispatch를 차단한다", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const h = harness({
      candidateGate: gate,
      candidateGateOnCall: 2,
      onCandidate: (call) => { if (call === 2) entered(); },
    });
    await h.prepare("최초 준비", [h.task], {} as never);
    const staleDispatch = h.beforeTask(h.input, {} as never);
    await reached;
    await h.prepare("최신 준비", [{
      ...h.task,
      assessment: { ...facts, facts: ["candidate await 중 확인된 최신 facts"] },
    }], {} as never);
    release();
    expect(await staleDispatch).toMatchObject({ block: true });
    expect(await h.beforeTask(h.input, {} as never)).toBeUndefined();
  });

  test("한 발주 배치는 후보를 한 번 해석하고 다음 발주에서는 변경된 후보를 확인한다", async () => {
    let candidateCalls = 0;
    const available = structuredClone(candidates);
    const ledger = memoryLedger();
    const h = harness({ candidates: available, ledger, onCandidate: (call) => { candidateCalls = call; } });
    const tasks = Array.from({ length: 5 }, (_, index) => ({
      ...h.task,
      name: `Slice${index}`,
      task: brief.replace("src/view.ts", `src/slice${index}.ts`),
    }));
    await h.prepare("독립 경로 다섯 개", tasks, {} as never);
    candidateCalls = 0;
    const batch = { tasks: tasks.map(({ name, task }) => ({ name, task, model: `${DEEPSEEK}:auto` })) };
    expect(await h.beforeTask(batch, {} as never, "five")).toBeUndefined();
    // 준비의 한 번을 제외하면 admission은 task 수와 무관하게 한 번이다.
    expect(candidateCalls).toBe(2);
    h.noteSpawned(batch, "five", new Map(tasks.map((task, index) =>
      [index, { agentId: `agent-${task.name}`, jobId: `job-${task.name}` }])));
    expect(ledger.records.map((record) => "name" in record ? record.name : null)).toEqual(tasks.map((task) => task.name));
    available[0]!.efforts = ["medium"];
    expect(await h.beforeTask(batch, {} as never, "changed")).toMatchObject({
      block: true, reason: expect.stringContaining("후보 또는 판단 기준"),
    });
  });

  test("Task Guard 계약이 같으면 본문·context 문구는 달라도 연결하고 이름·계약 변경은 재준비한다", async () => {
    const h = harness();
    await h.prepare("준비할 때 쓴 설명", [h.task], {} as never);
    for (const change of [
      { ...h.input, context: "발주 시 더 간결해진 설명" },
      { ...h.input, tasks: [{ ...h.input.tasks[0], task: brief + "\n설명 문장부호와 오타만 달라짐!" }] },
    ]) expect(await h.beforeTask(change, {} as never)).toBeUndefined();
    for (const change of [
      { ...h.input, tasks: [{ ...h.input.tasks[0], name: "OtherFix" }] },
      { ...h.input, tasks: [{ ...h.input.tasks[0], task: brief.replace("표시 오류 수정", "출력 전이 변경") }] },
      { ...h.input, tasks: [{ ...h.input.tasks[0], task: brief.replace("src/view.ts", "src/other.ts") }] },
      { ...h.input, tasks: [{ ...h.input.tasks[0], task: brief.replace("WORK_CLASS: maintenance", "WORK_CLASS: diagnostic") }] },
    ]) expect(await h.beforeTask(change, {} as never)).toMatchObject({ block: true });
  });
  test("무관한 owner 변화는 판단과 dispatch를 무효화하지 않고 현재 path 충돌만 다시 본다", async () => {
    const h = harness();
    await h.prepare("같은 계약", [h.task], {} as never);
    h.setOwners([{ name: "Other", primaryDeliverable: "다른 조각", ownedPaths: ["src/other.ts"] }]);
    expect(await h.beforeTask(h.input, {} as never)).toBeUndefined();
    h.setOwners([]);
    expect(await h.beforeTask(h.input, {} as never)).toBeUndefined();
    expect(h.requests).toHaveLength(1);
    h.setOwners([{ name: "Conflict", primaryDeliverable: "다른 조각", ownedPaths: ["src/"] }]);
    expect(await h.beforeTask(h.input, {} as never)).toMatchObject({ block: true });
  });
  test("준비 당시에도 active path가 겹치면 ownerTarget 오판으로 새 spawn하지 않는다", async () => {
    const h = harness();
    h.setOwners([{
      name: "ActiveOwner",
      primaryDeliverable: "다른 조각",
      ownedPaths: ["src/"],
      active: true,
    }]);
    await h.prepare("같은 계약", [h.task], {} as never);
    expect(await h.beforeTask(h.input, {} as never)).toMatchObject({ block: true });
  });
  test("active OWNED_PATHS 충돌은 placement와 ROUTING_REASON으로 우회하지 않고 inactive owner는 차단하지 않는다", async () => {
    const reasonTask = brief.replace(
      "OWNED_PATHS: src/view.ts",
      "OWNED_PATHS: src/view.ts\nROUTING_REASON: Main이 기존 판단과 다른 새 spawn을 선택함",
    );
    const reasonInput = {
      context: "같은 계약",
      tasks: [{
        name: "ViewFix",
        task: reasonTask,
        agent: "maker",
        model: `${DEEPSEEK}:auto`,
      }],
    };
    const owner = {
      name: "ActiveOwner",
      primaryDeliverable: "표시 오류 수정",
      ownedPaths: ["src/"],
      active: true,
    };

    const unavailable = harness({ fail: true });
    unavailable.setOwners([owner]);
    await unavailable.prepare("Jev 불가", [unavailable.task], {} as never);
    expect(await unavailable.beforeTask(reasonInput, {} as never))
      .toMatchObject({ block: true });

    const instruct = harness({ additional: 0.9, ownerTarget: "owner0" });
    instruct.setOwners([owner]);
    expect((await instruct.prepare("기존 owner 지목", [instruct.task], {} as never))[0]!.placement)
      .toMatchObject({ action: "instruct-existing" });
    expect(await instruct.beforeTask(reasonInput, {} as never))
      .toMatchObject({ block: true });
    instruct.setOwners([{ ...owner, active: false }]);
    expect(await instruct.beforeTask(reasonInput, {} as never)).toBeUndefined();
  });

  test("active 충돌은 OWNED_PATHS 선언만 비교하고 assessment의 읽기·참고 경로는 차단하지 않는다", async () => {
    const h = harness();
    h.setOwners([{
      name: "OtherProjectWriter",
      primaryDeliverable: "별도 프로젝트 변경",
      ownedPaths: ["other-project/"],
      active: true,
    }]);
    await h.prepare("read-only 조사", [{
      ...h.task,
      assessment: {
        ...facts,
        paths: ["src/view.ts", "other-project/report.txt"],
        facts: ["other-project/report.txt는 읽기 전용 참고 증거다"],
      },
    }], {} as never);
    expect(await h.beforeTask(h.input, {} as never)).toBeUndefined();
  });
  test("관련 owner만 바뀌면 placement 질문만 다시 묻고 최초 등급·UI/UX 판단을 보존한다", async () => {
    const h = harness();
    h.setOwners([{ name: "FirstOwner", primaryDeliverable: "표시 오류 수정", ownedPaths: ["src/view.ts"] }]);
    const first = await h.prepare("같은 계약", [h.task], {} as never);
    expect(h.requests[0]!.questions).toHaveProperty("workClass");
    expect(h.requests[0]!.questions).toHaveProperty("ownerTarget");

    h.setOwners([{ name: "SecondOwner", primaryDeliverable: "표시 오류 수정", ownedPaths: ["src/view.ts"] }]);
    const second = await h.prepare("같은 계약", [h.task], {} as never);
    expect(h.requests).toHaveLength(2);
    expect(Object.keys(h.requests[1]!.questions).sort()).toEqual([
      "additionalInstruction", "duplicate", "ownerTarget",
    ]);
    expect(second[0]!.recommendations.workClass).toEqual(first[0]!.recommendations.workClass);
    expect(second[0]!.recommendations.uiUxBoundary).toEqual(first[0]!.recommendations.uiUxBoundary);
    expect(await h.beforeTask(h.input, {} as never)).toBeUndefined();
  });
  test("소유 경로 overlap은 정본의 case·directory·exact·dot 경계를 따른다", async () => {
    for (const [ownedPath, overlaps] of [
      ["SRC/", true],
      ["SRC/VIEW.TS", true],
      [".", true],
      ["src2/", false],
    ] as const) {
      const h = harness();
      h.setOwners([{
        name: "ActiveOwner",
        primaryDeliverable: "표시 오류 수정",
        ownedPaths: [ownedPath],
        active: true,
      }]);
      await h.prepare("같은 계약", [h.task], {} as never);
      expect("ownerTarget" in h.requests[0]!.questions).toBe(overlaps);
      const result = await h.beforeTask(h.input, {} as never);
      if (overlaps) expect(result).toMatchObject({ block: true });
      else expect(result).toBeUndefined();
    }
  });
  test("A/B 준비 뒤 A owner의 시작·settle은 disjoint B 판단을 다시 호출하지 않는다", async () => {
    const h = harness();
    const second = {
      name: "Second",
      task: brief.replace("src/view.ts", "src/second.ts"),
      assessment: { ...facts, paths: ["src/second.ts"] },
    };
    await h.prepare("같은 batch", [h.task, second], {} as never);
    expect(h.requests).toHaveLength(2);
    expect(await h.beforeTask(h.input, {} as never)).toBeUndefined();
    h.noteSpawned(h.input);
    const secondInput = {
      context: "같은 batch",
      tasks: [{
        name: second.name,
        task: second.task,
        agent: "maker",
        model: `${DEEPSEEK}:auto`,
      }],
    };
    for (const active of [true, false]) {
      h.setOwners([{
        name: "ViewFix",
        primaryDeliverable: "표시 오류 수정",
        ownedPaths: ["src/view.ts"],
        active,
      }]);
      expect(await h.beforeTask(secondInput, {} as never)).toBeUndefined();
    }
    expect(h.requests).toHaveLength(2);
  });
  test("같은 배치의 공유 작업공간 OWNED_PATHS 중복은 게시 전에 배치 전체를 막고 형제 경로는 통과한다", async () => {
    const make = (name: string, paths: string) => ({
      name,
      task: brief.replace("OWNED_PATHS: src/view.ts", `OWNED_PATHS: ${paths}`),
      assessment: { ...facts, paths: paths.split(",") },
    });
    const spawnIds = new Map([[0, { agentId: "agent-left", jobId: "job-left" }], [1, { agentId: "agent-right", jobId: "job-right" }]]);
    for (const [left, right, overlaps] of [
      ["src/view.ts", "src/view.ts", true],
      ["src/", "src/view.ts", true],
      ["src/view.ts", "SRC\\VIEW.TS", true],
      [".", "doc/note.md", true],
      ["src/view.ts,src/a.ts", "src/b.ts,src/a.ts", true],
      ["src/view.ts", "src/view.tsx", false],
      ["evals/", "evals2/case.ts", false],
    ] as const) {
      const ledger = memoryLedger();
      const h = harness({ ledger });
      const tasks = [make("Left", left), make("Right", right)];
      await h.prepare("같은 batch", tasks, {} as never);
      const item = (task: typeof tasks[number]) => ({ name: task.name, task: task.task, agent: "maker", model: `${DEEPSEEK}:auto` });
      const batch = { context: "같은 batch", tasks: tasks.map(item) };
      const result = await h.beforeTask(batch, {} as never, "batch");
      if (!overlaps) {
        expect(result).toBeUndefined();
        h.noteSpawned(batch, "batch", spawnIds);
        expect(ledger.records).toMatchObject([
          { name: "Left", ownership: { primaryDeliverable: "표시 오류 수정", ownedPaths: left.split(","), workspace: "shared" } },
          { name: "Right", ownership: { primaryDeliverable: "표시 오류 수정", ownedPaths: right.split(","), workspace: "shared" } },
        ]);
        continue;
      }
      expect(result).toMatchObject({ block: true, reason: expect.stringContaining("'Left' ↔ 'Right'") });
      // 차단된 배치는 어떤 초안도 게시하지 않는다. 같은 입력의 spawn 관측이 와도 원장에 남지 않는다.
      h.noteSpawned(batch, "batch", spawnIds);
      expect(ledger.records).toHaveLength(0);
      // 막힌 배치가 예약을 남기지 않아 한쪽만 다시 내면 그대로 통과하고 그 한 건만 기록된다.
      const single = { context: "같은 batch", tasks: [item(tasks[0]!)] };
      expect(await h.beforeTask(single, {} as never, "single")).toBeUndefined();
      h.noteSpawned(single, "single", spawnIds);
      expect(ledger.records).toMatchObject([{ name: "Left", assignmentId: `${h.sessionId}#single#0` }]);
      expect(ledger.records).toHaveLength(1);
    }
  });
  describe("별도 task 호출 사이의 공유 작업공간 예약", () => {
    interface PreparedTask { name: string; task: string; assessment: RoutingFacts }
    const make = (name: string, paths: string): PreparedTask => ({
      name,
      task: brief.replace("OWNED_PATHS: src/view.ts", `OWNED_PATHS: ${paths}`),
      assessment: { ...facts, paths: paths.split(",") },
    });
    const single = (task: PreparedTask, extra: Record<string, unknown> = {}, top: Record<string, unknown> = {}) =>
      ({ context: "호출 간", ...top, tasks: [{ name: task.name, task: task.task, agent: "maker", model: `${DEEPSEEK}:auto`, ...extra }] });
    async function prepared(left: string, right: string) {
      const ledger = memoryLedger();
      const h = harness({ ledger });
      const tasks = [make("Left", left), make("Right", right)];
      await h.prepare("호출 간", tasks, {} as never);
      return { h, ledger, left: tasks[0]!, right: tasks[1]! };
    }
    test("겹치는 exact·상하위 경로는 순차·동시 어느 쪽이든 한 호출만 예약하고 disjoint는 모두 통과한다", async () => {
      for (const [left, right, overlaps] of [
        ["src/a.ts", "src/a.ts", true],
        ["src/", "src/a.ts", true],
        ["src/a.ts", "src/", true],
        ["src/a.ts", "src/b.ts", false],
      ] as const) {
        const sequential = await prepared(left, right);
        expect(await sequential.h.beforeTask(single(sequential.left), {} as never, "call-a")).toBeUndefined();
        const second = await sequential.h.beforeTask(single(sequential.right), {} as never, "call-b");
        if (overlaps) expect(second).toMatchObject({ block: true, reason: expect.stringContaining("'Left'") });
        else expect(second).toBeUndefined();

        const concurrent = await prepared(left, right);
        const results = await Promise.all([
          concurrent.h.beforeTask(single(concurrent.left), {} as never, "call-a"),
          concurrent.h.beforeTask(single(concurrent.right), {} as never, "call-b"),
        ]);
        expect(results.filter((result) => result === undefined)).toHaveLength(overlaps ? 1 : 2);
      }
    });
    test("isolated 항목과 항목별 isolated override는 예약 scope를 따른다", async () => {
      const cases: [Record<string, unknown>, Record<string, unknown>, boolean][] = [
        [{ isolated: true }, {}, false],
        [{}, {}, true],
        // 상위 isolated보다 항목 값이 우선한다: 항목이 false면 공유 작업공간 예약과 충돌한다.
        [{ isolated: false }, { isolated: true }, true],
      ];
      for (const [extra, top, blocked] of cases) {
        const { h, left, right } = await prepared("src/a.ts", "src/a.ts");
        expect(await h.beforeTask(single(left), {} as never, "call-a")).toBeUndefined();
        const result = await h.beforeTask(single(right, extra, top), {} as never, "call-b");
        if (blocked) expect(result).toMatchObject({ block: true });
        else expect(result).toBeUndefined();
      }
    });
    test("뒤 guard 거절·실패·미실행으로 풀린 호출만 예약을 내놓고 spawn 관측은 예약을 실제 owner로 넘긴다", async () => {
      const { h, ledger, left, right } = await prepared("src/a.ts", "src/b.ts");
      const leftAgain = make("LeftAgain", "src/a.ts");
      const rightAgain = make("RightAgain", "src/b.ts");
      await h.prepare("호출 간", [leftAgain, rightAgain], {} as never);
      expect(await h.beforeTask(single(left), {} as never, "call-a")).toBeUndefined();
      expect(await h.beforeTask(single(right), {} as never, "call-b")).toBeUndefined();
      expect(await h.beforeTask(single(leftAgain), {} as never, "call-c")).toMatchObject({ block: true });
      // call-a가 spawn 전에 풀리면 그 예약만 사라진다. call-b 예약은 그대로다.
      h.releaseCall("call-a");
      expect(await h.beforeTask(single(rightAgain), {} as never, "call-d")).toMatchObject({ block: true, reason: expect.stringContaining("'Right'") });
      expect(await h.beforeTask(single(leftAgain), {} as never, "call-c")).toBeUndefined();
      // 풀린 호출의 초안은 남지 않아 같은 입력의 늦은 spawn 관측이 와도 원장에 쓰지 않는다.
      h.noteSpawned(single(left), "call-a");
      expect(ledger.records).toHaveLength(0);
      // spawn 관측은 자기 호출 예약을 실제 owner 목록으로 넘긴다. 이후 충돌은 deps.owners의 active owner가 맡는다.
      h.noteSpawned(single(right), "call-b");
      expect(ledger.records).toMatchObject([{ name: "Right" }]);
      expect(await h.beforeTask(single(rightAgain), {} as never, "call-e")).toBeUndefined();
    });
    test("같은 이름·같은 계약의 isolated 별도 호출은 각자 자기 초안으로 spawn identity를 남기고 다른 호출의 정리에 지워지지 않는다", async () => {
      const ledger = memoryLedger();
      const h = harness({ ledger });
      const fix = make("Fix", "src/a.ts");
      // 준비 판단은 한 번이고 두 호출이 재사용한다.
      await h.prepare("호출 간", [fix], {} as never);
      const isolatedCall = single(fix, { isolated: true });
      const ids = (agentId: string) => new Map([[0, { agentId, jobId: agentId }]]);
      // core는 한 assistant 메시지의 호출을 모두 admission한 뒤 실행·결과를 돌려준다.
      expect(await h.beforeTask(isolatedCall, {} as never, "call-a")).toBeUndefined();
      expect(await h.beforeTask(isolatedCall, {} as never, "call-b")).toBeUndefined();
      expect(await h.beforeTask(isolatedCall, {} as never, "call-c")).toBeUndefined();
      // 다른 호출의 spawn 없는 종료·selector가 어긋난 spawn은 자기 예약만 정리한다.
      h.releaseCall("call-c");
      h.noteSpawned(isolatedCall, "call-c", ids("Fix-3"));
      expect(ledger.records).toHaveLength(0);
      h.noteSpawned(single(fix, { isolated: true, model: `${DEEPSEEK}:auto` }), "call-x", ids("Fix-x"));
      expect(ledger.records).toHaveLength(0);
      expect([...h.noteSpawned(isolatedCall, "call-a", ids("Fix")).values()].map((entry) => entry.identity.attemptId)).toEqual([`${h.sessionId}#call-a#0#a1`]);
      expect([...h.noteSpawned(isolatedCall, "call-b", ids("Fix-2")).values()].map((entry) => entry.identity.attemptId)).toEqual([`${h.sessionId}#call-b#0#a1`]);
      // 소비한 초안은 같은 호출의 늦은 중복 관측에 다시 쓰이지 않는다.
      h.noteSpawned(isolatedCall, "call-b", ids("Fix-2"));
      expect(ledger.records.map((record) => record.type === "dispatch" ? [record.name, record.attemptId, record.agentId, record.ownership?.workspace] : null)).toEqual([
        ["Fix", `${h.sessionId}#call-a#0#a1`, "Fix", "isolated"],
        ["Fix", `${h.sessionId}#call-b#0#a1`, "Fix-2", "isolated"],
      ]);
    });
  });
  test("isolated로 요청한 항목은 별도 worktree scope라 같은 배치 중복으로 막지 않고 workspace를 기록한다", async () => {
    const tasks = [
      { name: "Left", task: brief, assessment: facts },
      { name: "Right", task: brief, assessment: facts },
    ];
    const item = (name: string, extra: Record<string, unknown> = {}) => ({ name, task: brief, agent: "maker", model: `${DEEPSEEK}:auto`, ...extra });
    const spawnIds = new Map([[0, { agentId: "agent-left", jobId: "job-left" }], [1, { agentId: "agent-right", jobId: "job-right" }]]);
    const cases: [Record<string, unknown>, string[] | null][] = [
      [{ context: "c", tasks: [item("Left", { isolated: true }), item("Right")] }, ["isolated", "shared"]],
      [{ context: "c", tasks: [item("Left", { isolated: true }), item("Right", { isolated: true })] }, ["isolated", "isolated"]],
      // core spawnParamsFor처럼 항목 값이 우선이고, 없으면 상위 isolated를 따른다.
      [{ context: "c", isolated: true, tasks: [item("Left", { isolated: false }), item("Right")] }, ["shared", "isolated"]],
      [{ context: "c", isolated: true, tasks: [item("Left", { isolated: false }), item("Right", { isolated: false })] }, null],
      [{ context: "c", isolated: false, tasks: [item("Left"), item("Right")] }, null],
      // 경쟁 후보: isolated "capture" 도 별도 worktree scope라 같은 OWNED_PATHS 둘이 한 배치에서 겹침으로 막히지 않는다.
      [{ context: "c", tasks: [item("Left", { isolated: "capture" }), item("Right", { isolated: "capture" })] }, ["isolated", "isolated"]],
      [{ context: "c", isolated: "capture", tasks: [item("Left"), item("Right")] }, ["isolated", "isolated"]],
      [{ context: "c", isolated: "capture", tasks: [item("Left", { isolated: false }), item("Right")] }, ["shared", "isolated"]],
      [{ context: "c", tasks: [item("Left", { isolated: "capture" }), item("Right")] }, ["isolated", "shared"]],
      // 알 수 없는 문자열은 격리로 보지 않는다(core schema 도 거절한다). 같은 OWNED_PATHS 공유 둘은 그대로 막힌다.
      [{ context: "c", tasks: [item("Left", { isolated: "apply" }), item("Right", { isolated: "apply" })] }, null],
    ];
    for (const [batch, workspaces] of cases) {
      const ledger = memoryLedger();
      const h = harness({ ledger });
      await h.prepare("c", tasks, {} as never);
      const result = await h.beforeTask(batch, {} as never, "batch");
      h.noteSpawned(batch, "batch", spawnIds);
      if (workspaces === null) {
        expect(result).toMatchObject({ block: true });
        expect(ledger.records).toHaveLength(0);
      } else {
        expect(result).toBeUndefined();
        expect(ledger.records.map((record) => record.type === "dispatch" ? record.ownership?.workspace : undefined)).toEqual(workspaces);
      }
    }
  });
  test("active owner 충돌은 양쪽이 공유 작업공간일 때만이고 소유 경로 미상 active owner는 공유 발주 전체를 막는다", async () => {
    const shared = { name: "SharedOwner", primaryDeliverable: "표시 오류 수정", ownedPaths: ["src/"], active: true };
    const isolatedInput = { context: "같은 계약", tasks: [{ name: "ViewFix", task: brief, agent: "maker", model: `${DEEPSEEK}:auto`, isolated: true }] };
    const legacy: Owner = { name: "Legacy", primaryDeliverable: null, ownedPaths: [], ownershipUnknown: true, active: true };
    const cases: [Owner, "shared" | "isolated", boolean][] = [
      [shared, "shared", true],
      [shared, "isolated", false],
      [{ ...shared, workspace: "isolated" }, "shared", false],
      [legacy, "shared", true],
      [legacy, "isolated", false],
      [{ ...legacy, active: false }, "shared", false],
    ];
    for (const [owner, input, blocked] of cases) {
      const h = harness();
      h.setOwners([owner]);
      await h.prepare("같은 계약", [h.task], {} as never);
      const result = await h.beforeTask(input === "shared" ? h.input : isolatedInput, {} as never);
      if (blocked) expect(result).toMatchObject({ block: true, reason: expect.stringContaining(owner.name ?? "") });
      else expect(result).toBeUndefined();
    }
  });
  test("늦은 이전 facts 준비는 최신 binding을 덮지 않고 동일 입력 판단 병합을 보존한다", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const h = harness({
      judgeGate: gate,
      judgeGateOnCall: 1,
      onJudge: () => entered(),
      workClasses: ["NORMAL", "HARD"],
      hardFocuses: ["CODE_SYSTEM", "UI_UX"],
    });
    const stale = h.prepare("이전 facts", [h.task], {} as never);
    await reached;
    const latestTask = {
      ...h.task,
      assessment: { ...facts, facts: ["최신 B facts"] },
    };
    const latest = await h.prepare("최신 facts", [latestTask], {} as never);
    expect(latest[0]!.status).toBe("judged");
    release();
    await expect(stale).rejects.toThrow("더 최신");
    expect(await h.beforeTask({
      ...h.input,
      tasks: [{ ...h.input.tasks[0], model: `${DEEPSEEK}:auto` }],
    }, {} as never)).toBeUndefined();
    expect(h.requests).toHaveLength(2);
  });
  test("assessment 변경은 등급을 포함한 새 판단으로 교체한다", async () => {
    const h = harness();
    await h.prepare("처음 설명", [h.task], {} as never);
    await h.prepare("다른 설명", [{ ...h.task, assessment: { ...facts, unknowns: ["추가로 확인한 미확인 값"] } }], {} as never);
    expect(h.requests.length).toBe(2);
    expect(h.requests[1]!.questions).toHaveProperty("workClass");
    expect(await h.beforeTask(h.input, {} as never)).toBeUndefined();
  });
  test("루브릭 변경은 등급을 다시 묻고 full session reset 뒤에는 재준비가 필요하다", async () => {
    const h = harness();
    await h.prepare("같은 계약", [h.task], {} as never);
    h.policy.modelSelection.criteria.NORMAL += " revised";
    expect(await h.beforeTask(h.input, {} as never)).toMatchObject({ block: true });
    await h.prepare("같은 계약", [h.task], {} as never);
    expect(h.requests.length).toBe(2);
    expect(h.requests[1]!.questions).toHaveProperty("workClass");
    h.reset();
    expect(await h.beforeTask(h.input, {} as never)).toMatchObject({ block: true });
  });
  test("추천 변경과 Jev 불가는 Main 근거를 남기면 진행하며 다른 모델을 호출하지 않는다", async () => {
    for (const fail of [false, true]) {
      const h = harness({ fail });
      const prepared = await h.prepare("같은 계약", [h.task], {} as never);
      expect(prepared[0]!.status).toBe(fail ? "unavailable" : "judged");
      // 추천(NORMAL_DEEPSEEK)과 다른 후보(NORMAL_OPUS)는 추천 변경이라 근거를 요구한다. Jev 불가도 같다.
      const item = { ...h.input.tasks[0], model: "anthropic/claude-opus-5-5:auto" };
      expect(await h.beforeTask({ ...h.input, tasks: [item] }, {} as never)).toMatchObject({ block: true });
      item.task = brief.replace("OWNED_PATHS: src/view.ts", "OWNED_PATHS: src/view.ts\nROUTING_REASON: 두 경합 불변식이 새로 확인되어 Main이 결정함");
      expect(await h.beforeTask({ ...h.input, tasks: [item] }, {} as never)).toBeUndefined();
      expect(h.requests.length).toBe(1);
    }
  });
  test("일시 unavailable 판단은 다음 명시 prepare에서 회복하고 성공 cache는 재사용한다", async () => {
    const h = harness({ failCalls: [1] });
    const unavailable = await h.prepare("일시 실패", [h.task], {} as never);
    expect(unavailable[0]!.status).toBe("unavailable");
    expect(unavailable[0]!.recommendations).toBeNull();
    const recovered = await h.prepare("명시 재준비", [h.task], {} as never);
    expect(recovered[0]!.status).toBe("judged");
    await h.prepare("성공 cache 재사용", [h.task], {} as never);
    expect(h.requests).toHaveLength(2);
    expect(await h.beforeTask(h.input, {} as never)).toBeUndefined();
  });
  test("중단된 SWE 발주는 계속 거절한다", async () => {
    const h = harness();
    await h.prepare("같은 계약", [h.task], {} as never);
    for (const item of [
      { ...h.input.tasks[0], model: "devin/swe-2:auto" },
      { ...h.input.tasks[0], model: "", task: '[character-summon alias="TESTA" model="devin/swe-2"]' },
    ]) expect(await h.beforeTask({ ...h.input, tasks: [item] }, {} as never)).toMatchObject({ block: true });
  });
  test("공백·누락·문자열 아닌 solutionSpace는 full·prepared·batch 어디서든 예약 전에 거절하고 내용이 있으면 통과한다(#57)", async () => {
    // core schema는 공백 문자열을 받고 task 도구는 lenient라 누락·다른 타입도 hook까지 온다. core는 trim 뒤 빈 값을 버리고
    // child 강도를 brief 전문으로 분류하므로, 준비된 설명이 없는 발주는 여기서 막는다.
    const h = harness();
    const other = { name: "OtherFix", task: brief.replace("src/view.ts", "src/other.ts"), assessment: { ...facts, paths: ["src/other.ts"] } };
    const routes = await h.prepare("같은 계약", [h.task, other], {} as never) as { preparedId: string }[];
    const view = (solutionSpace: unknown) => ({ ...h.input.tasks[0], solutionSpace });
    for (const solutionSpace of ["", "   ", "\n\t", undefined, 3]) {
      const blocked = await h.beforeTask({ ...h.input, tasks: [view(solutionSpace)] }, {} as never, "full") as { block: boolean; reason: string };
      expect(blocked).toMatchObject({ block: true });
      expect(blocked.reason).toContain("solutionSpace");
    }
    // prepared 참조도 복원한 뒤 같은 검사를 받는다.
    const referenced = (solutionSpace: unknown) => ({
      context: "PREPARED_CONTEXT",
      tasks: [{ task: `PREPARED_TASK: ${routes[0]!.preparedId}`, model: `${DEEPSEEK}:auto`, solutionSpace }],
    });
    expect(await h.beforeTask(referenced("  "), {} as never, "ref")).toMatchObject({ block: true });
    // batch 하나라도 비면 배치 전체를 막고 앞 항목도 예약하지 않는다: 같은 경로의 다른 호출이 승인 중 예약에 막히지 않는다.
    for (const solutionSpace of [" ", undefined]) {
      const batch = {
        context: "같은 계약",
        tasks: [view("one fix: view label"), { name: other.name, task: other.task, agent: "maker", model: `${DEEPSEEK}:auto`, solutionSpace }],
      };
      expect(await h.beforeTask(batch, {} as never, `blank-batch-${String(solutionSpace)}`)).toMatchObject({ block: true, reason: expect.stringContaining("OtherFix") });
    }
    expect(await h.beforeTask({ ...h.input, tasks: [view("one fix: view label")] }, {} as never, "next-call")).toBeUndefined();
    // 위 호출이 이제 그 경로를 예약했으므로 같은 호출 id로 prepared 통과를 확인한다.
    expect(await h.beforeTask(referenced("one fix: view label"), {} as never, "next-call")).toMatchObject({ input: expect.any(Object) });
    // 대조: 실제로 남은 예약은 다른 호출 id의 같은 경로 발주를 막는다. 위의 거절된 batch가 예약을 남겼다면 next-call이 이렇게 막혔다.
    expect(await h.beforeTask({ ...h.input, tasks: [view("one fix: view label")] }, {} as never, "other-call")).toMatchObject({ block: true });
  });
  test("0.5 이상 판정과 식별 가능한 실재 owner가 함께 있을 때만 기존 owner를 우선한다", async () => {
    const h = harness({ duplicate: 0.5, ownerTarget: "owner0" });
    h.setOwners([{ name: "Existing", primaryDeliverable: "표시 오류 수정", ownedPaths: ["src/view.ts"] }]);
    const prepared = await h.prepare("같은 계약", [h.task], {} as never);
    expect(prepared[0]!.placement).toMatchObject({ action: "retarget-existing", ownerIndex: 0, owner: { name: "Existing" } });
    expect(await h.beforeTask(h.input, {} as never)).toMatchObject({ block: true });
    h.setOwners([]);
    expect(await h.beforeTask(h.input, {} as never)).toMatchObject({ block: true });
    await h.prepare("같은 계약", [h.task], {} as never);
    expect(await h.beforeTask(h.input, {} as never)).toBeUndefined();
  });
  test("추가 지시 판정은 지목한 owner를 반환하고 식별 실패는 새 발주 선택을 막지 않는다", async () => {
    const owner = { name: "Existing", primaryDeliverable: "표시 오류 수정", ownedPaths: ["src/view.ts"] };
    const instruct = harness({ additional: 0.5, ownerTarget: "owner0" });
    instruct.setOwners([owner]);
    expect((await instruct.prepare("", [instruct.task], {} as never))[0]!.placement).toMatchObject({ action: "instruct-existing", owner: { name: "Existing" } });
    const unknown = harness({ additional: 0.9, ownerTarget: "UNKNOWN" });
    unknown.setOwners([owner]);
    expect((await unknown.prepare("", [unknown.task], {} as never))[0]!.placement).toMatchObject({ action: "dispatch-new", owner: null });
    expect(await unknown.beforeTask(unknown.input, {} as never)).toBeUndefined();
  });
  test("TaskGuard 파생 필드는 같은 브리프이고 소유 경로 변경은 다른 브리프다", async () => {
    const h = harness();
    await h.prepare("같은 계약", [h.task], {} as never);
    const derived = brief.replace("OWNED_PATHS:", "PURPOSE: primary\nBLOCKS_PRIMARY: yes\nOWNED_PATHS:");
    expect(await h.beforeTask({ ...h.input, tasks: [{ ...h.input.tasks[0], task: derived }] }, {} as never)).toBeUndefined();
    expect(await h.beforeTask({ ...h.input, tasks: [{ ...h.input.tasks[0], task: derived.replace("src/view.ts", "src/other.ts") }] }, {} as never)).toMatchObject({ block: true });
  });
  test("NORMAL 한도를 모르면 기본 DeepSeek 후보와 unavailable 사유를 유지한다", async () => {
    const h = harness({ workClass: "NORMAL" });
    const batch = await h.prepareBatch("확정 문장 작업", [h.task], {} as never);
    expect(batch.routes[0]).toMatchObject({ profile: "NORMAL_DEEPSEEK", normalAllocation: { state: "unavailable", profile: "NORMAL_DEEPSEEK" } });
    expect(await h.dispatch(`${DEEPSEEK}:auto`)).toBeUndefined();
  });
  test("TaskGuard lock이 확립된 뒤 WORK_CLASS와 PRIMARY_DELIVERABLE을 생략한 child도 연결한다", async () => {
    const h = harness();
    await h.prepare("", [h.task], {} as never);
    expect(await h.beforeTask(h.input, {} as never)).toBeUndefined();
    h.noteSpawned(h.input);
    const inheritedBrief = "TASK_GUARD:\nOWNED_PATHS: src/other.ts\n\n두 번째 child는 lock 값을 상속한다.";
    const inheritedTask = {
      name: "Second",
      task: inheritedBrief,
      assessment: { ...facts, paths: ["src/other.ts"] },
    };
    await h.prepare("표현이 다른 준비 context", [inheritedTask], {} as never);
    expect(await h.beforeTask({
      context: "발주 context",
      tasks: [{
        name: inheritedTask.name,
        task: inheritedBrief,
        agent: "maker",
        model: `${DEEPSEEK}:auto`,
      }],
    }, {} as never)).toBeUndefined();
  });
  test("다른 guard나 task 실패 전의 beforeTask만으로 routing lock을 확립하지 않는다", async () => {
    const h = harness();
    await h.prepare("", [h.task], {} as never);
    expect(await h.beforeTask({
      ...h.input,
      tasks: [{ ...h.input.tasks[0], model: "unknown/unavailable:auto" }],
    }, {} as never)).toMatchObject({ block: true });
    const inheritedTask = {
      name: "Second",
      task: "TASK_GUARD:\nOWNED_PATHS: src/other.ts\n\n실패한 spawn의 lock을 상속하면 안 된다.",
      assessment: { ...facts, paths: ["src/other.ts"] },
    };
    await h.prepare("", [inheritedTask], {});
    const explicitDefault = inheritedTask.task.replace("TASK_GUARD:", "TASK_GUARD:\nWORK_CLASS: feature\nPRIMARY_DELIVERABLE: Second");
    expect(await h.beforeTask({ tasks: [{ name: "Second", task: explicitDefault, model: `${DEEPSEEK}:auto` }] }, {})).toBeUndefined();
  });
  test("TaskGuard 계약을 못 만들면 빠진 필드와 양식을 짚고 판정을 호출하지 않는다", async () => {
    const h = harness();
    const noBlock = { ...h.task, task: "브리프 본문만 있고 guard가 없다." };
    await expect(h.prepare("", [noBlock], {} as never)).rejects.toThrow("`TASK_GUARD:` 블록이 없습니다");
    const noPaths = { ...h.task, task: brief.replace("OWNED_PATHS: src/view.ts\n", "") };
    await expect(h.prepare("", [noPaths], {} as never)).rejects.toThrow("빠진 필드: OWNED_PATHS(모든 child 필수)");
    expect(h.requests).toHaveLength(0);
  });
  test("준비 경계도 WORK_CLASS enum을 거절하고 허용값을 알리며 판정을 호출하지 않는다", async () => {
    const h = harness();
    const invalid = { ...h.task, task: brief.replace("WORK_CLASS: maintenance", "WORK_CLASS: implementation") };
    const error = await h.prepare("", [invalid], {} as never).then(() => undefined, (e: Error) => e.message);
    expect(error).toContain("WORK_CLASS는 feature|maintenance|diagnostic 중 하나여야 합니다");
    expect(error).toContain("implementation");
    expect(h.requests).toHaveLength(0);
  });
  test("prepared 참조는 실제 beforeTask에서 canonical context와 brief로 복원한다", async () => {
    const h = harness();
    const routes = await h.prepare("원래 batch context", [h.task], {} as never);
    const preparedId = (routes[0] as { preparedId: string }).preparedId;
    const referenced = {
      context: "PREPARED_CONTEXT",
      tasks: [{
        name: h.task.name,
        task: `PREPARED_TASK: ${preparedId}`,
        agent: "maker",
        model: `${DEEPSEEK}:auto`,
      }],
    };
    const decision = await h.beforeTask(referenced, {} as never) as {
      input: { context: string; tasks: Array<{ task: string }> };
    };
    expect(decision.input.context).toBe("원래 batch context");
    expect(decision.input.tasks[0]!.task).toBe(brief);
    expect(resolvePreparedTaskInput(decision.input, h.sessionId)).toBe(decision.input);
    expect(h.requests).toHaveLength(1);

    for (const invalid of [
      { ...referenced, context: "다른 context" },
      { ...referenced, tasks: [{ ...referenced.tasks[0], name: "OtherFix" }] },
      { ...referenced, tasks: [{ ...referenced.tasks[0], task: "PREPARED_TASK: missing" }] },
    ]) {
      expect(await h.beforeTask(invalid, {} as never)).toMatchObject({ block: true });
    }
    expect(() => resolvePreparedTaskInput(referenced, "다른-session")).toThrow();
  });
  test("prepared 참조 형식 오류는 벗어난 지점과 올바른 단일 형태를 집는다", async () => {
    const h = harness();
    const routes = await h.prepare("원래 batch context", [h.task], {} as never) as Array<{ preparedId: string }>;
    const preparedId = routes[0]!.preparedId;
    const dispatch = async (task: string, context = "PREPARED_CONTEXT") => (await h.beforeTask({
      context,
      tasks: [{ name: h.task.name, task, agent: "maker", model: `${DEEPSEEK}:auto` }],
    }, {} as never)) as { block: boolean; reason: string };

    const appended = await dispatch(`PREPARED_TASK: ${preparedId}\n\n덧붙인 본문`);
    expect(appended).toMatchObject({ input: { tasks: [expect.objectContaining({ task: `${brief}\n덧붙인 본문` })] } });

    const badId = await dispatch(`PREPARED_TASK: ${preparedId}/x`);
    expect(badId.reason).toContain("preparedId 형식이 아닙니다");
    expect(badId.reason).toContain("허용 문자: A-Za-z0-9._-");

    const wrongContext = await dispatch(`PREPARED_TASK: ${preparedId}`, "다른 context");
    expect(wrongContext.reason).toContain("'PREPARED_CONTEXT'로 보내야 합니다");
    expect(wrongContext.reason).toContain("받은 값 '다른 context'");

    const unknown = await dispatch("PREPARED_TASK: missing");
    expect(unknown.reason).toContain("'missing'");
    expect(unknown.reason).toContain(`이 session에 준비된 참조: ${preparedId}`);

    const missingName = await h.beforeTask({
      context: "PREPARED_CONTEXT",
      tasks: [{ name: "OtherFix", task: `PREPARED_TASK: ${preparedId}` }],
    }, {} as never) as { block: boolean; reason: string };
    expect(missingName.reason).toContain("prepared task name이 일치하지 않습니다: prepared='ViewFix' 발주='OtherFix'");
    for (const name of ["", "  ", 7]) {
      const bad = await h.beforeTask({
        context: "PREPARED_CONTEXT",
        tasks: [{ name, task: `PREPARED_TASK: ${preparedId}` }],
      }, {} as never) as { block: boolean; reason: string };
      expect(bad.reason).toContain("prepared task name이 일치하지 않습니다: prepared='ViewFix'");
    }

    // 이름을 생략한 참조는 준비한 name으로 복원돼 같은 계약으로 발주된다. 후속 hook은 복원된 name을 본다.
    const restored = resolvePreparedTaskInput({
      context: "PREPARED_CONTEXT",
      tasks: [{ task: `PREPARED_TASK: ${preparedId}`, model: `${DEEPSEEK}:auto` }],
    }, h.sessionId) as { tasks: Array<Record<string, unknown>> };
    expect(restored.tasks[0]).toMatchObject({ name: "ViewFix", task: brief, model: `${DEEPSEEK}:auto` });
    const omitted = await h.beforeTask({
      context: "PREPARED_CONTEXT",
      tasks: [{ task: `PREPARED_TASK: ${preparedId}`, model: `${DEEPSEEK}:auto` }],
    }, {} as never) as { block?: boolean; input?: { tasks: Array<Record<string, unknown>> } };
    expect(omitted.block).toBeUndefined();
    expect(omitted.input?.tasks[0]).toMatchObject({ name: "ViewFix", task: brief });
    expect(() => resolvePreparedTaskInput({
      context: "PREPARED_CONTEXT",
      tasks: [{ task: `PREPARED_TASK: ${preparedId}` }],
    }, "다른-session")).toThrow();
  });
  test("서로 다른 module instance도 같은 prepared store와 증가 ID를 공유한다", async () => {
    // legacy loader의 entry별 module 평가 경계를 재현하므로 static import 하나로는 이 계약을 검사할 수 없다.
    const first = await import("../lib/prepared-task?routing-copy-a");
    const second = await import("../lib/prepared-task?routing-copy-b");
    expect(first).not.toBe(second);
    const sessionId = "sample";
    const [preparedId] = first.storePreparedTaskBatch(
      "공유 context",
      [{ name: "Shared", task: "공유 원문" }],
      sessionId,
    );
    expect(second.resolvePreparedTaskInput({
      context: "PREPARED_CONTEXT",
      name: "Shared",
      task: `PREPARED_TASK: ${preparedId}`,
    }, sessionId)).toMatchObject({ context: "공유 context", task: "공유 원문" });
    expect(() => second.resolvePreparedTaskInput({
      context: "PREPARED_CONTEXT",
      name: "Shared",
      task: `PREPARED_TASK: ${preparedId}`,
    }, "다른-session")).toThrow();

    second.clearPreparedTaskSession(sessionId);
    expect(() => first.resolvePreparedTaskInput({
      context: "PREPARED_CONTEXT",
      name: "Shared",
      task: `PREPARED_TASK: ${preparedId}`,
    }, sessionId)).toThrow();
    const [nextId] = second.storePreparedTaskBatch(
      "다음 context",
      [{ name: "Shared", task: "다음 원문" }],
      sessionId,
    );
    expect(nextId).not.toBe(preparedId);
    expect(() => first.resolvePreparedTaskInput({
      context: "PREPARED_CONTEXT",
      name: "Shared",
      task: `PREPARED_TASK: ${preparedId}`,
    }, sessionId)).toThrow();
    first.clearPreparedTaskSession(sessionId);
  });

  test("mixed full/ref는 복원하고 다른 batch 참조 조합은 거절한다", async () => {
    const h = harness();
    const second = {
      name: "Second",
      task: brief.replace("src/view.ts", "src/second.ts"),
      assessment: { ...facts, paths: ["src/second.ts"] },
    };
    const routes = await h.prepare("공유 context", [h.task, second], {} as never) as Array<{ preparedId: string }>;
    const restored = resolvePreparedTaskInput({
      context: "PREPARED_CONTEXT",
      tasks: [
        { name: h.task.name, task: `PREPARED_TASK: ${routes[0]!.preparedId}` },
        { name: second.name, task: `PREPARED_TASK: ${routes[1]!.preparedId}` },
      ],
    }, h.sessionId);
    expect(restored.context).toBe("공유 context");
    expect((restored.tasks as Array<{ task: string }>)[1]!.task).toBe(second.task);
    expect(resolvePreparedTaskInput({
      context: "PREPARED_CONTEXT",
      tasks: [
        { name: h.task.name, task: `PREPARED_TASK: ${routes[0]!.preparedId}` },
        { name: second.name, task: second.task },
      ],
    }, h.sessionId)).toMatchObject({ tasks: [{ name: h.task.name, task: brief }, { name: second.name, task: second.task }] });

    const other = await h.prepare("다른 context", [{ ...second, name: "Third" }], {} as never) as Array<{ preparedId: string }>;
    expect(() => resolvePreparedTaskInput({
      context: "PREPARED_CONTEXT",
      tasks: [
        { name: h.task.name, task: `PREPARED_TASK: ${routes[0]!.preparedId}` },
        { name: "Third", task: `PREPARED_TASK: ${other[0]!.preparedId}` },
      ],
    }, h.sessionId)).toThrow();
  });
});

describe("블라인드 입력과 독립 질문", () => {
  test("구조 밖 모델 필드는 버리고 정상 prose와 설정명은 그대로 전달한다", () => {
    const state = routingState({
      ...facts,
      facts: ["일반 단어와 gpt-5.6-terra 설정명을 문서에서 확인했다"],
      currentModel: "secret-model",
      desiredGrade: "max",
    } as RoutingFacts, []);
    expect(JSON.stringify(state)).not.toContain("secret-model");
    expect(JSON.stringify(state)).not.toContain("desiredGrade");
    expect(state.facts).toEqual(["일반 단어와 gpt-5.6-terra 설정명을 문서에서 확인했다"]);
    const policy = loadRoutingPolicy();
    const questions = routingQuestions(policy, []);
    expect(questions.workClass!.criteria).toEqual(policy.modelSelection.criteria);
    expect(questions).not.toHaveProperty("easyFocus");
    expect(Object.keys(policy.modelSelection.criteria)).toEqual(["NORMAL", "HARD"]);
    const ownerQuestions = routingQuestions(policy, [{ name: "Existing", primaryDeliverable: "x", ownedPaths: ["x.ts"] }]);
    expect(ownerQuestions.duplicate!.type).toBe("noul");
    expect(ownerQuestions.ownerTarget!.criteria).toHaveProperty("owner0");
    expect(state.unknowns).toEqual(facts.unknowns);
  });
});

describe("후보 provider 갱신 공유와 잔량 예산", () => {
  // registry 경로를 실제로 도는 하네스. deps.candidates를 주입하지 않는다.
  const profileModels: Record<string, string> = {
    NORMAL_SONNET: SONNET,
    NORMAL_OPUS: "anthropic/claude-opus-5-5",
    HARD_UI_OPUS: "anthropic/claude-opus-5-5",
    HARD_CODE_OPUS: "anthropic/claude-opus-5-5",
    HARD_CODE_SONNET: SONNET,
    HARD_UI_SONNET: SONNET,
    NORMAL_DEEPSEEK: DEEPSEEK,
    HARD_CODE_DEEPSEEK: DEEPSEEK,
    NORMAL_SOL: "openai-codex/gpt-6.1-sol",
    HARD_CODE_TERRA: "openai-codex/gpt-6.1-sol",
    HARD_CODE_SOL61: "openai-codex/gpt-6.1-sol",
  };
  const strengths = ["low", "medium", "high", "xhigh", "max"];
  const normalAnswers = {
    workClass: { choice: "NORMAL" }, hardFocus: { choice: "CODE_SYSTEM" },
    uiUxBoundary: { noul: 0 }, designOpen: { noul: 0 }, uiDifficulty: { choice: "NONE" }, boundedDesign: { choice: "NONE" },
  };
  function registryHarness(options: { registry: unknown; useSidecar?: boolean; sessionId?: string; omitRoles?: string[] }) {
    const routingPolicy = loadRoutingPolicy();
    const modelRoles: Record<string, string> = {};
    for (const [profile, entry] of Object.entries(routingPolicy.modelSelection.profiles)) {
      const model = profileModels[profile];
      if (!model) throw new Error(`fixture에 ${profile} 모델 매핑이 없다`);
      const slot = entry.modelConfigPath.slice("modelRoles.".length);
      if (!options.omitRoles?.includes(slot)) modelRoles[slot] = model;
    }
    const questions: Record<string, unknown>[] = [];
    const ctx = {
      sessionManager: { getSessionId: () => options.sessionId ?? "registry-harness" },
      models: { current: () => undefined },
      modelRegistry: options.registry,
    } as never;
    const route = registerMakerRouting({} as never, {
      policy: () => routingPolicy,
      settings: async () => ({ getModelRoles: () => modelRoles }),
      owners: () => [],
      // useSidecar면 실제 readSidecarQuota가 OMP_USAGE_PORT로 돈다.
      ...(options.useSidecar ? {} : { quota: async () => ({ state: "unavailable", observedAt: 0, reason: "test harness" }) }),
      judge: async (_ctx, request) => {
        questions.push(request.questions);
        return { answers: normalAnswers };
      },
    });
    return { route, ctx, questions, policy: routingPolicy, task: { name: "ViewFix", task: brief, assessment: facts } };
  }
  const dispatchInput = (task: { name: string }, model = `${DEEPSEEK}:auto`) => ({
    context: "계약", tasks: [{ name: task.name, task: brief, agent: "maker", model }],
  });

  test("같은 호출의 후보 해석은 provider마다 한 번만, 서로 다른 provider는 함께 갱신한다", async () => {
    const ready = new Set<string>();
    const refreshCalls: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const registry = {
      find: (provider: string) => (ready.has(provider) ? { thinking: { efforts: strengths } } : undefined),
      refreshDiscoverableProviders: async ([provider]: string[]) => {
        refreshCalls.push(provider);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        ready.add(provider);
      },
    };
    const h = registryHarness({ registry });
    const batch = await h.route.prepareBatch("계약", [h.task], h.ctx);
    // 모든 provider가 첫 await 전에 진입해야 병렬이다.
    expect(maxInFlight).toBe(new Set(Object.values(profileModels).map((model) => model.split("/")[0])).size);
    expect(new Set(refreshCalls).size).toBe(refreshCalls.length);
    // 순서는 정본 profile 순서 그대로다.
    expect(batch.candidates.map((candidate) => candidate.profile)).toEqual(Object.keys(h.policy.modelSelection.profiles));
    expect(batch.unavailableCandidates).toEqual([]);
  });

  test("명시 후보 slot이 없으면 그 후보만 unavailable이고 다른 모델로 대체되지 않는다", async () => {
    const registry = { find: (provider: string) => provider ? { thinking: { efforts: strengths } } : undefined, refreshDiscoverableProviders: async () => {} };
    const h = registryHarness({ registry, omitRoles: ["makerHardCodeOpus"] });
    const batch = await h.route.prepareBatch("계약", [h.task], h.ctx);
    expect(batch.unavailableCandidates.map(({ profile, model }) => ({ profile, model }))).toEqual([
      { profile: "HARD_CODE_OPUS", model: "" },
    ]);
    expect(batch.candidates.map((candidate) => candidate.profile)).not.toContain("HARD_CODE_OPUS");
  });

  test("준비에서 실패한 provider는 같은 발주에서 재조회하지 않고 새 준비에서는 다시 시도한다", async () => {
    const refreshCalls: string[] = [];
    const registry = {
      find: (provider: string) => provider === "anthropic" ? undefined : { thinking: { efforts: strengths } },
      refreshDiscoverableProviders: async ([provider]: string[]) => { refreshCalls.push(provider); throw new Error("offline"); },
    };
    const h = registryHarness({ registry });
    // 같은 배치의 공유 작업공간 Maker는 소유 경로가 겹치면 막히므로 task마다 다른 파일을 소유한다.
    const tasks = ["FixA", "FixB", "FixC"].map((name) => ({ name, task: brief.replace("src/view.ts", `src/${name}.ts`), assessment: facts }));
    const batch = await h.route.prepareBatch("계약", tasks, h.ctx);
    expect(batch.unavailableCandidates.map((entry) => entry.profile)).toEqual(["NORMAL_SONNET", "NORMAL_OPUS", "HARD_UI_OPUS", "HARD_CODE_OPUS", "HARD_CODE_SONNET", "HARD_UI_SONNET"]);
    expect(refreshCalls.filter((provider) => provider === "anthropic")).toHaveLength(1);
    refreshCalls.length = 0;
    const input = {
      context: "계약",
      tasks: tasks.map((entry) => ({ name: entry.name, task: entry.task, agent: "maker", model: `${DEEPSEEK}:auto` })),
    };
    expect(await h.route.beforeTask(withSolutionSpace(input), h.ctx)).toBeUndefined();
    expect(refreshCalls).toEqual([]);
    await h.route.prepareBatch("새 준비", tasks, h.ctx);
    expect(refreshCalls.filter((provider) => provider === "anthropic")).toHaveLength(1);
    h.route.reset();
    refreshCalls.length = 0;
    await h.route.prepareBatch("reset 뒤 준비", tasks, h.ctx);
    expect(refreshCalls.filter((provider) => provider === "anthropic")).toHaveLength(1);
  });

  test("준비 뒤 registry 후보가 바뀌면 공유 갱신으로도 dispatch를 통과하지 않는다", async () => {
    let drifted = false;
    const registry = {
      find: () => ({ thinking: { efforts: drifted ? ["low", "high", "max"] : strengths } }),
      refreshDiscoverableProviders: async () => {},
    };
    const h = registryHarness({ registry });
    await h.route.prepareBatch("계약", [h.task], h.ctx);
    drifted = true;
    expect(await h.route.beforeTask(withSolutionSpace(dispatchInput(h.task)), h.ctx)).toMatchObject({ block: true });
  });

  test("갱신 뒤 찾은 후보도 추론 단계를 선언하지 않으면 auto로 고를 수 없어 발주 후보에서 제외된다", async () => {
    const refreshed = new Set<string>();
    const registry = {
      find: (provider: string) => {
        if (provider !== "anthropic") return { thinking: { efforts: strengths } };
        return refreshed.has(provider) ? {} : undefined;
      },
      refreshDiscoverableProviders: async ([provider]: string[]) => { refreshed.add(provider); },
    };
    const h = registryHarness({ registry });
    const batch = await h.route.prepareBatch("계약", [h.task], h.ctx);
    expect(batch.candidates.map((candidate) => candidate.profile)).toEqual(["NORMAL_DEEPSEEK", "HARD_CODE_DEEPSEEK", "NORMAL_SOL", "HARD_CODE_TERRA", "HARD_CODE_SOL61"]);
    expect(batch.unavailableCandidates.map(({ profile, model }) => ({ profile, model }))).toEqual([
      { profile: "NORMAL_SONNET", model: SONNET },
      { profile: "NORMAL_OPUS", model: "anthropic/claude-opus-5-5" },
      { profile: "HARD_UI_OPUS", model: "anthropic/claude-opus-5-5" },
      { profile: "HARD_CODE_OPUS", model: "anthropic/claude-opus-5-5" },
      { profile: "HARD_CODE_SONNET", model: SONNET },
      { profile: "HARD_UI_SONNET", model: SONNET },
    ]);
    expect(batch.unavailableCandidates[0]!.reason).toBe("auto로 고를 추론 강도를 확인할 수 없는 후보");
  });

});

describe("HARD 분야와 NORMAL 한도 기반 배정", () => {
  type Options = NonNullable<Parameters<typeof harness>[0]>;
  test("Jev routes settled work to DeepSeek, difficult UI to Opus, bounded design/rework to Sol, and open design/repeated failure to Main", async () => {
    const rework = { task: reworkTaskBrief };
    type Row = [string, Options & { task?: string }, string | null];
    const rows: Row[] = [
      ["확정된 구현 → DeepSeek", {}, "NORMAL_DEEPSEEK"],
      ["보통 UI(기존 패턴 안의 UI 판단) → Sonnet", { uiUxBoundary: 1, uiDifficulty: "ROUTINE" }, "NORMAL_SONNET"],
      ["HARD + 보통 UI → HARD UI Sonnet", { workClass: "HARD", hardFocuses: ["UI_UX"], uiDifficulty: "ROUTINE" }, "HARD_UI_SONNET"],
      ["보통 UI와 한정된 설계가 함께면 Sol이 먼저다", { uiDifficulty: "ROUTINE", boundedDesign: "BOUNDED" }, "NORMAL_SOL"],
      ["보통 UI의 한정된 실패 재작업도 Sol이 먼저다", { uiDifficulty: "ROUTINE", reworkNature: "BOUNDED_FAILURE" }, "NORMAL_SOL"],
      ["보통 UI인데 Sonnet이 없으면 추천 없음(DeepSeek·Opus로 대체하지 않음)", { uiDifficulty: "ROUTINE", candidates: without("NORMAL_SONNET") }, null],
      ["보통 UI여도 반복 실패면 Main이 먼저다", { uiDifficulty: "ROUTINE", reworkNature: "RETURN_TO_MAIN" }, null],
      ["UI 경계만으로 어렵다고 보지 않는다(NONE)", { uiUxBoundary: 1, uiDifficulty: "NONE" }, "NORMAL_DEEPSEEK"],
      ["정말 어려운 UI → Opus", { uiUxBoundary: 1, uiDifficulty: "DIFFICULT" }, "NORMAL_OPUS"],
      ["HARD 코드, 방향 확정 → HARD DeepSeek", { workClass: "HARD", hardFocuses: ["CODE_SYSTEM"] }, "HARD_CODE_DEEPSEEK"],
      ["HARD 라벨·UI_UX 분야만으로는 Opus가 아니다", { workClass: "HARD", hardFocuses: ["UI_UX"] }, "HARD_CODE_DEEPSEEK"],
      ["HARD + 어려운 UI → HARD UI Opus", { workClass: "HARD", hardFocuses: ["UI_UX"], uiDifficulty: "DIFFICULT" }, "HARD_UI_OPUS"],
      ["Bounded design uses Sol", { boundedDesign: "BOUNDED" }, "NORMAL_SOL"],
      ["HARD bounded design uses Sol61", { workClass: "HARD", hardFocuses: ["CODE_SYSTEM"], boundedDesign: "BOUNDED" }, "HARD_CODE_SOL61"],
      ["준비된 복잡한 상태 구현(boundedDesign NONE)은 DeepSeek", { boundedDesign: "NONE", designOpen: 0.2 }, "NORMAL_DEEPSEEK"],
      ["한정된 설계도 큰 교차 경계 재설계(designOpen 높음)면 Main이 먼저다", { boundedDesign: "BOUNDED", designOpen: 0.8 }, null],
      ["한정된 설계도 반복 실패면 Main이 먼저다", { boundedDesign: "BOUNDED", reworkNature: "RETURN_TO_MAIN" }, null],
      ["boundedDesign UNKNOWN은 추천 없음(Opus로 올리지 않음)", { boundedDesign: "UNKNOWN" }, null],
      ["boundedDesign 무응답도 모름이라 추천 없음", { boundedDesign: null }, null],
      ["어려운 UI와 한정된 설계가 함께여도 Opus 하나(어려운 UI 우선)", { uiDifficulty: "DIFFICULT", boundedDesign: "BOUNDED" }, "NORMAL_OPUS"],
      ["열린 설계 → Main", { designOpen: 0.5 }, null],
      ["designOpen 무응답은 모름(UNKNOWN): 추천 없음이지만 막지 않는다", { designOpen: null }, null],
      ["HARD 열린 설계 → Main", { workClass: "HARD", hardFocuses: ["CODE_SYSTEM"], designOpen: 0.9 }, null],
      ["UI 난이도 UNKNOWN은 보통도 어려움도 아니라 추천 없음(Opus로 올리지 않음)", { uiUxBoundary: 1, uiDifficulty: "UNKNOWN" }, null],
      ["UI 난이도 무응답도 모름이라 추천 없음", { uiUxBoundary: 1, uiDifficulty: null }, null],
      ["HARD에서도 UI 난이도 모름이면 추천 없음", { workClass: "HARD", hardFocuses: ["CODE_SYSTEM"], uiDifficulty: "UNKNOWN" }, null],
      ["열린 설계는 UI 난이도 모름보다 먼저 Main으로 돌아온다", { designOpen: 0.9, uiDifficulty: "UNKNOWN" }, null],
      ["Bounded failed rework uses Sol", { ...rework, reworkNature: "BOUNDED_FAILURE" }, "NORMAL_SOL"],
      ["HARD bounded rework uses Sol61", { ...rework, reworkNature: "BOUNDED_FAILURE", workClass: "HARD", hardFocuses: ["CODE_SYSTEM"] }, "HARD_CODE_SOL61"],
      ["반복 실패 → Main", { ...rework, reworkNature: "RETURN_TO_MAIN" }, null],
      ["반복 실패는 어려운 UI여도 Main이 먼저다", { ...rework, reworkNature: "RETURN_TO_MAIN", uiDifficulty: "DIFFICULT", uiUxBoundary: 1 }, null],
      ["의도한 RED·인프라·검증 보정은 실패가 아니라 DeepSeek", { ...rework, reworkNature: "NOT_FAILURE" }, "NORMAL_DEEPSEEK"],
      ["실패 근거 없는 재작업 표기(NONE)도 DeepSeek", { ...rework, reworkNature: "NONE" }, "NORMAL_DEEPSEEK"],
      ["FINDING_ID 표기가 없어도 Jev가 반복 실패로 보면 Main이 먼저다", { reworkNature: "RETURN_TO_MAIN" }, null],
      ["Bounded failed rework without FINDING_ID uses Sol", { reworkNature: "BOUNDED_FAILURE" }, "NORMAL_SOL"],
      ["DeepSeek가 없으면 Opus로 자동 대체하지 않고 추천 없음(Main이 다시 판단)", { candidates: without("NORMAL_DEEPSEEK") }, null],
      ["HARD DeepSeek가 없으면 HARD Opus로 자동 대체하지 않고 추천 없음", { workClass: "HARD", candidates: without("HARD_CODE_DEEPSEEK") }, null],
      ["어려운 UI인데 Opus가 없으면 추천 없음(Sonnet·Sol로 올리지 않음)", { uiDifficulty: "DIFFICULT", candidates: without("NORMAL_OPUS") }, null],
      ["어려운 UI인데 HARD Opus가 없으면 추천 없음", { workClass: "HARD", hardFocuses: ["UI_UX"], uiDifficulty: "DIFFICULT", candidates: without("HARD_UI_OPUS") }, null],
      ["DeepSeek·Opus가 모두 없으면 추천 없음", { candidates: without("NORMAL_DEEPSEEK", "NORMAL_OPUS") }, null],
      ["Jev 실패 → 추천 없음", { fail: true }, null],
    ];
    for (const [label, { task: taskBrief, ...options }, expected] of rows) {
      // Main 계열이 달라도 추천은 같다.
      for (const main of [CODEX_MAIN, ANTHROPIC_MAIN, null]) {
        const h = harness({ ...options, main });
        const task = taskBrief ? { ...h.task, task: taskBrief } : h.task;
        const [route] = await h.prepare("matrix", [task], {} as never);
        expect(route!.profile, `${label} / ${main?.provider ?? "main 없음"}`).toBe(expected);
        if (expected === null && !options.fail) {
          const allocation = options.workClass === "HARD" ? route!.hardAllocation : route!.normalAllocation;
          expect(allocation, label).toMatchObject({ profile: null, reason: expect.stringContaining("Main") });
        }
      }
    }
  });
  test("Anthropic 하루 몫 소진은 Maker 추천·발주를 바꾸지 않고, 실제 사용 불가는 관측 소진으로 남는다", async () => {
    // 2026-11-11 사용자 정정: 하루 몫 예외는 새 최상위 세션(모델 미지정)만이며 Maker는 동작해야 한다.
    const anthropic = (used: number, over: { limitReached?: boolean } = {}) => async () => ({
      state: "observed", observedAt: 1,
      providers: { anthropic: [9, 11].map((credentialId) => ({
        credentialId, disabled: false, limitReached: over.limitReached ?? false, autoBlockedUntilMs: null, fetchedAt: 1,
        limits: [{ id: "anthropic:7d", windowId: "7d", shared: true, resetsAt: 100,
          usedFraction: 0.2, daySlot: { usedPct: used, quotaPct: 14.29, slotsLeft: 7, quality: "exact" } }],
      })) },
    }) as never;
    const overDaySlot = anthropic(15);
    for (const workClass of ["NORMAL", "HARD"]) {
      const expected = workClass === "HARD" ? "HARD_UI_OPUS" : "NORMAL_OPUS";
      for (const quota of [anthropic(10), overDaySlot]) {
        const h = harness({ workClass, uiDifficulty: "DIFFICULT", quota });
        const batch = await h.prepareBatch("day slot", [h.task], h.ctx);
        expect(batch.routes[0]!.profile).toBe(expected);
        // 하루 몫만으로는 Opus 발주에 근거를 더 요구하지 않는다.
        expect(await h.dispatch(`${OPUS}:auto`)).toBeUndefined();
      }
    }
    // 다른 명시 Anthropic 후보도 하루 몫 때문에 추가로 막히지 않는다(기존 추천 변경 근거 규칙만 적용된다).
    const settled = harness({ workClass: "NORMAL", quota: overDaySlot });
    await settled.prepare("명시 후보", [settled.task], {} as never);
    const reasoned = brief.replace("OWNED_PATHS: src/view.ts", "OWNED_PATHS: src/view.ts\nROUTING_REASON: Main이 명시 후보로 선택함");
    expect(await settled.dispatch(`${OPUS}:auto`, reasoned)).toBeUndefined();
    expect(await settled.dispatch(`${SONNET}:auto`, reasoned)).toBeUndefined();
    // 실제 사용 불가(한도 도달)는 대체가 아니라 추천 없음으로 남는다.
    const spent = harness({ workClass: "NORMAL", uiDifficulty: "DIFFICULT", quota: anthropic(10, { limitReached: true }) });
    const [spentRoute] = await spent.prepare("실제 소진", [spent.task], {} as never);
    expect(spentRoute).toMatchObject({ profile: null, normalAllocation: { profile: null, returnToMain: false } });
  });
  test("DeepSeek 후보는 한도로 소진돼도 Opus로 내려가지 않고 추천 없음이며, 미관측은 소진이 아니고 막지도 않는다", async () => {
    const spent = { limitReached: true, limits: [] };
    const observed = (providers: Record<string, unknown[]>) => async () => ({ state: "observed", observedAt: 1, providers }) as never;
    // 미관측: DeepSeek 유지, 사유에 남긴다.
    const blind = harness();
    const [blindRoute] = await blind.prepare("한도 미관측", [blind.task], {} as never);
    expect(blindRoute!.normalAllocation).toMatchObject({
      state: "unavailable", profile: "NORMAL_DEEPSEEK", reason: expect.stringContaining("한도 미관측은 소진이 아닙니다"),
    });
    // 관측된 정상 한도: DeepSeek.
    const fine = harness({ quota: observed({ hive: [{ limitReached: false, limits: [] }] }) });
    expect((await fine.prepare("정상", [fine.task], {} as never))[0]!.normalAllocation).toMatchObject({ state: "observed", profile: "NORMAL_DEEPSEEK" });
    // DeepSeek 소진: Opus가 멀쩡해도 자동 대체 없이 추천 없음. 구조 차단이 아니라 Main 재판단이라 returnToMain은 false다.
    const dsSpent = harness({ quota: observed({ hive: [spent] }) });
    const [dsSpentRoute] = await dsSpent.prepare("DeepSeek 소진", [dsSpent.task], {} as never);
    expect(dsSpentRoute).toMatchObject({ profile: null, normalAllocation: { profile: null, returnToMain: false } });
    // 다른 provider의 소진은 DeepSeek 추천을 바꾸지 않는다.
    const others = harness({ quota: observed({ anthropic: [spent], "openai-codex": [spent] }) });
    expect((await others.prepare("다른 provider 소진", [others.task], {} as never))[0]!.profile).toBe("NORMAL_DEEPSEEK");
    // 어려운 UI는 Opus 소진 시 추천 없음. DeepSeek로 내려가지 않는다.
    const uiSpent = harness({ uiDifficulty: "DIFFICULT", quota: observed({ anthropic: [spent] }) });
    expect((await uiSpent.prepare("UI Opus 소진", [uiSpent.task], {} as never))[0]!.profile).toBeNull();
  });
  test("추천 후보는 ROUTING_REASON 없이 발주되고, Sonnet·Opus·Sol은 의도한 예외로 ROUTING_REASON이 있어야 auto로 발주된다", async () => {
    const reasoned = brief.replace("OWNED_PATHS: src/view.ts", "OWNED_PATHS: src/view.ts\nROUTING_REASON: Main이 계약 근거로 의도한 예외를 선택함");
    const h = harness();
    const [route] = await h.prepare("명시 대안", [h.task], {} as never);
    expect(route!.profile).toBe("NORMAL_DEEPSEEK");
    expect(await h.dispatch(`${DEEPSEEK}:auto`)).toBeUndefined();
    for (const alternative of [SONNET, "anthropic/claude-opus-5-5", "openai-codex/gpt-6.1-sol"]) {
      // 추천 변경에는 근거가 필요하다. concrete suffix는 auto로 보정한다.
      expect(await h.dispatch(`${alternative}:auto`), alternative).toMatchObject({ block: true });
      expect(await h.dispatch(`${alternative}:auto`, reasoned), alternative).toBeUndefined();
      expect(await h.dispatch(`${alternative}:high`, reasoned), alternative).toMatchObject({ input: { tasks: [expect.objectContaining({ model: `${alternative}:auto` })] } });
    }
    // 어려운 UI의 추천은 Opus이고 DeepSeek·Sonnet은 근거가 있어야 한다. 추천이 없는 Main 반환 route도 근거 없이는 발주할 수 없다.
    const ui = harness({ uiDifficulty: "DIFFICULT" });
    expect((await ui.prepare("어려운 UI", [ui.task], {} as never))[0]!.profile).toBe("NORMAL_OPUS");
    expect(await ui.dispatch(`${OPUS}:auto`)).toBeUndefined();
    for (const alternative of [`${DEEPSEEK}:auto`, `${SONNET}:auto`]) {
      expect(await ui.dispatch(alternative), alternative).toMatchObject({ block: true });
    }
    const open = harness({ designOpen: 0.9 });
    expect((await open.prepare("열린 설계", [open.task], {} as never))[0]!.profile).toBeNull();
    // 해결되지 않은 구조 결정은 어떤 후보도, 임의의 ROUTING_REASON으로도 발주할 수 없다.
    for (const model of [DEEPSEEK, SONNET, OPUS]) {
      expect(await open.dispatch(`${model}:auto`, reasoned), model).toMatchObject({ block: true, reason: expect.stringContaining("maker_route를 다시 실행") });
    }
    // 모름(UNKNOWN)은 막지 않는다: 근거 없이는 막히고, Main이 ROUTING_REASON으로 정하면 기존 경로로 발주된다. 비싼 모델로 자동 승격하지 않는다.
    const unknown = harness({ designOpen: null });
    expect((await unknown.prepare("모름", [unknown.task], {} as never))[0]!.normalAllocation).toMatchObject({ profile: null, returnToMain: false });
    expect(await unknown.dispatch(`${DEEPSEEK}:auto`)).toMatchObject({ block: true });
    expect(await unknown.dispatch(`${DEEPSEEK}:auto`, reasoned)).toBeUndefined();
    const jevDown = harness({ fail: true });
    expect((await jevDown.prepare("Jev 불가", [jevDown.task], {} as never))[0]!.profile).toBeNull();
    expect(await jevDown.dispatch(`${DEEPSEEK}:auto`, reasoned)).toBeUndefined();
  });
  test("등급 답이 없는 부분 판정도 이미 드러난 열린 설계·반복 실패를 막고, 증거 없는 미분류는 막지 않는다", async () => {
    const reasoned = brief.replace("OWNED_PATHS: src/view.ts", "OWNED_PATHS: src/view.ts\nROUTING_REASON: 부분 판정에도 Main이 정함");
    for (const options of [{ designOpen: 0.8 }, { reworkNature: "RETURN_TO_MAIN" }]) {
      const h = harness({ workClass: "UNCLASSIFIED", uiDifficulty: "NONE", ...options });
      const [route] = await h.prepare("부분 판정", [h.task], {} as never);
      expect(route!.profile).toBeNull();
      expect(route!.normalAllocation).toMatchObject({ returnToMain: true });
      expect(await h.dispatch(`${DEEPSEEK}:auto`, reasoned), JSON.stringify(options)).toMatchObject({ block: true, reason: expect.stringContaining("maker_route를 다시 실행") });
    }
    const none = harness({ workClass: "UNCLASSIFIED", uiDifficulty: "NONE" });
    const [route] = await none.prepare("증거 없음", [none.task], {} as never);
    expect(route!.profile).toBeNull();
    expect(route!.normalAllocation).toBeNull();
    expect(await none.dispatch(`${DEEPSEEK}:auto`, reasoned)).toBeUndefined();
  });
  test("반복 실패 결정은 FINDING_ID 없이도 모든 후보를 막고, Main이 사실을 바꿔 다시 준비한 판단만 발주된다", async () => {
    const reasoned = brief.replace("OWNED_PATHS: src/view.ts", "OWNED_PATHS: src/view.ts\nROUTING_REASON: 같은 접근을 한 번 더 시도함");
    const h = harness({ reworkNatures: ["RETURN_TO_MAIN", "NONE"], uiDifficulty: "DIFFICULT" });
    const [first] = await h.prepare("반복 실패", [h.task], {} as never);
    expect(first!.profile).toBeNull();
    expect(first!.normalAllocation).toMatchObject({ returnToMain: true, reason: expect.stringContaining("maker_route를 다시 실행") });
    expect(await h.dispatch(`${OPUS}:auto`, reasoned)).toMatchObject({ block: true });
    // Main이 접근을 바꾼 사실로 다시 준비하면 새 판단이 나오고 과거 실패 기록만으로 계속 막히지 않는다.
    const revised = { ...h.task, assessment: { ...facts, settledImplementation: ["상태 소유자를 store로 옮기는 새 접근으로 확정"], failureEvidence: ["이전 접근은 갱신 시점이 둘로 갈려 실패함"] } };
    const [second] = await h.prepare("접근 변경", [revised], {} as never);
    expect(second!.normalAllocation).toMatchObject({ returnToMain: false });
    expect(second!.profile).toBe("NORMAL_OPUS");
    expect(await h.dispatch(`${OPUS}:auto`)).toBeUndefined();
    expect(h.requests).toHaveLength(2);
  });
  test("기존 owner 충돌은 추천과 상관없이 새 발주를 막는다", async () => {
    const h = harness();
    h.setOwners([{ name: "Existing", primaryDeliverable: "표시 오류 수정", ownedPaths: ["src/view.ts"], active: true }]);
    await h.prepare("owner 보존", [h.task], {} as never);
    expect(await h.dispatch(`${DEEPSEEK}:auto`)).toMatchObject({ block: true });
  });
  test("새 UI/UX 경계에서 같은 owner가 이어가고 모델을 바꾸지 않으며 freeze·소유권 이전은 Main이 정한다는 안내를 싣는다", async () => {
    const h = harness({ uiUxBoundary: 1 });
    const [route] = await h.prepare("UI 경계", [h.task], {} as never);
    expect(route!.uiUxHandoff).toContain("실행 중 모델은 바꾸지 않습니다");
    expect(route!.uiUxHandoff).toContain("Main이");
    const plain = harness();
    expect((await plain.prepare("경계 없음", [plain.task], {} as never))[0]!.uiUxHandoff).toBeNull();
  });
  test("보통 UI의 추천 Sonnet은 근거 없이 발주되고 DeepSeek로 바꾸려면 ROUTING_REASON이 필요하다", async () => {
    const h = harness({ uiDifficulty: "ROUTINE" });
    expect((await h.prepare("보통 UI", [h.task], {} as never))[0]!.profile).toBe("NORMAL_SONNET");
    expect(await h.dispatch(`${SONNET}:auto`)).toBeUndefined();
    expect(await h.dispatch(`${DEEPSEEK}:auto`)).toMatchObject({ block: true });
  });
  test("Gemini·GLM은 Maker 후보가 아니다: 근거를 적어도 해당 모델 발주는 후보 밖이라 막힌다", async () => {
    const reasoned = brief.replace("OWNED_PATHS: src/view.ts", "OWNED_PATHS: src/view.ts\nROUTING_REASON: Main이 명시 후보로 선택함");
    const h = harness({ workClass: "NORMAL", candidates });
    await h.prepare("후보 없음", [h.task], {} as never);
    expect(await h.dispatch("google-antigravity/gemini-3.8-flash:auto", reasoned)).toMatchObject({ block: true });
    expect(await h.dispatch("hive/zai-org/glm-5.3-flash:auto", reasoned)).toMatchObject({ block: true });
  });
  test("prepared 추가 지시는 보존하고 context ROUTING_REASON은 필요한 참조에 옮긴다", async () => {
    const h = harness({ workClass: "NORMAL" });
    const routes = await h.prepare("원래 batch context", [h.task], {} as never) as Array<{ preparedId: string; profile: string }>;
    expect(routes[0]!.profile).toBe("NORMAL_DEEPSEEK");
    const preparedId = routes[0]!.preparedId;
    const dispatch = async (task: string) => (await h.beforeTask({
      context: "PREPARED_CONTEXT",
      tasks: [{ name: h.task.name, task, agent: "maker", model: `${SONNET}:auto` }],
    }, {} as never)) as { block?: boolean; reason?: string; input?: { context: string; tasks: Array<{ task: string }> } };
    const reason = "ROUTING_REASON: Main이 계열 근거로 Sonnet을 선택함";

    // 추천 변경 게이트는 그대로다: 참조만 보내면 근거가 없어 막힌다.
    expect(await dispatch(`PREPARED_TASK: ${preparedId}`)).toMatchObject({ block: true });
    for (const addition of [`${reason}\n덧붙인 본문`, `\n${reason}`, `${reason}\n\n`]) {
      const accepted = await dispatch(`PREPARED_TASK: ${preparedId}\n${addition}`);
      expect(accepted.block).toBeUndefined();
      expect(accepted.input!.tasks[0]!.task).toBe(`${brief}\n${addition.trim()}`);
    }
    for (const addition of ["ROUTING_REASON:", "OWNED_PATHS: src/other.ts"]) {
      expect(await dispatch(`PREPARED_TASK: ${preparedId}\n${addition}`)).toMatchObject({ block: true });
    }
    const reasoned = await dispatch(`PREPARED_TASK: ${preparedId}\n${reason}`);
    expect(reasoned.block).toBeUndefined();
    expect(reasoned.input!.context).toBe("원래 batch context");
    expect(reasoned.input!.tasks[0]!.task).toBe(`${brief}\n${reason}`);

    // 참조가 하나면 context에 실은 근거(다음 줄·같은 줄·근거 한 줄만)를 그 task 참조의 근거로 옮겨 같은 게이트를 통과한다.
    for (const context of [`PREPARED_CONTEXT\n${reason}`, `PREPARED_CONTEXT ${reason}`, reason]) {
      const moved = await h.beforeTask({
        context,
        tasks: [{ name: h.task.name, task: `PREPARED_TASK: ${preparedId}`, agent: "maker", model: `${SONNET}:auto` }],
      }, {} as never) as { block?: boolean; input?: { context: string; tasks: Array<{ task: string }> } };
      expect(moved.block).toBeUndefined();
      expect(moved.input!.context).toBe("원래 batch context");
      expect(moved.input!.tasks[0]!.task).toBe(`${brief}\n${reason}`);
    }
    // A context reason already present on the reference is harmless; generic additions stay in context.
    for (const [context, task] of [
      [`PREPARED_CONTEXT\n${reason}`, `PREPARED_TASK: ${preparedId}\n${reason}`],
      [`PREPARED_CONTEXT\n${reason}\n덧붙인 본문`, `PREPARED_TASK: ${preparedId}`],
    ]) {
      const accepted = await h.beforeTask({
        context,
        tasks: [{ name: h.task.name, task, agent: "maker", model: `${SONNET}:auto` }],
      }, {} as never) as { block?: boolean; input: { context: string } };
      expect(accepted.block).toBeUndefined();
      expect(accepted.input.context).toBe(context.includes("덧붙인 본문") ? "원래 batch context\n덧붙인 본문" : "원래 batch context");
    }
    // Context reasons apply only to references that do not already carry their own reason.
    const second = { name: "Second", task: brief.replace("src/view.ts", "src/second.ts"), assessment: { ...facts, paths: ["src/second.ts"] } };
    const pair = await h.prepare("두 task context", [h.task, second], {} as never) as Array<{ preparedId: string }>;
    const own = "ROUTING_REASON: 두 번째 task만의 근거입니다";
    const resolvePair = (secondTask: string, firstTask = `PREPARED_TASK: ${pair[0]!.preparedId}`) => resolvePreparedTaskInput({
      context: `PREPARED_CONTEXT\n${reason}`,
      tasks: [
        { name: h.task.name, task: firstTask },
        { name: second.name, task: secondTask },
      ],
    }, h.sessionId) as { tasks: Array<{ task: string }> };
    expect(resolvePair(`PREPARED_TASK: ${pair[1]!.preparedId}`).tasks.map((task) => task.task.endsWith(`\n${reason}`))).toEqual([true, true]);
    const mixedReasons = resolvePair(`PREPARED_TASK: ${pair[1]!.preparedId}\n${own}`).tasks;
    expect(mixedReasons[0]!.task.endsWith(`\n${reason}`)).toBe(true);
    expect(mixedReasons[1]!.task.endsWith(`\n${own}`)).toBe(true);
    expect(resolvePair(`PREPARED_TASK: ${pair[1]!.preparedId}\n${own}`, `PREPARED_TASK: ${pair[0]!.preparedId}\n${own}`).tasks.map((task) => task.task.endsWith(`\n${own}`))).toEqual([true, true]);
  });
  test("Jev 요청은 designOpen을 정본 기준 문구로 한 번 묻고 과제 본문은 싣지 않는다", async () => {
    const h = harness();
    await h.prepare("본문 비전송", [h.task], {} as never);
    expect(h.requests).toHaveLength(1);
    const asked = h.requests[0]!.questions.designOpen;
    expect(asked).toMatchObject({ type: "noul", instructions: expect.stringContaining(h.policy.modelSelection.designOpenCriteria) });
    expect(typeof h.policy.modelSelection.designOpenCriteria).toBe("string");
    expect(JSON.stringify(h.requests[0])).not.toContain("구현 원문");
  });
  test("준비 뒤 Main 모델 계열이 바뀌어도 준비는 무효가 되지 않고 같은 추천으로 발주된다", async () => {
    const h = harness({ workClass: "HARD", hardFocuses: ["CODE_SYSTEM"], main: CODEX_MAIN });
    expect((await h.prepare("family", [h.task], {} as never))[0]!.profile).toBe("HARD_CODE_DEEPSEEK");
    h.setMain(ANTHROPIC_MAIN);
    expect(await h.dispatch(`${DEEPSEEK}:auto`)).toBeUndefined();
    h.setMain(CODEX_MAIN);
    expect(await h.dispatch(`${DEEPSEEK}:auto`)).toBeUndefined();
    expect(h.requests).toHaveLength(1);
  });
  test("위임 판단은 같은 배치에서 묻되 결과에는 싣지 않고 발주 원장에만 남기며 등급·profile·placement를 바꾸지 않는다", async () => {
    const criteria = { MAIN: "Main 문맥이 유리한 단일 밀접 수정", MAKER: "독립·병렬 수행이 가능", UNKNOWN: "근거 부족" };
    const run = async (delegation: string) => {
      const ledger = memoryLedger([]);
      const h = harness({ delegation, ledger });
      h.policy.modelSelection.delegationCriteria = criteria;
      const batch = await h.prepareBatch("위임 판단", [h.task], {} as never);
      return { h, ledger, route: batch.routes[0]! };
    };
    const main = await run("MAIN");
    const maker = await run("MAKER");
    // 같은 배치에 delegation 질문이 들어간다(추가 round 없음).
    expect(main.h.requests).toHaveLength(1);
    expect(main.h.requests[0]!.questions.delegation).toMatchObject({ type: "choice", criteria });
    // 10-30 감사: 위임 조언 68건 중 60건이 MAIN이었고 그중 52건은 그대로 발주됐다. 결과에서는 빼고 원장에만 남긴다.
    expect(main.route.recommendations).not.toHaveProperty("delegation");
    expect(main.route.recommendations).toHaveProperty("workClass");
    expect(await main.h.dispatch(`${DEEPSEEK}:auto`)).toBeUndefined();
    main.h.noteSpawned({ context: main.h.input.context, tasks: [{ ...main.h.input.tasks[0] }] });
    expect(main.ledger.records.at(-1)).toMatchObject({ type: "dispatch", delegationAdvice: { choice: "MAIN", confidence: null } });
    // 등급·profile·placement는 위임 답과 무관하게 같다.
    expect(main.route.profile).toBe("NORMAL_DEEPSEEK");
    expect(maker.route.profile).toBe("NORMAL_DEEPSEEK");
    expect(main.route.normalAllocation).toEqual(maker.route.normalAllocation);
    expect(main.route.placement).toEqual(maker.route.placement);
  });
  test("registered routing exposes Main-direct advice without changing dispatch or review contracts", async () => {
    for (const [choice, action] of [["MAIN", "main-direct"], ["MAKER", "dispatch-new"], ["UNKNOWN", "main-decision"], ["invalid", "main-decision"]]) {
      const h = harness({ delegation: choice, crossReviewNeed: "REQUIRED" });
      const result = await h.tool.execute("small", { context: "Small known correction", tasks: [h.task] }, undefined, undefined, h.ctx);
      const batch = JSON.parse(result.content[0]!.text);
      expect(batch.routes[0]!.delegationAdvice.action).toBe(action);
      expect(batch.routes[0]!.profile).toBe("NORMAL_DEEPSEEK");
      expect(batch.routes[0]!.crossReviewAdvice.choice).toBe("REQUIRED");
      expect(await h.dispatch(`${DEEPSEEK}:auto`)).toBeUndefined();
      expect(h.requests).toHaveLength(1);
    }
  });
  test("owner continuation precedes Main-direct advice and failed rework model suggestions", async () => {
    const h = harness({ delegation: "MAIN", additional: 1, ownerTarget: "owner0", reworkNature: "BOUNDED_FAILURE" });
    h.setOwners([{ name: "Existing", primaryDeliverable: "표시 오류 수정", ownedPaths: ["src/view.ts"], active: true }]);
    const [route] = await h.prepare("Continue correction", [h.task], {} as never);
    expect(route!.delegationAdvice.action).toBe("instruct-existing");
    expect(route!.placement.owner?.name).toBe("Existing");
    expect(route!.profile).toBe("NORMAL_SOL");
    expect((await h.dispatch(`${DEEPSEEK}:auto`))?.block).toBe(true);
  });
  test("unresolved failure still returns to Main before owner continuation", async () => {
    const h = harness({ delegation: "MAKER", additional: 1, ownerTarget: "owner0", reworkNature: "RETURN_TO_MAIN" });
    h.setOwners([{ name: "Existing", primaryDeliverable: "표시 오류 수정", ownedPaths: ["src/view.ts"] }]);
    const [route] = await h.prepare("Reconsider approach", [h.task], {} as never);
    expect(route!.delegationAdvice.action).toBe("main-decision");
    expect(route!.normalAllocation?.returnToMain).toBe(true);
    expect(route!.profile).toBeNull();
    expect((await h.dispatch(`${DEEPSEEK}:auto`, `${brief}\nROUTING_REASON: retry anyway`))?.block).toBe(true);
  });
});

describe("발주 이력 기록과 history advisory", () => {
  const pastSession = "past-session";
  const past = (overrides: Partial<Extract<LedgerRecord, { type: "dispatch" }>> = {}): Extract<LedgerRecord, { type: "dispatch" }> => {
    const assignmentId = `past-session#${overrides.name ?? "Past"}`;
    return {
      type: "dispatch", ts: "2026-09-24T00:00:00.000Z", name: "Past", workClass: "HARD", focus: "CODE_SYSTEM",
      recommendedProfile: "HARD_CODE_OPUS", recommendedModel: "anthropic/claude-opus-5-5", recommendedEffort: "high",
      chosenModel: "anthropic/claude-opus-5-5", chosenEffort: "high", routingReason: false, purpose: "primary",
      sessionId: pastSession, assignmentId, attempt: 1, attemptId: `${assignmentId}#a1`,
      agentId: `agent-${overrides.name ?? "Past"}`, jobId: `job-${overrides.name ?? "Past"}`,
      ...overrides,
    };
  };
  test("검사를 통과한 발주만 spawn 성공 때 추천·선택·identity를 기록하고 route에 같은 등급·분야 history를 붙인다", async () => {
    const ledger = memoryLedger([
      past({ name: "PastHard" }),
      { type: "outcome", ts: "2026-09-24T00:10:00.000Z", sessionId: pastSession, assignmentId: "past-session#PastHard", attempt: 1, attemptId: "past-session#PastHard#a1", agentId: "agent-PastHard", jobId: "job-PastHard", status: "completed", durationSec: 600 },
      { type: "verdict", ts: "2026-09-24T00:20:00.000Z", sessionId: pastSession, assignmentId: "past-session#PastHard", attempt: 1, attemptId: "past-session#PastHard#a1", agentId: "agent-PastHard", jobId: "job-PastHard", verdict: "accepted", revision: "rev-1", evidenceLocators: ["artifact://past"], reason: "수용" },
      past({ name: "PastUi", focus: "UI_UX" }),
      past({ name: "PastNormal", workClass: "NORMAL", focus: null }),
    ]);
    const h = harness({ workClass: "HARD", hardFocuses: ["CODE_SYSTEM"], ledger, workClassConfidence: 0.62 });
    const batch = await h.prepareBatch("이력", [h.task], {} as never);
    expect(batch.routes[0]!.history).toMatchObject({
      workClass: "HARD", focus: "CODE_SYSTEM", attempts: 1, unobserved: 0,
      followed: { ok: 1, rework: 0, held: 0, pending: 0, aborted: 0 }, switched: {},
    });
    // 준비 handle만 route에 싣는다. 실제 발주 identity는 spawn에서 task 호출 id로 캡처한다.
    expect(batch.routes[0]!.plan).toEqual({ sessionId: h.sessionId, planId: `${h.sessionId}#route#0` });
    const before = ledger.records.length;
    const alternate = "anthropic/claude-opus-5-5:auto";
    expect(await h.dispatch(alternate)).toMatchObject({ block: true });
    h.noteSpawned({ context: h.input.context, tasks: [{ ...h.input.tasks[0], model: alternate }] });
    expect(ledger.records).toHaveLength(before);

    const reasoned = brief.replace("OWNED_PATHS: src/view.ts", "OWNED_PATHS: src/view.ts\nROUTING_REASON: 독립 판단이 필요해 대안을 선택함");
    expect(await h.dispatch(alternate, reasoned)).toBeUndefined();
    // 통과한 초안과 다른 selector로 spawn된 결과는 기록하지 않는다.
    h.noteSpawned({ context: h.input.context, tasks: [{ ...h.input.tasks[0], task: reasoned, model: "openai-codex/gpt-6-sol:auto" }] });
    expect(ledger.records).toHaveLength(before);
    expect(await h.dispatch(alternate, reasoned)).toBeUndefined();
    h.noteSpawned({ context: h.input.context, tasks: [{ ...h.input.tasks[0], task: reasoned, model: alternate }] });
    expect(ledger.records).toHaveLength(before + 1);
    expect(ledger.records.at(-1)).toMatchObject({
      type: "dispatch", name: "ViewFix", workClass: "HARD", focus: "CODE_SYSTEM",
      recommendedProfile: "HARD_CODE_DEEPSEEK", recommendedModel: DEEPSEEK, recommendedEffort: "auto",
      chosenModel: "anthropic/claude-opus-5-5", chosenEffort: "auto", routingReason: true, purpose: null,
      // Jev 등급 확신도와 Main의 변경 근거 본문을 같은 attempt 행에 남겨 outcome·verdict와 attemptId로 잇는다.
      workClassConfidence: 0.62, workClassProbabilities: { HARD: 0.62, NORMAL: 0.38 },
      routingReasonText: "독립 판단이 필요해 대안을 선택함",
      sessionId: h.sessionId, assignmentId: `${h.sessionId}#task-call#0`, attempt: 1, attemptId: `${h.sessionId}#task-call#0#a1`,
      agentId: "agent-viewfix", jobId: "job-viewfix",
    });
  });
  test("ledger가 없거나 Jev가 불가하면 history는 null이다", async () => {
    expect((await harness().prepareBatch("이력 없음", [harness().task], {} as never)).routes[0]!.history).toBeNull();
    const unavailable = harness({ fail: true, ledger: memoryLedger([past({})]) });
    expect((await unavailable.prepareBatch("Jev 불가", [unavailable.task], {} as never)).routes[0]!.history).toBeNull();
  });
  test("Jev가 확신도를 주지 않았거나 불가하면 dispatch 행의 확신도는 null이고 근거 줄이 없으면 본문도 null이다", async () => {
    const ledger = memoryLedger([]);
    const h = harness({ ledger });
    await h.prepare("같은 계약", [h.task], {} as never);
    expect(await h.dispatch(`${DEEPSEEK}:auto`)).toBeUndefined();
    h.noteSpawned({ context: h.input.context, tasks: [{ ...h.input.tasks[0] }] });
    expect(ledger.records.at(-1)).toMatchObject({
      type: "dispatch", workClass: "NORMAL", workClassConfidence: null, workClassProbabilities: null, routingReason: false, routingReasonText: null,
    });
  });
  test("빈 ROUTING_REASON 줄은 추천 변경·UNKNOWN 발주 근거가 아니다(#76)", async () => {
    const ledger = memoryLedger([]);
    const h = harness({ ledger });
    const prepared = (await h.prepare("같은 계약", [h.task], {} as never))[0] as unknown as { preparedId: string };
    const empty = [
      `${brief}\nROUTING_REASON:\n# Verification`,
      `${brief}\nROUTING_REASON: \t\n# Verification`,
      `${brief}\nROUTING_REASON:\n# Verification`.replaceAll("\n", "\r\n"),
      `${brief}\nROUTING_REASON:`,
    ];
    for (const task of empty) {
      const blocked = await h.dispatch("anthropic/claude-opus-5-5:auto", task);
      expect(blocked).toMatchObject({ block: true, reason: expect.stringContaining("ROUTING_REASON") });
    }
    // prepared 참조에 덧붙인 빈 근거도 같은 판정을 받는다.
    const referenced = await h.beforeTask({
      context: "PREPARED_CONTEXT",
      tasks: [{ name: h.task.name, task: `PREPARED_TASK: ${prepared.preparedId}\nROUTING_REASON:\n# Verification`, model: "anthropic/claude-opus-5-5:auto" }],
    }, {} as never);
    expect(referenced).toMatchObject({ block: true });
    // 반대로 같은 줄의 근거는 그대로 발주를 허용하고 원장 본문으로 기록된다.
    const reasoned = `${brief}\n\nROUTING_REASON:\tMain이 독립 판단을 위해 선택함`;
    expect(await h.dispatch("anthropic/claude-opus-5-5:auto", reasoned)).toBeUndefined();
    h.noteSpawned({ context: h.input.context, tasks: [{ ...h.input.tasks[0], model: "anthropic/claude-opus-5-5:auto", task: reasoned }] });
    expect(ledger.records.at(-1)).toMatchObject({
      type: "dispatch", routingReason: true, routingReasonText: "Main이 독립 판단을 위해 선택함",
    });
  });
  test("UNKNOWN 결정도 빈 ROUTING_REASON으로는 발주되지 않는다(#76)", async () => {
    const h = harness({ designOpen: null });
    await h.prepare("모름", [h.task], {} as never);
    expect(await h.dispatch(`${DEEPSEEK}:auto`, `${brief}\nROUTING_REASON:\n# Verification`)).toMatchObject({ block: true });
    expect(await h.dispatch(`${DEEPSEEK}:auto`, `${brief}\r\nROUTING_REASON:\t\r\n# Verification`)).toMatchObject({ block: true });
    expect(await h.dispatch(`${DEEPSEEK}:auto`, `${brief}\nROUTING_REASON: 모름 판단을 Main이 정함`)).toBeUndefined();
  });
  test("추천 모델은 근거가 없어도, 또는 빈 근거 줄이어도 그대로 발주된다(#76 대조)", async () => {
    const ledger = memoryLedger([]);
    const h = harness({ ledger });
    await h.prepare("같은 계약", [h.task], {} as never);
    // 추천 모델에는 변경 근거를 요구하지 않는다(기존 테스트 L2030-L2037의 정상 발주 계약).
    expect(await h.dispatch(`${DEEPSEEK}:auto`, `${brief}\nROUTING_REASON:\n# Target`)).toBeUndefined();
    h.noteSpawned({ context: h.input.context, tasks: [{ ...h.input.tasks[0], task: `${brief}\nROUTING_REASON:\n# Target` }] });
    expect(ledger.records.at(-1)).toMatchObject({ type: "dispatch", routingReason: false, routingReasonText: null });
  });
});

describe("어려운 UI 이관과 active owner", () => {
  test("어려운 UI에서도 Opus가 없으면 추천 없음이고 비싼 모델로 자동 승격하지 않는다", async () => {
    const h = harness({ uiDifficulty: "DIFFICULT", candidates: without("NORMAL_OPUS", "HARD_UI_OPUS") });
    const batch = await h.prepareBatch("UI 후보 없음", [h.task], {} as never);
    expect(batch.routes[0]).toMatchObject({ profile: null, normalAllocation: { profile: null, returnToMain: false } });
    // 근거 없이는 Sonnet·DeepSeek로 대신 발주할 수 없다.
    expect(await h.dispatch(`${SONNET}:auto`)).toMatchObject({ block: true });
    expect(await h.dispatch(`${DEEPSEEK}:auto`)).toMatchObject({ block: true });
  });

  test("UI 이관도 active writer를 보존하고 freeze 뒤 명시적 새 발주만 허용한다", async () => {
    const h = harness({ uiUxBoundary: 1, uiDifficulty: "DIFFICULT", additional: 1, ownerTarget: "owner0" });
    const owner = { name: "Previous", primaryDeliverable: "표시 오류 수정", ownedPaths: ["src/view.ts"], active: true };
    h.setOwners([owner]);
    await h.prepareBatch("UI 경계 발견", [h.task], {} as never);
    const reasoned = brief.replace("OWNED_PATHS: src/view.ts", "OWNED_PATHS: src/view.ts\nROUTING_REASON: 변경·증거 인계 후 Opus 이관");
    expect(await h.dispatch(`${OPUS}:auto`, reasoned)).toMatchObject({ block: true, reason: expect.stringContaining("active owner") });
    h.setOwners([{ ...owner, active: false }]);
    await h.prepareBatch("UI 경계 발견", [h.task], {} as never);
    expect(await h.dispatch(`${OPUS}:auto`, reasoned)).toBeUndefined();
  });
});

describe("maker_route 준비 단계 진단", () => {
  const setImmediateTick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const diagnosticKeys = ["candidatesMs", "decisionNew", "decisionReused", "jevStarted", "judgeWaitMs", "placementNew", "placementReused", "quotaExtraWaitMs", "totalMs"];
  const owner = (name: string) => ({ name, primaryDeliverable: "표시 오류 수정", ownedPaths: ["src/view.ts"] });

  test("최초 준비는 실제 요청 수만큼 시작하고 같은 준비의 재사용은 신규 0이다", async () => {
    const h = harness();
    const first = await h.prepareBatch("같은 계약", [h.task], {} as never);
    expect(first.diagnostics).toMatchObject({ jevStarted: 1, decisionNew: 1, decisionReused: 0, placementNew: 0, placementReused: 0 });
    expect(first.diagnostics.jevStarted).toBe(h.requests.length);
    const second = await h.prepareBatch("같은 계약", [h.task], {} as never);
    expect(second.diagnostics).toMatchObject({ jevStarted: 0, decisionNew: 0, decisionReused: 1 });
    expect(h.requests).toHaveLength(1);
  });

  test("진행 중 판단을 기다리는 동시 호출은 시작 호출에만 1을 귀속한다", async () => {
    const gate = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    const h = harness({ judgeGate: gate.promise, onJudge: () => reached.resolve() });
    const a = h.prepareBatch("같은 계약", [h.task], {} as never);
    await reached.promise;
    const b = h.prepareBatch("같은 계약", [h.task], {} as never);
    await setImmediateTick();
    gate.resolve();
    const [first, second] = await Promise.all([a, b]);
    expect(first.diagnostics.jevStarted).toBe(1);
    expect(second.diagnostics).toMatchObject({ jevStarted: 0, decisionNew: 0, decisionReused: 1 });
    expect(first.diagnostics.jevStarted + second.diagnostics.jevStarted).toBe(h.requests.length);
  });

  test("decision과 placement를 함께 판단해도 요청은 1이고 owner만 바뀌면 placement만 신규다", async () => {
    const h = harness();
    h.setOwners([owner("FirstOwner")]);
    const full = await h.prepareBatch("같은 계약", [h.task], {} as never);
    expect(full.diagnostics).toMatchObject({ jevStarted: 1, decisionNew: 1, placementNew: 1, decisionReused: 0, placementReused: 0 });
    expect(h.requests).toHaveLength(1);
    h.setOwners([owner("SecondOwner")]);
    const placementOnly = await h.prepareBatch("같은 계약", [h.task], {} as never);
    expect(placementOnly.diagnostics).toMatchObject({ jevStarted: 1, decisionNew: 0, decisionReused: 1, placementNew: 1, placementReused: 0 });
    expect(h.requests).toHaveLength(2);
    const again = await h.prepareBatch("같은 계약", [h.task], {} as never);
    expect(again.diagnostics).toMatchObject({ jevStarted: 0, decisionReused: 1, placementReused: 1, placementNew: 0 });
    expect(h.requests).toHaveLength(2);
  });

  test("unavailable 뒤 재준비는 신규 요청이고 이후 성공 결과는 재사용으로 센다", async () => {
    const h = harness({ failCalls: [1] });
    const failed = await h.prepareBatch("실패", [h.task], {} as never);
    expect(failed.routes[0]!.status).toBe("unavailable");
    expect(failed.diagnostics).toMatchObject({ jevStarted: 1, decisionNew: 1 });
    const recovered = await h.prepareBatch("재준비", [h.task], {} as never);
    expect(recovered.diagnostics).toMatchObject({ jevStarted: 1, decisionNew: 1, decisionReused: 0 });
    const reused = await h.prepareBatch("재사용", [h.task], {} as never);
    expect(reused.diagnostics).toMatchObject({ jevStarted: 0, decisionReused: 1 });
    expect(h.requests).toHaveLength(2);
  });

  test("quota가 판단보다 늦으면 판단 후 추가 대기로, 먼저 끝나면 0으로 잡고 시간은 음수가 아니다", async () => {
    let now = 0;
    const late = Promise.withResolvers<void>();
    const lateQuota = harness({
      clock: () => now,
      quota: async () => { await late.promise; return { state: "unavailable", observedAt: 0, reason: "late" }; },
    });
    const pending = lateQuota.prepareBatch("같은 계약", [lateQuota.task], {} as never);
    await setImmediateTick();
    now = 20;
    late.resolve();
    const slow = (await pending).diagnostics;
    expect(slow).toMatchObject({ totalMs: 20, candidatesMs: 0, judgeWaitMs: 0, quotaExtraWaitMs: 20 });

    const gate = Promise.withResolvers<void>();
    const candidateGate = Promise.withResolvers<void>();
    now = 0;
    const early = harness({ clock: () => now, judgeGate: gate.promise, candidateGate: candidateGate.promise });
    const earlyPending = early.prepareBatch("같은 계약", [early.task], {} as never);
    await setImmediateTick();
    now = 7;
    candidateGate.resolve();
    await setImmediateTick();
    now = 30;
    gate.resolve();
    const fast = (await earlyPending).diagnostics;
    expect(fast).toMatchObject({ totalMs: 30, candidatesMs: 7, judgeWaitMs: 23, quotaExtraWaitMs: 0 });

    now = 100;
    const backward = harness({ clock: () => (now -= 5) });
    const clamped = (await backward.prepareBatch("같은 계약", [backward.task], {} as never)).diagnostics;
    for (const key of ["totalMs", "candidatesMs", "judgeWaitMs", "quotaExtraWaitMs"] as const) expect(clamped[key]).toBeGreaterThanOrEqual(0);
  });

  test("task 수와 무관하게 진단 필드가 고정이고 추천·후보·요청 수는 task 수만 따른다", async () => {
    const names = ["FixA", "FixB", "FixC", "FixD", "FixE"];
    const tasks = names.map((name) => ({ name, task: brief, assessment: { ...facts, goal: `${facts.goal} ${name}` } }));
    const one = harness();
    const many = harness();
    const single = await one.prepareBatch("계약", [tasks[0]!], {} as never);
    const batch = await many.prepareBatch("계약", tasks, {} as never);
    expect(Object.keys(single.diagnostics).sort()).toEqual(diagnosticKeys);
    expect(Object.keys(batch.diagnostics).sort()).toEqual(diagnosticKeys);
    expect(batch.diagnostics.jevStarted).toBe(many.requests.length);
    expect(batch.diagnostics.jevStarted).toBe(tasks.length);
    expect(batch.candidates).toEqual(single.candidates);
    expect(batch.routes[0]!.recommendations).toEqual(single.routes[0]!.recommendations);
    expect(batch.routes[0]!.profile).toBe(single.routes[0]!.profile);
  });

  test("진단은 details에만 있고 모델용 text와 진단 값에는 브리프·경로·이름이 없다", async () => {
    const h = harness();
    h.setOwners([owner("SecretOwner")]);
    const result = await h.tool.execute("call-1", {
      context: "SECRET_MARKER 문맥", tasks: [{ name: h.task.name, task: `${brief}\nSECRET_MARKER`, assessment: facts }],
    }, undefined, undefined, h.ctx);
    const details = result.details as { diagnostics: Record<string, unknown> } & Record<string, unknown>;
    expect(Object.keys(details.diagnostics).sort()).toEqual(diagnosticKeys);
    const text = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(text).not.toHaveProperty("diagnostics");
    expect(result.content[0]!.text).not.toContain("jevStarted");
    const serialized = JSON.stringify(details.diagnostics);
    for (const marker of ["SECRET_MARKER", "src/view.ts", "ViewFix", "SecretOwner", "구현 원문"]) expect(serialized).not.toContain(marker);
    for (const value of Object.values(details.diagnostics)) expect(typeof value).toBe("number");
    // 진단을 뺀 details 공통 필드는 text view와 같은 키를 가진다.
    const { diagnostics: _diagnostics, ...rest } = details;
    expect(Object.keys(text).sort()).toEqual(Object.keys(rest).sort());
  });
});

describe("발주 준비는 SpawnGuard와 같은 TASK_GUARD 블록 경계를 읽는다", () => {
  const sonnet = `${DEEPSEEK}:auto`;
  const titleBetween =
    "TASK_GUARD:\nWORK_CLASS: maintenance\nPRIMARY_DELIVERABLE: 표시 오류 수정\nTASK_TITLE: 표시 오류 수정\nOWNED_PATHS: src/view.ts\n\n본문";
  test("TASK_TITLE이 guard 필드 사이에 끼면 SpawnGuard처럼 OWNED_PATHS 누락으로 거절하고 Jev를 부르지 않는다", async () => {
    const h = harness();
    await expect(h.prepare("같은 계약", [{ ...h.task, task: titleBetween }], {} as never)).rejects.toThrow("OWNED_PATHS");
    expect(await h.beforeTask({ context: "c", tasks: [{ name: "ViewFix", task: titleBetween, agent: "maker", model: sonnet }] }, {} as never))
      .toMatchObject({ block: true, reason: expect.stringContaining("OWNED_PATHS") });
    expect(h.requests.length).toBe(0);
  });
  test("TASK_TITLE 뒤 FINDING_ID는 guard 필드가 아니므로 rework 연결도 준비 계약 차이도 만들지 않는다", async () => {
    const ledger = memoryLedger();
    const h = harness({ ledger });
    await h.prepare("같은 계약", [h.task], {} as never);
    const single = (task: string) => ({ context: "같은 계약", tasks: [{ name: "ViewFix", task, agent: "maker", model: sonnet }] });
    expect(await h.beforeTask(single(brief), {} as never, "call-a")).toBeUndefined();
    h.noteSpawned(single(brief), "call-a");
    const trailing = brief.replace("\n\n구현", "\nTASK_TITLE: 표시 오류 수정\nFINDING_ID: f-1\n\n구현");
    expect(await h.beforeTask(single(trailing), {} as never, "call-b")).toBeUndefined();
    const spawned = [...h.noteSpawned(single(trailing), "call-b").values()];
    expect(spawned.map((entry) => entry.identity.attemptId)).toEqual([`${h.sessionId}#call-b#0#a1`]);
  });
});

describe("character-summon marker를 가진 task의 maker_route 면제", () => {
  const sonnet = "openai-codex/gpt-6-sol:auto";
  const exact = '[character-summon alias="RIN(린)" model="anthropic/claude-opus-5-5" oauth-position="0"]';
  const single = (task: string) => ({ context: "c", tasks: [{ name: "ViewFix", task, agent: "maker", model: sonnet }] });
  test("정확한 marker가 아닌 문자열은 maker_route admission을 건너뛰지 못한다", async () => {
    const h = harness();
    for (const loose of [
      '[character-summon alias="RIN(린)" model="anthropic/claude-opus-5-5"\n',
      '[character-summon alias="RIN(린)" model="anthropic/claude-opus-5-5" oauth-position="9"]\n',
      '[character-summon alias="ZZZ" model="anthropic/claude-opus-5-5"]\n',
    ]) {
      expect(await h.beforeTask(single(`${loose}${brief}`), {} as never)).toMatchObject({ block: true });
    }
  });
  test("정확한 marker의 진짜 summon 여부는 command-guard가 검증하므로 라우팅 admission은 그대로 면제한다", async () => {
    const h = harness();
    expect(await h.beforeTask(single(`${exact}\n${brief}`), {} as never)).toBeUndefined();
  });
  test("사용자가 요청한 캐릭터 호출이 있는 session의 평문 brief는 면제하고 요청이 없거나 이미 쓴 뒤에는 면제하지 않는다", async () => {
    const h = harness();
    const state = createTaskGuardState();
    let pending: string[] = [];
    const claimedCalls = new Set<string>();
    bindTaskGuardSession(h.sessionId, state, { pending: () => pending, claimed: (id) => claimedCalls.has(id) });
    try {
      // 단일 alias summon은 모델이 평문 brief를 내고 command-guard가 marker brief로 다시 쓴다. 요청이 없으면 일반 발주다.
      expect(await h.beforeTask(single(brief), {} as never, "t1")).toMatchObject({ block: true });
      pending = ["RIN(린)"];
      expect(await h.beforeTask(single(brief), {} as never, "t2")).toBeUndefined();
      // guard가 먼저 돌아 claim을 끝낸 같은 호출도 summon으로 본다. 다른 호출은 아니다.
      pending = [];
      claimedCalls.add("t2");
      expect(await h.beforeTask(single(brief), {} as never, "t2")).toBeUndefined();
      expect(await h.beforeTask(single(brief), {} as never, "t3")).toMatchObject({ block: true });
    } finally {
      unbindTaskGuardSession(h.sessionId, state);
    }
  });
});

describe("maker_route 준비는 같은 session의 TaskGuard 정본 lock만 상속한다", () => {
  // Without a session lock, omitted fields use feature and the task name instead.
  const inherit = "TASK_GUARD:\nOWNED_PATHS: src/second.ts\n\n본문";
  const second = () => [{ name: "Second", task: inherit, assessment: facts }];
  async function expectDefaultContract(h: ReturnType<typeof harness>) {
    await h.prepare("후속", second(), {});
    const explicit = inherit.replace("TASK_GUARD:", "TASK_GUARD:\nWORK_CLASS: feature\nPRIMARY_DELIVERABLE: Second");
    expect(await h.beforeTask({ tasks: [{ name: "Second", task: explicit, model: `${DEEPSEEK}:auto` }] }, {})).toBeUndefined();
  }
  const settle = (state: TaskGuardState, callId: string, name: string) => settleTaskCall(state, callId, {
    executed: true, isError: false,
    details: { progress: [{ index: 0, id: name, status: "pending" }], async: { jobId: name } },
    registry: [{ id: name, agentId: name, startTime: Date.now() }],
  });
  /** TaskGuard가 첫 child를 받아 lock을 세우고 routing도 같은 spawn을 관측한 session. */
  async function spawnedSession() {
    const h = harness();
    const state = createTaskGuardState();
    bindTaskGuardSession(h.sessionId, state);
    expect(reserveTaskCall(state, "call-1", { tasks: [{ agent: "maker", name: "ViewFix", task: brief }] }).ok).toBe(true);
    settle(state, "call-1", "ViewFix");
    await h.prepare("같은 계약", [h.task], {} as never);
    const call = { context: "같은 계약", tasks: [{ name: "ViewFix", task: brief, agent: "maker", model: `${DEEPSEEK}:auto` }] };
    expect(await h.beforeTask(call, {} as never, "call-1")).toBeUndefined();
    h.noteSpawned(call, "call-1");
    return { h, state };
  }

  test("취소 환불로 TaskGuard가 lock을 풀면 준비가 풀린 lock을 계속 상속하지 않는다", async () => {
    const { h, state } = await spawnedSession();
    try {
      expect((await h.prepare("후속", second(), {} as never))[0]!.status).toBe("judged");
      expect(releaseCancelledSpawns(state, ["ViewFix"])).toBe(1);
      expect(state.lock).toBeUndefined();
      await expectDefaultContract(h);
    } finally {
      unbindTaskGuardSession(h.sessionId, state);
    }
  });

  test("실행 중 child가 남아 TaskGuard lock이 살아 있으면 다른 child의 취소가 lock을 풀지 않는다", async () => {
    const { h, state } = await spawnedSession();
    try {
      expect(reserveTaskCall(state, "call-2", { tasks: [{ agent: "maker", name: "Other", task: inherit }] }).ok).toBe(true);
      settle(state, "call-2", "Other");
      expect(releaseCancelledSpawns(state, ["ViewFix"])).toBe(1);
      expect(state.lock).toBeDefined();
      expect((await h.prepare("후속", second(), {} as never))[0]!.status).toBe("judged");
    } finally {
      unbindTaskGuardSession(h.sessionId, state);
    }
  });

  test("다른 session의 lock은 읽지 않고 한 session의 환불이 다른 session의 lock을 풀지 않는다", async () => {
    const left = await spawnedSession();
    const right = await spawnedSession();
    const bare = harness();
    const bareState = createTaskGuardState();
    bindTaskGuardSession(bare.sessionId, bareState);
    try {
      releaseCancelledSpawns(left.state, ["ViewFix"]);
      await expectDefaultContract(left.h);
      expect((await right.h.prepare("후속", second(), {} as never))[0]!.status).toBe("judged");
      // lock이 없는 session은 다른 session에 lock이 있어도 상속하지 않는다.
      await expectDefaultContract(bare);
    } finally {
      unbindTaskGuardSession(left.h.sessionId, left.state);
      unbindTaskGuardSession(right.h.sessionId, right.state);
      unbindTaskGuardSession(bare.sessionId, bareState);
    }
  });

  test("reload가 같은 session id를 새 state로 이어받으면 옛 state의 lock도 늦은 정리도 새 연결에 영향이 없다", async () => {
    const { h, state: oldState } = await spawnedSession();
    const newState = createTaskGuardState();
    bindTaskGuardSession(h.sessionId, newState);
    try {
      await expectDefaultContract(h);
      // 옛 인스턴스의 늦은 shutdown은 자기 state가 아니므로 새 연결을 지우지 못한다.
      unbindTaskGuardSession(h.sessionId, oldState);
      expect(reserveTaskCall(newState, "call-9", { tasks: [{ agent: "maker", name: "Fresh", task: brief }] }).ok).toBe(true);
      expect((await h.prepare("후속", second(), {} as never))[0]!.status).toBe("judged");
    } finally {
      unbindTaskGuardSession(h.sessionId, newState);
    }
  });

  // Deliverable drift is advisory; the budget and first inheritance lock remain unchanged.
  const child = (name: string, workClass: string, deliverable: string, path: string) => ({
    name, task: `TASK_GUARD:\nWORK_CLASS: ${workClass}\nPRIMARY_DELIVERABLE: ${deliverable}\nOWNED_PATHS: ${path}\n\n본문`, assessment: { ...facts, paths: [path] },
  });
  test.each([
    ["PRIMARY_DELIVERABLE", "maintenance", "다른 산출물"],
    ["WORK_CLASS", "feature", "표시 오류 수정"],
  ])("batch 안에서 %s가 다른 child는 advisory와 함께 준비한다", async (_label, workClass, deliverable) => {
    const h = harness();
    const routes = await h.prepare("", [h.task, child("Other", workClass, deliverable, "src/other.ts")], {});
    expect(routes[1]!.status).toBe("judged");
    expect(routes[1]!.briefGaps?.join("\n")).toContain("기준=maintenance:표시 오류 수정(같은 batch에서 먼저 계약을 정한 child)");
  });
  test("공백만 다른 PRIMARY_DELIVERABLE과 두 값을 생략한 같은 batch child는 그대로 준비된다", async () => {
    const h = harness();
    const routes = await h.prepare("", [h.task, child("Spaced", "maintenance", "  표시   오류 수정 ", "src/spaced.ts"), { name: "Bare", task: inherit, assessment: facts }], {} as never);
    expect(routes.map((route) => route.status)).toEqual(["judged", "judged", "judged"]);
  });
  test("요청 lock과 다른 child도 준비·발주하고 기준과 새 값을 알린다", async () => {
    const { h, state } = await spawnedSession();
    try {
      const routes = await h.prepare("후속", [child("Other", "maintenance", "다른 산출물", "src/other.ts")], {});
      expect(routes[0]!.briefGaps?.join("\n")).toContain("이 요청의 TaskGuard lock");
      const mixed = { context: "같은 계약", tasks: [
        { name: "ViewFix", task: brief, agent: "maker", model: `${DEEPSEEK}:auto` },
        { name: "Other", task: child("Other", "maintenance", "다른 산출물", "src/other.ts").task, agent: "maker", model: `${DEEPSEEK}:auto` },
      ] };
      expect(await h.beforeTask(mixed, {} as never, "call-2")).toMatchObject({ notices: [expect.stringContaining("이 child=maintenance:다른 산출물")] });
    } finally {
      unbindTaskGuardSession(h.sessionId, state);
    }
  });

  // 2026-10-28 06:52:53: 사용자가 같은 요청에서 따로 시킨 두 번째 완료물(Pr16573WinVerify)의 maker_route를 SideQuestGuard가 거절했고,
  // Main은 작업을 바꾸지 않고 라벨만 맞춰 다시 발주했다. 사용자 입력에 글자 그대로 있는 USER_REQUEST 인용은 별도 완료물로 받는다.
  const requested = (name: string, quote: string) => ({
    name,
    task: `TASK_GUARD:\nWORK_CLASS: diagnostic\nPRIMARY_DELIVERABLE: PR 16573 Windows 검증 보고\nOWNED_PATHS: doc/pr/\nUSER_REQUEST: ${quote}\n\n본문`,
    assessment: { ...facts, paths: ["doc/pr/"] },
  });
  test("USER_REQUEST는 선택 사항이며 인용 유무와 관계없이 추가 완료물을 받는다", async () => {
    const { h, state } = await spawnedSession();
    noteUserRequestText(state, "표시 오류 고치고, 그리고 PR 16573도 윈도우에서   검증해줘.");
    try {
      for (const quote of ["PR 16573 검증을 사용자가 원함", "검증해줘"]) {
        const routes = await h.prepare("후속", [requested("Additional", quote)], {});
        expect(routes[0]!.status).toBe("judged");
      }

      const item = requested("WinVerify", "“PR 16573도 윈도우에서 검증해줘”");
      expect((await h.prepare("후속", [item], {} as never))[0]!.status).toBe("judged");
      const call = { context: "후속", tasks: [{ name: "WinVerify", task: item.task, agent: "maker", model: `${DEEPSEEK}:auto` }] };
      expect(await h.beforeTask(call, {} as never, "call-3")).toBeUndefined();
      const reserved = reserveTaskCall(state, "call-3", { tasks: [{ agent: "maker", name: "WinVerify", task: item.task }] });
      expect(reserved.ok).toBe(true);
      // An admitted deliverable can be continued without a quote; another new one is advisory.
      const followUp = "TASK_GUARD:\nWORK_CLASS: diagnostic\nPRIMARY_DELIVERABLE: PR 16573 Windows 검증 보고\nOWNED_PATHS: doc/pr2/\n\n본문";
      expect(reserveTaskCall(state, "call-4", { tasks: [{ agent: "maker", name: "WinVerify2", task: followUp }] }).ok).toBe(true);
      const stray = reserveTaskCall(state, "call-5", { tasks: [{ agent: "maker", name: "Stray", task: followUp.replace("PR 16573 Windows 검증 보고", "곁가지 정리") }] });
      expect(stray).toMatchObject({ ok: true, notices: [expect.stringContaining("곁가지 정리")] });
    } finally {
      unbindTaskGuardSession(h.sessionId, state);
    }
  });
});

describe("교차검증 필요성 자문(crossReviewNeed)은 같은 Jev 묶음의 typed choice이고 게이트가 아니다", () => {
  test("질문은 정책 기준을 choice로 싣고, 답마다 정해진 이유·다음 행동을 돌려준다", async () => {
    const asked = harness({ crossReviewNeed: "REQUIRED" });
    const batch = await asked.prepareBatch("자문", [asked.task], {} as never);
    const criteria = asked.policy.modelSelection.crossReviewNeedCriteria;
    expect(Object.keys(criteria).sort()).toEqual(["NOT_NEEDED", "RECOMMENDED", "REQUIRED", "UNKNOWN"]);
    expect(asked.requests[0]!.questions.crossReviewNeed).toMatchObject({ type: "choice", criteria });
    expect(batch.routes[0]!.crossReviewAdvice).toEqual({ choice: "REQUIRED", reason: criteria.REQUIRED, nextAction: expect.stringContaining("cross_review") });
    const unknown = harness({ crossReviewNeed: "UNKNOWN" });
    expect((await unknown.prepareBatch("자문", [unknown.task], {} as never)).routes[0]!.crossReviewAdvice)
      .toMatchObject({ choice: "UNKNOWN", reason: criteria.UNKNOWN, missingEvidence: expect.stringContaining("assessment facts") });
    const notNeeded = harness({ crossReviewNeed: "NOT_NEEDED" });
    expect((await notNeeded.prepareBatch("자문", [notNeeded.task], {} as never)).routes[0]!.crossReviewAdvice!.nextAction).toContain("never waives the gate");
  });
  test("답이 없거나 Jev가 불가하면 선택 없이 빠진 근거만 알린다", async () => {
    for (const h of [harness(), harness({ fail: true })]) {
      expect((await h.prepareBatch("자문", [h.task], {} as never)).routes[0]!.crossReviewAdvice)
        .toMatchObject({ choice: null, missingEvidence: expect.stringContaining("assessment facts") });
    }
  });
});

describe("Jev 분류 기준과 DeepSeek 기본 추천", () => {
  test("Jev 요청은 designOpen·uiDifficulty·reworkNature를 정책 정본 기준으로 한 번 묻고 mainWaits와 task 원문은 싣지 않는다", async () => {
    const h = harness();
    await h.prepare("질문", [h.task], {} as never);
    expect(h.requests).toHaveLength(1);
    const { questions } = h.requests[0]!;
    const selection = h.policy.modelSelection;
    expect(questions).not.toHaveProperty("mainWaits");
    expect(questions.uiDifficulty).toMatchObject({ type: "choice", criteria: selection.uiDifficultyCriteria });
    expect(Object.keys(selection.uiDifficultyCriteria)).toEqual(["NONE", "ROUTINE", "DIFFICULT", "UNKNOWN"]);
    expect(questions.reworkNature).toMatchObject({ type: "choice", criteria: selection.reworkNatureCriteria });
    expect(Object.keys(selection.reworkNatureCriteria)).toEqual(["NONE", "BOUNDED_FAILURE", "RETURN_TO_MAIN", "NOT_FAILURE"]);
    expect(questions.boundedDesign).toMatchObject({ type: "choice", criteria: selection.boundedDesignCriteria });
    expect(Object.keys(selection.boundedDesignCriteria)).toEqual(["NONE", "BOUNDED", "UNKNOWN"]);
    expect(questions.designOpen).toMatchObject({ type: "noul" });
    expect(JSON.stringify(h.requests)).not.toContain("구현 원문");
  });
  test("DeepSeek 후보가 없거나 소진이면 추천 없이 Main 재판단이고 발주는 막지 않으며 Main이 근거를 남기면 다른 후보를 직접 고를 수 있다", async () => {
    const spent = { disabled: false, limitReached: true, limits: [] };
    const reasoned = brief.replace("OWNED_PATHS: src/view.ts", "OWNED_PATHS: src/view.ts\nROUTING_REASON: DeepSeek 한도 소진을 확인하고 Main이 Sonnet을 직접 선택함");
    const cases: [string[], Record<string, unknown[]>][] = [
      [["NORMAL_DEEPSEEK"], {}],
      [[], { hive: [spent] }],
    ];
    for (const [missing, providers] of cases) {
      const h = harness({
        candidates: candidates.filter((candidate) => !missing.includes(candidate.profile)),
        quota: async () => ({ state: "observed", observedAt: 1, providers }) as never,
      });
      const [route] = await h.prepare("폴백", [h.task], {} as never);
      expect(route!.profile).toBeNull();
      expect(route!.normalAllocation).toMatchObject({ profile: null, returnToMain: false });
      expect(await h.dispatch(`${SONNET}:auto`, reasoned), JSON.stringify(missing)).toBeUndefined();
      expect(await h.dispatch(`${SONNET}:auto`), JSON.stringify(missing)).toMatchObject({ block: true });
    }
  });
});

describe("산출물별 필수 스킬 advisory(rule://frontend 정본, 발주 비차단)", () => {
  const mockup = [
    "TASK_GUARD:", "WORK_CLASS: feature", "PRIMARY_DELIVERABLE: 입고 운영 화면 목업", "OWNED_PATHS: app/receiving/page.tsx", "",
    "SKILL_EXCLUSIONS: {\"kill-ai-slop\":\"\"}",
    "# Change", "skill://seed-design와 skill://frontend-design을 읽고 hallmark 또는 ui-ux-pro-max 중 하나를 적용한다.",
  ].join("\n");
  const visual = {
    requiredSkillDeliverable: { choice: "VISUAL" },
    requiredSkillSet_web_ui: { noul: 0.9 },
    requiredSkillModifier_operator_screen: { noul: 0.8 },
    requiredSkillModifier_ko_copy: { noul: 0.9 },
  };

  test("한국어 운영 목업 브리프의 누락·선택형 축소·이유 없는 제외를 briefGaps로 알리고 발주는 그대로 통과해 기대 세트를 원장에 남긴다", async () => {
    const ledger = memoryLedger();
    const h = harness({ ledger, uiUxBoundary: 1, uiDifficulty: "DIFFICULT", designOpen: 0, skillAnswers: visual });
    const task = { ...h.task, task: mockup };
    const route = (await h.prepareBatch("목업", [task], {})).routes[0]!;
    const gaps = route.briefGaps ?? [];
    const missing = gaps.find((gap) => gap.startsWith("필수 스킬 누락"));
    expect(missing).toContain("skill://operational-expert-tool-ui");
    expect(missing).toContain("skill://humanizer");
    for (const handed of ["seed-design", "frontend-design", "hallmark", "ui-ux-pro-max", "kill-ai-slop"]) expect(missing).not.toContain(`skill://${handed}`);
    expect(gaps.some((gap) => gap.includes("선택형") && gap.includes("hallmark 또는 ui-ux-pro-max"))).toBe(true);
    expect(gaps.some((gap) => gap.includes("kill-ai-slop") && gap.includes("이유가 없음"))).toBe(true);
    // 분류 답은 Main용 recommendations에 섞지 않는다.
    expect(Object.keys(route.recommendations ?? {}).some((key) => key.startsWith("requiredSkill"))).toBe(false);
    expect(await h.dispatch(`${OPUS}:auto`, mockup)).toBeUndefined();
    h.noteSpawned({ context: h.input.context, tasks: [{ ...h.input.tasks[0], task: mockup, model: `${OPUS}:auto` }] });
    expect(ledger.records.at(-1)).toMatchObject({
      type: "dispatch",
      requiredSkills: {
        state: "selected", sets: ["web-ui"], modifiers: ["operator-screen", "ko-copy"],
        skills: ["seed-design", "frontend-design", "ui-ux-pro-max", "hallmark", "kill-ai-slop", "operational-expert-tool-ui", "humanizer"],
        excluded: [{ skill: "kill-ai-slop", reason: "" }],
      },
    });
  });

  test("시각 판단 없는 코드 조각은 .tsx 경로여도 필수 스킬을 요구하지 않고, 세트 답과 모순되면 조용히 버리지 않고 알린다", async () => {
    const plain = harness({ skillAnswers: { requiredSkillDeliverable: { choice: "NONVISUAL" } } });
    const task = { ...plain.task, assessment: { ...facts, paths: ["app/receiving/page.tsx"] } };
    expect((await plain.prepareBatch("로직", [task], {})).routes[0]!.briefGaps).toBeNull();

    const conflict = harness({ skillAnswers: { requiredSkillDeliverable: { choice: "NONVISUAL" }, requiredSkillSet_web_ui: { noul: 1 } } });
    const gaps = (await conflict.prepareBatch("로직", [{ ...conflict.task, assessment: task.assessment }], {})).routes[0]!.briefGaps ?? [];
    expect(gaps.some((gap) => gap.startsWith("필수 스킬 세트 분류 미확인") && gap.includes("모순"))).toBe(true);
    expect(gaps.some((gap) => gap.startsWith("필수 스킬 누락") || gap.startsWith("필수 스킬을 선택형으로 줄임"))).toBe(false);
  });

  test("분류 불가·정본 손상은 빈 성공이 아니라 미확인 advisory이며 발주를 막지 않는다", async () => {
    const ambiguous = harness({ skillAnswers: { requiredSkillDeliverable: { choice: "VISUAL" } } });
    const ambiguousGaps = (await ambiguous.prepareBatch("모호", [ambiguous.task], {})).routes[0]!.briefGaps ?? [];
    expect(ambiguousGaps.some((gap) => gap.startsWith("필수 스킬 세트 분류 미확인"))).toBe(true);
    expect(await ambiguous.dispatch(`${DEEPSEEK}:auto`)).toBeUndefined();

    const broken = harness({ requiredSkills: () => parseRequiredSkillContract("<!-- required-skills:start -->\n```json\n{\"version\":1,\n```\n<!-- required-skills:end -->") });
    const brokenRoute = (await broken.prepareBatch("손상", [broken.task], {})).routes[0]!;
    expect(brokenRoute.briefGaps?.some((gap) => gap.startsWith("필수 스킬 세트 advisory 불가"))).toBe(true);
    // 정본을 읽지 못하면 분류 질문을 보내지 않는다.
    expect(Object.keys(broken.requests[0]!.questions).some((key) => key.startsWith("requiredSkill"))).toBe(false);
    expect(await broken.dispatch(`${DEEPSEEK}:auto`)).toBeUndefined();
  });

  test("정본이 바뀌면 같은 facts라도 이전 분류 cache를 쓰지 않고 같은 판단 묶음 한 번으로 다시 묻는다", async () => {
    let source = loadRequiredSkillContract();
    const h = harness({ requiredSkills: () => source });
    await h.prepareBatch("같은", [h.task], {});
    await h.prepareBatch("같은", [h.task], {});
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.questions).toHaveProperty("workClass");
    expect(h.requests[0]!.questions).toHaveProperty("requiredSkillDeliverable");
    if (source.state !== "loaded") throw new Error(source.reason);
    source = { ...source, contract: { ...source.contract, modifiers: [...source.contract.modifiers, { id: "extra", when: "추가 조건", skills: ["stop-slop"] }] } };
    await h.prepareBatch("같은", [h.task], {});
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]!.questions).toHaveProperty("requiredSkillModifier_extra");
  });
});

describe("seance 과거 세션 조회 발주(2026-11-11)", () => {
  const seanceItem = (overrides: Record<string, unknown> = {}) => ({
    agent: "seance",
    sourceSession: "2026-11-10T00-00-00-000Z_session.jsonl",
    task: "그 세션에서 정한 발주 가드 계약만 요약한다.",
    ...overrides,
  });

  test("정확한 seance 조회는 준비 없이 beforeTask를 통과하고 입력을 바꾸지 않는다", async () => {
    const h = harness();
    const input = { context: "", tasks: [seanceItem()] };
    expect(await h.beforeTask(input, {})).toBeUndefined();
    expect(await h.beforeTask({ ...seanceItem() }, {})).toBeUndefined();
  });

  test("seance 조회는 세션 원장에 발주 기록을 남기지 않는다", async () => {
    const ledger = memoryLedger();
    const h = harness({ ledger });
    expect(await h.beforeTask({ context: "", tasks: [seanceItem({ name: "SeanceRead" })] }, {})).toBeUndefined();
    h.noteSpawned({ context: "", tasks: [seanceItem({ name: "SeanceRead" })] });
    expect(ledger.records).toHaveLength(0);
  });

  test("sourceSession이 없는 seance와 다른 agent는 계속 막고 준비도 요구한다", async () => {
    for (const item of [
      seanceItem({ sourceSession: undefined }),
      seanceItem({ sourceSession: "   " }),
      { ...seanceItem(), agent: "explore" },
    ]) {
      const h = harness();
      const result = await h.beforeTask({ context: "", tasks: [item] }, {}) as { block?: boolean; reason?: string };
      expect(result?.block).toBe(true);
    }
  });

  test("조회 브리프의 TASK_GUARD 문장이 뒤 maker의 발주 계약을 덮지 않는다", async () => {
    // 과거 세션 원문에는 TASK_GUARD 블록이 그대로 들어 있을 수 있다. 그 값이 batch lock이 되면 뒤 maker의
    // 생략 필드가 사용자 요청이 아닌 과거 문장에서 채워져, 실제 요청 lock과 다른 계약으로 발주된다.
    const historical = seanceItem({
      task: "TASK_GUARD:\nWORK_CLASS: diagnostic\nPRIMARY_DELIVERABLE: 과거 세션의 진단 요약\nOWNED_PATHS: old/path.ts\n\n이 블록은 과거 기록이다.",
    });
    const inherited = { name: "InheritFix", task: "TASK_GUARD:\nOWNED_PATHS: src/view.ts\n\n생략 필드를 lock에서 채운다.", agent: "maker", model: `${DEEPSEEK}:auto` };
    const h = harness();
    // 준비는 요청 lock이 빈 상태에서 maker 계약(feature:InheritFix)으로 만든다.
    await h.prepare("", [{ name: inherited.name, task: inherited.task, assessment: facts }], {});
    const routed = await h.beforeTask({ context: "", tasks: [historical, inherited] }, {}) as { block?: boolean; reason?: string } | undefined;
    // 조회가 lock을 세우면 marker가 diagnostic:과거 세션의 진단 요약이 되어 준비한 계약과 어긋나 막힌다.
    expect(routed?.block).not.toBe(true);
    expect(routed?.reason ?? "").not.toContain("diagnostic");
    // guard도 같은 계약을 본다: 과거 브리프는 그대로, maker는 요청 기본값으로 파생된다.
    const state = createTaskGuardState();
    const decision = reserveTaskCall(state, "historical-guard", { context: "", tasks: [historical, inherited] });
    expect(decision.ok).toBe(true);
    expect(state.lock).toEqual({ workClass: "feature", deliverable: "InheritFix", deliverableKey: "inheritfix" });
    const tasks = (decision.ok ? decision.input?.tasks : undefined) as Array<Record<string, unknown>>;
    expect(tasks[0]).toMatchObject({ agent: "seance", task: historical.task });
    const makerTask = String(tasks[1]?.task ?? "");
    expect(makerTask).toContain("WORK_CLASS: feature");
    expect(makerTask).toContain("PRIMARY_DELIVERABLE: InheritFix");
    expect(makerTask).not.toContain("과거 세션의 진단 요약");
  });

  test("조회 브리프에 은퇴 모델·캐릭터 marker 원문이 있어도 발주 경계 검사를 하지 않는다", async () => {
    // 과거 세션 원문에는 그때 쓴 marker가 그대로 남는다. 조회 호출은 모델을 고르지 않으므로
    // marker 검사로 막지 않되, 같은 문장을 가진 일반 maker 발주는 계속 막힌다.
    const quoted = seanceItem({
      task: '과거 기록 인용: [character-summon alias="RIN(린)" model="devin/swe-2"] 결정 근거를 요약한다.',
    });
    const h = harness();
    expect(await h.beforeTask({ context: "", tasks: [quoted] }, {})).toBeUndefined();
    const ordinary = await h.beforeTask({
      context: "",
      tasks: [{ name: "Fix", task: `${brief}\n\n${quoted.task}`, agent: "maker", model: `${DEEPSEEK}:auto` }],
    }, {}) as { block?: boolean; reason?: string };
    expect(ordinary?.block).toBe(true);
    expect(ordinary?.reason).toContain("SWE-2");
  });

  test("혼합 배치는 maker 항목의 준비·계약을 그대로 요구한다", async () => {
    const h = harness();
    const mixed = { context: "", tasks: [{ name: "ViewFix", task: brief, agent: "maker", model: `${DEEPSEEK}:auto` }, seanceItem()] };
    expect(await h.beforeTask(mixed, {})).toMatchObject({ block: true });
    await h.prepare("", [h.task], {});
    const routed = await h.beforeTask(mixed, {}) as { block?: boolean } | undefined;
    expect(routed?.block).not.toBe(true);
    // 같은 배치를 guard에 넘기면 maker 1 + seance 1로 세고 seance 브리프는 그대로 둔다.
    const decision = reserveTaskCall(createTaskGuardState(), "mixed", mixed);
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.input?.tasks[1]).toMatchObject(seanceItem());
  });
});
