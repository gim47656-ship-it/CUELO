import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSkillCandidates } from "./skill-candidates.ts";

const SINCE = Date.parse("2026-10-26T00:00:00.000Z");
const NOW = Date.parse("2026-11-02T00:00:00.000Z");
const lines = (rows) => rows.map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join("\n");
const learn = (id, timestamp, args) => ({
  type: "message", id, timestamp,
  message: { role: "assistant", content: [{ type: "text", text: "기록" }, { type: "toolCall", id: `call-${id}`, name: "learn", arguments: args }] },
});

test("keeps only procedure learn calls without a skill, after since, masked and newest first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-candidates-"));
  try {
    mkdirSync(join(dir, "proj"));
    const rows = [
      { type: "title", title: "t" },
      { type: "session", id: "S1", timestamp: "2026-10-20T00:00:00.000Z" },
      learn("a", "2026-10-28T00:00:00.000Z", { kind: "procedure", topic: "deploy", memory: "Run update.sh with API_KEY=sk-abcdef123456 set", skill: null }),
      learn("b", "2026-10-29T00:00:00.000Z", { kind: "evidence", memory: "evidence only" }),
      learn("c", "2026-10-30T00:00:00.000Z", { kind: "procedure", memory: "already a skill", skill: { name: "x" } }),
      learn("d", "2026-10-25T00:00:00.000Z", { kind: "procedure", memory: "before since" }),
      learn("e", "2026-11-03T00:00:00.000Z", { kind: "procedure", memory: "after now" }),
      "{not json \"learn\"",
      learn("f", "2026-10-31T00:00:00.000Z", JSON.stringify({ kind: "procedure", memory: `${"긴 기억 ".repeat(200)}` })),
      { type: "message", id: "u", timestamp: "2026-10-31T01:00:00.000Z", message: { role: "user", content: [{ type: "toolCall", name: "learn", arguments: { kind: "procedure", memory: "user role" } }] } },
    ];
    writeFileSync(join(dir, "proj", "s1.jsonl"), lines(rows));
    // fork 사본: 같은 호출이 다른 파일에 그대로 복사돼도 한 번만 센다.
    writeFileSync(join(dir, "proj", "z-fork.jsonl"), lines([{ type: "session", id: "S2" }, rows[2]]));
    const found = await collectSkillCandidates(dir, SINCE, NOW);
    assert.deepEqual(found.map((c) => c.timestamp), ["2026-10-31T00:00:00.000Z", "2026-10-28T00:00:00.000Z"]);
    const [long, deploy] = found;
    assert.equal(deploy.topic, "deploy");
    assert.equal(deploy.sessionId, "S1");
    assert.ok(!deploy.memory.includes("sk-abcdef123456"), deploy.memory);
    assert.ok(long.memory.length <= 601 && long.memory.endsWith("…"));
    assert.equal(long.topic, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing sessions directory yields no candidates", async () => {
  assert.deepEqual(await collectSkillCandidates(join(tmpdir(), "no-such-skill-dir-xyz"), SINCE, NOW), []);
});

test("keeps the newest 40, reads a spaced session header, and keeps distinct id-less calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-candidates-"));
  try {
    const many = Array.from({ length: 45 }, (_, i) => learn(`m${i}`, new Date(SINCE + (i + 1) * 60_000).toISOString(), { kind: "procedure", memory: `요령 ${i}` }));
    const noId = (topic) => ({ type: "toolCall", name: "learn", arguments: { kind: "procedure", topic, memory: "같은 요령" } });
    const twin = { type: "message", id: "t", timestamp: "2026-11-01T00:00:00.000Z", message: { role: "assistant", content: [noId("첫째"), noId("둘째")] } };
    writeFileSync(join(dir, "a.jsonl"), lines(["{\"type\": \"session\", \"id\": \"S9\"}", ...many, twin]));
    const found = await collectSkillCandidates(dir, SINCE, NOW);
    assert.equal(found.length, 40);
    assert.deepEqual(found.slice(0, 2).map((c) => c.topic).sort(), ["둘째", "첫째"]);
    assert.equal(found.at(-1).memory, "요령 7");
    assert.ok(found.every((c) => c.sessionId === "S9"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("id-less calls in different sessions at the same time stay apart when their text differs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-candidates-"));
  try {
    const bare = (memory) => ({ type: "message", timestamp: "2026-11-01T00:00:00.000Z", message: { role: "assistant", content: [{ type: "toolCall", name: "learn", arguments: { kind: "procedure", memory } }] } });
    writeFileSync(join(dir, "a.jsonl"), lines([{ type: "session", id: "A" }, bare("가 요령")]));
    writeFileSync(join(dir, "b.jsonl"), lines([{ type: "session", id: "B" }, bare("나 요령")]));
    assert.deepEqual((await collectSkillCandidates(dir, SINCE, NOW)).map((c) => c.sessionId).sort(), ["A", "B"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
