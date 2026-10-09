import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// draft의 PDF 변환. WSL에서 Windows Edge headless의 --print-to-pdf로 HTML을 인쇄한다.
// 맑은 고딕은 Windows 글꼴이라 Linux Chromium으로는 같은 결과가 나오지 않는다. 다른 환경이면
// 다른 형식으로 몰래 바꾸지 않고 오류로 끝낸다.

const EDGE_CANDIDATES = [
  "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const EDGE_TIMEOUT_MS = 90_000;

async function run(command: string[], cwd: string, signal: AbortSignal): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", signal });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${command[0]} 종료 코드 ${code}: ${(err || out).trim().slice(0, 400)}`);
  return out;
}

async function isWsl(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try { return /microsoft/i.test(await readFile("/proc/version", "utf8")); } catch { return false; }
}

/** WSL과 Windows Edge가 있는지 확인한다. draft는 모델을 부르기 전에 이것으로 PDF 가능 여부를 먼저 본다. */
export async function findEdge(): Promise<string> {
  if (!(await isWsl())) throw new Error("PDF 변환은 WSL에서 Windows Edge(headless 인쇄)로만 지원합니다. 이 환경에서는 .md나 .docx로 저장하세요.");
  for (const candidate of EDGE_CANDIDATES) {
    try { await access(candidate); return candidate; } catch { /* 다음 설치 위치 */ }
  }
  throw new Error(`Windows Edge(msedge.exe)를 찾지 못했습니다: ${EDGE_CANDIDATES.join(", ")}`);
}

/** HTML을 A4 PDF 바이트로 인쇄한다. 임시 HTML·Edge 프로필·PDF는 Windows %TEMP% 아래 전용 폴더에 두고 끝나면 지운다. */
export async function renderPdf(html: string, signal: AbortSignal): Promise<Buffer> {
  const edge = await findEdge();
  // UNC(\\wsl.localhost) 경로 대신 Windows 로컬 임시 폴더를 쓴다. cmd.exe는 /mnt/c에서 실행해 UNC 경고를 피한다.
  const windowsTemp = (await run(["cmd.exe", "/d", "/c", "echo %TEMP%"], "/mnt/c", signal)).trim();
  if (!/^[A-Za-z]:\\/.test(windowsTemp)) throw new Error(`Windows %TEMP%를 해석하지 못했습니다: ${windowsTemp}`);
  const linuxTemp = (await run(["wslpath", "-u", windowsTemp], "/mnt/c", signal)).trim();
  const work = await mkdtemp(join(linuxTemp, "cuelo-draft-"));
  try {
    const page = join(work, "page.html");
    const output = join(work, "out.pdf");
    await writeFile(page, html, "utf8");
    const [winPage, winOutput, winProfile] = await Promise.all([page, output, join(work, "profile")]
      .map(async (path) => (await run(["wslpath", "-w", path], "/mnt/c", signal)).trim()));
    const url = `file:///${encodeURI(winPage!.replaceAll("\\", "/"))}`;
    const attempt = AbortSignal.any([signal, AbortSignal.timeout(EDGE_TIMEOUT_MS)]);
    // 사용자 Edge와 섞이지 않게 절대 경로의 격리 프로필을 쓴다(잘못된 프로필 경로는 데스크톱 오류 창을 띄운다).
    await run([edge, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
      `--user-data-dir=${winProfile}`, "--no-pdf-header-footer", `--print-to-pdf=${winOutput}`, url], work, attempt);
    let pdf: Buffer;
    try { pdf = await readFile(output); } catch { throw new Error("Edge가 PDF를 만들지 않았습니다."); }
    if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("Edge 출력이 PDF가 아닙니다.");
    return pdf;
  } finally {
    // Edge 하위 프로세스가 프로필 파일을 잠시 붙잡을 수 있어 몇 번 재시도한다.
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 }).catch(() => undefined);
  }
}
