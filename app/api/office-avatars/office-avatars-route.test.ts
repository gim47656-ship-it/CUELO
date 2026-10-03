import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { GET as list } from "./route";
import { GET as model } from "./[id]/route";

// 실제 agent 디렉터리의 개인 모델을 읽지 않게 임시 디렉터리로 옮겨 두고, 끝나면 되돌린다.
const agentDir = mkdtempSync(join(tmpdir(), "cuelo-office-avatars-"));
const previousAgentDir = getAgentDir();
const BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]);

beforeAll(() => {
  setAgentDir(agentDir);
  expect(resolve(getAgentDir())).toBe(resolve(agentDir));
  mkdirSync(join(agentDir, "office-avatars"));
  writeFileSync(join(agentDir, "office-avatars", "mio.vrm"), BYTES);
  // 고정 ID 가 아닌 이름과 모델 폴더 밖의 파일은 있어도 내주지 않아야 한다.
  writeFileSync(join(agentDir, "office-avatars", "guest.vrm"), BYTES);
  writeFileSync(join(agentDir, "auth.json"), "{}");
});

afterAll(() => {
  setAgentDir(previousAgentDir);
  rmSync(agentDir, { recursive: true, force: true });
});

function request(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, { headers: { host: "localhost", ...headers } });
}

function get(id: string, headers?: Record<string, string>): Promise<Response> {
  return model(request(`/api/office-avatars/${encodeURIComponent(id)}`, headers), { params: Promise.resolve({ id }) });
}

test("목록은 설치된 고정 ID 모델만 알린다", async () => {
  const response = await list(request("/api/office-avatars"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ available: ["mio"] });
});

test("설치된 모델은 파일 그대로 내주고, 같은 파일이면 304 로 다시 쓰게 한다", async () => {
  const response = await get("mio");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("model/gltf-binary");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
  const etag = response.headers.get("etag");
  expect(etag).toBeTruthy();
  const again = await get("mio", { "if-none-match": etag! });
  expect(again.status).toBe(304);
});

test("고정 ID 가 아니면 파일이 있어도 404 다", async () => {
  for (const id of ["guest", "../auth.json", "..\\auth", "MIO", "mio.vrm", ""]) {
    const response = await get(id);
    expect(response.status).toBe(404);
  }
});

test("고정 ID 라도 이 설치에 파일이 없으면 404 다", async () => {
  expect((await get("rin")).status).toBe(404);
});

test("다른 사이트에서 온 요청은 받지 않는다", async () => {
  const response = await get("mio", { origin: "https://evil.example", "sec-fetch-site": "cross-site" });
  expect(response.status).toBe(403);
});
