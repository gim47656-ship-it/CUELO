import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DREAMING_MAX_BYTES, DREAMING_MAX_EVENTS, DREAMING_WINDOW_MS, DreamingCollector, parseDreamingEvidence } from "./dreaming.ts";
import { buildNightlyExport } from "./nightly-inbox.ts";
import { maskSecrets, normalizeError, scanSessions, summarizeArgs } from "./sessions.ts";

const NOW = new Date("2026-11-19T19:00:00Z");
const at = (deltaMs = 0) => new Date(+NOW + deltaMs).toISOString();
const sessionId = "00000000-0000-4000-8000-000000000001";
const entryId = (n) => n.toString(16).padStart(8, "0");
const empty = { from: at(-DREAMING_WINDOW_MS), events: [], partial: false };
const event = (n, quote, fields = {}) => ({ sessionId, entryId: entryId(n), at: at(-n), kind: "user", quote, ...fields });
const report = JSON.parse(readFileSync(new URL("./fixture-report.json", import.meta.url), "utf8"));
const exportBundle = (dreaming, fields = {}) => buildNightlyExport({ source: "home", now: NOW, report, skillCandidates: [], errorsBySignature: {}, dreaming, ...fields });

const token = `ghp_${"A1b2C3d4E5".repeat(4)}`;
const keyPart = "Tl9FeGFtcGxlTm90QUNyZWRlbnRpYWw=";
const privateKey = `-----BEGIN ${"OPENSSH PRIVATE KEY"}-----\n${keyPart}\n-----END ${"OPENSSH PRIVATE KEY"}-----`;
const sshToken = `ibssh_${"Pretend123ABC"}`;
const flags = "sensitive demo value";
const curl = `curl -u 'demo:${flags}' https://example.invalid`;
const passwd = "demo pass with spaces";
const login = `helper --db-password '${passwd}'`;

test("export masks provider tokens and never exports credential-bearing multiline or shell quotes", () => {
  const dreaming = { ...empty, events: [
    event(1, `사용자 정정\n  첫 값은 ${token} 입니다.`),
    event(2, privateKey),
    event(3, `tailnet ${sshToken}`),
    event(4, `Command exited with code 22. Echoed ${flags}`, { kind: "failed-command", command: curl }),
    event(5, "Command exited with code 2", { kind: "failed-command", command: login }),
    event(6, 'Authorization: Basic ' + 'demoYmFzSWM='),
    event(7, "x".repeat(1197) + token),
    event(8, "fatal: denied", { kind: "failed-command", command: "mysqldump -u root -pExampleShortOpaque appdb" }),
    event(9, "fatal: denied", { kind: "failed-command", command: "git fetch https://ExampleOpaqueUser@git.example.invalid/r.git" }),
    event(10, `error: ${token}`, { kind: "failed-command", command: "echo ENCODED_SENSITIVE_VALUE" }),
    event(11, "fatal: denied", { kind: "failed-command", command: "redis-cli -a ExampleRedisFlag ping" }),
    event(12, "fatal: denied", { kind: "failed-command", command: "redis-cli ping redis://:ExampleRedisUri@db.invalid" }),
    event(13, "fatal: denied", { kind: "failed-command", command: "ldapsearch -w ExampleLdapValue" }),
    event(14, "fatal: denied", { kind: "failed-command", command: "openssl enc -k ExampleOpenSSLValue" }),
    event(15, "fatal: denied", { kind: "failed-command", command: "keytool -storepass ExampleKeystoreValue" }),
    event(16, "fatal: denied", { kind: "failed-command", command: "redis-cli --pass ExampleRedisLongFlag ping" }),
    event(17, "fatal: denied", { kind: "failed-command", command: "ldappasswd -w ExampleLdapBind -s ExampleLdapNew" }),
    event(18, "fatal: denied", { kind: "failed-command", command: "keytool -storepasswd -new ExampleNewKeystoreValue" }),
    event(19, "fatal: denied", { kind: "failed-command", command: "openssl enc -pass pass:ExampleOpenSSLPass" }),
    event(20, "fatal: denied", { kind: "failed-command", command: "redis-cli \\\n -a ExampleContinuedSecret" }),
  ] };
  const bundle = exportBundle(dreaming, { errorsBySignature: { [`bash: ${curl}`]: 1, [`bash: ${login}`]: 2, [`bash: ${sshToken}`]: 3 } });
  const json = JSON.stringify(bundle);
  assert.ok(bundle.problems.length > 0);
  assert.equal(bundle.dreaming.partial, true);
  assert.equal(bundle.dreaming.events.length, 20);
  assert.equal(bundle.dreaming.events[0].quote, "사용자 정정\n  첫 값은 [REDACTED] 입니다.");
  assert.equal(bundle.dreaming.events[1].quote, "[가림]");
  assert.equal(bundle.dreaming.events[3].quote, "[가림]");
  assert.equal(bundle.dreaming.events[6].clipped, true);
  for (const secret of [token, "ghp_", keyPart, sshToken, flags, passwd, "demoYmFzSWM=", "ExampleShortOpaque", "ExampleOpaqueUser", "ENCODED_SENSITIVE_VALUE",
    "ExampleRedisFlag", "ExampleRedisUri", "ExampleLdapValue", "ExampleOpenSSLValue", "ExampleKeystoreValue",
    "ExampleRedisLongFlag", "ExampleLdapBind", "ExampleLdapNew", "ExampleNewKeystoreValue", "ExampleOpenSSLPass", "ExampleContinuedSecret"]) {
    assert.ok(!json.includes(secret));
  }
});

