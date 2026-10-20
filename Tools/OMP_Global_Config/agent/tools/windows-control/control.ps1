param([Parameter(Mandatory = $true)][string]$Request)
# windows_control 도구의 Windows 쪽 본체. 요청은 base64(UTF-8 JSON) 한 인자로 받는다(WSL 인자 따옴표 문제를 피한다).
# 클래식 Win32 컨트롤(WinForms·VB6·MFC)의 자식 창에 SendMessageTimeout으로 WM_SETTEXT·BM_CLICK을 보낸다.
# 전면 창·포커스는 바꾸지 않는다(SetForegroundWindow·SetFocus·SendInput을 쓰지 않는다).
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class CueloChild {
    public long Hwnd;
    public string ClassName;
    public string Text;
    public int ControlId;
    public bool Visible;
    public bool Enabled;
    public int Check;
}

public static class CueloWin {
    private delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr h);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr h);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr h, int index);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "SendMessageTimeoutW")]
    private static extern IntPtr SendMessageTimeoutText(IntPtr h, uint m, IntPtr w, StringBuilder l, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "SendMessageTimeoutW")]
    private static extern IntPtr SendMessageTimeoutString(IntPtr h, uint m, IntPtr w, string l, uint flags, uint timeout, out IntPtr result);

    private const uint SMTO_ABORTIFHUNG = 2;
    private const uint WM_SETTEXT = 0x000C, WM_GETTEXT = 0x000D, WM_GETTEXTLENGTH = 0x000E;
    private const uint BM_GETCHECK = 0x00F0, BM_CLICK = 0x00F5;
    private const int GWL_STYLE = -16;

    public static bool Exists(long hwnd) { return IsWindow(new IntPtr(hwnd)); }

    public static string ReadText(IntPtr h) {
        IntPtr length;
        if (SendMessageTimeout(h, WM_GETTEXTLENGTH, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, 1000, out length) == IntPtr.Zero) return null;
        int n = (int)length.ToInt64();
        if (n < 0) n = 0;
        if (n > 65535) n = 65535;
        StringBuilder buffer = new StringBuilder(n + 1);
        IntPtr copied;
        if (SendMessageTimeoutText(h, WM_GETTEXT, new IntPtr(n + 1), buffer, SMTO_ABORTIFHUNG, 1000, out copied) == IntPtr.Zero) return null;
        return buffer.ToString();
    }

    // Check state only for check-box and radio-button styles; push buttons report -1.
    private static int CheckState(IntPtr h, string className) {
        if (className.IndexOf("BUTTON", StringComparison.OrdinalIgnoreCase) < 0) return -1;
        int kind = GetWindowLong(h, GWL_STYLE) & 0xF;
        if (kind != 2 && kind != 3 && kind != 4 && kind != 5 && kind != 6 && kind != 9) return -1;
        IntPtr state;
        if (SendMessageTimeout(h, BM_GETCHECK, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, 1000, out state) == IntPtr.Zero) return -1;
        return (int)state.ToInt64();
    }

    public static CueloChild Describe(IntPtr h) {
        StringBuilder cls = new StringBuilder(256);
        GetClassName(h, cls, 256);
        CueloChild child = new CueloChild();
        child.Hwnd = h.ToInt64();
        child.ClassName = cls.ToString();
        child.Text = ReadText(h);
        child.ControlId = GetDlgCtrlID(h);
        child.Visible = IsWindowVisible(h);
        child.Enabled = IsWindowEnabled(h);
        child.Check = CheckState(h, child.ClassName);
        return child;
    }

    public static List<CueloChild> Children(long top) {
        List<CueloChild> list = new List<CueloChild>();
        EnumChildWindows(new IntPtr(top), delegate (IntPtr h, IntPtr l) { list.Add(Describe(h)); return true; }, IntPtr.Zero);
        return list;
    }

    // Returns 0 when delivered; otherwise the Win32 error (1460 = timeout, e.g. a modal dialog is still open; 5 = elevated target).
    public static int SetText(long hwnd, string value) {
        IntPtr result;
        if (SendMessageTimeoutString(new IntPtr(hwnd), WM_SETTEXT, IntPtr.Zero, value, SMTO_ABORTIFHUNG, 2000, out result) != IntPtr.Zero) return 0;
        int error = Marshal.GetLastWin32Error();
        return error == 0 ? -1 : error;
    }

    public static int Click(long hwnd, uint timeoutMs) {
        IntPtr result;
        if (SendMessageTimeout(new IntPtr(hwnd), BM_CLICK, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, timeoutMs, out result) != IntPtr.Zero) return 0;
        int error = Marshal.GetLastWin32Error();
        return error == 0 ? -1 : error;
    }
}
"@

