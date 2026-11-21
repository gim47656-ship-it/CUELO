import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MORNING_PREAMBLE } from "./morning-prompt.ts";
import { NIGHTLY_PREAMBLE } from "./nightly.ts";
import { buildFullPrompt, buildMetricPrompt } from "./prompt.ts";
import { collectModelErrorCounts } from "./model-errors.ts";
import { normalizeError, scanSessions } from "./sessions.ts";

const lines = (rows) => rows.map((row) => JSON.stringify(row)).join("\n");

const mountedDispatches = (exitCode, mode = "execute") => [
  { tool: "recall", mode, exitCode, args: { query: "fixture" } },
  { tool: "git_finalize", mode, exitCode, inner: { stage: "complete" } },
];

for (const raw of [false, true]) {
  for (const [scenario, toolCommands, expected] of [
    ["historical", null, [1, 1]],
    ["successful dispatches in a failed shell", mountedDispatches(0), [1, 1]],
    ["failed dispatches in a successful shell", mountedDispatches(1), [1, 0]],
    ["help and malformed metadata", [
      ...mountedDispatches(0, "help"), ...mountedDispatches("0"),
      ["recall", "execute", 0], { tool: "git_finalize", mode: "execute" },
    ], [0, 0]],
  ]) {
    test(`recall attempts and finalize opportunities: ${scenario} (${raw ? "raw fallback" : "native projection"})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "upkeep-dispatches-"));
      try {
        const now = Date.now(), timestamp = new Date(now - 5000).toISOString();
        const row = (id, message) => ({ type: "message", id, timestamp, message });
        const rows = toolCommands === null ? [
          row("historical-call", { role: "assistant", content: [
            { type: "toolCall", id: "recall", name: "write", arguments: { path: "xd://recall" } },
          ] }),
          row("historical-result", { role: "toolResult", toolName: "git_finalize", isError: false }),
        ] : [
          row("mounted-result", { role: "toolResult", toolName: "bash", isError: scenario.startsWith("successful"),
            content: [{ type: "text", text: "recall: success\ngit_finalize: 기억 export 실패" }], details: { toolCommands } }),
        ];
        // serde rejects duplicate recognized fields; JSON.parse uses the last value.
        const jsonl = raw ? lines(rows).replaceAll('"role":', '"role":"ignored","role":') : lines(rows);
        writeFileSync(join(dir, "s.jsonl"), jsonl);
        const { windows } = await scanSessions(dir, now);
        const { recallCalls, finalizeResults, exportFailures } = windows[0];
        assert.deepEqual([recallCalls, finalizeResults], expected);
        assert.equal(exportFailures, 0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

test("long pasted text and prompts CUELO generates are requests but not complaints, even when they quote past complaints", async () => {
  const dir = mkdtempSync(join(tmpdir(), "upkeep-generated-"));
  try {
    const now = Date.now();
    const report = JSON.parse(readFileSync(new URL("./fixture-report.json", import.meta.url), "utf8"));
    const quoted = "\n- 백그라운드로 또 모하고있냐? · 눌렀는데 왜 안됬지..";
    const generated = [
      buildFullPrompt(report), buildMetricPrompt(report, "complaints", "repeat-complaints"), MORNING_PREAMBLE, NIGHTLY_PREAMBLE,
    ].map((text) => text + quoted);
    // 300자까지는 사용자가 한 말로 센다(경계).
    const atLimit = "또 안 되잖아".padEnd(300, ".");
    const pasted = `${"조사 결과를 붙여 넣습니다. ".repeat(20)}또 다른 저장소도 있습니다.`;
    const user = (id, text) => ({ type: "message", id, timestamp: new Date(now - 60_000).toISOString(), message: { role: "user", content: text } });
    writeFileSync(join(dir, "s.jsonl"), lines([
      { type: "session", id: "S", timestamp: new Date(now - 120_000).toISOString() },
      ...generated.map((text, i) => user(`g${i}`, text)),
      user("p1", pasted), user("p2", `${atLimit}.`),
      user("u1", "또 안 되잖아"), user("u2", atLimit),
    ]));
    const scan = await scanSessions(dir, now);
    assert.equal(scan.windows[0].turns, 8);
    assert.equal(scan.windows[0].complaints, 2);
    assert.deepEqual(scan.evidence["repeat-complaints"].map((row) => row.label), ["또 안 되잖아", atLimit.slice(0, 120)]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a child session's copy of a rewritten session does not hide the original's user requests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "upkeep-child-copy-"));
  try {
    const now = Date.now();
    const header = { type: "session", id: "S", timestamp: new Date(now - 120_000).toISOString() };
    const request = { type: "message", id: "a", timestamp: new Date(now - 60_000).toISOString(), message: { role: "user", content: "빌드 다시 해줘" } };
    // seance 하위 세션이 원본 기록을 복사해 둔 뒤, 원본 파일이 통째로 다시 쓰여 생성 시각이 사본보다 늦어진 경우다.
    mkdirSync(join(dir, "cwd", "P"), { recursive: true });
    writeFileSync(join(dir, "cwd", "P", "History.jsonl"), lines([{ type: "session", id: "C", timestamp: header.timestamp }, request]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(join(dir, "cwd", "s.jsonl"), lines([header, request]));
    const scan = await scanSessions(dir, now);
    assert.equal(scan.windows[0].turns, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("또 counts anywhere in the message except the conjunctions 또는 and 또한 (2026-11-12 decision)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "upkeep-again-"));
  try {
    const now = Date.now();
    const user = (id, text) => ({ type: "message", id, timestamp: new Date(now - 60_000).toISOString(), message: { role: "user", content: text } });
    writeFileSync(join(dir, "s.jsonl"), lines([
      { type: "session", id: "S", timestamp: new Date(now - 120_000).toISOString() },
      user("a", "또 Wait 로거네 아"), user("b", "아또 살짝버벅인다."), user("c", "지금또 바탕화면에 안보이네독이"),
      user("d", "블루투스머시기뜨네또"), user("e", "f5 또안눌리는데"),
      user("f", "브라우저 또는 앱이 안전하지 않을 수 있습니다"), user("g", "또한 이 파일도 봐줘"), user("h", "아 또한 이것도 봐줘"),
    ]));
    const scan = await scanSessions(dir, now);
    assert.deepEqual(scan.evidence["repeat-complaints"].map((row) => row.label), [
      "또 Wait 로거네 아", "아또 살짝버벅인다.", "지금또 바탕화면에 안보이네독이", "블루투스머시기뜨네또", "f5 또안눌리는데",
    ]);
    assert.equal(scan.windows[0].complaints, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

// 세션 줄은 JSON.parse가 읽는 대로 읽는다. 줄 끝(CR·CRLF), 이스케이프한 키, 겹친 키(뒤의 값), 깨진 바이트(U+FFFD),
// 짝 없는 서로게이트, 이미지 블록이 섞여도 같은 값을 센다.
test("session lines are read as JSON.parse reads them, whatever the line ending, key escapes, duplicate keys or broken bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "upkeep-lines-"));
  try {
    const now = Date.now(), timestamp = new Date(now - 5000).toISOString();
    const row = (text) => Buffer.from(text, "utf8");
    writeFileSync(join(dir, "s.jsonl"), Buffer.concat([
      row(`${JSON.stringify({ type: "session", id: "S", timestamp })}\r\n`),
      row(`{"\\u0074ype":"message","id":"u1","timestamp":"${timestamp}","message":{"role":"\\u0075ser","content":"또 안 되잖아 escaped"}}\r`),
      row(`{"type":"message","id":"u2","timestamp":"${timestamp}","message":{"role":"user","content":"또 깨진 `), Buffer.from([0xff, 0xe2, 0x82]), row(` 바이트"}}\n`),
      row(`{"type":"message","id":"a1","timestamp":"${timestamp}","message":{"role":"assistant","content":[{"type":"thinking","thinking":"x"},`
        + `{"type":"text","type":"toolCall","id":"k1","name":"edit","arguments":{"path":"a.ts","note":"lone \\ud800 kept"}}]}}\n`),
      row(`{"type":"message","id":"r1","timestamp":"${timestamp}","message":{"role":"toolResult","toolCallId":"k1","toolName":"edit","isError":false,"isError":true,`
        + `"content":[{"type":"image","data":"${"Q".repeat(5000)}"},{"type":"text","text":"Edit failed\\nAPI_KEY=abc"}]}}`),
    ]));
    const scan = await scanSessions(dir, now);
    const w = scan.windows[0];
    assert.deepEqual([w.turns, w.complaints, w.calls, w.errors], [2, 2, 1, 1]);
    assert.deepEqual(scan.evidence["repeat-complaints"].map((r) => [r.sessionId, r.label]), [["S", "또 안 되잖아 escaped"], ["S", "또 깨진 \uFFFD\uFFFD 바이트"]]);
    assert.deepEqual(Object.values(scan.failureExcerpts), [[{ args: "path=a.ts note=lone \ud800 kept", error: "Edit failed API_KEY=[가림]", recovery: null }]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 사전 점검 플러그인(argon-preflight)이 lab_goal·task·maker_route를 일부러 막고 돌려주는 조언은 "오류가 아니다"로 시작한다.
// 다시 부르면 통과하는 하네스 안내라 도구 실패·발주 거절·스킬 연 뒤 오류로 세지 않는다(2026-11-08 android-cli 오판정).
test("preflight advice that blocks a call is not a tool failure, a dispatch reject or a failure after a skill was opened", async () => {
  const dir = mkdtempSync(join(tmpdir(), "upkeep-preflight-"));
  try {
    const now = Date.now(), timestamp = new Date(now - 5000).toISOString();
    const msg = (id, message) => ({ type: "message", id, timestamp, message });
    const call = (id, name, args) => msg(`a-${id}`, { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
    const result = (id, toolName, isError, text) => msg(`r-${id}`, { role: "toolResult", toolCallId: id, toolName, isError, content: [{ type: "text", text }] });
    const advice = "[사전 점검] 오류가 아니다. 발주 직전에 model(3.0초)이 사용자의 최근 말과 계획을 대 본 조언이다.\n맞는 것은 계획에 반영하고, 같은 도구(maker_route)를 다시 불러라.";
    writeFileSync(join(dir, "s.jsonl"), lines([
      { type: "session", id: "S", timestamp },
      msg("u1", { role: "user", content: "앱 정리해 줘" }),
      call("k1", "read", { path: "skill://demo" }), result("k1", "read", false, "skill body"),
      call("k2", "lab_goal", { op: "frame" }), result("k2", "lab_goal", true, advice.replace("발주", "작업 목표")),
      call("k3", "maker_route", { tasks: [] }), result("k3", "maker_route", true, advice),
      call("k4", "bash", { command: "adb devices" }), result("k4", "bash", true, "bash: line 1: adb: command not found\n\nCommand exited with code 127"),
      call("k5", "eval", { language: "py", code: "await tool.maker_route(plan)" }),
      result("k5", "eval", true, `Traceback (most recent call last):\n  File "<cell>", line 503, in _bridge_call\nRuntimeError: ${advice}\n\nCommand exited with code 1`),
      call("k6", "eval", { language: "py", code: "print('routing'); await tool.maker_route(plan)" }),
      result("k6", "eval", true, `routing\nTraceback (most recent call last):\n  File "<cell>", line 503, in _bridge_call\nRuntimeError: ${advice}\n\nCommand exited with code 1`),
    ]));
    const scan = await scanSessions(dir, now);
    const w = scan.windows[0];
    assert.deepEqual([w.calls, w.errors, w.rejects], [6, 1, 0]);
    assert.deepEqual([scan.skills.windows[0].demo.afterCalls, scan.skills.windows[0].demo.afterFailures], [5, 1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// core shake는 세션 파일의 오래된 도구 결과를 `[shaken ~N tokens — recover: artifact://<id> (region <n>)]`로 바꾸고 원문을
// 세션 artifact 폴더의 `<id>.shake.log`에 남긴다. 분류는 원문으로 한다(2026-11-13 사무실: shake된 사전 점검 안내 4건이 발주 거절로 세어짐).
test("a shaken tool result is classified by its original text from the session's shake artifact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "upkeep-shaken-"));
  try {
    const now = Date.now(), timestamp = new Date(now - 5000).toISOString();
    const msg = (id, message) => ({ type: "message", id, timestamp, message });
    const call = (id, name, args) => msg(`a-${id}`, { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
    const result = (id, toolName, text) => msg(`r-${id}`, { role: "toolResult", toolCallId: id, toolName, isError: true, content: [{ type: "text", text }] });
    const advice = "[사전 점검] 오류가 아니다. 발주 직전에 model(3.0초)이 사용자의 최근 말과 계획을 대 본 조언이다.\n맞는 것은 계획에 반영하고, 같은 도구(maker_route)를 다시 불러라.";
    // 원문 안의 다음 번호 머리 모양 줄은 뒤에 빈 줄이 없으므로 region 경계가 아니다.
    const reject = "context='PREPARED_CONTEXT'인데 exact prepared 참조가 없습니다.\n### region 3 (task, ~1 tok)\n둘째 줄";
    writeFileSync(join(dir, "s.jsonl"), lines([
      { type: "session", id: "S", timestamp },
      msg("u1", { role: "user", content: "코어 올려 줘" }),
      call("k1", "maker_route", { tasks: [] }), result("k1", "maker_route", "[shaken ~2285 tokens — recover: artifact://7 (region 1)]"),
      call("k2", "task", { tasks: [] }), result("k2", "task", "[shaken ~90 tokens — recover: local://7.log (region 2)]"),
      call("k3", "task", { tasks: [] }), result("k3", "task", "[shaken ~2018 tokens — recover: artifact://7 (region 3)]"),
      call("k4", "task", { tasks: [] }), result("k4", "task", "[shaken ~50 tokens — recover: artifact://8 (region 1)]"),
    ]));
    mkdirSync(join(dir, "s"));
    writeFileSync(join(dir, "s", "7.shake.log"), [
      "### region 1 (maker_route, ~2285 tok)", "", advice, "",
      "### region 2 (task, ~90 tok)", "", advice, "",
      "### region 3 (task, ~2018 tok)", "", advice.replace("maker_route", "task"), "",
    ].join("\n"));
    mkdirSync(join(dir, "s", "local"));
    writeFileSync(join(dir, "s", "local", "7.log"), ["### region 2 (task, ~90 tok)", "", reject, ""].join("\n"));
    const scan = await scanSessions(dir, now);
    // 원문이 사전 점검 안내인 두 건은 빠지고, 원문이 실제 거절인 한 건과 원문 파일이 없는 자리표시 한 건은 남는다.
    if (process.platform !== "linux") {
      assert.deepEqual([scan.windows[0].calls, scan.windows[0].errors, scan.windows[0].rejects], [4, 4, 4]);
      assert.ok(Object.values(scan.failureExcerpts).flat().every((row) => row.error.startsWith("[shaken ~")));
      return;
    }
    assert.deepEqual([scan.windows[0].calls, scan.windows[0].errors, scan.windows[0].rejects], [4, 2, 2]);
    assert.deepEqual(Object.values(scan.failureExcerpts).flat().map((row) => row.error).sort(), [reject.replaceAll("\n", " "), "[shaken ~50 tokens — recover: artifact://8 (region 1)]"].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 실제 실패 14일 표본(2026-11-08): bash 「(no output)」 111건과 eval Traceback 머리 63건이 각각 한 묶음으로 뭉쳐
// 원인별 집계가 보이지 않았다. 첫 줄 대신 원인을 말하는 줄(terminal exception, 실제 오류 줄, exit만 남은 실패)을 쓴다.
test("failures group by their cause line, not by a Traceback head, a no-output marker or an exit line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "upkeep-cause-"));
  try {
    const now = Date.now(), timestamp = new Date(now - 5000).toISOString();
    const msg = (id, message) => ({ type: "message", id, timestamp, message });
    const call = (id, name, args) => msg(`a-${id}`, { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
    const result = (id, toolName, isError, text) => msg(`r-${id}`, { role: "toolResult", toolCallId: id, toolName, isError, content: [{ type: "text", text }] });
    writeFileSync(join(dir, "s.jsonl"), lines([
      { type: "session", id: "S", timestamp },
      msg("u1", { role: "user", content: "점검해 줘" }),
      call("k1", "eval", { code: "import websockets" }),
      result("k1", "eval", true, "Traceback (most recent call last):\n  File \"<cell>\", line 9, in <module>\nModuleNotFoundError: No module named 'websockets'\n\nCommand exited with code 1"),
      call("k2", "bash", { command: "python3 x.py" }),
      result("k2", "bash", true, "Traceback (most recent call last):\n  File \"<string>\", line 3, in <module>\nKeyError: 'message'\n\nCommand exited with code 1"),
      call("k3", "bash", { command: "true" }),
      result("k3", "bash", true, "(no output)\n\nCommand exited with code 1"),
      call("k4", "bash", { command: "true" }),
      result("k4", "bash", true, "(no output)\n\nCommand exited with code 2"),
      call("k5", "bash", { command: "f() {" }),
      result("k5", "bash", true, "bash: -c: line 1: unexpected EOF while looking for matching `\"'\n\nCommand exited with code 2"),
    ]));
    const scan = await scanSessions(dir, now);
    assert.deepEqual(Object.keys(scan.windows[0].errorsBySignature).sort(), [
      "bash: Command exited with code 1",
      "bash: Command exited with code 2",
      "bash: KeyError: 'message'",
      "bash: bash: -c: line N: unexpected EOF while looking for matching `\"'",
      "eval: ModuleNotFoundError: No module named 'websockets'",
    ]);
    assert.equal(scan.windows[0].errors, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only the exact preflight advisory first lines are excluded, never a real failure that quotes them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "upkeep-advice-"));
  try {
    const now = Date.now(), timestamp = new Date(now - 5000).toISOString();
    const msg = (id, message) => ({ type: "message", id, timestamp, message });
    const call = (id, name, args) => msg(`a-${id}`, { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
    const result = (id, toolName, isError, text) => msg(`r-${id}`, { role: "toolResult", toolCallId: id, toolName, isError, content: [{ type: "text", text }] });
    const body = "작업 목표 직전에 aistudio/gemini-4-argon(7.5초)이 계획을 대 봤다.";
    writeFileSync(join(dir, "s.jsonl"), lines([
      { type: "session", id: "S", timestamp },
      msg("u1", { role: "user", content: "발주해 줘" }),
      call("k1", "lab_goal", { op: "frame" }), result("k1", "lab_goal", true, `Error: [사전 점검] 오류가 아니다. ${body}`),
      call("k2", "maker_route", { tasks: [] }), result("k2", "maker_route", true, `[아르곤 사전 점검] 오류가 아니다. ${body}`),
      // 문구가 본문에 섞인 실제 실패는 조언이 아니다.
      call("k3", "bash", { command: "bun test" }),
      result("k3", "bash", true, "bun test failed after the [사전 점검] 오류가 아니다. advice\n\nCommand exited with code 1"),
      call("k4", "eval", { language: "py", code: "raise ValueError(advice)" }),
      result("k4", "eval", true, `Traceback (most recent call last):\n  File "<cell>", line 1, in <module>\nValueError: [사전 점검] 오류가 아니다. ${body}\n\nCommand exited with code 1`),
      call("k5", "eval", { language: "py", code: "handle_failed_advice()" }),
      result("k5", "eval", true, `Traceback (most recent call last):\n  File "<cell>", line 1, in <module>\nRuntimeError: [사전 점검] 오류가 아니다. ${body}\n\nDuring handling of the above exception, another exception occurred:\n\nTraceback (most recent call last):\n  File "<cell>", line 4, in <module>\nValueError: recovery failed\n\nCommand exited with code 1`),
      ...["KeyboardInterrupt", "subprocess.TimeoutExpired: Command timed out", "SystemExit: 2"].flatMap((exception, index) => [
        call(`chain-${index}`, "eval", { language: "py", code: "handle_failed_advice()" }),
        result(`chain-${index}`, "eval", true, `Traceback (most recent call last):\n  File "<cell>", line 1, in <module>\nRuntimeError: [사전 점검] 오류가 아니다. ${body}\n\nDuring handling of the above exception, another exception occurred:\n\nTraceback (most recent call last):\n  File "<cell>", line 4, in <module>\n${exception}\n\nCommand exited with code 1`),
      ]),
      call("timeout", "eval", { language: "py", code: "print(saved_traceback); long_work()" }),
      result("timeout", "eval", true, `log:\nTraceback (most recent call last):\n  File "<cell>", line 1, in <module>\nRuntimeError: [사전 점검] 오류가 아니다. ${body}\nstill working\n\nCommand timed out after 30 seconds`),
    ]));
    const scan = await scanSessions(dir, now);
    assert.deepEqual([scan.windows[0].calls, scan.windows[0].errors, scan.windows[0].rejects], [9, 7, 0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 11-12 사용자 결정: 하네스가 일부러 막거나 안내한 호출은 도구 실패로 세지 않는다.
test("harness blocks (edit anchor, image router, draft coverage, eval gate) are not tool failures, but quoting them is", async () => {
  const dir = mkdtempSync(join(tmpdir(), "upkeep-harness-"));
  try {
    const now = Date.now(), timestamp = new Date(now - 5000).toISOString();
    const msg = (id, message) => ({ type: "message", id, timestamp, message });
    const call = (id, name, args) => msg(`a-${id}`, { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
    const result = (id, toolName, isError, text) => msg(`r-${id}`, { role: "toolResult", toolCallId: id, toolName, isError, content: [{ type: "text", text }] });
    const blocks = [
      ["edit", "This edit anchors to lines 10 of HANDOFF.md that [HANDOFF.md#2D6B] never displayed (it showed a partial range, a search hit, or a folded summary). Actual file content at those lines:\n  10:x"],
      ["edit", "This edit anchors to lines 33 of HANDOFF.md, which exceed the display column cap, and no retained read shows them in full."],
      ["edit", "이 edit는 README.md의 132번 줄을 기준으로 했지만, [README.md#2D6B] 스냅샷은 그 줄을 온전히 보여 준 적이 없다."],
      ["read", "image-question-router: 이미지는 먼저 vision 모델에게 묻는다. 직접 읽기를 막았다.\n`a.png?q=<질문>`으로 read하라."],
      ["edit", "[draft-coverage] 아직 쓰지 않았다. /tmp/a.md에 새로 더하는 글 1덩어리(40자)가 없다"],
      ["eval", "[EvalGateGuard] eval 안에서 git_finalize/git_integrate/cross_review/slop_check/deploy_verify를 부르지 마세요."],
      ["eval", "Traceback (most recent call last):\n  File \"<cell>\", line 1, in <module>\nRuntimeError: [EvalGateGuard] eval 안에서 git_finalize를 부르지 마세요.\n\nCommand exited with code 1"],
    ];
    writeFileSync(join(dir, "s.jsonl"), lines([
      { type: "session", id: "S", timestamp },
      msg("u1", { role: "user", content: "고쳐 줘" }),
      ...blocks.flatMap(([tool, text], index) => [call(`b${index}`, tool, {}), result(`b${index}`, tool, true, text)]),
      // 표지가 첫 줄이 아니면 실제 실패다.
      call("q1", "bash", { command: "bun test" }),
      result("q1", "bash", true, "test failed: expected [draft-coverage] notice\n\nCommand exited with code 1"),
      call("q2", "read", { path: "a.md" }),
      result("q2", "read", true, "ENOENT: no such file, image-question-router: 이미지는 먼저 vision 모델에게 묻는다."),
    ]));
    const scan = await scanSessions(dir, now);
    assert.deepEqual([scan.windows[0].calls, scan.windows[0].errors], [blocks.length + 2, 2]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 공개 이슈 #77: Pydantic 필드 별칭(`Name`, `DisplayName`)이 실제 예외를 밀어내지 않아야 한다.
test("a validation error keeps its own line when the model field name is CamelCase", async () => {
  const dir = mkdtempSync(join(tmpdir(), "upkeep-alias-"));
  try {
    const now = Date.now(), timestamp = new Date(now - 5000).toISOString();
    const msg = (id, message) => ({ type: "message", id, timestamp, message });
    const call = (id, name, args) => msg(`a-${id}`, { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
    const result = (id, toolName, isError, text) => msg(`r-${id}`, { role: "toolResult", toolCallId: id, toolName, isError, content: [{ type: "text", text }] });
    const traceback = (field) => `Traceback (most recent call last):\n  File "<string>", line 1, in <module>\n    model.model_validate({})\npydantic_core._pydantic_core.ValidationError: 1 validation error for Payload\n${field}\n  Field required [type=missing, input_value={}, input_type=dict]\n    For further information visit https://errors.pydantic.dev/2.13/v/missing`;
    writeFileSync(join(dir, "s.jsonl"), lines([
      { type: "session", id: "S", timestamp },
      msg("u1", { role: "user", content: "검증해 줘" }),
      call("k1", "eval", { code: "a" }), result("k1", "eval", true, traceback("name")),
      call("k2", "eval", { code: "b" }), result("k2", "eval", true, traceback("Name")),
      call("k3", "eval", { code: "c" }), result("k3", "eval", true, traceback("DisplayName")),
      // 별칭 보완이 지켜야 할 기존 계약: 메시지 없는 사용자 정의 예외, 메시지 있는 예외와 뒤따르는 로그 줄.
      call("k4", "eval", { code: "d" }), result("k4", "eval", true, 'Traceback (most recent call last):\n  File "a.py", line 2\nMyWeirdFailure'),
      call("k5", "eval", { code: "e" }), result("k5", "eval", true, 'Traceback (most recent call last):\n  File "a.py", line 3\nCustomProblem: nope\nINFO:     Shutting down'),
      // 교차 검토 R1-OAI-1: 모델 표시 이름(model title)에 공백이 있어도 별칭을 예외로 세지 않는다.
      call("k6", "eval", { code: "f" }), result("k6", "eval", true, 'Traceback (most recent call last):\n  File "<string>", line 1\nValidationError: 1 validation error for User Profile\nDisplayName\n  Field required'),
      // 교차 검토 R1-OAI-2: 새 Traceback 머리 없이 연결 구분 줄 뒤에 오는 마지막 실제 예외를 잃지 않는다.
      call("k7", "eval", { code: "g" }), result("k7", "eval", true, 'Traceback (most recent call last):\n  File "<string>", line 1\nValidationError: 1 validation error for Payload\nName\n\nThe above exception was the direct cause of the following exception:\n\nCustomFailure'),
    ]));
    const scan = await scanSessions(dir, now);
    // 세 필드 이름 모두 같은 실제 원인으로 묶인다(필드 이름이 묶음 키를 바꾸지 않는다).
    assert.deepEqual(scan.windows[0].errorsBySignature, {
      "eval: MyWeirdFailure": 1,
      "eval: CustomProblem: nope": 1,
      "eval: ValidationError: N validation error for User Profile": 1,
      "eval: CustomFailure": 1,
      "eval: pydantic_core._pydantic_core.ValidationError: N validation error for Payload": 3,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 교차 검토 R1-ANT-1~4: CRLF 결과, pydantic 필드 줄, 배너로 시작하는 bash 실패, 문구가 본문에 섞인 실패.
test("a CRLF traceback, a validation field line and a banner line still group by their cause", async () => {
  const dir = mkdtempSync(join(tmpdir(), "upkeep-cause2-"));
  try {
    const now = Date.now(), timestamp = new Date(now - 5000).toISOString();
    const msg = (id, message) => ({ type: "message", id, timestamp, message });
    const call = (id, name, args) => msg(`a-${id}`, { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
    const result = (id, toolName, isError, text) => msg(`r-${id}`, { role: "toolResult", toolCallId: id, toolName, isError, content: [{ type: "text", text }] });
    writeFileSync(join(dir, "s.jsonl"), lines([
      { type: "session", id: "S", timestamp },
      msg("u1", { role: "user", content: "점검해 줘" }),
      call("k1", "eval", { code: "x" }),
      result("k1", "eval", true, 'Traceback (most recent call last):\r\n  File "<cell>", line 9\r\nKeyError: \'x\'\r\n'),
      call("k2", "eval", { code: "y" }),
      result("k2", "eval", true, 'Traceback (most recent call last):\n  File "<cell>", line 1\npydantic_core._pydantic_core.ValidationError: 1 validation error for M\nname\n  Field required'),
      call("k3", "bash", { command: "bun test" }),
      result("k3", "bash", true, "bun test v1.1.0\nerror: expected 1 to be 2\n\nCommand exited with code 1"),
      // 로그 줄(전부 대문자인 표지)은 예외가 아니고, 들여 쓴 오류 줄은 같은 묶음이어야 한다.
      call("k4", "eval", { code: "z" }),
      result("k4", "eval", true, 'Traceback (most recent call last):\n  File "a.py", line 1, in <module>\nValueError: bad\nINFO:     Shutting down'),
      call("k5", "bash", { command: "x" }),
      result("k5", "bash", true, "  error: expected 1 to be 2\n\nCommand exited with code 1"),
      // 연결된 traceback은 마지막(terminal) 예외를 쓴다. 이름에 숫자가 있어도 예외 클래스다.
      call("k6", "eval", { code: "w" }),
      result("k6", "eval", true, 'Traceback (most recent call last):\n  File "a", line 1\nbotocore.exceptions.ClientError: x\n\nThe above exception was the direct cause of the following exception:\n\nTraceback (most recent call last):\n  File "b", line 2\nboto3.exceptions.S3UploadFailedError: y'),
    ]));
    const scan = await scanSessions(dir, now);
    assert.deepEqual(Object.keys(scan.windows[0].errorsBySignature).sort(), [
      "bash: error: expected N to be N",
      "eval: KeyError: 'x'",
      "eval: ValueError: bad",
      "eval: botoN.exceptions.SNUploadFailedError: y",
      "eval: pydantic_core._pydantic_core.ValidationError: N validation error for M",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("context load counts injected messages by kind and same-result reads, and a compaction starts the repeat check over", async () => {
  const dir = mkdtempSync(join(tmpdir(), "upkeep-context-load-"));
  try {
    const now = Date.now(), timestamp = new Date(now - 5000).toISOString();
    const msg = (id, message, at = timestamp) => ({ type: "message", id, timestamp: at, message });
    const inject = (id, customType, content) => ({ type: "custom_message", id, customType, timestamp, content });
    const call = (id, path, at) => msg(`a-${id}`, { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path, i: `reading ${id}` } }] }, at);
    const result = (id, text, isError = false, at = timestamp) => msg(`r-${id}`, { role: "toolResult", toolCallId: id, toolName: "read", isError, content: [{ type: "text", text }] }, at);
    const read = (id, path, text, isError = false) => [call(id, path), result(id, text, isError)];
    const nudge = "todo 없이 다섯 번째 도구 호출이다.";
    const week = 7 * 86_400_000;
    writeFileSync(join(dir, "s.jsonl"), lines([
      { type: "session", id: "S", timestamp },
      msg("u1", { role: "user", content: "고쳐 줘" }),
      inject("n1", "todo-nudge", nudge), inject("n2", "todo-nudge", nudge), inject("n3", "my plugin!", "x"),
      // 상속 속성 이름도 자기 행이 되고, 종류와 내용의 경계가 다른 두 메시지는 반복이 아니다.
      inject("n5", "constructor", "c"), inject("n6", "a\nb", "c"), inject("n7", "a", "b\nc"),
      ...read("k1", "a.ts:1-5", "AAA"), ...read("k2", "a.ts:1-5", "AAA"), ...read("k3", "a.ts:1-5", "nope", true),
      // A, B, A: 세 번째는 압축 뒤 이미 받은 결과다. 호출이 이 파일에 없는 결과도 크기는 센다(반복 판정만 못 한다).
      ...read("k6", "a.ts:1-5", "BBB"), ...read("k7", "a.ts:1-5", "AAA"), result("k8", "AAA"),
      // 호출은 7일 창 밖, 결과는 창 안: 결과가 모델에 들어간 시각으로 센다.
      call("k9", "b.ts", new Date(now - week - 1000).toISOString()), result("k9", "CCC", false, new Date(now - week + 1000).toISOString()),
      { type: "compaction", id: "c1", timestamp },
      inject("n4", "todo-nudge", nudge),
      ...read("k4", "a.ts:1-5", "AAA"), ...read("k5", "a.ts:1-5", "BBB"),
    ]));
    const { contextLoad } = await scanSessions(dir, now);
    assert.deepEqual({ ...contextLoad.injected }, {
      "todo-nudge": { count: 3, size: nudge.length * 3, repeats: 1, repeatSize: nudge.length },
      other: { count: 2, size: 2, repeats: 0, repeatSize: 0 },
      constructor: { count: 1, size: 1, repeats: 0, repeatSize: 0 },
      a: { count: 1, size: 3, repeats: 0, repeatSize: 0 },
    });
    assert.equal(Object.hasOwn(Object, "count"), false);
    // read 크기는 저장된 content JSON 값의 UTF-8 바이트다: [{"type":"text","text":"AAA"}]
    const stored = Buffer.byteLength(JSON.stringify([{ type: "text", text: "AAA" }]));
    assert.deepEqual(contextLoad.reads, { count: 8, size: stored * 8, repeats: 2, repeatSize: stored * 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fork's copied read results seed its repeat check without being counted twice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "upkeep-context-fork-"));
  try {
    const now = Date.now(), timestamp = new Date(now - 5000).toISOString();
    const msg = (id, message) => ({ type: "message", id, timestamp, message });
    const read = (id, text) => [
      msg(`a-${id}`, { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "p" } }] }),
      msg(`r-${id}`, { role: "toolResult", toolCallId: id, toolName: "read", isError: false, content: [{ type: "text", text }] }),
    ];
    writeFileSync(join(dir, "parent.jsonl"), lines([{ type: "session", id: "P", timestamp }, ...read("k1", "AAA"), ...read("k2", "AAA")]));
    writeFileSync(join(dir, "fork.jsonl"), lines([{ type: "session", id: "F", timestamp }, ...read("k1", "AAA"), ...read("k3", "AAA")]));
    const { contextLoad } = await scanSessions(dir, now);
    assert.deepEqual([contextLoad.reads.count, contextLoad.reads.repeats], [3, 2]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PC export counts Codex system-param and whitespace-stream errors with their outcome, once per entry, child sessions included", async () => {
  const dir = mkdtempSync(join(tmpdir(), "upkeep-model-errors-"));
  try {
    const now = Date.now();
    const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
    const ws = "Codex stream stopped: whitespace-only tool-call argument delta events exceeded the limit";
    const reply = (id, min, extra = {}) => ({ type: "message", id, timestamp: at(min), message: { role: "assistant", content: [], provider: "openai-codex", model: "gpt-6.2-sol", stopReason: "stop", ...extra } });
    const failed = (id, min, errorMessage) => reply(id, min, { stopReason: "error", errorMessage });
    const user = (id, min) => ({ type: "message", id, timestamp: at(min), message: { role: "user", content: "다음" } });
    const top = lines([
      { type: "session", id: "S", timestamp: at(100) },
      user("u1", 90), reply("a1", 89), reply("g1", 88, { provider: "google", model: "gemini" }),
      failed("e1", 80, ws), { type: "model_change", id: "m1", timestamp: at(79), model: "anthropic/claude-sonnet-5-5" },
      user("u2", 70), failed("e2", 69, ws), user("u3", 60),
      failed("e4", 40, ws), reply("a4", 39),
      failed("e5", 30, ws),
      failed("old", 20 * 24 * 60, "400 Unsupported parameter: system"),
    ]);
    mkdirSync(join(dir, "cwd", "P"), { recursive: true });
    writeFileSync(join(dir, "cwd", "s.jsonl"), top);
    writeFileSync(join(dir, "cwd", "P", "maker.jsonl"), lines([{ type: "session", id: "C", timestamp: at(50) }, failed("c1", 45, "400 Unsupported parameter: system")]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // fork 사본은 원본 entry를 그대로 복사한다. 같은 오류를 두 번 세지 않는다.
    writeFileSync(join(dir, "cwd", "fork.jsonl"), top);
    const scan = await scanSessions(dir, now, [], [], true);
    const total = (field) => scan.modelErrors.days.reduce((n, day) => n + day[field], 0);
    assert.equal(scan.modelErrors.partial, false);
    assert.deepEqual(
      ["assistant", "codex", "systemParam", "whitespace", "whitespaceRecovered", "whitespaceUnrecovered", "whitespacePending"].map(total),
      [8, 7, 1, 4, 2, 1, 1],
    );
    assert.equal((await scanSessions(dir, now)).modelErrors, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an ego lite upgrade notice line never becomes the ego_browser failure key", () => {
  const notice = "[ego-browser:notice] ego lite 1.3.5 is available (current 1.3.3) — run: ego-browser upgrade in your shell, then re-read the ego-browser skill";
  assert.equal(
    normalizeError("ego_browser", `ego_browser: exit 1. TaskSpace cuelo-x-user\n${notice}\n[stderr] SyntaxError: Identifier 'task' has already been declared`),
    "[stderr] SyntaxError: Identifier 'task' has already been declared",
  );
  assert.equal(normalizeError("ego_browser", `ego_browser: exit 1.\n${notice}\nTypeError: page.click is not a function`), "TypeError: page.click is not a function");
  assert.equal(normalizeError("ego_browser", `  ${notice}\nPermission denied`), "Permission denied");
  assert.equal(normalizeError("ego_browser", `${notice}\nTypeError: x`), "TypeError: x");
  assert.equal(normalizeError("ego_browser", `${notice}\n\nPermission denied`), "Permission denied");
  assert.equal(normalizeError("ego_browser", `\n${notice}`), normalizeError("ego_browser", notice));
});

test("model error collector: Codex only, today plus 13 UTC days, nothing after now, copies keep the later outcome, Maker messages are not human turns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "upkeep-model-errors-unit-"));
  try {
    const now = Date.parse("2026-11-21T12:00:00.000Z");
    const ws = "whitespace-only tool-call argument delta events";
    const msg = (id, timestamp, message) => ({ type: "message", id, timestamp, message });
    const codex = (id, timestamp, extra = {}) => msg(id, timestamp, { role: "assistant", provider: "openai-codex", model: "m", stopReason: "stop", ...extra });
    const stall = (id, timestamp, extra = {}) => codex(id, timestamp, { stopReason: "error", errorMessage: ws, ...extra });
    const file = (name, rows, tail = "") => { const path = join(dir, name); writeFileSync(path, lines(rows) + tail); return path; };
    const top = file("top.jsonl", [
      msg("g", "2026-11-21T10:00:00.000Z", { role: "assistant", provider: "google", model: "g", stopReason: "error", errorMessage: "400 Unsupported parameter: system" }),
      stall("s1", "2026-11-21T10:01:00.000Z", { model: undefined }), codex("ok1", "2026-11-21T10:02:00.000Z", { model: undefined }),
      stall("s2", "2026-11-21T11:00:00.000Z"), { type: "model_change", id: "mx", timestamp: "invalid" },
      { type: "model_change", id: "mc", timestamp: "2026-11-21T12:30:00.000Z" },
    ]);
    const maker = file("maker.jsonl", [
      stall("s3", "2026-11-21T09:00:00.000Z"), msg("relay", "2026-11-21T09:01:00.000Z", { role: "user", content: "Main이 보낸 다음 지시" }), codex("ok3", "2026-11-21T09:02:00.000Z"),
    ]);
    const original = file("original.jsonl", [stall("s4", "2026-11-21T08:00:00.000Z")], '\n{"type":"mess');
    const fork = file("fork.jsonl", [stall("s4", "2026-11-21T08:00:00.000Z"), codex("ok4", "2026-11-21T08:05:00.000Z")]);
    const edges = file("edges.jsonl", [
      codex("before", "2026-11-07T23:59:59.000Z", { stopReason: "error", errorMessage: "Unsupported parameter: system" }),
      codex("first", "2026-11-08T00:00:00.000Z", { stopReason: "error", errorMessage: "Unsupported parameter: system" }),
    ]);
    const broken = file("broken.jsonl", [stall("s5", "2026-11-20T08:00:00.000Z")], `\n{not json\n${JSON.stringify(codex("ok5", "2026-11-20T08:01:00.000Z"))}`);
    const brokenLast = file("broken-last.jsonl", [stall("s6", "2026-11-20T09:00:00.000Z")], "\n{bad\n");
    // id가 없는 두 기록은 시각이 같아도 사본인지 알 수 없어 따로 센다.
    const idless = (name, model, rest = []) => file(name, [{ ...stall("x", "2026-11-19T08:00:00.000Z", { model }), id: undefined }, ...rest]);
    const idlessA = idless("idless-a.jsonl", "a");
    const idlessB = idless("idless-b.jsonl", "b", [codex("okb", "2026-11-19T08:01:00.000Z", { model: "b" })]);

    const result = await collectModelErrorCounts([
      { path: top, child: false }, { path: maker, child: true }, { path: original, child: false }, { path: fork, child: false }, { path: edges, child: false },
      { path: idlessA, child: false }, { path: idlessB, child: false },
    ], now);
    assert.equal(result.partial, false, "a half-written last line is an append in progress, not a lost record");
    assert.deepEqual([...result.byDay.keys()].sort(), ["2026-11-08", "2026-11-19", "2026-11-21"]);
    assert.deepEqual(result.byDay.get("2026-11-19"), { systemParam: 0, whitespace: 2, whitespaceRecovered: 1, whitespaceUnrecovered: 0, whitespacePending: 1 });
    // s1: 모델 이름 없는 응답은 같은 모델 복구가 아님, s2: 12:30 model_change는 집계 시각 뒤, s3: Maker의 사용자 메시지는 사람 요청이 아님,
    // s4: 원본에서는 결말이 없지만 fork에서 같은 모델이 답함.
    assert.deepEqual(result.byDay.get("2026-11-21"), { systemParam: 0, whitespace: 4, whitespaceRecovered: 2, whitespaceUnrecovered: 0, whitespacePending: 2 });
    assert.equal((await collectModelErrorCounts([{ path: broken, child: false }], now)).partial, true);
    assert.equal((await collectModelErrorCounts([{ path: brokenLast, child: false }], now)).partial, true, "a newline-terminated broken record was fully written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
