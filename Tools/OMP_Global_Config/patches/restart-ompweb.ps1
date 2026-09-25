# omp-web 서버를 껐다 켠다.
#
# 반드시 omp-web 트리 밖에서 실행한다. 프로세스 계보가 이렇게 물려 있어서,
# omp-web 안의 터미널에서 돌리면 자기 자신이 kill 대상에 포함된다.
#
#   cmd.exe (omp-web.cmd)
#    └─ node.exe (omp-web.js)
#        └─ bun.exe (next 서버, :30141)  <- 세션이 여기서 돈다
#
# 실행 방법은 두 가지다.
#   1) Win+R  ->  %USERPROFILE%\.omp\restart-ompweb.cmd
#   2) schtasks /run /tn OMPWEB-Restart   (작업 스케줄러가 띄우므로 계보가 분리된다)
#
# -InitiatorSessionId <id>: READY 뒤 그 세션에 재개 메시지를 prompt로 넣는다(업그레이드 배포의 자동 재개와 같은 목적).
# 스케줄 작업으로 넘길 때는 인자가 사라지므로 id를 resume 파일로 넘긴다.
param([string]$InitiatorSessionId)

$ErrorActionPreference = 'Continue'
$resumeFile = Join-Path $env:USERPROFILE '.omp\restart-ompweb.resume.json'
if ($InitiatorSessionId) {
	if ($InitiatorSessionId -notmatch '^[0-9a-fA-F-]{36}$') { Write-Error "-InitiatorSessionId 형식 오류: $InitiatorSessionId"; exit 2 }
	@{ sessionId = $InitiatorSessionId.ToLowerInvariant(); atUtc = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $resumeFile -Encoding UTF8
}
$port = 30141
$log = Join-Path $env:USERPROFILE '.omp\restart-ompweb.log'

function Log($m) {
	$line = "$((Get-Date).ToString('HH:mm:ss')) $m"
	$line | Tee-Object -FilePath $log -Append
}

"===== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') restart =====" | Out-File -FilePath $log -Append -Encoding utf8

function Test-Port($p) {
	$c = New-Object Net.Sockets.TcpClient
	try {
		if (-not $c.ConnectAsync('127.0.0.1', $p).Wait(500)) { return $false }
		return $c.Connected
	} catch { return $false } finally { $c.Dispose() }
}

function Test-PortBindable($p) {
	$listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $p)
	try {
		$listener.Start()
		$listener.Stop()
		return $true
	} catch { return $false }
}

function Test-PortFree($p) {
	return (Test-PortBindable $p) -and -not (Test-Port $p)
}

function Test-WebAlive($p) {
	$response = $null
	try {
		$request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$p/")
		$request.Method = 'HEAD'
		$request.Timeout = 4000
		$request.ReadWriteTimeout = 4000
		$response = $request.GetResponse()
		return $response.StatusCode -eq [Net.HttpStatusCode]::OK
	} catch [Net.WebException] {
		$response = $_.Exception.Response
		return $false
	} catch { return $false } finally {
		if ($response) { $response.Close() }
	}
}

# 포트 소유자에서 위로 걸어올라가 omp-web 계보의 최상위를 찾는다.
# 최상위 cmd 부터 트리째 끝내야 node 가 next 서버를 되살리지 않는다.
$roots = @()
foreach ($conn in @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
	$cur = Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)" -ErrorAction SilentlyContinue
	if (-not $cur) { continue }
	Log "포트 $port 소유: pid=$($cur.ProcessId) $($cur.Name)"
	while ($cur.ParentProcessId) {
		$parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($cur.ParentProcessId)" -ErrorAction SilentlyContinue
		if (-not $parent) { break }
		if ($parent.CommandLine -notmatch 'omp-web') { break }
		$cur = $parent
	}
	$roots += $cur.ProcessId
}

# 이 스크립트가 종료 대상 트리 안에서 돌면 taskkill이 자기 자신까지 끝내 재기동이 끊긴다.
# 그 경우 계보가 분리된 스케줄 작업에 넘기고 빠진다.
if ($roots) {
	$cur = Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction SilentlyContinue
	while ($cur) {
		if ($roots -contains $cur.ProcessId) {
			Log "현재 프로세스가 omp-web 트리(pid=$($cur.ProcessId)) 안에 있다. OMPWEB-Restart 작업으로 넘긴다."
			schtasks /run /tn OMPWEB-Restart 2>&1 | Out-Null
			if ($LASTEXITCODE -ne 0) { Log "FAILED: OMPWEB-Restart 실행 실패(exit $LASTEXITCODE). omp-web 밖에서 restart-ompweb.cmd를 실행한다."; exit 1 }
			exit 0
		}
		if (-not $cur.ParentProcessId) { break }
		$cur = Get-CimInstance Win32_Process -Filter "ProcessId=$($cur.ParentProcessId)" -ErrorAction SilentlyContinue
	}
}

