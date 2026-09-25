# 비밀 스캔(allowlist·패턴·판정 함수)의 정본. setup.ps1 과 verify.ps1 이 resolve-omp1-command.ps1 과
# 같은 방식으로 dot-source 해서 두 스크립트가 같은 파일을 같은 기준으로 판정하게 한다. 차단 경로
# 목록은 두 스크립트의 검사 범위가 달라 각자 갖고 있고, export.ps1 도 프로필->미러 가져오기 흐름용
# 자체 사본을 쓴다. 이 파일을 고치면 그 사본들에도 같은 규칙을 적용할지 대조해야 한다.
#
# 판정 결과는 사유 문자열 하나이고 $null 이면 통과다. 사유는 세 갈래를 구분한다.
#   Unsupported ...  바이너리·미지원 확장자라 텍스트로 볼 수 없다
#   Malformed ...    .jsonl/.diff 의 형식이 깨져 증거로 신뢰할 수 없다
#   Matched ...      실제 비밀 패턴 또는 자격증명 형태의 대입을 찾았다
# 사유에는 발견한 값이나 키의 실제값을 넣지 않는다. 걸린 패턴 이름만 적어 운영자가 규칙을 고칠 수
# 있게 하고, 값 자체는 출력하지 않는다.
$SafeTextExtensions = @(
    '.md', '.txt', '.yml', '.yaml', '.json', '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx',
    '.html', '.htm', '.css', '.scss', '.dot', '.sh', '.ps1', '.psm1', '.psd1', '.xml',
    '.toml', '.ini', '.cfg', '.conf', '.cmd', '.bat', '.py', '.csv', '.vb', '.frm', '.bas', '.resx',
    '.gitattributes', '.gitignore',
    # 커밋되는 검증 증거 포맷(JSON Lines 세션 조각, git unified diff)도 텍스트로 검사한다.
    # 확장자를 통째로 허용하지 않고 아래 형식 검사를 함께 적용한다.
    '.jsonl', '.diff'
)
# Markdown prose pairs a word, a colon, and another word constantly, which the
# config-assignment heuristic below misreads as a credential (design-system docs
# discussing design tokens are the common case). That heuristic therefore skips
# prose files. Credential-format detection ($DirectSecretPatterns) still runs on
# every file, so a real key pasted into a document is still caught.
$ProseExtensions = @('.md', '.txt')
$CodeExtensions = @('.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx')
$LegacyCp949Extensions = @('.vb', '.frm', '.bas', '.cfg', '.csv', '.resx')
$EvidenceExtensions = @('.jsonl', '.diff')
$CodeReferencePattern = '^\(*[A-Za-z_$]'
$DirectSecretPatterns = @(
    '-----BEGIN [A-Z ]*PRIVATE KEY-----',
    '(?i)\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}',
    '\bAIza[0-9A-Za-z_-]{35}\b',
    '(?i)\bgh[pousr]_[A-Za-z0-9]{20,}',
    '\bAKIA[0-9A-Z]{16}\b',
    '(?i)\bBearer\s+[A-Za-z0-9._-]{20,}',
    '\bxox[baprs]-[A-Za-z0-9-]{20,}',
    '(?i)\b[a-z][a-z0-9+.-]*://[^/\s:@]+:[^/\s@]+@'
)
$AssignmentPattern = '(?i)["'']?(?<key>[A-Za-z_][A-Za-z0-9_.-]*)["'']?[ \t]*(?<separator>[:=])[ \t]*(?:"(?<double>[^"\r\n]+)"|''(?<single>[^''\r\n]+)''|(?<bare>[^\s,;}\]]{8,}))'
$SensitiveKeyPattern = '(?i)(?:tokens?|cookies?|passwords?|passwds?|secrets?|credentials?|connectionstrings?|(?:token|cookie|secret|credential)(?:key|value|header|string))$|^(?:auth|authentication|authorization|auth(?:token|key|secret|credential|cookie|header|config|data))$|account(?:key|token|secret|credential|password)$|(?:api|private)keys?$|sessionids?$'
# 마지막 대안 `(?-i:...)` 은 환경변수 이름 지시를 비밀이 아닌 것으로 본다. omp 는 `apiKey` 값을
# 먼저 환경변수 이름으로 해석하므로(`src/config/model-config-values.ts` 의 resolveConfigValue)
# `models.yml` 에는 값이 아니라 이름(예 OPENCODE_ZEN_API_KEY)만 들어간다. 전부 대문자이고
# 밑줄이 하나 이상인 형태만 통과시키므로 소문자가 섞인 실제 키(`sk-...`)나 밑줄 없는 대문자
# 토큰(`AKIA...`)은 그대로 걸린다. `(?i)` 가 앞에 있어 이 대안만 대소문자 구분을 되살린다.
# 주의: 이 주석에 `키이름` 형태의 대입 쌍을 쓰면 스캐너가 자기 자신을 잡는다(2026-08-18 실제 발생).
$PlaceholderPattern = '(?i)^(?:example|sample|placeholder|redacted|none|null|pass(?:ed)?|fail(?:ed)?|false|true|required|login|environment|env|process|variable|(?:string|number|boolean|unknown|object)\)?|your[-_]?.*|<.*>|\$\{.*\}|\$\$.*|\$\([^)]*\)|x{4,}|\*{4,}|(?-i:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+))$'

