import { stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { OFFICE_AVATAR_DIR, type OfficeAvatarId } from "@/lib/office/office-avatars";

/**
 * 고정 ID 하나의 개인 모델 파일. 경로는 agent 데이터 디렉터리와 ID 만으로 짓는다 — 요청의 어떤
 * 문자열도 경로에 들어가지 않는다. 파일이 없으면 null 이고, 그 밖의 읽기 오류는 그대로 던진다.
 */
export async function findOfficeAvatarFile(id: OfficeAvatarId): Promise<{ path: string; size: number; mtimeMs: number } | null> {
  const path = join(getAgentDir(), OFFICE_AVATAR_DIR, `${id}.vrm`);
  try {
    const info = await stat(path);
    return info.isFile() ? { path, size: info.size, mtimeMs: info.mtimeMs } : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}
