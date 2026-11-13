import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startSessionBusyStateWriter } from "./session-busy-state";
import { readBusySnapshots } from "./repo-sync/busy-files";

test("writer uses 0600 atomic replacement, realpath cwd, independent server files and cleanup", () => {
  const root = mkdtempSync(join(tmpdir(), "cuelo-busy-writer-"));
  const source = { ids: ["root"], sessions: [{ id: "root", cwd: root }] };
  const a = startSessionBusyStateWriter({ agentDir: root, port: "30141", appDir: root, collect: () => source });
  const b = startSessionBusyStateWriter({ agentDir: root, port: "30163", appDir: root, collect: () => ({ ids: [], sessions: [] }) });
  const c = startSessionBusyStateWriter({ agentDir: root, appDir: root, collect: () => ({ ids: ["unresolved"], sessions: [] }) });
  try {
    assert.notEqual(a.path, b.path); assert.ok(c.path.endsWith(`${process.pid}.json`));
    const inode = statSync(a.path).ino; a.refresh();
    assert.notEqual(statSync(a.path).ino, inode); assert.equal(statSync(a.path).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(a.path, "utf8")).cwds, [root]);
    assert.equal(readBusySnapshots(root).length, 3);
    assert.equal(readBusySnapshots(root).find(s => s.port === null)?.unresolved, 1);
    const dir = join(root, "cuelo-busy-cwds"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "30100-99999999.json"), JSON.stringify({ writtenAt: Date.now(), pid: 99999999, port: 30100, cwds: [], unresolved: 0, appDir: root }), { mode: 0o600 });
    assert.equal(readBusySnapshots(root).length, 3);
  } finally { a.stop(); b.stop(); c.stop(); assert.equal(readBusySnapshots(root).length, 0); rmSync(root, { recursive: true, force: true }); }
});
