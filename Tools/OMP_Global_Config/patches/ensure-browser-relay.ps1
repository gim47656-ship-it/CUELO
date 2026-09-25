<#
`omp browser-relay serve`를 127.0.0.1의 지정 포트에서 항상 살려 둔다.

모드
  -Register  작업 스케줄러 작업을 등록하고 즉시 시작한 뒤 포트를 확인한다.
  -Serve     작업 스케줄러가 쓰는 감시 모드다.
  (기본)     포트를 확인하고, 죽어 있으면 등록된 감시 작업 또는 relay를 시작한다.

기록은 `~/.omp/browser-relay.log`에만 남긴다.
#>
[CmdletBinding()]
param(
    [switch]$Register,
    [switch]$Serve,
    [ValidateRange(1, 65535)]
    [int]$Port = 9224,
    [ValidateRange(1, 3600)]
    [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Continue'
try {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
} catch { }

$TaskName = 'OMP-BrowserRelay'
$OmpHome = Join-Path $env:USERPROFILE '.omp'
$LogPath = Join-Path $OmpHome 'browser-relay.log'

function Log([string]$Message) {
    $line = '{0} {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Message
    try { Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8 } catch { }
    Write-Host $line
}

function Resolve-Omp {
    if ($env:OMP_EXE -and (Test-Path -LiteralPath $env:OMP_EXE -PathType Leaf)) { return $env:OMP_EXE }
    $local = Join-Path $env:LOCALAPPDATA 'omp\omp.exe'
    if (Test-Path -LiteralPath $local -PathType Leaf) { return $local }
    $command = Get-Command omp.exe -ErrorAction SilentlyContinue
    if ($command -and $command.Source) { return $command.Source }
    return $null
}

function Test-Relay([int]$RelayPort) {
    $client = New-Object Net.Sockets.TcpClient
    try {
        if ($client.ConnectAsync('127.0.0.1', $RelayPort).Wait(500)) { return $client.Connected }
        return $false
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Wait-Relay([int]$RelayPort, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while (-not (Test-Relay $RelayPort)) {
        if ((Get-Date) -ge $deadline) { return $false }
        Start-Sleep -Milliseconds 400
    }
    return $true
}

function Start-Relay([string]$OmpPath, [int]$RelayPort) {
    return Start-Process -FilePath $OmpPath `
        -ArgumentList @('browser-relay', 'serve', "--port=$RelayPort") `
        -WindowStyle Hidden -PassThru
}

if ($Register) {
    $selfPath = [Security.SecurityElement]::Escape($PSCommandPath)
    $account = '{0}\{1}' -f $env:USERDOMAIN, $env:USERNAME
    $xmlAccount = [Security.SecurityElement]::Escape($account)
    $startBoundary = (Get-Date).AddMinutes(-1).ToString('yyyy-MM-ddTHH:mm:ss')
    $xml = @"
<?xml version="1.0"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>omp browser relay를 살려 둔다. 원본: OMP_Global_Config/patches/ensure-browser-relay.ps1</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$xmlAccount</UserId>
      <Delay>PT15S</Delay>
    </LogonTrigger>
    <TimeTrigger>
      <StartBoundary>$startBoundary</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>PT5M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$xmlAccount</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File &quot;$selfPath&quot; -Serve -Port $Port</Arguments>
    </Exec>
  </Actions>
</Task>
"@
    if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {
        Log '감시 작업을 등록할 수 없다 (ScheduledTasks 모듈 없음)'
        exit 1
    }
    try {
        Register-ScheduledTask -TaskName $TaskName -Xml $xml -Force | Out-Null
        Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    } catch {
        Log "감시 작업 등록 또는 시작 실패: $($_.Exception.Message)"
        exit 1
    }
    Log "감시 작업 등록 및 시작: $TaskName (127.0.0.1:$Port)"
    if (Wait-Relay $Port $TimeoutSeconds) {
        Log "browser relay 정상 (127.0.0.1:$Port)"
        exit 0
    }
    Log "browser relay를 $TimeoutSeconds초 안에 띄우지 못했다 (127.0.0.1:$Port)"
    exit 1
}

if ($Serve) {
    Log "감시 시작 pid=$PID port=$Port"
    $fastFailures = 0
    while ($true) {
        if (Test-Relay $Port) {
            $fastFailures = 0
            Start-Sleep -Seconds 15
            continue
        }

        $omp = Resolve-Omp
        if (-not $omp) {
            Log 'omp.exe를 찾지 못해 감시를 계속할 수 없다'
            exit 1
        }
        $startedAt = Get-Date
        $process = Start-Relay $omp $Port
        if (-not $process) {
            Log 'browser relay 시작 실패'
            exit 1
        }
        Log "browser relay 시작 pid=$($process.Id) port=$Port"
        $process.WaitForExit()
        $lifetime = ((Get-Date) - $startedAt).TotalSeconds
        Log ('browser relay 종료 pid={0} exit={1} 수명={2:N0}초' -f $process.Id, $process.ExitCode, $lifetime)
        if ($lifetime -lt 5) {
            $fastFailures++
            if ($fastFailures -ge 5) {
                Log 'browser relay가 계속 즉시 종료된다. 감시를 멈춘다(5분 뒤 스케줄러가 다시 시도).'
                exit 1
            }
            Start-Sleep -Seconds 3
        } else {
            $fastFailures = 0
        }
    }
}

if (Test-Relay $Port) {
    Write-Host "browser relay 정상 (127.0.0.1:$Port)"
    exit 0
}

& schtasks.exe /query /tn $TaskName *> $null
if ($LASTEXITCODE -eq 0) {
    & schtasks.exe /run /tn $TaskName *> $null
    if ($LASTEXITCODE -ne 0) {
        Log "감시 작업 시작 요청이 exit $LASTEXITCODE를 반환했다. 이미 실행 중일 수 있으므로 포트 대기를 계속한다"
    } else {
        Log "감시 작업 시작 요청: $TaskName"
    }
} else {
    $omp = Resolve-Omp
    if (-not $omp) {
        Log 'omp.exe를 찾지 못했다'
        exit 1
    }
    $process = Start-Relay $omp $Port
    if (-not $process) {
        Log 'browser relay 시작 실패'
        exit 1
    }
    Log "직접 시작 pid=$($process.Id) port=$Port"
}

if (Wait-Relay $Port $TimeoutSeconds) {
    Log "browser relay 정상 (127.0.0.1:$Port)"
    exit 0
}
Log "browser relay를 $TimeoutSeconds초 안에 띄우지 못했다 (127.0.0.1:$Port). ~/.omp/browser-relay.log를 확인한다"
exit 1
