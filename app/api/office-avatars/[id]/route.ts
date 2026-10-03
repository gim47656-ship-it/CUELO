import { openAsBlob } from "node:fs";
import { NextResponse } from "next/server";
import { parseOfficeAvatarId } from "@/lib/office/office-avatars";
import { isApiRequestAllowed } from "@/lib/request-security";
import { findOfficeAvatarFile } from "../avatar-file";

export const dynamic = "force-dynamic";

/**
 * 개인 오피스 모델 하나(VRM = glTF 바이너리). 고정 ID 가 아니거나 이 설치에 파일이 없으면 404 다.
 * 모델은 수십 MB 라 브라우저가 들고 있다가 같은 파일이면 304 로 다시 쓰게 ETag 를 단다.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const id = parseOfficeAvatarId((await params).id);
  if (!id) return NextResponse.json({ error: "Unknown office avatar" }, { status: 404 });
  try {
    const file = await findOfficeAvatarFile(id);
    if (!file) return NextResponse.json({ error: "Office avatar is not installed" }, { status: 404 });
    const headers = {
      "Cache-Control": "private, no-cache",
      ETag: `"${file.size.toString(36)}-${Math.trunc(file.mtimeMs).toString(36)}"`,
    };
    if (req.headers.get("if-none-match") === headers.ETag) return new Response(null, { status: 304, headers });
    return new Response(await openAsBlob(file.path), {
      headers: { ...headers, "Content-Type": "model/gltf-binary" },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
