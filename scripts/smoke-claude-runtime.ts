import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeRuntime } from "../lib/runtime/claude-adapter";
import type { AgentEvent } from "../lib/runtime/types";

const cwd = await mkdtemp(join(tmpdir(), "cuelo-claude-runtime-"));
const runtime = createClaudeRuntime();
const session = await runtime.createSession({ cwd, model: process.env.CUELO_CLAUDE_MODEL ?? "claude-haiku-4-5" });
const events: AgentEvent[] = [];
let waitingForAbortDelta = false;
const abortReady = Promise.withResolvers<void>();
const unsubscribe = session.onEvent((event) => {
  events.push(event);
  if (waitingForAbortDelta && event.type === "text_delta") abortReady.resolve();
});
try {
  await session.prompt('Create hello.txt containing exactly "hi" and do not do anything else.');
  const content = await readFile(join(cwd, "hello.txt"), "utf8");
  if (content.trim() !== "hi") throw new Error(`Unexpected hello.txt contents: ${JSON.stringify(content)}`);
  const firstTurn = events.find((event) => event.type === "turn_completed");
  if (firstTurn?.type !== "turn_completed" || firstTurn.stopReason !== "stop") {
    throw new Error(`Expected a successful first turn, observed ${JSON.stringify(firstTurn)}`);
  }
  waitingForAbortDelta = true;
  const secondTurn = session.prompt("Write a very long, detailed essay about the history of arithmetic. Do not use any tools.");
  const timeout = setTimeout(() => abortReady.reject(new Error("Timed out waiting for generated text before abort")), 30_000);
  await abortReady.promise;
  clearTimeout(timeout);
  await session.abort();
  await secondTurn;
  const abortTurn = events.filter((event) => event.type === "turn_completed").at(-1);
  if (abortTurn?.type !== "turn_completed" || abortTurn.stopReason !== "aborted") {
    throw new Error(`Expected interrupt control request to produce an aborted turn, observed ${JSON.stringify(abortTurn)}`);
  }
  const usage = events.filter((event) => event.type === "usage");
  const textCharacters = events.filter((event) => event.type === "text_delta").reduce((total, event) => total + event.text.length, 0);
  console.log(JSON.stringify({ cwd, engine: session.engine, sessionId: session.id, model: process.env.CUELO_CLAUDE_MODEL ?? "claude-haiku-4-5", file: "hello.txt", fileContents: content, usage, abort: abortTurn.stopReason, eventTypes: events.map((event) => event.type), textCharacters }, null, 2));
} finally {
  unsubscribe();
  await session.dispose();
  await rm(cwd, { recursive: true, force: true });
}