if (-not $roots) {
	Log "실행 중인 omp-web 없음. 그대로 띄운다."
} else {
	# 턴이 도는 세션을 서버가 목록에 적고 abort하게 한다(omp-web lib/update-interrupt.ts). 새 서버가 그 세션을 재개한다.
	# 이 스크립트를 부른 세션은 턴을 끝낸 뒤라 목록에 없고, 아래 resume 파일로 따로 깨운다.
	$interruptDir = Join-Path $env:USERPROFILE '.omp\external-update\interrupts'
	$interruptId = 'restart-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmssfff')
	$exclude = @()
	if (Test-Path -LiteralPath $resumeFile) { try { $exclude = @((Get-Content -LiteralPath $resumeFile -Raw -Encoding UTF8 | ConvertFrom-Json).sessionId) } catch {} }
	New-Item -ItemType Directory -Path $interruptDir -Force | Out-Null
	@{ schemaVersion = 1; id = $interruptId; reason = 'restart'; excludeSessionIds = $exclude; atUtc = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $interruptDir 'request.json') -Encoding UTF8
	$ackPath = Join-Path $interruptDir "$interruptId.ack.json"
	$ackDeadline = (Get-Date).AddSeconds(15)
	while (-not (Test-Path -LiteralPath $ackPath) -and (Get-Date) -lt $ackDeadline) { Start-Sleep -Milliseconds 300 }
	if (Test-Path -LiteralPath $ackPath) { Log "세션 중단 ack: $((Get-Content -LiteralPath $ackPath -Raw).Trim() -replace '\s+', ' ')" } else { Log "세션 중단 ack 없음(15s). 그대로 종료한다." }
	foreach ($pid_ in ($roots | Select-Object -Unique)) {
		Log "트리 종료: pid=$pid_"
		taskkill /PID $pid_ /T /F 2>&1 | Out-Null
	}
}

$deadline = (Get-Date).AddSeconds(30)
while ((-not (Test-PortFree $port)) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 400 }
if (-not (Test-PortFree $port)) {
	Log "FAILED: 30초 안에 $port 포트를 새 서버가 bind할 수 있는 상태로 회수하지 못했다. 재기동을 중단한다. 로그($log), 현재 포트 소유 프로세스와 브라우저의 대기 연결을 확인한다."
	exit 1
}
Log "포트 해제 확인."

# OMPWEB 재기동과 무관하게 browser relay도 먼저 살아 있어야 브라우저 연결이 즉시 복구된다.
$ensureBrowserRelay = Join-Path $env:USERPROFILE '.omp\ensure-browser-relay.ps1'
if (Test-Path -LiteralPath $ensureBrowserRelay) {
	foreach ($line in @(& $ensureBrowserRelay 6>&1)) { Log "browser relay: $line" }
}

Log "런처 실행."
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $env:USERPROFILE '.omp\ompweb-launcher\launch.ps1')
if ($LASTEXITCODE -ne 0) {
	Log "FAILED: 런처가 exit $LASTEXITCODE 로 종료됐다."
	exit 1
}

$deadline = (Get-Date).AddSeconds(90)
while ((-not (Test-WebAlive $port)) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }
if (Test-WebAlive $port) {
	Log "READY http://127.0.0.1:$port"
	if (Test-Path -LiteralPath $resumeFile) {
		try {
			$r = Get-Content -LiteralPath $resumeFile -Raw -Encoding UTF8 | ConvertFrom-Json
			Remove-Item -LiteralPath $resumeFile -Force
			$msg = "[자동 재개] OMPWEB 재시작이 끝났다(READY). 재시작 직전 작업을 이어서 진행한다."
			# 세션이 이미 턴을 돌고 있으면 streamingBehavior 없는 prompt는 AgentBusyError로 거절된다. followUp으로 큐잉한다.
			$body = @{ type = 'prompt'; message = $msg; streamingBehavior = 'followUp'; internalPrompt = $true } | ConvertTo-Json -Compress
			$resp = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "http://127.0.0.1:$port/api/agent/$($r.sessionId)" `
				-ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 60
			Log "RESUME_SENT session=$($r.sessionId) status=$($resp.StatusCode)"
		} catch { Log "RESUME_FAILED: $($_.Exception.Message)" }
	}
	exit 0
}
Log "FAILED: 90초 안에 OMP WEB HTTP 200 응답을 받지 못했다."
exit 1
