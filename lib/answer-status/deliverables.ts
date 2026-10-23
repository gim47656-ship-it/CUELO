import { getFileExt, isDocumentPreviewPath, isImagePath } from "@/lib/file-types";
import type { WrittenFile } from "@/lib/turn-written-files";

/** 결과 카드가 미리보기로 앞세우는 결과물 종류. 파일 보기(`FileViewer`)가 화면으로 그려 주는 것만이다. */
export type DeliverableKind = "html" | "document" | "image";

export interface Deliverable {
  filePath: string;
  kind: DeliverableKind;
}

/**
 * 결과물이 아니라 작업 과정에 딸린 자리. 테스트·픽스처, 의존성·빌드 산출물, 작업 기록(`doc/history`
 * 아래 검증 스크린샷 포함)은 사용자가 확인할 완성 화면이 아니다.
 */
const PROCESS_SEGMENTS: Record<string, true> = {
  test: true,
  tests: true,
  __tests__: true,
  __fixtures__: true,
  fixtures: true,
  __snapshots__: true,
  node_modules: true,
  coverage: true,
};

/** 경로 조각은 대소문자와 구분자(`\`·`/`)에 상관없이 본다. Windows 경로의 `Tests\`·`Doc\History\`도 같다. */
function isProcessPath(filePath: string): boolean {
  const segments = filePath.toLowerCase().replace(/\\/g, "/").split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (Object.hasOwn(PROCESS_SEGMENTS, segment)) return true;
    if (segment.startsWith(".next")) return true;
    if (segment === "doc" && segments[index + 1] === "history") return true;
  }
  return false;
}

function deliverableKind(filePath: string): DeliverableKind | null {
  const ext = getFileExt(filePath);
  if (ext === "html" || ext === "htm") return "html";
  if (isDocumentPreviewPath(filePath)) return "document";
  if (isImagePath(filePath)) return "image";
  return null;
}

const KIND_ORDER: Record<DeliverableKind, number> = { html: 0, document: 1, image: 2 };

/**
 * 한 턴이 쓴 파일 중 완성 결과물로 앞세울 것. 소스·설정·Markdown 기록은 빼고, 화면(HTML)·문서
 * (PDF·DOCX)·이미지 순으로, 같은 종류 안에서는 쓴 순서대로 둔다. 첫 항목이 미리보기 대상이다.
 */
export function pickDeliverables(files: readonly WrittenFile[]): Deliverable[] {
  const picked: Deliverable[] = [];
  for (const file of files) {
    if (isProcessPath(file.filePath)) continue;
    const kind = deliverableKind(file.filePath);
    if (kind) picked.push({ filePath: file.filePath, kind });
  }
  return picked
    .map((deliverable, index) => ({ deliverable, index }))
    .sort((left, right) => KIND_ORDER[left.deliverable.kind] - KIND_ORDER[right.deliverable.kind] || left.index - right.index)
    .map(({ deliverable }) => deliverable);
}
