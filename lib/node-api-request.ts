import type { IncomingMessage } from "node:http";

/**
 * The Fetch `Request` the security helpers are written against, rebuilt from the Node request a
 * Pages API route receives. Only what those helpers read is carried over - method, url and headers
 * - and the scheme comes from the socket, so the host and origin checks decide exactly as they do
 * for an App Router handler. A body, when a route needs one, is read separately.
 */
export function webRequestFromNode(req: IncomingMessage): Request {
  const protocol = "encrypted" in req.socket && req.socket.encrypted ? "https" : "http";
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    // HTTP/2 pseudo-headers are not valid `Headers` names and carry nothing these checks read.
    if (name.startsWith(":")) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  return new Request(`${protocol}://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
    method: req.method ?? "GET",
    headers,
  });
}

/**
 * Reads the whole body with a hard ceiling, so a route never buffers an unbounded request. Returns
 * null when the ceiling is passed - the caller answers 413 and nothing further is parsed.
 */
export async function readRequestText(
  req: IncomingMessage,
  maximumBytes: number,
): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bytes.byteLength;
    if (size > maximumBytes) return null;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}
