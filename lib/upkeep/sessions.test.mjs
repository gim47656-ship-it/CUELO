import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanSessions } from "./sessions.ts";

const lines = (rows) => rows.map((row) => JSON.stringify(row)).join("\n");

test("Maker results in batched notices, previews and wait snapshots are all counted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "upkeep-delivery-"));
  try {
    const now = Date.now(), timestamp = new Date(now - 5000).toISOString();
    const result = (id, duration, status, body = "output") =>
      `<task-result id="${id}" agent="maker" status="completed" duration="${duration}">\n${body === "preview" ? `<meta lines="55" size="5.3KB" />\n<preview full-output="agent://${id}">` : "\n<output>"}\n{\n  "status": "${status}",\n  "summary": "x"\n}\n</${body}>\n</task-result>`;
    const batched = {
      type: "custom_message", id: "n1", customType: "async-result", timestamp,
      content: `<system-notice>\n── Job Display (Display) ──\n${result("Display", "19m30s", "completed")}\n── Job Aux (Aux) ──\n${result("Aux", "19m59s", "partial", "preview")}\n</system-notice>`,
    };
    const snapshot = (id, name, text) => ({
      type: "message", id, timestamp, message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }] },
    });
    const recovered = (id, duration, status) =>
      `### ${id} [task] — completed\nLabel: ${id}\nDelivery: not auto-delivered; recovered by this snapshot.\n\`\`\`\n${result(id, duration, status)}\n\`\`\``;
    writeFileSync(join(dir, "s.jsonl"), lines([
      { type: "session", id: "S", timestamp },
      batched,
      snapshot("w1", "wait", `## Completed (1)\n\n${recovered("Audit", "10m40s", "partial")}`),
      snapshot("h1", "hub", `## Completed (1)\n\n${recovered("Quote", "45s", "completed")}`),
      // 이미 받은 결과를 다시 읽은 출력은 도착이 아니다.
      snapshot("r1", "read", result("Display", "19m30s", "partial")),
    ]));
    const { makerResults } = await scanSessions(dir, now);
    assert.deepEqual(makerResults.map((r) => [r.name, r.durationSec, r.partial]), [
      ["Display", 1170, false], ["Aux", 1199, true], ["Audit", 640, true], ["Quote", 45, false],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 공개 이슈 #59: 자동 알림으로 이미 받은 결과를 wait·hub가 `already delivered or recovered`로 다시 보여 주면 새 도착이 아니다.
// 같은 스냅샷의 다른 작업(직접 전달·회수)은 작업 블록마다 따로 판정해 그대로 센다.
test("a result wait/hub shows again as already delivered is not counted twice; other jobs in that snapshot still are", async () => {
  const dir = mkdtempSync(join(tmpdir(), "upkeep-redelivery-"));
  try {
    const now = Date.now(), timestamp = new Date(now - 5000).toISOString();
    const result = (id, status, extra = "") =>
      `<task-result id="${id}" agent="maker" status="completed" duration="45s">\n<output>\n{"status":"${status}"}\n${extra}</output>\n</task-result>`;
    const job = (id, delivery, body) => `### ${id} [task] — completed\nLabel: ${id}\nDelivery: ${delivery}\n\`\`\`\n${body}\n\`\`\``;
    const snapshot = (id, name, text) => ({
      type: "message", id, timestamp, message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }] },
    });
    writeFileSync(join(dir, "s.jsonl"), lines([
      { type: "session", id: "S", timestamp },
      { type: "custom_message", id: "n1", customType: "async-result", timestamp, content: `<system-notice>\n${result("Build", "partial")}\n</system-notice>` },
      snapshot("w1", "wait", `## Completed (3)\n\n${[
        job("Build", "already delivered or recovered.", result("Build", "partial", "### Notes [x] — y\nnot a job header\n")),
        job("Direct", "delivered directly to wait.", result("Direct", "completed")),
        job("Late", "not auto-delivered; recovered by this snapshot.", result("Late", "partial")),
      ].join("\n")}`),
      snapshot("h1", "hub", `## Completed (1)\n\n${job("Build", "already delivered or recovered.", result("Build", "partial"))}`),
    ]));
    const { makerResults } = await scanSessions(dir, now);
    assert.deepEqual(makerResults.map((r) => [r.name, r.partial]), [["Build", true], ["Direct", false], ["Late", true]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
