import { describe, expect, mock, test } from "bun:test";
import { watch } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  clearPreparedTaskSession,
  storePreparedTaskBatch,
} from "../lib/prepared-task";

// Test-only loader boundary: the mirror has no runtime OMP package, so register the Bun mock before loading index.ts.
mock.module("@oh-my-pi/pi-coding-agent", () => ({
  isToolCallEventType: (toolName: string, event: { toolName?: string }) => event.toolName === toolName,
}));

const { default: commandGuard } = await import("./index");

type Handler = (event: unknown, ctx: unknown) => unknown;

function createGuardHarness(options: { cwd?: string; sessionId?: string } = {}) {
  const handlers: Record<string, Handler[]> = {};
  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  const pi = {
    on(name: string, handler: Handler) {
      (handlers[name] ??= []).push(handler);
    },
    sendMessage(message: unknown, sendOptions: unknown) {
      sentMessages.push({ message, options: sendOptions });
    },
  };
  commandGuard(pi as never);
  const ctx = {
    cwd: options.cwd ?? process.cwd(),
    sessionManager: { getSessionId: () => options.sessionId ?? "runtime-guard-session" },
  };
  return {
    sentMessages,
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

async function runFixtureGit(cwd: string, args: string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${exitCode})\n${stdout}${stderr}`);
  }
}

function waitForFile(path: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    resolve();
  };
  const watcher = watch(dirname(path), () => {
    void access(path).then(finish, () => {});
  });
  void access(path).then(finish, () => {});
  return promise.finally(() => watcher.close());
}

type DelayedGitFixture = {
  root: string;
  workspace: string;
  markerPath: string;
  releasePath: string;
};

async function armStatusDelay(fixture: DelayedGitFixture) {
  await Promise.all([
    rm(fixture.markerPath, { force: true }),
    rm(fixture.releasePath, { force: true }),
  ]);
  return {
    started: waitForFile(fixture.markerPath),
    release: () => writeFile(fixture.releasePath, "release\n"),
  };
}

async function createDelayedGitFixture(): Promise<DelayedGitFixture> {
  const root = await mkdtemp(join(tmpdir(), "omp-ownership-"));
  const repository = join(root, "repository");
  const workspace = join(repository, "workspace");
  await mkdir(join(workspace, "owned"), { recursive: true });
  await mkdir(join(workspace, "outside"), { recursive: true });
  await Promise.all([
    writeFile(join(workspace, "owned", "kept.txt"), "owned-baseline\n"),
    writeFile(join(workspace, "outside", "dirty.txt"), "clean\n"),
    writeFile(join(workspace, "outside", "unchanged.txt"), "clean\n"),
    writeFile(join(workspace, "outside", "delete.txt"), "delete-me\n"),
    writeFile(join(workspace, "outside", "rename.txt"), "rename-me\n"),
  ]);
  await runFixtureGit(repository, ["init", "--quiet"]);
  await runFixtureGit(repository, ["config", "user.name", "OMP Test"]);
  await runFixtureGit(repository, ["config", "user.email", "omp-test@example.invalid"]);
  await runFixtureGit(repository, ["config", "commit.gpgsign", "false"]);
  await runFixtureGit(repository, ["config", "core.autocrlf", "false"]);
  await runFixtureGit(repository, ["add", "--", "workspace"]);
  await runFixtureGit(repository, ["commit", "--quiet", "-m", "fixture"]);
  await Promise.all([
    writeFile(join(workspace, "outside", "dirty.txt"), "dirty-before-spawn\n"),
    writeFile(join(workspace, "outside", "unchanged.txt"), "unchanged-dirty\n"),
  ]);

  const markerPath = join(root, "fsmonitor-started");
  const releasePath = join(root, "fsmonitor-release");
  const delayScript = join(root, "delayed-fsmonitor.cjs");
  const hookPath =
    process.platform === "win32" ? join(root, "delayed-fsmonitor.cmd") : join(root, "delayed-fsmonitor");
  // fake timer는 실제 Git child가 JS event loop를 양보하는지 증명하지 못한다. marker/release 파일로
  // child를 결정적으로 멈추며, deadline은 sync 회귀가 release 쓰기까지 막을 때의 회수 안전장치다.
  await writeFile(
    delayScript,
    `const fs = require("node:fs");\n` +
      `const marker = ${JSON.stringify(markerPath)};\n` +
      `const release = ${JSON.stringify(releasePath)};\n` +
      `fs.writeFileSync(marker, String(process.pid));\n` +
      `const cell = new Int32Array(new SharedArrayBuffer(4));\n` +
      `const deadline = Date.now() + 1500;\n` +
      `while (!fs.existsSync(release) && Date.now() < deadline) Atomics.wait(cell, 0, 0, 10);\n` +
      `process.exit(1);\n`,
  );
  if (process.platform === "win32") {
    await writeFile(hookPath, `@"${process.execPath}" "${delayScript}"\r\n`);
  } else {
    await writeFile(hookPath, `#!/bin/sh\nexec "${process.execPath}" "${delayScript}"\n`);
    await chmod(hookPath, 0o755);
  }
  await runFixtureGit(repository, ["config", "core.fsmonitorHookVersion", "1"]);
  await runFixtureGit(repository, ["config", "core.fsmonitor", hookPath.replace(/\\/g, "/")]);
  return { root, workspace, markerPath, releasePath };
}

