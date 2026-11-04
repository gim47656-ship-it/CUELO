import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const lab = await import("./plugin-lab.ts");

function tempAgentDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cuelo-plugin-lab-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function makePlugin(agentDir, id, manifest = {}, files = { "index.ts": "export default function () {}\n" }, root = "plugin-lab") {
  const dir = path.join(agentDir, root, id);
  write(path.join(dir, "plugin.json"), JSON.stringify({
    id, name: `Plugin ${id}`, description: "test plugin", createdAt: "2026-11-04T00:00:00.000Z", extension: "index.ts", ...manifest,
  }));
  for (const [rel, text] of Object.entries(files)) write(path.join(dir, rel), text);
  return dir;
}

const byId = (plugins, id, origin) => plugins.find((plugin) => plugin.id === id && (!origin || plugin.origin === origin));

test("refuses manifest paths that leave the plugin folder", async (t) => {
  const agentDir = tempAgentDir(t);
  write(path.join(agentDir, "outside.ts"), "export default function () {}\n");
  makePlugin(agentDir, "dotdot", { extension: "../../outside.ts" });
  makePlugin(agentDir, "absolute", { extension: path.join(agentDir, "outside.ts") });
  const linked = makePlugin(agentDir, "linked", { extension: "link.ts" }, {});
  fs.symlinkSync(path.join(agentDir, "outside.ts"), path.join(linked, "link.ts"));
  makePlugin(agentDir, "panel-escape", { panel: "../panel.html" });
  makePlugin(agentDir, "fine");

  const plugins = await lab.listLabPlugins(agentDir);
  for (const id of ["dotdot", "absolute", "linked", "panel-escape"]) {
    const plugin = byId(plugins, id);
    assert.ok(plugin.problem, `${id} must carry a problem`);
    assert.equal(plugin.enabled, false, `${id} must not be enabled`);
  }
  assert.equal(byId(plugins, "fine").problem, undefined);
  const entries = await lab.labExtensionEntries(agentDir);
  assert.deepEqual(entries.map((entry) => entry.id), ["fine"]);
  assert.equal(entries[0].path, fs.realpathSync(path.join(agentDir, "plugin-lab/fine/index.ts")));
});

test("a broken manifest is listed with a problem and does not hide the others", async (t) => {
  const agentDir = tempAgentDir(t);
  write(path.join(agentDir, "plugin-lab/broken/plugin.json"), "{ not json");
  makePlugin(agentDir, "wrong-id", { id: "other" });
  makePlugin(agentDir, "ok");
  write(path.join(agentDir, "plugin-lab/state.json"), JSON.stringify({ disabled: [] }));
  const plugins = await lab.listLabPlugins(agentDir);
  assert.deepEqual(plugins.map((plugin) => plugin.id).sort(), ["broken", "ok", "wrong-id"]);
  assert.match(byId(plugins, "broken").problem, /not valid JSON/);
  assert.match(byId(plugins, "wrong-id").problem, /folder name/);
  assert.equal(byId(plugins, "ok").enabled, true);
});

test("a promoted plugin shadows the trial copy of the same id", async (t) => {
  const agentDir = tempAgentDir(t);
  makePlugin(agentDir, "twin");
  makePlugin(agentDir, "twin", {}, undefined, "cuelo-plugins");
  const plugins = await lab.listLabPlugins(agentDir);
  const trial = byId(plugins, "twin", "trial");
  const promoted = byId(plugins, "twin", "promoted");
  assert.equal(trial.promoted, true);
  assert.equal(trial.enabled, false);
  assert.equal(promoted.enabled, true);
  const entries = await lab.labExtensionEntries(agentDir);
  assert.deepEqual(entries.map((entry) => entry.path), [fs.realpathSync(path.join(agentDir, "cuelo-plugins/twin/index.ts"))]);
});

test("disabling a plugin turns it off in the listing and for sessions", async (t) => {
  const agentDir = tempAgentDir(t);
  makePlugin(agentDir, "toggle");
  const off = await lab.setLabPluginEnabled("toggle", false, agentDir);
  assert.equal(off.enabled, false);
  assert.equal(byId(await lab.listLabPlugins(agentDir), "toggle").enabled, false);
  assert.deepEqual(await lab.labExtensionEntries(agentDir), []);
  const on = await lab.setLabPluginEnabled("toggle", true, agentDir);
  assert.equal(on.enabled, true);
  assert.equal((await lab.labExtensionEntries(agentDir)).length, 1);
  assert.equal(await lab.setLabPluginEnabled("missing", false, agentDir), undefined);
});

test("load errors become the plugin problem until a clean load clears them", async (t) => {
  const agentDir = tempAgentDir(t);
  makePlugin(agentDir, "thrower");
  await lab.recordLabLoadResults({ thrower: "Failed to load extension: boom" }, agentDir);
  assert.equal(byId(await lab.listLabPlugins(agentDir), "thrower").problem, "Failed to load extension: boom");
  await lab.recordLabLoadResults({ thrower: null }, agentDir);
  assert.equal(byId(await lab.listLabPlugins(agentDir), "thrower").problem, undefined);
});

