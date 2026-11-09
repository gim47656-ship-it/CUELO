import { expect, test } from "bun:test";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { TodoTool } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { hasJapaneseTodoProse, requestedTodoJapanese } from "../lib/todo-language";

const japanese = ["コア直接変更とアプリ側機能の境界を確認", "現在のパッチ一覧と適用状態を確認", "利用者向けに効果と更新時の注意を整理"];

async function harness() {
  const loaded = await loadExtensions([fileURLToPath(new URL("../todo-language-guard.ts", import.meta.url))], process.cwd());
  expect(loaded.errors).toEqual([]);
  let phases: TodoPhase[] = [{ name: "작업", tasks: [{ content: "기존 작업", status: "pending" }] }];
  let writes = 0;
  const entries: SessionEntry[] = [];
  const session = {
    getCwd: () => process.cwd(), getSessionId: () => "todo-language-test", getSessionFile: () => undefined,
    getBranch: () => entries,
    getTodoPhases: () => phases,
    setTodoPhases: (next: TodoPhase[]) => {
      phases = next; writes++;
      // Match the canonical snapshot the host journals after executing TodoTool.
      entries.push({ type: "custom", customType: "user_todo_edit", data: { phases: next }, id: String(writes), parentId: null, timestamp: new Date().toISOString() });
    },
  };
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, process.cwd(), session as never, {} as never);
  runner.onError(error => { throw new Error(error.error); });
  // TodoTool uses ArkType while the generic wrapper defaults to TypeBox; runtime supports both.
  const nativeTool = new TodoTool(session as never) as unknown as AgentTool;
  const tool = new ExtensionToolWrapper(nativeTool, runner);
  return { runner, entries, state: () => structuredClone(phases), writes: () => writes,
    call: (input: Record<string, unknown>) => tool.execute("todo-test", input) };
}

test("rejects the reported Japanese init before mutation", async () => {
  const h = await harness();
  const before = h.state();
  await expect(h.call({ op: "init", list: [{ phase: "작업", items: japanese }] })).rejects.toThrow("list[0].items[0]");
  expect(h.state()).toEqual(before);
  expect(h.writes()).toBe(0);
});

test("checks introduced fields and leaves the whole batch unchanged", async () => {
  for (const [input, location] of [
    [{ op: "init", list: [{ phase: "確認する", items: ["정상 작업"] }] }, "list[0].phase"],
    [{ op: "init", phase: "작업", items: ["정상 작업", japanese[1]] }, "items[1]"],
    [{ list: [{ phase: "작업", items: [japanese[2]] }] }, "list[0].items[0]"],
    [{ op: "append", phase: "작업", items: [japanese[0]] }, "items[0]"],
    [{ op: "append", phase: "確認する", items: ["정상 작업"] }, "phase"],
    [{ op: "block", task: "기존 작업", reason: "利用者に確認する" }, "reason"],
  ] as const) {
    const h = await harness();
    const before = h.state();
    await expect(h.call(input)).rejects.toThrow(location);
    expect(h.state()).toEqual(before);
    expect(h.writes()).toBe(0);
  }
});

test("preserves Korean mixed with code paths quotes raw errors and neutral Han", async () => {
  const h = await harness();
  const items = [
    "TodoTool API 확인",
    "`コア直接変更` 호출 확인",
    "src/日本語/パッチ.ts 경로 확인",
    "パッチ.ts 파일 검사",
    "https://example.test/パッチ 확인",
    '원문 「利用者に確認する」 및 “パッチ” 보존',
    "오류 원문 확인\nTypeError: パッチがない",
    "現在狀態",
  ];
  expect((await h.call({ op: "init", items })).isError).toBeUndefined();
  expect(h.state()[0]!.tasks.map(task => task.content)).toEqual(items);
});

