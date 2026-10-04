import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * 이미지 파일을 `?q=` 없이 `read`하려는 시도를 막고 `경로?q=<질문>`으로 먼저 묻게 한다. 글자·값 확인뿐 아니라
 * 레이아웃·간격·색·정렬 판단도 `modelRoles.vision` 모델이 보고 답을 텍스트로 주며, 이미지는 세션 컨텍스트에
 * 실리지 않는다(2026-09-28 사용자 결정: 형태 판단도 vision이 맡는다. 처음에는 JEV가 용도를 판정해 글자 확인만
 * 돌렸다). 직접 보기는 그 경로로 `?q=` 질문을 한 번 한 뒤에만 열린다(2026-10-04: 한 번 막은 뒤 재read를 통과시키던
 * 방식에서는 막힌 에이전트 대부분이 질문 없이 같은 경로를 바로 다시 읽었다).
 * `browser`·`computer` 스크린샷은 `read`가 아니라서 이 전환의 대상이 아니다.
 */

const IMAGE_PATH = /\.(?:png|jpe?g|gif|webp|bmp)$/i;

/** 이미지 read면 `?` 앞 경로를 정규화해 질문 여부와 함께 주고, 아니면 undefined를 준다. */
export function imageRead(path: unknown): { target: string; asked: boolean } | undefined {
  if (typeof path !== "string") return undefined;
  const trimmed = path.trim();
  if (!trimmed || /^https?:\/\//i.test(trimmed)) return undefined;
  const query = trimmed.indexOf("?");
  const base = query < 0 ? trimmed : trimmed.slice(0, query);
  if (!IMAGE_PATH.test(base)) return undefined;
  return { target: base.replace(/\\/g, "/"), asked: query >= 0 && /[?&]q=/.test(trimmed.slice(query)) };
}

export function blockReason(path: string): string {
  return [
    "image-question-router: 이미지는 먼저 vision 모델에게 묻는다. 직접 읽기를 막았다.",
    `\`${path}?q=<구체적인 질문>\`으로 read하라. 글자·값뿐 아니라 레이아웃·간격·색·정렬·잘림도 질문으로 물을 수 있고, 이미지는 컨텍스트에 실리지 않는다.`,
    "그 질문의 답으로 판단할 수 없을 때만 같은 경로를 다시 read하면 직접 보게 통과한다. 질문 없이 다시 read해도 계속 막힌다.",
  ].join("\n");
}

export default function imageQuestionRouter(pi: ExtensionAPI): void {
  const asked = new Set<string>();

  pi.on("session_start", () => {
    asked.clear();
  });
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "read") return;
    const input: unknown = event.input;
    const image = imageRead(input && typeof input === "object" && "path" in input ? input.path : undefined);
    if (!image) return;
    if (image.asked) {
      asked.add(image.target);
      return;
    }
    // 이미지를 받지 못하는 모델은 코어가 이미 메타데이터와 `?q=` 안내를 돌려준다.
    if (ctx.model && !ctx.model.input.includes("image")) return;
    if (asked.has(image.target)) return;
    return { block: true, reason: blockReason(image.target) };
  });
}
