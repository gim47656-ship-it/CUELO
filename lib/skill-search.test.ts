import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import * as realNpx from "@/lib/npx";

// Only runNpx is replaced (no package is ever resolved or run); the rest of lib/npx
// stays real. `realNpx` is a live namespace that mock.module() rewrites, so the real
// exports are copied first and that copy is what is put back for any later file.
interface NpxOutput {
  stdout: string;
  stderr: string;
}

let npxRun: (args: string[]) => Promise<NpxOutput>;
const npxCalls: string[][] = [];
const originalNpx = { ...realNpx };
mock.module("@/lib/npx", () => ({
  ...originalNpx,
  runNpx: (args: string[]) => {
    npxCalls.push(args);
    return npxRun(args);
  },
}));
// The route must be loaded after mock.module() so it binds the stub, which a static
// import cannot do (imports are hoisted above the call).
const { POST } = await import("@/app/api/skills/search/route");
afterAll(() => {
  mock.module("@/lib/npx", () => originalNpx);
});

let fetchMock: Mock<typeof fetch>;
let respond: () => Response | Promise<Response>;

beforeEach(() => {
  npxCalls.length = 0;
  npxRun = () => Promise.reject(new Error("runNpx was not stubbed for this test"));
  respond = () => Response.json({ skills: [] });
  fetchMock = spyOn(globalThis, "fetch").mockImplementation((() => Promise.resolve().then(respond)) as never);
});
afterEach(() => fetchMock.mockRestore());

