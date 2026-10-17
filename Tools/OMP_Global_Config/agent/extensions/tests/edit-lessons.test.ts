import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createEditLessons, EDIT_LESSONS_PER_PATH, relativeTarget } from "../edit-lessons";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;
interface Item {
  id?: string;
  content: string;
  source?: string;
  timestamp?: string;
  score?: number;
}
type Search = (query: string, options?: { limit?: number; signal?: AbortSignal }) => Promise<{ items: Item[] }>;

const CWD = "/repo";

function setup(search?: Search, deps: { searchTimeoutMs?: number } = {}) {
  const handlers: Record<string, Handler[]> = {};
  const pi = {
    on: (name: string, handler: Handler) => (handlers[name] ??= []).push(handler),
    logger: { debug: () => {} },
  };
  createEditLessons(deps)(pi as never);
  const queries: string[] = [];
  const ctx = {
    cwd: CWD,
    memory: search ? { search: (query: string, options?: { limit?: number; signal?: AbortSignal }) => (queries.push(query), search(query, options)) } : undefined,
  };
  return {
    queries,
    call: (toolName: string, input: Record<string, unknown>) => handlers.tool_call![0]!({ type: "tool_call", toolName, toolCallId: "t", input }, ctx) as Promise<{ additionalContext?: string } | undefined>,
    fire: (name: string) => handlers[name]!.forEach((handler) => handler({}, ctx)),
  };
}

const lesson = (id: string, content: string, extra: Partial<Item> = {}): Item => ({ id, content, source: "coding-agent-learn", timestamp: "2026-10-05T01:02:03Z", score: 0.5, ...extra });

