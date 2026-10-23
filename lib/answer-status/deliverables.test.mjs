import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { pickDeliverables } = await jiti.import("./deliverables.ts");

const files = (...paths) => paths.map((filePath) => ({ filePath }));

test("keeps only rendered outputs and puts a page first, then documents, then images", () => {
  const picked = pickDeliverables(files(
    "/w/app/page.tsx",
    "/w/out/cover.png",
    "/w/out/report.pdf",
    "/w/config.yml",
    "/w/HANDOFF.md",
    "/w/out/index.html",
    "/w/out/brief.docx",
    "/w/out/site.htm",
  ));
  assert.deepEqual(picked, [
    { filePath: "/w/out/index.html", kind: "html" },
    { filePath: "/w/out/site.htm", kind: "html" },
    { filePath: "/w/out/report.pdf", kind: "document" },
    { filePath: "/w/out/brief.docx", kind: "document" },
    { filePath: "/w/out/cover.png", kind: "image" },
  ]);
});

test("leaves out tests, fixtures, work records and build output", () => {
  assert.deepEqual(pickDeliverables(files(
    "/w/tests/fixture.html",
    "/w/src/__tests__/shot.png",
    "/w/e2e/fixtures/page.html",
    "/w/doc/history/2026/10/23-x/evidence/desktop.png",
    "C:\\w\\node_modules\\pkg\\index.html",
    "/w/.next-verify/server/app/index.html",
    "/w/coverage/index.html",
  )), []);
});

test("process folders are left out whatever their letter case or path separator", () => {
  assert.deepEqual(pickDeliverables(files(
    "/w/Tests/page.html",
    "C:\\w\\Doc\\History\\2026\\evidence\\shot.png",
    "C:\\w\\Node_Modules\\pkg\\index.html",
    "/w/.Next/server/app/index.html",
    "/w/src/__Fixtures__/card.png",
  )), []);
});

test("a turn that wrote only source or Markdown has no deliverable", () => {
  assert.deepEqual(pickDeliverables(files("/w/lib/a.ts", "/w/README.md", "/w/notes.txt")), []);
});

test("a folder merely named like a process folder inside a name does not exclude", () => {
  assert.deepEqual(pickDeliverables(files("/w/latest/index.html", "/w/contest/poster.webp")), [
    { filePath: "/w/latest/index.html", kind: "html" },
    { filePath: "/w/contest/poster.webp", kind: "image" },
  ]);
});
