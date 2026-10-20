import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { posix } from "node:path";

// 2026-10-21 사무실 실측(doc/history/2026/10/21-computer-background): WinForms에서 computer의 UIA press·setValue는
// 효과는 있지만 사용자 전면 창을 가져가고, 게시된 win.click은 오류 없이 무시됐다. 같은 컨트롤 HWND에
// SendMessage WM_SETTEXT·BM_CLICK을 보내면 전면 창을 지키며 25~45ms에 동작했다. 이 도구가 그 경로다.

export type ControlAction = "list" | "read" | "setText" | "click";

export interface WindowsControlParams {
  window: string | number;
  action: ControlAction;
  text?: string;
  className?: string;
  index?: number;
  value?: string;
  timeoutMs?: number;
}

export interface ExecResult { code: number; stdout: string; stderr?: string }
export type Exec = (command: string, args: string[], options: { cwd: string; timeout?: number }) => Promise<ExecResult>;

export interface ControlDeps {
  exec: Exec;
  cwd: string;
  /** WSL이면 스크립트 경로를 wslpath -w로 바꾼다. */
  wsl: boolean;
  scriptPath: string;
}

export interface ChildControl {
  Hwnd: number;
  ClassName: string;
  Text: string | null;
  ControlId: number;
  Visible: boolean;
  Enabled: boolean;
  /** -1: 상태를 읽을 수 없음(일반 버튼, WinForms처럼 직접 그리는 체크박스), 0: 해제, 1: 체크, 2: 불확정 */
  Check: number;
}

export interface ControlChange {
  hwnd: number;
  className: string;
  added?: boolean;
  removed?: boolean;
  text?: string | null;
  textBefore?: string | null;
  textAfter?: string | null;
  checkBefore?: number;
  checkAfter?: number;
  enabledAfter?: boolean;
  visibleAfter?: boolean;
}

export interface ControlResult {
  ok: boolean;
  error?: string;
  message?: string;
  action?: ControlAction;
  window?: number;
  windowClosed?: boolean;
  target?: ChildControl;
  targetAfter?: ChildControl | null;
  win32Error?: number;
  elapsedMs?: number;
  foregroundUnchanged?: boolean;
  changes?: ControlChange[] | ControlChange | null;
  controls?: ChildControl[] | ChildControl | null;
  matches?: ChildControl[] | ChildControl | null;
  shell?: string;
}

const DEFAULT_CLICK_TIMEOUT_MS = 2000;
const MAX_LISTED = 40;
const WIN32_TIMEOUT = 1460;
const WIN32_ACCESS_DENIED = 5;

/** 요청을 검증해 스크립트로 넘길 JSON으로 만든다. 잘못된 요청은 Windows를 부르기 전에 거절한다. */
export function buildRequest(params: WindowsControlParams): Record<string, unknown> {
  const window = Number(params.window);
  if (!Number.isSafeInteger(window) || window <= 0) {
    throw new Error(`windows_control: window는 computer.window()의 id(양의 정수 HWND)여야 한다: ${String(params.window)}`);
  }
  const needsTarget = params.action !== "list";
  if (needsTarget && params.text === undefined && params.className === undefined) {
    throw new Error("windows_control: list 말고는 text 또는 className으로 대상 컨트롤을 지정해야 한다");
  }
  if (params.action === "setText" && params.value === undefined) {
    throw new Error("windows_control: setText에는 value가 필요하다");
  }
  if (params.index !== undefined && (!Number.isInteger(params.index) || params.index < 0)) {
    throw new Error(`windows_control: index는 0 이상의 정수여야 한다: ${params.index}`);
  }
  const timeoutMs = Math.max(100, Math.min(30_000, Math.trunc(params.timeoutMs ?? DEFAULT_CLICK_TIMEOUT_MS)));
  return {
    window,
    action: params.action,
    ...(params.text !== undefined ? { text: params.text } : {}),
    ...(params.className !== undefined ? { className: params.className } : {}),
    ...(params.index !== undefined ? { index: params.index } : {}),
    ...(params.value !== undefined ? { value: params.value } : {}),
    timeoutMs,
  };
}