function Write-Result($value) { $value | ConvertTo-Json -Depth 5 -Compress }

function Get-Changes($before, $after) {
    $old = @{}
    foreach ($child in $before) { $old[$child.Hwnd] = $child }
    $changes = @()
    foreach ($child in $after) {
        $prev = $old[$child.Hwnd]
        if ($null -eq $prev) {
            $changes += [ordered]@{ hwnd = $child.Hwnd; className = $child.ClassName; added = $true; text = $child.Text }
            continue
        }
        if ($prev.Text -ne $child.Text -or $prev.Check -ne $child.Check -or $prev.Enabled -ne $child.Enabled -or $prev.Visible -ne $child.Visible) {
            $changes += [ordered]@{
                hwnd = $child.Hwnd; className = $child.ClassName
                textBefore = $prev.Text; textAfter = $child.Text
                checkBefore = $prev.Check; checkAfter = $child.Check
                enabledAfter = $child.Enabled; visibleAfter = $child.Visible
            }
        }
    }
    # 사라진 컨트롤도 변화다(창은 남았는데 버튼이 자식을 없앤 경우).
    $now = @{}
    foreach ($child in $after) { $now[$child.Hwnd] = $true }
    foreach ($child in $before) {
        if (-not $now.ContainsKey($child.Hwnd)) {
            $changes += [ordered]@{ hwnd = $child.Hwnd; className = $child.ClassName; removed = $true; text = $child.Text }
        }
    }
    , $changes
}

try {
    $req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Request)) | ConvertFrom-Json
    $window = [long]$req.window
    $foregroundBefore = [CueloWin]::GetForegroundWindow().ToInt64()
    if (-not [CueloWin]::Exists($window)) {
        Write-Result ([ordered]@{ ok = $false; error = 'window-not-found'; window = $window }); exit 0
    }
    $before = [CueloWin]::Children($window)
    if ($req.action -eq 'list') {
        $foregroundAfter = [CueloWin]::GetForegroundWindow().ToInt64()
        Write-Result ([ordered]@{ ok = $true; action = 'list'; window = $window; foregroundUnchanged = ($foregroundBefore -eq $foregroundAfter); controls = $before }); exit 0
    }

    $found = @($before | Where-Object {
        ($null -eq $req.text -or $_.Text -ceq [string]$req.text) -and
        ($null -eq $req.className -or $_.ClassName.IndexOf([string]$req.className, [StringComparison]::OrdinalIgnoreCase) -ge 0)
    })
    if ($found.Count -eq 0) {
        Write-Result ([ordered]@{ ok = $false; error = 'control-not-found'; window = $window; controls = $before }); exit 0
    }
    if ($null -ne $req.index) {
        $index = [int]$req.index
        if ($index -lt 0 -or $index -ge $found.Count) {
            Write-Result ([ordered]@{ ok = $false; error = 'index-out-of-range'; window = $window; matches = $found }); exit 0
        }
        $target = $found[$index]
    } elseif ($found.Count -gt 1) {
        Write-Result ([ordered]@{ ok = $false; error = 'ambiguous'; window = $window; matches = $found }); exit 0
    } else {
        $target = $found[0]
    }

    # 바꾸는 동작은 비활성 컨트롤에 보내지 않는다(사용자가 막아 둔 입력칸·버튼이다).
    if ($req.action -ne 'read' -and -not $target.Enabled) {
        Write-Result ([ordered]@{ ok = $false; error = 'control-disabled'; window = $window; target = $target }); exit 0
    }
    $code = 0
    $started = [Diagnostics.Stopwatch]::StartNew()
    switch ($req.action) {
        'setText' { $code = [CueloWin]::SetText($target.Hwnd, [string]$req.value) }
        'click' { $code = [CueloWin]::Click($target.Hwnd, [uint32]$req.timeoutMs) }
        'read' { }
        default { throw "unknown action $($req.action)" }
    }
    $started.Stop()
    $after = if ([CueloWin]::Exists($window)) { [CueloWin]::Children($window) } else { @() }
    $foregroundAfter = [CueloWin]::GetForegroundWindow().ToInt64()
    Write-Result ([ordered]@{
        ok = ($code -eq 0)
        action = $req.action
        window = $window
        windowClosed = -not [CueloWin]::Exists($window)
        target = $target
        targetAfter = ($after | Where-Object { $_.Hwnd -eq $target.Hwnd } | Select-Object -First 1)
        win32Error = $code
        elapsedMs = $started.ElapsedMilliseconds
        foregroundUnchanged = ($foregroundBefore -eq $foregroundAfter)
        changes = (Get-Changes $before $after)
    })
} catch {
    Write-Result ([ordered]@{ ok = $false; error = 'script-error'; message = $_.Exception.Message })
}
