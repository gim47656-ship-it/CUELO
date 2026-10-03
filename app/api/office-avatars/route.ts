import { NextResponse } from "next/server";
import { OFFICE_AVATAR_IDS, type OfficeAvatarManifest } from "@/lib/office/office-avatars";
import { isApiRequestAllowed } from "@/lib/request-security";
import { findOfficeAvatarFile } from "./avatar-file";

export const dynamic = "force-dynamic";

/**
 * 이 설치에 들어 있는 개인 오피스 모델 목록. 오피스 장면은 여기 있는 캐릭터만 모델을 받고, 나머지는
 * 기본 도형 캐릭터로 그린다 — 모델이 없는 공개 설치본에서는 늘 빈 목록이다.
 */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const files = await Promise.all(OFFICE_AVATAR_IDS.map(findOfficeAvatarFile));
    const payload: OfficeAvatarManifest = { available: OFFICE_AVATAR_IDS.filter((_, index) => files[index] !== null) };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
