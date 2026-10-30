[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Repository,
    [Parameter(Mandatory = $true)]
    [string]$Remote,
    [Parameter(Mandatory = $true)]
    [string]$UpstreamRef,
    [int]$WaitSeconds = 300,
    [int]$MaxHoldSeconds = 100
)

# git_integrate의 잠금 보유자. finalizer.ps1과 같은 이름의 named mutex(git common-dir + remote + upstream ref)를 잡아
# 두 도구가 같은 대상 ref로 보내는 작업을 한 줄로 세운다. .NET named mutex는 PowerShell 프로세스만 잡을 수 있으므로
# git 작업은 부모(integrate.ts)가 하고 이 스크립트는 잠금만 쥔다.
# 프로토콜: 잡으면 {"locked":true,...} 한 줄을 쓰고 표준 입력을 기다린다. 한 줄이 오거나 입력이 닫히면(부모가 죽은 경우 포함)
# 놓고 끝낸다. 부모가 멈춰 입력을 닫지 못해도 MaxHoldSeconds가 지나면 놓는다. finalizer.ps1은 120초만 기다리므로
# 멈춘 도구 호출이 git_finalize를 그보다 오래 붙잡지 않게 하려는 상한이다.
$ErrorActionPreference = 'Stop'
try {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
} catch {}
$env:GIT_TERMINAL_PROMPT = '0'
$isWindowsPlatform = [IO.Path]::DirectorySeparatorChar -eq '\'

function Write-Line($Value) {
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
}

# finalizer.ps1의 Normalize-FullPath와 같은 규칙이어야 같은 잠금 이름이 나온다.
function Normalize-FullPath([string]$Path) {
    $comparison = if ($isWindowsPlatform) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    $fullPath = [IO.Path]::GetFullPath($Path)
    $pathRoot = [IO.Path]::GetPathRoot($fullPath)
    if ($fullPath.Equals($pathRoot, $comparison)) { return $pathRoot }
    return $fullPath.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Get-Sha256Hex([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

$mutex = $null
$owns = $false
$exitCode = 0
try {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $commonOutput = @(& git -C $Repository rev-parse --path-format=absolute --git-common-dir 2>&1)
        $gitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($gitCode -ne 0) { throw "git rev-parse --git-common-dir failed: $(($commonOutput | Out-String).Trim())" }
    $commonDir = Normalize-FullPath (($commonOutput | Out-String).Trim())
    $lockDirectory = if ($isWindowsPlatform) { $commonDir.ToLowerInvariant() } else { $commonDir }
    $lockKey = Get-Sha256Hex ($lockDirectory + [char]0 + $Remote + [char]0 + $UpstreamRef)
    $mutexName = if ($isWindowsPlatform) { "Global\OMP-GitFinalize-$lockKey" } else { "OMP-GitFinalize-$lockKey" }
    $mutex = [Threading.Mutex]::new($false, $mutexName)
    try {
        $owns = $mutex.WaitOne([TimeSpan]::FromSeconds($WaitSeconds))
    } catch [Threading.AbandonedMutexException] {
        $owns = $true
    }
    if (-not $owns) {
        Write-Line ([ordered]@{ locked = $false; name = $mutexName; error = "Timed out after $WaitSeconds s waiting for the repository finalizer lock: $mutexName" })
        $exitCode = 2
    } else {
        Write-Line ([ordered]@{ locked = $true; name = $mutexName; commonDir = $commonDir; maxHoldSeconds = $MaxHoldSeconds })
        # Console.In.ReadLineAsync는 동기로 막혀 상한 타이머가 돌지 않는다(2026-10-31 실측). 표준 입력 스트림의 ReadAsync는
        # 스레드 풀에서 읽으므로 Wait에 시간 상한을 걸 수 있다. 한 바이트가 오거나 입력이 닫히면(0바이트) 끝난다.
        # mutex는 잡은 이 스레드가 놓는다(.NET mutex는 잡은 스레드만 놓을 수 있다).
        $stdin = [Console]::OpenStandardInput()
        $read = $stdin.ReadAsync([byte[]]::new(1), 0, 1)
        $expired = -not $read.Wait([TimeSpan]::FromSeconds($MaxHoldSeconds))
        $mutex.ReleaseMutex()
        $owns = $false
        Write-Line ([ordered]@{ released = $true; expired = $expired })
        if ($expired) { $exitCode = 3 }
    }
} catch {
    Write-Line ([ordered]@{ locked = $false; error = $_.Exception.Message })
    $exitCode = 1
} finally {
    if ($owns -and $mutex) {
        try { $mutex.ReleaseMutex() } catch {}
    }
    if ($mutex) { $mutex.Dispose() }
}
exit $exitCode
