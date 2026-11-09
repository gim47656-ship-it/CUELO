import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MORNING_PREAMBLE } from "./morning-prompt.ts";
import { NIGHTLY_PREAMBLE } from "./nightly.ts";
import { buildFullPrompt, buildMetricPrompt } from "./prompt.ts";
import { scanSessions } from "./sessions.ts";

const lines = (rows) => rows.map((row) => JSON.stringify(row)).join("\n");

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

test("또 counts as a complaint only at the start of the message (2026-11-05 decision)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "upkeep-leading-"));
  try {
    const now = Date.now();
    const user = (id, text) => ({ type: "message", id, timestamp: new Date(now - 60_000).toISOString(), message: { role: "user", content: text } });
    writeFileSync(join(dir, "s.jsonl"), lines([
      { type: "session", id: "S", timestamp: new Date(now - 120_000).toISOString() },
      user("a", "또 Wait 로거네 아"), user("b", " 또됨?"),
      user("c", "사무실에서는 또 클라우드쪽에어떻게넘길지 생각해볼게"), user("d", "컴퓨터또 다운됨.."), user("e", "또한 이 파일도 봐줘"),
    ]));
    const scan = await scanSessions(dir, now);
    assert.equal(scan.windows[0].complaints, 2);
    assert.deepEqual(scan.evidence["repeat-complaints"].map((row) => row.label), ["또 Wait 로거네 아", " 또됨?"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("또 right after a short interjection also counts, 또한 and mid-sentence 또 still do not (2026-11-09 decision)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "upkeep-interjection-"));
  try {
    const now = Date.now();
    const user = (id, text) => ({ type: "message", id, timestamp: new Date(now - 60_000).toISOString(), message: { role: "user", content: text } });
    writeFileSync(join(dir, "s.jsonl"), lines([
      { type: "session", id: "S", timestamp: new Date(now - 120_000).toISOString() },
      user("a", "아또 살짝버벅인다."), user("b", "아니 또 멈췄네"), user("c", "에휴.. 또야"),
      user("d", "아 또한 이것도 봐줘"), user("e", "아 그건 또 다른 문제야"), user("f", "아니요 괜찮아요"), user("g", "하나 더 또 부탁해"),
    ]));
    const scan = await scanSessions(dir, now);
    assert.deepEqual(scan.evidence["repeat-complaints"].map((row) => row.label), ["아또 살짝버벅인다.", "아니 또 멈췄네", "에휴.. 또야"]);
    assert.equal(scan.windows[0].complaints, 3);
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
    ]));
    const scan = await scanSessions(dir, now);
    const w = scan.windows[0];
    assert.deepEqual([w.calls, w.errors, w.rejects], [4, 1, 0]);
    assert.deepEqual([scan.skills.windows[0].demo.afterCalls, scan.skills.windows[0].demo.afterFailures], [3, 1]);
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
    ]));
    const scan = await scanSessions(dir, now);
    assert.deepEqual([scan.windows[0].calls, scan.windows[0].errors, scan.windows[0].rejects], [3, 1, 0]);
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
