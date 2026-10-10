import { describe, expect, test } from "bun:test";
import { loadRoutingPolicy, registerMakerRouting, routingQuestions, routingState, type Owner, type QuotaSnapshot, type RoutingDeps, type RoutingFacts } from "../lib/maker-routing";
import { resolvePreparedTaskInput } from "../lib/prepared-task";
import type { LedgerRecord, RoutingLedger } from "../lib/routing-ledger";

const facts: RoutingFacts = {
  goal: "상태 표시 오류 수정", acceptance: ["오류 경로 정상 표시"], facts: ["한 화면에서 재현됨"],
  hypotheses: ["갱신 시점 누락"], unknowns: ["어느 단계에서 값이 바뀌는지"], paths: ["src/view.ts"],
  callBoundaries: ["상태 저장소 → 표시"], settledImplementation: null, reusedPatterns: ["src/other.ts:20"],
  remainingJudgments: ["입력부터 표시까지 원인 추적"], invariants: ["정상 상태 표시 유지"], checks: ["오류 재현 실행"], failureEvidence: null,
};
const brief = "TASK_GUARD:\nWORK_CLASS: maintenance\nPRIMARY_DELIVERABLE: 표시 오류 수정\nOWNED_PATHS: src/view.ts\n\n구현 원문은 Jev에 보내지 않는다.";
const allStrengths = ["low", "medium", "high", "xhigh", "max"];
const candidates = [
  { profile: "NORMAL_SONNET", model: "openai-codex/gpt-6-sol", efforts: allStrengths },
  { profile: "NORMAL_OPUS", model: "anthropic/claude-opus-5-5", efforts: allStrengths },
  { profile: "HARD_UI_OPUS", model: "anthropic/claude-opus-5-5", efforts: allStrengths },
  { profile: "HARD_CODE_OPUS", model: "anthropic/claude-opus-5-5", efforts: allStrengths },
  { profile: "HARD_CODE_SONNET", model: "openai-codex/gpt-6-sol", efforts: allStrengths },
  { profile: "NORMAL_DEEPSEEK", model: "b-ai/deepseek-v4.1-flash", efforts: allStrengths },
  { profile: "NORMAL_SOL", model: "openai-codex/gpt-6.1-sol", efforts: allStrengths },
  { profile: "HARD_CODE_ASTRA", model: "openai-codex/gpt-6-astra", efforts: allStrengths },
];
/** 후보·Main 모델의 계열. 코어 `ctx.models.family`(=`model.identity.class`)를 대신하는 하네스 fixture다. */
const families: Record<string, string> = {
  "openai-codex/gpt-6-astra": "openai",
  "openai-codex/gpt-6-sol": "openai",
  "anthropic/claude-opus-5-5": "anthropic",
};
/** 메모리 ledger. 파일 경로 없이 기록·요약 경로를 본다. */
function memoryLedger(initial: LedgerRecord[] = []): RoutingLedger & { records: LedgerRecord[] } {
  const records = [...initial];
  return { records, append: (record) => { records.push(record); }, read: () => [...records] };
}
const CODEX_MAIN = { provider: "openai-codex", id: "gpt-6-astra" };
const ANTHROPIC_MAIN = { provider: "anthropic", id: "claude-opus-5-5" };
let nextHarnessSession = 0;
function harness(options: {
  fail?: boolean;
  failCalls?: number[];
  duplicate?: number;
  additional?: number;
  ownerTarget?: string;
  workClass?: string;
  workClasses?: string[];

  hardFocuses?: string[];
  uiUxBoundary?: number;
  normalFits?: string[];
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
} = {}) {
  const sessionId = "example".concat(String(++nextHarnessSession));
  const modelFamilies = options.families ?? families;
  let mainModel = options.main ?? undefined;
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
        (`${provider}/${id}` in modelFamilies ? { provider, id } : undefined),
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
    judge: async (_ctx, request) => {
      requests.push(request);
      const call = requests.length;
      options.onJudge?.();
      if (options.judgeGate && call === (options.judgeGateOnCall ?? 1)) await options.judgeGate;
      if (options.fail || options.failCalls?.includes(call)) throw new Error("TimeoutError");
      return { answers: {
        workClass: { choice: options.workClasses?.[call - 1] ?? options.workClass ?? "NORMAL" },
        hardFocus: { choice: options.hardFocuses?.[call - 1] ?? "CODE_SYSTEM" },
        uiUxBoundary: { noul: options.uiUxBoundary ?? 0 },
        duplicate: { noul: options.duplicate ?? 0 }, additionalInstruction: { noul: options.additional ?? 0 },
        delegation: { choice: options.delegation ?? "MAKER" },
        ...(options.normalFits?.[call - 1] ? { normalFit: { choice: options.normalFits[call - 1] } } : {}),
        ...(options.ownerTarget ? { ownerTarget: { choice: options.ownerTarget } } : {}),
      } };
    },
  });
  const task = { name: "ViewFix", task: brief, assessment: facts };
  const input = { context: "같은 계약", tasks: [{ name: task.name, task: brief, agent: "maker", model: "openai-codex/gpt-6-sol:auto" }] };
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
      route.beforeTask(value, routingCtx, callId),
    noteSpawned: (value: Record<string, unknown>, callId = "task-call",
      ids = new Map<number, { agentId: string; jobId: string }>([[0, { agentId: "agent-viewfix", jobId: "job-viewfix" }]])) =>
      route.noteSpawned(value, sessionId, callId, ids),
    // core는 같은 task 호출의 admission과 spawn 결과에 같은 toolCallId를 준다. noteSpawned 기본값과 같은 호출로 낸다.
    dispatch: (model: string, task: string = brief) => route.beforeTask({
      context: input.context,
      tasks: [{ name: input.tasks[0]!.name, task, agent: "maker", model }],
    }, routingCtx, "task-call"),
    setOwners(value: typeof owners) { owners = value; },
    setMain(value: typeof CODEX_MAIN | null) { mainModel = value ?? undefined; },
  };
}

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
      tasks: [{ name: h.task.name, task, agent: "maker", model: "openai-codex/gpt-6-sol:auto" }],
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
        model: "openai-codex/gpt-6-sol:auto",
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
        model: "openai-codex/gpt-6-sol:auto",
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
    const ctx = { sessionManager: { getSessionId: () => sessionId }, modelRegistry: registry } as never;
    const route = registerMakerRouting({} as never, {
      policy: () => policy,
      settings: async () => ({ getModelRoles: () => modelRoles }),
      owners: () => [],
      quota: async () => ({ state: "unavailable", observedAt: 0, reason: "test" }),
      judge: async () => ({ answers: { workClass: { choice: "NORMAL" } } }),
    });
    const task = { name: "ViewFix", task: brief, assessment: facts };
    const batch = await route.prepareBatch("계약", [task], ctx);
    expect(batch.candidates.map((candidate) => candidate.model)).not.toContain(missing.model);
    expect(batch.unavailableCandidates).toEqual([{ profile: "NORMAL_DEEPSEEK", model: missing.model, reason: "registry에 없는 Maker 후보" }]);
    expect(batch.routes[0]!.status).toBe("judged");
    const input = { context: "계약", tasks: [{ name: task.name, task: brief, agent: "maker", model: "openai-codex/gpt-6-sol:auto" }] };
    expect(await route.beforeTask(input, ctx)).toBeUndefined();
    // 불가한 후보를 지정하면 다른 모델로 대체하지 않고 막는다.
    const blocked = { context: "계약", tasks: [{ name: task.name, task: brief, agent: "maker", model: `${missing.model}:auto` }] };
    expect(await route.beforeTask(blocked, ctx)).toMatchObject({ block: true });
  });
  test("후보 강도는 registry 단계 전체이고 Jev에 강도를 묻지 않으며 발주는 '<후보 selector>:auto'만 통과한다", async () => {
    const policy = loadRoutingPolicy();
    const modelRoles: Record<string, string> = {};
    for (const profile of Object.keys(policy.modelSelection.profiles)) {
      const slot = policy.modelSelection.profiles[profile]!.modelConfigPath.slice("modelRoles.".length);
      // 설정 slot은 운영처럼 :auto suffix다. 후보 해석은 suffix를 떼고 registry를 찾는다.
      modelRoles[slot] = `${candidates.find((candidate) => candidate.profile === profile)!.model}:auto`;
    }
    // DeepSeek는 운영 models.yml처럼 low·high만 선언한다. 후보 강도는 그 선언 그대로다.
    const ladders: Record<string, string[]> = { "b-ai/deepseek-v4.1-flash": ["low", "high"] };
    const registry = {
      find: (provider: string, id: string) => {
        const found = candidates.find((candidate) => candidate.model === `${provider}/${id}`);
        return found ? { thinking: { efforts: ladders[found.model] ?? found.efforts } } : undefined;
      },
      refreshDiscoverableProviders: async () => {},
    };
    const ctx = { sessionManager: { getSessionId: () => "auto-only" }, modelRegistry: registry } as never;
    const asked: Record<string, unknown>[] = [];
    const route = registerMakerRouting({} as never, {
      policy: () => policy,
      settings: async () => ({ getModelRoles: () => modelRoles }),
      owners: () => [],
      quota: async () => ({ state: "unavailable", observedAt: 0, reason: "test" }),
      judge: async (_ctx, request) => {
        asked.push(request.questions);
        return { answers: { workClass: { choice: "HARD" }, hardFocus: { choice: "CODE_SYSTEM" }, uiUxBoundary: { noul: 0 } } };
      },
    });
    const batch = await route.prepareBatch("계약", [{ name: "Deep", task: brief, assessment: facts }], ctx);
    // 정책 구간으로 좁히지 않는다. Opus·Sonnet·Sol·DeepSeek 모두 registry가 선언한 단계 그대로다.
    expect(batch.candidates).toEqual(candidates.map((candidate) => ({ ...candidate, efforts: ladders[candidate.model] ?? candidate.efforts })));
    expect(Object.keys(asked[0]!).filter((key) => /effort/i.test(key))).toEqual([]);
    expect(batch.routes[0]!.profile).toBe("HARD_CODE_OPUS");
    const dispatch = (model: string) => ({ context: "계약", tasks: [{ name: "Deep", task: brief, agent: "maker", model }] });
    for (const concrete of ["anthropic/claude-opus-5-5:low", "anthropic/claude-opus-5-5:max", "anthropic/claude-opus-5-5"]) {
      expect(await route.beforeTask(dispatch(concrete), ctx)).toMatchObject({
        block: true, reason: expect.stringContaining("model:'anthropic/claude-opus-5-5:auto'"),
      });
    }
    expect(await route.beforeTask(dispatch("anthropic/claude-opus-5-5:auto"), ctx)).toBeUndefined();
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
    const batch = { tasks: tasks.map(({ name, task }) => ({ name, task, model: "openai-codex/gpt-6-sol:auto" })) };
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
      "OWNED_PATHS:",
      "ROUTING_REASON: Main이 기존 판단과 다른 새 spawn을 선택함\nOWNED_PATHS:",
    );
    const reasonInput = {
      context: "같은 계약",
      tasks: [{
        name: "ViewFix",
        task: reasonTask,
        agent: "maker",
        model: "openai-codex/gpt-6-sol:auto",
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
        model: "openai-codex/gpt-6-sol:auto",
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
      const item = (task: typeof tasks[number]) => ({ name: task.name, task: task.task, agent: "maker", model: "openai-codex/gpt-6-sol:auto" });
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
      ({ context: "호출 간", ...top, tasks: [{ name: task.name, task: task.task, agent: "maker", model: "openai-codex/gpt-6-sol:auto", ...extra }] });
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
      h.noteSpawned(single(fix, { isolated: true, model: "openai-codex/gpt-6-sol:auto" }), "call-x", ids("Fix-x"));
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
    const item = (name: string, extra: Record<string, unknown> = {}) => ({ name, task: brief, agent: "maker", model: "openai-codex/gpt-6-sol:auto", ...extra });
    const spawnIds = new Map([[0, { agentId: "agent-left", jobId: "job-left" }], [1, { agentId: "agent-right", jobId: "job-right" }]]);
    const cases: [Record<string, unknown>, string[] | null][] = [
      [{ context: "c", tasks: [item("Left", { isolated: true }), item("Right")] }, ["isolated", "shared"]],
      [{ context: "c", tasks: [item("Left", { isolated: true }), item("Right", { isolated: true })] }, ["isolated", "isolated"]],
      // core spawnParamsFor처럼 항목 값이 우선이고, 없으면 상위 isolated를 따른다.
      [{ context: "c", isolated: true, tasks: [item("Left", { isolated: false }), item("Right")] }, ["shared", "isolated"]],
      [{ context: "c", isolated: true, tasks: [item("Left", { isolated: false }), item("Right", { isolated: false })] }, null],
      [{ context: "c", isolated: false, tasks: [item("Left"), item("Right")] }, null],
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
    const isolatedInput = { context: "같은 계약", tasks: [{ name: "ViewFix", task: brief, agent: "maker", model: "openai-codex/gpt-6-sol:auto", isolated: true }] };
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
      tasks: [{ ...h.input.tasks[0], model: "anthropic/claude-opus-5-5:auto" }],
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
      // 추천(NORMAL_SONNET)과 다른 후보(NORMAL_OPUS)는 추천 변경이라 근거를 요구한다. Jev 불가도 같다.
      const item = { ...h.input.tasks[0], model: "anthropic/claude-opus-5-5:auto" };
      expect(await h.beforeTask({ ...h.input, tasks: [item] }, {} as never)).toMatchObject({ block: true });
      item.task = brief.replace("OWNED_PATHS:", "ROUTING_REASON: 두 경합 불변식이 새로 확인되어 Main이 결정함\nOWNED_PATHS:");
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
  test("concrete 강도와 coarse override 및 SWE 발주는 거절한다", async () => {
    const h = harness();
    await h.prepare("같은 계약", [h.task], {} as never);
    for (const item of [
      { ...h.input.tasks[0], model: "openai-codex/gpt-6-sol:medium" },
      { ...h.input.tasks[0], effort: "hi" },
      { ...h.input.tasks[0], model: "devin/swe-2:auto" },
      { ...h.input.tasks[0], model: "", task: '[character-summon alias="NOVA" model="devin/swe-2"]' },
    ]) expect(await h.beforeTask({ ...h.input, tasks: [item] }, {} as never)).toMatchObject({ block: true });
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
  test("NORMAL 한도를 모르면 기본 Sonnet 후보와 unavailable 사유를 유지한다", async () => {
    const h = harness({ workClass: "NORMAL" });
    const batch = await h.prepareBatch("확정 문장 작업", [h.task], {} as never);
    expect(batch.routes[0]).toMatchObject({ profile: "NORMAL_SONNET", normalAllocation: { state: "unavailable", profile: "NORMAL_SONNET" } });
    expect(await h.dispatch("openai-codex/gpt-6-sol:auto")).toBeUndefined();
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
        model: "openai-codex/gpt-6-sol:auto",
      }],
    }, {} as never)).toBeUndefined();
  });
  test("다른 guard나 task 실패 전의 beforeTask만으로 routing lock을 확립하지 않는다", async () => {
    const h = harness();
    await h.prepare("", [h.task], {} as never);
    expect(await h.beforeTask({
      ...h.input,
      tasks: [{ ...h.input.tasks[0], model: "openai-codex/gpt-6-sol:medium" }],
    }, {} as never)).toMatchObject({ block: true });
    const inheritedTask = {
      name: "Second",
      task: "TASK_GUARD:\nOWNED_PATHS: src/other.ts\n\n실패한 spawn의 lock을 상속하면 안 된다.",
      assessment: { ...facts, paths: ["src/other.ts"] },
    };
    await expect(h.prepare("", [inheritedTask], {} as never)).rejects.toThrow();
    expect(h.requests).toHaveLength(1);
  });
  test("TaskGuard 계약을 못 만들면 빠진 필드와 양식을 짚고 판정을 호출하지 않는다", async () => {
    const h = harness();
    const noBlock = { ...h.task, task: "브리프 본문만 있고 guard가 없다." };
    await expect(h.prepare("", [noBlock], {} as never)).rejects.toThrow("`TASK_GUARD:` 블록이 없습니다");
    const pathsOnly = { ...h.task, task: "TASK_GUARD:\nOWNED_PATHS: src/view.ts\n\n첫 child인데 lock 필드가 없다." };
    const error = await h.prepare("", [pathsOnly], {} as never).then(() => undefined, (e: Error) => e.message);
    expect(error).toContain("빠진 필드: WORK_CLASS");
    expect(error).toContain("PRIMARY_DELIVERABLE");
    expect(error).not.toContain("OWNED_PATHS(모든 child 필수)");
    expect(error).toContain("rule://task-guard");
    expect(error).not.toContain("첫 child인데");
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
        model: "openai-codex/gpt-6-sol:auto",
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
      tasks: [{ name: h.task.name, task, agent: "maker", model: "openai-codex/gpt-6-sol:auto" }],
    }, {} as never)) as { block: boolean; reason: string };

    const appended = await dispatch(`PREPARED_TASK: ${preparedId}\n\n덧붙인 본문`);
    expect(appended.block).toBe(true);
    expect(appended.reason).toContain("exact prepared 참조가 아닙니다");
    expect(appended.reason).toContain("참조 뒤에 본문 2줄이 더 붙었습니다");
    expect(appended.reason).toContain("'PREPARED_TASK: <preparedId>' 하나");
    expect(appended.reason).not.toContain("덧붙인 본문");

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
      tasks: [{ task: `PREPARED_TASK: ${preparedId}`, model: "openai-codex/gpt-6-sol:auto" }],
    }, h.sessionId) as { tasks: Array<Record<string, unknown>> };
    expect(restored.tasks[0]).toMatchObject({ name: "ViewFix", task: brief, model: "openai-codex/gpt-6-sol:auto" });
    const omitted = await h.beforeTask({
      context: "PREPARED_CONTEXT",
      tasks: [{ task: `PREPARED_TASK: ${preparedId}`, model: "openai-codex/gpt-6-sol:auto" }],
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

  test("한 batch 참조만 함께 복원하고 mixed full/ref와 다른 batch 조합은 거절한다", async () => {
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
    expect(() => resolvePreparedTaskInput({
      context: "PREPARED_CONTEXT",
      tasks: [
        { name: h.task.name, task: `PREPARED_TASK: ${routes[0]!.preparedId}` },
        { name: second.name, task: second.task },
      ],
    }, h.sessionId)).toThrow();

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
    NORMAL_SONNET: "openai-codex/gpt-6-sol",
    NORMAL_OPUS: "anthropic/claude-opus-5-5",
    HARD_UI_OPUS: "anthropic/claude-opus-5-5",
    HARD_CODE_OPUS: "anthropic/claude-opus-5-5",
    HARD_CODE_SONNET: "openai-codex/gpt-6-sol",
    NORMAL_DEEPSEEK: "b-ai/deepseek-v4.1-flash",
    NORMAL_SOL: "openai-codex/gpt-6.1-sol",
    HARD_CODE_ASTRA: "openai-codex/gpt-6-astra",
  };
  const strengths = ["low", "medium", "high", "xhigh", "max"];
  const normalAnswers = {
    workClass: { choice: "NORMAL" }, hardFocus: { choice: "CODE_SYSTEM" },
    uiUxBoundary: { noul: 0 },
  };
  function registryHarness(options: { registry: unknown; useSidecar?: boolean; sessionId?: string }) {
    const routingPolicy = loadRoutingPolicy();
    const modelRoles: Record<string, string> = {};
    for (const [profile, entry] of Object.entries(routingPolicy.modelSelection.profiles)) {
      modelRoles[entry.modelConfigPath.slice("modelRoles.".length)] = profileModels[profile]!;
    }
    const questions: Record<string, unknown>[] = [];
    const ctx = {
      sessionManager: { getSessionId: () => options.sessionId ?? "registry-harness" },
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
  const dispatchInput = (task: { name: string }, model = "openai-codex/gpt-6-sol:auto") => ({
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
    expect(batch.unavailableCandidates.map((entry) => entry.profile)).toEqual(["NORMAL_OPUS", "HARD_UI_OPUS", "HARD_CODE_OPUS"]);
    expect(refreshCalls.filter((provider) => provider === "anthropic")).toHaveLength(1);
    refreshCalls.length = 0;
    const input = {
      context: "계약",
      tasks: tasks.map((entry) => ({ name: entry.name, task: entry.task, agent: "maker", model: "openai-codex/gpt-6-sol:auto" })),
    };
    expect(await h.route.beforeTask(input, h.ctx)).toBeUndefined();
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
    expect(await h.route.beforeTask(dispatchInput(h.task), h.ctx)).toMatchObject({ block: true });
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
    expect(batch.candidates.map((candidate) => candidate.profile)).toEqual(["NORMAL_SONNET", "HARD_CODE_SONNET", "NORMAL_DEEPSEEK", "NORMAL_SOL", "HARD_CODE_ASTRA"]);
    expect(batch.unavailableCandidates.map(({ profile, model }) => ({ profile, model }))).toEqual([
      { profile: "NORMAL_OPUS", model: "anthropic/claude-opus-5-5" },
      { profile: "HARD_UI_OPUS", model: "anthropic/claude-opus-5-5" },
      { profile: "HARD_CODE_OPUS", model: "anthropic/claude-opus-5-5" },
    ]);
    expect(batch.unavailableCandidates[0]!.reason).toBe("auto로 고를 추론 강도를 확인할 수 없는 후보");
  });

});

describe("HARD 분야와 NORMAL 한도 기반 배정", () => {
  test("같은 가용 한도에서 과제별 Sonnet·Sol을 추천하고 prepared 발주에 추가 판단·예외 근거를 요구하지 않는다", async () => {
    const live = candidates.map((candidate) => candidate.profile === "NORMAL_SONNET"
      ? { ...candidate, model: "anthropic/claude-sonnet-5-5" } : candidate);
    const h = harness({
      candidates: live, normalFits: ["SONNET", "SOL"],
      quota: async () => ({ state: "observed", observedAt: 1, providers: {} }),
    });
    const tasks = ["MeaningComparison", "SettledCode"].map((name) => ({
      ...h.task, name, task: brief.replace("src/view.ts", `src/${name}.ts`),
      assessment: {
        ...facts,
        settledImplementation: name === "SettledCode" ? ["기존 타입 매퍼 계약과 입출력·실행 검사 확정"] : null,
        remainingJudgments: name === "SettledCode" ? ["명세에 따른 국소 구현"] : ["문서·정책 간 의미 비교와 요구 해석"],
      },
    }));
    const batch = await h.prepareBatch("과제별 선택", tasks, {} as never);
    expect(batch.routes.map((route) => route.profile)).toEqual(["NORMAL_SONNET", "NORMAL_SOL"]);
    expect(batch.routes.map((route) => route.normalAllocation?.fit)).toEqual(["SONNET", "SOL"]);
    const beforeDispatch = h.requests.length;
    const dispatch = await h.beforeTask({
      context: "PREPARED_CONTEXT",
      tasks: batch.routes.map((route) => ({
        task: `PREPARED_TASK: ${route.preparedId}`,
        model: `${live.find((candidate) => candidate.profile === route.profile)!.model}:auto`,
        solutionSpace: "기존 계약 안에서 구현",
      })),
    }, {} as never);
    expect(dispatch).toMatchObject({ input: { context: "과제별 선택", tasks: [
      { name: "MeaningComparison", model: "anthropic/claude-sonnet-5-5:auto", task: tasks[0]!.task },
      { name: "SettledCode", model: "openai-codex/gpt-6.1-sol:auto", task: tasks[1]!.task },
    ] } });
    expect(dispatch).not.toHaveProperty("block");
    expect(beforeDispatch).toBe(2);
    expect(h.requests.length).toBe(beforeDispatch);
    expect(batch.diagnostics.jevStarted).toBe(2);
    expect(JSON.stringify(h.requests)).not.toContain("구현 원문");
  });
  test("불명·누락·잘못된 적합성 답은 Sonnet 기본이고 한도 미관측도 소진이 아니며 Sol 근거를 보존한다", async () => {
    for (const fit of ["UNKNOWN", "OTHER", undefined, "SOL"]) {
      const h = harness({ normalFits: fit ? [fit] : undefined });
      const [route] = await h.prepare("한도 미관측", [h.task], {} as never);
      expect(route!.profile).toBe(fit === "SOL" ? "NORMAL_SOL" : "NORMAL_SONNET");
      expect(route!.normalAllocation).toMatchObject({
        state: "unavailable", fit: fit === "SOL" ? "SOL" : "UNKNOWN",
        basis: h.policy.modelSelection.normalFitCriteria[fit === "SOL" ? "SOL" : "UNKNOWN"],
      });
    }
  });
  test("적합성 우선 후보가 없거나 소진되면 다른 일반 후보를 먼저 확인하고 모두 불가하면 최종 대안 또는 null이다", async () => {
    const live = candidates.map((candidate) => candidate.profile === "NORMAL_SONNET"
      ? { ...candidate, model: "anthropic/claude-sonnet-5-5" } : candidate);
    const cases: [string, string[], Record<string, unknown[]>, string | null][] = [
      ["SOL", ["NORMAL_SOL"], {}, "NORMAL_SONNET"],
      ["SOL", [], { "openai-codex": [{ limitReached: true, limits: [] }] }, "NORMAL_SONNET"],
      ["SONNET", ["NORMAL_SONNET"], {}, "NORMAL_SOL"],
      ["SONNET", [], { anthropic: [{ limitReached: true, limits: [] }] }, "NORMAL_SOL"],
      ["SOL", [], { "openai-codex": [{ limitReached: true, limits: [] }], anthropic: [{ limitReached: true, limits: [] }] }, "NORMAL_DEEPSEEK"],
      ["SOL", [], { "openai-codex": [{ limitReached: true, limits: [] }], anthropic: [{ limitReached: true, limits: [] }], "b-ai": [{ limitReached: true, limits: [] }] }, null],
      ["SOL", ["NORMAL_SONNET", "NORMAL_SOL", "NORMAL_DEEPSEEK"], {}, null],
    ];
    for (const [fit, missing, providers, expected] of cases) {
      const h = harness({
        normalFits: [fit], candidates: live.filter((candidate) => !missing.includes(candidate.profile)),
        quota: async () => ({ state: "observed", observedAt: 1, providers }) as never,
      });
      const [route] = await h.prepare("가용 후보 선택", [h.task], {} as never);
      expect(route!.profile).toBe(expected);
      if (expected === null) expect(route!.normalAllocation).toMatchObject({ state: "unavailable", profile: null });
    }
    // quota unavailable still respects missing registry candidates, not a nonexistent preferred profile.
    const blind = harness({ normalFits: ["SOL"], candidates: live.filter((candidate) => candidate.profile !== "NORMAL_SOL") });
    expect((await blind.prepare("미관측·후보 없음", [blind.task], {} as never))[0]!.profile).toBe("NORMAL_SONNET");
  });
  test("Sol 적합성도 UI·HARD의 Opus와 active owner 충돌을 바꾸지 않는다", async () => {
    for (const [options, expected] of [
      [{ uiUxBoundary: 0.9 }, "NORMAL_OPUS"],
      [{ workClass: "HARD", hardFocuses: ["CODE_SYSTEM"] }, "HARD_CODE_OPUS"],
    ] as [NonNullable<Parameters<typeof harness>[0]>, string][]) {
      const h = harness({ ...options, normalFits: ["SOL"] });
      const [route] = await h.prepare("경계 보존", [h.task], {} as never);
      expect(route!.profile).toBe(expected);
      expect(route!.normalAllocation).toBeNull();
    }
    const h = harness({ normalFits: ["SOL"] });
    h.setOwners([{ name: "Existing", primaryDeliverable: "표시 오류 수정", ownedPaths: ["src/view.ts"], active: true }]);
    await h.prepare("owner 보존", [h.task], {} as never);
    expect(await h.dispatch("openai-codex/gpt-6.1-sol:auto")).toMatchObject({ block: true });
  });
  test("적합성 근거가 없을 때 Sol·HARD Astra로 추천을 바꾸려면 ROUTING_REASON이 있어야 auto로 발주된다", async () => {
    const reasoned = brief.replace("OWNED_PATHS:", "ROUTING_REASON: Main이 비용·계열 근거로 명시 대안을 선택함\nOWNED_PATHS:");
    const models = { NORMAL_SOL: "openai-codex/gpt-6.1-sol", HARD_CODE_ASTRA: "openai-codex/gpt-6-astra" };
    // 기본 추천은 그대로: NORMAL은 Sonnet, HARD 코드는 Opus.
    const normal = harness({ workClass: "NORMAL" });
    const [normalRoute] = await normal.prepare("명시 대안", [normal.task], {} as never);
    expect(normalRoute!.profile).toBe("NORMAL_SONNET");
    const spent = harness({
      workClass: "NORMAL",
      quota: async () => ({
        state: "observed", observedAt: 1,
        providers: { "openai-codex": [{ disabled: false, limitReached: true, limits: [] }] },
      }) as never,
    });
    const [spentRoute] = await spent.prepare("소진", [spent.task], {} as never);
    // 이 fixture의 Sonnet·Sol은 둘 다 Codex라 함께 소진됐다. 다음 대체인 DeepSeek를 추천한다.
    expect(spentRoute!.profile).toBe("NORMAL_DEEPSEEK");
    // Anthropic primary만 소진되고 Codex가 살아 있으면 DeepSeek보다 Sol을 먼저 추천한다.
    const anthropicSonnet = candidates
      .map((candidate) => candidate.profile === "NORMAL_SONNET" ? { ...candidate, model: "anthropic/claude-sonnet-5-5" } : candidate);
    const solFirst = harness({
      workClass: "NORMAL",
      candidates: anthropicSonnet,
      quota: async () => ({
        state: "observed", observedAt: 1,
        providers: { anthropic: [{ disabled: false, limitReached: true, limits: [] }] },
      }) as never,
    });
    const [solFirstRoute] = await solFirst.prepare("Sol 먼저", [solFirst.task], {} as never);
    expect(solFirstRoute!.normalAllocation).toMatchObject({ state: "observed", profile: "NORMAL_SOL" });
    expect(solFirstRoute!.profile).toBe("NORMAL_SOL");
    expect(await solFirst.dispatch("openai-codex/gpt-6.1-sol:auto")).toBeUndefined();
    for (const [profile, base] of Object.entries(models)) {
      const work = profile === "NORMAL_SOL" ? "NORMAL" : "HARD";
      const h = harness({ workClass: work, hardFocuses: ["CODE_SYSTEM"] });
      const [route] = await h.prepare("명시 대안", [h.task], {} as never);
      expect(route!.profile).toBe(work === "NORMAL" ? "NORMAL_SONNET" : "HARD_CODE_OPUS");
      // 추천과 다른 후보는 근거 없이는 막히고, 근거가 있어도 concrete 강도는 막힌다.
      expect(await h.dispatch(`${base}:auto`)).toMatchObject({ block: true });
      expect(await h.dispatch(`${base}:auto`, reasoned)).toBeUndefined();
      expect(await h.dispatch(`${base}:high`, reasoned)).toMatchObject({ block: true });
    }
  });
  test("Main 계열이 바뀌어도 HARD의 분야별 모델과 준비 판단을 유지한다", async () => {
    for (const [focus, profile, model] of [
      ["UI_UX", "HARD_UI_OPUS", "anthropic/claude-opus-5-5:auto"],
      ["CODE_SYSTEM", "HARD_CODE_OPUS", "anthropic/claude-opus-5-5:auto"],
    ]) {
      const h = harness({ workClass: "HARD", hardFocuses: [focus!], main: CODEX_MAIN });
      const routes = await h.prepare("분야별 선택", [h.task], {} as never);
      expect(routes[0]!.profile).toBe(profile);
      expect(await h.dispatch(model!)).toBeUndefined();
      h.setMain(ANTHROPIC_MAIN);
      expect(await h.dispatch(model!)).toBeUndefined();
      expect(h.requests).toHaveLength(1);
    }
  });
  test("NORMAL은 사용 가능한 primary Sonnet을 우선하고, Sonnet 소진일 때만 대안을 추천하며 미관측은 소진으로 보지 않는다", async () => {
    const account = (usedFraction: number, extra: Record<string, unknown> = {}) => ({
      credentialId: 1, disabled: false, autoBlockedUntilMs: null, limitReached: false, fetchedAt: 1,
      limits: [{ id: "limit", usedFraction, resetsAt: null, daySlot: null }],
      ...extra,
    });
    const deepseek = candidates;
    const build = (providers: Record<string, unknown[]>) => harness({
      workClass: "NORMAL", candidates: deepseek,
      families: { ...families, "b-ai/deepseek-v4.1-flash": "deepseek" },
      quota: async () => ({ state: "observed", observedAt: 1, providers }),
    });

    // 1) Luna가 사용 가능하면 대안 여유가 더 커도(0.8 대 0.2) primary NORMAL을 유지한다.
    const usable = build({ "openai-codex": [account(0.8)], anthropic: [account(0.2)], "b-ai": [account(0.2)] });
    const first = await usable.prepareBatch("한도 배분", [usable.task], {} as never);
    expect(first.routes[0]).toMatchObject({ profile: "NORMAL_SONNET", normalAllocation: { state: "observed", profile: "NORMAL_SONNET" } });
    expect(await usable.dispatch("openai-codex/gpt-6-sol:auto")).toBeUndefined();
    expect(usable.requests).toHaveLength(1);

    // 2) Luna provider 계정이 실제로 소진(limitReached)되면 사용 가능한 NORMAL 대안을 추천한다.
    const spent = build({
      "openai-codex": [account(1, { limitReached: true })], anthropic: [account(0.2)], "b-ai": [account(0.2)],
    });
    const second = await spent.prepareBatch("한도 배분", [spent.task], {} as never);
    expect(second.routes[0]).toMatchObject({ profile: "NORMAL_DEEPSEEK", normalAllocation: { state: "observed", profile: "NORMAL_DEEPSEEK" } });

    // 3) 미관측은 소진으로 간주하지 않는다. primary를 유지한다.
    const blind = harness({
      workClass: "NORMAL", candidates: deepseek,
      families: { ...families, "b-ai/deepseek-v4.1-flash": "deepseek" },
      quota: async () => ({ state: "unavailable", observedAt: 0, reason: "관측 실패" }),
    });
    const third = await blind.prepareBatch("한도 배분", [blind.task], {} as never);
    expect(third.routes[0]).toMatchObject({ profile: "NORMAL_SONNET", normalAllocation: { state: "unavailable", profile: "NORMAL_SONNET" } });
    expect(await blind.dispatch("openai-codex/gpt-6-sol:auto")).toBeUndefined();

    // 4) HARD 배정은 계정 상태와 무관하게 분야를 따른다.
    const hard = harness({ workClass: "HARD", hardFocuses: ["CODE_SYSTEM"] });
    expect((await hard.prepareBatch("HARD 유지", [hard.task], {} as never)).routes[0]!.profile).toBe("HARD_CODE_OPUS");
  });
  describe("Anthropic 사용량과 명시적 모델 선택", () => {
    // 운영 설정처럼 Sonnet·Opus 후보가 모두 Anthropic인 후보 표.
    const live = candidates.map((candidate) => candidate.model === "openai-codex/gpt-6-sol"
      ? { ...candidate, model: "anthropic/claude-sonnet-5-5" } : candidate);
    // 오늘 구간(리셋 시각에서 24시간씩 거꾸로 센 구간)의 사용량. 7d의 하루 몫은 100/7%다.
    const slot = (usedPct: number | null, slotEnd = 500) => ({ usedPct, quotaPct: 100 / 7, slotsLeft: 1, quality: usedPct === null ? "unknown" : "exact", slotEnd });
    const anthropicAccount = (weeklyUsed: number, extra: Record<string, unknown> = {}, daySlot: unknown = null) => ({
      credentialId: 1, disabled: false, autoBlockedUntilMs: null, limitReached: null, fetchedAt: 1,
      limits: [
        { id: "anthropic:5h", usedFraction: 0.1, resetsAt: 50, daySlot: null, windowId: "5h", shared: true },
        { id: "anthropic:7d", usedFraction: weeklyUsed, resetsAt: 500, daySlot, windowId: "7d", shared: true },
      ],
      ...extra,
    });
    const open = { credentialId: 2, disabled: false, autoBlockedUntilMs: null, limitReached: null, fetchedAt: 1, limits: [] };
    const build = (anthropic: unknown[], codex: unknown[], options: NonNullable<Parameters<typeof harness>[0]>) => harness({
      candidates: live,
      quota: async () => ({ state: "observed", observedAt: 10, providers: { anthropic, "openai-codex": codex, "b-ai": [open] } }) as never,
      ...options,
    });

    test("모든 계정이 오늘 몫에 도달해도 사용 가능한 Sonnet·Opus를 유지한다", async () => {
      const cases: [NonNullable<Parameters<typeof harness>[0]>, string, string][] = [
        [{ workClass: "NORMAL" }, "NORMAL_SONNET", "anthropic/claude-sonnet-5-5:auto"],
        [{ workClass: "NORMAL", normalFits: ["SOL"] }, "NORMAL_SOL", "openai-codex/gpt-6.1-sol:auto"],
        [{ workClass: "NORMAL", uiUxBoundary: 0.9 }, "NORMAL_OPUS", "anthropic/claude-opus-5-5:auto"],
        [{ workClass: "HARD", hardFocuses: ["UI_UX"] }, "HARD_UI_OPUS", "anthropic/claude-opus-5-5:auto"],
        [{ workClass: "HARD", hardFocuses: ["CODE_SYSTEM"] }, "HARD_CODE_OPUS", "anthropic/claude-opus-5-5:auto"],
      ];
      for (const [options, profile, model] of cases) {
        const h = build([
          anthropicAccount(0.5, {}, { ...slot(20), quotaPct: 0.001 }),
          anthropicAccount(0.6, { credentialId: 3 }, { ...slot(30), quotaPct: 0.001 }),
        ], [open], options);
        const batch = await h.prepareBatch("사용 가능한 모델 유지", [h.task], {} as never);
        expect(batch.routes[0]!.profile).toBe(profile);
        expect(await h.dispatch(model)).toBeUndefined();
      }
    });

    test("실제 공유 한도 소진만 NORMAL 대안을 고르고 HARD·UI 전문성은 자동 전환하지 않는다", async () => {
      const cases: [unknown[], string][] = [
        [[anthropicAccount(1), anthropicAccount(1.02, { credentialId: 3 })], "NORMAL_SOL"],
        [[anthropicAccount(1), anthropicAccount(0.4, { credentialId: 3 }, slot(30))], "NORMAL_SONNET"],
        [[anthropicAccount(0, { limits: [{ id: "anthropic:7d", usedFraction: 1, resetsAt: 5, windowId: "7d", shared: true }] })], "NORMAL_SONNET"],
        [[anthropicAccount(0, { limits: [{ id: "anthropic:7d:fable", usedFraction: 1, resetsAt: 500, windowId: "7d", shared: false }] })], "NORMAL_SONNET"],
      ];
      for (const [accounts, profile] of cases) {
        const h = build(accounts, [open], { workClass: "NORMAL" });
        expect((await h.prepareBatch("실제 소진", [h.task], {} as never)).routes[0]!.profile).toBe(profile);
      }
      // Codex(Sol)까지 소진되면 다음 대체인 DeepSeek로 넘어간다.
      const bothSpent = build([anthropicAccount(1)], [{ ...open, limitReached: true }], { workClass: "NORMAL" });
      expect((await bothSpent.prepareBatch("둘 다 소진", [bothSpent.task], {} as never)).routes[0]!.profile).toBe("NORMAL_DEEPSEEK");
      for (const [options, profile] of [
        [{ workClass: "NORMAL", uiUxBoundary: 0.9 }, "NORMAL_OPUS"],
        [{ workClass: "HARD", hardFocuses: ["CODE_SYSTEM"] }, "HARD_CODE_OPUS"],
      ] as [NonNullable<Parameters<typeof harness>[0]>, string][]) {
        const h = build([anthropicAccount(1)], [open], options);
        expect((await h.prepareBatch("전문성 유지", [h.task], {} as never)).routes[0]!.profile).toBe(profile);
      }
    });
  });
  test("위임 판단은 같은 배치에서 recommendations로만 돌아오고 등급·profile·placement를 바꾸지 않는다", async () => {
    const criteria = { MAIN: "Main 문맥이 유리한 단일 밀접 수정", MAKER: "독립·병렬 수행이 가능", UNKNOWN: "근거 부족" };
    const run = async (delegation: string) => {
      const h = harness({ delegation });
      h.policy.modelSelection.delegationCriteria = criteria;
      const batch = await h.prepareBatch("위임 판단", [h.task], {} as never);
      return { h, route: batch.routes[0]! };
    };
    const main = await run("MAIN");
    const maker = await run("MAKER");
    // 같은 배치에 delegation 질문이 들어간다(추가 round 없음).
    expect(main.h.requests).toHaveLength(1);
    expect(main.h.requests[0]!.questions.delegation).toMatchObject({ type: "choice", criteria });
    // 답은 recommendations.delegation으로만 돌아온다.
    expect(main.route.recommendations).toMatchObject({ delegation: { choice: "MAIN" } });
    expect(maker.route.recommendations).toMatchObject({ delegation: { choice: "MAKER" } });
    // 등급·profile·placement는 위임 답과 무관하게 같다.
    expect(main.route.profile).toBe("NORMAL_SONNET");
    expect(maker.route.profile).toBe("NORMAL_SONNET");
    expect(main.route.normalAllocation).toEqual(maker.route.normalAllocation);
    expect(main.route.placement).toEqual(maker.route.placement);
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
    const h = harness({ workClass: "HARD", hardFocuses: ["CODE_SYSTEM"], ledger });
    const batch = await h.prepareBatch("이력", [h.task], {} as never);
    expect(batch.routes[0]!.history).toMatchObject({
      workClass: "HARD", focus: "CODE_SYSTEM", attempts: 1, unobserved: 0,
      followed: { ok: 1, rework: 0, held: 0, pending: 0, aborted: 0 }, switched: {},
    });
    // 준비 handle만 route에 싣는다. 실제 발주 identity는 spawn에서 task 호출 id로 캡처한다.
    expect(batch.routes[0]!.plan).toEqual({ sessionId: h.sessionId, planId: `${h.sessionId}#route#0` });
    const before = ledger.records.length;
    const alternate = "openai-codex/gpt-6-sol:auto";
    expect(await h.dispatch(alternate)).toMatchObject({ block: true });
    h.noteSpawned({ context: h.input.context, tasks: [{ ...h.input.tasks[0], model: alternate }] });
    expect(ledger.records).toHaveLength(before);

    const reasoned = brief.replace("OWNED_PATHS:", "ROUTING_REASON: 독립 판단이 필요해 대안을 선택함\nOWNED_PATHS:");
    expect(await h.dispatch(alternate, reasoned)).toBeUndefined();
    // 통과한 초안과 다른 selector로 spawn된 결과는 기록하지 않는다.
    h.noteSpawned({ context: h.input.context, tasks: [{ ...h.input.tasks[0], task: reasoned, model: "anthropic/claude-opus-5-5:auto" }] });
    expect(ledger.records).toHaveLength(before);
    expect(await h.dispatch(alternate, reasoned)).toBeUndefined();
    h.noteSpawned({ context: h.input.context, tasks: [{ ...h.input.tasks[0], task: reasoned, model: alternate }] });
    expect(ledger.records).toHaveLength(before + 1);
    expect(ledger.records.at(-1)).toMatchObject({
      type: "dispatch", name: "ViewFix", workClass: "HARD", focus: "CODE_SYSTEM",
      recommendedProfile: "HARD_CODE_OPUS", recommendedModel: "anthropic/claude-opus-5-5", recommendedEffort: "auto",
      chosenModel: "openai-codex/gpt-6-sol", chosenEffort: "auto", routingReason: true, purpose: null,
      sessionId: h.sessionId, assignmentId: `${h.sessionId}#task-call#0`, attempt: 1, attemptId: `${h.sessionId}#task-call#0#a1`,
      agentId: "agent-viewfix", jobId: "job-viewfix",
    });
  });
  test("ledger가 없거나 Jev가 불가하면 history는 null이다", async () => {
    expect((await harness().prepareBatch("이력 없음", [harness().task], {} as never)).routes[0]!.history).toBeNull();
    const unavailable = harness({ fail: true, ledger: memoryLedger([past({})]) });
    expect((await unavailable.prepareBatch("Jev 불가", [unavailable.task], {} as never)).routes[0]!.history).toBeNull();
  });
});

describe("NORMAL UI/UX 전문성 경계", () => {
  test("코드 지배 혼합 작업도 UI/UX 판단이 남으면 NORMAL Opus로 실행한다", async () => {
    const h = harness({ uiUxBoundary: 1, hardFocuses: ["CODE_SYSTEM"] });
    const batch = await h.prepareBatch("혼합 UI 판단", [h.task], {} as never);
    expect(batch.routes[0]).toMatchObject({ profile: "NORMAL_OPUS", normalAllocation: null, recommendations: { workClass: { choice: "NORMAL" } } });
    expect(await h.dispatch("anthropic/claude-opus-5-5:auto")).toBeUndefined();
    const reasoned = brief.replace("OWNED_PATHS:", "ROUTING_REASON: 다른 후보 선택\nOWNED_PATHS:");
    expect(await h.dispatch("openai-codex/gpt-6-sol:auto", reasoned)).toMatchObject({ block: true });
  });

  test("Opus unavailable이면 일반 후보로 조용히 대체하지 않는다", async () => {
    const h = harness({ uiUxBoundary: 1, candidates: candidates.filter((candidate) => !candidate.model.startsWith("anthropic/")) });
    const batch = await h.prepareBatch("UI 후보 없음", [h.task], {} as never);
    expect(batch.routes[0]!.profile).toBeNull();
    const reasoned = brief.replace("OWNED_PATHS:", "ROUTING_REASON: 후보 없음\nOWNED_PATHS:");
    expect(await h.dispatch("openai-codex/gpt-6-sol:auto", reasoned)).toMatchObject({ block: true, reason: expect.stringContaining("NORMAL_OPUS") });
  });

  test("UI 이관도 active writer를 보존하고 freeze 뒤 명시적 새 발주만 허용한다", async () => {
    const h = harness({ uiUxBoundary: 1, additional: 1, ownerTarget: "owner0" });
    const owner = { name: "Previous", primaryDeliverable: "표시 오류 수정", ownedPaths: ["src/view.ts"], active: true };
    h.setOwners([owner]);
    await h.prepareBatch("UI 경계 발견", [h.task], {} as never);
    const reasoned = brief.replace("OWNED_PATHS:", "ROUTING_REASON: 변경·증거 인계 후 Opus 이관\nOWNED_PATHS:");
    expect(await h.dispatch("anthropic/claude-opus-5-5:auto", reasoned)).toMatchObject({ block: true, reason: expect.stringContaining("active owner") });
    h.setOwners([{ ...owner, active: false }]);
    await h.prepareBatch("UI 경계 발견", [h.task], {} as never);
    expect(await h.dispatch("anthropic/claude-opus-5-5:auto", reasoned)).toBeUndefined();
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
