import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import lspTimeoutHint, { LSP_TIMEOUT_HINT } from "../lsp-timeout-hint";

type Handler = (event: Record<string, unknown>) => unknown;

function emit(event: Record<string, unknown>) {
  let handler: Handler | undefined;
  lspTimeoutHint({ on: (_name: string, h: Handler) => { handler = h; } } as unknown as ExtensionAPI);
  return handler!({ type: "tool_result", toolCallId: "c1", input: {}, ...event }) as { content?: { type: string; text: string }[] } | undefined;
}

// 11-02 세션에 실제로 돌아온 core 문구 그대로다.
const CORE = "LSP diagnostics timed out after 180s on typescript-language-server. The server may still be indexing; try again or pass timeout=<larger>.";

describe("lsp-timeout-hint", () => {
  test("진단 시간 초과는 재시도 권고 대신 프로젝트 타입 검사를 안내하고, 시간·서버 정보는 남긴다", () => {
    const out = emit({ toolName: "lsp", isError: true, content: [{ type: "text", text: CORE }] });
    const text = out?.content?.[0]?.text ?? "";
    expect(text).toStartWith("LSP diagnostics timed out after 180s on typescript-language-server.");
    expect(text).toContain(LSP_TIMEOUT_HINT);
    expect(text).not.toContain("pass timeout=<larger>");
  });

  test("서버 이름에 점이 있어도 바꾸고, core 형식과 다른 시간 표기는 그대로 둔다", () => {
    const dotted = emit({ toolName: "lsp", isError: true, content: [{ type: "text", text: CORE.replace("typescript-language-server", "typescript.server") }] });
    expect(dotted?.content?.[0]?.text).toStartWith("LSP diagnostics timed out after 180s on typescript.server.");
    expect(dotted?.content?.[0]?.text).toContain(LSP_TIMEOUT_HINT);
    expect(emit({ toolName: "lsp", isError: true, content: [{ type: "text", text: CORE.replace("180s on typescript-language-server", "180seconds") }] })).toBeUndefined();
    const bare = emit({ toolName: "lsp", isError: true, content: [{ type: "text", text: CORE.replace(" on typescript-language-server", "") }] });
    expect(bare?.content?.[0]?.text).toContain(LSP_TIMEOUT_HINT);
  });

  test("다른 LSP 동작의 시간 초과, 다른 오류, 성공 결과, 다른 도구는 그대로 둔다", () => {
    const references = CORE.replace("diagnostics", "references");
    expect(emit({ toolName: "lsp", isError: true, content: [{ type: "text", text: references }] })).toBeUndefined();
    expect(emit({ toolName: "lsp", isError: true, content: [{ type: "text", text: "No language server for .md" }] })).toBeUndefined();
    expect(emit({ toolName: "lsp", isError: false, content: [{ type: "text", text: CORE }] })).toBeUndefined();
    expect(emit({ toolName: "bash", isError: true, content: [{ type: "text", text: CORE }] })).toBeUndefined();
  });
});
