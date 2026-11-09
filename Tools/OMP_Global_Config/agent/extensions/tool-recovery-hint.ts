import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// 2026-11-09 점검(최근 7일 오류 1339건): 다음 실패들이 원래 오류 문구만으로는 다음 호출을 고칠 단서가 없었다.
// - `proc://<id>`가 끝난 뒤 정리된 job·재시작으로 사라진 Maker를 가리켜 `Background job or service not found` 5건
//   (read 4, eval 1). 결과는 `agent://<id>`·`history://<id>`에 남아 있다.
// - eval에서 큰 git 출력을 `execFileSync`로 받다 `ENOBUFS` 1건.
// - eval에서 `tool.read()` 결과 텍스트를 그대로 `JSON.parse`하다 `Unexpected identifier "Showing"` 1건(read는 머리말·꼬리말을 붙인다).
// 오류 여부·종류는 바꾸지 않고, 원래 문구 뒤에 바로 쓸 수 있는 다음 행동 한 줄만 덧붙인다.

const JOB_MISSING = /Background job or service not found: ([^\s()]+)/;
const ENOBUFS = /\bENOBUFS\b/;
const READ_TEXT_JSON = /JSON Parse error: Unexpected identifier "Showing"/;

export function jobMissingHint(id: string): string {
  return `[다시 찾는 법] 끝난 job은 잠시 뒤 목록에서 빠지고, 서버 재시작 뒤에는 이전 job id가 남지 않는다. task 결과는 agent://${id}(완료 출력)·history://${id}(대화 기록)로 읽고, 지금 도는 job·service 목록은 read proc:// 로 본다. bash job의 출력이 필요하면 그 호출 결과의 artifact:// 를 읽는다.`;
}

export const ENOBUFS_HINT = "[다시 하는 법] 자식 프로세스 출력이 버퍼 한도를 넘었다. 큰 git·검색 출력은 eval 대신 bash로 실행해 artifact로 읽거나, 출력이 꼭 필요하면 execFileSync에 maxBuffer를 키워 주거나 --name-only·-z처럼 필요한 부분만 받는다.";

export const READ_TEXT_JSON_HINT = "[다시 하는 법] tool.read() 결과 텍스트에는 읽기 머리말과 'Showing lines …' 같은 꼬리말이 붙어 JSON이 아니다. JSON 파일은 Bun.file(path).json() 이나 read 의 ?q=<jq>&raw=true 로 값만 받는다.";

export function recoveryHint(toolName: string, text: string): string | undefined {
  const job = JOB_MISSING.exec(text);
  if (job && (toolName === "read" || toolName === "eval" || toolName === "write")) return jobMissingHint(job[1]!);
  if (toolName !== "eval") return undefined;
  if (ENOBUFS.test(text)) return ENOBUFS_HINT;
  if (READ_TEXT_JSON.test(text)) return READ_TEXT_JSON_HINT;
  return undefined;
}

export default function toolRecoveryHint(pi: ExtensionAPI): void {
  pi.on("tool_result", (event) => {
    if (!event.isError) return;
    const textPart = event.content.find((part) => part.type === "text");
    if (!textPart || textPart.type !== "text") return;
    const hint = recoveryHint(event.toolName, textPart.text);
    if (!hint || textPart.text.includes(hint)) return;
    return { content: event.content.map((part) => (part === textPart ? { ...part, text: `${part.text}\n\n${hint}` } : part)) };
  });
}