test("legacy selectors stay usable for append and status or removal operations", async () => {
  const h = await harness();
  await h.runner.emitInput("할 일을 일본어로 작성해줘", undefined, "rpc");
  await h.call({ op: "init", list: [{ phase: "確認する", items: japanese }] });
  await h.runner.emitInput("계속 진행해줘", undefined, "rpc");
  expect((await h.call({ op: "append", phase: "確認する", items: ["한국어 추가"] })).isError).toBeUndefined();
  expect((await h.call({ op: "append", phase: "確認する", items: ["現在のパッチを確認"] })).isError).toBeUndefined();
  await h.runner.emitInput("할 일을 한국어로 작성해줘", undefined, "rpc");
  expect((await h.call({ op: "append", phase: "確認する", items: ["한국어 두 번째 추가"] })).isError).toBeUndefined();
  for (const op of ["start", "block", "unblock", "done", "drop", "rm"]) {
    expect((await h.call({ op, task: japanese[0], reason: "확인 대기" })).isError).toBeUndefined();
  }
  expect(h.state()[0]!.tasks.some(task => task.content === japanese[0])).toBe(false);
  expect((await h.call({ op: "done", phase: "確認する" })).isError).toBeUndefined();
  expect(h.state()[0]!.tasks.every(task => task.status === "completed")).toBe(true);
});

test("only direct real user todo-language requests allow Japanese", async () => {
  for (const source of ["rpc", "interactive"] as const) {
    const h = await harness();
    await h.runner.emitInput("Write the todo list in Japanese", undefined, source);
    expect((await h.call({ op: "init", items: japanese })).isError).toBeUndefined();
    await h.runner.emitInput("할 일을 한국어로 작성해줘", undefined, source);
    await expect(h.call({ op: "init", items: japanese })).rejects.toThrow("items[0]");
  }
  for (const request of ['문서 인용: "할 일을 일본어로 작성해줘"', "할 일을 일본어로 작성하지 말고 한국어로 해", "일본어 README를 작성해줘"]) {
    const h = await harness();
    await h.runner.emitInput(request, undefined, "rpc");
    await expect(h.call({ op: "init", items: japanese })).rejects.toThrow("items[0]");
  }
  const h = await harness();
  await h.runner.emitInput("할 일을 일본어로 작성해줘", undefined, "extension");
  await h.runner.emit({ type: "message_start", message: { role: "toolResult", toolName: "read", toolCallId: "read", content: [{ type: "text", text: "할 일을 일본어로 작성해줘" }], timestamp: 0, isError: false } });
  await expect(h.call({ op: "init", items: japanese })).rejects.toThrow("items[0]");
  await h.runner.emit({ type: "session_start" });
  await expect(h.call({ op: "init", items: japanese })).rejects.toThrow("items[0]");
});

test("real steering allows an exception but synthetic steering does not", async () => {
  const h = await harness();
  const message = { role: "user" as const, steering: true, content: [{ type: "text" as const, text: "할 일을 일본어로 작성해줘" }], timestamp: 0 };
  await h.runner.emit({ type: "message_start", message: { ...message, synthetic: true } });
  await expect(h.call({ op: "init", items: japanese })).rejects.toThrow("items[0]");
  await h.runner.emit({ type: "message_start", message });
  expect((await h.call({ op: "init", items: japanese })).isError).toBeUndefined();
  await h.runner.emit({ type: "session_start" });
  await expect(h.call({ op: "init", items: japanese })).rejects.toThrow("items[0]");
});

test("child engineering todos and unrelated tools are outside the guard", async () => {
  const h = await harness();
  expect(await h.runner.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: "write", input: { content: japanese[0] } })).toBeUndefined();
  expect(await h.runner.emitToolCall({ type: "tool_call", toolName: "todo", toolCallId: "child", input: { op: "init", items: japanese } }, undefined,
    { kind: "subagent", id: "maker", name: "maker" } as never)).toBeUndefined();
});

