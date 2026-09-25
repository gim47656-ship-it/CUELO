import assert from "node:assert/strict";
import test from "node:test";

// 검증 대상은 계약 동작 둘이다. (1) JSON-RPC 봉투에서 대조용 네 값만 뽑고 인자 본문은 보지
// 않는다 (2) 기록 줄에 handleKey·지시문 같은 비밀·본문이 새지 않는다. 파일 쓰기는 검증하지
// 않는다 — 배관이고, 이 테스트는 `logGpt6Call`을 부르지 않는다.
async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./gpt6-call-log.ts");
  } catch {
    return import("./gpt6-call-log.ts");
  }
}

const { gpt6CallFields, gpt6CallLine, gpt6CallStatus } = await loadSubject();

test("tools/call 봉투에서 도구명·연결번호·rpc id만 뽑는다", () => {
  const fields = gpt6CallFields({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "omp_get_result",
      arguments: { handle: "H-2191", handleKey: "Q4ereojlpkdNAYg5DkTRSqVtE", sinceEntryId: "848d4ebf" },
    },
  });
  assert.deepEqual(fields, { method: "tools/call", tool: "omp_get_result", handle: "H-2191", rpcId: 7 });
});

test("봉투가 아닌 본문은 빈 값이 된다 — dispatch 앞에서 던지지 않는다", () => {
  for (const body of [null, undefined, "text", 42, [1, 2], {}]) {
    assert.deepEqual(gpt6CallFields(body), {});
  }
  assert.deepEqual(gpt6CallFields({ method: "tools/call", params: { arguments: "not-an-object" } }),
    { method: "tools/call" });
});

test("기록 줄에 handleKey·지시문 본문이 들어가지 않는다", () => {
  const body = {
    jsonrpc: "2.0",
    id: "wfr_01a0b15e",
    method: "tools/call",
    params: {
      name: "omp_send_instruction",
      arguments: { handle: "H-2191", handleKey: "Q4ereojlpkdNAYg5DkTRSqVtE", message: "비밀 지시문" },
    },
  };
  const line = gpt6CallLine({ ...gpt6CallFields(body), status: "ok", durationMs: 12.4 });
  assert.doesNotMatch(line, /Q4ereojlpkdNAYg5DkTRSqVtE|비밀 지시문|handleKey|message/);
  const parsed = JSON.parse(line);
  assert.equal(parsed.method, "tools/call");
  assert.equal(parsed.tool, "omp_send_instruction");
  assert.equal(parsed.handle, "H-2191");
  assert.equal(parsed.rpcId, "wfr_01a0b15e");
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.durationMs, 12);
});

test("기록 줄의 시각은 로컬 시간대 오프셋을 포함한다", () => {
  const now = new Date(2026, 8, 18, 6, 56, 32, 858);
  const line = JSON.parse(gpt6CallLine({ status: "ok", durationMs: 0 }, now));
  assert.equal(line.time.slice(0, 23), "2026-09-18T06:56:32.858");
  assert.match(line.time, /[+-]\d{2}:\d{2}$/);
});

test("dispatch 결과를 ok·error·notification으로 가른다", () => {
  assert.equal(gpt6CallStatus({ jsonrpc: "2.0", id: 1, result: { content: [] } }), "ok");
  assert.equal(gpt6CallStatus({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "..." } }), "error:-32602");
  assert.equal(gpt6CallStatus({ jsonrpc: "2.0", id: null, error: { message: "..." } }), "error");
  assert.equal(gpt6CallStatus(null), "notification");
});
