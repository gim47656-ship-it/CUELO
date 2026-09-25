# Approved --version identities. Older entries stay for rollback and for other PCs
# whose pin was written earlier; the current Known-Good is appended, never swapped in.
# omp/18.3.0 "omp-windows-x64.exe" (release v18.3.0) SHA-256
# 9be13f13e3c11dcba25dfccfad0f8c508f66fd8bc2f95a0f06f2964be8d8f527, matching the
# published SHA256SUMS.txt (checked 2026-09-25); prior identities stay valid.
# omp/18.2.11 "omp-windows-x64.exe" (release v18.2.11) SHA-256
# d4a946359d97b943e0dd09b1ed204fc4dda4228178928e8237402e2c47f0eb69, matching the
# GitHub release asset digest and published SHA256SUMS.txt; prior identities stay valid.
# omp/18.2.10 "omp-windows-x64.exe" (release v18.2.10) SHA-256
# cd4f82063d7f44c96bf8c2cbea53b8dcd9eeb9d5643b6d47dd469049c5db8f2d, matching the
# GitHub release asset digest and published SHA256SUMS.txt; prior identities stay valid.
# omp/18.2.9 "omp-windows-x64.exe" (release v18.2.9) SHA-256
# 145b74ec45a167682ec4749155c528607ef449880c07976ed9f6c50461912d43, matching the
# GitHub release asset digest and published SHA256SUMS.txt; prior identities stay valid.
# omp/18.2.8 "omp-windows-x64.exe" (release v18.2.8) SHA-256
# b95431cb63b073c36c3664f6d9e2611de8d28d6e6e21ede657c8f83f0e7034b3, matching the
# GitHub release asset digest and published SHA256SUMS.txt; prior identities stay valid.
# omp/18.2.7 "omp-windows-x64.exe" (release v18.2.7) SHA-256
# 8901de39644c31f8ae3ef5a6d192be2a2c4fd808e8f0119b3e4445a2cc5c946c, matching the
# GitHub release asset digest and published SHA256SUMS.txt; prior identities stay valid.
# omp/18.2.6 "omp-windows-x64.exe" (release v18.2.6) SHA-256
# 1fbff31df4bba1ec8a48d74b392e4b4c8c12de0a7f53cf62c6e5436fdfebda28, matching both the
# GitHub release asset digest and the published SHA256SUMS.txt (previous Known-Good
# omp/18.2.1 "omp-windows-x64.exe" (release v18.2.1) SHA-256
# fee52652c7b0b90eb7716b3c6da50ab4d90442505eef1c5349c9428e8d966679, itself matching both
# sources, and before that omp/18.2.0 =
# 128df4420e9778a9a0712e7969919b782ab47aed04d000efe28ac4cb3e04b071). This file
# only approves the identity; the absolute path and SHA-256 pin live in ~/.omp/omp1-command.json
# and are written by setup.ps1 -RefreshOmp1Pin after it verifies the executable.
$script:AllowedOmp1VersionOutputs = @('omp/18.1.17', 'omp/18.1.18', 'omp/18.1.21', 'omp/18.1.22', 'omp/18.2.0', 'omp/18.2.1', 'omp/18.2.6', 'omp/18.2.7', 'omp/18.2.8', 'omp/18.2.9', 'omp/18.2.10', 'omp/18.2.11', 'omp/18.3.0')

function Get-Omp1CommandPinPath {
    if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        throw 'USERPROFILE is not set; the OMP1 executable pin cannot be located.'
    }
    return (Join-Path (Join-Path $env:USERPROFILE '.omp') 'omp1-command.json')
}