# .jsonl/.diff 는 구조화 증거 포맷이라 형식을 먼저 본다. 형식이 깨진 파일은 내용 판정보다 그 사유로
# 실패시켜야 운영자가 '비밀 탐지'와 구분할 수 있다. 검사를 생략하지 않으므로 깨진 증거도 통과하지
# 못하고, 실패 사유만 정확해진다. 빈 파일은 검사할 내용이 없으므로 통과시킨다.
function Get-EvidenceFormatReason([string]$Extension, [string]$Content) {
    if ([string]::IsNullOrWhiteSpace($Content)) { return $null }
    if ($Extension -eq '.jsonl') {
        $number = 0
        foreach ($line in ($Content -split "\r?\n")) {
            $number++
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            try {
                $null = ConvertFrom-Json -InputObject $line -ErrorAction Stop
            } catch {
                return "Malformed JSONL line $number"
            }
        }
        return $null
    }
    # unified diff 는 `@@ -a,b +c,d @@` 헌크 머리말을 갖고, 바이너리 패치는 `diff --git` 을 갖는다.
    if ($Content -match '(?m)^(?:@@ |diff --git )') { return $null }
    return 'Malformed diff (no git diff header)'
}

# 대입 후보가 자격증명으로 보이는지 판정한다. $Extension 은 그 텍스트가 실제로 온 파일의 확장자다.
# JS/TS 의 따옴표 없는 식별자·타입·표현식은 비밀 문자열 리터럴이 아니다. 따옴표 값, template
# literal, 숫자 값과 직접 비밀 패턴 검사는 계속 적용한다.
function Test-CredentialLikeAssignment([string]$Text, [string]$Extension) {
    foreach ($match in [regex]::Matches($Text, $AssignmentPattern)) {
        $key = ($match.Groups['key'].Value -replace '[_.-]', '')
        if ($key -notmatch $SensitiveKeyPattern) { continue }
        if ($CodeExtensions -contains $Extension -and
            $match.Groups['bare'].Success -and
            $match.Groups['bare'].Value -match $CodeReferencePattern) { continue }
        $value = @($match.Groups['double'].Value, $match.Groups['single'].Value, $match.Groups['bare'].Value) |
            Where-Object { $_ } | Select-Object -First 1
        $value = "$value".Trim().TrimEnd(',', ';')
        # HTTP 인증 scheme만 있는 코드 문자열은 credential이 아니다. 뒤에 토큰이 있으면 그대로 검사한다.
        if ($CodeExtensions -contains $Extension -and $key -ieq 'authorization' -and $value -ceq 'Bearer') { continue }
        if ($value -and $value -notmatch $PlaceholderPattern) { return $true }
    }
    return $false
}

