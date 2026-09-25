import { describe, expect, test } from "bun:test";

import {
  bindSpawnAliases,
  buildOwnershipReport,
  CANCEL_REFUND_LIMIT,
  createOwnershipState,
  createTaskGuardState,
  diffTreeSnapshots,
  getTaskGuardUsage,
  hasUnreportedChildren,
  isPathOwned,
  matchBlockedEvalModelBridge,
  noteUserRedirect,
  parseOwnedPaths,
  readCancelledJobIds,
  readSettledTaskIds,
  readSpawnProgress,
  registerSpawnedMakers,
  releaseCancelledSpawns,
  reportOwnedChildren,
  reserveTaskCall,
  reservedMakers,
  rollbackTaskCall,
  stripScopePrefix,
  TASK_BUDGET_LIMITS,
  type TaskGuardDecision,
  type TaskGuardState,
  type TreeSnapshot,
  unreportedOwnedChildIds,
} from "./task-guard";

function brief(overrides: Partial<Record<string, string>> = {}): string {
  const values = {
    WORK_CLASS: "feature",
    PURPOSE: "primary",
    BLOCKS_PRIMARY: "yes",
    PRIMARY_DELIVERABLE: "Arena에서 A/B 토론을 실행할 수 있다",
    OWNED_PATHS: "agent/extensions/command-guard/",
    ...overrides,
  };
  const finding = values.FINDING_ID ? `\nFINDING_ID: ${values.FINDING_ID}` : "";
  const owned = values.OWNED_PATHS ? `\nOWNED_PATHS: ${values.OWNED_PATHS}` : "";
  return `TASK_GUARD:\nWORK_CLASS: ${values.WORK_CLASS}\nPURPOSE: ${values.PURPOSE}\nBLOCKS_PRIMARY: ${values.BLOCKS_PRIMARY}\nPRIMARY_DELIVERABLE: ${values.PRIMARY_DELIVERABLE}${owned}${finding}\n\nImplement the requested slice.`;
}

function flat(agent: string, task: string) {
  return { agent, task };
}

/** 트리 스냅샷 테스트용 plain data. 실제 git 호출은 여기서 만들지 않는다. */
function snap(entries: Array<[string, string | undefined]>): TreeSnapshot {
  return new Map(entries);
}

/** primary Maker 한도를 named child로 정확히 채우고 그 이름을 순서대로 돌려준다. */
function fillPrimaryMakers(state: TaskGuardState): string[] {
  const names: string[] = [];
  for (let index = 0; index < TASK_BUDGET_LIMITS.primaryMaker; index += 1) {
    const name = `Filler${index}`;
    const spawn = { tasks: [{ agent: "maker", name, task: brief() }] };
    expect(reserveTaskCall(state, `fill-${index}`, spawn).ok).toBe(true);
    names.push(name);
  }
  return names;
}

/** lock을 확립하는 첫 child. 이후 항목은 lock에서 파생할 수 있다. */
function lockedState(): TaskGuardState {
  const state = createTaskGuardState();
  expect(reserveTaskCall(state, "lock", flat("maker", brief())).ok).toBe(true);
  return state;
}

