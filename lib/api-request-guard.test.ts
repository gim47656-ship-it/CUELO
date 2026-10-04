import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebAuthStoreOptions } from "../bin/web-auth-store.js";
import { rejectUnauthorizedRequest } from "./api-request-guard";

const require = createRequire(import.meta.url);
const store = require("../bin/web-auth-store.js");

const PASSWORD = "a-long-enough-password";
const dirs: string[] = [];
afterEach(() => {
  store.clearVerificationCache();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function authOptions(password: string | null): WebAuthStoreOptions & { file: string } {
  const dir = mkdtempSync(join(tmpdir(), "cuelo-guard-"));
  dirs.push(dir);
  // An empty environment keeps the developer's CUELO_PASSWORD out of the decision.
  const options = { file: join(dir, "cuelo-auth.json"), env: {} as NodeJS.ProcessEnv, params: { cost: 16, keyLength: 32 } };
  if (password !== null) store.setWebPassword(password, options);
  return options;
}

function request(pathname: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1:30141${pathname}`, { headers: { host: "127.0.0.1:30141", ...headers } });
}

const basic = (password: string) => `Basic ${Buffer.from(`omp:${password}`, "utf8").toString("base64")}`;

test("refuses an untrusted host or cross-site API call before any credential check", async () => {
  const locked = authOptions(PASSWORD);
  const foreign = rejectUnauthorizedRequest(request("/api/attachments", { host: "evil.example" }), "/api/attachments", locked);
  expect(foreign?.status).toBe(403);
  expect(await foreign?.json()).toEqual({ error: "Untrusted API request" });

  const crossSite = rejectUnauthorizedRequest(
    request("/api/attachments", { "sec-fetch-site": "cross-site", authorization: basic(PASSWORD) }),
    "/api/attachments",
    locked,
  );
  expect(crossSite?.status).toBe(403);

  const page = rejectUnauthorizedRequest(request("/", { host: "evil.example" }), "/", locked);
  expect(page?.status).toBe(403);
  expect(await page?.text()).toBe("Untrusted request");
});

test("asks for the password with the Basic challenge and lets the right one through", async () => {
  const locked = authOptions(PASSWORD);
  const api = rejectUnauthorizedRequest(request("/api/attachments"), "/api/attachments", locked);
  expect(api?.status).toBe(401);
  expect(api?.headers.get("www-authenticate")).toBe('Basic realm="cuelo", charset="UTF-8"');
  expect(api?.headers.get("cache-control")).toBe("no-store");
  expect(await api?.json()).toEqual({ error: "Authentication required", recoveryPath: "/recover" });

  const page = rejectUnauthorizedRequest(request("/office"), "/office", locked);
  expect(page?.status).toBe(401);
  expect(page?.headers.get("content-type")).toBe("text/html; charset=utf-8");

  expect(rejectUnauthorizedRequest(request("/api/attachments", { authorization: basic("wrong") }), "/api/attachments", locked)?.status).toBe(401);
  expect(rejectUnauthorizedRequest(request("/api/attachments", { authorization: basic(PASSWORD) }), "/api/attachments", locked)).toBeNull();
  expect(rejectUnauthorizedRequest(request("/api/attachments"), "/api/attachments", authOptions(null))).toBeNull();
});

test("keeps recovery reachable while locked and refuses everything else when the credential is unreadable", () => {
  const broken = authOptions(PASSWORD);
  writeFileSync(broken.file, "{ not json");
  expect(rejectUnauthorizedRequest(request("/recover"), "/recover", broken)).toBeNull();
  expect(rejectUnauthorizedRequest(request("/api/web-access/recovery"), "/api/web-access/recovery", broken)).toBeNull();
  const api = rejectUnauthorizedRequest(request("/api/attachments", { authorization: basic(PASSWORD) }), "/api/attachments", broken);
  expect(api?.status).toBe(503);
  expect(api?.headers.get("cache-control")).toBe("no-store");
});

test("the proxy skips only the streaming upload path and still covers its sub-routes", () => {
  const pathnames = ["/api/attachments", "/", "/office", "/recover", "/api", "/api/files", "/api/attachments/draft", "/api/attachments/att_0/transcription", "/api/attachment-settings", "/api/attachmentsx", "/api/web-access/recovery"];
  // Next's matcher compiler loads its node environment, which wraps the process-wide console around
  // request storage this test process already created without it; later test files would then throw
  // on every console call. Compile the real `proxy.ts` matcher in a child process instead.
  const script = `
    const { getMiddlewareMatchers } = require("next/dist/build/analysis/get-page-static-info.js");
    const { config } = require(${JSON.stringify(join(import.meta.dir, "..", "proxy.ts"))});
    const matchers = getMiddlewareMatchers(config.matcher, {});
    const pathnames = ${JSON.stringify(pathnames)};
    process.stdout.write(JSON.stringify(Object.fromEntries(pathnames.map((p) => [p, matchers.some((m) => new RegExp(m.regexp).test(p))]))));
  `;
  const result = spawnSync(process.execPath, ["-e", script], { cwd: join(import.meta.dir, ".."), encoding: "utf8", timeout: 60_000 });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(Object.fromEntries(pathnames.map((p) => [p, p !== "/api/attachments"])));
});
