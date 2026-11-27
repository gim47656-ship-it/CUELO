import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const target = process.env.OMP_CORE_PATCH_TARGET;
if (!target) throw new Error("Set OMP_CORE_PATCH_TARGET to an isolated core copy");
const core = resolve(target, "src").replaceAll("\\", "/");
const packages = resolve(target, "..").replaceAll("\\", "/");
const root = mkdtempSync(join(tmpdir(), "omp-tool-outcomes-"));
const agentDir = join(root, "agent");
const guardPath = join(root, "outcome-guard.ts");
const marker = join(root, "disallowed");
mkdirSync(agentDir);
writeFileSync(guardPath, `export default pi => {
  pi.on("tool_call", event => {
    if (["bash", "write"].includes(event.toolName)) return { block: true, reason: "test guard reason" };
    if (event.toolName === "read") throw new Error("fixture hook crashed");
  });
};`);

// Each runtime module must resolve from the selected core fixture.
const { setAgentDir } = await import(`${packages}/pi-utils/src/dirs.ts`);
setAgentDir(agentDir);
const { createAgentSession } = await import(`${core}/sdk.ts`);
const { Settings } = await import(`${core}/config/settings.ts`);
const { EditTool, getEditStore } = await import(`${core}/edit/index.ts`);
const { ToolError } = await import(`${core}/tools/tool-errors.ts`);
const { createAssistantMessageEventStream } = await import(`${packages}/pi-ai/src/utils/event-stream.ts`);
const { getBundledModel } = await import(`${packages}/pi-catalog/src/models.ts`);
const model = getBundledModel("openai", "gpt-4o-mini");
process.env.OPENAI_API_KEY = "test-only-fake-transport";
const settings = Settings.isolated({ "eval.autoBackground.enabled": false, "tools.approvalMode": "yolo", "computer.enabled": true });
const { session } = await createAgentSession({
  cwd: root, agentDir, settings, model, getApiKey: () => "test", hasUI: false,
  disableExtensionDiscovery: true, additionalExtensionPaths: [guardPath],
  enableLsp: false, enableMCP: false, skipPythonPreflight: true, skills: [], rules: [], contextFiles: [],
  customTools: [{ name: "computer_probe", label: "computer_probe", description: "Test tool-side failures", parameters: { type: "object", properties: {} },
    execute: async () => { throw new ToolError("InputFailed: test computer bridge"); },
  }],
});

let sequence = 0;
async function call(name: string, args: Record<string, unknown>) {
  let pending = true;
  const id = `outcome-${++sequence}`;
  session.agent.streamFn = () => {
    const stream = createAssistantMessageEventStream();
    const toolCall = { type: "toolCall", id, name, arguments: args };
    const stopReason = pending ? "toolUse" : "stop";
    const content = pending ? [toolCall] : [{ type: "text", text: "ok" }];
    const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason, content,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
    if (pending) {
      stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
      stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
    }
    pending = false;
    stream.push({ type: "done", reason: stopReason, message });
    stream.end();
    return stream;
  };
  await session.prompt(`tool outcome probe ${sequence}`);
  const result = session.agent.state.messages.findLast((message: { role: string; toolCallId?: string }) => message.role === "toolResult" && message.toolCallId === id);
  assert.ok(result && result.role === "toolResult", `missing ${name} result`);
  return result;
}