describe("TaskBudget", () => {
  test("static 누적 한도는 8-slot 두 primary wave와 한 rework·cancel wave를 허용한다", () => {
    expect(TASK_BUDGET_LIMITS).toEqual({
      primaryMaker: 16,
      reworkMaker: 8,
      total: 24,
    });
    expect(CANCEL_REFUND_LIMIT).toBe(8);
  });

  test("8-item primary batch 두 번은 통과하고 17번째는 거부한다", () => {
    const state = createTaskGuardState();
    const wave = () => ({
      tasks: Array.from({ length: 8 }, () => ({ agent: "maker", task: brief() })),
    });

    expect(reserveTaskCall(state, "wave-1", wave()).ok).toBe(true);
    expect(reserveTaskCall(state, "wave-2", wave()).ok).toBe(true);
    expect(getTaskGuardUsage(state)).toEqual({
      primaryMaker: 16,
      reworkMaker: 0,
      total: 16,
    });

    const over = reserveTaskCall(state, "over", flat("maker", brief()));
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.reason).toContain("primary Maker");
      expect(over.reason).toContain("current=16 requested=1 next=17 limit=16");
    }
  });

  test("한도 초과 batch는 current/requested/next/limit를 알리고 usage를 소비하지 않는다", () => {
    const state = createTaskGuardState();
    for (let index = 0; index < 13; index += 1) {
      expect(reserveTaskCall(state, `fill-${index}`, flat("maker", brief())).ok).toBe(true);
    }
    const rejected = reserveTaskCall(state, "batch-over", {
      tasks: Array.from({ length: 4 }, () => ({ agent: "maker", task: brief() })),
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.reason).toContain("current=13 requested=4 next=17 limit=16");
    }
    expect(getTaskGuardUsage(state)).toEqual({
      primaryMaker: 13,
      reworkMaker: 0,
      total: 13,
    });

    const remaining = reserveTaskCall(state, "remaining", {
      tasks: Array.from({ length: 3 }, () => ({ agent: "maker", task: brief() })),
    });
    expect(remaining.ok).toBe(true);
    expect(getTaskGuardUsage(state).primaryMaker).toBe(16);
  });

  test("full 8-item rework batch는 통과하고 9번째는 거부한다", () => {
    const state = createTaskGuardState();
    const rework = brief({ PURPOSE: "rework", FINDING_ID: "F-17" });
    expect(
      reserveTaskCall(state, "rework-wave", {
        tasks: Array.from({ length: 8 }, () => ({ agent: "maker", task: rework })),
      }).ok,
    ).toBe(true);
    expect(getTaskGuardUsage(state)).toEqual({
      primaryMaker: 0,
      reworkMaker: 8,
      total: 8,
    });

    const over = reserveTaskCall(state, "rework-over", flat("maker", rework));
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.reason).toContain("rework Maker");
      expect(over.reason).toContain("current=8 requested=1 next=9 limit=8");
    }
  });

  test("primary 16과 rework 8을 합친 total 24 위 spawn은 거부한다", () => {
    const state = createTaskGuardState();
    fillPrimaryMakers(state);
    const rework = brief({ PURPOSE: "rework", FINDING_ID: "F-17" });
    expect(
      reserveTaskCall(state, "rework-wave", {
        tasks: Array.from({ length: 8 }, () => ({ agent: "maker", task: rework })),
      }).ok,
    ).toBe(true);
    expect(getTaskGuardUsage(state)).toEqual({
      primaryMaker: 16,
      reworkMaker: 8,
      total: 24,
    });

    const over = reserveTaskCall(state, "total-over", flat("maker", rework));
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.reason).toContain("총 child spawn");
      expect(over.reason).toContain("current=24 requested=1 next=25 limit=24");
    }
    expect(getTaskGuardUsage(state).total).toBe(24);
  });

  test("rework Maker는 FINDING_ID가 있어야 한다", () => {
    const state = createTaskGuardState();
    const missing = reserveTaskCall(state, "1", flat("maker", brief({ PURPOSE: "rework" })));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toMatch(/FINDING_ID/);
    expect(getTaskGuardUsage(state).total).toBe(0);
  });
});

describe("SideQuestGuard", () => {
  test("primary deliverable을 진전시키지 않는 child는 차단한다", () => {
    const state = createTaskGuardState();
    const decision = reserveTaskCall(
      state,
      "1",
      flat("maker", brief({ BLOCKS_PRIMARY: "no" })),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/SideQuestGuard/);
    expect(getTaskGuardUsage(state).total).toBe(0);
  });

  test("요청 중 WORK_CLASS와 PRIMARY_DELIVERABLE 변경을 차단한다", () => {
    const state = lockedState();
    for (const [label, drift] of [
      ["WORK_CLASS", brief({ WORK_CLASS: "diagnostic" })],
      ["PRIMARY_DELIVERABLE", brief({ PRIMARY_DELIVERABLE: "관측 로그를 정리한다" })],
    ] as const) {
      const decision = reserveTaskCall(state, `drift-${label}`, flat("maker", drift));
      expect(decision.ok).toBe(false);
      if (!decision.ok) expect(decision.reason).toMatch(/SideQuestGuard/);
    }
    expect(getTaskGuardUsage(state).primaryMaker).toBe(1);
  });

  test("lock 없는 첫 child의 미기재와 폐지된 역할을 차단한다", () => {
    const state = createTaskGuardState();
    // lock이 없으면 사람이 판단해야 하는 두 값은 파생할 수 없다.
    const missing = reserveTaskCall(state, "1", flat("maker", "Do the work"));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toMatch(/WORK_CLASS/);

    const unknown = reserveTaskCall(state, "2", flat("scout", brief()));
    expect(unknown.ok).toBe(false);
  });

  test("batch 중 하나라도 side quest면 전체 호출을 거부하고 budget을 소비하지 않는다", () => {
    const state = createTaskGuardState();
    const decision = reserveTaskCall(state, "1", {
      tasks: [
        { agent: "maker", task: brief() },
        { agent: "maker", task: brief({ BLOCKS_PRIMARY: "no" }) },
      ],
    });
    expect(decision.ok).toBe(false);
    expect(getTaskGuardUsage(state)).toEqual({
      primaryMaker: 0,
      reworkMaker: 0,
      total: 0,
    });
  });

  test("실제 task tool 오류가 나면 선점한 budget을 되돌린다", () => {
    const state = createTaskGuardState();
    expect(reserveTaskCall(state, "1", flat("maker", brief())).ok).toBe(true);
    rollbackTaskCall(state, "1");
    expect(getTaskGuardUsage(state).total).toBe(0);
    expect(reserveTaskCall(state, "2", flat("maker", brief())).ok).toBe(true);
  });
});

