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

function makePlugin(agentDir, id, manifest = {}, files = { "index.ts": "export default function () {}\n" }, root = "cuelo-plugins") {
  const dir = path.join(agentDir, root, id);
  write(path.join(dir, "plugin.json"), JSON.stringify({
    id, name: `Plugin ${id}`, description: "test plugin", createdAt: "2026-11-04T00:00:00.000Z", extension: "index.ts", ...manifest,
  }));
  for (const [rel, text] of Object.entries(files)) write(path.join(dir, rel), text);
  return dir;
}

const byId = (plugins, id) => plugins.find((plugin) => plugin.id === id);

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
  assert.equal(entries[0].path, fs.realpathSync(path.join(agentDir, "cuelo-plugins/fine/index.ts")));
});

test("a broken manifest is listed with a problem and does not hide the others", async (t) => {
  const agentDir = tempAgentDir(t);
  write(path.join(agentDir, "cuelo-plugins/broken/plugin.json"), "{ not json");
  makePlugin(agentDir, "wrong-id", { id: "other" });
  makePlugin(agentDir, "ok");
  write(path.join(agentDir, "plugin-lab/state.json"), JSON.stringify({ disabled: [] }));
  const plugins = await lab.listLabPlugins(agentDir);
  assert.deepEqual(plugins.map((plugin) => plugin.id).sort(), ["broken", "ok", "wrong-id"]);
  assert.match(byId(plugins, "broken").problem, /not valid JSON/);
  assert.match(byId(plugins, "wrong-id").problem, /folder name/);
  assert.equal(byId(plugins, "ok").enabled, true);
});

test("a plugin folder only in the retired trial folder is neither listed nor loaded", async (t) => {
  const agentDir = tempAgentDir(t);
  makePlugin(agentDir, "installed");
  makePlugin(agentDir, "leftover", {}, undefined, "plugin-lab");
  const plugins = await lab.listLabPlugins(agentDir);
  assert.deepEqual(plugins.map((plugin) => plugin.id), ["installed"]);
  assert.deepEqual((await lab.labExtensionEntries(agentDir)).map((entry) => entry.id), ["installed"]);
  assert.equal(await lab.getLabPlugin("leftover", agentDir), undefined);
  assert.equal(await lab.setLabPluginEnabled("leftover", false, agentDir), undefined);
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

test("check locates the repository source copy by walking up from the session cwd, then the installed copy", async (t) => {
  const agentDir = tempAgentDir(t);
  makePlugin(agentDir, "echo");
  const checkout = tempAgentDir(t);
  const source = makePlugin(checkout, "authored", {}, undefined, "Tools/OMP_Global_Config/agent/cuelo-plugins");
  const project = path.join(checkout, "app", "nested");
  write(path.join(project, "placeholder.txt"), "");

  // Authored in the repository but not installed yet: the source copy is found from a nested cwd.
  const pending = await lab.locateLabPlugin("authored", project, agentDir);
  assert.equal(pending.source, "repository");
  assert.equal(fs.realpathSync(pending.dir), fs.realpathSync(source));
  assert.equal(fs.realpathSync(pending.extensionPath), fs.realpathSync(path.join(source, "index.ts")));

  // Installed and absent from the repository: the installed copy is used, from any cwd.
  const installed = await lab.locateLabPlugin("echo", project, agentDir);
  assert.equal(installed.source, "installed");
  assert.equal(fs.realpathSync(installed.dir), fs.realpathSync(path.join(agentDir, "cuelo-plugins", "echo")));

  // The repository copy wins over an installed copy of the same id.
  makePlugin(agentDir, "authored");
  const both = await lab.locateLabPlugin("authored", project, agentDir);
  assert.equal(both.source, "repository");

  assert.equal(await lab.locateLabPlugin("missing", project, agentDir), undefined);
  assert.equal(await lab.locateLabPlugin("../escape", project, agentDir), undefined);
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

test("lastEnhancement reaches the listing and survives a toggle, and none is reported as absent", async (t) => {
  const agentDir = tempAgentDir(t);
  makePlugin(agentDir, "enhanced", { lastEnhancement: { at: "2026-11-10T20:02:34Z", summary: "성공한 결과만 셉니다." } });
  makePlugin(agentDir, "plain");
  const listed = byId(await lab.listLabPlugins(agentDir), "enhanced");
  assert.deepEqual(listed.lastEnhancement, { at: "2026-11-10T20:02:34Z", summary: "성공한 결과만 셉니다." });
  assert.equal(byId(await lab.listLabPlugins(agentDir), "plain").lastEnhancement, undefined);
  const toggled = await lab.setLabPluginEnabled("enhanced", false, agentDir);
  assert.deepEqual(toggled.lastEnhancement, listed.lastEnhancement);
});

test("an unusable lastEnhancement is dropped without becoming a problem or blocking the plugin", async (t) => {
  const agentDir = tempAgentDir(t);
  const bad = {
    "loose-at": { at: "November 10, 2026", summary: "본문" },
    "no-summary": { at: "2026-11-10T20:02:34Z", summary: "   " },
    "not-an-object": "2026-11-10T20:02:34Z",
    "empty": {},
    // Date.parse rolls this over to 2 March, which would put a fabricated day on the card.
    "impossible-day": { at: "2026-02-30T12:00:00Z", summary: "본문" },
    "impossible-day-offset": { at: "2026-04-31T23:30:00+09:00", summary: "본문" },
  };
  for (const [id, lastEnhancement] of Object.entries(bad)) makePlugin(agentDir, id, { lastEnhancement });
  const plugins = await lab.listLabPlugins(agentDir);
  for (const id of Object.keys(bad)) {
    const plugin = byId(plugins, id);
    assert.equal(plugin.lastEnhancement, undefined, `${id} must not expose unusable metadata`);
    assert.equal(plugin.problem, undefined, `${id} must stay loadable`);
    assert.equal(plugin.enabled, true, `${id} must stay on`);
  }
  assert.deepEqual((await lab.labExtensionEntries(agentDir)).map((entry) => entry.id).sort(), Object.keys(bad).sort());
});

test("a real instant survives in every manifest timezone form", async (t) => {
  const agentDir = tempAgentDir(t);
  const ats = {
    "utc": "2026-11-10T20:02:34Z",
    "seoul": "2026-11-09T00:08:53+09:00",
    // Local evening that falls on the next UTC day: the written day is the one that must survive, not the UTC one.
    "seoul-late": "2026-11-10T23:30:00+09:00",
    "new-york": "2026-11-10T19:30:00-05:00",
    "leap-day": "2028-02-29T00:00:00Z",
  };
  for (const [id, at] of Object.entries(ats)) makePlugin(agentDir, id, { lastEnhancement: { at, summary: "본문" } });
  const plugins = await lab.listLabPlugins(agentDir);
  for (const [id, at] of Object.entries(ats)) {
    assert.deepEqual(byId(plugins, id).lastEnhancement, { at, summary: "본문" }, `${id} must keep its instant`);
  }
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
