import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { extractTurnWrittenFiles } = await jiti.import("./turn-written-files.ts");

function toolCall(toolCallId, toolName, input) {
  return { type: "toolCall", toolCallId, toolName, input };
}

function okResult(toolCallId) {
  return { role: "toolResult", toolCallId, content: [{ type: "text", text: "ok" }] };
}

function errorResult(toolCallId) {
  return { role: "toolResult", toolCallId, content: [{ type: "text", text: "boom" }], isError: true };
}

function results(...entries) {
  return new Map(entries.map((r) => [r.toolCallId, r]));
}

function paths(content, toolResults, cwd) {
  return extractTurnWrittenFiles(content, toolResults, cwd).map((f) => f.filePath);
}

test("extracts a file from a successful write tool call", () => {
  const content = [toolCall("1", "write", { file_path: "/abs/out/report.html" })];
  assert.deepEqual(paths(content, results(okResult("1"))), ["/abs/out/report.html"]);
});

test("extracts a file from a successful edit tool call using input.path", () => {
  const content = [toolCall("1", "edit", { path: "/abs/src/a.ts" })];
  assert.deepEqual(paths(content, results(okResult("1"))), ["/abs/src/a.ts"]);
});

test("reads the written file from the result when a hashline edit carries no path argument", () => {
  const call = toolCall("e1", "edit", { i: "Adding doc map entry", input: "[doc/README.md#6697]\nPUT <14:\n+- line" });
  const result = { ...okResult("e1"), details: { path: "/repo/doc/README.md", op: "update", diff: "" } };
  assert.deepEqual(paths([call], results(result), "/repo"), ["/repo/doc/README.md"]);
});

test("lists every file of a multi-file edit and skips files it deleted", () => {
  const call = toolCall("e2", "edit", { i: "Two files", input: "[a.md#1111]\nCUT 1\n[b.md#2222]\nREM\n[c.md#3333]\nPUT >1:\n+x" });
  const result = {
    ...okResult("e2"),
    details: {
      perFileResults: [
        { path: "/repo/a.md", op: "update" },
        { path: "/repo/b.md", op: "delete" },
        { path: "/repo/c.md", op: "update" },
      ],
    },
  };
  assert.deepEqual(paths([call], results(result), "/repo"), ["/repo/a.md", "/repo/c.md"]);
});

test("skips a file a path-argument edit reports as deleted", () => {
  const call = toolCall("e3", "edit", { path: "/repo/gone.md" });
  const result = { ...okResult("e3"), details: { path: "/repo/gone.md", op: "delete" } };
  assert.deepEqual(paths([call], results(result), "/repo"), []);
});

test("accepts namespaced write/edit tool names from MCP servers", () => {
  const content = [
    toolCall("1", "write_file", { file_path: "/abs/a.txt" }),
    toolCall("2", "fs.edit", { file_path: "/abs/b.txt" }),
    toolCall("3", "str_replace_editor", { file_path: "/abs/c.txt" }),
  ];
  assert.deepEqual(
    paths(content, results(okResult("1"), okResult("2"), okResult("3"))),
    ["/abs/a.txt", "/abs/b.txt", "/abs/c.txt"],
  );
});

test("skips a tool call whose result errored", () => {
  const content = [toolCall("1", "write", { file_path: "/abs/out/report.html" })];
  assert.deepEqual(paths(content, results(errorResult("1"))), []);
});

test("skips a tool call whose result has not arrived (streaming)", () => {
  const content = [toolCall("1", "write", { file_path: "/abs/out/report.html" })];
  assert.deepEqual(paths(content, results()), []);
  assert.deepEqual(paths(content, undefined), []);
});

test("deduplicates the same file written then edited", () => {
  const content = [
    toolCall("1", "write", { file_path: "/abs/out/report.html" }),
    toolCall("2", "edit", { path: "/abs/out/report.html" }),
  ];
  assert.deepEqual(paths(content, results(okResult("1"), okResult("2"))), ["/abs/out/report.html"]);
});

test("resolves a relative path against cwd", () => {
  const content = [toolCall("1", "write", { file_path: "out/report.html" })];
  assert.deepEqual(paths(content, results(okResult("1")), "/abs"), ["/abs/out/report.html"]);
});

test("resolves extensionless and dot-prefixed filenames against cwd", () => {
  const content = [
    toolCall("1", "write", { path: "LICENSE" }),
    toolCall("2", "write", { path: ".env" }),
  ];
  assert.deepEqual(
    paths(content, results(okResult("1"), okResult("2")), "/repo"),
    ["/repo/LICENSE", "/repo/.env"],
  );
});

test("preserves path characters that have special meaning in hrefs", () => {
  const content = [
    toolCall("1", "write", { path: "release#1.md" }),
    toolCall("2", "write", { path: "query?.json" }),
    toolCall("3", "write", { path: "report.md:42" }),
  ];
  assert.deepEqual(
    paths(content, results(okResult("1"), okResult("2"), okResult("3")), "/repo"),
    ["/repo/release#1.md", "/repo/query?.json", "/repo/report.md:42"],
  );
});

test("normalizes Windows-relative tool paths against a Windows cwd", () => {
  const content = [toolCall("1", "write", { path: "src\\report.html" })];
  assert.deepEqual(
    paths(content, results(okResult("1")), "C:\\repo"),
    ["C:/repo/src/report.html"],
  );
});

test("skips non-writing tools like read and bash", () => {
  const content = [
    toolCall("1", "read", { file_path: "/abs/a.ts" }),
    toolCall("2", "bash", { command: "echo hi > /abs/a.txt" }),
  ];
  assert.deepEqual(paths(content, results(okResult("1"), okResult("2"))), []);
});