describe("eval spawn bypass", () => {
  test("eval의 child 생성 호출과 흔한 alias 우회를 차단한다", () => {
    const blocked = [
      'await agent("inspect")',
      'await workpool(items)',
      'await tool.task({ agent: "maker", task: "x" })',
      'const run = agent; await run("x")',
      'spawn = workpool\nspawn(items)',
    ];
    for (const code of blocked) {
      expect(matchBlockedEvalModelBridge({ language: "js", code })).toMatch(/SpawnGuard/);
    }
  });

  test("판정 상담용 stateless completion과 일반 eval·browser 관측은 허용한다", () => {
    const allowed = [
      'completion("judge", { model: "slow" })',
      'const verdict = completion(packet, { model: "slow" }); display(await verdict.wait())',
      'const data = await read("package.json"); display(data)',
      'await tool.browser({ action: "screenshot" })',
      'const agentCount = rows.length; display(agentCount)',
    ];
    for (const code of allowed) {
      expect(matchBlockedEvalModelBridge({ language: "js", code })).toBeUndefined();
    }
  });
});

describe("취소 환불", () => {
  // `write proc://<id>/kill` 결과: details.proc = executeCancel details(`cancelled[]`는 id·status).
  const killDetails = (...outcomes: Array<[string, string]>) => ({
    proc: { op: "cancel", jobs: [], cancelled: outcomes.map(([id, status]) => ({ id, status })) },
  });

  test("proc kill 결과에서 런타임이 cancelled로 확인한 id만 읽는다", () => {
    expect(
      readCancelledJobIds(killDetails(["LiveServer", "cancelled"], ["Done", "already_completed"], ["Foreign", "not_found"])),
    ).toEqual(["LiveServer"]);
    expect(readCancelledJobIds({ proc: { action: "stop", daemon: {} } })).toEqual([]);
    expect(readCancelledJobIds(undefined)).toEqual([]);
  });

  test("취소가 확인된 named child의 슬롯은 다시 쓸 수 있다", () => {
    const state = createTaskGuardState();
    const names = fillPrimaryMakers(state);
    expect(reserveTaskCall(state, "over", flat("maker", brief())).ok).toBe(false);

    const cancelled = names.slice(0, CANCEL_REFUND_LIMIT);
    expect(
      releaseCancelledSpawns(
        state,
        readCancelledJobIds(killDetails(...cancelled.map((name): [string, string] => [name, "cancelled"]))),
      ),
    ).toBe(CANCEL_REFUND_LIMIT);
    const remaining = TASK_BUDGET_LIMITS.primaryMaker - CANCEL_REFUND_LIMIT;
    expect(getTaskGuardUsage(state)).toEqual({
      primaryMaker: remaining,
      reworkMaker: 0,
      total: remaining,
    });
    expect(reserveTaskCall(state, "after", flat("maker", brief())).ok).toBe(true);
  });

  test("이름 없는 spawn과 취소되지 않은 job은 환불하지 않는다", () => {
    const state = createTaskGuardState();
    expect(reserveTaskCall(state, "1", flat("maker", brief())).ok).toBe(true);
    expect(releaseCancelledSpawns(state, ["Unknown"])).toBe(0);
    expect(getTaskGuardUsage(state).primaryMaker).toBe(1);
  });

  test("full 8-slot refund는 모두 재사용할 수 있고 9번째 refund는 허용하지 않는다", () => {
    const state = createTaskGuardState();
    const named = (name: string) => ({ tasks: [{ agent: "maker", name, task: brief() }] });
    const names = fillPrimaryMakers(state);
    const cancelled = names.slice(0, CANCEL_REFUND_LIMIT);
    expect(releaseCancelledSpawns(state, cancelled)).toBe(8);

    const refilled = cancelled.map((name) => `${name}-again`);
    refilled.forEach((name, index) => {
      expect(reserveTaskCall(state, `refill-${index}`, named(name)).ok).toBe(true);
    });
    expect(getTaskGuardUsage(state)).toEqual({
      primaryMaker: 16,
      reworkMaker: 0,
      total: 16,
    });
    expect(releaseCancelledSpawns(state, [refilled[0]!])).toBe(0);
    expect(getTaskGuardUsage(state).primaryMaker).toBe(16);
    expect(reserveTaskCall(state, "over", named("Extra")).ok).toBe(false);
  });
});