function Get-Omp1CommandSha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '')
        } finally {
            $sha.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

function Assert-Omp1CommandIdentity([string]$Path) {
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $Path
    $startInfo.Arguments = '--version'
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) {
            throw "OMP1 executable identity check could not start: $Path"
        }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(10000)) {
            try { $process.Kill() } catch {}
            throw "OMP1 executable identity check timed out: $Path"
        }
        $process.WaitForExit()
        $outputTasks = [Threading.Tasks.Task[]]@($stdoutTask, $stderrTask)
        if (-not [Threading.Tasks.Task]::WaitAll($outputTasks, 5000)) {
            throw "OMP1 executable identity check output stalled: $Path"
        }
        $stdout = ([string]$stdoutTask.Result).Trim()
        $stderr = ([string]$stderrTask.Result).Trim()
        if ($process.ExitCode -ne 0 -or -not [string]::IsNullOrWhiteSpace($stderr)) {
            throw "OMP1 executable identity check failed: $Path"
        }
        if ($script:AllowedOmp1VersionOutputs -cnotcontains $stdout) {
            throw "Executable is not an approved OMP1 version: '$stdout'"
        }
    } finally {
        $process.Dispose()
    }
}


function Get-ValidatedOmp1CommandPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$ExpectedSha256
    )
    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw 'OMP1 executable path is empty.'
    }
    if (-not [IO.Path]::IsPathRooted($Path)) {
        throw "OMP1 executable path is not absolute: $Path"
    }

    try {
        $absolutePath = [IO.Path]::GetFullPath($Path)
    } catch {
        throw "OMP1 executable path is invalid: $Path"
    }
    if (-not (Test-Path -LiteralPath $absolutePath -PathType Leaf)) {
        throw "OMP1 executable was not found: $absolutePath"
    }
    if ([IO.Path]::GetExtension($absolutePath) -ine '.exe') {
        throw "OMP1 command is not an executable (.exe): $absolutePath"
    }

    $actualSha256 = Get-Omp1CommandSha256 $absolutePath
    if ($PSBoundParameters.ContainsKey('ExpectedSha256')) {
        if ($ExpectedSha256 -notmatch '^[A-Fa-f0-9]{64}$') {
            throw 'OMP1 executable pin contains an invalid SHA-256 value.'
        }
        if ($actualSha256 -ine $ExpectedSha256) {
            throw "OMP1 executable pin SHA-256 mismatch: $absolutePath"
        }
    }
    Assert-Omp1CommandIdentity $absolutePath


    return [pscustomobject]@{
        Path = $absolutePath
        Sha256 = $actualSha256
    }
}

function Assert-Omp1CommandPinDocument($Pin, [string]$PinPath) {
    if ($null -eq $Pin -or $Pin -isnot [pscustomobject]) {
        throw "OMP1 executable pin must be a JSON object: $PinPath"
    }
    $expectedProperties = @('schemaVersion', 'path', 'sha256')
    $propertyNames = @($Pin.PSObject.Properties.Name)
    if ($propertyNames.Count -ne $expectedProperties.Count) {
        throw "OMP1 executable pin must contain exactly schemaVersion, path, and sha256: $PinPath"
    }
    foreach ($propertyName in $expectedProperties) {
        if ($propertyNames -cnotcontains $propertyName) {
            throw "OMP1 executable pin has an invalid property set: $PinPath"
        }
    }
    # ConvertFrom-Json yields Int32 on Windows PowerShell 5.1 and Int64 on PowerShell 7, so accept
    # both integer types. Strings and non-integers are still rejected, and the verdict is shell-independent.
    if (($Pin.schemaVersion -isnot [int] -and $Pin.schemaVersion -isnot [long]) -or [int64]$Pin.schemaVersion -ne 1) {
        throw "OMP1 executable pin has an unsupported schemaVersion: $PinPath"
    }
    if (
        $Pin.path -isnot [string] -or
        $Pin.sha256 -isnot [string] -or
        $Pin.sha256 -notmatch '^[A-Fa-f0-9]{64}$'
    ) {
        throw "OMP1 executable pin path must be a string and sha256 must be 64 hexadecimal characters: $PinPath"
    }
}

function Read-Omp1CommandPin([string]$PinPath) {
    if (-not (Test-Path -LiteralPath $PinPath -PathType Leaf)) { return $null }

    try {
        $pin = Get-Content -LiteralPath $PinPath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    } catch {
        throw "OMP1 executable pin is not valid JSON: $PinPath"
    }
    Assert-Omp1CommandPinDocument $pin $PinPath

    try {
        return Get-ValidatedOmp1CommandPath ([string]$pin.path) ([string]$pin.sha256)
    } catch {
        throw "Invalid OMP1 executable pin at ${PinPath}: $($_.Exception.Message)"
    }
}