test("ignores paths that only appear in the reply text", () => {
  // A path the assistant merely writes in prose is not evidence of a write.
  const content = [
    { type: "text", text: "I saved the report to /abs/out/report.html for you." },
  ];
  assert.deepEqual(paths(content, results()), []);
});

test("lists only the file actually written, not others named in the text", () => {
  const content = [
    toolCall("1", "write", { file_path: "/abs/out/real.html" }),
    { type: "text", text: "See also /abs/out/imagined.html and /etc/passwd" },
  ];
  assert.deepEqual(paths(content, results(okResult("1"))), ["/abs/out/real.html"]);
});

test("skips a write call missing both file_path and path", () => {
  const content = [toolCall("1", "write", { content: "hi" })];
  assert.deepEqual(paths(content, results(okResult("1"))), []);
});

test("returns an empty array for an empty or text-only turn", () => {
  assert.deepEqual(paths([], results()), []);
  assert.deepEqual(paths([{ type: "text", text: "hi" }], results()), []);
});

test("skips internal device URIs recorded as write paths", () => {
  // `write xd://recall` invokes a device, not a file — the resolved path would
  // not exist and the Files panel would open a "Not found" tab.
  const content = [
    toolCall("1", "write", { path: "xd://recall" }),
    toolCall("2", "edit", { path: "artifact://abc123" }),
  ];
  assert.deepEqual(paths(content, results(okResult("1"), okResult("2")), "/repo"), []);
});

test("keeps Windows drive-absolute paths that look like a scheme", () => {
  // `C://…`는 scheme:// 패턴과 겹치지만 기존 resolve가 정규화하던 드라이브 절대경로다.
  const content = [toolCall("1", "write", { path: "C://out//report.html" })];
  assert.deepEqual(
    paths(content, results(okResult("1")), "C:\\repo"),
    ["C:/out/report.html"],
  );
});

test("scratch writes under .omp or the OS temp folder are not changed files, but omp configuration is", () => {
  const writes = [
    ["repo-scratch", ".omp/x.sh"],
    ["tmp", "/tmp/probe.ts"],
    ["user-skill", "/home/user/.omp/agent/skills/s/SKILL.md"],
    ["project-rule", ".omp/rules/r.md"],
    ["wsl-temp", "/mnt/c/Users/user/AppData/Local/Temp/x"],
    ["home-scratch", "/home/user/.omp/scratch/cache.json"],
    ["real", "src/a.ts"],
    // An isolated HOME kept in the repo's scratch folder: the first .omp segment decides, not the agent dir inside it.
    ["fixture-home", ".omp/verify/isolated-home/.omp/agent/sessions/s.jsonl"],
    ["profile-rule", "/home/user/.omp/profiles/work/agent/rules/p.md"],
  ];
  const content = writes.map(([id, path]) => toolCall(id, "write", { path }));
  assert.deepEqual(paths(content, results(...writes.map(([id]) => okResult(id))), "/repo"), [
    "/home/user/.omp/agent/skills/s/SKILL.md",
    "/repo/.omp/rules/r.md",
    "/repo/src/a.ts",
    "/home/user/.omp/profiles/work/agent/rules/p.md",
  ]);
  // A hashline edit names its file only in the result.
  const hashline = toolCall("h", "edit", { input: "[.omp/probe.ts#1A2B]\nPUT >1:\n+x" });
  assert.deepEqual(paths([hashline], results({ ...okResult("h"), details: { path: "/repo/.omp/probe.ts", op: "update" } }), "/repo"), []);
});

test("Windows scratch folders are scratch while a project folder that happens to be called Temp is not", () => {
  const writes = [
    ["named-temp", "D:\\work\\Temp\\proj\\a.cs"],
    ["user-temp", "C:\\Users\\user\\AppData\\Local\\Temp\\b.txt"],
    ["user-omp", "C:\\Users\\user\\.omp\\cdrive-size.ps1"],
    ["project-system", ".omp\\SYSTEM.md"],
  ];
  const content = writes.map(([id, path]) => toolCall(id, "write", { path }));
  assert.deepEqual(paths(content, results(...writes.map(([id]) => okResult(id))), "C:\\repo"), [
    "D:/work/Temp/proj/a.cs",
    "C:/repo/.omp/SYSTEM.md",
  ]);
});

test("a session working inside a temp or .omp folder keeps its own files", () => {
  const inTemp = [toolCall("a", "write", { path: "a.ts" }), toolCall("b", "write", { path: ".omp/x.sh" }), toolCall("c", "write", { path: "/tmp/other/b.ts" })];
  assert.deepEqual(paths(inTemp, results(okResult("a"), okResult("b"), okResult("c")), "/tmp/work"), ["/tmp/work/a.ts"]);
  const inProfile = [toolCall("r", "write", { path: "rules/x.md" })];
  assert.deepEqual(paths(inProfile, results(okResult("r")), "/home/user/.omp/agent"), ["/home/user/.omp/agent/rules/x.md"]);
  // Agent-managed worktrees (task isolation, PR checkouts) live under ~/.omp/wt and are real work.
  const isolated = [toolCall("w", "write", { path: "/home/user/.omp/wt/iso-1a2b3c4d5/m/src/a.ts" })];
  assert.deepEqual(paths(isolated, results(okResult("w")), "/repo"), ["/home/user/.omp/wt/iso-1a2b3c4d5/m/src/a.ts"]);
});