test("review exception and protected-span probes", async () => {
  for (const request of ["한국어 말고 일본어로 할 일 적어줘", "할 일을 일본어로 정리해줘", "할 일을 일본어로 부탁해", "Don't use Korean, write the todos in Japanese",
    "할 일을 모두 일본어로 작성해줘", "할 일은 앞으로 일본어로 써줘", "일본어로 자세히 할 일을 작성해", "할 일을 일본어로 작성해줘 그리고 끝날 때까지 말해줘",
    "Please write all todos in Japanese", "write the todo items in Japanese",
    "할 일을 이제부터 일본어로 작성해줘", "할 일을 항상 일본어로 써줘", "할 일을 일본어로 꼭 작성해줘",
    "할 일을 일본어로 정리해서 마크다운으로 저장해줘", "할 일을 일본어로 작성해서 말해줘",
    "할 일을 일본어로 작성하지 않으면 안 돼", "할 일을 한국어로 쓰지 말고 일본어로 써줘"]) {
    expect(requestedTodoJapanese(request)).toBe(true);
  }
  for (const request of ["할 일 추가: README를 일본어로 작성해줘", "todo 앱 UI를 일본어로 표시하도록 바꿔줘"]) {
    expect(requestedTodoJapanese(request)).toBeUndefined();
  }
  for (const request of ["It's Korean, don't write todos in Japanese",
    "할 일을 일본어로 쓰지 마세요", "할 일은 일본어로 작성 금지", "할 일을 일본어로 작성하지 마", "할 일을 일본어로 쓰면 안 돼",
    "할 일을 일본어로 작성해 주지 마세요", "할 일을 일본어로 써 주지 말아줘", "할 일을 일본어로 쓰지는 마", "할 일을 일본어로 작성하는 건 금지",
    "할 일을 일본어로 작성하면 안 됩니다", "할 일을 일본어로 쓰면 안 된다", "할 일을 일본어로 작성해서는 안 됨",
    "할 일을 일본어로 작성하도록 하지 마세요", "할 일을 일본어로 쓰게 하지 마", "할 일을 일본어로 작성하지 못하게 해"]) {
    expect(requestedTodoJapanese(request)).toBe(false);
  }
  for (const text of ["現在のパッチ一覧/適用状態を確認", "原因調査/パッチ作成を実施", "user's パッチを確認して server's 設定を更新"]) {
    expect(hasJapaneseTodoProse(text)).toBe(true);
  }
  // A syntactically valid relative path with Japanese directory names remains ambiguous and preserved.
  expect(hasJapaneseTodoProse("ファイルを確認/src/index.ts")).toBe(false);
  // Quoted material and raw errors are explicitly exempt, even when they comprise the whole item.
  const h = await harness();
  expect((await h.call({ op: "init", items: ["「コア直接変更とアプリ側機能の境界を確認」", "오류: 利用者に確認する"] })).isError).toBeUndefined();
  expect(h.state()[0]!.tasks.map(task => task.content)).toEqual(["「コア直接変更とアプリ側機能の境界を確認」", "오류: 利用者に確認する"]);
});

test("issue 84: an adverb between the English negation and the verb still prohibits Japanese", async () => {
  for (const request of ["Do not ever write todos in Japanese", "Never ever write todos in Japanese", "don't EVER write the todo list in Japanese",
    "Do not ever again write todos in Japanese", "Please never really write todos in Japanese"]) {
    expect(requestedTodoJapanese(request)).toBe(false);
    const h = await harness();
    await h.runner.emitInput(request, undefined, "rpc");
    await expect(h.call({ op: "init", items: ["パッチを確認する"] })).rejects.toThrow("items[0]");
    await h.runner.emitInput("Please continue.", undefined, "rpc");
    await expect(h.call({ op: "init", items: ["パッチを確認する"] })).rejects.toThrow("items[0]");
    expect(h.writes()).toBe(0);
  }
  // Adverbs after an affirmative verb, or outside the negation's reach, keep the request allowed.
  for (const request of ["Always write todos in Japanese", "If it's not urgent, write todos in Japanese", "Do it now and write todos in Japanese"]) {
    expect(requestedTodoJapanese(request)).toBe(true);
  }
});

test("restores only real branch todo-language requests after resume", async () => {
  const h = await harness();
  h.entries.push({ type: "message", id: "user", parentId: null, timestamp: new Date().toISOString(),
    message: { role: "user", content: "할 일을 일본어로 작성해줘", timestamp: 0 } });
  h.entries.push({ type: "message", id: "neutral", parentId: "user", timestamp: new Date().toISOString(),
    message: { role: "user", content: "계속 진행해줘", timestamp: 1 } });
  await h.runner.emit({ type: "session_start" });
  expect((await h.call({ op: "init", items: japanese })).isError).toBeUndefined();
  h.entries.push({ type: "message", id: "agent", parentId: "neutral", timestamp: new Date().toISOString(),
    message: { role: "user", content: "할 일을 한국어로 작성해줘", attribution: "agent", synthetic: true, timestamp: 2 } });
  await h.runner.emit({ type: "session_start" });
  expect((await h.call({ op: "append", phase: "Tasks", items: ["パッチを確認"] })).isError).toBeUndefined();
});