describe("edit-lessons", () => {
  test("edit의 paths로 찾은 교훈 중 basename이 든 학습·retain 기억만 붙인다", async () => {
    const seen: Array<{ query: string; limit?: number; hasSignal: boolean }> = [];
    const t = setup(async (query, options) => {
      seen.push({ query, limit: options?.limit, hasSignal: options?.signal instanceof AbortSignal });
      return {
        items: [
          lesson("a1", "setup.ps1은 -ValidateOnly를 먼저 돌린다", { score: 0.9 }),
          lesson("b2", "retain 쪽 setup.ps1 메모", { source: "coding-agent-retain", score: 0.4, timestamp: undefined }),
          lesson("c3", "다른 파일 이야기만 한다"),
          lesson("d4", "setup.ps1 전사 조각", { source: "coding-agent-transcript" }),
          { content: "id 없는 setup.ps1 기억", source: "coding-agent-learn" },
          lesson("e5", "SETUP.PS1 대소문자만 다르다"),
        ],
      };
    });
    const result = await t.call("edit", { paths: [join(CWD, "Tools/OMP_Global_Config/setup.ps1")] });
    expect(seen).toEqual([{ query: "Tools/OMP_Global_Config/setup.ps1", limit: 8, hasSignal: true }]);
    const lines = result!.additionalContext!.split("\n");
    expect(lines[0]).toBe("[edit-lessons] Tools/OMP_Global_Config/setup.ps1에 묶인 기억 2건. 단서일 뿐이며 현재 지시·정본·승인이 우선한다. 원문은 memory://<id>로 읽는다.");
    expect(lines.slice(1)).toEqual([
      "- setup.ps1은 -ValidateOnly를 먼저 돌린다 (id: a1, 2026-10-05)",
      "- retain 쪽 setup.ps1 메모 (id: b2)",
    ]);
  });

  test("write의 path도 읽고, 한 경로에는 점수 높은 3건까지만 붙인다", async () => {
    const t = setup(async () => ({
      items: ["x1", "x2", "x3", "x4"].map((id, i) => lesson(id, `lib.ts 교훈 ${id}`, { score: i / 10 })),
    }));
    const result = await t.call("write", { path: "src/lib.ts", content: "..." });
    const lines = result!.additionalContext!.split("\n");
    expect(lines).toHaveLength(1 + EDIT_LESSONS_PER_PATH);
    expect(lines[0]).toContain("src/lib.ts에 묶인 기억 3건");
    expect(lines.slice(1).map((line) => line.match(/id: (\w+)/)![1])).toEqual(["x4", "x3", "x2"]);
  });

  test("비밀 패턴 기억은 내용 없이 id만 알리고 상한 3건에 세지 않는다", async () => {
    const t = setup(async () => ({
      items: [
        lesson("s1", "deploy.mjs의 비밀번호는 환경 파일에서 읽는다", { score: 0.99 }),
        lesson("p1", "deploy.mjs 점검 순서", { score: 0.2 }),
        lesson("s2", "deploy.mjs 토큰 위치", { score: 0.98 }),
      ],
    }));
    const text = (await t.call("edit", { path: "deploy.mjs" }))!.additionalContext!;
    expect(text).toContain("묶인 기억 3건");
    expect(text).toContain("- deploy.mjs 점검 순서 (id: p1, 2026-10-05)");
    expect(text).toContain("- 비밀 패턴이 있어 보이지 않음: s1, s2");
    expect(text).not.toContain("환경 파일에서 읽는다");
    expect(text).not.toContain("토큰 위치");
  });

  test("교훈 줄은 공백만 정리하고 경로·literal은 가리지 않으며 검색이 준 길이를 자르지 않는다", async () => {
    const long = `a.ts ${"가".repeat(500)}`;
    const t = setup(async () => ({ items: [lesson("l1", long), lesson("l2", "a.ts는\n`bun test`  전에\tsrc/lib/x.ts를 본다")] }));
    const lines = (await t.call("edit", { path: "a.ts" }))!.additionalContext!.split("\n").slice(1);
    expect(lines).toEqual([
      `- ${long} (id: l1, 2026-10-05)`,
      "- a.ts는 `bun test` 전에 src/lib/x.ts를 본다 (id: l2, 2026-10-05)",
    ]);
  });

  test("같은 경로를 세션에서 다시 고치면 다시 찾지 않고 아무것도 붙이지 않는다", async () => {
    const t = setup(async () => ({ items: [lesson("a1", "x.ts 교훈")] }));
    expect(await t.call("edit", { path: "x.ts" })).toBeDefined();
    expect(await t.call("write", { path: join(CWD, "x.ts") })).toBeUndefined();
    expect(t.queries).toEqual(["x.ts"]);
  });

  test("다른 경로에서 다시 나온 같은 기억 id는 되풀이하지 않는다", async () => {
    const t = setup(async (query) => ({
      items: query === "a/x.ts"
        ? [lesson("shared", "x.ts와 y.ts는 함께 고친다")]
        : [lesson("shared", "x.ts와 y.ts는 함께 고친다"), lesson("only-y", "y.ts 전용 교훈")],
    }));
    const first = (await t.call("edit", { path: "a/x.ts" }))!.additionalContext!;
    expect(first).toContain("id: shared");
    const second = (await t.call("edit", { path: "b/y.ts" }))!.additionalContext!;
    expect(second).not.toContain("id: shared");
    expect(second).toContain("id: only-y");
    expect(second).toContain("묶인 기억 1건");
  });

  test("한 호출의 여러 경로는 입력 순서대로 구역을 나눠 한 문맥으로 합치고 같은 id는 한 번만 싣는다", async () => {
    const t = setup(async () => ({
      items: [lesson("both", "a.ts b.ts 공통 교훈", { score: 0.9 }), lesson("a-only", "a.ts 전용"), lesson("b-only", "b.ts 전용")],
    }));
    const text = (await t.call("edit", { paths: ["a.ts", "b.ts", "a.ts"] }))!.additionalContext!;
    const sections = text.split("\n\n");
    expect(sections).toHaveLength(2);
    expect(sections[0]).toStartWith("[edit-lessons] a.ts에 묶인 기억 2건");
    expect(sections[0]).toContain("id: both");
    expect(sections[0]).toContain("id: a-only");
    expect(sections[1]).toStartWith("[edit-lessons] b.ts에 묶인 기억 1건");
    expect(sections[1]).toContain("id: b-only");
    expect(sections[1]).not.toContain("id: both");
  });

  test("basename을 가진 기억이 없으면 붙이지 않는다", async () => {
    const t = setup(async () => ({ items: [lesson("a1", "관계 없는 교훈"), lesson("a2", "other.ts 교훈")] }));
    expect(await t.call("edit", { path: "src/x.ts" })).toBeUndefined();
  });

  test("ctx.memory가 없으면 붙이지 않는다", async () => {
    const t = setup(undefined);
    expect(await t.call("edit", { path: "x.ts" })).toBeUndefined();
  });

  test("검색이 실패하면 던지지 않고 붙이지 않는다", async () => {
    const t = setup(() => Promise.reject(new Error("db locked")));
    expect(await t.call("edit", { path: "x.ts" })).toBeUndefined();
    const sync = setup(() => { throw new Error("sync boom"); });
    expect(await sync.call("write", { path: "x.ts" })).toBeUndefined();
  });

  test("제한 시간 안에 검색이 끝나지 않으면 신호를 취소하고 붙이지 않는다", async () => {
    let aborted = false;
    const t = setup(
      (_query, options) => {
        options?.signal?.addEventListener("abort", () => { aborted = true; });
        return Promise.withResolvers<{ items: Item[] }>().promise; // 영원히 끝나지 않는 검색
      },
      { searchTimeoutMs: 20 },
    );
    const started = performance.now();
    expect(await t.call("edit", { path: "x.ts" })).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(150);
    expect(aborted).toBe(true);
  });

  test("edit·write가 아닌 도구는 검색하지 않는다", async () => {
    const t = setup(async () => ({ items: [lesson("a1", "x.ts 교훈")] }));
    expect(await t.call("read", { path: "x.ts" })).toBeUndefined();
    expect(await t.call("bash", { command: "cat x.ts" })).toBeUndefined();
    expect(t.queries).toEqual([]);
  });

  test("경로가 없거나 문자열이 아니면 검색하지 않는다", async () => {
    const t = setup(async () => ({ items: [lesson("a1", "x.ts 교훈")] }));
    expect(await t.call("edit", { input: "[x.ts#1A2B]" })).toBeUndefined();
    expect(await t.call("edit", { paths: [1, null], path: 3 })).toBeUndefined();
    expect(t.queries).toEqual([]);
  });

  test("session_start와 session_shutdown은 찾은 경로와 붙인 기억 id를 초기화한다", async () => {
    const t = setup(async () => ({ items: [lesson("a1", "x.ts 교훈")] }));
    expect(await t.call("edit", { path: "x.ts" })).toBeDefined();
    expect(await t.call("edit", { path: "x.ts" })).toBeUndefined();
    t.fire("session_start");
    expect(await t.call("edit", { path: "x.ts" })).toBeDefined();
    expect(await t.call("edit", { path: "x.ts" })).toBeUndefined();
    t.fire("session_shutdown");
    expect(await t.call("edit", { path: "x.ts" })).toBeDefined();
  });

  test("검색이 실패한 경로도 같은 세션에서 다시 기다리지 않는다", async () => {
    const t = setup(() => Promise.reject(new Error("down")));
    await t.call("edit", { path: "x.ts" });
    await t.call("edit", { path: "x.ts" });
    expect(t.queries).toEqual(["x.ts"]);
  });

  test("같은 파일의 다른 표기는 한 번만 찾는다 (R1-OAI-4)", async () => {
    const t = setup(async () => ({ items: [lesson("a1", "x.ts 교훈")] }));
    expect(await t.call("edit", { paths: ["src/../x.ts", "x.ts", join(CWD, "x.ts")] })).toBeDefined();
    expect(await t.call("write", { path: "./x.ts" })).toBeUndefined();
    expect(t.queries).toEqual(["x.ts"]);
    const outside = setup(async () => ({ items: [lesson("o1", "x.ts 바깥 교훈")] }));
    expect(await outside.call("edit", { paths: ["/other/x.ts", "../other/x.ts"] })).toBeDefined();
    expect(outside.queries).toEqual(["/other/x.ts"]);
  });

  test("한 검색 결과 안의 같은 id는 한 자리만 차지하고 가림 목록에도 한 번만 나온다 (R1-OAI-5)", async () => {
    const t = setup(async () => ({
      items: [
        lesson("dup", "x.ts 교훈 첫 줄", { score: 0.9 }),
        lesson("dup", "x.ts 교훈 둘째 줄", { score: 0.8 }),
        lesson("dup", "x.ts 교훈 셋째 줄", { score: 0.7 }),
        lesson("b", "x.ts 다른 교훈", { score: 0.5 }),
        lesson("sec", "x.ts의 토큰 위치", { score: 0.4 }),
        lesson("sec", "x.ts의 토큰 위치 사본", { score: 0.3 }),
      ],
    }));
    const lines = (await t.call("edit", { path: "x.ts" }))!.additionalContext!.split("\n");
    expect(lines[0]).toContain("묶인 기억 3건");
    expect(lines.slice(1)).toEqual([
      "- x.ts 교훈 첫 줄 (id: dup, 2026-10-05)",
      "- x.ts 다른 교훈 (id: b, 2026-10-05)",
      "- 비밀 패턴이 있어 보이지 않음: sec",
    ]);
  });

  test("검색을 기다리는 사이 세션이 바뀌면 옛 결과는 버리고 새 세션의 집합을 건드리지 않는다 (R1-OAI-6)", async () => {
    for (const event of ["session_start", "session_shutdown"]) {
      const gates: Array<(value: { items: Item[] }) => void> = [];
      const t = setup(() => {
        const { promise, resolve } = Promise.withResolvers<{ items: Item[] }>();
        gates.push(resolve);
        return promise;
      });
      const stale = t.call("edit", { path: "x.ts" });
      t.fire(event);
      gates[0]!({ items: [lesson("old", "x.ts 옛 세션 교훈")] });
      expect(await stale).toBeUndefined();
      // 새 세션에서는 같은 경로를 처음부터 다시 찾고, 옛 결과가 attached에 남아 있지 않다.
      const fresh = t.call("edit", { path: "x.ts" });
      gates[1]!({ items: [lesson("old", "x.ts 옛 세션 교훈")] });
      expect((await fresh)!.additionalContext).toContain("id: old");
      expect(t.queries).toEqual(["x.ts", "x.ts"]);
    }
  });
});