function makerTaskEvent(toolCallId: string, name: string) {
  return {
    type: "tool_call",
    toolName: "task",
    toolCallId,
    input: {
      agent: "maker",
      name,
      task:
        "TASK_GUARD:\n" +
        "WORK_CLASS: maintenance\n" +
        "PURPOSE: primary\n" +
        "BLOCKS_PRIMARY: yes\n" +
        "PRIMARY_DELIVERABLE: 비동기 소유권 스냅샷\n" +
        "OWNED_PATHS: owned/\n\n" +
        "격리 fixture를 수정한다.",
    },
  };
}

function settledTaskResult(toolCallId: string, name: string) {
  return {
    type: "tool_result",
    toolName: "task",
    toolCallId,
    input: {},
    content: [{ type: "text", text: "spawned" }],
    isError: false,
    details: { progress: [{ index: 0, id: name, status: "completed" }] },
  };
}

function renderedText(value: unknown): string {
  if (!value || typeof value !== "object" || !("content" in value)) return "";
  if (typeof value.content === "string") return value.content;
  if (!Array.isArray(value.content)) return "";
  return value.content
    .flatMap((part) => {
      if (!part || typeof part !== "object" || !("text" in part) || typeof part.text !== "string") {
        return [];
      }
      return [part.text];
    })
    .join("\n");
}

