import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import promptPrefixLedger, {
  MIN_LOST_CHARS,
  PROMPT_PREFIX_BREAK_TYPE,
  PROMPT_PREFIX_LEDGER_TYPE,
  PROMPT_PREFIX_SNAPSHOT_TYPE,
  type PromptPrefixBreak,
  type PromptPrefixRecord,
  promptPrefixRecord,
} from "../prompt-prefix-ledger";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;
type Entry = { type: string; customType?: string; data?: unknown };

function payload(skills = "- a: one", projectContext = "<project-context>\nrepo rules\n</project-context>") {
  return {
    model: "claude-opus-5-5",
    tools: [
      { name: "read", description: "Read files", input_schema: { type: "object" } },
      { name: "bash", description: "Run", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
    ],
    system: [
      { type: "text", text: `RFC 2119 keywords\n# Engineering\nbe correct\n# Skills & Rules\n<skills>\n${skills}\n</skills>` },
      { type: "text", text: projectContext },
      { type: "text", text: "<memories>\nrecalled\n</memories>" },
    ],
    messages: [],
  };
}

function harness(branch: Entry[] = [], clock: () => number = () => 1_000, failOn?: string) {
  const handlers: Record<string, Handler[]> = {};
  promptPrefixLedger({
    on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); },
    appendEntry: (customType: string, data: unknown) => {
      // failOn 기록은 처음 한 번만 실패한다.
      if (customType === failOn) {
        failOn = undefined;
        throw new Error("disk full");
      }
      branch.push({ type: "custom", customType, data });
    },
  } as unknown as ExtensionAPI, clock);
  let sessionId = "s1";
  const ctx = { sessionManager: { getBranch: () => branch, getSessionId: () => sessionId } };
  const send = (body: unknown) => {
    for (const handler of handlers.before_provider_request ?? []) {
      expect(handler({ type: "before_provider_request", payload: body }, ctx)).toBeUndefined();
    }
  };
  const emit = (name: string) => { for (const handler of handlers[name] ?? []) handler({ type: name }, ctx); };
  const shutdown = () => emit("session_shutdown");
  const switchTo = (id: string) => { sessionId = id; emit("session_switch"); };
  const records = () => branch.filter((entry) => entry.customType === PROMPT_PREFIX_LEDGER_TYPE).map((entry) => entry.data as PromptPrefixRecord);
  const breaks = () => branch.filter((entry) => entry.customType === PROMPT_PREFIX_BREAK_TYPE).map((entry) => entry.data as PromptPrefixBreak);
  return { branch, send, shutdown, emit, switchTo, records, breaks };
}

const big = (label: string) => `${label} ${"x".repeat(MIN_LOST_CHARS)}`;

/** Anthropic 대화: 첫 사용자 메시지, 번역 숨김 메시지, 그 뒤 턴들. */
function conversation(first = "첫 질문", extra: unknown[] = []) {
  return {
    ...payload(),
    messages: [
      { role: "user", content: [{ type: "text", text: first }] },
      { role: "user", content: [{ type: "text", text: "[interpreter] first question" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }, { type: "text", text: big("answer") }] },
      ...extra,
    ],
  };
}

function codex(input: unknown[], options: { instructions?: string; chained?: boolean } = {}) {
  return {
    model: "gpt-6-astra",
    instructions: options.instructions ?? "identity",
    tools: [{ type: "function", name: "read" }],
    input: [{ role: "developer", content: "<project-context>\nrules\n</project-context>" }, ...input],
    ...(options.chained ? { previous_response_id: "resp_1" } : {}),
  };
}

