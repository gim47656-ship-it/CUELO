import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// `rpc-manager.ts`는 Next 빌드 밖에서 로드할 수 없다(`@oh-my-pi/pi-tui/*` subpath가
// webpack alias로만 풀린다). 그래서 이 파일은 같은 디렉터리의 `goal-mode.wiring.test.mjs`와
// 같은 방식으로 배선을 고정한다.
const rpc = readFileSync(new URL("./rpc-manager.ts", import.meta.url), "utf8");

// 내부 지시문(`sendInternalPrompt`)은 genuine 사용자 요청이 아니다. 이 경계가 무너지면
// 하네스가 보낸 턴이 SDK `input` 이벤트를 발화해 command-guard의 요청 단위 task budget을
// 조용히 리셋한다. 호출자가 트리에 없다는 이유로 `internalPrompt` 인자를 지우는 것이
// 가장 그럴듯한 회귀 경로이므로 여기서 막는다.
test("내부 지시문은 internalPrompt 표시를 달고 전송된다", () => {
  assert.match(
    rpc,
    /async sendInternalPrompt\(message: string\): Promise<unknown> \{\s*return this\.send\(\{ type: "prompt", message \}, true\);/,
  );
});

test("genuine 사용자 요청 판별식이 내부 지시문과 큐잉 입력을 모두 제외한다", () => {
  assert.match(
    rpc,
    /function isGenuineUserRequest\(internalPrompt: boolean, streamingBehavior: string \| undefined\): boolean \{\s*return !internalPrompt && streamingBehavior === undefined;/,
  );
});

test("SDK input 이벤트는 그 판별식을 통과한 경로에서만 발화된다", () => {
  // `send`의 prompt 분기에서 emitGenuineUserInput 호출이 판별식 블록 안에만 있어야 한다.
  const promptCase = rpc.slice(rpc.indexOf('case "prompt": {'), rpc.indexOf('case "abort":'));
  assert.notEqual(promptCase.length, 0);
  assert.equal(
    (promptCase.match(/this\.emitGenuineUserInput\(/g) ?? []).length,
    1,
    "emitGenuineUserInput 호출은 prompt 분기에 정확히 하나여야 한다",
  );
  assert.match(
    promptCase,
    /if \(isGenuineUserRequest\(internalPrompt, streamingBehavior\)\) \{[^}]*?await this\.emitGenuineUserInput\(/s,
  );
});

// RPC 입력이 두 번째 인자를 채울 수 있으면 원격 호출자가 스스로를 내부 지시문으로
// 위장해 요청 경계를 건너뛸 수 있다. 외부에서 들어오는 명령은 항상 1-arg 호출이어야 한다.
test("RPC 경로는 internalPrompt 인자를 채우지 않는다", () => {
  const internalCallSites = rpc.match(/\.send\((?:[^()]|\([^()]*\))*,\s*true\s*\)/g) ?? [];
  assert.deepEqual(internalCallSites, ['.send({ type: "prompt", message }, true)']);
});
