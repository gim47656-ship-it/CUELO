import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { readPost, routinesDir } from "@/lib/routines/store";

export const dynamic = "force-dynamic";

/** GET: 글 한 편(머리말과 markdown 본문). 파일 이름은 글 이름 형식만 받아 저장소 밖을 읽지 않는다. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  const { id, file } = await params;
  const post = readPost(routinesDir(), id, file);
  if (!post) return NextResponse.json({ error: "Post not found" }, { status: 404 });
  return NextResponse.json({ post: { file, ...post } });
}
