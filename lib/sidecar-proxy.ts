import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const SIDECAR_MAX_REQUEST_BODY_BYTES = 256 * 1024;

type SidecarFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type SidecarBodyKind = "none" | "json";

export interface SidecarTarget {
  url: string;
  body: SidecarBodyKind;
  accept: string;
  origin?: string;
}

const RESOURCE_ORIGIN = "http://127.0.0.1:30142";
const SIDECHAT_ORIGIN = "http://127.0.0.1:30143";
const SUBAGENT_ORIGIN = "http://127.0.0.1:30144";
const OMP_WEB_LOOPBACK_ORIGIN = "http://127.0.0.1:30141";
const SAFE_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "etag",
  "expires",
  "last-modified",
] as const;

export function resolveSidecarTarget(
  method: string,
  service: string,
  segments: readonly string[],
): SidecarTarget | null {
  const normalizedMethod = method.toUpperCase();

  if (service === "resource") {
    if (
      normalizedMethod === "GET"
      && segments.length === 1
      && (segments[0] === "usage" || segments[0] === "models")
    ) {
      return {
        url: `${RESOURCE_ORIGIN}/${segments[0]}`,
        body: "none",
        accept: "application/json",
      };
    }

    if (
      normalizedMethod === "POST"
      && segments.length === 3
      && segments[0] === "credential"
      && (segments[2] === "enable" || segments[2] === "disable" || segments[2] === "reset")
      && /^[1-9]\d*$/.test(segments[1])
    ) {
      const credentialId = Number(segments[1]);
      if (!Number.isSafeInteger(credentialId)) return null;
      return {
        url: `${RESOURCE_ORIGIN}/credential/${credentialId}/${segments[2]}`,
        body: segments[2] === "reset" ? "json" : "none",
        accept: "application/json",
        origin: OMP_WEB_LOOPBACK_ORIGIN,
      };
    }
    return null;
  }

  if (
    service === "sidechat"
    && normalizedMethod === "POST"
    && segments.length === 1
    && segments[0] === "ask"
  ) {
    return {
      url: `${SIDECHAT_ORIGIN}/ask`,
      body: "json",
      accept: "application/x-ndjson, application/json",
    };
  }

  if (
    service === "subagent"
    && normalizedMethod === "GET"
    && segments.length === 1
    && (segments[0] === "archive" || segments[0] === "transcript")
  ) {
    return {
      url: `${SUBAGENT_ORIGIN}/${segments[0]}`,
      body: "none",
      accept: "application/json",
    };
  }

  return null;
}

function jsonError(status: number, error: string): Response {
  return Response.json(
    { error },
    {
      status,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

function declaredContentLength(request: Request): number | null {
  const value = request.headers.get("content-length");
  if (value === null) return null;
  if (!/^\d+$/.test(value)) throw new TypeError("Invalid Content-Length");
  const length = Number(value);
  if (!Number.isSafeInteger(length)) throw new TypeError("Invalid Content-Length");
  return length;
}

async function readRequestBody(request: Request): Promise<ArrayBuffer> {
  const declaredLength = declaredContentLength(request);
  if (declaredLength !== null && declaredLength > SIDECAR_MAX_REQUEST_BODY_BYTES) {
    throw new RangeError("Request body too large");
  }

  const reader = request.body?.getReader();
  if (!reader) return new ArrayBuffer(0);

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > SIDECAR_MAX_REQUEST_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new RangeError("Request body too large");
    }
    chunks.push(chunk.value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

function responseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  for (const name of SAFE_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

export async function proxySidecarRequest(
  request: Request,
  service: string,
  segments: readonly string[],
  fetchImpl: SidecarFetch = fetch,
): Promise<Response> {
  if (!isApiRequestAllowed(request)) {
    return jsonError(403, "Untrusted API request");
  }

  const target = resolveSidecarTarget(request.method, service, segments);
  if (!target) return jsonError(404, "Sidecar route not found");

  let body: ArrayBuffer | undefined;
  if (target.body === "json") {
    if (!hasJsonContentType(request)) {
      return jsonError(415, "Content-Type must be application/json");
    }
    try {
      body = await readRequestBody(request);
    } catch (error) {
      return error instanceof RangeError
        ? jsonError(413, "Request body too large")
        : jsonError(400, "Invalid request body");
    }
  } else if (request.body !== null) {
    try {
      if ((await readRequestBody(request)).byteLength !== 0) {
        return jsonError(400, "Request body is not allowed");
      }
    } catch {
      return jsonError(400, "Request body is not allowed");
    }
  }

  const headers = new Headers({ Accept: target.accept });
  if (target.body === "json") headers.set("Content-Type", "application/json");
  if (target.origin) headers.set("Origin", target.origin);

  const query = new URL(request.url).search;
  try {
    const upstream = await fetchImpl(`${target.url}${query}`, {
      method: request.method.toUpperCase(),
      headers,
      body,
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
      signal: request.signal,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders(upstream),
    });
  } catch {
    if (service === "resource" && segments[2] === "reset") {
      return Response.json({
        error: "Reset outcome unknown", code: "reset_outcome_unknown", outcomeUnknown: true,
      }, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
    return jsonError(502, "Sidecar unavailable");
  }
}