function Write-Omp1CommandPin([string]$PinPath, [string]$Path, [string]$Sha256) {
    $parent = Split-Path -Parent $PinPath
    New-Item -ItemType Directory -Path $parent -Force | Out-Null

    $document = [ordered]@{
        schemaVersion = 1
        path = $Path
        sha256 = $Sha256.ToUpperInvariant()
    }
    $json = ($document | ConvertTo-Json) + [Environment]::NewLine

    if (Test-Path -LiteralPath $PinPath -PathType Leaf) {
        try {
            $current = Get-Content -LiteralPath $PinPath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
            Assert-Omp1CommandPinDocument $current $PinPath
            if ([string]$current.path -eq $Path -and [string]$current.sha256 -ieq $Sha256) { return }
        } catch {}
    }

    $temporaryPath = Join-Path $parent ('.omp1-command.' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($temporaryPath, $json, [Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $PinPath -PathType Leaf) {
            [IO.File]::Replace($temporaryPath, $PinPath, [NullString]::Value)
        } else {
            Move-Item -LiteralPath $temporaryPath -Destination $PinPath
        }
    } finally {
        if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
    }
}

function Resolve-Omp1Command {
    [CmdletBinding()]
    param(
        [switch]$Initialize,
        [switch]$Refresh
    )

    if ($Refresh -and -not $Initialize) {
        throw 'Refreshing the OMP1 executable pin is only allowed during explicit initialization.'
    }

    $pinPath = Get-Omp1CommandPinPath
    $pinExists = Test-Path -LiteralPath $pinPath -PathType Leaf
    $validPin = $null
    if ($pinExists) {
        try {
            $validPin = Read-Omp1CommandPin $pinPath
        } catch {
            if (-not $Refresh) {
                throw "$($_.Exception.Message) Re-run setup.ps1 with -RefreshOmp1Pin only after verifying the OMP1 binary."
            }
        }
    }

    if (
        $validPin -and $Initialize -and -not $Refresh -and
        -not [string]::IsNullOrWhiteSpace($env:OMP1_EXE)
    ) {
        try {
            $environmentCandidate = Get-ValidatedOmp1CommandPath $env:OMP1_EXE
        } catch {
            throw "OMP1_EXE is invalid: $($_.Exception.Message)"
        }
        if (
            $environmentCandidate.Path -ine $validPin.Path -or
            $environmentCandidate.Sha256 -ine $validPin.Sha256
        ) {
            throw 'OMP1_EXE differs from the existing valid pin. Re-run setup.ps1 with -RefreshOmp1Pin only after verifying the OMP1 binary.'
        }
    }

    if ($validPin -and -not ($Initialize -and $Refresh)) {
        return $validPin.Path
    }
    if (-not $Initialize) {
        throw "OMP1 executable pin was not found: $pinPath Run setup.ps1 to initialize it."
    }

    $candidatePath = $null
    if (-not [string]::IsNullOrWhiteSpace($env:OMP1_EXE)) {
        try {
            $candidatePath = (Get-ValidatedOmp1CommandPath $env:OMP1_EXE).Path
        } catch {
            throw "OMP1_EXE is invalid: $($_.Exception.Message)"
        }
    } elseif ($validPin) {
        $candidatePath = $validPin.Path
    } else {
        $knownPath = if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
            $null
        } else {
            Join-Path $env:LOCALAPPDATA 'omp/omp.exe'
        }
        if ($knownPath -and (Test-Path -LiteralPath $knownPath -PathType Leaf)) {
            $candidatePath = (Get-ValidatedOmp1CommandPath $knownPath).Path
        } else {
            $pathCommand = Get-Command omp -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($pathCommand) {
                $candidatePath = (Get-ValidatedOmp1CommandPath $pathCommand.Source).Path
            }
        }
    }

    if (-not $candidatePath) {
        throw 'OMP1 executable could not be initialized. Set OMP1_EXE to its absolute path or install it at %LOCALAPPDATA%\omp\omp.exe.'
    }

    $candidate = Get-ValidatedOmp1CommandPath $candidatePath
    Write-Omp1CommandPin $pinPath $candidate.Path $candidate.Sha256
    return $candidate.Path
}