describe("prompt prefix ledger", () => {
  test("에이전트 프롬프트가 아닌 요청은 기록하지 않는다", () => {
    const h = harness();
    h.send({ system: [{ type: "text", text: "Summarize the conversation" }], tools: [] });
    h.send({ system: "plain string system" });
    h.send(undefined);
    expect(h.records()).toEqual([]);
  });

  test("같은 머리와 cache_control 위치만 바뀐 요청은 다시 기록하지 않고, 바뀐 절만 다른 지문이 된다", () => {
    const h = harness();
    h.send(payload());
    h.send(payload());
    const moved = payload();
    delete (moved.tools[1] as { cache_control?: unknown }).cache_control;
    (moved.tools[0] as { cache_control?: unknown }).cache_control = { type: "ephemeral" };
    h.send(moved);
    expect(h.records()).toHaveLength(1);

    h.send(payload("- a: one\n- b: two"));
    const [before, after] = h.records();
    expect(after).toBeDefined();
    expect(after!.tools).toEqual(before!.tools);
    const head = (record: PromptPrefixRecord) => new Map(record.system[0]!.sections.map(([title, hash]) => [title, hash]));
    const changed = [...head(after!)].filter(([title, hash]) => head(before!).get(title) !== hash).map(([title]) => title);
    expect(changed).toEqual(["<skills>"]);
    expect(after!.system.slice(1).map((block) => block.hash)).toEqual(before!.system.slice(1).map((block) => block.hash));
  });

  test("변동 구간 표시는 <project-context>부터 뒤 블록 전부에 붙는다", () => {
    expect(promptPrefixRecord(payload())!.system.map((block) => block.volatile)).toEqual([false, true, true]);
  });

  test("제목 기호 뒤가 탭이어도 절을 나눈다", () => {
    const body = payload();
    body.system[0]!.text = "#\tOne\nbody\n##\tTwo\nbody";
    expect(promptPrefixRecord(body)!.system[0]!.sections.map(([title]) => title)).toEqual(["#\tOne", "##\tTwo"]);
  });

  test("재시작 뒤 새 인스턴스는 세션 기록의 마지막 지문과 비교한다", () => {
    const first = harness();
    first.send(payload());
    const restarted = harness(first.branch);
    restarted.send(payload());
    expect(restarted.records()).toHaveLength(1);
    restarted.send(payload("- c: three"));
    expect(restarted.records()).toHaveLength(2);
  });

  test("분기를 오가거나 다른 세션으로 옮기면 지금 분기의 마지막 기록과 비교한다", () => {
    const h = harness();
    h.send(payload());
    const branchA = [...h.branch];
    h.send(payload("- b: two"));
    expect(h.records()).toHaveLength(2);
    h.branch.splice(0, h.branch.length, ...branchA);
    h.send(payload());
    expect(h.records()).toHaveLength(1);
    h.branch.length = 0;
    h.send(payload());
    expect(h.records()).toHaveLength(1);
  });

  test("대화가 뒤에만 늘면 끊김을 남기지 않고, 앞 메시지가 바뀌면 바뀐 위치와 앞뒤 글자를 남긴다", () => {
    const h = harness();
    h.send(conversation());
    h.send(conversation("첫 질문", [{ role: "user", content: [{ type: "text", text: "다음 질문" }] }]));
    expect(h.breaks()).toEqual([]);

    h.send(conversation("첫 질문 (고침)", [{ role: "user", content: [{ type: "text", text: "다음 질문" }] }]));
    const [found] = h.breaks();
    expect(found).toMatchObject({ kind: "rewrite", restart: false, index: 0, role: "user", prevCount: 4, curCount: 4 });
    expect(found!.lostChars).toBeGreaterThanOrEqual(MIN_LOST_CHARS);
    expect(found!.prev).toContain("첫 질문\"");
    expect(found!.cur).toContain("첫 질문 (고침)");
  });

  test("cache_control 위치만 옮겨 다니거나 끝의 짧은 메시지만 바뀐 요청은 기록하지 않는다", () => {
    const h = harness();
    const tail = (text: string, mark: boolean) => conversation("첫 질문", [
      { role: "user", content: [{ type: "text", text, ...(mark ? { cache_control: { type: "ephemeral" } } : {}) }] },
    ]);
    h.send(tail("알림", true));
    h.send(tail("알림", false));
    h.send(tail("다른 알림", false));
    expect(h.breaks()).toEqual([]);
  });

  test("재시작 뒤 첫 요청은 종료 때 남긴 지문과 비교하고, 그대로면 남기지 않는다", () => {
    const first = harness([], () => 1_000);
    first.send(conversation());
    first.shutdown();
    expect(first.branch.filter((entry) => entry.customType === PROMPT_PREFIX_SNAPSHOT_TYPE)).toHaveLength(1);
    expect(JSON.stringify(first.branch)).not.toContain("첫 질문");

    const same = harness([...first.branch], () => 61_000);
    same.send(conversation());
    expect(same.breaks()).toEqual([]);

    const changed = harness([...first.branch], () => 61_000);
    changed.send(conversation("첫 질문 (재시작 뒤 달라짐)"));
    const [found] = changed.breaks();
    expect(found).toMatchObject({ kind: "rewrite", restart: true, index: 0, gapMs: 60_000 });
    expect(found!.prev).toBeUndefined();
    expect(found!.cur).toContain("재시작 뒤 달라짐");
  });

  test("Codex 이어 보내기가 끊겨 전체를 다시 보내면 chain-reset을, instructions가 바뀌면 head 끊김을 남긴다", () => {
    const h = harness();
    const history = [{ role: "user", content: big("질문") }];
    h.send(codex(history));
    h.send(codex([{ role: "user", content: "delta" }], { chained: true }));
    h.send(codex([{ role: "user", content: "delta" }], { chained: true }));
    h.send(codex([...history, { role: "user", content: "delta" }]));
    expect(h.breaks()).toEqual([expect.objectContaining({ kind: "chain-reset", wire: "responses", chained: 2 })]);

    h.send(codex([...history, { role: "user", content: "delta" }], { instructions: "identity\n<memories>new</memories>" }));
    const head = h.breaks()[1];
    expect(head).toMatchObject({ kind: "rewrite", index: "head" });
    expect(head!.cur).toContain("<memories>new");
  });

  test("비밀값처럼 보이는 발췌는 남기지 않는다", () => {
    const h = harness();
    h.send(conversation("api_key 하나"));
    h.send(conversation("api_key 둘"));
    const [found] = h.breaks();
    expect(found!.prev).toBe("[생략: 비밀값처럼 보이는 내용]");
    expect(found!.cur).toBe("[생략: 비밀값처럼 보이는 내용]");
  });

  test("머리가 바뀌면 대화가 짧아도 머리 뒤쪽 손실로 기록하고 머리 글자 수를 남긴다", () => {
    const h = harness();
    const context = `<project-context>\n${"x".repeat(MIN_LOST_CHARS + 5_000)}\n</project-context>`;
    h.send(payload("- a: one", context));
    h.send(payload("- b: two", context));
    const [found] = h.breaks();
    expect(found).toMatchObject({ kind: "rewrite", index: "head", prevChars: expect.any(Number), curChars: expect.any(Number) });
    expect(found!.lostChars).toBeGreaterThanOrEqual(MIN_LOST_CHARS);
  });

  test("기준 요청이 없어도 이어 보내기 뒤 전체 요청은 chain-reset으로 남는다", () => {
    let now = 1_000;
    const h = harness([], () => now);
    h.send(codex([{ role: "user", content: "delta" }], { chained: true }));
    now = 91_000;
    h.send(codex([{ role: "user", content: "full" }]));
    expect(h.breaks()).toEqual([expect.objectContaining({ kind: "chain-reset", chained: 1, gapMs: 90_000 })]);
  });

  test("끊김 기록이 실패해도 요청 훅은 던지지 않고 다음 비교 기준은 지금 요청으로 옮긴다", () => {
    const h = harness([], () => 1_000, PROMPT_PREFIX_BREAK_TYPE);
    h.send(conversation());
    h.send(conversation("고침 하나"));
    expect(h.breaks()).toEqual([]);
    // 기준이 실패한 요청으로 옮겨졌으면 같은 요청은 끊김이 아니고, 다음 변경만 기록된다.
    h.send(conversation("고침 하나"));
    expect(h.breaks()).toEqual([]);
    h.send(conversation("고침 둘"));
    expect(h.breaks()).toEqual([expect.objectContaining({ kind: "rewrite", index: 0 })]);
  });

  test("다른 세션으로 바뀌거나 분기를 옮기면 이전 기준과 비교하지 않는다", () => {
    const h = harness();
    h.send(conversation());
    h.switchTo("s2");
    h.send(conversation("다른 세션의 첫 질문"));
    h.emit("session_tree");
    h.send(conversation("분기를 옮긴 뒤"));
    expect(h.breaks()).toEqual([]);
  });
});
