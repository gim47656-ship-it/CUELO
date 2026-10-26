import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCleanup, buildScript, defaultExec, isUnavailable, type Exec } from "../../tools/ego-browser/index";

// draft의 PDF 변환. ego lite가 있는 PC에서는 HTML을 ego lite TaskSpace에서 Page.printToPDF로 인쇄한다(기본 브라우저 경로).
// ego lite가 없는 PC(래퍼가 127로 끝남)에서만 기존 Windows Edge headless의 --print-to-pdf로 인쇄한다.
// ego 쪽의 다른 실패는 오류로 끝내고 Edge로 몰래 바꾸지 않는다. 맑은 고딕은 Windows 글꼴이라 Linux Chromium으로는
// 같은 결과가 나오지 않는다. 다른 환경이면 다른 형식으로 몰래 바꾸지 않고 오류로 끝낸다.

const EDGE_CANDIDATES = [
  "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const EDGE_TIMEOUT_MS = 90_000;
const EGO_TIMEOUT_MS = 90_000;
const EGO_PROBE_TIMEOUT_MS = 15_000;

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

/** 테스트에서 바꿔 끼우는 바깥 의존: ego 실행기, 작업 폴더, 폴더 삭제, Edge 인쇄. */
export interface PdfDeps {
  exec: Exec;
  /** 임시 작업 폴더. Linux 경로와, ego(Windows Node)가 보는 같은 폴더의 Windows 경로. */
  makeWork: (signal: AbortSignal) => Promise<{ dir: string; winDir: string }>;
  /** 작업 폴더 삭제. 실패하면 던진다(호출 쪽이 경고로 바꾼다). */
  remove: (dir: string) => Promise<void>;
  renderEdge: (html: string, signal: AbortSignal) => Promise<PdfResult>;
}

/** 인쇄 결과. warnings는 PDF는 만들었지만 사용자에게 알려야 하는 문제(예: 지우지 못한 임시 폴더). */
export interface PdfResult {
  pdf: Buffer;
  warnings: string[];
}

export type PdfBackend = "ego" | "edge";

/** exit 127은 래퍼가 ego lite 미설치를 알리는 코드다. 이때만 Edge로 넘어간다. */
const EGO_NOT_INSTALLED = 127;

async function probeEgo(exec: Exec, signal: AbortSignal): Promise<boolean> {
  let result;
  try {
    result = await exec(["--version"], "", { timeoutMs: EGO_PROBE_TIMEOUT_MS, signal });
  } catch (error) {
    if (isUnavailable(error)) return false;
    throw new Error(`ego lite 확인 실패: ${errorText(error)}`, { cause: error });
  }
  if (result.code === EGO_NOT_INSTALLED) return false;
  if (result.killed || result.code !== 0) throw new Error(`ego lite 확인 실패: ego-browser --version exit ${result.code}${result.killed ? ", 시간 초과" : ""}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  return true;
}

async function findEdge(): Promise<string> {
  for (const candidate of EDGE_CANDIDATES) {
    try { await access(candidate); return candidate; } catch { /* 다음 설치 위치 */ }
  }
  throw new Error(`Windows Edge(msedge.exe)를 찾지 못했습니다: ${EDGE_CANDIDATES.join(", ")}`);
}

/**
 * PDF 인쇄 수단을 확인한다. draft는 모델을 부르기 전에 이것으로 PDF 가능 여부를 먼저 본다.
 * ego lite가 있으면 "ego", 없을 때만 Windows Edge를 찾아 "edge"를 돌려준다.
 */
export async function findPdfBackend(signal: AbortSignal = new AbortController().signal, exec: Exec = defaultExec): Promise<PdfBackend> {
  if (!(await isWsl())) throw new Error("PDF 변환은 WSL에서 ego lite TaskSpace나 Windows Edge(headless 인쇄)로만 지원합니다. 이 환경에서는 .md나 .docx로 저장하세요.");
  if (await probeEgo(exec, signal)) return "ego";
  try { await findEdge(); } catch (error) {
    throw new Error(`ego lite가 없고(ego-browser 래퍼가 127로 끝남) ${error instanceof Error ? error.message : String(error)}`);
  }
  return "edge";
}

/** WSL 임시 작업 폴더를 Windows %TEMP% 아래에 만든다. UNC(\\wsl.localhost) 경로 대신 Windows 로컬 폴더를 쓴다. cmd.exe는 /mnt/c에서 실행해 UNC 경고를 피한다. */
async function makeWindowsWork(signal: AbortSignal): Promise<{ dir: string; winDir: string }> {
  const windowsTemp = (await run(["cmd.exe", "/d", "/c", "echo %TEMP%"], "/mnt/c", signal)).trim();
  if (!/^[A-Za-z]:\\/.test(windowsTemp)) throw new Error(`Windows %TEMP%를 해석하지 못했습니다: ${windowsTemp}`);
  const linuxTemp = (await run(["wslpath", "-u", windowsTemp], "/mnt/c", signal)).trim();
  const dir = await mkdtemp(join(linuxTemp, "cuelo-draft-"));
  let winDir: string;
  try {
    winDir = (await run(["wslpath", "-w", dir], "/mnt/c", signal)).trim();
  } catch (error) {
    // 되돌리기에 실패하면 조용히 넘기지 않고 남은 폴더 경로를 오류에 적는다.
    try { await removeDir(dir); } catch (removeError) {
      throw new Error(`${errorText(error)}\n경고: 임시 폴더를 지우지 못했습니다. 직접 지워도 됩니다: ${dir} (${errorText(removeError)})`, { cause: error });
    }
    throw error;
  }
  return { dir, winDir };
}

/** 작업 폴더를 지운다. 브라우저 하위 프로세스가 파일을 잠시 붙잡을 수 있어 몇 번 재시도한다. */
const removeDir = (dir: string): Promise<void> => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });

/** 지우지 못하면 조용히 넘기지 않고 남은 Windows 경로를 이름 붙인 경고로 돌려준다. */
async function removeWork(dir: string, winDir: string, remove: PdfDeps["remove"]): Promise<string[]> {
  try { await remove(dir); return []; } catch (error) {
    return [`임시 폴더를 지우지 못했습니다. 직접 지워도 됩니다: ${winDir} (${errorText(error)})`];
  }
}

function pdfOrThrow(pdf: Buffer, who: string): Buffer {
  if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error(`${who} 출력이 PDF가 아닙니다.`);
  return pdf;
}

async function renderEdge(html: string, signal: AbortSignal, makeWork: PdfDeps["makeWork"], remove: PdfDeps["remove"]): Promise<PdfResult> {
  const edge = await findEdge();
  const { dir, winDir } = await makeWork(signal);
  let pdf: Buffer | undefined;
  let failure: unknown;
  try {
    await writeFile(join(dir, "page.html"), html, "utf8");
    const url = `file:///${encodeURI(`${winDir}\\page.html`.replaceAll("\\", "/"))}`;
    const attempt = AbortSignal.any([signal, AbortSignal.timeout(EDGE_TIMEOUT_MS)]);
    // 사용자 Edge와 섞이지 않게 절대 경로의 격리 프로필을 쓴다(잘못된 프로필 경로는 데스크톱 오류 창을 띄운다).
    await run([edge, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
      `--user-data-dir=${winDir}\\profile`, "--no-pdf-header-footer", `--print-to-pdf=${winDir}\\out.pdf`, url], dir, attempt);
    let bytes: Buffer;
    try { bytes = await readFile(join(dir, "out.pdf")); } catch { throw new Error("Edge가 PDF를 만들지 않았습니다."); }
    pdf = pdfOrThrow(bytes, "Edge");
  } catch (error) { failure = error; }
  const warnings = await removeWork(dir, winDir, remove);
  if (failure !== undefined) throw withWarnings(failure, warnings);
  return { pdf: pdf!, warnings };
}

/**
 * ego Node(Windows)에서 도는 본문. 사용자 기본 프로필의 공간이라 로그인 쿠키가 외부로 나가지 않게 막은 뒤 로컬 HTML 파일만 열어 인쇄한다.
 * 1) Network.setBlockedURLs로 http·https·ws·wss 요청을 막는다(HTML이 가져오는 이미지·CSS·fetch).
 * 2) 그러나 WebSocket은 setBlockedURLs로 막히지 않는다(10-26 실측: 차단 중에도 로컬 서버에 `/ws` 핸드셰이크가 도착했다).
 *    그래서 페이지 스크립트 실행을 끈다. draft의 HTML은 `toHtml`이 만든 정적 문서(스크립트 없음, 본문은 이스케이프)라 인쇄 결과는 같다.
 * A4와 여백은 HTML의 CSS(@page)가 정한다.
 */
export function egoBody(url: string, output: string): string {
  return `const fs = await import("node:fs/promises");
await page.cdp("Network.enable", {});
await page.cdp("Network.setBlockedURLs", { urls: ["http://*", "https://*", "ws://*", "wss://*"] });
await page.cdp("Emulation.setScriptExecutionDisabled", { value: true });
await page.goto(${JSON.stringify(url)});
const printed = await page.cdp("Page.printToPDF", { printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false });
if (!printed || !printed.data) throw new Error("Page.printToPDF가 데이터를 돌려주지 않았다");
await fs.writeFile(${JSON.stringify(output)}, Buffer.from(printed.data, "base64"));
`;
}

/** 이름으로 TaskSpace를 찾아 닫는다. 실패하면 사유를, 성공하면 null을 돌려준다. */
async function closeSpace(name: string, exec: Exec): Promise<string | null> {
  try {
    const result = await exec(["nodejs"], buildCleanup(name), { timeoutMs: 30_000 });
    if (result.killed || result.code !== 0) return `정리 스크립트 exit ${result.code}${result.killed ? ", 시간 초과" : ""}: ${(result.stderr || result.stdout).trim().slice(0, 200)}`;
    return null;
  } catch (error) {
    return errorText(error);
  }
}

/** 실행이 도중에 끊긴 경우: 공간을 닫아 보고, 닫지 못했으면 오류에 남아 있을 수 있다고 적는다. */
async function failWithCleanup(headline: string, name: string, exec: Exec): Promise<never> {
  const problem = await closeSpace(name, exec);
  throw new Error(problem === null ? `${headline}(TaskSpace ${name}은 정리했습니다)` : `${headline} TaskSpace ${name} may remain (정리 실패: ${problem})`);
}

/** ego 인쇄 결과. pdf가 null이면 ego lite 미설치(127/ENOENT)라 Edge로 넘어가도 된다는 뜻이고, warnings는 그 사이 생긴 경고다. */
type EgoOutcome = { pdf: Buffer | null; warnings: string[] };

/**
 * ego lite TaskSpace(호출마다 새로 만든 전용 공간, 사용자 기본 프로필)로 인쇄한다. 공간은 성공·실패와 무관하게 닫는다(buildScript finish).
 * 그 밖의 실패는 ego를 이름에 넣은 오류로 던지며, 그때도 임시 폴더 경고는 오류 문구에 붙는다.
 */
async function renderEgo(html: string, signal: AbortSignal, deps: PdfDeps): Promise<EgoOutcome> {
  const { dir, winDir } = await deps.makeWork(signal);
  const name = `cuelo-draft-pdf-${randomUUID().slice(0, 8)}`;
  let pdf: Buffer | null = null;
  let failure: unknown;
  try {
    await writeFile(join(dir, "page.html"), html, "utf8");
    const url = `file:///${encodeURI(`${winDir}\\page.html`.replaceAll("\\", "/"))}`;
    const script = buildScript(name, "user", egoBody(url, `${winDir}\\out.pdf`), true);
    let result;
    try {
      result = await deps.exec(["nodejs"], script, { timeoutMs: EGO_TIMEOUT_MS, signal });
    } catch (error) {
      if (!isUnavailable(error)) return await failWithCleanup(`ego lite PDF 인쇄 실패: ${errorText(error)}`, name, deps.exec);
    }
    if (result !== undefined && result.code !== EGO_NOT_INSTALLED) {
      if (result.killed) {
        // 시간 초과·취소로 스크립트가 죽으면 finally가 못 돌았을 수 있어 이름으로 찾아 닫는다.
        return await failWithCleanup(`ego lite PDF 인쇄가 ${Math.round(EGO_TIMEOUT_MS / 1000)}초 안에 끝나지 않았거나 취소됐습니다.`, name, deps.exec);
      }
      if (result.code !== 0) throw new Error(`ego lite PDF 인쇄 실패(exit ${result.code}, TaskSpace ${name}): ${(result.stderr || result.stdout).trim().slice(0, 600)}`);
      let bytes: Buffer;
      try { bytes = await readFile(join(dir, "out.pdf")); } catch { throw new Error(`ego lite가 PDF 파일을 만들지 않았습니다(TaskSpace ${name}).`); }
      pdf = pdfOrThrow(bytes, "ego lite");
    }
  } catch (error) { failure = error; }
  const warnings = await removeWork(dir, winDir, deps.remove);
  if (failure !== undefined) throw withWarnings(failure, warnings);
  return { pdf, warnings };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 실패에는 PDF가 없어 결과 경고를 실을 곳이 없다. 경고(남은 임시 폴더 등)를 오류 문구에 붙여 잃지 않는다. */
function withWarnings(error: unknown, warnings: string[]): unknown {
  if (warnings.length === 0) return error;
  return new Error([errorText(error), ...warnings.map((warning) => `경고: ${warning}`)].join("\n"), { cause: error });
}

/** HTML을 PDF로 인쇄한다(A4 등 용지는 HTML의 CSS). 임시 HTML·PDF는 Windows %TEMP% 아래 전용 폴더에 두고 끝나면 지운다. 지우지 못하면 warnings에 남은 경로를 적는다(실패할 때는 오류 문구에 붙는다). */
export async function renderPdf(html: string, signal: AbortSignal, deps: Partial<PdfDeps> = {}): Promise<PdfResult> {
  if (!deps.exec && !(await isWsl())) throw new Error("PDF 변환은 WSL에서 ego lite TaskSpace나 Windows Edge(headless 인쇄)로만 지원합니다. 이 환경에서는 .md나 .docx로 저장하세요.");
  const makeWork = deps.makeWork ?? makeWindowsWork;
  const remove = deps.remove ?? removeDir;
  const full: PdfDeps = {
    exec: deps.exec ?? defaultExec,
    makeWork,
    remove,
    renderEdge: deps.renderEdge ?? ((page, abort) => renderEdge(page, abort, makeWork, remove)),
  };
  const ego = await renderEgo(html, signal, full);
  if (ego.pdf) return { pdf: ego.pdf, warnings: ego.warnings };
  // ego lite가 없을 때만 Edge로 넘어간다. ego 쪽에서 생긴 경고는 Edge 결과(또는 Edge 실패 오류)에 이어 붙인다.
  try {
    const edge = await full.renderEdge(html, signal);
    return { pdf: edge.pdf, warnings: [...ego.warnings, ...edge.warnings] };
  } catch (error) { throw withWarnings(error, ego.warnings); }
}
