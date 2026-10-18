import type { ToolResultMessage } from "@/lib/types";

/**
 * 도구 결과에 기록된 종료 코드. `details.exitCode`가 우선이고, 없으면 bash 결과 끝의
 * `Command exited with code N` 줄을 읽는다. 둘 다 없으면 null(기록 없음)이다.
 */
export function readExitCode(result: ToolResultMessage): number | null {
  const details = result.details as { exitCode?: unknown } | undefined;
  if (typeof details?.exitCode === "number") return details.exitCode;
  const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
  const match = /Command exited with code (-?\d+)\s*$/.exec(text.trimEnd());
  return match ? Number(match[1]) : null;
}