describe("relativeTarget", () => {
  test("cwd 아래 경로는 상대 `/` 경로로, 밖은 정규화한 절대 경로로", () => {
    expect(relativeTarget("/repo", "/repo/a/b.ts")).toBe("a/b.ts");
    expect(relativeTarget("/repo", "/other/b.ts")).toBe("/other/b.ts");
    expect(relativeTarget("/repo", "/repo")).toBe("/repo");
    expect(relativeTarget("/repo", "./a/b.ts")).toBe("a/b.ts");
    expect(relativeTarget("/repo", "a\\b.ts")).toBe("a/b.ts");
    expect(relativeTarget(undefined, "/repo/a.ts")).toBe("/repo/a.ts");
  });

  test("같은 파일을 가리키는 다른 표기는 같은 키가 된다 (R1-OAI-4)", () => {
    expect(relativeTarget("/repo", "src/../x.ts")).toBe("x.ts");
    expect(relativeTarget("/repo", "/repo/src/../x.ts")).toBe("x.ts");
    expect(relativeTarget("/repo", "../other/x.ts")).toBe("/other/x.ts");
    expect(relativeTarget("/repo", "/other/x.ts")).toBe("/other/x.ts");
    expect(relativeTarget("/repo", "/other/../other/x.ts")).toBe("/other/x.ts");
    expect(relativeTarget(undefined, "src/../x.ts")).toBe("x.ts");
    expect(relativeTarget(undefined, "./a\\b.ts")).toBe("a/b.ts");
  });
});
