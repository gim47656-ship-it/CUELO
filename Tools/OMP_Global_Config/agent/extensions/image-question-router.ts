import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * 이미지 파일을 `?q=` 없이 `read`하려는 첫 시도를 막고 `경로?q=<질문>`으로 다시 읽게 한다. 글자·값 확인뿐 아니라
 * 레이아웃·간격·색·정렬 판단도 `modelRoles.vision` 모델이 보고 답을 텍스트로 주며, 이미지는 세션 컨텍스트에
 * 실리지 않는다(2026-09-28 사용자 결정: 형태 판단도 vision이 맡는다. 처음에는 JEV가 용도를 판정해 글자 확인만
 * 돌렸다). 같은 경로를 세션에서 다시 read하면 통과하므로, vision 답으로 부족할 때 모델이 직접 볼 길은 남는다.
 * `browser`·`computer` 스크린샷은 `read`가 아니라서 이 전환의 대상이 아니다.
 */

const IMAGE_PATH = /\.(?:png|jpe?g|gif|webp|bmp)$/i;

/** 전환 대상인 이미지 read면 정규화한 경로를, 아니면 undefined를 준다. */
export function imageReadTarget(path: unknown): string | undefined {
  if (typeof path !== "string") return undefined;
  const target = path.trim();
  if (!target || target.includes("?") || /^https?:\/\//i.test(target)) return undefined;
  return IMAGE_PATH.test(target) ? target.replace(/\\/g, "/") : undefined;
}

export function blockReason(path: string): string {
  return [
    "image-question-router: 이미지는 먼저 vision 모델에게 묻는다. 직접 읽기를 한 번 막았다.",
    `\`${path}?q=<구체적인 질문>\`으로 다시 read하라. 글자·값뿐 아니라 레이아웃·간격·색·정렬·잘림도 질문으로 물을 수 있고, 이미지는 컨텍스트에 실리지 않는다.`,
    "vision 답으로 판단할 수 없을 때만 같은 경로를 그대로 한 번 더 read하면 직접 보게 통과한다.",
  ].join("\n");
}

export default function imageQuestionRouter(pi: ExtensionAPI): void {
  const redirected = new Set<string>();

  pi.on("session_start", () => {
    redirected.clear();
  });
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "read") return;
    const target = imageReadTarget((event.input as { path?: unknown }).path);
    if (!target) return;
    // 이미지를 받지 못하는 모델은 코어가 이미 메타데이터와 `?q=` 안내를 돌려준다.
    if (ctx.model && !ctx.model.input.includes("image")) return;
    if (redirected.has(target)) return;
    redirected.add(target);
    return { block: true, reason: blockReason(target) };
  });
}