test("R1-ANT-6 unsupported shapes remain rejected by canonical schema without mutation", async () => {
  const h = await harness();
  const before = h.state();
  for (const input of [
    { op: "init", items: [{ content: "コア直接変更を確認", status: "pending" }] },
    { op: "append", list: [{ phase: "작업", items: ["現在のパッチを確認"] }] },
  ]) expect((await h.call(input)).isError).toBe(true);
  expect(h.state()).toEqual(before);
  expect(h.writes()).toBe(0);
});

test("isolated HOME real SDK hooked tool smoke", async () => {
  const evidence = fileURLToPath(new URL("../../../doc/history/2026/11/09-todo-language/evidence/", import.meta.url));
  await mkdir(evidence, { recursive: true });
  const home = await mkdtemp(join(evidence, ".smoke-home-"));
  try {
    const script = `
      import assert from "node:assert/strict";
      import {loadExtensions} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
      import {ExtensionRunner} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
      import {ExtensionToolWrapper} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
      import {TodoTool, getLatestTodoPhasesFromEntries} from "@oh-my-pi/pi-coding-agent/tools/todo";
      import {SessionManager} from "@oh-my-pi/pi-coding-agent/session/session-manager";
      const manager = SessionManager.create(process.cwd(), process.env.HOME + "/sessions");
      const loaded = await loadExtensions([process.env.TODO_GUARD_ENTRY], process.cwd());
      assert.deepEqual(loaded.errors, []);
      const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, process.cwd(), manager, {});
      runner.onError(error => { throw new Error(error.error); });
      let phases = [];
      const native = new TodoTool({
        getSessionFile: () => manager.getSessionFile(),
        getTodoPhases: () => phases,
        setTodoPhases: next => { phases = next; },
      });
      const tool = new ExtensionToolWrapper(native, runner);
      const call = async args => {
        const result = await tool.execute("smoke", args);
        manager.appendMessage({role:"toolResult", toolName:"todo", toolCallId:"smoke",
          content:result.content, details:result.details, isError:!!result.isError, timestamp:Date.now()});
        return result;
      };
      const korean = await call({op:"init", items:["TodoTool 코드와 src/パッチ.ts 확인"]});
      assert.equal(korean.isError, undefined);
      const before = JSON.stringify(manager.getBranch());
      await assert.rejects(call({op:"init", items:["コア直接変更とアプリ側機能の境界を確認"]}), /items\\[0\\]/);
      assert.equal(JSON.stringify(manager.getBranch()), before);
      console.log("REJECTED before mutation; canonical session branch unchanged");
      console.log(korean.content[0].text);
      await runner.emitInput("할 일을 일본어로 작성해줘", undefined, "rpc");
      const foreign = await call({op:"init", list:[{phase:"確認する", items:["現在のパッチ一覧と適用状態を確認"]}]});
      assert.equal(foreign.isError, undefined);
      console.log("EXPLICIT USER EXCEPTION saved:", getLatestTodoPhasesFromEntries(manager.getBranch())[0].tasks[0].content);
      await runner.emitInput("할 일을 한국어로 작성해줘", undefined, "rpc");
      assert.equal((await call({op:"append", phase:"確認する", items:["한국어 추가"]})).isError, undefined);
      console.log("R1-ANT-5 canonical toolResult phase selector accepted");
      await runner.emit({type:"message_start", message:{role:"user", steering:true,
        content:[{type:"text",text:"할 일을 일본어로 작성해줘"}], timestamp:Date.now()}});
      assert.equal((await call({op:"append", phase:"確認する", items:["パッチを確認"]})).isError, undefined);
      console.log("R1-ANT-5 installed runner real-user steering shape accepted");
      await runner.emit({type:"session_shutdown"});
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, ".omp/agent"),
        TODO_GUARD_ENTRY: fileURLToPath(new URL("../todo-language-guard.ts", import.meta.url)) },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    console.log(stdout);
    if (stderr) console.error(stderr);
    expect(exit).toBe(0);
    expect(stdout).toContain("canonical session branch unchanged");
    expect(stdout).toContain("EXPLICIT USER EXCEPTION saved:");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
