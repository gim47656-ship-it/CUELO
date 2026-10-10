import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const { readArchivedIds, readArchivedIdsReadOnly } = await import("./session-archive.ts");
const { getAgentDir } = await import("./session-reader.ts");
const { setAgentDir } = await import("@oh-my-pi/pi-utils");

/** Runs against a temporary agent directory, never the real registry, and restores the previous one. */
async function withAgentDir(run) {
  const previous = getAgentDir();
  const dir = mkdtempSync(join(tmpdir(), "session-archive-"));
  setAgentDir(dir);
  try {
    assert.equal(resolve(getAgentDir()), resolve(dir));
    return await run(dir);
  } finally {
    setAgentDir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
}

const registry = (ids) => JSON.stringify({ archived: ids });

test("the read-only reader takes a legacy registry where it is, without adopting it", () => withAgentDir((dir) => {
  const legacy = join(dir, "omp-web-archived.json");
  writeFileSync(legacy, registry(["old-1", "old-2"]));
  assert.deepEqual([...readArchivedIdsReadOnly()].sort(), ["old-1", "old-2"]);
  assert.equal(readFileSync(legacy, "utf8"), registry(["old-1", "old-2"]));
  assert.equal(existsSync(join(dir, "cuelo-archived.json")), false);
}));

test("the current registry wins over a legacy one, as adoption would decide", () => withAgentDir((dir) => {
  writeFileSync(join(dir, "cuelo-archived.json"), registry(["new"]));
  writeFileSync(join(dir, "omp-web-archived.json"), registry(["old"]));
  assert.deepEqual([...readArchivedIdsReadOnly()], ["new"]);
  assert.deepEqual([...readArchivedIds()], ["new"]);
}));

test("no registry at all means nothing is archived", () => withAgentDir(() => {
  assert.deepEqual([...readArchivedIdsReadOnly()], []);
}));

test("a corrupt registry fails the read-only reader but still reads as empty for the session list", () => withAgentDir((dir) => {
  for (const body of ["{not json", JSON.stringify({ archived: "s1" }), "null"]) {
    writeFileSync(join(dir, "cuelo-archived.json"), body);
    assert.throws(() => readArchivedIdsReadOnly());
    assert.deepEqual([...readArchivedIds()], []);
  }
}));
