import { describe, expect, test } from "bun:test";

import { checkOutputHint } from "./check-output-hint";

describe("checkOutputHint", () => {
  test("a filter that can leave its own status after a check still gets the hint", () => {
    for (const command of [
      "bun test lib/upkeep | tail -20",
      "bun run typecheck 2>&1 | grep -c error",
      "bun test lib/upkeep | tail -5; echo $?",
      "bun test lib/upkeep > /tmp/t.log 2>&1; tail -3 /tmp/t.log",
      "npx tsc --noEmit | tee /tmp/tsc.log",
      // 교차 검토 지적: 상태를 읽는 자리가 검사 바로 뒤가 아니거나, pipefail을 끄거나 검사 뒤에야 켜거나 다른 셸에서만 켠 명령,
      // 상태 변수가 아닌 글자, 중첩 셸의 검사를 바깥 파이프가 가리는 명령.
      "bun test; tail -3 /tmp/t.log; echo $?",
      "set +o pipefail; bun test | tail -3",
      "bun test | tail -3; set -o pipefail",
      "bash -c 'set -o pipefail'; bun test | tail -3",
      "bun test | tail -3; echo PIPESTATUS",
      "bash -c 'bun test' | tail -5; echo $?",
      "bash -c 'bun test; rc=$?; exit $rc' | tail -5",
      "bun test | tail -3; bash -c 'echo ${PIPESTATUS[0]}'",
      "set -o pipefail | cat; bun test | tail -3",
    ]) {
      expect(checkOutputHint(command), command).toContain("[검사 종료 코드]");
    }
  });

  test("commands that already captured the check's status or never filter after it stay quiet", () => {
    // 2026-11-14 야간 세션의 실제 명령: 종료 코드를 PIPESTATUS나 바로 뒤 $?로 남겼는데도 안내가 붙었다(8번 중 8번).
    for (const command of [
      'bun test lib/upkeep/handoff.test.mjs 2>&1 | tail -15; echo "exit=${PIPESTATUS[0]}"',
      'bun test lib/upkeep/ > /tmp/ht.log 2>&1; echo "exit=$?"; tail -4 /tmp/ht.log; grep -n "(fail)" /tmp/ht.log | head',
      '(cd /tmp/h && bun test lib/upkeep/ > /tmp/ht-head.log 2>&1; echo "head exit=$?"); tail -3 /tmp/ht-head.log',
      "set -o pipefail; bun test lib/upkeep | tail -20",
      "set -euo pipefail; bun run lint | tail -5",
      "set -o pipefail; bash -c 'bun test' | tail -5",
      "bash -c 'bun test; rc=$?; tail -3 log'",
      "bun test lib/upkeep > /tmp/t.log 2>&1; rc=$?; tail -3 /tmp/t.log; exit $rc",
      "grep -n checkOutputHint index.ts; bun test command-guard",
      "bun test command-guard",
      "bun install | tail -3",
    ]) {
      expect(checkOutputHint(command), command).toBeUndefined();
    }
  });
});
