import { describe, expect, test } from "bun:test";
import { buildRequest, formatControlResult, runWindowsControl, type ChildControl, type Exec, type ExecResult } from "./index";

const apply: ChildControl = { Hwnd: 11, ClassName: "WindowsForms10.BUTTON.app.0.x", Text: "Apply", ControlId: 11, Visible: true, Enabled: true, Check: -1 };
const enable: ChildControl = { ...apply, Hwnd: 12, Text: "Enable", ControlId: 12 };

function fakeExec(answers: Record<string, ExecResult | Error>): { exec: Exec; calls: { command: string; args: string[] }[] } {
  const calls: { command: string; args: string[] }[] = [];
  const exec: Exec = async (command, args) => {
    calls.push({ command, args });
    const answer = answers[command];
    if (answer instanceof Error) throw answer;
    if (!answer) throw new Error(`unexpected ${command}`);
    return answer;
  };
  return { exec, calls };
}

describe("buildRequest", () => {
  test("refuses requests that cannot address one control before calling Windows", () => {
    expect(() => buildRequest({ window: "0", action: "list" })).toThrow("양의 정수");
    expect(() => buildRequest({ window: "12ab", action: "list" })).toThrow("양의 정수");
    expect(() => buildRequest({ window: 5, action: "click" })).toThrow("text 또는 className");
    expect(() => buildRequest({ window: 5, action: "setText", className: "EDIT" })).toThrow("value");
    expect(() => buildRequest({ window: 5, action: "click", text: "OK", index: -1 })).toThrow("index");
  });

  test("bounds the click wait and keeps an empty setText value", () => {
    expect(buildRequest({ window: "5", action: "click", text: "OK", timeoutMs: 999_999 }).timeoutMs).toBe(30_000);
    expect(buildRequest({ window: 5, action: "setText", className: "EDIT", value: "" }).value).toBe("");
  });
});

describe("runWindowsControl", () => {
  const ok: ExecResult = { code: 0, stdout: `noise\r\n${JSON.stringify({ ok: true, action: "list", window: 5, foregroundUnchanged: true, controls: [apply] })}\r\n` };

  test("passes the request as one base64 argument and falls back to Windows PowerShell 5.1 when pwsh is missing", async () => {
    // pi.exec(ptree) throws an ENOENT-coded error when the executable is not on PATH.
    const missing = Object.assign(new Error('Executable not found in $PATH: "pwsh.exe"'), { code: "ENOENT" });
    const { exec, calls } = fakeExec({
      wslpath: { code: 0, stdout: "\\\\wsl.localhost\\Ubuntu\\x\\control.ps1\n" },
      "pwsh.exe": missing,
      "powershell.exe": ok,
    });
    const result = await runWindowsControl({ window: 5, action: "click", text: "그 \"버튼\"" }, { exec, cwd: "/w", wsl: true, scriptPath: "/x/control.ps1" });
    expect(result.shell).toBe("powershell.exe");
    const args = calls.at(-1)!.args;
    expect(args[args.indexOf("-File") + 1]).toBe("\\\\wsl.localhost\\Ubuntu\\x\\control.ps1");
    const sent = JSON.parse(Buffer.from(args[args.indexOf("-Request") + 1], "base64").toString("utf8"));
    expect(sent).toEqual({ window: 5, action: "click", text: "그 \"버튼\"", timeoutMs: 2000 });
  });

  test("does not fall back when pwsh ran and failed, whatever the exit code or message", async () => {
    const failures: ExecResult[] = [
      { code: 1, stdout: "", stderr: "Add-Type: compile error" },
      { code: 1, stdout: "", stderr: "Cannot find path 'C:\\x' because it does not exist." },
      { code: 127, stdout: "", stderr: "exited 127 without output" },
    ];
    for (const failure of failures) {
      const { exec, calls } = fakeExec({ "pwsh.exe": failure });
      await expect(runWindowsControl({ window: 5, action: "list" }, { exec, cwd: "/w", wsl: false, scriptPath: "C:\\x.ps1" }))
        .rejects.toThrow(failure.stderr!.slice(0, 20));
      expect(calls.map((call) => call.command)).toEqual(["pwsh.exe"]);
    }
  });

  test("an exec failure other than a missing pwsh is not retried with 5.1", async () => {
    const { exec, calls } = fakeExec({ "pwsh.exe": new Error("request failed: ENOENT in message only") });
    await expect(runWindowsControl({ window: 5, action: "list" }, { exec, cwd: "/w", wsl: false, scriptPath: "C:\\x.ps1" })).rejects.toThrow("message only");
    expect(calls.map((call) => call.command)).toEqual(["pwsh.exe"]);
  });
});

describe("formatControlResult", () => {
  test("an ambiguous pick lists the candidates and says nothing was sent", () => {
    const text = formatControlResult({ ok: false, error: "ambiguous", window: 5, matches: [apply, enable] });
    expect(text).toContain("아무것도 보내지 않았다");
    expect(text).toContain("\"Apply\" hwnd=11");
    expect(text).toContain("\"Enable\" hwnd=12");
  });

  test("reads PowerShell's single-object form of a one-element change list", () => {
    const text = formatControlResult({
      ok: true, action: "click", window: 5, target: apply, targetAfter: apply, win32Error: 0, elapsedMs: 15, foregroundUnchanged: true,
      changes: { hwnd: 13, className: "STATIC", textBefore: "idle", textAfter: "applied:x", checkBefore: -1, checkAfter: -1 },
    });
    expect(text).toContain("\"idle\" → \"applied:x\"");
    expect(text).toContain("전면 창 유지");
  });

  test("a handler still running after the wait is reported as delivered, not as a failure to retry", () => {
    const text = formatControlResult({ ok: false, action: "click", window: 5, target: apply, win32Error: 1460, foregroundUnchanged: false, changes: [] });
    expect(text).toContain("전달됐지만");
    expect(text).toContain("모달");
    expect(text).toContain("전면 창이 바뀌었다");
  });

  test("a control the click removed is reported, not hidden behind 'no change'", () => {
    const text = formatControlResult({
      ok: true, action: "click", window: 5, target: apply, targetAfter: null, win32Error: 0, foregroundUnchanged: true,
      changes: [{ hwnd: 11, className: "BUTTON", removed: true, text: "Apply" }],
    });
    expect(text).toContain("대상 컨트롤이 사라졌다");
    expect(text).toContain("hwnd=11 사라짐");
    expect(text).not.toContain("변화 없음");
  });

  test("list reports the measured foreground state", () => {
    const text = formatControlResult({ ok: true, action: "list", window: 5, foregroundUnchanged: false, controls: [apply] });
    expect(text).toContain("\"Apply\" hwnd=11");
    expect(text).toContain("전면 창이 바뀌었다");
  });
});