test("the panel route source serves only the manifest panel inside the folder", async (t) => {
  const agentDir = tempAgentDir(t);
  makePlugin(agentDir, "with-panel", { panel: "panel.html" }, { "index.ts": "export default () => {}\n", "panel.html": "<p>hi</p>" });
  makePlugin(agentDir, "no-panel");
  assert.equal(await lab.readLabPanel("with-panel", agentDir), "<p>hi</p>");
  assert.equal(await lab.readLabPanel("no-panel", agentDir), undefined);
  assert.equal(await lab.readLabPanel("../with-panel", agentDir), undefined);
});

function sessionLines(entries) {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

const call = (timestamp, name) => ({ type: "message", timestamp, message: { role: "assistant", content: [{ type: "toolCall", id: "c", name, arguments: {} }] } });
const result = (timestamp, toolName, isError) => ({ type: "message", timestamp, message: { role: "toolResult", toolName, isError } });

test("usage counts tool calls, failures, sessions, panel opens and days since the window start", async (t) => {
  const agentDir = tempAgentDir(t);
  const sessionsDir = path.join(agentDir, "sessions");
  makePlugin(agentDir, "counter", { tools: ["lab_count"] });
  makePlugin(agentDir, "idle", { tools: ["lab_idle"] });
  const since = Date.parse("2026-11-01T00:00:00.000Z");
  // Session A (oldest): one failure. Sessions B-D: clean. The old call before `since` is ignored.
  write(path.join(sessionsDir, "proj/a.jsonl"), sessionLines([
    call("2026-10-30T10:00:00.000Z", "lab_count"),
    call("2026-11-01T10:00:00.000Z", "lab_count"),
    result("2026-11-01T10:00:01.000Z", "lab_count", true),
    call("2026-11-01T11:00:00.000Z", "other_tool"),
  ]));
  write(path.join(sessionsDir, "proj/b.jsonl"), sessionLines([call("2026-11-02T10:00:00.000Z", "lab_count"), result("2026-11-02T10:00:01.000Z", "lab_count", false)]));
  write(path.join(sessionsDir, "proj/c.jsonl"), sessionLines([call("2026-11-03T10:00:00.000Z", "lab_count")]));
  write(path.join(sessionsDir, "proj/d.jsonl"), sessionLines([call("2026-11-03T12:00:00.000Z", "lab_count"), call("2026-11-03T12:01:00.000Z", "lab_count")]));
  write(path.join(agentDir, "plugin-lab/usage.jsonl"), sessionLines([
    { ts: "2026-10-31T00:00:00.000Z", id: "counter", event: "panel_open" },
    { ts: "2026-11-04T09:00:00.000Z", id: "counter", event: "panel_open" },
    { ts: "2026-11-04T09:05:00.000Z", id: "counter", event: "draft" },
  ]));

  const usage = await lab.readLabUsage(since, sessionsDir, agentDir);
  assert.deepEqual(usage.find((entry) => entry.id === "counter"), {
    id: "counter", sessions: 4, toolCalls: 5, toolFailures: 1, panelOpens: 1, activeDays: 4,
    lastUsedAt: "2026-11-04T09:05:00.000Z", recentSessionFailures: 0,
  });
  assert.deepEqual(usage.find((entry) => entry.id === "idle"), {
    id: "idle", sessions: 0, toolCalls: 0, toolFailures: 0, panelOpens: 0, activeDays: 0, lastUsedAt: null, recentSessionFailures: 0,
  });

  // A failure in one of the three newest sessions counts as recent.
  fs.appendFileSync(path.join(sessionsDir, "proj/d.jsonl"), sessionLines([result("2026-11-03T12:02:00.000Z", "lab_count", true)]));
  const again = await lab.readLabUsage(since, sessionsDir, agentDir);
  assert.equal(again.find((entry) => entry.id === "counter").recentSessionFailures, 1);
});

test("export masks secrets, keeps trial plugins only and drops files over 64 KiB", async (t) => {
  const agentDir = tempAgentDir(t);
  const sessionsDir = path.join(agentDir, "sessions");
  makePlugin(agentDir, "secretive", {}, {
    "index.ts": 'const API_KEY = "abcd1234efgh5678";\nexport default () => {}\n',
    "icon.png": "\u0000\u0001binary",
  });
  makePlugin(agentDir, "huge", {}, { "index.ts": "export default () => {}\n", "data.json": `"${"x".repeat(70 * 1024)}"` });
  makePlugin(agentDir, "shipped", {}, undefined, "cuelo-plugins");

  const entries = await lab.collectLabExport(0, sessionsDir, agentDir);
  assert.deepEqual(entries.map((entry) => entry.plugin.id).sort(), ["huge", "secretive"]);

  const secretive = entries.find((entry) => entry.plugin.id === "secretive");
  assert.deepEqual(secretive.files.map((file) => file.path).sort(), ["index.ts", "plugin.json"]);
  const index = secretive.files.find((file) => file.path === "index.ts").text;
  assert.doesNotMatch(index, /abcd1234efgh5678/);
  const total = secretive.files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0);
  assert.ok(total <= lab.LAB_EXPORT_LIMIT_BYTES);

  const huge = entries.find((entry) => entry.plugin.id === "huge");
  assert.deepEqual(huge.files, []);
  assert.match(huge.plugin.problem, /64|65536/);
  assert.equal(huge.usage.toolCalls, 0);
});

