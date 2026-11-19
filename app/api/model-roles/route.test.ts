import { afterEach, beforeEach, expect, test } from "bun:test";
import { PUT } from "./route";

let previousRoots: typeof globalThis.__ompAllowedRootsCache;
beforeEach(() => {
  previousRoots = globalThis.__ompAllowedRootsCache;
  globalThis.__ompAllowedRootsCache = { roots: new Set([process.cwd()]), expiresAt: Infinity };
});
afterEach(() => { globalThis.__ompAllowedRootsCache = previousRoots; });

function put(body: unknown): Request {
  return new Request("http://127.0.0.1:30141/api/model-roles", {
    method: "PUT",
    headers: { host: "127.0.0.1:30141", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a role cannot be newly pinned to a retired provider, with or without a thinking suffix or case change", async () => {
  for (const selector of ["b-ai/gemini-4-hydrogen", "b-ai/deepseek-v4.1-flash:high", "B-AI/gemini-4-hydrogen"]) {
    const response = await PUT(put({ cwd: process.cwd(), role: "default", selector, scope: "global" }));
    expect({ selector, status: response.status }).toEqual({ selector, status: 400 });
    expect((await response.json() as { error: string }).error).toBe("That provider is no longer offered");
  }
});
