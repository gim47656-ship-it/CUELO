import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createEditLessons, EDIT_LESSONS_PER_PATH, lessonTarget, relativeTarget } from "../edit-lessons";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;
interface Item {
  id?: string;
  content: string;
  source?: string;
  timestamp?: string;
  score?: number;
}
type Search = (query: string, options?: { limit?: number; signal?: AbortSignal }) => Promise<{ items: Item[]; message?: string }>;
type ReadMemory = (ctx: unknown, id: string, signal: AbortSignal) => Promise<string>;

const CWD = "/repo";

function setup(search?: Search, deps: { searchTimeoutMs?: number; readMemory?: ReadMemory } = {}) {
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

  test("끝나지 못한 검색(오류·시간 초과·사용 불가 메시지)은 다음 편집에서 다시 찾고, 성공하면 붙인다", async () => {
    let calls = 0;
    const t = setup(async () => {
      calls++;
      if (calls === 1) throw new Error("db locked");
      if (calls === 2) return Promise.withResolvers<{ items: Item[] }>().promise; // 시간 초과
      return { items: [lesson("a1", "x.ts 교훈")] };
    }, { searchTimeoutMs: 20 });
    expect(await t.call("edit", { path: "x.ts" })).toBeUndefined();
    // 두 번째 시도(시간 초과)가 상한이라 세 번째 편집은 다시 찾지 않는다.
    expect(await t.call("edit", { path: "x.ts" })).toBeUndefined();
    expect(await t.call("edit", { path: "x.ts" })).toBeUndefined();
    expect(t.queries).toEqual(["x.ts", "x.ts"]);

    let n = 0;
    const retry = setup(async () => {
      n++;
      if (n === 1) return Promise.withResolvers<{ items: Item[] }>().promise;
      return { items: [lesson("a1", "x.ts 교훈")] };
    }, { searchTimeoutMs: 20 });
    expect(await retry.call("edit", { path: "x.ts" })).toBeUndefined();
    expect((await retry.call("edit", { path: "x.ts" }))!.additionalContext).toContain("id: a1");
    expect(await retry.call("edit", { path: "x.ts" })).toBeUndefined();
    expect(retry.queries).toEqual(["x.ts", "x.ts"]);

    let m = 0;
    const unavailable = setup(async () => (++m === 1 ? { items: [], message: "Mnemopi backend is not initialised for this session." } : { items: [lesson("a1", "x.ts 교훈")] }));
    expect(await unavailable.call("edit", { path: "x.ts" })).toBeUndefined();
    expect(await unavailable.call("edit", { path: "x.ts" })).toBeDefined();
  });

  test("끝난 빈 결과나 교훈 없는 결과는 같은 세션에서 다시 찾지 않는다", async () => {
    const empty = setup(async () => ({ items: [] }));
    await empty.call("edit", { path: "x.ts" });
    await empty.call("edit", { path: "x.ts" });
    expect(empty.queries).toEqual(["x.ts"]);
    const unrelated = setup(async () => ({ items: [lesson("c3", "다른 파일 이야기만 한다")] }));
    await unrelated.call("edit", { path: "x.ts" });
    await unrelated.call("edit", { path: "x.ts" });
    expect(unrelated.queries).toEqual(["x.ts"]);
  });

  test("ctx.memory가 없으면 다음 편집에서 다시 시도하되 상한이 있다", async () => {
    const t = setup(undefined);
    await t.call("edit", { path: "x.ts" });
    await t.call("edit", { path: "x.ts" });
    // 상한 뒤에는 이 경로를 더 건드리지 않는다(상태가 남아 있어도 던지지 않는다).
    expect(await t.call("edit", { path: "x.ts" })).toBeUndefined();
  });

  test("미리보기 밖에 파일명이 있는 잘린 교훈은 전문을 읽어 붙이고, 전문에도 없으면 거른다", async () => {
    const preview = (head: string) => `${head} ${"가".repeat(480)}…`;
    const reads: string[] = [];
    const fulls: Record<string, string> = {
      far: `${preview("앞부분")}`.slice(0, -1) + "…… 끝에서 setup.ps1은 -ValidateOnly를 먼저 돌린다.",
      other: `${preview("딴 얘기")}`.slice(0, -1) + "…… 끝까지 다른 파일 이야기만 한다.",
    };
    const t = setup(
      async () => ({
        items: [
          lesson("far", preview("앞부분"), { score: 0.9 }),
          lesson("other", preview("딴 얘기"), { score: 0.8 }),
          lesson("whole", "온전한 미리보기에는 파일명이 없다", { score: 0.7 }),
          lesson("near", "setup.ps1은 앞쪽에 있다", { score: 0.6 }),
        ],
      }),
      { readMemory: async (_ctx, id) => (reads.push(id), fulls[id] ?? (() => { throw new Error("no row"); })()) },
    );
    const lines = (await t.call("edit", { path: "Tools/setup.ps1" }))!.additionalContext!.split("\n");
    expect(reads.sort()).toEqual(["far", "other"]); // 온전한(잘리지 않은) 무관 미리보기와 이미 파일명이 보이는 것은 읽지 않는다
    expect(lines[0]).toContain("묶인 기억 2건");
    expect(lines[1]).toStartWith(`- ${preview("앞부분")} [전문에서 setup.ps1 언급: …`);
    expect(lines[1]).toContain("setup.ps1은 -ValidateOnly를 먼저 돌린다.…] (id: far, 2026-10-05)");
    expect(lines[2]).toBe("- setup.ps1은 앞쪽에 있다 (id: near, 2026-10-05)");
    expect(lines).toHaveLength(3);
  });

  test("전문에서 비밀 패턴이 나오면 내용 없이 id만 알린다", async () => {
    const clipped = `${"가".repeat(499)}…`;
    const t = setup(
      async () => ({ items: [lesson("sec", clipped)] }),
      { readMemory: async () => `${"가".repeat(499)} x.ts의 비밀번호는 환경 파일에서 읽는다` },
    );
    const lines = (await t.call("edit", { path: "x.ts" }))!.additionalContext!.split("\n");
    expect(lines.slice(1)).toEqual(["- 비밀 패턴이 있어 보이지 않음: sec"]);
  });

  test("전문 읽기가 실패하거나 시간 초과면 그 경로는 다음 편집에서 다시 읽는다", async () => {
    const clipped = `${"가".repeat(499)}…`;
    let reads = 0;
    const t = setup(
      async () => ({ items: [lesson("far", clipped)] }),
      {
        searchTimeoutMs: 20,
        readMemory: (_ctx, _id, signal) => {
          reads++;
          if (reads === 1) return Promise.reject(new Error("not found"));
          if (reads === 2) {
            const hang = Promise.withResolvers<string>();
            signal.addEventListener("abort", () => hang.reject(new Error("aborted")));
            return hang.promise;
          }
          return Promise.resolve(`${"가".repeat(499)} x.ts 교훈`);
        },
      },
    );
    expect(await t.call("edit", { path: "x.ts" })).toBeUndefined();
    expect(await t.call("edit", { path: "x.ts" })).toBeUndefined();
    expect(reads).toBe(2); // 시도 상한(2) 뒤에는 읽지 않는다
    expect(await t.call("edit", { path: "x.ts" })).toBeUndefined();
    expect(reads).toBe(2);

    let n = 0;
    const retry = setup(
      async () => ({ items: [lesson("far", clipped)] }),
      { readMemory: async () => { if (++n === 1) throw new Error("not found"); return `${"가".repeat(499)} x.ts 교훈`; } },
    );
    expect(await retry.call("edit", { path: "x.ts" })).toBeUndefined();
    expect((await retry.call("edit", { path: "x.ts" }))!.additionalContext).toContain("id: far");
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

  test("파일이 아닌 대상(proc://·agent://·conflict:// 등)은 기억을 찾지 않고 무관한 교훈도 붙이지 않는다", async () => {
    // 2026-10-26 관측: `proc://bg_19/kill`이 `proc:/bg_19/kill`로 접혀 basename `kill`·`Main`·`1`이 무관한 기억에 걸렸다.
    const t = setup(async () => ({
      items: [lesson("k", "kill 신호는 먼저 보낸다"), lesson("m", "Main은 병합한다"), lesson("one", "1번 충돌은 양쪽을 합친다"), lesson("x", "x.md 교훈")],
    }));
    const targets = [
      "proc://bg_19/kill", "proc:/bg_19/kill", "agent://Main", "conflict://1", "conflict:/1", "local://x.md", "local:/x.md",
      "xd://recall", "memory://abc", "skill://hallmark", "artifact://3", "ssh://host/etc/x.md", "mcp://srv/Main",
      "PROC://bg/kill", "/repo/local://x.md", "C:\\repo\\local://x.md", "https://example.com/x.md",
    ];
    for (const target of targets) {
      expect(await t.call("write", { path: target, content: "" })).toBeUndefined();
      expect(await t.call("edit", { path: target, paths: [target] })).toBeUndefined();
    }
    expect(t.queries).toEqual([]);
  });

  test("같은 호출의 파일 대상은 그대로 찾고 비파일 대상만 건너뛴다", async () => {
    const t = setup(async () => ({ items: [lesson("a1", "x.ts 교훈"), lesson("k", "kill 교훈")] }));
    const result = await t.call("edit", { paths: ["proc://bg/kill", "x.ts", "agent://Main"] });
    expect(t.queries).toEqual(["x.ts"]);
    expect(result!.additionalContext).toStartWith("[edit-lessons] x.ts에 묶인 기억 1건");
    expect(result!.additionalContext).not.toContain("id: k");
  });

  test("file:// URI는 실제 파일 경로로 풀어 찾는다 (Windows 드라이브·UNC·퍼센트 인코딩 포함)", async () => {
    const t = setup(async () => ({ items: [lesson("a1", "x.ts 교훈"), lesson("sp", "a b.ts 교훈"), lesson("w", "w.ts 교훈")] }));
    expect(await t.call("write", { path: "file:///repo/src/x.ts" })).toBeDefined();
    expect(await t.call("write", { path: "FILE:///repo/a%20b.ts" })).toBeDefined();
    expect(await t.call("write", { path: "file:///C:/proj/w.ts" })).toBeDefined();
    expect(t.queries).toEqual(["src/x.ts", "a b.ts", "C:/proj/w.ts"]);
    expect(lessonTarget("C:\\repo", "file:///C:/repo/src/x.ts")).toBe("src/x.ts");
    expect(lessonTarget("C:\\repo", "file://server/share/u.ts")).toBe("//server/share/u.ts");
    expect(lessonTarget("/repo", "file://localhost/repo/x.ts")).toBe("x.ts");
    expect(lessonTarget("/repo", "file:///repo/%E0%A4%A")).toBeUndefined(); // 깨진 퍼센트 인코딩
  });

  test("Windows 드라이브 경로와 상대·절대 파일 경로는 계속 찾는다", async () => {
    const t = setup(async (query) => ({ items: [lesson(query, `${query.slice(query.lastIndexOf("/") + 1)} 교훈`)] }));
    expect(await t.call("edit", { path: "C:\\proj\\w.ts" })).toBeDefined();
    expect(await t.call("edit", { path: "c:/proj/x.ts" })).toBeDefined();
    expect(await t.call("edit", { path: "src/dir:name/x.ts" })).toBeDefined();
    // core는 접두 경로 뒤의 단일 슬래시 `local:/`을 URL로 풀지 않는다(router.ts PREFIXED_URL_SEGMENT_RE는 `://`만): 실제 경로다.
    expect(await t.call("edit", { path: "/repo/local:/y.md" })).toBeDefined();
    expect(t.queries).toEqual(["C:/proj/w.ts", "c:/proj/x.ts", "src/dir:name/x.ts", "local:/y.md"]);
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

  test("Windows 모양 cwd(`C:\\repo`)는 호스트와 무관하게 win32 규칙으로 푼다", () => {
    expect(relativeTarget("C:\\repo", "C:\\repo\\src\\..\\x.ts")).toBe("x.ts");
    expect(relativeTarget("C:\\repo", "x.ts")).toBe("x.ts");
    expect(relativeTarget("C:\\repo", "c:/repo/a/b.ts")).toBe("a/b.ts");
    expect(relativeTarget("C:\\repo", "D:\\other\\x.ts")).toBe("D:/other/x.ts");
    expect(relativeTarget("C:\\repo", "..\\other\\x.ts")).toBe("C:/other/x.ts");
    expect(relativeTarget(undefined, "C:\\a\\..\\x.ts")).toBe("C:/x.ts");
  });

  test("POSIX 모양 cwd(`/repo`)는 호스트 플랫폼과 무관하게 드라이브 없이 푼다", () => {
    expect(relativeTarget("/repo", "/repo/src/../x.ts")).toBe("x.ts");
    expect(relativeTarget("/repo", "/other/x.ts")).toBe("/other/x.ts");
    expect(relativeTarget("/repo", "../other/x.ts")).toBe("/other/x.ts");
  });
});
