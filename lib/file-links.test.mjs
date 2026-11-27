import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./file-links.ts");
}

test("resolves absolute markdown file links and strips line suffixes", async () => {
  const { resolveLocalFileHref } = await loadSubject();

  assert.equal(
    resolveLocalFileHref(
      "/home/me/project/components/MarkdownBody.tsx:36",
      "/home/me/project",
    ),
    "/home/me/project/components/MarkdownBody.tsx",
  );
});

test("resolves absolute file links outside cwd", async () => {
  const { resolveLocalFileHref } = await loadSubject();

  assert.equal(
    resolveLocalFileHref(
      "/home/me/.codex/config.toml:12",
      "/home/me/project",
    ),
    "/home/me/.codex/config.toml",
  );
});

test("resolves relative markdown file links against cwd", async () => {
  const { resolveLocalFileHref } = await loadSubject();

  assert.equal(
    resolveLocalFileHref("components/AppShell.tsx#L42", "/home/me/project"),
    "/home/me/project/components/AppShell.tsx",
  );
});

test("does not let relative links escape cwd", async () => {
  const { resolveLocalFileHref } = await loadSubject();

  assert.equal(
    resolveLocalFileHref("../outside.md", "/home/me/project"),
    null,
  );
});

test("resolves preview links from the file directory within the project root", async () => {
  const { resolveLocalFileHref } = await loadSubject();

  assert.equal(
    resolveLocalFileHref("../file.js", "/home/me/project/docs/nested", "/home/me/project"),
    "/home/me/project/docs/file.js",
  );
  assert.equal(
    resolveLocalFileHref("../../../outside.js", "/home/me/project/docs/nested", "/home/me/project"),
    null,
  );
});

test("does not treat app or external URLs as file links", async () => {
  const { resolveLocalFileHref } = await loadSubject();

  assert.equal(resolveLocalFileHref("/api/files/home/me/project/a.ts", "/home/me/project"), null);
  assert.equal(resolveLocalFileHref("https://example.com/a.ts", "/home/me/project"), null);
  assert.equal(resolveLocalFileHref("ftp://example.com/a.ts", "/home/me/project"), null);
  assert.equal(resolveLocalFileHref("//example.com/a.ts", "/home/me/project"), null);
});

test("resolves Windows file URLs without a synthetic leading slash", async () => {
  const { resolveLocalFileHref } = await loadSubject();

  assert.equal(
    resolveLocalFileHref("file:///C:/Users/me/project/file.txt:10", "C:/Users/me/project"),
    "C:/Users/me/project/file.txt",
  );
});

test("resolves UNC file URLs and backslash UNC paths", async () => {
  const { resolveLocalFileHref } = await loadSubject();

  assert.equal(
    resolveLocalFileHref("file://server/share/project/file.txt", "/home/me/project"),
    "//server/share/project/file.txt",
  );
  assert.equal(
    resolveLocalFileHref("\\\\server\\share\\project\\file.txt", "/home/me/project"),
    "//server/share/project/file.txt",
  );
});

test("resolves source locations without treating their suffix as part of the path", async () => {
  const { resolveLocalFileLink } = await loadSubject();
  const cwd = "/home/me/project";
  for (const [href, startLine, endLine] of [
    ["file.ts:10-25", 10, 25],
    ["file.ts#L10-L25", 10, 25],
    ["file.ts#L25-10", 10, 25],
    ["file.ts:25-10", 10, 25],
    ["file.ts?view=source#L10-L25", 10, 25],
    ["file.ts:10-25?view=source", 10, 25],
    ["file.ts#L10", 10, 10],
    ["file.ts:10", 10, 10],
    ["file.ts:10:5", 10, 10],
  ]) {
    assert.deepEqual(resolveLocalFileLink(href, cwd), {
      filePath: `${cwd}/file.ts`,
      lines: { startLine, endLine },
    }, href);
  }
  for (const href of ["file.ts", "file.ts#heading", "file.ts?line=:10", "file.ts#L0", "file.ts:-1", "file.ts:10-0", "file.ts#L9007199254740992"]) {
    assert.deepEqual(resolveLocalFileLink(href, cwd), { filePath: `${cwd}/file.ts` }, href);
  }
});

test("source locations still respect the relative root and external URL guards", async () => {
  const { resolveLocalFileLink } = await loadSubject();
  const cwd = "/home/me/project";
  assert.deepEqual(resolveLocalFileLink("C:/x/y.ts:10", cwd), {
    filePath: "C:/x/y.ts",
    lines: { startLine: 10, endLine: 10 },
  });
  assert.deepEqual(resolveLocalFileLink("../file.js#L7", `${cwd}/docs`, cwd), {
    filePath: `${cwd}/file.js`,
    lines: { startLine: 7, endLine: 7 },
  });
  for (const href of ["../outside.md:10-25", "%2e%2e/outside.md#L10", "https://example.com/file.ts#L10", "scheme:123", "javascript:1", "mailto:123", "/api/files/x.ts#L10"]) {
    assert.equal(resolveLocalFileLink(href, cwd), null, href);
  }
});