function search(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return POST(new Request("http://127.0.0.1:30141/api/skills/search", {
    method: "POST",
    headers: { host: "127.0.0.1:30141", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

interface SearchBody {
  results?: { package: string; installs: string; url: string }[];
  error?: string;
}

const skill = (n: number | undefined, name = `fixture-${n}`) => ({
  name,
  source: "example/skills",
  id: `example/skills/${name}`,
  installs: n,
});

// Exact shape of `npx skills find <query>` output (vercel-labs/skills src/find.ts),
// colors included, for a 0 / 1 / 2 / K / M installs result set.
const CLI_RESULTS = [
  "\x1b[38;5;102mInstall with\x1b[0m npx skills add <owner/repo@skill>",
  "",
  "\x1b[38;5;145mexample/skills@fixture-m\x1b[0m \x1b[36m2M installs\x1b[0m",
  "\x1b[38;5;102m└ https://skills.sh/example/skills/fixture-m\x1b[0m",
  "",
  "\x1b[38;5;145mexample/skills@fixture-k\x1b[0m \x1b[36m1.5K installs\x1b[0m",
  "\x1b[38;5;102m└ https://skills.sh/example/skills/fixture-k\x1b[0m",
  "",
  "\x1b[38;5;145mexample/skills@fixture-2\x1b[0m \x1b[36m2 installs\x1b[0m",
  "\x1b[38;5;102m└ https://skills.sh/example/skills/fixture-2\x1b[0m",
  "",
  "\x1b[38;5;145mexample/skills@fixture-1\x1b[0m \x1b[36m1 install\x1b[0m",
  "\x1b[38;5;102m└ https://skills.sh/example/skills/fixture-1\x1b[0m",
  "",
  "\x1b[38;5;145mexample/skills@fixture-0\x1b[0m",
  "\x1b[38;5;102m└ https://skills.sh/example/skills/fixture-0\x1b[0m",
  "",
].join("\n");

const CLI_NO_RESULTS = '\x1b[38;5;102mNo skills found for "fixture"\x1b[0m\n';

test("a valid empty result from skills.sh stays a 200 empty list", async () => {
  const res = await search({ query: "nothing-matches" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ results: [] });
  expect(npxCalls).toEqual([]);
});

test("keeps 0, 1, 2, K and M install results from skills.sh, most installed first", async () => {
  respond = () =>
    Response.json({
      skills: [skill(0), skill(1), skill(2), skill(1500, "fixture-k"), skill(2_000_000, "fixture-m"), skill(undefined, "fixture-none")],
    });
  const res = await search({ query: "fixture" });
  expect(res.status).toBe(200);
  const { results } = (await res.json()) as SearchBody;
  expect(results?.map((r) => [r.package, r.installs])).toEqual([
    ["example/skills@fixture-m", "2M installs"],
    ["example/skills@fixture-k", "1.5K installs"],
    ["example/skills@fixture-2", "2 installs"],
    ["example/skills@fixture-1", "1 install"],
    ["example/skills@fixture-0", ""],
    ["example/skills@fixture-none", ""],
  ]);
  expect(results?.[0].url).toBe("https://skills.sh/example/skills/fixture-m");
});

test("sends the trimmed query and a limit clamped to 1..50", async () => {
  const seen: URL[] = [];
  fetchMock.mockImplementation(((input: string) => {
    seen.push(new URL(input));
    return Promise.resolve(Response.json({ skills: [] }));
  }) as never);
  await search({ query: "  react testing  ", limit: 9999 });
  await search({ query: "react", limit: 0 });
  await search({ query: "react", limit: "abc" });
  expect(seen.map((u) => [u.searchParams.get("q"), u.searchParams.get("limit")])).toEqual([
    ["react testing", "50"],
    ["react", "1"],
    ["react", "50"],
  ]);
});

test("when skills.sh fails, the CLI fallback keeps every valid 0/1/2/K/M result", async () => {
  respond = () => new Response("", { status: 503 });
  npxRun = async () => ({ stdout: CLI_RESULTS, stderr: "" });
  const res = await search({ query: "fixture" });
  expect(res.status).toBe(200);
  const { results } = (await res.json()) as SearchBody;
  expect(results).toEqual([
    { package: "example/skills@fixture-m", installs: "2M installs", url: "https://skills.sh/example/skills/fixture-m" },
    { package: "example/skills@fixture-k", installs: "1.5K installs", url: "https://skills.sh/example/skills/fixture-k" },
    { package: "example/skills@fixture-2", installs: "2 installs", url: "https://skills.sh/example/skills/fixture-2" },
    { package: "example/skills@fixture-1", installs: "1 install", url: "https://skills.sh/example/skills/fixture-1" },
    { package: "example/skills@fixture-0", installs: "", url: "https://skills.sh/example/skills/fixture-0" },
  ]);
  expect(npxCalls).toEqual([["skills", "find", "fixture"]]);
});

test("the CLI fallback honours the requested limit", async () => {
  respond = () => new Response("", { status: 503 });
  npxRun = async () => ({ stdout: CLI_RESULTS, stderr: "" });
  const { results } = (await (await search({ query: "fixture", limit: 2 })).json()) as SearchBody;
  expect(results?.map((r) => r.package)).toEqual(["example/skills@fixture-m", "example/skills@fixture-k"]);
});

test("results printed by a CLI that then exits non-zero are still returned", async () => {
  respond = () => new Response("", { status: 503 });
  npxRun = () => Promise.reject(Object.assign(new Error("Command failed"), { stdout: CLI_RESULTS, stderr: "" }));
  const res = await search({ query: "fixture" });
  expect(res.status).toBe(200);
  expect(((await res.json()) as SearchBody).results).toHaveLength(5);
});

test("skills.sh failure plus an empty CLI answer is an error, not an empty result", async () => {
  respond = () => new Response("", { status: 503 });
  npxRun = async () => ({ stdout: CLI_NO_RESULTS, stderr: "" });
  const res = await search({ query: "fixture" });
  expect(res.status).toBeGreaterThanOrEqual(400);
  const body = (await res.json()) as SearchBody;
  expect(body.results).toBeUndefined();
  expect(body.error).toContain("HTTP 503");
});

test("a CLI that fails without output is an error carrying both failures", async () => {
  respond = () => Promise.reject(new Error("fixture network unavailable"));
  npxRun = () => Promise.reject(new Error("fixture npx crashed"));
  const res = await search({ query: "fixture" });
  expect(res.status).toBeGreaterThanOrEqual(400);
  const body = (await res.json()) as SearchBody;
  expect(body.results).toBeUndefined();
  expect(body.error).toContain("fixture network unavailable");
  expect(body.error).toContain("fixture npx crashed");
});

test("a 200 reply without a skills list falls back, and is an error when the CLI proves nothing", async () => {
  const replies = [
    () => new Response("<html>gateway</html>", { status: 200 }),
    () => Response.json({}),
    () => Response.json({ error: "rate limited" }),
    () => Response.json({ skills: null }),
    () => Response.json({ skills: "none" }),
    () => Response.json(null),
  ];
  for (const reply of replies) {
    respond = reply;
    npxRun = async () => ({ stdout: CLI_RESULTS, stderr: "" });
    expect(((await (await search({ query: "fixture" })).json()) as SearchBody).results).toHaveLength(5);

    npxRun = async () => ({ stdout: CLI_NO_RESULTS, stderr: "" });
    const res = await search({ query: "fixture" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as SearchBody;
    expect(body.results).toBeUndefined();
    expect(typeof body.error).toBe("string");
  }
});

test("CLI guidance text and package-less lines are never mistaken for a skill", async () => {
  respond = () => new Response("", { status: 503 });
  npxRun = async () => ({
    stdout: [
      "Install with npx skills add <owner/repo@skill>",
      "Usage: npx skills find <query> [--owner <owner>]",
      "example/@fixture 1 install",
      "",
    ].join("\n"),
    stderr: "",
  });
  const res = await search({ query: "fixture" });
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(((await res.json()) as SearchBody).results).toBeUndefined();
});

test("the failure message is redacted before it is bounded to 500 characters", async () => {
  const secret = "fixture-secret-value-0123456789";
  process.env.SKILLS_SEARCH_TEST_TOKEN = secret;
  try {
    respond = () => new Response("", { status: 503 });
    // The secret starts just inside the last 500 characters of the composed message,
    // so clipping before redaction would leave an unredactable fragment of it.
    npxRun = () => Promise.reject(new Error(`${"A".repeat(2000)}${secret}${"B".repeat(440)}`));
    const res = await search({ query: "fixture" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const { error } = (await res.json()) as SearchBody;
    expect(error?.length).toBeLessThanOrEqual(500);
    expect(error).not.toContain(secret.slice(0, 12));
    expect(error).not.toContain(secret.slice(-12));
    expect(error).toContain("[REDACTED]");
    expect(error).toContain("HTTP 503");
  } finally {
    delete process.env.SKILLS_SEARCH_TEST_TOKEN;
  }
});

test("rejects untrusted, malformed and oversized requests before contacting skills.sh or the CLI", async () => {
  expect((await search({ query: "x" }, { host: "evil.example" })).status).toBe(403);
  expect((await search({ query: "x" }, { "content-type": "text/plain" })).status).toBe(415);
  expect((await search({ query: "   " })).status).toBe(400);
  expect((await search({ query: "x".repeat(201) })).status).toBe(400);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(npxCalls).toEqual([]);
});
