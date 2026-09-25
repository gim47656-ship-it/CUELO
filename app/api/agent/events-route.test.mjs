import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createMessageUpdateCoalescer } = await jiti.import("../../../lib/rpc-manager.ts");


test("agent SSE coalesces cumulative message updates and flushes before ordered events", async () => {
  const emitted = [];
  const coalescer = createMessageUpdateCoalescer((event) => emitted.push(event));

  coalescer.push({ type: "message_update", message: { id: "first" } });
  coalescer.push({ type: "message_update", message: { id: "latest" } });
  assert.deepEqual(emitted, []);

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(emitted, [{ type: "message_update", message: { id: "latest" } }]);

  coalescer.push({ type: "message_update", message: { id: "before-end" } });
  coalescer.push({ type: "message_end", message: { id: "complete" } });
  assert.deepEqual(emitted.slice(1), [
    { type: "message_update", message: { id: "before-end" } },
    { type: "message_end", message: { id: "complete" } },
  ]);

  coalescer.push({ type: "message_update", message: { id: "dropped" } });
  coalescer.close();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(emitted.length, 3);
});