describe("사용자 redirect", () => {
  test("사람이 방향을 바꾸면 deliverable lock만 풀고 budget은 유지한다", () => {
    const state = createTaskGuardState();
    expect(reserveTaskCall(state, "1", flat("maker", brief())).ok).toBe(true);

    const redirected = brief({ PRIMARY_DELIVERABLE: "Run X-Ray 화면" });
    const drift = reserveTaskCall(state, "2", flat("maker", redirected));
    expect(drift.ok).toBe(false);

    expect(noteUserRedirect(state)).toBe(true);
    // 첫 발주는 그대로 소비된 상태여야 한다: 남은 자리는 한도 - 1 뿐이다.
    for (let index = 1; index < TASK_BUDGET_LIMITS.primaryMaker; index += 1) {
      expect(reserveTaskCall(state, `r${index}`, flat("maker", redirected)).ok).toBe(true);
    }
    expect(getTaskGuardUsage(state).primaryMaker).toBe(TASK_BUDGET_LIMITS.primaryMaker);

    const overBudget = reserveTaskCall(state, "over", flat("maker", redirected));
    expect(overBudget.ok).toBe(false);
  });
});

describe("OWNED_PATHS", () => {
  test("maker spawn은 OWNED_PATHS가 없으면 거부한다", () => {
    const state = createTaskGuardState();
    const missing = reserveTaskCall(state, "1", flat("maker", brief({ OWNED_PATHS: "" })));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toMatch(/OWNED_PATHS/);
    expect(getTaskGuardUsage(state).total).toBe(0);
  });

  test("콤마로 나눈 소유 경로를 maker 항목별로 남긴다", () => {
    const state = createTaskGuardState();
    const decision = reserveTaskCall(state, "1", {
      tasks: [
        { agent: "maker", name: "First", task: brief({ OWNED_PATHS: "x/" }) },
        { agent: "maker", name: "Guard", task: brief({ OWNED_PATHS: "a/b/, c.txt" }) },
        { agent: "maker", task: brief({ OWNED_PATHS: "." }) },
      ],
    });
    expect(decision.ok).toBe(true);
    // 이름 없는 항목에는 name 키가 없고, index는 전체 tasks[] 기준을 유지한다.
    expect(reservedMakers(state, "1")).toEqual([
      { name: "First", index: 0, ownedPaths: ["x/"] },
      { name: "Guard", index: 1, ownedPaths: ["a/b/", "c.txt"] },
      { index: 2, ownedPaths: ["."] },
    ]);
  });

  test("빈 항목과 앞뒤 공백은 버리고 선행 ./는 떼어낸다", () => {
    expect(parseOwnedPaths(" a/b/ , c.txt ,, ")).toEqual(["a/b/", "c.txt"]);
    expect(parseOwnedPaths("./a/b/, ./c.txt")).toEqual(["a/b/", "c.txt"]);
    expect(parseOwnedPaths(undefined)).toEqual([]);
  });

  test("절대경로 OWNED_PATHS는 거부한다", () => {
    const state = createTaskGuardState();
    for (const absolute of ["C:\\proj\\a/", "/etc/x", "\\\\server\\share\\a"]) {
      const decision = reserveTaskCall(state, absolute, flat("maker", brief({ OWNED_PATHS: absolute })));
      expect(decision.ok).toBe(false);
      if (!decision.ok) expect(decision.reason).toMatch(/절대경로/);
    }
    expect(getTaskGuardUsage(state).total).toBe(0);
  });

  test("cwd 밖을 가리키는 `..` 표기는 거부한다", () => {
    const state = createTaskGuardState();
    for (const escaping of ["../x.txt", "..", "..\\x.txt", "a/../b.txt", "a/../../x"]) {
      const decision = reserveTaskCall(state, escaping, flat("maker", brief({ OWNED_PATHS: escaping })));
      expect(decision.ok).toBe(false);
      if (!decision.ok) expect(decision.reason).toMatch(/OWNED_PATHS/);
    }
    // cwd 안에 머무는 표기는 계속 허용한다.
    expect(
      reserveTaskCall(state, "ok", flat("maker", brief({ OWNED_PATHS: "sub/dir/, c.txt" }))).ok,
    ).toBe(true);
  });
});

