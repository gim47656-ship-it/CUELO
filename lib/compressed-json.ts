/**
 * JSON 응답을 클라이언트가 받아 주면 gzip으로 보낸다.
 *
 * Next는 페이지와 정적 파일은 압축하지만 App Router route handler의 본문은 압축하지 않는다.
 * 2026-10-17 실측: 57MB 세션의 `GET /api/sessions/[id]`가 2.6MB 그대로 나갔고, gzip이면 약 0.7MB다.
 * 같은 PC 루프백에서는 차이가 작고 폰·원격 접속에서 로딩 시간을 줄인다.
 */
export function compressedJson(req: Request, body: unknown, init: ResponseInit = {}): Response {
  const json = JSON.stringify(body);
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.append("Vary", "Accept-Encoding");
  if (!acceptsGzip(req.headers.get("accept-encoding"))) {
    return new Response(json, { ...init, headers });
  }
  headers.set("Content-Encoding", "gzip");
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream, { ...init, headers });
}

/** `Accept-Encoding`이 gzip을 받는지. 명시한 `gzip` 항목이 `*`보다 우선하고, q=0은 거절이다. */
export function acceptsGzip(header: string | null): boolean {
  if (!header) return false;
  const quality = new Map<string, number>();
  for (const part of header.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    if (name) quality.set(name, q === undefined ? 1 : Number(q.slice(2)));
  }
  const gzip = quality.get("gzip") ?? quality.get("*");
  return gzip !== undefined && gzip > 0;
}
