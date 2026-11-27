import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";

// Limit the heuristic to files directly under /tmp, not nested project checkouts.
const BUN_SCRATCH_IMPORT = /^error: Cannot find (?:module|package) ['"][^'"\r\n]+['"] from ['"]\/tmp\/[^/'"\r\n]+\.(?:[cm]?[jt]s)['"]\r?$/m;
const SCRATCH_WATCHER_JQ = /^(\/tmp\/[^/\r\n]+): line \d+: jq: command not found\r?$/gm;

const IMPORT_HINT = "[임시 스크립트 사전 확인] 오류 문구로 추정한 안내입니다. 해당한다면 전체 검사를 다시 돌리기 전에 임시 스크립트 위치에서 프로젝트에 설치된 Bun과 의존성이 해석되는지 확인하세요. import가 작업 트리 기준이면 기존 fixture나 프로젝트 안의 임시 위치를 사용하세요.";
const JQ_HINT = "[임시 스크립트 사전 확인] 오류 문구로 추정한 안내입니다. 해당한다면 감시를 다시 시작하기 전에 같은 실행 환경에서 `command -v jq`로 확인하세요. jq가 없으면 이미 설치된 도구로 같은 결과를 확인할 수 있는지 먼저 보세요.";

export default function scratchDependencyHint(pi: ExtensionAPI): void {
  pi.on("tool_result", (event) => {
    if (event.toolName !== "bash") return;
    // On success, distinguish a direct watcher launch from commands quoting its output.
    const command = typeof event.input.command === "string" ? event.input.command.trim() : "";
    const launchedWatcher = /^bash[ \t]+(\/tmp\/[A-Za-z0-9_][A-Za-z0-9_.-]*)$/.exec(command)?.[1];
    const exitCode = (event.details as { exitCode?: unknown } | undefined)?.exitCode;
    const failed = event.isError || (typeof exitCode === "number" && exitCode !== 0);
    if (!failed && !launchedWatcher) return;
    for (const part of event.content) {
      if (part.type !== "text") continue;
      const text = part.text.includes("\u001b") ? stripVTControlCharacters(part.text) : part.text;
      if (failed && BUN_SCRATCH_IMPORT.test(text)) return { additionalContext: IMPORT_HINT };
      for (const [, script] of text.matchAll(SCRATCH_WATCHER_JQ)) {
        if (failed || launchedWatcher === script) return { additionalContext: JQ_HINT };
      }
    }
  });
}