test("export never follows a symlinked plugin folder", async (t) => {
  const agentDir = tempAgentDir(t);
  const outside = path.join(agentDir, "outside");
  write(path.join(outside, "plugin.json"), JSON.stringify({ id: "leak", name: "x", description: "x", createdAt: "2026-11-04T00:00:00Z" }));
  write(path.join(outside, "note.txt"), "OUTSIDE_MARKER");
  fs.mkdirSync(path.join(agentDir, "plugin-lab"), { recursive: true });
  fs.symlinkSync(outside, path.join(agentDir, "plugin-lab", "leak"));
  const entries = await lab.collectLabExport(0, path.join(agentDir, "sessions"), agentDir);
  const leak = entries.find((entry) => entry.plugin.id === "leak");
  assert.ok(leak?.plugin.problem);
  assert.deepEqual(leak.files, []);
});

test("the reload signature changes when any plugin file changes, not only the newest one", async (t) => {
  const agentDir = tempAgentDir(t);
  const dir = makePlugin(agentDir, "sig", {}, { "index.ts": "export default () => {}\n", "helper.ts": "export const a = 1;\n" });
  fs.utimesSync(path.join(dir, "index.ts"), new Date("2030-01-01"), new Date("2030-01-01"));
  fs.utimesSync(path.join(dir, "helper.ts"), new Date("2020-01-01"), new Date("2020-01-01"));
  const [before] = await lab.labExtensionEntries(agentDir);
  fs.writeFileSync(path.join(dir, "helper.ts"), "export const a = 22;\n");
  fs.utimesSync(path.join(dir, "helper.ts"), new Date("2021-01-01"), new Date("2021-01-01"));
  const [after] = await lab.labExtensionEntries(agentDir);
  assert.notEqual(after.signature, before.signature);
});

test("an unreadable state file keeps plugins off instead of re-enabling them", async (t) => {
  const agentDir = tempAgentDir(t);
  makePlugin(agentDir, "a");
  await lab.setLabPluginEnabled("a", false, agentDir);
  fs.writeFileSync(path.join(agentDir, "plugin-lab", "state.json"), "{");
  assert.deepEqual(await lab.labExtensionEntries(agentDir), []);
  const plugin = byId(await lab.listLabPlugins(agentDir), "a");
  assert.equal(plugin.enabled, false);
  assert.match(plugin.problem, /state\.json/);
  await assert.rejects(() => lab.setLabPluginEnabled("a", true, agentDir), /state\.json/);
});

test("concurrent toggles keep every decision", async (t) => {
  const agentDir = tempAgentDir(t);
  for (const id of ["a", "b", "c"]) makePlugin(agentDir, id);
  await Promise.all(["a", "b", "c"].map((id) => lab.setLabPluginEnabled(id, false, agentDir)));
  const plugins = await lab.listLabPlugins(agentDir);
  assert.deepEqual(plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.id), []);
});

test("createdAt must be an ISO date-time", async (t) => {
  const agentDir = tempAgentDir(t);
  makePlugin(agentDir, "loose-date", { createdAt: "March 1, 2026" });
  const plugin = byId(await lab.listLabPlugins(agentDir), "loose-date");
  assert.match(plugin.problem, /createdAt/);
  assert.equal(plugin.enabled, false);
});

test("a plugin too large to fingerprint restarts on every reload instead of keeping stale code", async (t) => {
  const agentDir = tempAgentDir(t);
  const files = { "z-entry.ts": "export default () => {}\n" };
  for (let i = 0; i < 510; i++) files[`a${String(i).padStart(3, "0")}.txt`] = "x";
  makePlugin(agentDir, "big", { extension: "z-entry.ts" }, files);
  const [first] = await lab.labExtensionEntries(agentDir);
  const [second] = await lab.labExtensionEntries(agentDir);
  assert.notEqual(first.signature, second.signature);
});

test("an equal-length rewrite with the old mtime still changes the reload signature", async (t) => {
  const agentDir = tempAgentDir(t);
  const dir = makePlugin(agentDir, "same-size", {}, { "index.ts": "export default () => 1;\n" });
  const entry = path.join(dir, "index.ts");
  const stamp = new Date("2026-01-01T00:00:00Z");
  fs.utimesSync(entry, stamp, stamp);
  const [before] = await lab.labExtensionEntries(agentDir);
  await new Promise((resolve) => setTimeout(resolve, 20)); // ctime has sub-ms resolution, but keep the rewrite visibly later
  fs.writeFileSync(entry, "export default () => 2;\n");
  fs.utimesSync(entry, stamp, stamp);
  const [after] = await lab.labExtensionEntries(agentDir);
  assert.notEqual(after.signature, before.signature);
});
