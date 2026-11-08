// #74: exercise the actual Mnemopi facade and SQLite store with a deferred, local provider.
// HOME=<isolated-home> OMP_CORE_PATCH_TARGET=<physical-copy> bun run patches/core-embedding-rebuild-race-test.ts
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";

const core = process.env.OMP_CORE_PATCH_TARGET;
if (!core) throw new Error("OMP_CORE_PATCH_TARGET must name an isolated physical core copy");
const root = resolve(core, "../pi-mnemopi/src/core");
// The target is selected at runtime; static imports would test the host instead of the physical copy.
const { initBeam } = await import(`${root}/beam/index.ts`);
const { Mnemopi } = await import(`${root}/memory.ts`);
const { setLocalModelInitializerForTests, resetEmbeddingProviderForTests } = await import(`${root}/embeddings.ts`);
const OLD = "old-model";
const ACTIVE = "intfloat/multilingual-e5-large";
const oldVector = [1, 0, 0, 0];
const newVector = [0, 1, 0, 0];
let passed = 0;

async function scenario(kind: "race" | "failure" | "normal" | "local") {
  const db = new Database(":memory:");
  initBeam(db);
  const timestamp = new Date().toISOString();
  const working = ["changed", "deleted", "superseded", "projection", "unchanged"];
  working.push(...Array.from({ length: 20 }, (_, index) => `batch-${index}`));
  const episodic = ["ep-changed", "ep-deleted", "ep-superseded", "ep-unchanged"];
  for (const [table, ids] of [["working_memory", working], ["episodic_memory", episodic]] as const) {
    for (const id of ids) {
      db.query(`INSERT INTO ${table}(id, content, source, timestamp, session_id) VALUES (?, ?, 'test', ?, 'default')`).run(id, `old ${id}`, timestamp);
      db.query("INSERT INTO memory_embeddings(memory_id, embedding_json, model) VALUES (?, ?, ?)").run(id, JSON.stringify(oldVector), OLD);
    }
  }
  db.query("UPDATE working_memory SET embed_text = 'old projected input' WHERE id = 'projection'").run();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const calls: string[][] = [];
  const provider = async function* (texts: readonly string[]) {
    calls.push([...texts]);
    if (texts.some(text => text.includes("old changed"))) {
      entered.resolve();
      await release.promise;
      if (kind === "failure") throw new Error("synthetic corpus failure");
    }
    yield texts.map(text => text.includes("new changed") ? newVector : oldVector);
  };
  if (kind === "local") setLocalModelInitializerForTests(async () => ({ embed: provider }));
  const memory = new Mnemopi({ db, embeddings: { model: ACTIVE, ...(kind === "local" ? {} : { provider }) } });
  try {
    await entered.promise;
    if (kind === "race") {
      const before = new Set(memory.beam.pendingExtractions);
      assert.equal(memory.update("changed", "new changed"), true);
      assert.equal(memory.forget("deleted"), true);
      await Promise.all([...memory.beam.pendingExtractions].filter(task => !before.has(task)));
      const preserve = (id: string) => db.query("INSERT OR REPLACE INTO memory_embeddings(memory_id, embedding_json, model) VALUES (?, ?, ?)").run(id, JSON.stringify(newVector), ACTIVE);
      // Adjacent interleavings use SQL because the public facade mutates working rows only.
      db.query("UPDATE working_memory SET embed_text = 'new projected input' WHERE id = 'projection'").run();
      db.query("UPDATE working_memory SET superseded_by = 'replacement' WHERE id = 'superseded'").run();
      db.query("UPDATE episodic_memory SET content = 'new episodic input' WHERE id = 'ep-changed'").run();
      db.query("UPDATE episodic_memory SET superseded_by = 'replacement' WHERE id = 'ep-superseded'").run();
      db.query("DELETE FROM episodic_memory WHERE id = 'ep-deleted'").run();
      db.query("DELETE FROM memory_embeddings WHERE memory_id IN ('superseded', 'ep-superseded', 'ep-deleted')").run();
      preserve("projection");
      preserve("ep-changed");
      db.query("INSERT INTO working_memory(id, content, source, timestamp, session_id) VALUES ('added', 'new addition', 'test', ?, 'default')").run(timestamp);
      preserve("added");
    }
    release.resolve();
    await memory.flushExtractions();
    const embedding = (id: string) => db.query("SELECT embedding_json, model FROM memory_embeddings WHERE memory_id = ?").get(id) as { embedding_json: string; model: string } | null;
    const active = kind === "local" ? embedding("unchanged")?.model : ACTIVE;
    if (kind === "local") assert.ok(active?.startsWith(`${ACTIVE}#`), "local model fingerprint");
    if (kind === "race") {
      for (const id of ["changed", "projection", "ep-changed", "added"]) {
        assert.deepEqual(embedding(id), { embedding_json: JSON.stringify(newVector), model: ACTIVE }, `preserve newer ${id}`);
      }
      for (const id of ["deleted", "superseded", "ep-deleted", "ep-superseded"]) assert.equal(embedding(id), null, `do not recreate ${id}`);
      assert.equal(memory.get("changed")?.content, "new changed");
      assert.equal(memory.get("deleted"), null);
    }
    for (const id of kind === "race" ? ["unchanged", "ep-unchanged"] : [...working, ...episodic]) {
      assert.deepEqual(embedding(id), { embedding_json: JSON.stringify(oldVector), model: kind === "failure" ? OLD : active }, `${kind}: ${id}`);
    }
    const corpus = calls.find(texts => texts.some(text => text.includes("old projected input")));
    assert.ok(corpus);
    assert.ok(corpus.every(text => text.startsWith("passage: ") === (kind === "local")), "local E5 prefix only; injected provider receives original input");
    assert.ok(calls.every(texts => texts.length <= 16), "rebuild batches stay bounded with 29 source rows");
    console.log(`PASS ${kind}: ${kind === "race" ? "new vectors retained; deleted/superseded absent; new ID retained" : kind === "failure" ? "old corpus preserved" : "unchanged source rebuilt"}`);
    passed++;
  } finally {
    release.resolve();
    await memory.flushExtractions();
    memory.close();
    db.close();
    if (kind === "local") resetEmbeddingProviderForTests();
  }
}
for (const kind of ["race", "failure", "normal", "local"] as const) await scenario(kind);
console.log(`${passed} scenarios passed; local provider only, no live DB or network`);
