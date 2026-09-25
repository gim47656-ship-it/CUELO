[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Request
)

$ErrorActionPreference = 'Stop'
try {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
} catch {}
$env:GIT_TERMINAL_PROMPT = '0'

$stage = 'request'
$createdCommit = $null
$repoRoot = $null
$repoPaths = @()
$stagedByFinalizer = $false
$mutex = $null
$ownsMutex = $false
$messageFile = $null
$result = $null
$exitCode = 0

function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string[]]$GitArgs,
        [int[]]$AllowedExitCodes = @(0)
    )

    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = @(& git -c credential.interactive=false -C $WorkingDirectory @GitArgs 2>&1)
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    $text = ($output | Out-String).Trim()
    if ($AllowedExitCodes -notcontains $code) {
        if (-not $text) { $text = "git exited with code $code" }
        throw $text
    }
    return [pscustomobject]@{ Code = $code; Output = $text }
}

function Get-Sha256Hex([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Normalize-FullPath([string]$Path) {
    $fullPath = [IO.Path]::GetFullPath($Path)
    $pathRoot = [IO.Path]::GetPathRoot($fullPath)
    if ($fullPath.Equals($pathRoot, [StringComparison]::OrdinalIgnoreCase)) { return $pathRoot }
    return $fullPath.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Test-PathWithin([string]$Path, [string]$Root) {
    if ($Path.Equals($Root, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    $prefix = $Root
    if (
        -not $prefix.EndsWith([IO.Path]::DirectorySeparatorChar) -and
        -not $prefix.EndsWith([IO.Path]::AltDirectorySeparatorChar)
    ) {
        $prefix += [IO.Path]::DirectorySeparatorChar
    }
    return $Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Get-NearestExistingDirectory([string]$Path) {
    $candidate = [IO.Path]::GetDirectoryName($Path)
    while ($candidate -and -not (Test-Path -LiteralPath $candidate -PathType Container)) {
        $candidate = [IO.Path]::GetDirectoryName($candidate)
    }
    if (-not $candidate) { throw "No existing parent directory found for file path: $Path" }
    return Normalize-FullPath $candidate
}

function Get-RepositoryRootInPathNamespace([string]$WorkingDirectory) {
    [void](Invoke-Git -WorkingDirectory $WorkingDirectory -GitArgs @('rev-parse', '--show-toplevel'))
    $prefix = (Invoke-Git -WorkingDirectory $WorkingDirectory -GitArgs @('rev-parse', '--show-prefix')).Output.Trim('/')
    $root = Normalize-FullPath $WorkingDirectory
    if ($prefix) {
        foreach ($segment in ($prefix -split '/' | Where-Object { $_ })) {
            $root = [IO.Path]::GetDirectoryName($root)
            if (-not $root) { throw "Could not reconstruct repository root from prefix: $prefix" }
        }
    }
    return Normalize-FullPath $root
}

function Convert-ToRepoPath([string]$FullPath, [string]$Root) {
    if ($FullPath.Equals($Root, [StringComparison]::OrdinalIgnoreCase)) { return '' }
    return $FullPath.Substring($Root.Length).TrimStart('\', '/').Replace('\', '/')
}

function Get-GitPaths([string]$WorkingDirectory, [string[]]$GitArgs) {
    $response = Invoke-Git -WorkingDirectory $WorkingDirectory -GitArgs $GitArgs
    if (-not $response.Output) { return @() }
    return @($response.Output -split "`r?`n" | ForEach-Object { $_.Trim().Replace('\', '/') } | Where-Object { $_ })
}

function Assert-ExactPathSet([string[]]$Actual, [string[]]$Expected, [string]$Label) {
    $actualSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $expectedSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($path in $Actual) { [void]$actualSet.Add($path) }
    foreach ($path in $Expected) { [void]$expectedSet.Add($path) }
    if (-not $actualSet.SetEquals($expectedSet)) {
        throw "$Label mismatch. expected=[$($Expected -join ', ')] actual=[$($Actual -join ', ')]"
    }
}

try {
    if (-not (Test-Path -LiteralPath $Request -PathType Leaf)) { throw "Request file not found: $Request" }
    $payload = Get-Content -LiteralPath $Request -Raw -Encoding UTF8 | ConvertFrom-Json
    $cwd = Normalize-FullPath ([string]$payload.cwd)
    $message = ([string]$payload.message).Trim()
    $inputFiles = @($payload.files | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
    if (-not (Test-Path -LiteralPath $cwd -PathType Container)) { throw "Session cwd does not exist: $cwd" }
    if (-not $message) { throw 'Commit message is empty.' }
    if ($inputFiles.Count -eq 0) { throw 'At least one exact file path is required.' }

    $stage = 'repository'
    $resolvedFiles = @()
    $seenFullPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($inputFile in $inputFiles) {
        if ($inputFile.IndexOfAny(@([char]0, [char]10, [char]13)) -ge 0) { throw 'File paths cannot contain NUL or newlines.' }
        if ([IO.Path]::IsPathRooted($inputFile)) { throw "Absolute file path is not allowed: $inputFile" }
        $fullPath = Normalize-FullPath (Join-Path $cwd $inputFile)
        if (Test-Path -LiteralPath $fullPath -PathType Container) { throw "Directories are not allowed; list exact files: $inputFile" }
        if (-not $seenFullPaths.Add($fullPath)) { throw "Duplicate file path: $inputFile" }
        $resolvedFiles += [pscustomobject]@{ Input = $inputFile; FullPath = $fullPath }
    }

    $cwdRepoRoot = $null
    $cwdCommonDir = $null
    try {
        $cwdRepoRoot = Get-RepositoryRootInPathNamespace $cwd
        $cwdCommonDir = Normalize-FullPath (Invoke-Git -WorkingDirectory $cwdRepoRoot -GitArgs @('rev-parse', '--path-format=absolute', '--git-common-dir')).Output
    } catch {
        $cwdRepoRoot = $null
        $cwdCommonDir = $null
    }

    $selectedRepoRoot = $null
    $selectedCommonDir = $null
    foreach ($file in $resolvedFiles) {

        $probeDirectory = Get-NearestExistingDirectory $file.FullPath
        $targetRepoRoot = Get-RepositoryRootInPathNamespace $probeDirectory
        $targetCommonDir = Normalize-FullPath (Invoke-Git -WorkingDirectory $targetRepoRoot -GitArgs @('rev-parse', '--path-format=absolute', '--git-common-dir')).Output
        if (-not (Test-PathWithin -Path $file.FullPath -Root $targetRepoRoot)) {
            throw "File path escapes the repository: $($file.Input)"
        }

        if (-not $selectedRepoRoot) {
            $selectedRepoRoot = $targetRepoRoot
            $selectedCommonDir = $targetCommonDir
        } elseif (
            -not $selectedRepoRoot.Equals($targetRepoRoot, [StringComparison]::OrdinalIgnoreCase) -or
            -not $selectedCommonDir.Equals($targetCommonDir, [StringComparison]::OrdinalIgnoreCase)
        ) {
            throw "Files belong to different repositories: $($file.Input)"
        }
    }

    $repoRoot = $selectedRepoRoot
    $commonDir = $selectedCommonDir
    if ($cwdRepoRoot) {
        $targetsBelongToCwdRepository = $commonDir.Equals($cwdCommonDir, [StringComparison]::OrdinalIgnoreCase)
        if ($targetsBelongToCwdRepository) {
            foreach ($file in $resolvedFiles) {
                $parentPath = [IO.Path]::GetDirectoryName($file.FullPath)
                $isDirectRepoRootChild = $parentPath -and $parentPath.Equals($cwdRepoRoot, [StringComparison]::OrdinalIgnoreCase)
                if (-not (Test-PathWithin -Path $file.FullPath -Root $cwd) -and -not $isDirectRepoRootChild) {
                    throw "File path escapes the session cwd: $($file.Input)"
                }
            }
        }
    } else {
        foreach ($file in $resolvedFiles) {
            if (-not (Test-PathWithin -Path $file.FullPath -Root $cwd)) {
                throw "File path escapes the session cwd: $($file.Input)"
            }
        }
        if (-not (Test-PathWithin -Path $repoRoot -Root $cwd)) {
            throw "Discovered repository escapes the session cwd: $repoRoot"
        }
    }

    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in $resolvedFiles) {
        $repoPath = Convert-ToRepoPath -FullPath $file.FullPath -Root $repoRoot
        if (-not $repoPath -or $repoPath -eq '.git' -or $repoPath.StartsWith('.git/', [StringComparison]::OrdinalIgnoreCase)) {
            throw "Repository metadata or broad paths are not allowed: $($file.Input)"
        }
        if (-not $seen.Add($repoPath)) { throw "Duplicate file path: $($file.Input)" }
        $repoPaths += $repoPath
    }

    $stage = 'remote'
    $branch = (Invoke-Git -WorkingDirectory $repoRoot -GitArgs @('rev-parse', '--abbrev-ref', 'HEAD')).Output
    if (-not $branch -or $branch -eq 'HEAD') { throw 'Detached HEAD is not supported.' }
    $configuredRemote = (Invoke-Git -WorkingDirectory $repoRoot -GitArgs @('config', '--get', "branch.$branch.remote") -AllowedExitCodes @(0, 1)).Output
    $configuredUpstreamRef = (Invoke-Git -WorkingDirectory $repoRoot -GitArgs @('config', '--get', "branch.$branch.merge") -AllowedExitCodes @(0, 1)).Output
    $configuredRemotes = @((Invoke-Git -WorkingDirectory $repoRoot -GitArgs @('remote')).Output -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($configuredRemote) {
        if ($configuredRemote -eq '.') { throw "Branch '$branch' tracks the local repository and has no pushable remote." }
        if ($configuredRemotes -cnotcontains $configuredRemote) {
            throw "Branch '$branch' is configured to push to '$configuredRemote', which is not a configured remote."
        }
        $remote = $configuredRemote
    } elseif ($configuredRemotes.Count -eq 0) {
        throw "Branch '$branch' has no configured remote to push to."
    } elseif ($configuredRemotes -ccontains 'origin') {
        $remote = 'origin'
    } elseif ($configuredRemotes.Count -eq 1) {
        $remote = $configuredRemotes[0]
    } else {
        throw "Branch '$branch' has no tracked remote and the repository has multiple remotes: $($configuredRemotes -join ', ')"
    }
    if ($configuredUpstreamRef) {
        if ($configuredUpstreamRef -notmatch '^refs/heads/.+') { throw "Unsupported upstream ref: $configuredUpstreamRef" }
        $upstreamRef = $configuredUpstreamRef
    } else {
        $upstreamRef = "refs/heads/$branch"
    }
    $trackingConfigured = [bool]$configuredRemote -and [bool]$configuredUpstreamRef

    $stage = 'lock'
    $lockKey = Get-Sha256Hex ($commonDir.ToLowerInvariant() + [char]0 + $remote + [char]0 + $upstreamRef)
    $mutexName = "Global\OMP-GitFinalize-$lockKey"
    $mutex = [Threading.Mutex]::new($false, $mutexName)
    try {
        $ownsMutex = $mutex.WaitOne([TimeSpan]::FromSeconds(120))
    } catch [Threading.AbandonedMutexException] {
        $ownsMutex = $true
    }
    if (-not $ownsMutex) { throw "Timed out waiting for repository finalizer lock: $mutexName" }

    $stage = 'locked-preflight'
    $lockedCommonDir = Normalize-FullPath (Invoke-Git -WorkingDirectory $repoRoot -GitArgs @('rev-parse', '--path-format=absolute', '--git-common-dir')).Output
    $lockedBranch = (Invoke-Git -WorkingDirectory $repoRoot -GitArgs @('rev-parse', '--abbrev-ref', 'HEAD')).Output
    if (-not $lockedCommonDir.Equals($commonDir, [StringComparison]::OrdinalIgnoreCase) -or $lockedBranch -ne $branch) {
        throw 'Repository or branch changed while acquiring the finalizer lock.'
    }

    $stage = 'remote-probe'
    $probe = Invoke-Git -WorkingDirectory $repoRoot -GitArgs @('ls-remote', '--exit-code', '--refs', $remote, $upstreamRef) -AllowedExitCodes @(0, 2)
    $upstreamExists = $probe.Code -eq 0

    $stage = 'fetch'
    $headSha = (Invoke-Git -WorkingDirectory $repoRoot -GitArgs @('rev-parse', 'HEAD')).Output
    $upstreamSha = $null
    if ($upstreamExists) {
        [void](Invoke-Git -WorkingDirectory $repoRoot -GitArgs @('fetch', '--no-tags', $remote, $upstreamRef))
        $upstreamSha = (Invoke-Git -WorkingDirectory $repoRoot -GitArgs @('rev-parse', 'FETCH_HEAD')).Output
        $ancestry = Invoke-Git -WorkingDirectory $repoRoot -GitArgs @('merge-base', '--is-ancestor', $upstreamSha, $headSha) -AllowedExitCodes @(0, 1)
        if ($ancestry.Code -ne 0) {
            throw "HEAD is behind or diverged from the fetched upstream. HEAD=$headSha upstream=$upstreamSha"
        }
    }

    $stage = 'index-preflight'
    $indexState = Invoke-Git -WorkingDirectory $repoRoot -GitArgs @('diff', '--cached', '--quiet', '--exit-code') -AllowedExitCodes @(0, 1)
    if ($indexState.Code -ne 0) { throw 'The shared Git index already contains staged changes.' }

    $stage = 'stage'
    $stagedByFinalizer = $true
    [void](Invoke-Git -WorkingDirectory $repoRoot -GitArgs (@('--literal-pathspecs', 'add', '-A', '--') + $repoPaths))
    $cachedPaths = Get-GitPaths -WorkingDirectory $repoRoot -GitArgs @('-c', 'core.quotepath=false', 'diff', '--cached', '--no-renames', '--name-only')
    Assert-ExactPathSet -Actual $cachedPaths -Expected $repoPaths -Label 'Staged path set'

    $stage = 'commit'
    $messageFile = [IO.Path]::GetTempFileName()
    [IO.File]::WriteAllText($messageFile, $message + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    [void](Invoke-Git -WorkingDirectory $repoRoot -GitArgs @('commit', '--file', $messageFile))
    $createdCommit = (Invoke-Git -WorkingDirectory $repoRoot -GitArgs @('rev-parse', 'HEAD')).Output
    $stagedByFinalizer = $false

    $stage = 'commit-verify'
    $parentSha = (Invoke-Git -WorkingDirectory $repoRoot -GitArgs @('rev-parse', "$createdCommit^" )).Output
    if ($parentSha -ne $headSha) {
        throw "Created commit parent does not match the captured HEAD. parent=$parentSha head=$headSha"
    }
    $committedPaths = Get-GitPaths -WorkingDirectory $repoRoot -GitArgs @('-c', 'core.quotepath=false', 'diff-tree', '--no-commit-id', '--no-renames', '--name-only', '-r', $createdCommit)
    Assert-ExactPathSet -Actual $committedPaths -Expected $repoPaths -Label 'Committed path set'

    $stage = 'push'
    [void](Invoke-Git -WorkingDirectory $repoRoot -GitArgs @('push', $remote, "${createdCommit}:${upstreamRef}"))

    $stage = 'remote-verify'
    $remoteLine = (Invoke-Git -WorkingDirectory $repoRoot -GitArgs @('ls-remote', '--refs', $remote, $upstreamRef)).Output
    $remoteSha = (($remoteLine -split '\s+')[0]).Trim()
    if ($remoteSha -ne $createdCommit) {
        throw "Remote ref verification failed. expected=$createdCommit actual=$remoteSha"
    }

    if (-not $trackingConfigured) {
        $stage = 'tracking'
        [void](Invoke-Git -WorkingDirectory $repoRoot -GitArgs @('config', "branch.$branch.remote", $remote))
        [void](Invoke-Git -WorkingDirectory $repoRoot -GitArgs @('config', "branch.$branch.merge", $upstreamRef))
    }

    $stage = 'complete'
    $result = [ordered]@{
        ok = $true
        stage = $stage
        commitSha = $createdCommit
        remote = $remote
        upstreamRef = $upstreamRef
    }
} catch {
    $exitCode = 1
    $result = [ordered]@{
        ok = $false
        stage = $stage
        error = $_.Exception.Message
        commitSha = $createdCommit
    }
} finally {
    if ($stagedByFinalizer -and $repoRoot -and $repoPaths.Count -gt 0) {
        try { [void](Invoke-Git -WorkingDirectory $repoRoot -GitArgs (@('--literal-pathspecs', 'restore', '--staged', '--') + $repoPaths)) } catch {}
    }
    if ($messageFile) { Remove-Item -LiteralPath $messageFile -Force -ErrorAction SilentlyContinue }
    if ($ownsMutex -and $mutex) {
        try { $mutex.ReleaseMutex() } catch {}
    }
    if ($mutex) { $mutex.Dispose() }
}

[Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
exit $exitCode