describe("완료 스냅샷 접두사 처리", () => {
  test("cwd→root 접두사를 대소문자 무시로 떼어낸다", () => {
    expect(stripScopePrefix("Tools/App/src/a.ts", "Tools/App/")).toBe("src/a.ts");
    // show-prefix와 status 경로의 케이싱이 어긋나도 같은 경로로 본다.
    expect(stripScopePrefix("tools/app/src/a.ts", "Tools/App/")).toBe("src/a.ts");
    expect(stripScopePrefix("Tools/App/src/a.ts", "tools/app/")).toBe("src/a.ts");
    expect(stripScopePrefix("Tools\\App\\src\\a.ts", "Tools/App/")).toBe("src/a.ts");
    // 저장소 root가 세션이면 접두사가 없다.
    expect(stripScopePrefix("src/a.ts", "")).toBe("src/a.ts");
  });

  test("접두사가 맞지 않으면 항목을 버리지 않고 undefined를 돌린다", () => {
    expect(stripScopePrefix("Other/src/a.ts", "Tools/App/")).toBeUndefined();
    expect(stripScopePrefix("Tools/Other/a.ts", "Tools/App/")).toBeUndefined();
    expect(stripScopePrefix("Tools/App", "Tools/App/")).toBeUndefined();
  });
});

describe("소유 경로 판정", () => {
  test("디렉터리 prefix·정확한 파일·`.` 의미를 구분한다", () => {
    expect(isPathOwned(["evals/"], "evals/cases/a.json")).toBe(true);
    expect(isPathOwned(["evals/"], "evals2/x.json")).toBe(false);
    expect(isPathOwned(["evals/x.json"], "evals/x.json")).toBe(true);
    expect(isPathOwned(["evals/x.json"], "evals/x.json.bak")).toBe(false);
    expect(isPathOwned(["evals"], "evals/x.json")).toBe(false);
    expect(isPathOwned(["."], "any/where.txt")).toBe(true);
    expect(isPathOwned(["evals/x.json"], "EVALS\\X.JSON")).toBe(true);
  });
});

describe("OwnershipGuard 보고 줄", () => {
  test("계약 형식대로 만들고 공백·콤마를 이스케이프한다", () => {
    expect(
      buildOwnershipReport({
        child: "Maker A",
        ownedPaths: ["src/", "a,b.txt"],
        changedPaths: ["src/a.ts", "outside/x y.json"],
        concurrent: ["Other,One"],
      }),
    ).toBe(
      "[OwnershipGuard] child=Maker%20A owned=src/,a%2Cb.txt outside=outside/x%20y.json concurrent=Other%2COne",
    );
  });

  test("소유 밖 변경이 없으면 none, 판정할 수 없으면 unobserved다", () => {
    expect(
      buildOwnershipReport({
        child: "M1",
        ownedPaths: ["src/"],
        changedPaths: ["src/a.ts"],
        concurrent: [],
      }),
    ).toBe("[OwnershipGuard] child=M1 owned=src/ outside=none concurrent=none");
    expect(buildOwnershipReport({ child: "M1", ownedPaths: ["src/"], concurrent: [] })).toBe(
      "[OwnershipGuard] child=M1 owned=src/ outside=unobserved concurrent=none",
    );
  });
});

describe("트리 스냅샷 diff", () => {
  test("새 파일·이미 dirty였던 파일 변경·삭제를 잡는다", () => {
    const before = snap([
      ["dirty.txt", "h1"],
      ["gone.txt", "h2"],
    ]);
    const after = snap([
      ["dirty.txt", "h3"],
      ["new.txt", "h4"],
    ]);
    expect(diffTreeSnapshots(before, after)).toEqual(["dirty.txt", "gone.txt", "new.txt"]);
  });

  test("지문이 그대로인 dirty 파일은 보고하지 않는다", () => {
    const before = snap([["dirty.txt", "h1"]]);
    expect(diffTreeSnapshots(before, snap([["dirty.txt", "h1"]]))).toEqual([]);
  });
});

