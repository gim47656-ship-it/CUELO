// 편집 직후 조기 알림: marker에 맞는 게이트 대상 코드 파일은 git_finalize 전에 cross_review가 필요하다고 파일당 세션에 한 번만 알린다(게이트 아님).
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import crossReview, { editedPaths } from "../cross-review";

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
  const control = { failSend: false };
  const handlers: Record<string, Handler[]> = {};
  const sent: { message: { customType: string; content: string; display: boolean }; options: unknown }[] = [];
  const ctx = { cwd: work, agent: { kind: "main" }, sessionManager: { getSessionId: () => "s1" } };
  crossReview({
    zod: { object: () => ({}), string: () => ({ optional: () => ({}) }), array: () => ({ optional: () => ({}) }), boolean: () => ({ optional: () => ({}) }), number: () => ({}) },
    registerTool: () => {},
    on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); },
    sendMessage: (message: never, options: unknown) => { if (control.failSend) throw new Error("delivery failed"); sent.push({ message, options }); },
    getActiveTools: () => ["edit", "write", "cross_review"],
  } as unknown as ExtensionAPI);
  const emit = async (name: string, event: Record<string, unknown>) => { for (const handler of handlers[name] ?? []) await handler(event, ctx); };
  const edited = (toolName: string, path: string, isError = false) => emit("tool_result", { toolName, input: { path }, isError });
  return { work, ledger, sent, emit, edited, control };
}

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
    expect(env.sent[0]!.message.content).not.toContain("sampled");
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

  test("지금 내용을 덮는 통과한 검토가 이미 있으면 알리지 않는다", async () => {
    const env = setup();
    writeFileSync(join(env.work, "a.ts"), MARKER_CODE);
    writeFileSync(env.ledger, `${JSON.stringify({ type: "cross-review-resolve", reviewId: "xr-1", pass: true, files: [{ path: "a.ts", blob: blobOf(MARKER_CODE) }] })}\n`);
    await env.edited("write", "a.ts");
    expect(env.sent).toEqual([]);
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
});

describe("editedPaths", () => {
  test("write의 path, edit의 path와 [경로#TAG] 머리를 절대 경로로 모은다", () => {
    expect(editedPaths("write", { path: "a.ts" }, "/w")).toEqual(["/w/a.ts"]);
    expect(editedPaths("edit", { input: "[x/b.ts#1A2B]\nPUT 1:\n+x\n[/abs/c.ts#3C4D]\nPUT 1:\n+y\n" }, "/w")).toEqual(["/w/x/b.ts", "/abs/c.ts"]);
    expect(editedPaths("bash", { path: "a.ts" }, "/w")).toEqual([]);
  });
});