function Get-SuspiciousContentReason([string]$Path) {
    $extension = [IO.Path]::GetExtension($Path).ToLowerInvariant()
    if ($SafeTextExtensions -notcontains $extension) { return "Unsupported file type: $extension" }
    try {
        $strictUtf8 = New-Object Text.UTF8Encoding($false, $true)
        $content = [IO.File]::ReadAllText($Path, $strictUtf8)
    } catch {
        if ($LegacyCp949Extensions -notcontains $extension) {
            return "Unreadable content: $($_.Exception.Message)"
        }
        try {
            $strictCp949 = [Text.Encoding]::GetEncoding(
                949,
                [Text.EncoderExceptionFallback]::new(),
                [Text.DecoderExceptionFallback]::new()
            )
            $content = [IO.File]::ReadAllText($Path, $strictCp949)
        } catch {
            return "Unreadable UTF-8/CP949 content: $($_.Exception.Message)"
        }
    }
    if ($content -match '[\x00-\x08\x0B\x0C\x0E-\x1F]') { return 'Binary content' }
    if ($EvidenceExtensions -contains $extension) {
        $formatReason = Get-EvidenceFormatReason $extension $content
        if ($formatReason) { return $formatReason }
    }
    foreach ($pattern in $DirectSecretPatterns) {
        if ([regex]::IsMatch($content, $pattern)) { return "Matched secret pattern: $pattern" }
    }
    if ($ProseExtensions -contains $extension) { return $null }
    $normalizedPath = $Path.Replace('/', '\').ToLowerInvariant()
    # Pinned vendor runtime/data and committed context-window numeric reports contain code examples,
    # search token names, or aggregate token counters. Direct secret patterns above still run; only
    # the noisy assignment heuristic is skipped for these exact subtrees.
    $isUiUxRuntime = $extension -eq '.py' -and
        $normalizedPath -match '\\skills\\ui-ux-pro-max\\scripts\\(core|design_system|reasoning_contract|search)\.py$'
    $isUiUxData = $extension -eq '.csv' -and
        $normalizedPath -match '\\skills\\ui-ux-pro-max\\data\\(?:[^\\]+|stacks\\[^\\]+)\.csv$'
    $isContextWindowBaseline = $extension -eq '.json' -and
        $normalizedPath -match '\\evals\\baselines\\context-window-[^\\]+\.json$'
    if ($isUiUxRuntime -or $isUiUxData -or $isContextWindowBaseline) { return $null }
    if ($extension -eq '.diff') {
        # diff 본문 줄은 머리말이 가리키는 대상 파일에서 온 내용이다. `+++ b/<경로>`(파일이 지워진
        # 구간은 `--- a/<경로>`)의 확장자를 그 뒤 줄들이 물려받으므로, 코드 파일 diff 의 따옴표
        # 없는 식별자에 그 소스 파일과 같은 예외가 그대로 적용된다. 추가(+)·삭제(-) 줄 모두 이
        # 판정을 받는다. 머리말은 `---`·`+++` 가 붙어 나오는 쌍으로만 인정해서, 본문에 `-- x`/`++ x`
        # 처럼 보이는 줄이 구간 확장자를 바꾸지 않게 한다.
        $sourcePath = $null
        $lineExtension = $extension
        foreach ($line in ($content -split "\r?\n")) {
            if ($line -match '^---[ \t]+(?<path>[^\t]+)') {
                $sourcePath = $matches['path']
            } elseif ($sourcePath -and $line -match '^\+\+\+[ \t]+(?<path>[^\t]+)') {
                $target = $matches['path'] -replace '^[ab]/', ''
                if ($target -eq '/dev/null') { $target = $sourcePath -replace '^[ab]/', '' }
                $sourcePath = $null
                if (-not $target.StartsWith('"')) {
                    $lineExtension = [IO.Path]::GetExtension($target).ToLowerInvariant()
                }
                continue
            } elseif ($sourcePath) {
                $sourcePath = $null
            }
            if ($ProseExtensions -contains $lineExtension) { continue }
            if (Test-CredentialLikeAssignment $line $lineExtension) { return 'Matched credential-like assignment' }
        }
        return $null
    }
    if (Test-CredentialLikeAssignment $content $extension) { return 'Matched credential-like assignment' }
    return $null
}
