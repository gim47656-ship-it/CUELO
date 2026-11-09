import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import toolRecoveryHint, { ENOBUFS_HINT, READ_TEXT_JSON_HINT } from "../tool-recovery-hint";

type Handler = (event: Record<string, unknown>) => unknown;

function emit(toolName: string, text: string, isError = true) {
  let handler: Handler | undefined;
  toolRecoveryHint({ on: (_name: string, h: Handler) => { handler = h; } } as unknown as ExtensionAPI);
  const out = handler!({ type: "tool_result", toolCallId: "c1", input: {}, toolName, isError, content: [{ type: "text", text }] }) as
    | { content?: { type: string; text: string }[] }
    | undefined;
  return out?.content?.[0]?.text;
}

// 2026-11-02~09 세션에 실제로 돌아온 문구 그대로다.
const JOB = "Background job or service not found: ScreenGlitchFix";
const ENOBUFS = "Error: spawnSync git ENOBUFS (stdout or stderr buffer reached maxBuffer size limit)\n    at spawnSync (node:child_process:287:35)";
const SHOWING = 'SyntaxError: JSON Parse error: Unexpected identifier "Showing"\n    at <parse> (:0)';

describe("tool-recovery-hint", () => {
  test("사라진 job id는 그 id의 agent://·history://와 proc:// 목록을 안내하고 원래 문구를 남긴다", () => {
    const text = emit("read", JOB) ?? "";
    expect(text).toStartWith(JOB);
    expect(text).toContain("agent://ScreenGlitchFix");
    expect(text).toContain("history://ScreenGlitchFix");
    expect(text).toContain("read proc://");
    const viaEval = emit("eval", `Error: ${JOB.replace("ScreenGlitchFix", "bg_34")}\n    at wrappedExecute`) ?? "";
    expect(viaEval).toContain("agent://bg_34");
    const servicesDown = emit("read", "Background job or service not found: bg_16 (services unavailable: broker down)") ?? "";
    expect(servicesDown).toContain("agent://bg_16");
  });

  test("eval ENOBUFS와 read 텍스트 JSON 파싱은 각자 고칠 방법을 덧붙인다", () => {
    expect(emit("eval", ENOBUFS)).toBe(`${ENOBUFS}\n\n${ENOBUFS_HINT}`);
    expect(emit("eval", SHOWING)).toBe(`${SHOWING}\n\n${READ_TEXT_JSON_HINT}`);
  });

  test("다른 JSON 오류, 다른 도구의 같은 문구, 성공 결과, 이미 붙은 안내는 그대로 둔다", () => {
    expect(emit("eval", 'SyntaxError: JSON Parse error: Expected "}"')).toBeUndefined();
    expect(emit("bash", ENOBUFS)).toBeUndefined();
    expect(emit("bash", SHOWING)).toBeUndefined();
    expect(emit("read", JOB, false)).toBeUndefined();
    expect(emit("eval", `${ENOBUFS}\n\n${ENOBUFS_HINT}`)).toBeUndefined();
  });
});
