import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexRuntime } from "../lib/runtime/codex-adapter";
import type { AgentEvent } from "../lib/runtime/types";

const cwd = await mkdtemp(join(tmpdir(), "cuelo-codex-runtime-"));
const events: AgentEvent[] = [];
const session = await createCodexRuntime().createSession({ cwd });
session.onEvent((event) => events.push(event));
try {
  await session.prompt('Create hello.txt containing exactly the text "hi".');
  const contents = await readFile(join(cwd, "hello.txt"), "utf8");
  assert.equal(contents.trim(), "hi");
  const summary = {
    engine: session.engine,
    sessionId: session.id,
    eventTypes: events.map((event) => event.type),
    text: events.filter((event) => event.type === "text_delta").map((event) => event.text).join(""),
    file: join(cwd, "hello.txt"),
    contents,
  };
  console.log(JSON.stringify(summary, null, 2));

  // 긴 턴을 시작하고 도중에 중단한다: turn_completed(aborted)가 와야 한다.
  const before = events.length;
  const long = session.prompt("Run the shell command `sleep 60` and then reply done.");
  await Bun.sleep(8000);
  const t0 = Date.now();
  await session.abort();
  await long.catch(() => undefined);
  const done = events.slice(before).find((event) => event.type === "turn_completed");
  assert.equal(done?.type === "turn_completed" && done.stopReason, "aborted");
  console.log(JSON.stringify({ abort: "aborted", abortMs: Date.now() - t0 }));
} finally {
  await session.dispose();
}