describe("child 완료 보고", () => {
  test("한 번만 보고하고 소유 밖 변경을 남긴다", () => {
    const state = createOwnershipState();
    registerSpawnedMakers(
      state,
      "call-1",
      [{ name: "Alpha", index: 0, ownedPaths: ["src/"] }],
      snap([["src/a.ts", "h1"]]),
    );
    expect(reportOwnedChildren(state, ["Alpha"], snap([["src/a.ts", "h2"]]))).toEqual([
      "[OwnershipGuard] child=Alpha owned=src/ outside=none concurrent=none",
    ]);
    expect(reportOwnedChildren(state, ["Alpha"], snap([["src/a.ts", "h3"]]))).toEqual([]);
  });

  test("이름 없는 spawn은 progress id 별칭으로 되찾아 child=unnamed로 보고한다", () => {
    const state = createOwnershipState();
    const makers = [{ index: 0, ownedPaths: ["src/"] }];
    registerSpawnedMakers(state, "call-1", makers, snap([["src/a.ts", "h1"]]));
    bindSpawnAliases(state, "call-1", makers, [{ index: 0, id: "BoldFalcon" }]);
    expect(reportOwnedChildren(state, ["BoldFalcon"], snap([["src/a.ts", "h1"]]))).toEqual([
      "[OwnershipGuard] child=unnamed owned=src/ outside=none concurrent=none",
    ]);
  });

  test("같은 이름을 다시 spawn해도 보고된 항목이 가리지 않는다", () => {
    const state = createOwnershipState();
    registerSpawnedMakers(state, "call-1", [{ name: "Alpha", index: 0, ownedPaths: ["src/"] }], snap([]));
    expect(reportOwnedChildren(state, ["Alpha"], snap([]))).toEqual([
      "[OwnershipGuard] child=Alpha owned=src/ outside=none concurrent=none",
    ]);
    registerSpawnedMakers(state, "call-2", [{ name: "Alpha", index: 0, ownedPaths: ["src/"] }], snap([]));
    expect(reportOwnedChildren(state, ["Alpha"], snap([]))).toEqual([
      "[OwnershipGuard] child=Alpha owned=src/ outside=none concurrent=none",
    ]);
  });

  test("한 호출의 unnamed maker는 항목별로 각각 보고한다", () => {
    const state = createOwnershipState();
    const makers = [
      { index: 0, ownedPaths: ["a/"] },
      { index: 1, ownedPaths: ["b/"] },
    ];
    registerSpawnedMakers(state, "call-1", makers, snap([]));
    bindSpawnAliases(state, "call-1", makers, [
      { index: 0, id: "BoldFalcon" },
      { index: 1, id: "CalmOtter" },
    ]);
    expect(reportOwnedChildren(state, ["BoldFalcon"], snap([]))).toEqual([
      "[OwnershipGuard] child=unnamed owned=a/ outside=none concurrent=unnamed",
    ]);
    expect(reportOwnedChildren(state, ["CalmOtter"], snap([]))).toEqual([
      "[OwnershipGuard] child=unnamed owned=b/ outside=none concurrent=unnamed",
    ]);
  });

  test("살아 있는 동안 겹친 sibling을 attribution 후보로 남긴다", () => {
    const state = createOwnershipState();
    registerSpawnedMakers(state, "call-1", [{ name: "Alpha", index: 0, ownedPaths: ["a/"] }], snap([]));
    registerSpawnedMakers(state, "call-2", [{ name: "Beta", index: 0, ownedPaths: ["b/"] }], snap([]));
    expect(reportOwnedChildren(state, ["Beta"], snap([["a/x.txt", "h1"]]))[0]).toBe(
      "[OwnershipGuard] child=Beta owned=b/ outside=a/x.txt concurrent=Alpha",
    );
  });

  test("시작 전에 이미 끝난 sibling은 attribution 후보가 아니다", () => {
    const state = createOwnershipState();
    registerSpawnedMakers(state, "call-1", [{ name: "Alpha", index: 0, ownedPaths: ["a/"] }], snap([]));
    reportOwnedChildren(state, ["Alpha"], snap([]));
    registerSpawnedMakers(state, "call-2", [{ name: "Beta", index: 0, ownedPaths: ["b/"] }], snap([]));
    expect(reportOwnedChildren(state, ["Beta"], snap([]))[0]).toContain("concurrent=none");
  });

  test("스냅샷을 못 뜬 child는 outside=unobserved로 남긴다", () => {
    const state = createOwnershipState();
    registerSpawnedMakers(
      state,
      "call-1",
      [{ name: "Alpha", index: 0, ownedPaths: ["src/"] }],
      undefined,
    );
    expect(reportOwnedChildren(state, ["Alpha"], snap([]))).toEqual([
      "[OwnershipGuard] child=Alpha owned=src/ outside=unobserved concurrent=none",
    ]);
  });

  test("등록되지 않은 id는 보고하지 않는다", () => {
    const state = createOwnershipState();
    expect(hasUnreportedChildren(state)).toBe(false);
    expect(reportOwnedChildren(state, ["Nope"], snap([]))).toEqual([]);
  });

  test("이미 보고된 child만 있으면 스냅샷 대상이 비어 있다", () => {
    const state = createOwnershipState();
    registerSpawnedMakers(state, "call-1", [{ name: "Alpha", index: 0, ownedPaths: ["src/"] }], snap([]));
    expect(unreportedOwnedChildIds(state, ["Alpha", "Unknown"])).toEqual(["Alpha"]);
    reportOwnedChildren(state, ["Alpha"], snap([]));
    expect(unreportedOwnedChildIds(state, ["Alpha", "Unknown"])).toEqual([]);
    expect(hasUnreportedChildren(state)).toBe(false);
  });
});