describe("command guard runtime gates", () => {
  test("genuine 입력이나 사람의 steering은 첫 tool call을 막지 않는다", async () => {
    const harness = createGuardHarness();
    await harness.emit("input", { type: "input", text: "상태를 확인해", source: "rpc" });

    expect(await harness.emit("tool_call", {
      type: "tool_call",
      toolName: "read",
      toolCallId: "read-1",
      input: { path: "file.ts", i: "Reading file" },
    })).toBeUndefined();

    await harness.emit("message_start", {
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "방향 바꿔" }], steering: true },
    });
    expect(await harness.emit("tool_call", {
      type: "tool_call",
      toolName: "read",
      toolCallId: "read-2",
      input: { path: "file.ts", i: "Reading file" },
    })).toBeUndefined();
  });

  test("이미 표시된 답변 뒤 read·eval·todo를 AnswerFirst 오탐으로 다시 막지 않는다", async () => {
    const harness = createGuardHarness();
    await harness.emit("input", { type: "input", text: "후속 작업도 계속해", source: "rpc" });
    await harness.emit("message_start", {
      type: "message_start",
      message: { role: "assistant", content: [{ type: "text", text: "답변은 이미 사용자에게 표시됐다." }] },
    });

    for (const event of [
      {
        type: "tool_call",
        toolName: "read",
        toolCallId: "answer-first-read",
        input: { path: "file.ts", i: "Reading follow-up" },
      },
      {
        type: "tool_call",
        toolName: "eval",
        toolCallId: "answer-first-eval",
        input: { language: "js", code: "display(1)", i: "Checking follow-up" },
      },
      {
        type: "tool_call",
        toolName: "todo",
        toolCallId: "answer-first-todo",
        input: { action: "continue" },
      },
    ]) {
      expect(await harness.emit("tool_call", event)).toBeUndefined();
    }
  });

  test("synthetic·agent 귀속 steering은 사용자 redirect나 summon으로 취급하지 않는다", async () => {
    const genuine = createGuardHarness();
    await genuine.emit("message_start", {
      type: "message_start",
      message: { role: "user", content: "이 대화에서 미오불러와", steering: true },
    });
    expect(await genuine.emit("tool_call", {
      type: "tool_call",
      toolName: "read",
      toolCallId: "read-genuine",
      input: { path: "file.ts", i: "Reading file" },
    })).toMatchObject({ block: true });

    for (const message of [
      { role: "user", content: "이 대화에서 미오불러와", steering: true, synthetic: true },
      { role: "user", content: "이 대화에서 미오불러와", steering: true, attribution: "agent" },
      { role: "custom", customType: "async-result", content: "이 대화에서 미오불러와", steering: true },
      { role: "system", content: "이 대화에서 미오불러와", steering: true },
    ]) {
      const harness = createGuardHarness();
      await harness.emit("message_start", { type: "message_start", message });
      expect(await harness.emit("tool_call", {
        type: "tool_call",
        toolName: "read",
        toolCallId: "read-filtered",
        input: { path: "file.ts", i: "Reading file" },
      })).toBeUndefined();
    }
  });

  test("explicit multi-character summon requires exact markers and covers every pending alias", async () => {
    const taskBody = (marker: string) =>
      `${marker}\nTASK_GUARD:\nWORK_CLASS: diagnostic\nPRIMARY_DELIVERABLE: 인사\nOWNED_PATHS: .\n\n인사한다.`;
    const yukiMarker = '[character-summon alias="YUKI(유키)" model="openai-codex/gpt-6-astra"]';
    const mioMarker = '[character-summon alias="MIO(미오)" model="anthropic/claude-opus-5-5" oauth-position="N"]';

    const unmarked = createGuardHarness();
    await unmarked.emit("input", { type: "input", text: "유키랑 미오 불러와", source: "rpc" });
    const unmarkedBlocked = await unmarked.emit("tool_call", {
      type: "tool_call",
      toolName: "task",
      toolCallId: "task-unmarked",
      input: {
        tasks: [
          { agent: "maker", task: taskBody("인사 A") },
          { agent: "maker", task: taskBody("인사 B") },
        ],
      },
    });
    expect(unmarkedBlocked).toMatchObject({ block: true });

    const partial = createGuardHarness();
    await partial.emit("input", { type: "input", text: "유키랑 미오 불러와", source: "rpc" });
    const partialBlocked = await partial.emit("tool_call", {
      type: "tool_call",
      toolName: "task",
      toolCallId: "task-partial",
      input: { tasks: [{ agent: "maker", task: taskBody(yukiMarker) }] },
    });
    expect(partialBlocked).toMatchObject({ block: true });

    const marked = createGuardHarness();
    await marked.emit("input", { type: "input", text: "유키랑 미오 불러와", source: "rpc" });
    const allowed = await marked.emit("tool_call", {
      type: "tool_call",
      toolName: "task",
      toolCallId: "task-marked",
      input: {
        tasks: [
          { agent: "maker", task: taskBody(mioMarker) },
          { agent: "maker", task: taskBody(yukiMarker) },
        ],
      },
    }) as { input?: { tasks?: Array<{ task: string }> } } | undefined;
    expect(allowed?.input?.tasks).toHaveLength(2);
    expect(allowed?.input?.tasks?.[0]?.task).toContain('alias="MIO(미오)"');
    expect(allowed?.input?.tasks?.[1]?.task).toContain('alias="YUKI(유키)"');
    expect(await marked.emit("tool_call", {
      type: "tool_call",
      toolName: "read",
      toolCallId: "read-after",
      input: { path: "file.ts", i: "Reading file" },
    })).toBeUndefined();
  });

  test("무공백 TASK_GUARD 뒤 marker와 원래 캐릭터 과제를 함께 보존한다", async () => {
    const harness = createGuardHarness();
    await harness.emit("input", { type: "input", text: "린 불러와", source: "rpc" });
    const marker =
      '[character-summon alias="RIN(린)" model="anthropic/claude-opus-5-5" oauth-position="N"]';
    const allowed = await harness.emit("tool_call", {
      type: "tool_call",
      toolName: "task",
      toolCallId: "task-rin-no-gap",
      input: {
        agent: "maker",
        task: [
          "TASK_GUARD:",
          "WORK_CLASS: diagnostic",
          "PRIMARY_DELIVERABLE: 린의 실제 인사를 인라인으로 표시한다",
          "OWNED_PATHS: .",
          "ROUTING_REASON: RIN exact 모델과 OAuth position 0을 우선한다",
          marker,
          "# Target",
          "린이 사용자에게 직접 인사한다.",
        ].join("\n"),
      },
    }) as { input?: { task?: string } } | undefined;
    const task = allowed?.input?.task ?? "";
    expect(task).toContain(marker);
    expect(task).toContain("PURPOSE: primary");
    expect(task).toContain("BLOCKS_PRIMARY: yes");
    expect(task).toContain("ROUTING_REASON: RIN exact 모델과 OAuth position 0을 우선한다");
    expect(task).toContain("# Target\n린이 사용자에게 직접 인사한다.");
    expect(task.match(/^TASK_GUARD:$/gm)).toHaveLength(1);
  });

  test("a mixed summon keeps SHION pending while tool-capable tasks dispatch", async () => {
    const harness = createGuardHarness();
    await harness.emit("input", { type: "input", text: "유키와 시온 불러와", source: "rpc" });

    const allowed = await harness.emit("tool_call", {
      type: "tool_call",
      toolName: "task",
      toolCallId: "task-yuki",
      input: {
        tasks: [{
          agent: "maker",
          task: '[character-summon alias="YUKI(유키)" model="openai-codex/gpt-6-astra"]\nTASK_GUARD:\nWORK_CLASS: diagnostic\nPRIMARY_DELIVERABLE: 인사\nOWNED_PATHS: .\n\n인사한다.',
        }],
      },
    }) as { input?: unknown } | undefined;
    expect(allowed?.input).toBeDefined();

    const readBlocked = await harness.emit("tool_call", {
      type: "tool_call",
      toolName: "read",
      toolCallId: "read-mixed",
      input: { path: "file.ts", i: "Reading file" },
    });
    expect(readBlocked).toMatchObject({ block: true });

    expect(await harness.emit("tool_call", {
      type: "tool_call",
      toolName: "eval",
      toolCallId: "eval-shion",
      input: {
        language: "js",
        code: "const prompt='<character-voice alias=\"SHION(시온)\">'; completion(prompt, { model: 'web6/gpt-6-pro' });",
        i: "Calling WEB6 consultation",
      },
    })).toBeUndefined();
  });

  test("ordinary eval keeps stateless completion available for final-verdict consult", async () => {
    const harness = createGuardHarness();
    await harness.emit("input", { type: "input", text: "최종 판정 상담해", source: "rpc" });
    expect(await harness.emit("tool_call", {
      type: "tool_call",
      toolName: "eval",
      toolCallId: "eval-final-verdict",
      input: {
        language: "js",
        code: "completion('minimal verdict packet', { model: 'slow' })",
        i: "Consulting final verdict",
      },
    })).toBeUndefined();
  });

  test("MIO 불러와 summon blocks non-task first actions after the answer", async () => {
    const harness = createGuardHarness();
    await harness.emit("input", { type: "input", text: "이 대화에서 미오불러와", source: "rpc" });
    const blocked = await harness.emit("tool_call", {
      type: "tool_call",
      toolName: "read",
      toolCallId: "read-6",
      input: { path: "file.ts", i: "Reading file" },
    });
    expect(JSON.stringify(blocked)).toContain("첫 관련 행동은 task child");
  });

  test("SHION summon rejects task and accepts only voiced exact-WEB6 completion calls", async () => {
    async function readyShion() {
      const harness = createGuardHarness();
      await harness.emit("input", { type: "input", text: "시온 호출해", source: "rpc" });
      return harness;
    }

    const taskHarness = await readyShion();
    const taskBlocked = await taskHarness.emit("tool_call", {
      type: "tool_call",
      toolName: "task",
      toolCallId: "task-1",
      input: { agent: "maker", task: "상담" },
    });
    expect(JSON.stringify(taskBlocked)).toContain("task child가 아닙니다");

    const wrongHarness = await readyShion();
    const evalBlocked = await wrongHarness.emit("tool_call", {
      type: "tool_call",
      toolName: "eval",
      toolCallId: "eval-wrong",
      input: { language: "js", code: "print('wrong')", i: "Calling consultation" },
    });
    expect(JSON.stringify(evalBlocked)).toContain("character-voice");

    const jsSlowHarness = await readyShion();
    const jsSlowBlocked = await jsSlowHarness.emit("tool_call", {
      type: "tool_call",
      toolName: "eval",
      toolCallId: "eval-js-slow",
      input: {
        language: "js",
        code: "const marker='web6/gpt-6-pro'; const prompt='<character-voice alias=\"SHION(시온)\">'; completion(prompt, { model: 'slow' });",
        i: "Calling WEB6 consultation",
      },
    });
    expect(JSON.stringify(jsSlowBlocked)).toContain("bare completion()");

    const pySlowHarness = await readyShion();
    const pySlowBlocked = await pySlowHarness.emit("tool_call", {
      type: "tool_call",
      toolName: "eval",
      toolCallId: "eval-py-slow",
      input: {
        language: "py",
        code: "marker = 'web6/gpt-6-pro'\nprompt = '<character-voice alias=\"SHION(시온)\">'\ncompletion(prompt, model='slow')",
        i: "Calling WEB6 consultation",
      },
    });
    expect(JSON.stringify(pySlowBlocked)).toContain("bare completion()");

    const aliasHarness = await readyShion();
    const aliasBlocked = await aliasHarness.emit("tool_call", {
      type: "tool_call",
      toolName: "eval",
      toolCallId: "eval-js-alias",
      input: {
        language: "js",
        code: "const prompt='<character-voice alias=\"SHION(시온)\">'; const c=completion; c(prompt,{model:'slow'}); completion('dummy',{model:'web6/gpt-6-pro'});",
        i: "Calling WEB6 consultation",
      },
    });
    expect(JSON.stringify(aliasBlocked)).toContain("bare completion()");

    const propertyHarness = await readyShion();
    const propertyBlocked = await propertyHarness.emit("tool_call", {
      type: "tool_call",
      toolName: "eval",
      toolCallId: "eval-js-property",
      input: {
        language: "js",
        code: "const prompt='<character-voice alias=\"SHION(시온)\">'; client.completion(prompt,{model:'web6/gpt-6-pro'});",
        i: "Calling WEB6 consultation",
      },
    });
    expect(JSON.stringify(propertyBlocked)).toContain("bare completion()");

    const multipleHarness = await readyShion();
    const multipleBlocked = await multipleHarness.emit("tool_call", {
      type: "tool_call",
      toolName: "eval",
      toolCallId: "eval-js-multiple",
      input: {
        language: "js",
        code: "const prompt='<character-voice alias=\"SHION(시온)\">'; completion(prompt,{model:'web6/gpt-6-pro'}); completion(prompt,{model:'web6/gpt-6-pro'});",
        i: "Calling WEB6 consultation",
      },
    });
    expect(JSON.stringify(multipleBlocked)).toContain("bare completion()");

    const jsObjectHarness = await readyShion();
    expect(await jsObjectHarness.emit("tool_call", {
      type: "tool_call",
      toolName: "eval",
      toolCallId: "eval-js-object",
      input: {
        language: "js",
        code: "const prompt='<character-voice alias=\"SHION(시온)\">'; completion(prompt, { model: 'web6/gpt-6-pro' });",
        i: "Calling WEB6 consultation",
      },
    })).toBeUndefined();

    const jsPositionalHarness = await readyShion();
    expect(await jsPositionalHarness.emit("tool_call", {
      type: "tool_call",
      toolName: "eval",
      toolCallId: "eval-js-positional",
      input: {
        language: "js",
        code: "const prompt='<character-voice alias=\"SHION(시온)\">'; completion(prompt, 'web6/gpt-6-pro');",
        i: "Calling WEB6 consultation",
      },
    })).toBeUndefined();

    const pyHarness = await readyShion();
    expect(await pyHarness.emit("tool_call", {
      type: "tool_call",
      toolName: "eval",
      toolCallId: "eval-py",
      input: {
        language: "py",
        code: "prompt = '<character-voice alias=\"SHION(시온)\">'\ncompletion(prompt, model='web6/gpt-6-pro')",
        i: "Calling WEB6 consultation",
      },
    })).toBeUndefined();
  });
  test("failed WEB6 consultation releases SHION while failed tool-capable spawn stays pending", async () => {
    const shion = createGuardHarness();
    await shion.emit("input", { type: "input", text: "시온 호출해", source: "rpc" });
    expect(await shion.emit("tool_call", {
      type: "tool_call",
      toolName: "eval",
      toolCallId: "eval-shion-failed",
      input: {
        language: "js",
        code: "const prompt='<character-voice alias=\"SHION(시온)\">'; completion(prompt, { model: 'web6/gpt-6-pro' });",
        i: "Calling WEB6 consultation",
      },
    })).toBeUndefined();
    await shion.emit("tool_result", {
      type: "tool_result",
      toolName: "eval",
      toolCallId: "eval-shion-failed",
      input: {},
      content: [{ type: "text", text: "completion() could not resolve exact model" }],
      isError: true,
    });
    expect(await shion.emit("tool_call", {
      type: "tool_call",
      toolName: "read",
      toolCallId: "read-after-failed-shion",
      input: { path: "diagnostics.log", i: "Reading consultation failure" },
    })).toBeUndefined();

    const yuki = createGuardHarness();
    await yuki.emit("input", { type: "input", text: "유키 불러와", source: "rpc" });
    expect(await yuki.emit("tool_call", {
      type: "tool_call",
      toolName: "task",
      toolCallId: "task-yuki-failed",
      input: {
        agent: "maker",
        task: '[character-summon alias="YUKI(유키)" model="openai-codex/gpt-6-astra"]\nTASK_GUARD:\nWORK_CLASS: diagnostic\nPRIMARY_DELIVERABLE: 인사\nOWNED_PATHS: .\n\n인사한다.',
      },
    })).toMatchObject({ input: expect.anything() });
    await yuki.emit("tool_result", {
      type: "tool_result",
      toolName: "task",
      toolCallId: "task-yuki-failed",
      input: {},
      content: [{ type: "text", text: "spawn failed" }],
      isError: true,
    });
    expect(await yuki.emit("tool_call", {
      type: "tool_call",
      toolName: "read",
      toolCallId: "read-after-failed-yuki",
      input: { path: "file.ts", i: "Reading file" },
    })).toMatchObject({ block: true });
  });
});

