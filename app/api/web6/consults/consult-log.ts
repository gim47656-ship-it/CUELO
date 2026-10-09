/**
 * 상담 기록 JSONL 의 위치 찾기와 읽기.
 *
 * 기록을 쓰는 shim(`CUELO_Setup/web6/web6-server.js`)은 Windows 프로세스라 기록이 Windows 프로필
 * `%USERPROFILE%\.omp\web6-consults.jsonl` 에 쌓인다. WSL 에서 도는 앱의 `homedir()` 에는 그 파일이
 * 없으므로, WSL 이면 Windows 프로필의 같은 파일을 `/mnt/<드라이브>/Users/<사용자>/.omp/` 로 읽는다.
 * 복사하지 않는다 — 살아 있는 정본을 매번 읽어야 새 상담이 보인다.
 */
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseConsultLine, type Web6ConsultRecord } from "@/lib/hanse-web6-client";

const LOG_RELATIVE = join(".omp", "web6-consults.jsonl");

/**
 * 한 파일에서 읽는 최대 바이트. shim 이 파일을 2MB 로 제한하지만 대화창은 최근 상담만 쓰므로
 * 꼬리만 읽는다 — 폴링마다 전부 읽으면 파일 크기가 그대로 폴링 비용이 된다.
 */
export const TAIL_BYTES = 512 * 1024;

/** 한 응답에 싣는 최대 건수. 이보다 오래된 상담은 화면에 설 턴이 이미 지나갔다. */
export const MAX_RECORDS = 100;

export interface ConsultLogEnv {
  home?: string;
  env?: Record<string, string | undefined>;
  /** Windows 드라이브가 마운트되는 자리. WSL 은 `/mnt` 다. */
  mountRoot?: string;
}

/** `/mnt/c/Users/<user>/AppData/...` 같은 경로에서 `/mnt/c/Users/<user>` 을 뽑는다. 아니면 null. */
function windowsHomeFromPath(path: string | undefined, mountRoot: string): string | null {
  if (!path) return null;
  const normalized = path.replace(/\\/g, "/");
  const root = mountRoot.replace(/\/+$/, "");
  if (!normalized.startsWith(`${root}/`)) return null;
  const parts = normalized.slice(root.length + 1).split("/");
  // <드라이브>/Users/<사용자>/...
  if (parts.length < 3 || parts[0].length !== 1 || parts[1].toLowerCase() !== "users" || !parts[2]) return null;
  return `${root}/${parts[0]}/${parts[1]}/${parts[2]}`;
}

async function newestWindowsLog(mountRoot: string): Promise<string | null> {
  const usersDir = join(mountRoot, "c", "Users");
  let names: string[];
  try {
    names = await readdir(usersDir);
  } catch {
    return null;
  }
  let best: { path: string; mtimeMs: number } | null = null;
  for (const name of names) {
    const path = join(usersDir, name, LOG_RELATIVE);
    try {
      const info = await stat(path);
      if (info.isFile() && (!best || info.mtimeMs > best.mtimeMs)) best = { path, mtimeMs: info.mtimeMs };
    } catch {
      // 이 사용자에게는 상담 기록이 없다.
    }
  }
  return best?.path ?? null;
}

/**
 * 읽을 기록 파일 후보. 첫 번째는 언제나 이 프로세스의 홈이고, WSL 이면 Windows 프로필의 파일이 뒤따른다.
 * Windows 프로필은 CUELO 가 서비스에 넘기는 `CUELO_WINDOWS_COMPUTER_HOST`(Windows 사용자 폴더 아래의
 * helper 경로)에서 먼저 찾고, 그 값이 없을 때만 `/mnt/c/Users/*` 에서 가장 최근에 갱신된 기록을 쓴다.
 */
export async function resolveConsultLogPaths(options: ConsultLogEnv = {}): Promise<string[]> {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const mountRoot = options.mountRoot ?? "/mnt";
  const paths = [join(home, LOG_RELATIVE)];

  if (!env.WSL_DISTRO_NAME) return paths;

  const windowsHome = windowsHomeFromPath(env.CUELO_WINDOWS_COMPUTER_HOST, mountRoot);
  const windowsLog = windowsHome ? join(windowsHome, LOG_RELATIVE) : await newestWindowsLog(mountRoot);
  if (windowsLog && !paths.includes(windowsLog)) paths.push(windowsLog);
  return paths;
}

/** 파일 꼬리에서 `sessionId` 와 정확히 일치하는 기록. 파일이 없거나 못 읽으면 빈 목록이다. */
export async function readConsultsFromLog(path: string, sessionId: string): Promise<Web6ConsultRecord[]> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    // 파일 부재가 기본 상태다. 읽기 권한이 없는 경우도 화면에는 똑같이 "상담 없음"이다.
    return [];
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);

    let text = buffer.toString("utf8");
    if (size > length) {
      // 꼬리만 읽었으므로 첫 줄은 반쪽이다. 통째로 버린다(부분 복구를 시도하지 않는다).
      const firstBreak = text.indexOf("\n");
      text = firstBreak < 0 ? "" : text.slice(firstBreak + 1);
    }

    const consults: Web6ConsultRecord[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const record = parseConsultLine(line);
      if (record?.sessionId === sessionId) consults.push(record);
    }
    return consults;
  } finally {
    await handle.close();
  }
}

/** 후보 파일들의 기록을 시작 시각 순으로 합쳐 최근 `MAX_RECORDS` 건만 돌려준다. */
export async function readConsults(sessionId: string, options: ConsultLogEnv = {}): Promise<Web6ConsultRecord[]> {
  const paths = await resolveConsultLogPaths(options);
  const lists = await Promise.all(paths.map((path) => readConsultsFromLog(path, sessionId)));
  return lists.flat().sort((a, b) => a.startedAt - b.startedAt).slice(-MAX_RECORDS);
}
