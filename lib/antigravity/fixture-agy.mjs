#!/usr/bin/env node
// Isolated test ACP server. Never use against a real Antigravity session.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const cwd = process.cwd();
const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
const result = (id, value = {}) => send({ id, result: value });
const update = (sessionId, sessionUpdate, fields) => send({ method: "session/update", params: { sessionId, update: { sessionUpdate, ...fields } } });
const text = (value) => ({ type: "text", text: value });
const options = [
  { type: "select", id: "model", name: "Model", category: "model", currentValue: "claude-sonnet", options: [
    { value: "claude-sonnet", name: "Claude Sonnet" },
    { value: "gpt-oss", name: "GPT OSS" },
    { value: "gemini-3-pro", name: "Gemini 3 Pro" },
    { value: "gemini-3-flash", name: "Gemini 3 Flash" },
  ] },
  { type: "select", id: "thinking", name: "Thinking", category: "thought_level", currentValue: "low", options: [
    { value: "low", name: "Low" }, { value: "high", name: "High" },
  ] },
];
const audit = (frame) => appendFileSync(join(cwd, "fixture-wire.jsonl"), JSON.stringify({ pid: process.pid, ...frame }) + "\n");
audit({ argv: process.argv.slice(2), env: Object.keys(process.env).sort() });
assert.deepEqual(process.argv.slice(2), ["acp"]);
let sessionId;
let promptId;
let permissionRpcId = 500;
let awaitingPermission;
const line = createInterface({ input: process.stdin });
for await (const input of line) {
  const frame = JSON.parse(input);
  audit({ frame });
  const { id, method, params } = frame;
  if (method === "initialize") {
    assert.deepEqual(params, { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "CUELO", version: params.clientInfo.version } });
    result(id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, sessionCapabilities: { list: {} } } });
  } else if (["session/new", "session/list", "session/set_config_option", "session/prompt"].includes(method)
    && existsSync(join(cwd, "fixture-auth-required"))) {
    send({ id, error: { code: -32000, message: "Authentication required" } });
  } else if (method === "session/new") {
    assert.deepEqual(params, { cwd, mcpServers: [] });
    sessionId = randomUUID();
    audit({ savedSession: sessionId });
    result(id, { sessionId, configOptions: options });
  } else if (method === "session/list") {
    assert.equal(params.cwd, cwd);
    const saved = readFileSync(join(cwd, "fixture-wire.jsonl"), "utf8").trim().split("\n").map(JSON.parse)
      .flatMap(({ savedSession }) => savedSession ? [{ sessionId: savedSession, title: "Fixture Antigravity chat", cwd }] : []);
    result(id, params.cursor ? { sessions: [{ sessionId: "past-2", title: "Second page", cwd }] } : {
      sessions: [...saved, { sessionId: "past-1", title: "Saved ACP conversation", cwd: `${cwd}/` }, { sessionId: "cross-project", title: "Other project", cwd: "/other-project" }], nextCursor: "second-page",
    });
  } else if (method === "session/load") {
    assert.deepEqual(params, { cwd, mcpServers: [], sessionId: params.sessionId });
    sessionId = params.sessionId;
    update(sessionId, "user_message_chunk", { content: text("Earlier prompt") });
    update(sessionId, "agent_message_chunk", { content: text("Replayed answer") });
    options[0].currentValue = "gemini-3-pro";
    result(id, { configOptions: options });
  } else if (method === "session/set_config_option") {
    assert.equal(params.sessionId, sessionId);
    const option = options.find((entry) => entry.id === params.configId);
    assert.ok(option?.options.some((entry) => entry.value === params.value));
    option.currentValue = params.value;
    result(id, { configOptions: options });
  } else if (method === "session/prompt") {
    assert.deepEqual(Object.keys(params).sort(), ["prompt", "sessionId"]);
    assert.equal(params.sessionId, sessionId);
    assert.match(options[0].currentValue, /^gemini-/);
    if (params.prompt[0]?.text === "crash fixture") process.exit(9);
    if (promptId !== undefined) {
      update(sessionId, "agent_message_chunk", { content: text("Steering received.") });
      result(id, { stopReason: "end_turn" });
      continue;
    }
    promptId = id;
    update("foreign-session", "agent_message_chunk", { content: text("Foreign update must not leak") });
    update(sessionId, "session_info_update", { title: "Fixture Antigravity chat" });
    update(sessionId, "agent_thought_chunk", { content: text("Checking the requested change.") });
    update(sessionId, "agent_message_chunk", { content: text("I found a small change. ") });
    await new Promise((resolve) => setTimeout(resolve, 35));
    update(sessionId, "agent_message_chunk", { content: text("Here is the **diff**.") });
    update(sessionId, "plan", { entries: [{ content: "Review the setting", status: "completed", priority: "high" }] });
    const tool = { toolCallId: `edit-${id}`, title: "Update settings.ts", kind: "edit", status: "pending", locations: [{ path: join(cwd, "settings.ts") }], content: [{ type: "diff", path: "settings.ts", oldText: "export const enabled = false;", newText: "export const enabled = true;" }] };
    update(sessionId, "tool_call", tool);
    const permission = (permissionSessionId) => send({ id: ++permissionRpcId, method: "session/request_permission", params: { sessionId: permissionSessionId, toolCall: tool, options: [
      { kind: "allow_once", name: "Allow once", optionId: "allow-once" },
      { kind: "allow_always", name: "Always allow", optionId: "allow-always" },
      { kind: "reject_once", name: "Deny", optionId: "deny-once" },
    ] } });
    permission("foreign-session");
    permission(sessionId);
    awaitingPermission = permissionRpcId;
  } else if (method === "session/cancel") {
    assert.equal(params.sessionId, sessionId);
    if (promptId !== undefined) result(promptId, { stopReason: "cancelled" });
    promptId = undefined;
  } else if (!method && id === awaitingPermission) {
    if (frame.result.outcome.outcome !== "selected") continue;
    const accepted = frame.result.outcome.optionId === "allow-once";
    update(sessionId, "tool_call_update", { toolCallId: `edit-${promptId}`, status: accepted ? "completed" : "failed" });
    update(sessionId, "agent_message_chunk", { content: text(accepted ? "Permission allowed." : "Permission denied.") });
    result(promptId, { stopReason: "end_turn" });
    promptId = undefined;
  } else if (method) {
    assert.fail(`Unexpected client method ${method}`);
  }
}