describe("완료 관측 표면 파싱", () => {
  test("task 결과 progress에서 index·id·status를 읽는다", () => {
    expect(
      readSpawnProgress({
        progress: [
          { index: 0, id: "Alpha", status: "pending" },
          { index: 1, id: "Beta", status: "completed" },
        ],
      }),
    ).toEqual([
      { index: 0, id: "Alpha", status: "pending" },
      { index: 1, id: "Beta", status: "completed" },
    ]);
    expect(readSpawnProgress(undefined)).toEqual([]);
  });

  test("wait·async-result·read proc:// jobs[]에서 종료된 task job id만 읽는다", () => {
    expect(
      readSettledTaskIds({
        jobs: [
          { id: "Alpha", type: "task", status: "completed" },
          { id: "Beta", type: "task", status: "running" },
          { id: "bash_1", type: "bash", status: "completed" },
        ],
      }),
    ).toEqual(["Alpha"]);
    // async-result 전달은 status 없이 jobId만 온다.
    expect(readSettledTaskIds({ jobs: [{ jobId: "Beta", type: "task" }] })).toEqual(["Beta"]);
    expect(readSettledTaskIds(undefined)).toEqual([]);
  });
});

/** 교체 입력에서 해당 항목의 본문. 교체가 일어나지 않았으면 undefined. */
function rewrittenTask(decision: TaskGuardDecision, index = 0): string | undefined {
  if (!decision.ok || !decision.input) return undefined;
  const tasks = decision.input.tasks as Array<{ task: string }> | undefined;
  return tasks ? tasks[index]?.task : (decision.input.task as string | undefined);
}

