import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTurnDocuments } from "../lib/turn-documents";

const roots: string[] = [];
function fixture(git = true) {
  const root = mkdtempSync(join(tmpdir(), "turn-docs-unit-")); roots.push(root);
  if (git) mkdirSync(join(root, ".git"));
  const put = (path: string) => { const abs = join(root, path); mkdirSync(join(abs, ".."), { recursive: true }); writeFileSync(abs, "content\n"); return abs; };
  const docs = createTurnDocuments();
  const observe = (toolName: string, path: string, details: unknown = undefined, isError = false) => docs.observe({ toolName, input: { path }, details, isError }, root);
  return { root, put, docs, observe };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("turn documentation evidence", () => {
  test("old documents are not evidence of this work; reads review shared docs, only a record write records work", () => {
    const f = fixture();
    for (const path of ["HANDOFF.md", "doc/README.md", "doc/history/2026/11/03-work/main.md", "index.ts"]) f.put(path);
    f.observe("write", "index.ts");
    expect(f.docs.note(f.root)).toContain("미관측");
    f.observe("read", "HANDOFF.md:1-3"); f.observe("read", "doc/README.md:raw"); f.observe("read", "doc/history/2026/11/03-work/main.md");
    expect(f.docs.note(f.root)).toContain("작업 기록 쓰기");
    f.observe("write", "doc/history/2026/11/03-work/main.md");
    expect(f.docs.note(f.root)).toBeUndefined();
  });
  test("multi-read counts successful resolved links but not failed listed targets", () => {
    const f = fixture();
    for (const path of ["HANDOFF.md", "doc/README.md", "doc/history/2026/11/03-work/main.md", "index.ts"]) f.put(path);
    f.observe("write", "index.ts");
    f.observe("write", "doc/history/2026/11/03-work/main.md");
    f.observe("read", "HANDOFF.md;doc/README.md", {
      displayReadTargets: ["HANDOFF.md", "doc/README.md"],
      displayReadTargetLinks: [join(f.root, "HANDOFF.md"), null],
    });
    expect(f.docs.note(f.root)).toContain("doc/README.md 읽기/쓰기");
    f.observe("read", "HANDOFF.md;doc/README.md", {
      displayReadTargets: ["HANDOFF.md", "doc/README.md"],
      displayReadTargetLinks: [join(f.root, "HANDOFF.md"), join(f.root, "doc/README.md")],
    });
    expect(f.docs.note(f.root)).toBeUndefined();
  });
  test("documents created after source edits remove missing and unobserved claims", () => {
    const f = fixture(false); f.put("index.ts"); f.observe("write", "index.ts");
    expect(f.docs.note(f.root)).toContain("없거나 확인 불가");
    for (const path of ["HANDOFF.md", "doc/README.md", "doc/history/2026/11/03-work/maker-A.md"]) { f.put(path); f.observe("write", path); }
    expect(f.docs.note(f.root)).toBeUndefined();
  });
  test("draft credits authoritative saved metadata, never unsaved or failed results", () => {
    const f = fixture(); f.put("index.ts"); f.observe("write", "index.ts");
    for (const output of ["HANDOFF.md", "doc/README.md", "doc/history/2026/11/03-draft/maker-A.md"]) {
      const path = f.put(output);
      f.docs.observe({ toolName: "draft", input: { output }, details: { savedPath: path }, isError: false }, f.root);
    }
    expect(f.docs.note(f.root)).toBeUndefined();
    f.docs.reset(); f.observe("write", "index.ts");
    for (const output of ["HANDOFF.md", "doc/README.md", "doc/history/2026/11/03-draft/maker-A.md"]) {
      const event = { toolName: "draft", toolCallId: output, input: { output }, isError: false };
      f.docs.observe(event, f.root);
    }
    expect(f.docs.note(f.root)).toContain("작업 기록 쓰기");
    const failed = { toolName: "draft", toolCallId: "failed", input: { output: "doc/history/2026/11/03-draft/maker-A.md" }, isError: true };
    f.put(failed.input.output); f.docs.observe({ ...failed, details: { savedPath: join(f.root, failed.input.output) } }, f.root);
    expect(f.docs.note(f.root)).toContain("작업 기록 쓰기");
  });
  test.each(["vendor/maintained.ts", ".omp/settings.json", ".env.local"])("explicit mutation of maintained source/config %s still needs documentation", (path) => {
    const f = fixture(); f.put(path); f.observe("write", path);
    expect(f.docs.note(f.root)).toContain("HANDOFF.md");
  });
  test("read-only, doc-only, failed, URI, arbitrary code and assets do not count as source mutations", () => {
    const f = fixture();
    for (const path of ["index.ts", "doc/data.json", "report.pdf", "image.png"]) f.put(path);
    f.observe("read", "index.ts"); f.observe("write", "HANDOFF.md"); f.observe("write", "index.ts", undefined, true);
    f.observe("write", "xd://edit", { resolvedPath: join(f.root, "index.ts") });
    f.observe("write", "agent://Main"); f.observe("write", "local://file.ts");
    f.observe("write", "report.pdf"); f.observe("write", "doc/data.json"); f.observe("write", "image.png");
    f.docs.observe({ toolName: "bash", input: { command: "touch index.ts" }, isError: false }, f.root);
    f.docs.observe({ toolName: "eval", input: { code: "write('index.ts', 'x')" }, isError: false }, f.root);
    expect(f.docs.note(f.root)).toBeUndefined();
  });
  test("actual resolved write/edit metadata supersedes requested names and handles multi-file rename/delete", () => {
    const f = fixture(); f.put("actual.ts");
    f.observe("write", "requested.md", { resolvedPath: join(f.root, "actual.ts") });
    expect(f.docs.note(f.root)).toContain("HANDOFF.md"); f.docs.reset();
    f.docs.observe({ toolName: "edit", input: { input: "[requested.md#ABCD]\nPUT 1.=1:\n+x" }, details: { perFileResults: [{ path: "actual.ts", sourcePath: "old.ts", move: "actual.ts", op: "update" }, { path: "gone.ts", op: "delete" }] }, isError: false }, f.root);
    expect(f.docs.note(f.root)).toContain("HANDOFF.md");
  });
  test("successful edit headers and file URIs are local; reset discards evidence", () => {
    const f = fixture(); f.put("index.ts");
    f.docs.observe({ toolName: "edit", input: { input: "*** Begin Patch\n[index.ts#ABCD]\nPUT 1.=1:\n+x\n*** End Patch" }, isError: false }, f.root);
    expect(f.docs.note(f.root)).toContain("HANDOFF.md"); f.docs.reset();
    f.observe("write", new URL(`file://${f.root}/index.ts`).href);
    expect(f.docs.note(f.root)).toContain("HANDOFF.md"); f.docs.reset();
    expect(f.docs.note(f.root)).toBeUndefined();
  });
  test("nearest HANDOFF owns its docs, not an unrelated sibling or nested repository", () => {
    const f = fixture();
    f.put("a/HANDOFF.md"); f.put("b/HANDOFF.md"); f.put("a/index.ts");
    f.observe("write", "a/index.ts");
    for (const path of ["b/HANDOFF.md", "b/doc/README.md", "b/doc/history/2026/11/03-work/main.md"]) { f.put(path); f.observe("write", path); }
    expect(f.docs.note(f.root)).toContain("a");
    expect(f.docs.note(f.root)).not.toContain("`b`");
    f.docs.reset(); mkdirSync(join(f.root, "other/.git"), { recursive: true }); f.put("other/index.ts"); f.observe("write", "other/index.ts");
    expect(f.docs.note(f.root)).toBeUndefined();
  });
  test("outside paths and symlink escapes are not attributed to cwd", () => {
    const f = fixture(), other = fixture(); const outside = other.put("index.ts");
    f.observe("write", outside); symlinkSync(other.root, join(f.root, "alias")); f.observe("write", "alias/index.ts");
    expect(f.docs.note(f.root)).toBeUndefined();
  });
});
