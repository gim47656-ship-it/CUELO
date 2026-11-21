import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveImagesToTemp } from "@oh-my-pi/pi-coding-agent/utils/image-temp";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET } = await jiti.import("./route.ts");

// 1×1 투명 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const SESSION_ID = "tool-image-route-test";

function request(query, headers = {}) {
  return new Request(`http://localhost/api/tool-image?${new URLSearchParams(query)}`, {
    headers: { host: "localhost", ...headers },
  });
}

function toolResult(toolCallId, extra) {
  return { type: "message", id: toolCallId, parentId: null, timestamp: "2026-09-28T00:00:00.000Z", message: { role: "toolResult", toolCallId, ...extra } };
}

async function withSession(t, entries) {
  const previousRegistry = globalThis.__ompSessions;
  globalThis.__ompSessions = new Map([[SESSION_ID, {
    isAlive: () => true,
    inner: { sessionManager: { getEntries: () => entries } },
  }]]);
  t.after(() => {
    globalThis.__ompSessions = previousRegistry;
  });
}

test("serves only the images that session's tool result actually carries", async (t) => {
  const tempFiles = [];
  const tempFile = async (name, bytes) => {
    const file = join(tmpdir(), name);
    await writeFile(file, bytes);
    tempFiles.push(file);
    return file;
  };
  // 도구 결과에 적힌 경로라도 임시 폴더 밖이면 열지 않는다.
  const outsideDir = await mkdtemp(join(process.cwd(), ".tool-image-test-"));
  t.after(async () => {
    await rm(outsideDir, { recursive: true, force: true });
    await Promise.all(tempFiles.map((file) => rm(file, { force: true })));
  });
  const generated = await tempFile(`omp-image-routetest${process.pid}a.png`, PNG);
  const disguised = await tempFile(`omp-image-routetest${process.pid}b.png`, Buffer.from("not an image at all"));
  const svg = await tempFile(`omp-image-routetest${process.pid}c.svg`, Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"));
  const unrelatedName = await tempFile(`routetest-${process.pid}.png`, PNG);
  const outside = join(outsideDir, "omp-image-outside.png");
  await writeFile(outside, PNG);
  const unrelatedImage = Buffer.concat([PNG, Buffer.from("read")]);
  const commandImage = Buffer.concat([PNG, Buffer.from(`command ${process.pid}`)]);
  const secondImage = Buffer.concat([PNG, Buffer.from(`second ${process.pid}`)]);
  const [hashed, secondHashed] = await saveImagesToTemp(
    [commandImage, secondImage].map(bytes => ({ data: bytes.toString("base64"), mimeType: "image/png" })),
  );
  tempFiles.push(hashed, secondHashed);

  await withSession(t, [
    toolResult("read-1", {
      toolName: "read",
      content: [{ type: "text", text: "Read image file [image/png]" }, { type: "image", data: PNG.toString("base64"), mimeType: "image/png" }],
    }),
    toolResult("gen-1", { toolName: "generate_image", content: [{ type: "text", text: `Generated 1 image(s):\n  ${generated}` }], details: { imagePaths: [generated] } }),
    toolResult("gen-xdev", {
      toolName: "write",
      content: [{ type: "text", text: "Generated 5 image(s)" }],
      details: { xdev: { tool: "generate_image", inner: { imagePaths: [generated, disguised, svg, unrelatedName, outside] } } },
    }),
    toolResult("gen-command", {
      toolName: "bash",
      content: [{ type: "image", data: commandImage.toString("base64"), mimeType: "image/png" }],
      details: { toolCommands: [{ tool: "generate_image", mode: "execute", exitCode: 0, inner: { imagePaths: [hashed] } }] },
    }),
    toolResult("gen-attachment", {
      toolName: "generate_image",
      content: [{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }],
      details: { imagePaths: [generated] },
    }),
    toolResult("gen-cmd-blob", {
      toolName: "bash",
      content: [{ type: "image", data: "blob:missing", mimeType: "image/png" }],
      details: { toolCommands: [{ tool: "generate_image", mode: "execute", exitCode: 0, inner: { imagePaths: [generated] } }] },
    }),
    toolResult("gen-cmd-mixed", {
      toolName: "bash",
      content: [
        { type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
        { type: "image", data: "blob:missing", mimeType: "image/png" },
      ],
      details: { toolCommands: [
        { tool: "read", mode: "execute", exitCode: 0 },
        { tool: "generate_image", mode: "execute", exitCode: 0, inner: { imagePaths: [generated] } },
      ] },
    }),
    toolResult("gen-cmd-mixed-partial", {
      toolName: "bash",
      content: [unrelatedImage, unrelatedImage, commandImage].map(bytes =>
        ({ type: "image", data: bytes.toString("base64"), mimeType: "image/png" })),
      details: { toolCommands: [
        { tool: "read", mode: "execute", exitCode: 0 },
        { tool: "generate_image", mode: "execute", exitCode: 0, inner: { imagePaths: [hashed, secondHashed] } },
      ] },
    }),
    toolResult("gen-cmd-mixed-duplicate", {
      toolName: "bash",
      content: [
        { type: "image", data: "blob:missing", mimeType: "image/png" },
        { type: "image", data: commandImage.toString("base64"), mimeType: "image/png" },
      ],
      details: { toolCommands: [
        { tool: "read", mode: "execute", exitCode: 0 },
        { tool: "generate_image", mode: "execute", exitCode: 0, inner: { imagePaths: [hashed] } },
      ] },
    }),
    toolResult("gen-partial", {
      toolName: "generate_image",
      content: [{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }],
      details: { imagePaths: [generated, generated] },
    }),
    // generate_image 가 아닌 도구의 details 에 적힌 경로는 이미지 출처가 아니다.
    toolResult("other", { toolName: "bash", content: [{ type: "text", text: generated }], details: { imagePaths: [generated] } }),
    toolResult("text-image", { toolName: "read", content: [{ type: "image", data: Buffer.from("plain text").toString("base64"), mimeType: "image/png" }] }),
  ]);

  const count = async (toolCallId) => (await (await GET(request({ sessionId: SESSION_ID, toolCallId }))).json()).count;
  assert.equal(await count("read-1"), 1);
  assert.equal(await count("gen-1"), 1);
  assert.equal(await count("gen-xdev"), 5);
  assert.equal(await count("gen-command"), 1);
  assert.equal(await count("gen-attachment"), 1, "an attachment and its saved path count once");
  assert.equal(await count("gen-cmd-blob"), 1);
  assert.equal(await count("gen-cmd-mixed"), 2);
  const mixedFile = await GET(request({ sessionId: SESSION_ID, toolCallId: "gen-cmd-mixed", index: "1" }));
  assert.equal(mixedFile.status, 200);
  assert.deepEqual(Buffer.from(await mixedFile.arrayBuffer()), PNG);
  assert.equal(await count("gen-cmd-mixed-partial"), 4);
  const partial = await GET(request({ sessionId: SESSION_ID, toolCallId: "gen-cmd-mixed-partial", index: "3" }));
  assert.equal(partial.status, 200);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), secondImage);
  assert.equal(await count("gen-cmd-mixed-duplicate"), 1);
  assert.equal(await count("gen-partial"), 2);
  assert.equal(await count("other"), 0);

  for (const toolCallId of ["read-1", "gen-1", "gen-command", "gen-attachment", "gen-cmd-blob"]) {
    const response = await GET(request({ sessionId: SESSION_ID, toolCallId, index: "0" }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), toolCallId === "gen-command" ? commandImage : PNG);
  }

  const status = async (query) => (await GET(request({ sessionId: SESSION_ID, ...query }))).status;
  assert.equal(await status({ toolCallId: "gen-xdev", index: "0" }), 200);
  assert.equal(await status({ toolCallId: "gen-xdev", index: "1" }), 415, "확장자만 그림인 파일은 거부한다");
  assert.equal(await status({ toolCallId: "gen-xdev", index: "2" }), 404, "SVG 는 결과 파일 이름 규칙 밖이다");
  assert.equal(await status({ toolCallId: "gen-xdev", index: "3" }), 404, "generate_image 가 짓지 않은 이름은 열지 않는다");
  assert.equal(await status({ toolCallId: "gen-xdev", index: "4" }), 404, "임시 폴더 밖 경로는 열지 않는다");
  assert.equal(await status({ toolCallId: "gen-xdev", index: "5" }), 404);
  assert.equal(await status({ toolCallId: "text-image", index: "0" }), 415, "이미지 블록이라도 바이트가 그림이 아니면 거부한다");
  assert.equal(await status({ toolCallId: "missing", index: "0" }), 404);
  assert.equal(await status({ toolCallId: "read-1", index: "-1" }), 400);
  assert.equal(await status({ toolCallId: "read-1", index: "../x" }), 400);
  assert.equal((await GET(request({ sessionId: "no-such-session", toolCallId: "read-1" }))).status, 404);
  assert.equal((await GET(request({ sessionId: SESSION_ID }))).status, 400);
  assert.equal(
    (await GET(request({ sessionId: SESSION_ID, toolCallId: "read-1", index: "0" }, { "sec-fetch-site": "cross-site" }))).status,
    403,
  );
});
