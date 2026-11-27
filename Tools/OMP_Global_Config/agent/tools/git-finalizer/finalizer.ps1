[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Request,
    [switch]$PreflightOnly,
    [switch]$PinPublicationTarget
)

$ErrorActionPreference = 'Stop'
try {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
} catch {}
$env:GIT_TERMINAL_PROMPT = '0'
# PowerShell 5.1 on Windows and PowerShell 7 on Linux share this transaction.
$isWindowsPlatform = [IO.Path]::DirectorySeparatorChar -eq '\'
$pathComparison = if ($isWindowsPlatform) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
$pathComparer = if ($isWindowsPlatform) { [StringComparer]::OrdinalIgnoreCase } else { [StringComparer]::Ordinal }

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
    if ($fullPath.Equals($pathRoot, $pathComparison)) { return $pathRoot }
    return $fullPath.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Test-PathWithin([string]$Path, [string]$Root) {
    if ($Path.Equals($Root, $pathComparison)) { return $true }
    $prefix = $Root
    if (
        -not $prefix.EndsWith([IO.Path]::DirectorySeparatorChar) -and
        -not $prefix.EndsWith([IO.Path]::AltDirectorySeparatorChar)
    ) {
        $prefix += [IO.Path]::DirectorySeparatorChar
    }
    return $Path.StartsWith($prefix, $pathComparison)
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
    if ($FullPath.Equals($Root, $pathComparison)) { return '' }
    return $FullPath.Substring($Root.Length).TrimStart('\', '/').Replace('\', '/')
}

function Get-GitPaths([string]$WorkingDirectory, [string[]]$GitArgs) {
    $response = Invoke-Git -WorkingDirectory $WorkingDirectory -GitArgs $GitArgs
    if (-not $response.Output) { return @() }
    return @($response.Output -split "`r?`n" | ForEach-Object { $_.Trim().Replace('\', '/') } | Where-Object { $_ })
}

function Assert-ExactPathSet([string[]]$Actual, [string[]]$Expected, [string]$Label) {
    $actualSet = [Collections.Generic.HashSet[string]]::new($pathComparer)
    $expectedSet = [Collections.Generic.HashSet[string]]::new($pathComparer)
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
    $seenFullPaths = [Collections.Generic.HashSet[string]]::new($pathComparer)
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
    $cwdIsLinkedWorktree = $false
    try {
        $cwdRepoRoot = Get-RepositoryRootInPathNamespace $cwd
        $cwdCommonDir = Normalize-FullPath (Invoke-Git -WorkingDirectory $cwdRepoRoot -GitArgs @('rev-parse', '--path-format=absolute', '--git-common-dir')).Output
        $cwdGitDir = Normalize-FullPath (Invoke-Git -WorkingDirectory $cwdRepoRoot -GitArgs @('rev-parse', '--path-format=absolute', '--git-dir')).Output
        $cwdIsLinkedWorktree = -not $cwdGitDir.Equals($cwdCommonDir, $pathComparison)
    } catch {
        $cwdRepoRoot = $null
        $cwdCommonDir = $null
        $cwdIsLinkedWorktree = $false
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
            -not $selectedRepoRoot.Equals($targetRepoRoot, $pathComparison) -or
            -not $selectedCommonDir.Equals($targetCommonDir, $pathComparison)
        ) {
            throw "Files belong to different repositories: $($file.Input)"
        }
    }

    $repoRoot = $selectedRepoRoot
    $commonDir = $selectedCommonDir
    # cwd 밖 파일은 사용자의 명시 지시(outsideCwdReason)가 있을 때만 허용한다. 다른 저장소 대상도 같은 규칙이다(2026-11-19).
    # cwd 저장소 루트 바로 아래 파일(HANDOFF, CHANGELOG 같은 루트 문서)만 같은 저장소일 때 예외로 둔다.
    $outsideCwdReason = ([string]$payload.outsideCwdReason).Trim()
    # index.ts가 낡은 매니페스트를 직접 다시 만들어 더한 파일은 cwd 밖이어도 사용자 지시를 요구하지 않는다. 요청에 무엇이 실려 와도 이 파일 하나만 인정한다.
    $scriptStart = [DateTime]::UtcNow
    $generatedFiles = [Collections.Generic.HashSet[string]]::new($pathComparer)
    foreach ($generated in @($payload.generatedFiles)) {
        if (([string]$generated).Replace('\', '/') -eq 'Tools/CUELO_Setup/files/source-integrity.json') { [void]$generatedFiles.Add('Tools/CUELO_Setup/files/source-integrity.json') }
    }
    $outsideCwdMessage = $null
    if ($cwdRepoRoot) {
        $targetsBelongToCwdRepository = $commonDir.Equals($cwdCommonDir, $pathComparison)
        # 세션 전용 linked worktree 안이면 그 worktree 전체(같은 worktree 루트)는 지시 없이 허용한다. 여러 세션이 쓰는 main checkout과 다른 worktree·저장소는 아니다(사용자 결정 2026-11-19).
        $targetsInCwdLinkedWorktree = $cwdIsLinkedWorktree -and $repoRoot.Equals($cwdRepoRoot, $pathComparison)
        foreach ($file in $resolvedFiles) {
            if ($targetsInCwdLinkedWorktree) { continue }
            if (Test-PathWithin -Path $file.FullPath -Root $cwd) { continue }
            if ($generatedFiles.Contains((Convert-ToRepoPath -FullPath $file.FullPath -Root $repoRoot))) { continue }
            if ($targetsBelongToCwdRepository) {
                $parentPath = [IO.Path]::GetDirectoryName($file.FullPath)
                if ($parentPath -and $parentPath.Equals($cwdRepoRoot, $pathComparison)) { continue }
            }
            $outsideCwdMessage = "File path escapes the session cwd: $($file.Input)"
            break
        }
    } else {
        foreach ($file in $resolvedFiles) {
            if (-not (Test-PathWithin -Path $file.FullPath -Root $cwd) -and -not $generatedFiles.Contains((Convert-ToRepoPath -FullPath $file.FullPath -Root $repoRoot))) {
                $outsideCwdMessage = "File path escapes the session cwd: $($file.Input)"
                break
            }
        }
        if (-not $outsideCwdMessage -and -not (Test-PathWithin -Path $repoRoot -Root $cwd)) {
            $outsideCwdMessage = "Discovered repository escapes the session cwd: $repoRoot"
        }
    }
    $outsideCwdUsed = $null
    if ($outsideCwdMessage) {
        if (-not $outsideCwdReason) {
            throw "$outsideCwdMessage. Committing outside the session cwd requires the user's explicit instruction: pass it as outsideCwdReason."
        }
        $outsideCwdUsed = $outsideCwdReason
    }

    $seen = [Collections.Generic.HashSet[string]]::new($pathComparer)
    foreach ($file in $resolvedFiles) {
        $repoPath = Convert-ToRepoPath -FullPath $file.FullPath -Root $repoRoot
        if (-not $repoPath -or $repoPath -eq '.git' -or $repoPath.StartsWith('.git/', $pathComparison)) {
            throw "Repository metadata or broad paths are not allowed: $($file.Input)"
        }
        if (-not $seen.Add($repoPath)) { throw "Duplicate file path: $($file.Input)" }
        $repoPaths += $repoPath
    }

    if ($PreflightOnly -and -not $PinPublicationTarget) {
        [Console]::Out.WriteLine((@{ ok = $true; stage = 'preflight'; repositoryRoot = $repoRoot; repositoryFiles = @($repoPaths) } | ConvertTo-Json -Compress))
        exit 0
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
    if ($PreflightOnly) {
        $target = @{ branch = $branch; remote = $remote; upstreamRef = $upstreamRef; commonDir = $commonDir }
        [Console]::Out.WriteLine((@{ ok = $true; stage = 'preflight'; repositoryRoot = $repoRoot; repositoryFiles = @($repoPaths); target = $target } | ConvertTo-Json -Compress))
        exit 0
    }

    $stage = 'lock'
    $lockDirectory = if ($isWindowsPlatform) { $commonDir.ToLowerInvariant() } else { $commonDir }
    $lockKey = Get-Sha256Hex ($lockDirectory + [char]0 + $remote + [char]0 + $upstreamRef)
    $mutexName = if ($isWindowsPlatform) { "Global\OMP-GitFinalize-$lockKey" } else { "OMP-GitFinalize-$lockKey" }
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
    if (-not $lockedCommonDir.Equals($commonDir, $pathComparison) -or $lockedBranch -cne $branch) {
        throw 'Repository or branch changed while acquiring the finalizer lock.'
    }
    if ($payload.target) {
        $target = $payload.target
        if ($lockedBranch -cne $target.branch -or $remote -cne $target.remote -or $upstreamRef -cne $target.upstreamRef -or
            -not $lockedCommonDir.Equals([string]$target.commonDir, $pathComparison) -or
            (Invoke-Git -WorkingDirectory $repoRoot -GitArgs @('config', '--get', "branch.$branch.remote") -AllowedExitCodes @(0, 1)).Output -cne $configuredRemote -or
            (Invoke-Git -WorkingDirectory $repoRoot -GitArgs @('config', '--get', "branch.$branch.merge") -AllowedExitCodes @(0, 1)).Output -cne $configuredUpstreamRef) {
            throw 'Publication target changed after git_finalize preflight. No commit or push was made.'
        }
    }

    $stage = 'remote-probe'
    $probe = Invoke-Git -WorkingDirectory $repoRoot -GitArgs @('ls-remote', '--exit-code', '--refs', $remote, $upstreamRef) -AllowedExitCodes @(0, 2)
    $upstreamExists = $probe.Code -eq 0

    $stage = 'fetch'
    $headSha = (Invoke-Git -WorkingDirectory $repoRoot -GitArgs @('rev-parse', 'HEAD')).Output
    if ($payload.finalizeChecksHead -and $payload.finalizeChecksHead -cne $headSha) {
        $stage = 'finalize-checks'
        throw 'HEAD changed after running the repository checks. Call git_finalize again.'
    }
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
    if ($payload.finalizeChecksTree) {
        $stage = 'finalize-checks'
        $stagedTree = (Invoke-Git -WorkingDirectory $repoRoot -GitArgs @('write-tree')).Output
        if ($stagedTree -cne $payload.finalizeChecksTree) {
            throw 'The staged tree does not match the checked publication candidate. Call git_finalize again.'
        }
        $stage = 'stage'
    }
    # 계열 교차검증 게이트(index.ts)가 본 파일별 blob(요청한 모든 경로, 안 바뀐 것 포함)과 stage된 내용이 같아야 커밋한다.
    # 게이트 검사와 이 잠금 사이에 파일이 바뀌었거나 게이트가 보지 못한 경로가 stage되면 검토받지 않은 내용이 커밋되므로
    # 거절한다(요청에 gateBlobs가 없으면, 즉 코드 파일이 없는 요청이면 검사하지 않는다).
    $gateMap = $null
    if ($payload.gateBlobs) {
        $gateMap = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::Ordinal)
        foreach ($gateEntry in $payload.gateBlobs.PSObject.Properties) { $gateMap[[string]$gateEntry.Name] = [string]$gateEntry.Value }
        $stage = 'cross-review-verify'
        foreach ($gatePath in $repoPaths) {
            if (-not $gateMap.ContainsKey($gatePath)) {
                throw "Cross-review gate: $gatePath was not part of the change set the gate checked. Run git_finalize again so the gate sees it."
            }
            $indexEntry = (Invoke-Git -WorkingDirectory $repoRoot -GitArgs @('--literal-pathspecs', 'ls-files', '--stage', '--', $gatePath)).Output
            $stagedBlob = if ($indexEntry) { (($indexEntry -split '\s+')[1]) } else { 'deleted' }
            if ($stagedBlob -cne $gateMap[$gatePath]) {
                throw "Cross-review gate: $gatePath changed after the review check (checked blob $($gateMap[$gatePath]), staged blob $stagedBlob). Run git_finalize again so the gate sees the current content."
            }
        }
        $stage = 'stage'
    }
    # 이전 실행이 커밋은 만들고 push에서 실패했으면 요청 파일이 이미 깨끗하다. 그 파일이 아직 원격에 없는
    # 커밋(upstream..HEAD, 원격 브랜치가 없으면 원격 추적 ref 어디에도 없는 HEAD 커밋)에 들어 있을 때만
    # 그 커밋을 인정하고 새 커밋 없이 다시 보낸다.
    $cachedPaths = @($cachedPaths)
    $cachedSet = [Collections.Generic.HashSet[string]]::new($pathComparer)
    foreach ($path in $cachedPaths) { [void]$cachedSet.Add($path) }
    $alreadyCommitted = @($repoPaths | Where-Object { -not $cachedSet.Contains($_) })
    $resumedPush = $false
    if ($alreadyCommitted.Count -gt 0) {
        if ($upstreamSha -eq $headSha) {
            Assert-ExactPathSet -Actual $cachedPaths -Expected $repoPaths -Label 'Staged path set'
        }
        $pendingRange = if ($upstreamSha) { "${upstreamSha}..${headSha}" } else { "${headSha} not in refs/remotes/$remote" }
        $pendingPaths = if ($upstreamSha) {
            Get-GitPaths -WorkingDirectory $repoRoot -GitArgs @('-c', 'core.quotepath=false', 'diff', '--no-renames', '--name-only', $upstreamSha, $headSha)
        } else {
            Get-GitPaths -WorkingDirectory $repoRoot -GitArgs @('-c', 'core.quotepath=false', 'log', '--no-renames', '--format=', '--name-only', $headSha, '--not', "--remotes=$remote")
        }
        $pendingSet = [Collections.Generic.HashSet[string]]::new($pathComparer)
        foreach ($path in $pendingPaths) { [void]$pendingSet.Add($path) }
        $unpending = @($alreadyCommitted | Where-Object { -not $pendingSet.Contains($_) })
        if ($unpending.Count -gt 0) {
            throw "Staged path set mismatch. Unchanged paths are not in unpushed commits ${pendingRange}: $($unpending -join ', ')"
        }
        $resumedPush = $true
    }

    if ($cachedPaths.Count -gt 0) {
        Assert-ExactPathSet -Actual $cachedPaths -Expected @($repoPaths | Where-Object { $cachedSet.Contains($_) }) -Label 'Staged path set'
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
        Assert-ExactPathSet -Actual $committedPaths -Expected $cachedPaths -Label 'Committed path set'
        if ($payload.finalizeChecksTree) {
            $committedTree = (Invoke-Git -WorkingDirectory $repoRoot -GitArgs @('rev-parse', "$createdCommit^{tree}")).Output
            if ($committedTree -cne $payload.finalizeChecksTree) {
                throw "The created commit $createdCommit does not match the checked publication candidate. The local commit exists and was NOT pushed; inspect it before retrying."
            }
        }
        # 커밋 hook이 stage 뒤 파일을 다시 쓸 수 있으므로 push 전에 커밋에 들어간 blob도 게이트가 본 blob과 대조한다. 어긋나면 되돌리지
        # 않고(사용자 작업 보존) 로컬 커밋이 남았음을 알리며 멈춘다.
        if ($gateMap) {
            $stage = 'cross-review-verify'
            foreach ($gatePath in $repoPaths) {
                $treeEntry = (Invoke-Git -WorkingDirectory $repoRoot -GitArgs @('--literal-pathspecs', 'ls-tree', $createdCommit, '--', $gatePath)).Output
                $committedBlob = if ($treeEntry) { (($treeEntry -split '\s+')[2]) } else { 'deleted' }
                if ($committedBlob -cne $gateMap[$gatePath]) {
                    throw "Cross-review gate: the created commit $createdCommit holds a different blob for $gatePath than the one the gate checked (checked $($gateMap[$gatePath]), committed $committedBlob), probably a commit hook rewrote it. The local commit exists and was NOT pushed; inspect it before retrying."
                }
            }
        }
    } else {
        $stagedByFinalizer = $false
        $createdCommit = $headSha
    }

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

    # 커밋 뒤 안내(실패해도 커밋 결과는 그대로): 같은 작업이 만든 파일이 추적되지 않은 채 남는 일을 막으려고
    # 커밋 경로의 가장 깊은 공통 상위 폴더(저장소 루트면 cwd) 아래에 남은 미추적·수정·stage된 파일을 알려 준다.
    # push·검증이 끝난 뒤에 하고, 이미 오래 걸렸으면 건너뛰어 호출 제한 시간(180초) 안에 성공 응답이 나가게 한다.
    $leftoverScope = $null
    $leftoverTotal = 0
    $leftoverFiles = @()
    try {
        if (([DateTime]::UtcNow - $scriptStart).TotalSeconds -lt 90) {
            $commonSegments = $null
            foreach ($repoPath in $repoPaths) {
                $parts = @($repoPath -split '/')
                # 배열이 한 개나 0개로 풀리지 않도록 List로 모은다.
                $dirParts = [Collections.Generic.List[string]]::new()
                for ($index = 0; $index -lt $parts.Count - 1; $index++) { $dirParts.Add([string]$parts[$index]) }
                if ($null -eq $commonSegments) {
                    $commonSegments = $dirParts
                } else {
                    $shared = 0
                    while ($shared -lt $commonSegments.Count -and $shared -lt $dirParts.Count -and $commonSegments[$shared].Equals($dirParts[$shared], $pathComparison)) { $shared++ }
                    $commonSegments.RemoveRange($shared, $commonSegments.Count - $shared)
                }
            }
            $scopePath = $commonSegments -join '/'
            if (-not $scopePath -and (Test-PathWithin -Path $cwd -Root $repoRoot)) { $scopePath = Convert-ToRepoPath -FullPath $cwd -Root $repoRoot }
            # 세션 전용 linked worktree의 루트면 저장소 전체를 본다(사용자 결정 2026-11-27). 여러 세션이 쓰는 main checkout 루트는 지금처럼 건너뛴다.
            if (-not $scopePath -and $cwdIsLinkedWorktree -and $repoRoot.Equals($cwdRepoRoot, $pathComparison) -and $cwd.Equals($repoRoot, $pathComparison)) { $scopePath = '.' }
            if ($scopePath) {
                $committedSet = [Collections.Generic.HashSet[string]]::new($pathComparer)
                foreach ($repoPath in $repoPaths) { [void]$committedSet.Add($repoPath) }
                $states = [Collections.Generic.Dictionary[string, string]]::new($pathComparer)
                $gitPrefix = @('-c', 'core.quotepath=false', '--literal-pathspecs')
                foreach ($path in (Get-GitPaths -WorkingDirectory $repoRoot -GitArgs ($gitPrefix + @('ls-files', '--others', '--exclude-standard', '--', $scopePath)))) {
                    if (-not $committedSet.Contains($path)) { $states[$path] = 'untracked' }
                }
                foreach ($path in (Get-GitPaths -WorkingDirectory $repoRoot -GitArgs ($gitPrefix + @('diff', '--no-renames', '--name-only', '--', $scopePath)))) {
                    if (-not $committedSet.Contains($path)) { $states[$path] = 'modified' }
                }
                foreach ($path in (Get-GitPaths -WorkingDirectory $repoRoot -GitArgs ($gitPrefix + @('diff', '--cached', '--no-renames', '--name-only', '--', $scopePath)))) {
                    if (-not $committedSet.Contains($path)) { $states[$path] = if ($states.ContainsKey($path)) { 'staged+modified' } else { 'staged' } }
                }
                $leftoverTotal = $states.Count
                if ($leftoverTotal -gt 0) {
                    $leftoverScope = $scopePath
                    $leftoverFiles = @($states.Keys | Sort-Object { $_ } | Select-Object -First 20 | ForEach-Object { "$($states[$_]): $_" })
                }
            }
        }
    } catch {
        $leftoverScope = $null
        $leftoverTotal = 0
        $leftoverFiles = @()
    }
    $stage = 'complete'
    $result = [ordered]@{
        ok = $true
        stage = $stage
        commitSha = $createdCommit
        remote = $remote
        upstreamRef = $upstreamRef
        resumedPush = $resumedPush
    }
    if ($outsideCwdUsed) { $result['outsideCwdReason'] = $outsideCwdUsed }
    if ($leftoverTotal -gt 0) {
        $result['leftoverScope'] = $leftoverScope
        $result['leftoverTotal'] = $leftoverTotal
        $result['leftoverFiles'] = @($leftoverFiles)
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
