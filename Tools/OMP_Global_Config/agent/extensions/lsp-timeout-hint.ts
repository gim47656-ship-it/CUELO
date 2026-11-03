import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// core의 LSP 진단 시간 초과 문구는 "try again or pass timeout=<larger>"로 끝난다. 10-30 실측에서 같은 파일 진단을
// 60·180·300·240초로 네 번 다시 걸어 13분을 쓰고 모두 실패했고, 11-02에도 60→180초 재시도가 실패했다.
// 진단 시간 초과에서만 그 권고를 프로젝트 타입 검사로 바꾼다. 다른 LSP 동작과 다른 오류는 건드리지 않는다.
const TIMEOUT = /^(LSP diagnostics timed out after \d+s(?: on [^\n]+?)?\.) The server may still be indexing; try again or pass timeout=<larger>\./m;

export const LSP_TIMEOUT_HINT = "같은 진단을 더 긴 timeout으로 다시 보내지 않는다(60~300초 재시도가 모두 실패한 기록이 있다). 대신 bash로 프로젝트의 타입 검사를 돌린다: package.json에 `typecheck` 스크립트가 있으면 그것을, 없으면 그 tsconfig로 `tsc --noEmit -p <폴더>`를 쓴다. 서버 상태가 궁금하면 `lsp` action `status`로 본다.";

export function rewriteLspTimeout(text: string): string | undefined {
  const match = TIMEOUT.exec(text);
  return match ? text.replace(TIMEOUT, `${match[1]} ${LSP_TIMEOUT_HINT}`) : undefined;
}

export default function lspTimeoutHint(pi: ExtensionAPI): void {
  pi.on("tool_result", (event) => {
    if (event.toolName !== "lsp" || !event.isError) return;
    let changed = false;
    const content = event.content.map((part) => {
      if (part.type !== "text") return part;
      const text = rewriteLspTimeout(part.text);
      if (text === undefined) return part;
      changed = true;
      return { ...part, text };
    });
    return changed ? { content } : undefined;
  });
}