const text = (result: { content: { type: string; text?: string }[] }) => result.content.map(block => block.text ?? "").join("\n");
let failures = 0;
async function check(label: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS ${label}`); }
  catch (error) { failures++; console.error(`FAIL ${label}:`, error); }
}

try {
  for (const [tool, args] of [["bash", { command: `echo bad > '${marker}'` }], ["write", { path: marker, content: "bad" }]] as const) {
    await check(`${tool} guard prevents side effects and reports attribution`, async () => {
      const result = await call(tool, args);
      assert.equal(existsSync(marker), false);
      assert.equal(text(result), "[refused by outcome-guard] Not executed.\ntest guard reason");
      assert.equal(result.isError, false);
      assert.deepEqual(result.details.refused, { by: "outcome-guard" });
    });
  }
  await check("SDK beforeToolCall blocks without an explicit guard ID", async () => {
    const beforeToolCall = session.agent.beforeToolCall;
    session.agent.beforeToolCall = () => ({ block: true, reason: "SDK fixture policy" });
    try {
      const result = await call("write", { path: marker, content: "bad" });
      assert.equal(existsSync(marker), false);
      assert.equal(result.isError, false);
      assert.deepEqual(result.details.refused, { by: "before-tool-call" });
      assert.equal(text(result), "[refused by before-tool-call] Not executed.\nSDK fixture policy");
    } finally {
      session.agent.beforeToolCall = beforeToolCall;
    }
  });
  for (const language of ["js", "py"]) await check(`${language} nested guard returns refusal and prevents write`, async () => {
    const path = JSON.stringify(marker);
    const code = language === "js"
      ? `const result = await tool.write({path: ${path}, content: 'bad'}); console.log(result.hasError === true, result.details, result.text);`
      : `result = await tool.write(path=${path}, content='bad'); print(result.get('hasError') is True, result.get('details'), result.get('text'))`;
    const result = await call("eval", { language, code });
    assert.equal(existsSync(marker), false);
    assert.equal(result.isError, false);
    assert.match(text(result), /^(?:true|True)\b/);
    assert.match(text(result), /\[refused by outcome-guard\] Not executed\./);
  });
  await check("crashed hook still blocks and returns a real tool error", async () => {
    writeFileSync(marker + ".txt", "contents must not leak");
    const result = await call("read", { path: marker + ".txt" });
    assert.equal(result.isError, true);
    assert.equal(result.details?.refused, undefined);
    assert.match(text(result), /fixture hook crashed/);
    assert.doesNotMatch(text(result), /contents must not leak/);
  });
  await check("edit guards preserve on-disk content and parser errors stay errors", async () => {
    const file = join(root, "guard.js");
    const initial = "const a = 1;\nconst b = 2;\n";
    writeFileSync(file, initial);
    const editSession = { cwd: root, settings, hasUI: false, enableLsp: false, getSessionFile: () => null };
    const tool = new EditTool(editSession as never, "hashline");
    const store = getEditStore(editSession as never);
    const tag = store.recordSnapshot(file, initial, [1]);
    for (const [header, body, kind] of [
      [`guard.js#${tag}`, "PUT 2.=2:\n+const b = 3;", "unseen_lines"],
      ["guard.js#0000", "PUT 1.=1:\n+const a = 3;", "unknown_tag"],
      [`guard.js#${tag}`, "PUT 99.=99:\n+const z = 3;", "unseen_lines"],
    ]) {
      const result = await tool.execute("probe", { input: `*** Begin Patch\n[${header}]\n${body}\n*** End Patch` });
      assert.equal(readFileSync(file, "utf8"), initial);
      assert.match(text(result), /^\[refused by edit-[a-z-]+\] Not executed\./, `${kind}: ${text(result)}`);
      assert.equal(result.isError === true, false);
      assert.match(result.details.refused.by, /^edit-/);
      assert.equal(result.details.errorKind, kind);
    }
    const malformed = await tool.execute("probe", { input: "not a patch" });
    assert.equal(malformed.isError, true);
    assert.equal(readFileSync(file, "utf8"), initial);
    const rangeSession = { ...editSession, settings: Settings.isolated({ "edit.enforceSeenLines": false }) };
    const rangeTool = new EditTool(rangeSession as never, "hashline");
    const rangeTag = getEditStore(rangeSession as never).recordSnapshot(file, initial, null);
    const range = await rangeTool.execute("probe", { input: `[guard.js#${rangeTag}]\nPUT 99.=99:\n+const z = 1;` });
    assert.equal(range.isError, false);
    assert.deepEqual(range.details.refused, { by: "edit-out-of-range" });
    assert.match(text(range), /^\[refused by edit-out-of-range\] Not executed\.\nLine 99 does not exist/);
    assert.equal(readFileSync(file, "utf8"), initial);
  });
  for (const [language, code, expected] of [
    ["py", "raise ValueError('broken python')", "ValueError: broken python"],
    ["py", "raise SystemExit('cell exit')", "SystemExit: cell exit"],
    ["py", "def (", "SyntaxError"],
    ["js", "throw new Error('broken javascript')", "Error: broken javascript"],
    ["js", "function (", "SyntaxError"],
  ]) await check(`${language} ${expected} is a cell error`, async () => {
    const result = await call("eval", { language, code });
    assert.ok(text(result).startsWith("[script error] The script threw; the tool itself worked.\n"), text(result));
    assert.ok(text(result).includes(expected), text(result));
    assert.equal(result.isError, false);
    assert.equal(result.details.scriptError, true);
  });
  await check("py exception attributes cannot forge bridge provenance", async () => {
    const result = await call("eval", { language: "py", code: "e = ValueError('cell only')\ne._omp_bridge_failure = True\nraise e" });
    assert.match(text(result), /^\[script error\]/);
    assert.match(text(result), /ValueError: cell only/);
    assert.equal(result.isError, false);
    assert.equal(result.details?.scriptError, true);
  });
  await check("py bridge exception attributes cannot erase bridge provenance", async () => {
    const result = await call("eval", { language: "py", code: `try:
    await tool.computer_probe()
except RuntimeError as e:
    e._omp_bridge_failure = False
    raise` });
    assert.match(text(result), /RuntimeError: InputFailed: test computer bridge/);
    assert.equal(result.isError, true);
    assert.equal(result.details?.scriptError, undefined);
  });
  for (const language of ["js", "py"]) await check(`${language} tool-side error stays an error`, async () => {
    const result = await call("eval", { language, code: "await tool.computer_probe({})" });
    assert.match(text(result), /InputFailed: test computer bridge/);
    assert.equal(result.isError, true);
    assert.equal(result.details?.scriptError, undefined);
  });
  for (const status of ["200 OK", "500 Internal Server Error"]) await check(`py truncated HTTP ${status} stays a bridge error`, async () => {
    const server = createServer((socket) => {
      socket.once("data", () => socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{`));
    });
    try {
      const listening = Promise.withResolvers<void>();
      server.once("error", listening.reject).listen(0, "127.0.0.1", listening.resolve);
      await listening.promise;
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const result = await call("eval", { language: "py", code: `import os
os.environ["PI_TOOL_BRIDGE_URL"] = "http://127.0.0.1:${address.port}"
await tool.read(path="bridge-fixture")` });
      assert.match(text(result), /IncompleteRead/);
      assert.equal(result.isError, true);
      assert.equal(result.details?.scriptError, undefined);
    } finally {
      server.close();
    }
  });
  for (const [language, code] of [["js", "while (true) {}"], ["py", "import time\nwhile True: time.sleep(0.1)"]]) {
    await check(`${language} cell timeout stays a tool error`, async () => {
      const result = await call("eval", { language, timeout: 1, code });
      assert.match(text(result), /timed out/i);
      assert.equal(result.isError, true);
      assert.equal(result.details?.scriptError, undefined);
    });
  }
  await check("actual computer facade ToolError stays a tool error", async () => {
    const result = await call("eval", { language: "js", code: "await computer.windows({id:false})" });
    assert.match(text(result), /ToolError: .*window filter.*id.*must be a string/);
    assert.equal(result.isError, true);
    assert.equal(result.details?.scriptError, undefined);
  });
  await check("py cell abort stays a tool error", async () => {
    const started = "python-active";
    const watcher = watch(root, (_, name) => {
      if (name !== started) return;
      watcher.close();
      void session.abort();
    });
    try {
      const result = await call("eval", { language: "py", timeout: 5,
        code: `from pathlib import Path\nimport time\nPath(${JSON.stringify(join(root, started))}).touch()\nwhile True: time.sleep(0.1)`,
      });
      assert.match(text(result), /abort|interrupt|cancel/i);
      assert.doesNotMatch(text(result), /timed out/i);
      assert.equal(result.isError, true);
      assert.equal(result.details?.scriptError, undefined);
    } finally {
      watcher.close();
    }
  });
} finally {
  await session.dispose();
  rmSync(root, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