test("non-credential SSH destinations and ordinary short flags stay useful in existing failure reports", () => {
  assert.match(normalizeError("bash", "fatal: Could not read from ssh://git@github.com/a.git"), /^fatal: Could not read from/);
  assert.equal(summarizeArgs({ command: "mkdir -p build" }), "command=mkdir -p build");
  assert.equal(summarizeArgs({ command: "git push -u origin main" }), "command=git push -u origin main");
});

test("eight-day range survives a late upload; newest excerpts fit the JSON byte and event caps", () => {
  const bounds = exportBundle({ ...empty, events: [
    event(1, "just in", { at: empty.from }),
    event(2, "too old", { at: at(-DREAMING_WINDOW_MS - 1) }),
    event(3, "25 hours before upload", { at: at(-25 * 3_600_000) }),
    event(4, "in the future", { at: at(1) }),
  ] }).dreaming;
  assert.deepEqual(bounds.events.map(({ quote }) => quote), ["25 hours before upload", "just in"]);
  const large = exportBundle({ ...empty, events: Array.from({ length: DREAMING_MAX_EVENTS }, (_, i) => event(i, '가"\\\n'.repeat(350))) }).dreaming;
  assert.ok(Buffer.byteLength(JSON.stringify(large)) <= DREAMING_MAX_BYTES);
  assert.equal(large.partial, true);
  assert.ok(large.events.length < DREAMING_MAX_EVENTS);
  assert.equal(large.events[0].entryId, entryId(0));
  const collector = new DreamingCollector(+NOW - DREAMING_WINDOW_MS, +NOW, maskSecrets);
  for (let i = DREAMING_MAX_EVENTS * 3; i >= 0; i--) collector.add(event(i, "short"));
  const trimmed = collector.finish();
  assert.equal(trimmed.events.length, DREAMING_MAX_EVENTS);
  assert.equal(trimmed.events[0].entryId, entryId(0));
  assert.equal(trimmed.events.at(-1).entryId, entryId(DREAMING_MAX_EVENTS - 1));
  assert.equal(trimmed.partial, true);
});

test("a masker failure withholds the entire evidence section but still builds the legacy export", () => {
  const dreaming = parseDreamingEvidence({ ...empty, events: [event(1, "clean"), event(2, "fault")] }, +NOW, (text) => {
    if (text === "fault") throw new Error("a raw error must not be reported");
    return text;
  });
  assert.equal(dreaming, null);
  const bundle = exportBundle(dreaming);
  assert.equal(bundle.version, 2);
  assert.ok(bundle.problems.length > 0);
  assert.ok(!Object.hasOwn(bundle, "dreaming"));
});