export async function runWindowsControl(params: WindowsControlParams, deps: ControlDeps): Promise<ControlResult> {
  const request = buildRequest(params);
  let script = deps.scriptPath;
  if (deps.wsl) {
    const converted = await deps.exec("wslpath", ["-w", deps.scriptPath], { cwd: deps.cwd });
    script = converted.stdout.trim();
    if (converted.code !== 0 || !script) throw new Error(`windows_control: wslpath 변환 실패: ${converted.stderr ?? ""}`.trim());
  }
  const encoded = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Request", encoded];
  // 사용자 결정(10-09): Windows PowerShell 7(pwsh)을 먼저 쓰고, 없을 때만 5.1로 간다.
  // "없음"은 pi.exec가 실행 파일을 찾지 못해 code ENOENT로 throw한 경우뿐이다. pwsh가 실행돼서 실패한 경우
  // (어떤 종료 코드든)는 같은 요청을 다른 셸로 다시 보내지 않는다. 버튼을 두 번 누를 수 있어서다.
  let shell = "pwsh.exe";
  let result: ExecResult;
  try {
    result = await deps.exec(shell, args, { cwd: deps.cwd, timeout: 60_000 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
    shell = "powershell.exe";
    result = await deps.exec(shell, args, { cwd: deps.cwd, timeout: 60_000 });
  }
  const line = result.stdout.split(/\r?\n/).map((text) => text.trim()).filter((text) => text.startsWith("{")).pop();
  if (!line) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim().slice(0, 600);
    throw new Error(`windows_control: ${shell} exit ${result.code}, 결과 JSON 없음${detail ? `: ${detail}` : ""}`);
  }
  return { ...(JSON.parse(line) as ControlResult), shell };
}

/** ConvertTo-Json은 원소가 하나인 배열을 객체로 내보낸다. */
function asList<T>(value: T[] | T | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function quote(text: string | null | undefined): string {
  if (text === null || text === undefined) return "(읽기 실패)";
  const flat = text.replace(/\r?\n/g, "⏎");
  return JSON.stringify(flat.length > 80 ? `${flat.slice(0, 80)}…` : flat);
}

function describe(child: ChildControl): string {
  const flags = [child.Visible ? "" : "숨김", child.Enabled ? "" : "비활성", child.Check >= 0 ? `check=${child.Check}` : ""].filter(Boolean);
  return `${child.ClassName} ${quote(child.Text)} hwnd=${child.Hwnd}${child.ControlId ? ` id=${child.ControlId}` : ""}${flags.length ? ` (${flags.join(", ")})` : ""}`;
}

function describeChange(change: ControlChange): string {
  if (change.added) return `  + ${change.className} hwnd=${change.hwnd} 새로 생김 ${quote(change.text)}`;
  if (change.removed) return `  - ${change.className} hwnd=${change.hwnd} 사라짐 ${quote(change.text)}`;
  const parts: string[] = [];
  if (change.textBefore !== change.textAfter) parts.push(`${quote(change.textBefore)} → ${quote(change.textAfter)}`);
  if (change.checkBefore !== change.checkAfter) parts.push(`check ${change.checkBefore} → ${change.checkAfter}`);
  if (parts.length === 0) parts.push(`enabled=${change.enabledAfter} visible=${change.visibleAfter}`);
  return `  ${change.className} hwnd=${change.hwnd}: ${parts.join(", ")}`;
}

function listBlock(title: string, children: ChildControl[]): string[] {
  const shown = children.slice(0, MAX_LISTED).map((child) => `  ${describe(child)}`);
  const more = children.length > MAX_LISTED ? [`  … ${children.length - MAX_LISTED}개 더`] : [];
  return [`${title} (${children.length}개):`, ...shown, ...more];
}

export function formatControlResult(result: ControlResult): string {
  const lines: string[] = [];
  if (!result.ok && result.error) {
    switch (result.error) {
      case "window-not-found":
        return `windows_control: 창 hwnd=${result.window}가 없다. computer.window()로 id를 다시 확인한다.`;
      case "control-not-found":
        return [`windows_control: 조건에 맞는 컨트롤이 없다. 아무것도 보내지 않았다.`, ...listBlock("창의 컨트롤", asList(result.controls))].join("\n");
      case "ambiguous":
        return [`windows_control: 조건에 맞는 컨트롤이 여러 개다. index로 하나를 고른다. 아무것도 보내지 않았다.`, ...listBlock("후보(index 순서)", asList(result.matches))].join("\n");
      case "index-out-of-range":
        return [`windows_control: index가 후보 수를 넘는다. 아무것도 보내지 않았다.`, ...listBlock("후보(index 순서)", asList(result.matches))].join("\n");
      case "control-disabled":
        return `windows_control: 대상이 비활성이라 아무것도 보내지 않았다: ${result.target ? describe(result.target) : ""}`;
      case "script-error":
        return `windows_control: Windows 스크립트 오류: ${result.message ?? ""}`;
    }
  }
  const foreground = result.foregroundUnchanged
    ? "전면 창 유지."
    : "주의: 호출 사이 전면 창이 바뀌었다(이 호출 때문인지 사용자 조작인지 이 결과로는 구분할 수 없다).";
  if (result.action === "list") {
    lines.push(...listBlock(`창 hwnd=${result.window}의 자식 컨트롤`, asList(result.controls)), foreground);
    return lines.join("\n");
  }
  const target = result.target ? describe(result.target) : "(대상 미상)";
  const verb = result.action === "click" ? "BM_CLICK" : result.action === "setText" ? "WM_SETTEXT" : "읽기";
  if (result.ok) {
    lines.push(`${verb} ${result.action === "read" ? "완료" : "전달"}: ${target}${result.elapsedMs !== undefined && result.action !== "read" ? ` (${result.elapsedMs}ms)` : ""}`);
  } else if (result.win32Error === WIN32_TIMEOUT) {
    lines.push(`${verb} 전달됐지만 처리기가 ${result.action === "click" ? "timeoutMs" : "2초"} 안에 끝나지 않았다(모달 창이 열렸을 수 있다): ${target}`);
  } else if (result.win32Error === WIN32_ACCESS_DENIED) {
    lines.push(`${verb} 거부됨(Win32 5): 대상 프로그램이 관리자 권한으로 실행 중이다. 아무 효과도 없다고 본다: ${target}`);
  } else {
    lines.push(`${verb} 실패(Win32 ${result.win32Error}): ${target}`);
  }
  if (result.action !== "read" && !result.windowClosed) {
    lines.push(result.targetAfter ? `대상 지금: ${describe(result.targetAfter)}` : "대상 컨트롤이 사라졌다.");
  }
  if (result.windowClosed) lines.push("창이 닫혔다.");
  const changes = asList(result.changes);
  if (result.action !== "read" && !result.windowClosed) {
    if (changes.length > 0) lines.push("창 안 컨트롤 변화:", ...changes.map(describeChange));
    else lines.push("창 안 컨트롤의 텍스트·체크·활성 변화 없음. 효과는 AX나 화면으로 확인한다(새 창이 열렸으면 computer.windows()).");
  }
  lines.push(foreground);
  return lines.join("\n");
}

const factory: CustomToolFactory = (pi) => ({
  name: "windows_control",
  label: "Windows Control",
  loadMode: "essential",
  description:
    "Drive classic Win32 controls (WinForms, VB6, MFC: buttons, check boxes, text boxes) in a Windows window WITHOUT taking the user's foreground or focus. "
    + "Sends `WM_SETTEXT` / `BM_CLICK` with SendMessageTimeout to the control's own child window, then reads every child control again and reports what changed (text, check state, enabled) and whether the foreground window stayed the same. "
    + "Use it instead of computer `el.press()`/`el.setValue()` (which bring the window to the front on Windows) or `win.click` (silently ignored by WinForms buttons). "
    + "`window` is the id from `computer.window()` (the top-level HWND). `list` shows the child controls; other actions pick one control by exact `text` and/or `className` substring, with `index` when several match (ambiguous picks are refused, nothing sent). "
    + "Not for WPF, WinUI, UWP, web/Chromium or custom-drawn controls (they have no child window per control). "
    + "Same authorization as computer input: only windows the user asked you to operate; confirm before consequential buttons (save, delete, send, start a machine).",
  parameters: pi.zod.object({
    window: pi.zod.union([pi.zod.string(), pi.zod.number()]).describe("Top-level window id from computer.window() (HWND)"),
    action: pi.zod.enum(["list", "read", "setText", "click"]).describe("list child controls, read one, set its text, or click it"),
    text: pi.zod.string().optional().describe("Exact current text/caption of the control, e.g. a button label"),
    className: pi.zod.string().optional().describe("Case-insensitive substring of the Win32 class, e.g. EDIT, BUTTON, STATIC"),
    index: pi.zod.number().optional().describe("0-based pick among several matches, in list order"),
    value: pi.zod.string().optional().describe("New text for setText"),
    timeoutMs: pi.zod.number().optional().describe("How long click waits for the button handler (default 2000; a modal dialog keeps it running)"),
  }),

  async execute(_toolCallId, params, _onUpdate, _ctx, signal) {
    const exec: Exec = (command, args, options) => pi.exec(command, args, { ...options, signal });
    const result = await runWindowsControl(params as WindowsControlParams, {
      exec,
      cwd: pi.cwd,
      wsl: process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME),
      scriptPath: posix.join(import.meta.dir, "control.ps1"),
    });
    return {
      content: [{ type: "text", text: formatControlResult(result) }],
      details: result,
    };
  },
});

export default factory;