describe("TASK_GUARD 파생", () => {
  test("lock 아래 maker는 OWNED_PATHS만 적어도 통과하고 나머지를 파생한다", () => {
    const state = lockedState();
    const decision = reserveTaskCall(state, "2", {
      tasks: [{ agent: "maker", task: "TASK_GUARD:\nOWNED_PATHS: agent/a.ts\n\n두 번째 슬라이스." }],
    });
    expect(decision.ok).toBe(true);
    const body = rewrittenTask(decision);
    expect(body).toContain("WORK_CLASS: feature");
    expect(body).toContain("PURPOSE: primary");
    expect(body).toContain("BLOCKS_PRIMARY: yes");
    expect(body).toContain("PRIMARY_DELIVERABLE: Arena에서 A/B 토론을 실행할 수 있다");
    expect(body).toContain("OWNED_PATHS: agent/a.ts");
    expect(body).toContain("두 번째 슬라이스.");
    expect(getTaskGuardUsage(state).primaryMaker).toBe(2);
  });

  test("FINDING_ID만 적으면 rework로 집계한다", () => {
    const state = lockedState();
    const decision = reserveTaskCall(
      state,
      "2",
      flat("maker", "TASK_GUARD:\nOWNED_PATHS: a.ts\nFINDING_ID: F-3\n\n지적을 고쳐라."),
    );
    expect(decision.ok).toBe(true);
    const body = rewrittenTask(decision);
    expect(body).toContain("PURPOSE: rework");
    expect(body).toContain("FINDING_ID: F-3");
    expect(getTaskGuardUsage(state)).toMatchObject({ primaryMaker: 1, reworkMaker: 1, total: 2 });
  });

  test("PURPOSE: rework인데 FINDING_ID가 없으면 거부한다", () => {
    const state = lockedState();
    const decision = reserveTaskCall(
      state,
      "2",
      flat("maker", "TASK_GUARD:\nPURPOSE: rework\nOWNED_PATHS: a.ts\n\n고쳐라."),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/rework spawn에는 기존 FINDING_ID/);
  });

  test("잘못 적은 값은 lock이 있어도 거부한다(빈 값과 구분)", () => {
    const state = lockedState();
    const wrong = reserveTaskCall(
      state,
      "2",
      flat("maker", "TASK_GUARD:\nWORK_CLASS: feat\nOWNED_PATHS: a.ts\n\n작업."),
    );
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toMatch(/WORK_CLASS는 feature\|maintenance\|diagnostic/);

    const badPurpose = reserveTaskCall(
      state,
      "3",
      flat("maker", "TASK_GUARD:\nPURPOSE: makeit\nOWNED_PATHS: a.ts\n\n작업."),
    );
    expect(badPurpose.ok).toBe(false);
    if (!badPurpose.ok) expect(badPurpose.reason).toMatch(/PURPOSE는 primary\|rework/);
  });

  test("lock 없는 첫 child가 PRIMARY_DELIVERABLE을 생략하면 거부한다", () => {
    const state = createTaskGuardState();
    const decision = reserveTaskCall(
      state,
      "1",
      flat("maker", "TASK_GUARD:\nWORK_CLASS: feature\nOWNED_PATHS: a.ts\n\n작업."),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/PRIMARY_DELIVERABLE이 비어 있습니다/);
  });

  test("lock과 다른 PRIMARY_DELIVERABLE을 명시하면 side quest로 거부한다", () => {
    const state = lockedState();
    const decision = reserveTaskCall(
      state,
      "2",
      flat("maker", brief({ PRIMARY_DELIVERABLE: "관측 로그를 정리한다" })),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/SideQuestGuard/);
  });

  test("모두 명시한 항목의 본문은 바꾸지 않는다", () => {
    const state = createTaskGuardState();
    const decision = reserveTaskCall(state, "1", flat("maker", brief()));
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.input).toBeUndefined();
  });

  test("교체 입력은 원본을 변형하지 않고 다른 키를 보존한다", () => {
    const state = lockedState();
    const task = "TASK_GUARD:\nOWNED_PATHS: a.ts\n\n작업.";
    const item = { agent: "maker", name: "Audit", task };
    const input = { context: "shared", model: "slow", tasks: [item] };
    const decision = reserveTaskCall(state, "2", input);
    expect(decision.ok).toBe(true);
    expect(item.task).toBe(task);
    expect(input.tasks[0]).toBe(item);
    if (!decision.ok || !decision.input) throw new Error("교체 입력이 없다");
    expect(decision.input.context).toBe("shared");
    expect(decision.input.model).toBe("slow");
    const replaced = (decision.input.tasks as Array<Record<string, unknown>>)[0]!;
    expect(replaced).not.toBe(item);
    expect(replaced.name).toBe("Audit");
    expect(replaced.agent).toBe("maker");
    expect(replaced.task).toContain("WORK_CLASS: feature");
  });

  test("블록만 치환하고 앞뒤 본문은 그대로 둔다", () => {
    const state = lockedState();
    const task =
      "# Target\n앞 본문은 보존된다.\n\nTASK_GUARD:\nOWNED_PATHS: a.ts\n\n# Change\n뒤 본문도 보존된다.\n";
    const decision = reserveTaskCall(state, "2", flat("maker", task));
    expect(decision.ok).toBe(true);
    const body = rewrittenTask(decision) ?? "";
    expect(body.startsWith("# Target\n앞 본문은 보존된다.\n\nTASK_GUARD:\n")).toBe(true);
    expect(body.endsWith("\n\n# Change\n뒤 본문도 보존된다.\n")).toBe(true);
    expect(body).toContain("PRIMARY_DELIVERABLE: Arena에서 A/B 토론을 실행할 수 있다");
    // 블록이 두 번 생기지 않는다.
    expect(body.match(/^TASK_GUARD:$/gm)?.length).toBe(1);
  });

  test("빈 줄 없는 후속 캐릭터 marker와 과제 본문을 guard 파생에서 보존한다", () => {
    const state = lockedState();
    const suffix = [
      "ROUTING_REASON: exact 캐릭터 모델을 일반 분류보다 우선한다",
      '[character-summon alias="RIN(린)" model="anthropic/claude-opus-5-5" oauth-position="N"]',
      "# Target",
      "린이 사용자에게 직접 인사한다.",
    ].join("\n");
    const decision = reserveTaskCall(
      state,
      "incident-character-brief",
      flat("maker", `TASK_GUARD:\nOWNED_PATHS: a.ts\n${suffix}`),
    );
    expect(decision.ok).toBe(true);
    const body = rewrittenTask(decision) ?? "";
    expect(body).toContain("PURPOSE: primary");
    expect(body).toContain("BLOCKS_PRIMARY: yes");
    expect(body.endsWith(`\n${suffix}`)).toBe(true);
    expect(body.match(/\[character-summon /g)).toHaveLength(1);
  });
});

