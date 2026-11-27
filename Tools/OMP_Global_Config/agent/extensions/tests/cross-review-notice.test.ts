// 편집 직후 조기 알림과 턴 끝 안내: 게이트 대상 코드의 marker와 변경 크기를 추적한다.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import crossReview, { editedPaths } from "../cross-review";
import { earlyReviewNotice, spawnExec } from "../lib/cross-review";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

const roots: string[] = [];
const savedLedger = process.env.OMP_CROSS_REVIEW_LEDGER;

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedLedger === undefined) delete process.env.OMP_CROSS_REVIEW_LEDGER; else process.env.OMP_CROSS_REVIEW_LEDGER = savedLedger;
});

function sh(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}
const blobOf = (content: string) => createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0${content}`).digest("hex");

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "cross-review-notice-"));
  roots.push(dir);
  const work = join(dir, "work");
  mkdirSync(work);
  sh(work, "init", "-q", "--initial-branch=main");
  sh(work, "config", "user.name", "t");
  sh(work, "config", "user.email", "t@example.invalid");
  writeFileSync(join(work, "base.txt"), "base\n");
  sh(work, "add", "base.txt");
  sh(work, "commit", "-q", "-m", "base");
  const ledger = join(dir, "ledger.jsonl");
  process.env.OMP_CROSS_REVIEW_LEDGER = ledger;
  const control: { failSend: boolean; reviewTool: boolean; onNotice?: () => void } = { failSend: false, reviewTool: true };
  const handlers: Record<string, Handler[]> = {};
  const busHandlers: Record<string, ((data: unknown) => void)[]> = {};
  const sent: { message: { customType: string; content: string; display: boolean }; options: unknown }[] = [];
  const ctx = { cwd: work, agent: { kind: "main" }, sessionManager: { getSessionId: () => "s1" } };
  crossReview({
    zod: { object: () => ({}), string: () => ({ optional: () => ({}) }), array: () => ({ optional: () => ({}) }), boolean: () => ({ optional: () => ({}) }), number: () => ({}) },
    registerTool: () => {},
    on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); },
    sendMessage: (message: never, options: unknown) => {
      if (control.failSend) throw new Error("delivery failed");
      sent.push({ message, options });
      control.onNotice?.();
    },
    getActiveTools: () => control.reviewTool ? ["edit", "write", "cross_review"] : ["edit", "write"],
    events: { on: (name: string, handler: (data: unknown) => void) => { (busHandlers[name] ??= []).push(handler); }, emit: () => {} },
  } as unknown as ExtensionAPI);
  const emit = async (name: string, event: Record<string, unknown>) => { for (const handler of handlers[name] ?? []) await handler(event, ctx); };
  const edited = (toolName: string, path: string, isError = false) => emit("tool_result", { toolName, input: { path }, isError });
  const turnEnd = () => {
    const notices: string[] = [];
    for (const handler of busHandlers["cuelo:turn-end-notices"] ?? []) handler({ ctx, notices });
    return notices;
  };
  return { work, ledger, sent, emit, edited, control, turnEnd };
}

/** Paths announced so far, in delivery order; one early notice lists `- <trigger>: <path>, <path>` lines. */
const noticedPaths = (env: { sent: { message: { content: string } }[] }) => env.sent.flatMap(({ message }) =>
  message.content.split("\n").filter((line) => line.startsWith("- ")).flatMap((line) => line.slice(line.lastIndexOf("): ") + 3).split(", ")));

const MARKER_CODE = "import { rmSync } from \"node:fs\";\nexport const wipe = (p: string) => rmSync(p, { recursive: true });\n";

describe("편집 직후 조기 알림", () => {
  test("marker에 맞는 편집은 파일당 한 번만 알리고, 같은 경로의 다음 편집에는 알리지 않는다", async () => {
    const env = setup();
    writeFileSync(join(env.work, "a.ts"), MARKER_CODE);
    await env.edited("write", "a.ts");
    expect(env.sent).toHaveLength(1);
    expect(env.sent[0]!.message).toMatchObject({ customType: "cross-review-notice", display: false });
    expect(env.sent[0]!.message.content).toContain("a.ts");
    expect(env.sent[0]!.message.content).toMatch(/deletion at L2/);
    expect(env.sent[0]!.options).toEqual({ deliverAs: "aside" });
    appendFileSync(join(env.work, "a.ts"), "export const more = 1;\n");
    await env.edited("edit", "a.ts");
    expect(env.sent).toHaveLength(1);
  });

  test("marker가 없거나 게이트 대상이 아닌 파일, 실패한 편집, 저장소 밖 파일에는 알리지 않는다", async () => {
    const env = setup();
    writeFileSync(join(env.work, "plain.ts"), "export const add = (a: number, b: number) => a + b;\n");
    mkdirSync(join(env.work, "doc", "history", "x"), { recursive: true });
    writeFileSync(join(env.work, "doc", "history", "x", "run.ts"), MARKER_CODE);
    writeFileSync(join(env.work, "README.md"), "run `rm -rf build` first\n");
    writeFileSync(join(env.work, "a.test.ts"), MARKER_CODE);
    writeFileSync(join(env.work, "failed.ts"), MARKER_CODE);
    const outside = mkdtempSync(join(tmpdir(), "cross-review-notice-out-"));
    roots.push(outside);
    writeFileSync(join(outside, "x.ts"), MARKER_CODE);
    for (const path of ["plain.ts", "doc/history/x/run.ts", "README.md", "a.test.ts"]) await env.edited("write", path);
    await env.edited("write", "failed.ts", true);
    await env.edited("write", join(outside, "x.ts"));
    await env.emit("tool_result", { toolName: "bash", input: { command: "ls" }, isError: false });
    expect(env.sent).toEqual([]);
  });

  test("non-error refusal and script exception do not trigger edit notices", async () => {
    const env = setup();
    writeFileSync(join(env.work, "pending.ts"), MARKER_CODE);
    await env.emit("tool_result", { toolName: "edit", input: { path: "pending.ts" }, isError: false, details: { refused: { by: "edit-snapshot" } } });
    await env.emit("tool_result", { toolName: "eval", input: { code: "raise ValueError()" }, isError: false, details: { scriptError: true } });
    expect(env.sent).toHaveLength(0);
    await env.edited("edit", "pending.ts");
    expect(noticedPaths(env)).toContain("pending.ts");
  });

  test("처음에 marker가 없던 파일이 나중에 걸리면 그때 한 번 알린다", async () => {
    const env = setup();
    writeFileSync(join(env.work, "b.ts"), "export const x = 1;\n");
    await env.edited("write", "b.ts");
    expect(env.sent).toHaveLength(0);
    writeFileSync(join(env.work, "b.ts"), MARKER_CODE);
    await env.edited("write", "b.ts");
    await env.edited("write", "b.ts");
    expect(env.sent).toHaveLength(1);
  });

  const passLedger = (root: string, path: string, content: string) =>
    `${JSON.stringify({ type: "cross-review", reviewId: "xr-1", root })}\n${JSON.stringify({ type: "cross-review-resolve", reviewId: "xr-1", pass: true, files: [{ path, blob: blobOf(content) }] })}\n`;

  test("지금 내용을 덮는 통과한 검토가 같은 저장소에 이미 있으면 알리지 않는다", async () => {
    const env = setup();
    writeFileSync(join(env.work, "a.ts"), MARKER_CODE);
    writeFileSync(env.ledger, passLedger(realpathSync(env.work), "a.ts", MARKER_CODE));
    await env.edited("write", "a.ts");
    expect(env.sent).toEqual([]);
  });

  test("다른 저장소에서 통과한 같은 경로·같은 내용은 덮지 않으므로 알린다", async () => {
    const env = setup();
    writeFileSync(join(env.work, "a.ts"), MARKER_CODE);
    writeFileSync(env.ledger, passLedger("/some/other/repo", "a.ts", MARKER_CODE));
    await env.edited("write", "a.ts");
    expect(env.sent).toHaveLength(1);
  });

  test("session 시작이 알림 기록을 비운다", async () => {
    const env = setup();
    writeFileSync(join(env.work, "a.ts"), MARKER_CODE);
    await env.edited("write", "a.ts");
    await env.emit("session_start", {});
    await env.edited("write", "a.ts");
    expect(env.sent).toHaveLength(2);
  });

  test("알림 전달이 실패해도 편집 흐름으로 번지지 않고, 전달하지 못한 파일은 다음 편집에서 다시 알린다", async () => {
    const env = setup();
    writeFileSync(join(env.work, "a.ts"), MARKER_CODE);
    env.control.failSend = true;
    await env.edited("write", "a.ts");
    expect(env.sent).toEqual([]);
    env.control.failSend = false;
    await env.edited("write", "a.ts");
    expect(env.sent).toHaveLength(1);
  });

  test("턴 끝: 통과 기록 없는 marker 파일은 입력당 한 번 안내하고, 통과한 cross_review 뒤에는 안내하지 않는다", async () => {
    const env = setup();
    writeFileSync(join(env.work, "a.ts"), MARKER_CODE);
    await env.edited("write", "a.ts");
    const first = env.turnEnd();
    expect(first).toHaveLength(1);
    expect(first[0]).toContain("a.ts");
    expect(env.turnEnd()).toEqual([]);
    await env.emit("input", { source: "interactive" });
    expect(env.turnEnd()).toHaveLength(1);
    await env.emit("input", { source: "interactive" });
    writeFileSync(env.ledger, passLedger(realpathSync(env.work), "a.ts", MARKER_CODE));
    await env.emit("tool_result", { toolName: "cross_review", input: { action: "resolve" }, isError: false });
    expect(env.turnEnd()).toEqual([]);
  });

  test("턴 끝: marker 없는 1파일 10줄 편집에는 조기 알림과 턴 끝 안내가 없다", async () => {
    const env = setup();
    writeFileSync(join(env.work, "plain.ts"), "void 0;\n".repeat(10));
    await env.edited("write", "plain.ts");
    expect(env.sent).toEqual([]);
    expect(env.turnEnd()).toEqual([]);
  });

  test("bash-only shell writes announce the size cohort and make it visible at turn end", async () => {
    const env = setup();
    const shell = Bun.spawnSync(["bash", "-c", "for file in a b c; do printf 'package example\\n' > \"$file.go\"; done"], { cwd: env.work });
    expect(shell.exitCode).toBe(0);
    await env.emit("tool_result", { toolName: "bash", input: { command: "shell writes" }, details: { exitCode: 0 }, isError: false });
    expect(env.sent).toHaveLength(1);
    expect(env.sent[0]!.message.content).toContain("- crosses the review threshold (size: 3 code files, 3 changed lines): a.go, b.go, c.go");
    expect(env.sent[0]!.message.content.match(/rule:\/\/cross-review-procedure/g)).toHaveLength(1);
    const [reminder] = env.turnEnd();
    for (const file of ["a.go", "b.go", "c.go"]) expect(reminder).toContain(file);
    await env.emit("tool_result", { toolName: "bash", input: {}, details: { exitCode: 0 }, isError: false });
    expect(noticedPaths(env)).toEqual(["a.go", "b.go", "c.go"]);
  });

  test("a completed nonzero bash result remains ineligible for the success-only size notice", async () => {
    const env = setup();
    const command = "for file in a b c; do printf 'package example\\n' > \"$file.go\"; done; exit 3";
    const bash = { toolName: "bash", input: { command } };
    await env.emit("tool_call", bash);
    const result = Bun.spawnSync(["bash", "-c", command], { cwd: env.work });
    expect(result.exitCode).toBe(3);
    await env.emit("tool_result", { ...bash, details: { exitCode: result.exitCode }, isError: false });
    expect(env.sent).toEqual([]);
    expect(env.turnEnd()).toEqual([]);
  });

  test("bash-only changes below the size threshold do not trigger marker notices", async () => {
    const env = setup();
    await env.emit("tool_result", { toolName: "bash", input: {}, details: { exitCode: 0 }, isError: false });
    expect(env.sent).toEqual([]);
    writeFileSync(join(env.work, "a.ts"), MARKER_CODE);
    await env.emit("tool_result", { toolName: "bash", input: {}, details: { exitCode: 0 }, isError: false });
    expect(env.sent).toEqual([]);
    expect(env.turnEnd()).toEqual([]);
  });

  test("uncommitted work that predates the session's first tool is not announced as the session's change", async () => {
    const env = setup();
    for (const file of ["a.go", "b.go", "c.go"]) writeFileSync(join(env.work, file), "package earlier\n");
    const bash = { toolName: "bash", input: { command: "ls" } };
    await env.emit("tool_call", bash);
    await env.emit("tool_result", { ...bash, details: { exitCode: 0 }, isError: false });
    expect(env.sent).toEqual([]);
    expect(env.turnEnd()).toEqual([]);
    // Later writes by this session, to an inherited file or a new one, still count.
    writeFileSync(join(env.work, "b.go"), "package earlier\nvar changed = 1\n");
    for (const file of ["d.go", "e.go"]) writeFileSync(join(env.work, file), "package mine\n");
    await env.emit("tool_call", bash);
    await env.emit("tool_result", { ...bash, details: { exitCode: 0 }, isError: false });
    expect(noticedPaths(env).sort()).toEqual(["b.go", "d.go", "e.go"]);
  });

  test("an inherited file the session edits with edit or write is announced", async () => {
    const env = setup();
    for (const file of ["a.ts", "b.ts"]) writeFileSync(join(env.work, file), "export const earlier = 1;\n");
    await env.emit("tool_call", { toolName: "bash", input: { command: "git status" } });
    await env.emit("tool_call", { toolName: "write", input: { path: "a.ts" } });
    writeFileSync(join(env.work, "a.ts"), MARKER_CODE);
    await env.edited("write", "a.ts");
    expect(noticedPaths(env)).toEqual(["a.ts"]);
  });

  test("a clean repository at the first tool still announces bash-only writes", async () => {
    const env = setup();
    const bash = { toolName: "bash", input: { command: "shell writes" } };
    await env.emit("tool_call", bash);
    for (const file of ["a.go", "b.go", "c.go"]) writeFileSync(join(env.work, file), "package example\n");
    await env.emit("tool_result", { ...bash, details: { exitCode: 0 }, isError: false });
    expect(noticedPaths(env)).toHaveLength(3);
  });

  test("a failed first root lookup never lets a later call baseline the session's own writes", async () => {
    const env = setup();
    const spawn = Bun.spawn;
    let failed = false;
    const hook = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof spawn>) => {
      const [command, ...rest] = args;
      if (failed || !Array.isArray(command) || !command.includes("rev-parse")) return spawn(...args);
      failed = true;
      return spawn(["git", "no-such-subcommand"], ...(rest as []));
    }) as typeof spawn);
    try {
      const bash = { toolName: "bash", input: { command: "shell writes" } };
      await env.emit("tool_call", bash);
      writeFileSync(join(env.work, "a.go"), "package mine\n");
      await env.emit("tool_result", { ...bash, details: { exitCode: 0 }, isError: false });
      await env.emit("tool_call", bash);
      for (const file of ["b.go", "c.go"]) writeFileSync(join(env.work, file), "package mine\n");
      await env.emit("tool_result", { ...bash, details: { exitCode: 0 }, isError: false });
    } finally { hook.mockRestore(); }
    expect(failed).toBe(true);
    expect(noticedPaths(env).sort()).toEqual(["a.go", "b.go", "c.go"]);
  });

  test("a baseline that misses its wait does not hold back the earlier repository-wide notice", async () => {
    const env = setup();
    for (const file of ["a.go", "b.go", "c.go"]) writeFileSync(join(env.work, file), "package earlier\n");
    const hold = Promise.withResolvers<void>();
    const spawn = Bun.spawn;
    let held = false;
    const hook = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);
      if (held || !Array.isArray(args[0]) || !args[0].includes("status")) return child;
      held = true;
      return new Proxy(child, { get: (target, key) => key === "exited"
        ? hold.promise.then(() => target.exited) : Reflect.get(target, key, target) });
    }) as typeof spawn);
    try {
      const bash = { toolName: "bash", input: { command: "ls" } };
      await env.emit("tool_call", bash);
      await env.emit("tool_result", { ...bash, details: { exitCode: 0 }, isError: false });
      expect(held).toBe(true);
      expect(noticedPaths(env)).toHaveLength(3);
    } finally {
      hold.resolve();
      hook.mockRestore();
    }
  });

  test.each([
    ["eval", {}],
    ["ast_edit", { applied: true }],
    ["resolve", { sourceToolName: "ast_edit", sourceResultDetails: { applied: true } }],
  ] as const)("%s refreshes size after writing", async (toolName, details) => {
    const env = setup();
    for (const file of ["a.go", "b.go", "c.go"]) writeFileSync(join(env.work, file), "package example\n");
    await env.emit("tool_result", { toolName: "ast_edit", input: {}, details: { applied: false }, isError: false });
    expect(env.sent).toHaveLength(0);
    await env.emit("tool_result", { toolName, input: {}, details, isError: false });
    expect(noticedPaths(env)).toHaveLength(3);
  });

  test("rapid bash results in the same window share one repository inventory", async () => {
    const env = setup();
    const spawn = Bun.spawn;
    const hook = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof spawn>) => spawn(...args)) as typeof spawn);
    try {
      await Promise.all(Array.from({ length: 8 }, () => env.emit("tool_result", { toolName: "bash", input: {}, details: { exitCode: 0 }, isError: false })));
      expect(hook.mock.calls.filter(([args]) => Array.isArray(args) && args.includes("status"))).toHaveLength(1);
    } finally { hook.mockRestore(); }
  });

  test("bash results outside a Git repository never start the inventory", async () => {
    const env = setup();
    const spawn = Bun.spawn;
    const hook = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof spawn>) => spawn(...args)) as typeof spawn);
    try {
      await env.emit("tool_result", { toolName: "bash", input: { cwd: ".." }, details: { exitCode: 0 }, isError: false });
      expect(hook.mock.calls.some(([args]) => Array.isArray(args) && args.includes("status"))).toBe(false);
    } finally { hook.mockRestore(); }
  });

  test("a slow inventory releases the tool result and still publishes later", async () => {
    const env = setup();
    for (const file of ["a.go", "b.go", "c.go"]) writeFileSync(join(env.work, file), "package example\n");
    const hold = Promise.withResolvers<void>();
    const sent = Promise.withResolvers<void>();
    env.control.onNotice = () => { if (noticedPaths(env).length === 3) sent.resolve(); };
    const spawn = Bun.spawn;
    const hook = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);
      if (!Array.isArray(args[0]) || !args[0].includes("status")) return child;
      return new Proxy(child, { get: (target, key) => key === "exited"
        ? hold.promise.then(() => target.exited) : Reflect.get(target, key, target) });
    }) as typeof spawn);
    try {
      const start = performance.now();
      await env.emit("tool_result", { toolName: "bash", input: {}, details: { exitCode: 0 }, isError: false });
      expect(performance.now() - start).toBeLessThan(2_000);
      expect(env.sent).toHaveLength(0);
      hold.resolve();
      await sent.promise;
      expect(env.turnEnd()[0]).toContain("a.go, b.go, c.go");
    } finally {
      hold.resolve();
      hook.mockRestore();
    }
  });

  test("세 번째 파일에서 크기 기준에 닿으면 세 파일을 모두 한 번씩 알리고 턴 끝에도 안내한다", async () => {
    const env = setup();
    const files = ["a.ts", "b.ts", "c.ts"];
    for (const [index, file] of files.entries()) {
      writeFileSync(join(env.work, file), `export const x = ${index};\n`);
      await env.edited("write", file);
      expect(noticedPaths(env)).toHaveLength(index < 2 ? 0 : 3);
    }
    await env.edited("edit", "c.ts");
    expect(noticedPaths(env)).toHaveLength(3);
    const [reminder] = env.turnEnd();
    for (const file of files) {
      expect(noticedPaths(env).filter((path) => path === file)).toHaveLength(1);
      expect(reminder).toContain(file);
    }
    expect(env.sent.every(({ message }) => message.content.includes("size: 3 code files, 3 changed lines"))).toBe(true);
    expect(env.turnEnd()).toEqual([]);
  });

  test("a concurrent review refresh does not discard an edit's pending early notice", async () => {
    const env = setup();
    writeFileSync(join(env.work, "a.ts"), MARKER_CODE);
    await env.edited("write", "a.ts");
    writeFileSync(join(env.work, "b.ts"), "void 1;\n");
    writeFileSync(join(env.work, "c.ts"), "void 2;\n");
    const spawn = Bun.spawn;
    let review: Promise<void> | undefined;
    const hook = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof spawn>) => {
      if (!review && Array.isArray(args[0]) && args[0].includes("status")) {
        review = Promise.resolve();
        review = env.emit("tool_result", { toolName: "cross_review", input: { action: "review" }, isError: false });
      }
      return spawn(...args);
    }) as typeof spawn);
    try {
      await env.edited("write", "c.ts");
      expect(review).toBeDefined();
      await review;
      expect(noticedPaths(env)).toEqual(["a.ts", "b.ts", "c.ts"]);
    } finally { hook.mockRestore(); }
  });

  test("repository notice batches attributes and tracked numstat and needs no file hashing without passes", async () => {
    const env = setup();
    const tracked = join(env.work, "tracked.ts");
    writeFileSync(tracked, "export const x = 0;\n");
    sh(env.work, "add", "tracked.ts");
    sh(env.work, "commit", "-q", "-m", "tracked");
    writeFileSync(tracked, "export const x = 1;\n");
    writeFileSync(join(env.work, "new-a.ts"), "void 0;\n");
    writeFileSync(join(env.work, "new-b.ts"), "void 0;\n");
    writeFileSync(join(env.work, "README.md"), "notes\n".repeat(60));
    const calls: string[][] = [];
    const exec = spawnExec();
    const notice = await earlyReviewNotice(env.work, new Set(["new-b.ts"]), (command, args, options) => {
      calls.push(args);
      return exec(command, args, options);
    }, () => []);
    expect(notice).toHaveLength(3);
    expect(notice.every(({ trigger }) => trigger === "crosses the review threshold (size: 3 code files, 4 changed lines)")).toBe(true);
    for (const arg of ["status", "--numstat", "check-attr"]) expect(calls.filter((args) => args.includes(arg))).toHaveLength(1);
    expect(calls.some((args) => args.includes("hash-object"))).toBe(false);
  });

  test("턴 끝: 한 편집의 첫 파일 알림 전달이 실패해도 같은 편집의 다른 파일을 추적한다", async () => {
    const env = setup();
    writeFileSync(join(env.work, "a.ts"), MARKER_CODE);
    writeFileSync(join(env.work, "b.ts"), MARKER_CODE);
    env.control.failSend = true;
    await env.emit("tool_result", { toolName: "edit", input: { input: "[a.ts#AAAA]\nPUT 1.=1:\n+x\n[b.ts#BBBB]\nPUT 1.=1:\n+y\n" }, isError: false });
    const notice = env.turnEnd();
    expect(notice).toHaveLength(1);
    expect(notice[0]).toContain("a.ts");
    expect(notice[0]).toContain("b.ts");
  });

  test("턴 끝: cross_review가 꺼진 동안의 편집도 추적에 반영하고, 꺼져 있으면 안내하지 않는다", async () => {
    const env = setup();
    writeFileSync(join(env.work, "a.ts"), MARKER_CODE);
    await env.edited("write", "a.ts");
    env.control.reviewTool = false;
    expect(env.turnEnd()).toEqual([]);
    writeFileSync(join(env.work, "a.ts"), "export const x = 1;\n");
    await env.edited("write", "a.ts");
    env.control.reviewTool = true;
    expect(env.turnEnd()).toEqual([]);
  });
});

describe("editedPaths", () => {
  test("write의 path, edit의 path와 [경로#TAG] 머리를 절대 경로로 모은다", () => {
    expect(editedPaths("write", { path: "a.ts" }, "/w")).toEqual(["/w/a.ts"]);
    expect(editedPaths("edit", { input: "[x/b.ts#1A2B]\nPUT 1:\n+x\n[/abs/c.ts#3C4D]\nPUT 1:\n+y\n" }, "/w")).toEqual(["/w/x/b.ts", "/abs/c.ts"]);
    expect(editedPaths("bash", { path: "a.ts" }, "/w")).toEqual([]);
  });
});
