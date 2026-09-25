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
  { profile: "NORMAL", model: "openai-codex/gpt-6-luna", efforts: allStrengths },
  { profile: "NORMAL_DEEPSEEK", model: "anthropic/claude-opus-5-5", efforts: allStrengths },
  { profile: "NORMAL_SOL", model: "openai-codex/gpt-6-sol", efforts: allStrengths },
  { profile: "HARD_UI_UX", model: "anthropic/claude-opus-5-5", efforts: allStrengths },
  { profile: "HARD_CODE_SYSTEM", model: "anthropic/claude-opus-5-5", efforts: allStrengths },
  { profile: "HARD_CODE_SYSTEM_ALTERNATE", model: "openai-codex/gpt-6-astra", efforts: allStrengths },
];
/** 후보·Main 모델의 계열. 코어 `ctx.models.family`(=`model.identity.class`)를 대신하는 하네스 fixture다. */
const families: Record<string, string> = {
  "openai-codex/gpt-6-luna": "openai",
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
  const zodChain = (): { nullable(): unknown } => ({ nullable: () => zodChain() });
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
        // 후보 순서: NORMAL·NORMAL_DEEPSEEK·NORMAL_SOL·HARD_UI_UX·HARD_CODE_SYSTEM·HARD_CODE_SYSTEM_ALTERNATE.
        effort0: { choice: "high" }, effort1: { choice: "high" }, effort2: { choice: "medium" },
        effort3: { choice: "high" }, effort4: { choice: "xhigh" }, effort5: { choice: "high" },
        duplicate: { noul: options.duplicate ?? 0 }, additionalInstruction: { noul: options.additional ?? 0 },
        delegation: { choice: options.delegation ?? "MAKER" },
        ...(options.ownerTarget ? { ownerTarget: { choice: options.ownerTarget } } : {}),
      } };
    },
  });
  const task = { name: "ViewFix", task: brief, assessment: facts };
  const input = { context: "같은 계약", tasks: [{ name: task.name, task: brief, agent: "maker", model: "openai-codex/gpt-6-luna:high" }] };
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
    beforeTask: (value: Record<string, unknown>, _ctx: unknown) =>
      route.beforeTask(value, routingCtx),
    noteSpawned: (value: Record<string, unknown>, callId = "task-call",
      ids = new Map<number, { agentId: string; jobId: string }>([[0, { agentId: "agent-viewfix", jobId: "job-viewfix" }]])) =>
      route.noteSpawned(value, sessionId, callId, ids),
    dispatch: (model: string, task: string = brief) => route.beforeTask({
      context: input.context,
      tasks: [{ name: input.tasks[0]!.name, task, agent: "maker", model }],
    }, routingCtx),
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
      tasks: [{ name: h.task.name, task, agent: "maker", model: "openai-codex/gpt-6-sol:medium" }],
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
        model: "openai-codex/gpt-6-luna:high",
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
        model: "openai-codex/gpt-6-sol:medium",
      }],
    }, {} as never) as { block: boolean; reason: string };
    expect(reason.block).toBe(true);
    expect(reason.reason).not.toContain(longName);
    expect(reason.reason).not.toContain(longPath);
    expect(reason.reason).toContain("…");
    expect(reason.reason).not.toContain("구현 원문");
  });
  test("quota는 판단 완료 때 준비된 값만 붙이고 진행 중 조회는 취소한 뒤 unavailable로 반환한다", async () => {
    const seen: string[][] = [];
    let calls = 0;
    const quotaStarted = Promise.withResolvers<void>();
    const quotaStopped = Promise.withResolvers<void>();
    const judgeReached = Promise.withResolvers<void>();
    const h = harness({
      onJudge: () => judgeReached.resolve(),
      quota: async (providers, signal) => {
        seen.push(providers);
        calls += 1;
        if (calls === 1) {
          quotaStarted.resolve();
          await new Promise<void>((resolve) => {
            if (signal?.aborted) resolve();
            else signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          quotaStopped.resolve();
          return { state: "unavailable", observedAt: 1_001, reason: "aborted" };
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
    const pending = h.prepareBatch("같은 계약", [h.task], {} as never);
    await Promise.all([judgeReached.promise, quotaStarted.promise]);
    expect(h.requests.length).toBe(1);
    const first = await pending;
    expect(seen[0]).toEqual(["openai-codex", "anthropic"]);
    const allowed = (profile: string) => h.policy.modelSelection.profiles[profile]!.allowedEfforts;
    expect(first).toMatchObject({
      candidates: candidates.map((candidate) => ({
        ...candidate,
        efforts: candidate.efforts.filter((level) => allowed(candidate.profile).includes(level)),
      })),
      unavailableCandidates: [],
      quota: {
        state: "unavailable",
        reason: expect.stringContaining("route 판단 완료"),
      },
    });
    await quotaStopped.promise;
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
    const missing = candidates.find((candidate) => candidate.profile === "NORMAL_SOL")!;
    const registry = {
      find: (provider: string, id: string) => {
        const model = `${provider}/${id}`;
        if (model === missing.model) return undefined;
        const found = candidates.find((candidate) => candidate.model === model);
        return found ? { thinking: { efforts: found.efforts } } : undefined;
      },
      refreshProvider: async () => {},
    };
    const sessionId = "sample";
    const ctx = { sessionManager: { getSessionId: () => sessionId }, modelRegistry: registry } as never;
    const route = registerMakerRouting({} as never, {
      policy: () => policy,
      settings: async () => ({ get: () => modelRoles }),
      owners: () => [],
      quota: async () => ({ state: "unavailable", observedAt: 0, reason: "test" }),
      judge: async () => ({ answers: { workClass: { choice: "NORMAL" }, effort0: { choice: "high" }, effort1: { choice: "medium" }, effort2: { choice: "high" }, effort3: { choice: "high" }, effort4: { choice: "max" } } }),
    });
    const task = { name: "ViewFix", task: brief, assessment: facts };
    const batch = await route.prepareBatch("계약", [task], ctx);
    expect(batch.candidates.map((candidate) => candidate.model)).not.toContain(missing.model);
    expect(batch.unavailableCandidates).toEqual([{ profile: "NORMAL_SOL", model: missing.model, reason: "registry에 없는 Maker 후보" }]);
    expect(batch.routes[0]!.status).toBe("judged");
    const input = { context: "계약", tasks: [{ name: task.name, task: brief, agent: "maker", model: "openai-codex/gpt-6-luna:high" }] };
    expect(await route.beforeTask(input, ctx)).toBeUndefined();
    // 불가한 후보를 지정하면 다른 모델로 대체하지 않고 막는다.
    const blocked = { context: "계약", tasks: [{ name: task.name, task: brief, agent: "maker", model: `${missing.model}:medium` }] };
    expect(await route.beforeTask(blocked, ctx)).toMatchObject({ block: true });
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
        model: "openai-codex/gpt-6-sol:medium",
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
  test("관련 owner만 바뀌면 placement 질문만 다시 묻고 최초 등급·effort를 보존한다", async () => {
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
    expect(second[0]!.recommendations.effort2).toEqual(first[0]!.recommendations.effort2);
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
        model: "openai-codex/gpt-6-luna:high",
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
      tasks: [{ ...h.input.tasks[0], model: "anthropic/claude-opus-5-5:xhigh" }],
    }, {} as never)).toBeUndefined();
    expect(h.requests).toHaveLength(2);
  });
  test("assessment 변경은 등급·effort를 포함한 새 판단으로 교체한다", async () => {
    const h = harness();
    await h.prepare("처음 설명", [h.task], {} as never);
    await h.prepare("다른 설명", [{ ...h.task, assessment: { ...facts, unknowns: ["추가로 확인한 미확인 값"] } }], {} as never);
    expect(h.requests.length).toBe(2);
    expect(h.requests[1]!.questions).toHaveProperty("workClass");
    expect(h.requests[1]!.questions).toHaveProperty("effort0");
    expect(await h.beforeTask(h.input, {} as never)).toBeUndefined();
  });
  test("루브릭 변경은 등급·effort를 다시 묻고 full session reset 뒤에는 재준비가 필요하다", async () => {
    const h = harness();
    await h.prepare("같은 계약", [h.task], {} as never);
    h.policy.modelSelection.criteria.NORMAL += " revised";
    expect(await h.beforeTask(h.input, {} as never)).toMatchObject({ block: true });
    await h.prepare("같은 계약", [h.task], {} as never);
    expect(h.requests.length).toBe(2);
    expect(h.requests[1]!.questions).toHaveProperty("workClass");
    expect(h.requests[1]!.questions).toHaveProperty("effort0");
    h.reset();
    expect(await h.beforeTask(h.input, {} as never)).toMatchObject({ block: true });
  });
  test("추천 변경과 Jev 불가는 Main 근거를 남기면 진행하며 다른 모델을 호출하지 않는다", async () => {
    for (const fail of [false, true]) {
      const h = harness({ fail });
      const prepared = await h.prepare("같은 계약", [h.task], {} as never);
      expect(prepared[0]!.status).toBe(fail ? "unavailable" : "judged");
      // NORMAL 등급에 없는 모델의 다른 후보는 그 후보 구간으로 보고 추천 변경이라 근거를 요구한다.
      const item = { ...h.input.tasks[0], model: "openai-codex/gpt-6-astra:xhigh" };
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
  test("native selector 밖 강도와 coarse override 및 SWE 발주는 거절한다", async () => {
    const h = harness();
    await h.prepare("같은 계약", [h.task], {} as never);
    for (const item of [
      { ...h.input.tasks[0], model: "openai-codex/gpt-6-luna:medium" },
      { ...h.input.tasks[0], effort: "hi" },
      { ...h.input.tasks[0], model: "devin/swe-2:high" },
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
  test("NORMAL 기본 Luna는 high·xhigh 구간만 발주하고 concrete effort 검사를 유지한다", async () => {
    const ordinary = harness({ workClass: "NORMAL" });
    await ordinary.prepare("일반 발주", [ordinary.task], {} as never);
    expect(await ordinary.beforeTask({
      ...ordinary.input,
      tasks: [{ ...ordinary.input.tasks[0], model: "openai-codex/gpt-6-luna:high" }],
    }, {} as never)).toBeUndefined();
    expect(await ordinary.beforeTask({
      ...ordinary.input,
      tasks: [{ ...ordinary.input.tasks[0], model: "openai-codex/gpt-6-luna:low" }],
    }, {} as never)).toMatchObject({ block: true });
  });
  test("NORMAL 한도를 모르면 기본 Luna 후보와 unavailable 사유를 유지한다", async () => {
    const h = harness({ workClass: "NORMAL" });
    const batch = await h.prepareBatch("확정 문장 작업", [h.task], {} as never);
    expect(batch.routes[0]).toMatchObject({ profile: "NORMAL", normalAllocation: { state: "unavailable", profile: "NORMAL" } });
    expect(await h.dispatch("openai-codex/gpt-6-luna:high")).toBeUndefined();
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
        model: "openai-codex/gpt-6-luna:high",
      }],
    }, {} as never)).toBeUndefined();
  });
  test("다른 guard나 task 실패 전의 beforeTask만으로 routing lock을 확립하지 않는다", async () => {
    const h = harness();
    await h.prepare("", [h.task], {} as never);
    expect(await h.beforeTask({
      ...h.input,
      tasks: [{ ...h.input.tasks[0], model: "openai-codex/gpt-6-luna:medium" }],
    }, {} as never)).toMatchObject({ block: true });
    const inheritedTask = {
      name: "Second",
      task: "TASK_GUARD:\nOWNED_PATHS: src/other.ts\n\n실패한 spawn의 lock을 상속하면 안 된다.",
      assessment: { ...facts, paths: ["src/other.ts"] },
    };
    await expect(h.prepare("", [inheritedTask], {} as never)).rejects.toThrow();
    expect(h.requests).toHaveLength(1);
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
        model: "openai-codex/gpt-6-luna:high",
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
      tasks: [{ name: h.task.name, task, agent: "maker", model: "openai-codex/gpt-6-sol:medium" }],
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
    // 실제 흐름처럼 registry 지원 강도를 profile 허용 구간으로 거른 후보로 묻는다. NORMAL_SOL은 지원 강도가 하나뿐인 경우다.
    const banded = candidates.map((candidate) => ({
      ...candidate,
      efforts: candidate.profile === "NORMAL_SOL"
        ? ["medium"]
        : candidate.efforts.filter((level) => policy.modelSelection.profiles[candidate.profile]!.allowedEfforts.includes(level)),
    }));
    const questions = routingQuestions(policy, banded, []);
    expect(questions.workClass!.criteria).toEqual(policy.modelSelection.criteria);
    expect(questions).not.toHaveProperty("easyFocus");
    expect(Object.keys(policy.modelSelection.criteria)).toEqual(["NORMAL", "HARD"]);
    expect(questions.effort0!.criteria).toEqual({
      high: policy.effortSelection.criteria.high,
      xhigh: policy.effortSelection.criteria.xhigh,
    });
    // 강도 질문은 그 후보의 좁혀진 허용 구간만 묻는다. 정책 리터럴을 복사해 결합하지 않는다.
    const deepseekBand = banded.find((candidate) => candidate.profile === "NORMAL_DEEPSEEK")!.efforts;
    expect(Object.keys(questions.effort1!.criteria!).sort()).toEqual([...deepseekBand].sort());
    expect(questions).not.toHaveProperty("effort2");
    expect(questions.effort4!.criteria).not.toHaveProperty("max");
    const ownerQuestions = routingQuestions(policy, banded, [{ name: "Existing", primaryDeliverable: "x", ownedPaths: ["x.ts"] }]);
    expect(ownerQuestions.duplicate!.type).toBe("noul");
    expect(ownerQuestions.ownerTarget!.criteria).toHaveProperty("owner0");
    expect(state.unknowns).toEqual(facts.unknowns);
  });
});

describe("후보 provider 갱신 공유와 잔량 예산", () => {
  // registry 경로를 실제로 도는 하네스. deps.candidates를 주입하지 않는다.
  const profileModels: Record<string, string> = {
    NORMAL: "openai-codex/gpt-6-luna",
    NORMAL_DEEPSEEK: "anthropic/claude-opus-5-5",
    NORMAL_SOL: "openai-codex/gpt-6-sol",
    HARD_UI_UX: "anthropic/claude-opus-5-5",
    HARD_CODE_SYSTEM: "anthropic/claude-opus-5-5",
    HARD_CODE_SYSTEM_ALTERNATE: "openai-codex/gpt-6-astra",
  };
  const strengths = ["low", "medium", "high", "xhigh", "max"];
  const normalAnswers = {
    workClass: { choice: "NORMAL" }, hardFocus: { choice: "CODE_SYSTEM" },
    effort0: { choice: "high" }, effort1: { choice: "medium" }, effort2: { choice: "medium" },
    effort3: { choice: "high" }, effort4: { choice: "high" }, effort5: { choice: "high" },
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
      settings: async () => ({ get: () => modelRoles }),
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
  const dispatchInput = (task: { name: string }, model = "openai-codex/gpt-6-luna:high") => ({
    context: "계약", tasks: [{ name: task.name, task: brief, agent: "maker", model }],
  });

  test("같은 호출의 후보 해석은 provider마다 한 번만, 서로 다른 provider는 함께 갱신한다", async () => {
    const ready = new Set<string>();
    const refreshCalls: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const registry = {
      find: (provider: string) => (ready.has(provider) ? { thinking: { efforts: strengths } } : undefined),
      refreshProvider: async (provider: string) => {
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
    // 두 provider가 모두 첫 await 전에 진입해야 병렬이다. 순차 구현은 maxInFlight가 1이다.
    expect(maxInFlight).toBe(2);
    expect(new Set(refreshCalls).size).toBe(refreshCalls.length);
    // 순서는 정본 profile 순서 그대로다.
    expect(batch.candidates.map((candidate) => candidate.profile)).toEqual(Object.keys(h.policy.modelSelection.profiles));
    expect(batch.unavailableCandidates).toEqual([]);
  });

  test("준비에서 실패한 provider는 같은 발주에서 재조회하지 않고 새 준비에서는 다시 시도한다", async () => {
    const refreshCalls: string[] = [];
    const registry = {
      find: (provider: string) => provider === "anthropic" ? undefined : { thinking: { efforts: strengths } },
      refreshProvider: async (provider: string) => { refreshCalls.push(provider); throw new Error("offline"); },
    };
    const h = registryHarness({ registry });
    const tasks = ["FixA", "FixB", "FixC"].map((name) => ({ name, task: brief, assessment: facts }));
    const batch = await h.route.prepareBatch("계약", tasks, h.ctx);
    expect(batch.unavailableCandidates.map((entry) => entry.profile)).toEqual(["NORMAL_DEEPSEEK", "HARD_UI_UX", "HARD_CODE_SYSTEM"]);
    expect(refreshCalls.filter((provider) => provider === "anthropic")).toHaveLength(1);
    refreshCalls.length = 0;
    const input = {
      context: "계약",
      tasks: tasks.map((entry) => ({ name: entry.name, task: entry.task, agent: "maker", model: "openai-codex/gpt-6-luna:high" })),
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
      refreshProvider: async () => {},
    };
    const h = registryHarness({ registry });
    await h.route.prepareBatch("계약", [h.task], h.ctx);
    drifted = true;
    expect(await h.route.beforeTask(dispatchInput(h.task), h.ctx)).toMatchObject({ block: true });
  });

  test("갱신 뒤 찾은 후보도 지원 강도를 확인할 수 없으면 발주 후보에서 제외된다", async () => {
    const refreshed = new Set<string>();
    const registry = {
      find: (provider: string) => {
        if (provider !== "anthropic") return { thinking: { efforts: strengths } };
        return refreshed.has(provider) ? { thinking: { efforts: ["unsupported"] } } : undefined;
      },
      refreshProvider: async (provider: string) => { refreshed.add(provider); },
    };
    const h = registryHarness({ registry });
    const batch = await h.route.prepareBatch("계약", [h.task], h.ctx);
    expect(batch.candidates.map((candidate) => candidate.profile)).toEqual(["NORMAL", "NORMAL_SOL", "HARD_CODE_SYSTEM_ALTERNATE"]);
    expect(batch.unavailableCandidates.map(({ profile, model }) => ({ profile, model }))).toEqual([
      { profile: "NORMAL_DEEPSEEK", model: "anthropic/claude-opus-5-5" },
      { profile: "HARD_UI_UX", model: "anthropic/claude-opus-5-5" },
      { profile: "HARD_CODE_SYSTEM", model: "anthropic/claude-opus-5-5" },
    ]);
  });

  test("후보 강도는 registry 지원과 profile 허용 구간의 교집합이고 Jev는 그 안에서만, 하나뿐이면 묻지 않는다", async () => {
    const registry = {
      find: (provider: string, id: string) => ({
        thinking: { efforts: `${provider}/${id}` === "openai-codex/gpt-6-luna" ? ["low", "medium", "high"] : strengths },
      }),
      refreshProvider: async () => {},
    };
    const h = registryHarness({ registry });
    const batch = await h.route.prepareBatch("계약", [h.task], h.ctx);
    // 후보 모델은 fixture가 정하고, 강도는 registry 지원 ∩ profile 허용 구간이어야 한다. 정책 리터럴을 복사하지 않는다.
    expect(batch.candidates.map(({ profile, model }) => ({ profile, model })))
      .toEqual(Object.entries(profileModels).map(([profile, model]) => ({ profile, model })));
    for (const candidate of batch.candidates) {
      const allowed = h.policy.modelSelection.profiles[candidate.profile]!.allowedEfforts;
      const supported = candidate.model === "openai-codex/gpt-6-luna" ? ["low", "medium", "high"] : strengths;
      expect(candidate.efforts).toEqual(supported.filter((level) => allowed.includes(level)));
    }
    const asked = h.questions[0] as Record<string, { criteria: Record<string, string> }>;
    // 허용 강도가 하나뿐인 후보는 묻지 않고, 둘 이상인 후보만 그 구간을 묻는다.
    expect(asked).not.toHaveProperty("effort0");
    expect(Object.keys(asked.effort1!.criteria)).toEqual(batch.candidates.find((c) => c.profile === "NORMAL_DEEPSEEK")!.efforts);
    expect(Object.keys(asked.effort5!.criteria)).toEqual(batch.candidates.find((c) => c.profile === "HARD_CODE_SYSTEM_ALTERNATE")!.efforts);
  });

  test("느린 잔량 사이드카는 route 판단 뒤 즉시 취소하고 배치를 붙잡지 않는다", async () => {
    // 응답하지 않는 실제 HTTP 응답에 fetch abort가 걸리는지 보는 검사다. 가짜 timer로는
    // abort 경로와 실측 시간을 대신할 수 없어 이 한 건만 platform clock을 쓴다.
    const stalled = Promise.withResolvers<Response>();
    const server = Bun.serve({ port: 0, fetch: () => stalled.promise });
    const previous = process.env.OMP_USAGE_PORT;
    process.env.OMP_USAGE_PORT = String(server.port);
    try {
      const registry = { find: () => ({ thinking: { efforts: strengths } }), refreshProvider: async () => {} };
      const h = registryHarness({ registry, useSidecar: true });
      const started = Date.now();
      const batch = await h.route.prepareBatch("계약", [h.task], h.ctx);
      expect(batch.quota.state).toBe("unavailable");
      if (batch.quota.state !== "unavailable") throw new Error("느린 quota가 observed로 반환됨");
      expect(batch.quota.reason).toContain("route 판단 완료");
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      if (previous === undefined) delete process.env.OMP_USAGE_PORT;
      else process.env.OMP_USAGE_PORT = previous;
      await server.stop(true);
    }
  });
});

describe("HARD 분야와 NORMAL 한도 기반 배정", () => {
  test("후보별 허용 강도 구간 밖 선택은 같은 모델 이름으로 우회하지 못한다", async () => {
    const reasoned = brief.replace("OWNED_PATHS:", "ROUTING_REASON: Main이 후보 구간 안에서 선택함\nOWNED_PATHS:");
    // NORMAL_DEEPSEEK 구간은 정책이 정한다. 리터럴을 복사하지 않고 구간 안/밖을 정책에서 파생해 검사한다.
    const deepseekBand = loadRoutingPolicy().modelSelection.profiles.NORMAL_DEEPSEEK!.allowedEfforts;
    const deepseekOutside = allStrengths.filter((level) => !deepseekBand.includes(level));
    const cases: Record<string, [string, boolean][]> = {
      // NORMAL 조각: Luna는 자기 구간, NORMAL 자리의 Opus는 NORMAL_DEEPSEEK 구간, Sol은 NORMAL_SOL 구간을 따른다.
      // 등급에 없는 Astra는 그 후보 구간을 따른다.
      NORMAL: [
        ["openai-codex/gpt-6-luna:medium", false], ["openai-codex/gpt-6-luna:xhigh", true],
        ...deepseekBand.map((level): [string, boolean] => [`anthropic/claude-opus-5-5:${level}`, true]),
        ...deepseekOutside.map((level): [string, boolean] => [`anthropic/claude-opus-5-5:${level}`, false]),
        ["openai-codex/gpt-6-sol:low", true], ["openai-codex/gpt-6-sol:high", false],
        ["openai-codex/gpt-6-astra:high", true], ["openai-codex/gpt-6-luna:max", false],
      ],
      // HARD 조각: Opus는 HARD 구간(high·xhigh)으로 검사한다. NORMAL 후보로 낮추는 선택은 그 후보 구간을 따른다.
      HARD: [
        ["anthropic/claude-opus-5-5:medium", false], ["anthropic/claude-opus-5-5:high", true],
        ["anthropic/claude-opus-5-5:max", false], ["openai-codex/gpt-6-astra:xhigh", true],
        ["openai-codex/gpt-6-luna:high", true], ["openai-codex/gpt-6-sol:medium", true],
      ],
    };
    for (const [workClass, selections] of Object.entries(cases)) {
      const h = harness({ workClass, hardFocuses: ["CODE_SYSTEM"] });
      await h.prepare("후보별 강도 구간", [h.task], {} as never);
      for (const [model, allowed] of selections) {
        const result = await h.dispatch(model, reasoned);
        if (allowed) expect(result).toBeUndefined();
        else expect(result).toMatchObject({ block: true });
      }
    }
  });
  test("추천과 다른 후보는 구간 안이어도 ROUTING_REASON이 있어야 하고 Jev 불가 때는 강도를 허용하는 후보로 본다", async () => {
    const reasoned = brief.replace("OWNED_PATHS:", "ROUTING_REASON: Main이 대체 후보를 선택함\nOWNED_PATHS:");
    const hard = harness({ workClass: "HARD", hardFocuses: ["CODE_SYSTEM"] });
    await hard.prepare("HARD 대체", [hard.task], {} as never);
    expect(await hard.dispatch("anthropic/claude-opus-5-5:xhigh")).toBeUndefined();
    expect(await hard.dispatch("openai-codex/gpt-6-astra:high")).toMatchObject({ block: true });
    expect(await hard.dispatch("openai-codex/gpt-6-astra:high", reasoned)).toBeUndefined();
    const normal = harness({ workClass: "NORMAL" });
    await normal.prepare("NORMAL 대체", [normal.task], {} as never);
    expect(await normal.dispatch("anthropic/claude-opus-5-5:medium")).toMatchObject({ block: true });
    const unavailable = harness({ fail: true });
    await unavailable.prepare("Jev 불가", [unavailable.task], {} as never);
    expect(await unavailable.dispatch("anthropic/claude-opus-5-5:high")).toMatchObject({ block: true });
    for (const model of ["anthropic/claude-opus-5-5:high", "anthropic/claude-opus-5-5:xhigh"]) {
      expect(await unavailable.dispatch(model, reasoned)).toBeUndefined();
    }
    expect(await unavailable.dispatch("anthropic/claude-opus-5-5:max", reasoned)).toMatchObject({ block: true });
  });
  test("Main 계열이 바뀌어도 HARD의 분야별 모델과 준비 판단을 유지한다", async () => {
    for (const [focus, profile, model] of [
      ["UI_UX", "HARD_UI_UX", "anthropic/claude-opus-5-5:high"],
      ["CODE_SYSTEM", "HARD_CODE_SYSTEM", "anthropic/claude-opus-5-5:xhigh"],
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
  test("NORMAL은 사용 가능한 primary Luna를 우선하고, Luna 소진일 때만 대안을 추천하며 미관측은 소진으로 보지 않는다", async () => {
    const account = (usedFraction: number, extra: Record<string, unknown> = {}) => ({
      credentialId: 1, disabled: false, autoBlockedUntilMs: null, limitReached: false, fetchedAt: 1,
      limits: [{ id: "limit", usedFraction, resetsAt: null, daySlot: null }],
      ...extra,
    });
    // 실제 배치처럼 NORMAL_DEEPSEEK를 HARD(Opus)와 겹치지 않는 OpenCode Go 모델로 둔다.
    const deepseek = candidates.map((candidate) => candidate.profile === "NORMAL_DEEPSEEK"
      ? { ...candidate, model: "opencode-go/deepseek-v4-flash" } : candidate);
    const build = (providers: Record<string, unknown[]>) => harness({
      workClass: "NORMAL", candidates: deepseek,
      families: { ...families, "opencode-go/deepseek-v4-flash": "deepseek" },
      quota: async () => ({ state: "observed", observedAt: 1, providers }),
    });

    // 1) Luna가 사용 가능하면 대안 여유가 더 커도(0.8 대 0.2) primary NORMAL을 유지한다.
    const usable = build({ "openai-codex": [account(0.8)], anthropic: [account(0.2)], "opencode-go": [account(0.2)] });
    const first = await usable.prepareBatch("한도 배분", [usable.task], {} as never);
    expect(first.routes[0]).toMatchObject({ profile: "NORMAL", normalAllocation: { state: "observed", profile: "NORMAL" } });
    expect(await usable.dispatch("openai-codex/gpt-6-luna:high")).toBeUndefined();
    expect(await usable.dispatch("openai-codex/gpt-6-luna:low")).toMatchObject({ block: true });
    expect(usable.requests).toHaveLength(1);

    // 2) Luna provider 계정이 실제로 소진(limitReached)되면 사용 가능한 NORMAL 대안을 추천한다.
    const spent = build({
      "openai-codex": [account(1, { limitReached: true })], anthropic: [account(0.2)], "opencode-go": [account(0.2)],
    });
    const second = await spent.prepareBatch("한도 배분", [spent.task], {} as never);
    expect(second.routes[0]).toMatchObject({ profile: "NORMAL_DEEPSEEK", normalAllocation: { state: "observed", profile: "NORMAL_DEEPSEEK" } });

    // 3) 미관측은 소진으로 간주하지 않는다. primary를 유지한다.
    const blind = harness({
      workClass: "NORMAL", candidates: deepseek,
      families: { ...families, "opencode-go/deepseek-v4-flash": "deepseek" },
      quota: async () => ({ state: "unavailable", observedAt: 0, reason: "관측 실패" }),
    });
    const third = await blind.prepareBatch("한도 배분", [blind.task], {} as never);
    expect(third.routes[0]).toMatchObject({ profile: "NORMAL", normalAllocation: { state: "unavailable", profile: "NORMAL" } });
    expect(await blind.dispatch("openai-codex/gpt-6-luna:high")).toBeUndefined();

    // 4) HARD 배정은 계정 상태와 무관하게 분야를 따른다.
    const hard = harness({ workClass: "HARD", hardFocuses: ["CODE_SYSTEM"] });
    expect((await hard.prepareBatch("HARD 유지", [hard.task], {} as never)).routes[0]!.profile).toBe("HARD_CODE_SYSTEM");
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
    expect(main.route.profile).toBe("NORMAL");
    expect(maker.route.profile).toBe("NORMAL");
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
      recommendedProfile: "HARD_CODE_SYSTEM", recommendedModel: "anthropic/claude-opus-5-5", recommendedEffort: "high",
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
    const astra = "openai-codex/gpt-6-astra:high";
    expect(await h.dispatch(astra)).toMatchObject({ block: true });
    h.noteSpawned({ context: h.input.context, tasks: [{ ...h.input.tasks[0], model: astra }] });
    expect(ledger.records).toHaveLength(before);

    const reasoned = brief.replace("OWNED_PATHS:", "ROUTING_REASON: 독립 판단이 필요해 대안을 선택함\nOWNED_PATHS:");
    expect(await h.dispatch(astra, reasoned)).toBeUndefined();
    // 통과한 초안과 다른 selector로 spawn된 결과는 기록하지 않는다.
    h.noteSpawned({ context: h.input.context, tasks: [{ ...h.input.tasks[0], task: reasoned, model: "anthropic/claude-opus-5-5:xhigh" }] });
    expect(ledger.records).toHaveLength(before);
    expect(await h.dispatch(astra, reasoned)).toBeUndefined();
    h.noteSpawned({ context: h.input.context, tasks: [{ ...h.input.tasks[0], task: reasoned, model: astra }] });
    expect(ledger.records).toHaveLength(before + 1);
    expect(ledger.records.at(-1)).toMatchObject({
      type: "dispatch", name: "ViewFix", workClass: "HARD", focus: "CODE_SYSTEM",
      recommendedProfile: "HARD_CODE_SYSTEM", recommendedModel: "anthropic/claude-opus-5-5", recommendedEffort: "xhigh",
      chosenModel: "openai-codex/gpt-6-astra", chosenEffort: "high", routingReason: true, purpose: null,
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
