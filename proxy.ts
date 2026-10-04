import { NextResponse, type NextRequest } from "next/server";
import { rejectUnauthorizedRequest } from "@/lib/api-request-guard";

export function proxy(request: NextRequest) {
  return rejectUnauthorizedRequest(request, request.nextUrl.pathname) ?? NextResponse.next();
}

/**
 * `/api/attachments` (the streaming upload) is left out on purpose: Next buffers the whole body of
 * every request the proxy sees, so the route runs `rejectUnauthorizedRequest` itself before it reads
 * the body. Its sub-routes, such as `/api/attachments/draft`, still pass through here.
 */
export const config = { matcher: ["/", "/office", "/recover", "/api", "/api/:path((?!attachments$).*)"] };