test("reads only correction/failure evidence on the stored branch, never generated or nonhuman turns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nightly-dreaming-"));
  try {
    const text = (text) => ({ type: "text", text });
    const message = (n, role, content, extra, parent = n - 1) => ({
      type: "message", id: entryId(n), parentId: parent === 0 ? null : entryId(parent),
      timestamp: at(-100_000 + n), message: { role, content, ...extra },
    });
    const cmd = (id, command) => ({ type: "toolCall", id, name: "bash", arguments: { command } });
    writeFileSync(join(dir, "session.jsonl"), [
      { type: "session", id: sessionId, timestamp: at(-8_000_000) },
      message(1, "user", [text("Run the build."), { type: "image", data: "IMAGE_CONTENT" }]),
      message(2, "assistant", [cmd("bad", "bun run check"), text("running")], { stopReason: "toolUse" }),
      message(3, "toolResult", [text("fatal: missing script\nCommand exited with code 1")], { toolCallId: "bad", toolName: "bash", isError: false, details: { exitCode: 1 } }),
      message(4, "user", "정정: 이 PC에서는\n  빌드하지 마세요."),
      message(5, "assistant", [{ type: "thinking", text: "HIDDEN_REASONING" }, text("확인: 실행하지 않았습니다.")], { stopReason: "stop" }),
      message(6, "user", "CUELO 클라우드 변경 보고 세션\nANOTHER_SESSION_TEXT"),
      message(7, "assistant", [text("GENERATED_OUTCOME")], { stopReason: "stop" }),
      message(8, "user", "AUTHORIZED_TEST: run the helper."),
      message(9, "assistant", [cmd("sensitive", login)], { stopReason: "toolUse" }),
      message(10, "toolResult", [text(`fatal: cannot run helper (${passwd})\nCommand exited with code 1`)], { toolCallId: "sensitive", toolName: "bash", isError: true }),
      message(11, "assistant", [text("무관한 답변")], { stopReason: "aborted" }),
      message(12, "user", "정정: ABANDONED_CORRECTION"),
      message(13, "user", "정정: CURRENT_CORRECTION", undefined, 11),
      { type: "custom_message", customType: "irc:incoming", id: entryId(14), parentId: entryId(13), timestamp: at(-10) },
      message(15, "assistant", [text("IRC_OUTCOME")], { stopReason: "stop" }),
      message(16, "user", "Can you actually run the PRIVATE_ORDINARY_QUESTION build?"),
      message(17, "assistant", [text("PRIVATE_ORDINARY_ANSWER")], { stopReason: "stop" }),
    ].map((row) => JSON.stringify(row)).join("\n"));
    writeFileSync(join(dir, "invalid-session.jsonl"), [
      { type: "session", id: "00000000-0000-4000-8000-000000000003", timestamp: at(-8_000_000) },
      message(1, "user", "정정: MALFORMED_BRANCH"),
      { type: "message", parentId: entryId(1), timestamp: at(-1000), message: { role: "user", content: "unknown branch" } },
    ].map((row) => JSON.stringify(row)).join("\n"));
    writeFileSync(join(dir, "invalid-type.jsonl"), [
      { type: "session", id: "00000000-0000-4000-8000-000000000004", timestamp: at(-8_000_000) },
      message(1, "user", "정정: INVALID_TYPE_BRANCH"),
      { type: 42, id: entryId(2), parentId: entryId(1), timestamp: at(-1000) },
    ].map((row) => JSON.stringify(row)).join("\n"));
    const scan = await scanSessions(dir, +NOW, [], [], true);
    const bundle = exportBundle(scan.dreaming, { errorsBySignature: scan.windows[0].errorsBySignature, failureExcerpts: scan.failureExcerpts });
    const evidence = bundle.dreaming.events;
    assert.equal(bundle.dreaming.partial, true);
    assert.deepEqual(evidence.map(({ entryId: id }) => id), [13, 10, 5, 4, 3].map(entryId));
    assert.deepEqual(evidence.map(({ kind }) => kind), ["user", "failed-command", "outcome", "user", "failed-command"]);
    assert.equal(evidence.find((event) => event.entryId === entryId(4)).quote, "정정: 이 PC에서는\n  빌드하지 마세요.");
    assert.equal(evidence.at(-1).command, "bun run check");
    assert.equal(evidence.at(-1).quote, "fatal: missing script\nCommand exited with code 1");
    for (const absent of ["IMAGE_CONTENT", "HIDDEN_REASONING", "ANOTHER_SESSION_TEXT", "GENERATED_OUTCOME", "ABANDONED_CORRECTION", "IRC_OUTCOME", "PRIVATE_ORDINARY_", "MALFORMED_BRANCH", "INVALID_TYPE_BRANCH", passwd]) {
      assert.ok(!JSON.stringify(bundle).includes(absent));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
