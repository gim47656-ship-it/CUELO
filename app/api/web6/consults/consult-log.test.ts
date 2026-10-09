import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConsults, resolveConsultLogPaths } from "./consult-log";

const root = mkdtempSync(join(tmpdir(), "cuelo-consult-log-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const home = join(root, "wsl-home");
const mountRoot = join(root, "mnt");
const WSL = { WSL_DISTRO_NAME: "Ubuntu-24.04" };

function line(sessionId: string, startedAt: number, text: string) {
  return JSON.stringify({ sessionId, startedAt, finishedAt: startedAt + 1, model: "gpt-6-pro", status: "ok", text });
}

function writeLog(userHome: string, lines: string[]) {
  mkdirSync(join(userHome, ".omp"), { recursive: true });
  const path = join(userHome, ".omp", "web6-consults.jsonl");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

const kim = join(mountRoot, "c", "Users", "kim");
const other = join(mountRoot, "c", "Users", "other");
const kimLog = writeLog(kim, [line("s1", 10, "windows-a"), line("s2", 11, "other-session"), "{broken", line("s1", 30, "windows-b")]);
const otherLog = writeLog(other, [line("s1", 99, "other-user")]);
utimesSync(otherLog, new Date(1_000), new Date(1_000));

test("WSL이 아니면 홈의 기록만 본다", async () => {
  expect(await resolveConsultLogPaths({ home, env: {}, mountRoot })).toEqual([join(home, ".omp", "web6-consults.jsonl")]);
});

test("WSL에서는 helper 경로가 가리키는 Windows 사용자의 기록을 홈 기록 뒤에 읽는다", async () => {
  const env = { ...WSL, CUELO_WINDOWS_COMPUTER_HOST: join(kim, "AppData", "Local", "cuelo-windows-computer", "cuelo-computer-host.exe") };
  expect(await resolveConsultLogPaths({ home, env, mountRoot })).toEqual([join(home, ".omp", "web6-consults.jsonl"), kimLog]);
});

test("helper 경로가 없으면 /mnt/c/Users 중 가장 최근에 갱신된 기록을 쓴다", async () => {
  expect(await resolveConsultLogPaths({ home, env: WSL, mountRoot })).toEqual([join(home, ".omp", "web6-consults.jsonl"), kimLog]);
});

test("홈 기록과 Windows 기록을 sessionId로 거르고 시작 시각 순으로 합친다", async () => {
  const wslLog = writeLog(home, [line("s1", 20, "wsl-local")]);
  const env = { ...WSL, CUELO_WINDOWS_COMPUTER_HOST: join(kim, "AppData", "Local", "x", "host.exe") };
  const consults = await readConsults("s1", { home, env, mountRoot });
  expect(consults.map((c) => c.text)).toEqual(["windows-a", "wsl-local", "windows-b"]);
  rmSync(wslLog);
  expect((await readConsults("s1", { home, env, mountRoot })).map((c) => c.text)).toEqual(["windows-a", "windows-b"]);
  expect(await readConsults("nobody", { home, env, mountRoot })).toEqual([]);
});

test("기록 파일이 어디에도 없으면 빈 목록이다", async () => {
  expect(await readConsults("s1", { home: join(root, "nothing"), env: WSL, mountRoot: join(root, "no-mnt") })).toEqual([]);
});