describe("prepared task guard glue", () => {
  test("참조를 TaskGuard 전에 canonical input으로 복원하고 invalid session ref를 차단한다", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omp-prepared-guard-"));
    const sessionId = "example";
    const canonicalEvent = makerTaskEvent("prepared-source", "PreparedGuard");
    const [preparedId] = storePreparedTaskBatch(
      "canonical prepared context",
      [{ name: "PreparedGuard", task: canonicalEvent.input.task }],
      sessionId,
    );
    try {
      const harness = createGuardHarness({ cwd: directory, sessionId });
      const result = await harness.emit("tool_call", {
        type: "tool_call",
        toolName: "task",
        toolCallId: "prepared-ref",
        input: {
          context: "PREPARED_CONTEXT",
          tasks: [{
            agent: "maker",
            name: "PreparedGuard",
            task: `PREPARED_TASK: ${preparedId}`,
          }],
        },
      });
      expect(result).toMatchObject({
        input: {
          context: "canonical prepared context",
          tasks: [{ name: "PreparedGuard", task: canonicalEvent.input.task }],
        },
      });

      const otherSession = createGuardHarness({ cwd: directory, sessionId: "sample" });
      expect(await otherSession.emit("tool_call", {
        type: "tool_call",
        toolName: "task",
        toolCallId: "prepared-wrong-session",
        input: {
          context: "PREPARED_CONTEXT",
          tasks: [{
            agent: "maker",
            name: "PreparedGuard",
            task: `PREPARED_TASK: ${preparedId}`,
          }],
        },
      })).toMatchObject({
        block: true,
        reason: expect.stringContaining("prepared task"),
      });
    } finally {
      clearPreparedTaskSession(sessionId);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("async ownership snapshots", () => {
  test("실제 지연 Git child 동안 event loop를 열어 두고 cwd 전체 내용 변화를 보고한다", async () => {
    const fixture = await createDelayedGitFixture();
    try {
      const harness = createGuardHarness({ cwd: fixture.workspace });
      const delay = await armStatusDelay(fixture);
      let dispatchSettled = false;
      const dispatch = harness.emit(
        "tool_call",
        makerTaskEvent("snapshot-full-scan", "SnapshotFullScan"),
      ).then((result) => {
        dispatchSettled = true;
        return result;
      });

      await delay.started;
      expect(dispatchSettled).toBe(false);
      await delay.release();
      await dispatch;

      await Promise.all([
        writeFile(join(fixture.workspace, "owned", "kept.txt"), "owned-after-spawn\n"),
        writeFile(join(fixture.workspace, "outside", "dirty.txt"), "dirty-after-spawn\n"),
        writeFile(join(fixture.workspace, "outside", "new.txt"), "untracked\n"),
        unlink(join(fixture.workspace, "outside", "delete.txt")),
        rename(
          join(fixture.workspace, "outside", "rename.txt"),
          join(fixture.workspace, "outside", "renamed.txt"),
        ),
      ]);

      const result = await harness.emit(
        "tool_result",
        settledTaskResult("snapshot-full-scan", "SnapshotFullScan"),
      );
      const report = renderedText(result)
        .split("\n")
        .find((text) => text.includes("[OwnershipGuard]"));
      expect(report).toBeDefined();
      const outside = /\soutside=([^ ]+)/.exec(report ?? "")?.[1]?.split(",") ?? [];
      expect(outside).toEqual(
        expect.arrayContaining([
          "outside/delete.txt",
          "outside/dirty.txt",
          "outside/new.txt",
          "outside/renamed.txt",
        ]),
      );
      expect(outside).not.toContain("outside/unchanged.txt");
      expect(outside).not.toContain("owned/kept.txt");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("Git 관측 오류는 성공이나 빈 스냅샷 대신 unobserved로 남긴다", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omp-ownership-nongit-"));
    try {
      const harness = createGuardHarness({ cwd: directory });
      await harness.emit("tool_call", makerTaskEvent("snapshot-error", "SnapshotError"));
      const result = await harness.emit(
        "tool_result",
        settledTaskResult("snapshot-error", "SnapshotError"),
      );
      const text = renderedText(result);
      expect(text).toContain(
        "[OwnershipGuard] child=SnapshotError owned=owned/ outside=unobserved concurrent=none",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("pending baseline의 reset·task 실패는 stale dispatch를 차단하고 steering은 예약을 보존한다", async () => {
    const fixture = await createDelayedGitFixture();
    try {
      const resetHarness = createGuardHarness({ cwd: fixture.workspace });
      const resetDelay = await armStatusDelay(fixture);
      const staleDispatch = resetHarness.emit(
        "tool_call",
        makerTaskEvent("snapshot-reset", "SnapshotReset"),
      );
      await resetDelay.started;
      await resetHarness.emit("input", {
        type: "input",
        text: "새 사용자 요청",
        source: "rpc",
      });
      await resetDelay.release();
      expect(await staleDispatch).toMatchObject({ block: true });
      await resetHarness.emit("message_start", {
        type: "message_start",
        message: {
          role: "custom",
          customType: "async-result",
          details: { jobs: [{ id: "SnapshotReset", type: "task", status: "completed" }] },
        },
      });
      expect(resetHarness.sentMessages).toHaveLength(0);

      const steeringHarness = createGuardHarness({ cwd: fixture.workspace });
      const steeringDelay = await armStatusDelay(fixture);
      const steeredDispatch = steeringHarness.emit(
        "tool_call",
        makerTaskEvent("snapshot-steering", "SnapshotSteering"),
      );
      await steeringDelay.started;
      await steeringHarness.emit("message_start", {
        type: "message_start",
        message: { role: "user", content: "완료물 방향을 바꾼다", steering: true },
      });
      await steeringDelay.release();
      expect((await steeredDispatch)?.block).not.toBe(true);
      await writeFile(join(fixture.workspace, "outside", "dirty.txt"), "changed-after-steering\n");
      const steeredResult = await steeringHarness.emit(
        "tool_result",
        settledTaskResult("snapshot-steering", "SnapshotSteering"),
      );
      expect(renderedText(steeredResult)).toContain("child=SnapshotSteering");

      const failedHarness = createGuardHarness({ cwd: fixture.workspace });
      const failureDelay = await armStatusDelay(fixture);
      const failedDispatch = failedHarness.emit(
        "tool_call",
        makerTaskEvent("snapshot-failed", "SnapshotFailed"),
      );
      await failureDelay.started;
      await failedHarness.emit("tool_result", {
        type: "tool_result",
        toolName: "task",
        toolCallId: "snapshot-failed",
        input: {},
        content: [{ type: "text", text: "spawn failed" }],
        isError: true,
      });
      await failureDelay.release();
      expect(await failedDispatch).toMatchObject({ block: true });
      await failedHarness.emit("message_start", {
        type: "message_start",
        message: {
          role: "custom",
          customType: "async-result",
          details: { jobs: [{ id: "SnapshotFailed", type: "task", status: "failed" }] },
        },
      });
      expect(failedHarness.sentMessages).toHaveLength(0);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("겹친 terminal 회수는 await 뒤 exact child를 재확인해 한 번만 소비한다", async () => {
    const fixture = await createDelayedGitFixture();
    try {
      const harness = createGuardHarness({ cwd: fixture.workspace });
      const baselineDelay = await armStatusDelay(fixture);
      const baseline = harness.emit(
        "tool_call",
        makerTaskEvent("snapshot-terminal", "SnapshotTerminal"),
      );
      await baselineDelay.started;
      await baselineDelay.release();
      await baseline;

      const terminalDelay = await armStatusDelay(fixture);
      const toolResult = harness.emit(
        "tool_result",
        settledTaskResult("snapshot-terminal", "SnapshotTerminal"),
      );
      const asyncResult = harness.emit("message_start", {
        type: "message_start",
        message: {
          role: "custom",
          customType: "async-result",
          details: { jobs: [{ id: "SnapshotTerminal", type: "task", status: "completed" }] },
        },
      });
      await terminalDelay.started;
      await terminalDelay.release();
      const [toolOutput] = await Promise.all([toolResult, asyncResult]);
      const toolText = renderedText(toolOutput);
      const asideText = harness.sentMessages
        .map(({ message }) => renderedText(message))
        .join("\n");
      expect((toolText + asideText).match(/\[OwnershipGuard\]/g) ?? []).toHaveLength(1);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

describe("async repository matching", () => {
  test("첫 common-dir 조회는 event loop를 열고 공유되며 동일·다른·실패 target을 보수적으로 가른다", async () => {
    const fixture = await createDelayedGitFixture();
    const recoverable = join(fixture.root, "recoverable-repository");
    const deepWorkspace = join(fixture.workspace, ...Array.from({ length: 40 }, () => "d"));
    const tracePath = join(fixture.root, "common-dir-trace.json");
    const previousTrace = process.env.GIT_TRACE2_EVENT;
    await mkdir(recoverable, { recursive: true });
    await mkdir(deepWorkspace, { recursive: true });
    process.env.GIT_TRACE2_EVENT = tracePath.replace(/\\/g, "/");
    try {
      const harness = createGuardHarness({ cwd: deepWorkspace });
      let eventLoopAdvanced = false;
      const eventLoopTick = new Promise<void>((resolveTick) => {
        // 실제 시간을 기다리지 않고 다음 event-loop check phase가 Git child 완료 전에 진행되는지 본다.
        setImmediate(() => {
          eventLoopAdvanced = true;
          resolveTick();
        });
      });
      const sameRepository = await harness.emit("tool_call", {
        type: "tool_call",
        toolName: "bash",
        toolCallId: "same-repository",
        input: { command: "git add tracked.txt", cwd: deepWorkspace },
      });
      expect(eventLoopAdvanced).toBe(true);
      await eventLoopTick;
      expect(sameRepository).toMatchObject({ block: true });

      const traceEvents = (await readFile(tracePath, "utf8"))
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event?: string; argv?: string[] });
      const commonDirectoryStarts = traceEvents.filter((event) =>
        event.event === "start" && event.argv?.includes("--git-common-dir")
      );
      // session cwd와 command target이 같은 directory여도 진행 중 promise 하나만 공유한다.
      expect(commonDirectoryStarts).toHaveLength(1);

      const slashPath = recoverable.replace(/\\/g, "/");
      const failedLookup = await harness.emit("tool_call", {
        type: "tool_call",
        toolName: "bash",
        toolCallId: "unknown-repository",
        input: { command: `git -C "${slashPath}" add tracked.txt`, cwd: deepWorkspace },
      });
      expect(failedLookup).toMatchObject({ block: true });

      await runFixtureGit(recoverable, ["init", "--quiet"]);
      const differentRepository = await harness.emit("tool_call", {
        type: "tool_call",
        toolName: "bash",
        toolCallId: "different-repository",
        input: { command: `git -C "${slashPath}" add tracked.txt`, cwd: deepWorkspace },
      });
      // 실패 undefined를 영구 negative cache로 두지 않아 저장소가 확인되면 외부 repo 명령을 허용한다.
      expect(differentRepository).toBeUndefined();

      const changedTargetEvent = {
        type: "tool_call",
        toolName: "bash",
        toolCallId: "changed-target",
        input: { command: "git add tracked.txt", cwd: deepWorkspace },
      };
      const changedTarget = harness.emit("tool_call", changedTargetEvent);
      changedTargetEvent.input.command = `git -C "${slashPath}" add tracked.txt`;
      // 1차 수집 뒤 나타난 target은 전역 cache에 값이 있어도 이 판정에서는 unknown이므로 차단한다.
      expect(await changedTarget).toMatchObject({ block: true });
    } finally {
      if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
      else process.env.GIT_TRACE2_EVENT = previousTrace;
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
