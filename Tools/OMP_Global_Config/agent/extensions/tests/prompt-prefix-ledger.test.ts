import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import promptPrefixLedger, {
  PROMPT_PREFIX_LEDGER_TYPE,
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

function harness(branch: Entry[] = []) {
  const handlers: Record<string, Handler[]> = {};
  promptPrefixLedger({
    on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); },
    appendEntry: (customType: string, data: unknown) => { branch.push({ type: "custom", customType, data }); },
  } as unknown as ExtensionAPI);
  const ctx = { sessionManager: { getBranch: () => branch } };
  const send = (body: unknown) => {
    for (const handler of handlers.before_provider_request ?? []) {
      expect(handler({ type: "before_provider_request", payload: body }, ctx)).toBeUndefined();
    }
  };
  const records = () => branch.filter((entry) => entry.customType === PROMPT_PREFIX_LEDGER_TYPE).map((entry) => entry.data as PromptPrefixRecord);
  return { branch, send, records };
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
});
